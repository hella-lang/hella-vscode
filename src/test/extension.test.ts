import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';

suite('Hella Extension Test Suite', () => {
  vscode.window.showInformationMessage('Start all tests.');

  test('Hella commands are registered', async () => {
    for (const cmd of ['hella.format', 'hella.formatCheck', 'hella.restartServer']) {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes(cmd), `expected command ${cmd} to be registered`);
    }
  });

  test('Hella language is registered for .hll files', async () => {
    const langs = await vscode.languages.getLanguages();
    assert.ok(langs.includes('hella'), 'expected `hella` language to be registered');
  });
});
