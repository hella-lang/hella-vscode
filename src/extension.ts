import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;
let output: vscode.OutputChannel;
let formatting = false;

function cfg<T>(key: string, def: T): T {
  return vscode.workspace.getConfiguration('hella').get<T>(key, def);
}

function notifyInfo(msg: string): void {
  if (cfg<boolean>('notifications.enabled', false)) {
    vscode.window.showInformationMessage(`hella: ${msg}`);
  }
  output.appendLine(`[info] ${msg}`);
}

function notifyError(msg: string): void {
  // Formatter failures always surface (mirrors `notify` gating in nvim,
  // but a silent no-op formatter in VS Code would be confusing).
  vscode.window.showErrorMessage(`hella: ${msg}`);
  output.appendLine(`[error] ${msg}`);
}

/** Resolve the `hella lsp` command. Mirrors nvim `M.config.cmd`. */
function serverCommand(): string[] {
  const bin = cfg<string>('server.path', 'hella');
  const args = cfg<string[]>('server.args', ['lsp']);
  return [bin, ...args];
}

/**
 * Resolve the `hella fmt` command list. Mirrors nvim `fmt_cmd()`: uses
 * `hella.format.command` when set, otherwise derives it from the LSP
 * command by swapping the `lsp` subcommand for `fmt` (same binary).
 */
function fmtCommand(): string[] {
  const override = cfg<string[]>('format.command', []);
  if (override && override.length > 0) {
    return [...override];
  }
  const base = serverCommand().map((part) => (part === 'lsp' ? 'fmt' : part));
  if (!base.includes('fmt')) {
    base.push('fmt');
  }
  return base;
}

function runFmt(tmpFile: string, check: boolean): { code: number; out: string } {
  const cmd = fmtCommand();
  const full = check ? [...cmd, '--check', tmpFile] : [...cmd, tmpFile];
  const res = cp.spawnSync(full[0], full.slice(1), { encoding: 'utf8' });
  const out = ((res.stderr ?? '') + (res.stdout ?? '')).trim();
  return { code: res.status ?? 1, out };
}

/** Stage the document (including dirty text) into a temp `.hll` file. */
function stageToTempHll(text: string): string {
  // The CLI only collects `.hll` files (`collect_sources` skips anything
  // else, an explicit non-`.hll` file is rejected) while this extension
  // also edits legacy `.hlt`/`.holt` buffers — so formatting always goes
  // through a temporary `.hll` file, exactly like hella.nvim.
  const tmp = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'hella-fmt-')),
    'buffer.hll'
  );
  fs.writeFileSync(tmp, text, 'utf8');
  return tmp;
}

