import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { GardenStore } from '../garden';
import { startGardenServer, type GardenEndpoint } from '../server';
import { fixture } from './fixture';

async function connect(endpoint: GardenEndpoint): Promise<Client> {
  const client = new Client({ name: 'garden-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } }
  }));
  return client;
}

test('real MCP discovery, gardening workflow, errors, parallel clients and restart', async t => {
  const { directory, after } = await fixture(t);
  const logs: string[] = [];
  const store = await GardenStore.open(directory);
  after(() => store.close());
  const endpoint = await startGardenServer(store, message => logs.push(message), '0.0.1', assert.fail);
  after(() => endpoint.close());
  const client = await connect(endpoint);
  after(() => client.close());
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), [
    'add_plant', 'add_task', 'complete_task', 'list_plants', 'list_tasks', 'record_watering'
  ]);
  const added = await client.callTool({ name: 'add_plant', arguments: { name: 'Tomato', location: 'Patio' } });
  const content = z.array(z.object({ type: z.literal('text'), text: z.string() })).parse(added.content);
  const plant = z.object({ id: z.string().uuid() }).parse(JSON.parse(content[0].text));
  assert.ok(!(await client.callTool({ name: 'record_watering', arguments: { plantId: plant.id } })).isError);
  const addedTask = await client.callTool({
    name: 'add_task', arguments: { description: 'Prune tomato', plantId: plant.id }
  });
  const taskContent = z.array(z.object({ text: z.string() })).parse(addedTask.content);
  const task = z.object({ id: z.string().uuid() }).parse(JSON.parse(taskContent[0].text));
  assert.ok(!(await client.callTool({ name: 'complete_task', arguments: { taskId: task.id } })).isError);
  const listed = await client.callTool({ name: 'list_tasks', arguments: {} });
  assert.deepEqual(listed.content, [{
    type: 'text',
    text: JSON.stringify([{ id: task.id, description: 'Prune tomato', plantId: plant.id, completed: true }])
  }]);
  assert.equal((await client.callTool({ name: 'add_plant', arguments: { name: '  ' } })).isError, true);
  assert.equal((await client.callTool({
    name: 'record_watering', arguments: { plantId: '00000000-0000-4000-8000-000000000001' }
  })).isError, true);
  const second = await connect(endpoint);
  after(() => second.close());
  await Promise.all([
    client.callTool({ name: 'add_plant', arguments: { name: 'Basil' } }),
    second.callTool({ name: 'add_plant', arguments: { name: 'Mint' } })
  ]);
  assert.equal((await store.listPlants()).length, 3);
  await second.close();
  await client.close();
  await endpoint.close();
  await store.close();
  const reopened = await GardenStore.open(directory);
  after(() => reopened.close());
  const restarted = await startGardenServer(reopened, () => {}, '0.0.1', assert.fail);
  after(() => restarted.close());
  const reconnected = await connect(restarted);
  after(() => reconnected.close());
  const plantsResult = await reconnected.callTool({ name: 'list_plants', arguments: {} });
  const plantContent = z.array(z.object({ text: z.string() })).parse(plantsResult.content);
  const plants = z.array(z.object({ name: z.string(), wateringHistory: z.array(z.string()) }))
    .parse(JSON.parse(plantContent[0].text));
  assert.equal(plants.length, 3);
  assert.equal(plants[0].wateringHistory.length, 1);
  assert.ok(logs.some(message => message.includes('Tool failed: record_watering')));
  assert.ok(logs.every(message => !message.includes(endpoint.token)));
});

test('HTTP boundary rejects unauthorized, hostile, oversized and invalid requests; close releases port', async t => {
  const { directory, after } = await fixture(t);
  const store = await GardenStore.open(directory);
  after(() => store.close());
  const endpoint = await startGardenServer(store, () => {}, '0.0.1', assert.fail);
  after(() => endpoint.close());
  const headers = { Authorization: `Bearer ${endpoint.token}` };
  assert.equal((await fetch(endpoint.url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(endpoint.url, {
    method: 'POST', headers: { Authorization: 'Bearer incorrect' }
  })).status, 401);
  assert.equal((await fetch(endpoint.url, {
    method: 'POST', headers: { ...headers, Origin: 'https://example.com' }
  })).status, 403);
  const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(endpoint.url, {
      method: 'POST', headers: { ...headers, Host: 'attacker.example' }
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await fetch(endpoint.url, { headers })).status, 405);
  assert.equal((await fetch(new URL('/other', endpoint.url), { method: 'POST', headers })).status, 404);
  assert.equal((await fetch(endpoint.url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: '{invalid'
  })).status, 400);
  assert.equal((await fetch(endpoint.url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ padding: 'x'.repeat(70_000) })
  })).status, 413);
  await endpoint.close();
  await assert.rejects(fetch(endpoint.url));
});
