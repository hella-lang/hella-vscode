# Hella for VS Code

Complete VS Code extension for the **Hella** programming language.

📦 [Install from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=hella-lang.hella)

Provides:

- **Syntax highlighting** — all Hella keywords, operators, literals,
  strings (including raw `r"..."`, multiline `"""..."""`, and
  interpolation `{ expr }`), attributes, comments, and TODO/FIXME
  highlighting (TextMate grammar ported from `syntax/hella.vim`).
- **LSP integration** — connects to the Hella language server
  (`hella lsp`) for diagnostics, hover, goto-definition, completions,
  and document symbols.
- **Formatting** — runs the canonical formatter (`hella fmt`) on the
  current file, with format-on-save enabled by default. Formatting goes
  through the CLI, not LSP: the language server does not advertise
  `documentFormattingProvider`.
- **Auto-close blocks** — pressing Enter below a line ending in `do` or
  `has` inserts the matching `end` (endwise-style, no dependencies).

File extensions: `.hll` (canonical), `.hlt` and `.holt` (legacy aliases).

## Installation

From the [Marketplace listing](https://marketplace.visualstudio.com/items?itemName=hella-lang.hella):

- In VS Code: open the Extensions view (`Ctrl`/`Cmd`+`Shift`+`X`),
  search for **Hella**, and click **Install**.
- Or from the command line:

```bash
code --install-extension hella-lang.hella-lang
```

## Requirements

- The `hella` CLI on your PATH (provides the `lsp` and `fmt`
  subcommands this extension uses).

```bash
# From a checkout of the Hella toolchain repository
cargo install --path crates/hella-cli
hella setup   # install the standard library to ~/.hella/lib
```

## Commands

| Command                                    | Equivalent (nvim)      |
|--------------------------------------------|------------------------|
| `Hella: Format Document (hella fmt)`       | `:HellaFormat`         |
| `Hella: Check Formatting (hella fmt --check)` | `:HellaFormatCheck` |
| `Hella: Restart Language Server`           | `require("hella").restart()` |

## Extension Settings

| Setting                      | Default     | Description |
|------------------------------|-------------|-------------|
| `hella.server.path`          | `"hella"`   | Path to the Hella binary (`cmd` in nvim). |
| `hella.server.args`          | `["lsp"]`   | Language server arguments (LSP over stdio). |
| `hella.format.enabled`       | `true`      | Enable `hella fmt` formatting (`format.enabled`). |
| `hella.format.command`       | `[]`        | Override formatter command; empty derives it from the server command by swapping `lsp` → `fmt` (`format.cmd = nil`). |
| `hella.format.onSave`        | `true`      | Format on save (`format.on_save`, BufWritePre equivalent). |
| `hella.endwise.enabled`      | `true`      | Auto-close `do`/`has` with `end` on Enter (`endwise.enabled`). |
| `hella.notifications.enabled`| `false`     | Info notifications (`notify`). |

## Notes

- Formatting stages dirty buffers through a temporary `.hll` file,
  exactly like `hella.nvim` (the CLI only collects `.hll` sources,
  while the extension also edits `.hlt`/`.holt`).
- `endwise` skips strings, `//` comments, partial words (`mendo`),
  and blocks that already have an `end` below the cursor.
