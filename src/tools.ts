import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { GardenStore, errorMessage, idSchema, nameSchema } from './garden';

export function createGardenMcpServer(
  store: GardenStore,
  log: (message: string) => void,
  version: string
): McpServer {
  const server = new McpServer({ name: 'gardening', version });
  const annotations = { openWorldHint: false, destructiveHint: false };
  async function result(tool: string, action: () => Promise<unknown>): Promise<CallToolResult> {
    try {
      const value = await action();
      log(`Tool succeeded: ${tool}`);
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    } catch (error) {
      log(`Tool failed: ${tool}: ${errorMessage(error)}`);
      return { isError: true, content: [{ type: 'text', text: errorMessage(error) }] };
    }
  }
  server.registerTool('add_plant', {
    description: 'Add a garden plant with a name and optional location.',
    inputSchema: { name: nameSchema, location: nameSchema.optional() },
    annotations
  }, ({ name, location }) => result('add_plant', () => store.addPlant(name, location)));
  server.registerTool('list_plants', {
    description: 'List all plants, including IDs, locations and watering history.',
    inputSchema: {},
    annotations: { ...annotations, readOnlyHint: true }
  }, () => result('list_plants', () => store.listPlants()));
  server.registerTool('record_watering', {
    description: 'Record that a plant was watered now, using its ID from list_plants.',
    inputSchema: { plantId: idSchema },
    annotations
  }, ({ plantId }) => result('record_watering', () => store.recordWatering(plantId)));
  server.registerTool('add_task', {
    description: 'Add a gardening task, optionally linked to an existing plant ID.',
    inputSchema: { description: z.string().trim().min(1).max(1000), plantId: idSchema.optional() },
    annotations
  }, ({ description, plantId }) => result('add_task', () => store.addTask(description, plantId)));
  server.registerTool('list_tasks', {
    description: 'List all garden tasks, including IDs and completion state.',
    inputSchema: {},
    annotations: { ...annotations, readOnlyHint: true }
  }, () => result('list_tasks', () => store.listTasks()));
  server.registerTool('complete_task', {
    description: 'Mark a gardening task completed using its ID from list_tasks.',
    inputSchema: { taskId: idSchema },
    annotations: { ...annotations, idempotentHint: true }
  }, ({ taskId }) => result('complete_task', () => store.completeTask(taskId)));
  return server;
}
