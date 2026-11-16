import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import * as vscode from 'vscode';

// Executed by VS Code's extension test host, not by the Node test runner.
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('tdupoiron.gardening-mcp-demo');
  assert.ok(extension, 'Packaged gardening extension must be installed');
  await extension.activate();
  assert.equal(extension.isActive, true);
  assert.ok((await vscode.commands.getCommands(true)).includes('gardening.showLogs'));
  await vscode.commands.executeCommand('gardening.showLogs');

  const logDirectory = process.env.GARDEN_SMOKE_LOG_DIR;
  assert.ok(logDirectory, 'GARDEN_SMOKE_LOG_DIR must point to the isolated VS Code logs directory');
  let log = '';
  for (let attempt = 0; attempt < 50; attempt++) {
    const files = await readdir(logDirectory, { recursive: true });
    const gardeningLogs = files.filter(path => path.endsWith('Gardening.log'));
    log = (await Promise.all(gardeningLogs.map(path => readFile(join(logDirectory, path), 'utf8')))).join('\n');
    if (log.includes('Gardening MCP ready at')) {
      break;
    }
    await setTimeout(100);
  }
  assert.match(log, /Gardening MCP ready at http:\/\/127\.0\.0\.1:\d+\/mcp/);
  assert.match(log, /Registered six tools with VS Code/);
  assert.doesNotMatch(log, /\[error\]/i);
  console.log('Packaged extension activated, registered MCP, and opened its logs in desktop VS Code.');
}