function cleanupTemp(tmp: string): void {
  try {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function fullDocumentEdit(
  doc: vscode.TextDocument,
  formatted: string
): vscode.TextEdit[] {
  if (formatted === doc.getText()) {
    return [];
  }
  const last = doc.lineAt(doc.lineCount - 1);
  const range = new vscode.Range(
    new vscode.Position(0, 0),
    last.range.end
  );
  return [vscode.TextEdit.replace(range, formatted)];
}

/** Format via `hella fmt`. Returns true when the doc is (now) formatted. */
async function formatDocument(
  doc: vscode.TextDocument,
  opts?: { check?: boolean; onSave?: boolean }
): Promise<boolean> {
  if (formatting) {
    return true;
  }
  if (!cfg<boolean>('format.enabled', true)) {
    return false;
  }
  if (doc.languageId !== 'hella') {
    return false;
  }
  formatting = true;
  try {
    const tmp = stageToTempHll(doc.getText());
    try {
      const { code, out } = runFmt(tmp, !!opts?.check);
      if (code !== 0) {
        if (opts?.check && /would be reformatted/.test(out)) {
          // `--check` exits non-zero for unformatted files by design;
          // that is a report, not a formatter failure.
          if (!opts?.onSave) {
            vscode.window.showInformationMessage(
              'hella: buffer would be reformatted'
            );
          }
          return false;
        }
        const detail = out || `exit code ${code}`;
        if (!opts?.onSave || !/would be reformatted/.test(detail)) {
          notifyError(`fmt failed: ${detail}`);
        }
        return false;
      }
      if (opts?.check) {
        cleanupTemp(tmp);
        if (!opts?.onSave) {
          notifyInfo('already formatted');
          if (cfg<boolean>('notifications.enabled', false)) {
            vscode.window.showInformationMessage('hella: already formatted');
          }
        }
        return true;
      }
      const formatted = fs.readFileSync(tmp, 'utf8');
      cleanupTemp(tmp);
      if (formatted === doc.getText()) {
        if (!opts?.onSave) {
          notifyInfo('already formatted');
        }
        return true;
      }
      if (opts?.onSave) {
        // BufWritePre equivalent: swap in the formatted text before the
        // pending write picks it up (willSave with `edits` is not
        // available, so apply synchronously and let the save continue).
        const edit = new vscode.WorkspaceEdit();
        for (const e of fullDocumentEdit(doc, formatted)) {
          edit.set(doc.uri, [e]);
        }
        await vscode.workspace.applyEdit(edit);
      } else {
        const edit = new vscode.WorkspaceEdit();
        for (const e of fullDocumentEdit(doc, formatted)) {
          edit.set(doc.uri, [e]);
        }
        await vscode.workspace.applyEdit(edit);
        const label = doc.uri.fsPath || 'buffer';
        notifyInfo(`formatted ${label}`);
      }
      return true;
    } finally {
      cleanupTemp(tmp);
    }
  } finally {
    formatting = false;
  }
}

// ---------------------------------------------------------------------------
// endwise: auto-close `do`/`has` blocks with `end` (mirrors hella.nvim)
// ---------------------------------------------------------------------------

function endsWithKeyword(line: string, word: string): boolean {
  if (line === word) {
    return true;
  }
  if (!line.endsWith(word)) {
    return false;
  }
  return /[^A-Za-z0-9_]/.test(line.charAt(line.length - word.length - 1));
}

/** Strip a trailing `//` comment (nvim does the same before keyword check). */
function stripLineComment(line: string): string {
  const idx = line.indexOf('//');
  return idx >= 0 ? line.slice(0, idx).replace(/\s+$/, '') : line;
}

/**
 * Heuristic string check: is the trailing keyword inside a string literal?
 * Approximates nvim's `synID` guard (String/Comment/Character/Escape) by
 * scanning the line for unclosed `"` / `'` / `"""` / `r"` regions.
 */
function keywordInString(line: string, keyword: string): boolean {
  const col = line.lastIndexOf(keyword);
  if (col < 0) {
    return false;
  }
  let i = 0;
  let quote: string | null = null;
  let raw = false;
  while (i < col) {
    if (quote === null) {
      if (line.startsWith('"""', i)) {
        quote = '"""';
        raw = false;
        i += 3;
        continue;
      }
      if (line.startsWith('r"', i)) {
        quote = '"';
        raw = true;
        i += 2;
        continue;
      }
      const ch = line[i];
      if (ch === '"' || ch === "'") {
        quote = ch;
        raw = false;
        i += 1;
        continue;
      }
      i += 1;
    } else if (quote === '"""') {
      if (line.startsWith('"""', i)) {
        quote = null;
        i += 3;
      } else {
        i += 1;
      }
    } else {
      const ch = line[i];
      if (!raw && ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      i += 1;
    }
  }
  return quote !== null;
}

function endwiseEnabled(): boolean {
  return cfg<boolean>('endwise.enabled', true);
}

async function maybeEndwise(
  editor: vscode.TextEditor,
  prevLine: number
): Promise<void> {
  if (!endwiseEnabled()) {
    return;
  }
  const doc = editor.document;
  if (doc.languageId !== 'hella') {
    return;
  }
  const curLine = prevLine + 1;
  if (curLine >= doc.lineCount) {
    return;
  }
  const curText = doc.lineAt(curLine).text;
  // Only expand on a blank new line (guards mid-line splits and
  // completion confirmations, which leave text behind).
  if (/\S/.test(curText)) {
    return;
  }
  const prevText = doc.lineAt(prevLine).text;
  let stripped = prevText.replace(/\s+$/, '');
  stripped = stripLineComment(stripped);
  const opener =
    endsWithKeyword(stripped, 'do')
      ? 'do'
      : endsWithKeyword(stripped, 'has')
        ? 'has'
        : null;
  if (!opener) {
    return;
  }
  if (keywordInString(stripped, opener)) {
    return;
  }
  const base = (/^\s*/.exec(prevText) ?? [''])[0];
  // Don't duplicate: scan below for the first line dedented to the
  // opener's level. If it is an `end`, this block is already closed.
  for (let i = curLine + 1; i < Math.min(doc.lineCount, curLine + 41); i++) {
    const text = doc.lineAt(i).text;
    if (/\S/.test(text)) {
      const indent = (/^\s*/.exec(text) ?? [''])[0].length;
      if (indent <= base.length) {
        if (/^\s*end\b/.test(text)) {
          return;
        }
        break;
      }
    }
  }
  const insertSpaces = editor.options.insertSpaces !== false;
  const tabSize = Number(editor.options.tabSize ?? 4) || 4;
  const step = insertSpaces ? ' '.repeat(tabSize) : '\t';
  const middle = base + step;
  const endLine = base + 'end';
  await editor.edit((eb) => {
    eb.replace(
      new vscode.Range(curLine, 0, curLine, curText.length),
      `${middle}\n${endLine}`
    );
  });
  const pos = new vscode.Position(curLine, middle.length);
  editor.selection = new vscode.Selection(pos, pos);
}

// ---------------------------------------------------------------------------
// LSP client
// ---------------------------------------------------------------------------

function startClient(context: vscode.ExtensionContext): void {
  const [command, ...args] = serverCommand();
  const serverOptions: ServerOptions = {
    command,
    args,
    options: { cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'hella' }],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.hll'),
    },
  };
  client = new LanguageClient('hella', 'Hella Language Server', serverOptions, clientOptions);
  client.start();
  notifyInfo(`language server started (${command} ${args.join(' ')})`);
}

async function stopClient(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Hella');
  context.subscriptions.push(output);

  startClient(context);

  // Canonical formatter (`hella fmt` via the CLI, not LSP — the language
  // server does not advertise `documentFormattingProvider`, same as nvim).
  context.subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider('hella', {
      provideDocumentFormattingEdits(
        doc: vscode.TextDocument
      ): vscode.ProviderResult<vscode.TextEdit[]> {
        if (!cfg<boolean>('format.enabled', true) || formatting) {
          return [];
        }
        const tmp = stageToTempHll(doc.getText());
        try {
          const { code, out } = runFmt(tmp, false);
          if (code !== 0) {
            notifyError(`fmt failed: ${out || `exit code ${code}`}`);
            return [];
          }
          return fullDocumentEdit(doc, fs.readFileSync(tmp, 'utf8'));
        } finally {
          cleanupTemp(tmp);
        }
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hella.format', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'hella') {
        return;
      }
      await formatDocument(editor.document);
    }),
    vscode.commands.registerCommand('hella.formatCheck', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'hella') {
        return;
      }
      await formatDocument(editor.document, { check: true });
    }),
    vscode.commands.registerCommand('hella.restartServer', async () => {
      await stopClient();
      startClient(context);
    })
  );

  // Format-on-save (BufWritePre equivalent), on by default like nvim.
  // Uses `waitUntil` so the formatted text lands before the pending write
  // picks it up — the same guarantee nvim gets from BufWritePre.
  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((e) => {
      if (
        e.document.languageId !== 'hella' ||
        !cfg<boolean>('format.enabled', true) ||
        !cfg<boolean>('format.onSave', true) ||
        formatting
      ) {
        return;
      }
      // Skip when the user already drives formatting via
      // `editor.formatOnSave` (the provider above handles that path);
      // otherwise we would format twice (harmless but noisy).
      const formatOnSave: unknown = vscode.workspace
        .getConfiguration('editor', e.document.uri)
        .get('formatOnSave');
      if (
        formatOnSave === true ||
        formatOnSave === 'on' ||
        formatOnSave === 'modifications'
      ) {
        return;
      }
      const tmp = stageToTempHll(e.document.getText());
      try {
        const { code, out } = runFmt(tmp, false);
        if (code !== 0) {
          notifyError(`fmt failed: ${out || `exit code ${code}`}`);
          return;
        }
        const edits = fullDocumentEdit(
          e.document,
          fs.readFileSync(tmp, 'utf8')
        );
        if (edits.length > 0) {
          e.waitUntil(Promise.resolve(edits));
        }
      } finally {
        cleanupTemp(tmp);
      }
    })
  );

  // endwise: watch for newline insertions (vim.on_key + schedule equivalent).
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(async (e) => {
      if (!endwiseEnabled() || e.contentChanges.length === 0) {
        return;
      }
      const editor = vscode.window.visibleTextEditors.find(
        (ed) => ed.document === e.document
      );
      if (!editor || e.document.languageId !== 'hella') {
        return;
      }
      for (const ch of e.contentChanges) {
        if (ch.text.includes('\n')) {
          // Post-newline state: cursor sits on the blank new line whose
          // previous line may end with `do`/`has`.
          await maybeEndwise(editor, ch.range.start.line);
          break;
        }
      }
    })
  );
}

export async function deactivate(): Promise<void> {
  await stopClient();
}
