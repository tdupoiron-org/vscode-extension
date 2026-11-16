import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GardenStore, errorMessage } from './garden';
import { createGardenMcpServer } from './tools';

export interface GardenEndpoint {
  url: string;
  token: string;
  close(): Promise<void>;
}

export async function startGardenServer(
  store: GardenStore,
  log: (message: string) => void,
  version: string,
  onFatalError: (error: Error) => void
): Promise<GardenEndpoint> {
  const token = randomBytes(32).toString('hex');
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const active = new Set<McpServer>();
  let url: URL;
  let closing: Promise<void> | undefined;
  const listener = createServer((request, response) => {
    void handle(request, response).catch(error => {
      log(`MCP request failed: ${errorMessage(error)}`);
      if (!response.headersSent) {
        response.writeHead(500).end('MCP request failed. See Gardening logs.');
      } else {
        response.destroy();
      }
    });
  });
  listener.requestTimeout = 15_000;
  listener.headersTimeout = 10_000;
  listener.timeout = 30_000;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (closing) {
      response.writeHead(503).end('Server is stopping');
      return;
    }
    // SDK Host/Origin options are deprecated; validate at the HTTP boundary instead.
    if (request.headers.host !== url.host ||
        (request.headers.origin !== undefined && request.headers.origin !== url.origin)) {
      response.writeHead(403).end('Host or Origin is not allowed');
      return;
    }
    const authorization = Buffer.from(request.headers.authorization ?? '');
    if (authorization.length !== expectedAuthorization.length ||
        !timingSafeEqual(authorization, expectedAuthorization)) {
      response.writeHead(401).end('Unauthorized');
      return;
    }
    if (request.url !== '/mcp') {
      response.writeHead(404).end('Not found');
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end('Only POST is supported');
      return;
    }
    if (active.size >= 32) {
      response.writeHead(503).end('Too many concurrent requests');
      return;
    }
    const mcp = createGardenMcpServer(store, log, version);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      maxRequestBodySize: 64 * 1024
    });
    active.add(mcp);
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    } finally {
      try {
        await mcp.close();
      } finally {
        active.delete(mcp);
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      listener.off('error', reject);
      resolve();
    });
  });
  const address = listener.address();
  if (!address || typeof address === 'string') {
    listener.close();
    throw new Error('Cannot determine the gardening server port');
  }
  url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  listener.on('error', onFatalError);
  return {
    url: url.href,
    token,
    close() {
      closing ??= (async () => {
        const stopped = new Promise<void>((resolve, reject) => {
          listener.close(error => error ? reject(error) : resolve());
        });
        listener.closeAllConnections();
        await Promise.all([stopped, ...[...active].map(mcp => mcp.close())]);
      })();
      return closing;
    }
  };
}
