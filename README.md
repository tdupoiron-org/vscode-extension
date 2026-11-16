# Gardening MCP Demo

A desktop VS Code extension with a visible status-bar indicator and six gardening
tools exposed through an embedded MCP server. The server runs **inside the
extension host**, not in a separate daemon. Installing the VSIX is sufficient:
customers do not need Node.js, a server installation, or manual MCP configuration.

## Requirements

- Local desktop VS Code 1.101 or newer, with a trusted workspace.
- An MCP-capable chat client in VS Code, such as GitHub Copilot, with MCP enabled.
  Chat access, tool approval, and organization policy still apply.
- For development only: Node.js 22 or newer and npm.

Web VS Code and remote windows (SSH, containers, WSL) are outside this demo's
scope. The extension does not call external services; a chat provider may still
process tool inputs and results when you use its agent.

## Build and run

```sh
npm ci
npm run check
npm test
npm run build
```

Open this repository in VS Code and press **F5**, selecting **Run Gardening
Extension**. In the Extension Development Host, trust the workspace and wait for
**Gardening: Ready** in the status bar. Click the indicator, or run **Gardening:
Show Logs**, to open the output channel.

The indicator shows extension/server readiness, not whether a chat client is
connected. Startup failures show **Gardening: Error** with details in the logs.

## Package and install

```sh
npm run package
```

Install `gardening-mcp-demo-0.0.1.vsix` using **Extensions: Install from VSIX…**.
Reload the window if prompted. The VSIX bundles the MCP SDK and other runtime
dependencies; no external `node` command is launched.

This is a private demo package, not a Marketplace publication or a licensed
redistribution offering.

## Customer walkthrough

1. Confirm **Gardening: Ready** in the status bar.
2. Open **MCP: List Servers** and find **Gardening**, contributed by the extension.
   Start/enable it if required and accept the client's trust prompts.
3. Open an agent chat with gardening tools enabled. Try:

   > Use the gardening tools to add a Tomato plant on the Patio. Record that I
   > watered it, then create a task to prune it.

4. Then ask:

   > List my garden tasks, complete the tomato pruning task, and list my plants
   > and tasks again.

5. Reload VS Code and ask the client to list plants and tasks again. The same
   plant, watering history, and completed task should remain.

The garden starts empty. Tool IDs are returned by add/list operations; ask the
agent to use those IDs rather than inventing them.

| Tool | Inputs | Result |
| --- | --- | --- |
| `add_plant` | `name`, optional `location` | New plant with UUID and empty watering history |
| `list_plants` | None | All plants, locations, and watering timestamps |
| `record_watering` | `plantId` | Plant with the current UTC timestamp appended |
| `add_task` | `description`, optional `plantId` | New incomplete task |
| `list_tasks` | None | All tasks, including completed tasks |
| `complete_task` | `taskId` | Completed task; repeating this is safe |

Tool results contain JSON in MCP text content. Invalid inputs, unknown IDs, and
storage failures return explicit errors rather than successful empty results.
There is no weather integration, scheduling, reminder service, or custom dashboard.

## Lifecycle and storage

On activation, the extension starts a Streamable HTTP endpoint at
`http://127.0.0.1:<assigned-port>/mcp` and registers it using VS Code's MCP server
definition provider API. A random bearer token protects each activation; Host and
Origin validation rejects unexpected hosts and browser origins. The token is
passed in the registered definition and is not logged or written to configuration.
No public network interface is used.

Requests use stateless MCP transport and share one garden store, supporting
multiple clients and reconnects. Requests are limited to 64 KiB with at most 32
concurrent requests. On deactivation the provider is removed, HTTP connections
are closed, pending writes are drained, and the storage lock is released. Nothing
is intended to keep running after the extension host exits.

`garden.json` lives in VS Code's extension-owned workspace storage, not in the
repository. Empty windows use a shared `no-workspace` folder in the extension's
global storage. **Gardening: Show Logs** reports the exact storage directory.
Data persists across extension reloads; it is not automatically seeded or reset.
Writes are serialized and atomically replace the JSON file. Invalid persisted
data is never silently discarded.

Only one extension instance can own a garden directory at a time. A second window
using the same storage reports a lock error instead of risking data loss. A crash
or force-quit can leave `garden.lock` behind: close all windows using that garden,
then remove **only that lock file** in the logged storage directory and reload.
To reset the demo, close the owning window first and remove `garden.json` from
that directory. Back it up first if its contents matter.

## Troubleshooting

- **Error indicator:** inspect **Gardening: Show Logs**, correct the storage or
  compatibility problem, then run **Developer: Reload Window**.
- **No gardening tools:** confirm the window is trusted, the extension is enabled,
  the MCP server is enabled, and your agent permits those tools. Organization
  policy can block MCP even when the extension itself is ready.
- **Connection failed after reload:** let the client refresh/restart the
  extension-provided server definition. Each activation gets a fresh port and
  token; do not copy the temporary endpoint into a static configuration.
- **Corrupt data:** preserve a backup, then repair or explicitly remove the JSON
  file while the owning window is closed. Startup will not overwrite it.

## Validation

`npm test` uses Node's built-in runner and the official MCP client over real local
HTTP connections. It covers discovery, the gardening workflow, concurrent writes,
persistence, reconnects, invalid data and IDs, failed writes, storage locking,
HTTP authentication/Host/Origin checks, request-size limits, and shutdown.

After `npm test` and `npm run build`, an optional desktop extension-host smoke
test checks activation, MCP registration, and the log command. With `code` on your
PATH, run this from the repository root in a POSIX shell:

```sh
PROFILE_DIR="$(mktemp -d)"
GARDEN_SMOKE_LOG_DIR="$PROFILE_DIR/logs" code --wait \
  --user-data-dir "$PROFILE_DIR/user" \
  --extensions-dir "$PROFILE_DIR/extensions" \
  --logsPath "$PROFILE_DIR/logs" \
  --extensionDevelopmentPath "$PWD" \
  --extensionTestsPath "$PWD/.test-build/test/vscodeSmoke.js" \
  --disable-workspace-trust --skip-welcome --skip-release-notes
```

The test host exits automatically. This uses a separate temporary profile;
workspace trust is disabled only for that test instance. Inspect and remove the
printed temporary profile directory after testing (`echo "$PROFILE_DIR"`).
The smoke test does not sign in to a chat provider or exercise its approval UI.

For release/demo verification, also install the generated VSIX in a clean local
VS Code profile and complete the customer walkthrough. Passing server tests alone
does not establish that a customer's Copilot policies permit tool discovery.