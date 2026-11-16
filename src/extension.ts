import * as vscode from 'vscode';
import { GardenStore, errorMessage } from './garden';
import { startGardenServer, type GardenEndpoint } from './server';

let shutdown: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Gardening', { log: true });
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  context.subscriptions.push(output, status, vscode.commands.registerCommand(
    'gardening.showLogs', () => output.show()
  ));
  status.command = 'gardening.showLogs';
  status.name = 'Gardening MCP';
  status.text = '$(loading~spin) Gardening: Starting';
  status.tooltip = 'Starting the embedded gardening MCP server. Click to view logs.';
  status.show();

  let store: GardenStore | undefined;
  let endpoint: GardenEndpoint | undefined;
  let provider: vscode.Disposable | undefined;
  let cleanup: Promise<void> | undefined;
  shutdown = () => cleanup ??= (async () => {
    provider?.dispose();
    try {
      await endpoint?.close();
    } finally {
      await store?.close();
    }
  })();
  const fail = (error: unknown) => {
    provider?.dispose();
    status.text = '$(error) Gardening: Error';
    status.tooltip = 'Gardening MCP failed. Click for logs, then reload the window to retry.';
    output.error(errorMessage(error));
    void vscode.window.showErrorMessage(
      'Gardening MCP failed. Open Gardening: Show Logs for details, then reload the window to retry.'
    );
  };
  try {
    if (vscode.env.uiKind === vscode.UIKind.Web || vscode.env.remoteName) {
      throw new Error('This demo supports local desktop VS Code only, not web or remote windows.');
    }
    const storage = context.storageUri ?? vscode.Uri.joinPath(context.globalStorageUri, 'no-workspace');
    output.info(`Garden storage: ${storage.fsPath}`);
    store = await GardenStore.open(storage.fsPath);
    endpoint = await startGardenServer(store, message => output.info(message), '0.0.1', error => {
      fail(error);
      void shutdown?.().catch(cleanupError => output.error(`Shutdown failed: ${errorMessage(cleanupError)}`));
    });
    const definition = new vscode.McpHttpServerDefinition(
      'Gardening',
      vscode.Uri.parse(endpoint.url),
      { Authorization: `Bearer ${endpoint.token}` },
      '0.0.1'
    );
    provider = vscode.lm.registerMcpServerDefinitionProvider('gardening', {
      provideMcpServerDefinitions: () => [definition]
    });
    context.subscriptions.push(provider);
    status.text = '$(check) Gardening: Ready';
    status.tooltip = 'Embedded MCP endpoint is listening and registered. Click to view logs.';
    output.info(`Gardening MCP ready at ${endpoint.url}. Registered six tools with VS Code.`);
  } catch (error) {
    fail(error);
    await shutdown();
  }
}

export async function deactivate(): Promise<void> {
  await shutdown?.();
  shutdown = undefined;
}
