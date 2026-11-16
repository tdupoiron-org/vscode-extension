import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const nameSchema = z.string().trim().min(1).max(200);
export const idSchema = z.string().uuid();
const plantSchema = z.object({
  id: idSchema,
  name: nameSchema,
  location: nameSchema.optional(),
  wateringHistory: z.array(z.string().datetime())
}).strict();
const taskSchema = z.object({
  id: idSchema,
  description: z.string().trim().min(1).max(1000),
  plantId: idSchema.optional(),
  completed: z.boolean()
}).strict();
const gardenSchema = z.object({
  version: z.literal(1),
  plants: z.array(plantSchema),
  tasks: z.array(taskSchema)
}).strict().superRefine((garden, context) => {
  const plantIds = new Set(garden.plants.map(plant => plant.id));
  const taskIds = new Set(garden.tasks.map(task => task.id));
  if (plantIds.size !== garden.plants.length || taskIds.size !== garden.tasks.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate garden IDs' });
  }
  if (garden.tasks.some(task => task.plantId && !plantIds.has(task.plantId))) {
    context.addIssue({ code: 'custom', message: 'Task references an unknown plant' });
  }
});
type Garden = z.infer<typeof gardenSchema>;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export class GardenStore {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private constructor(
    private readonly directory: string,
    private garden: Garden
  ) {}

  static async open(directory: string): Promise<GardenStore> {
    await mkdir(directory, { recursive: true });
    const lockPath = join(directory, 'garden.lock');
    let lock;
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (hasCode(error, 'EEXIST')) {
        throw new Error(`Garden storage is locked: ${lockPath}. Close the other gardening extension window. If VS Code crashed, remove this lock only after confirming no other window uses this garden.`);
      }
      throw error;
    }
    try {
      await lock.writeFile(`Extension host PID: ${process.pid}\n`);
      let garden: Garden;
      try {
        garden = gardenSchema.parse(JSON.parse(await readFile(join(directory, 'garden.json'), 'utf8')));
      } catch (error) {
        if (!hasCode(error, 'ENOENT')) {
          throw new Error(`Cannot load garden data in ${directory}: ${errorMessage(error)}`);
        }
        garden = { version: 1, plants: [], tasks: [] };
      }
      return new GardenStore(directory, garden);
    } catch (error) {
      await unlink(lockPath);
      throw error;
    } finally {
      await lock.close();
    }
  }

  private async snapshot(): Promise<Garden> {
    if (this.closed) {
      throw new Error('Garden storage is closed');
    }
    await this.queue;
    return structuredClone(this.garden);
  }

  private mutate<T>(change: (garden: Garden) => T): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('Garden storage is closed'));
    }
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.garden);
      const result = change(next);
      gardenSchema.parse(next);
      const temporaryPath = join(this.directory, `garden-${randomUUID()}.tmp`);
      try {
        await open(temporaryPath, 'wx', 0o600).then(async file => {
          try {
            await file.writeFile(`${JSON.stringify(next, null, 2)}\n`);
            await file.sync();
          } finally {
            await file.close();
          }
        });
        await rename(temporaryPath, join(this.directory, 'garden.json'));
      } catch (error) {
        try {
          await unlink(temporaryPath);
        } catch (cleanupError) {
          if (!hasCode(cleanupError, 'ENOENT')) {
            throw new AggregateError([error, cleanupError], 'Garden write and temporary-file cleanup failed');
          }
        }
        throw error;
      }
      this.garden = next;
      return structuredClone(result);
    });
    // Keep later operations usable after a failed write; the caller receives the original rejection.
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async listPlants() {
    return (await this.snapshot()).plants;
  }

  async listTasks() {
    return (await this.snapshot()).tasks;
  }

  addPlant(name: string, location?: string) {
    return this.mutate(garden => {
      const plant = plantSchema.parse({
        id: randomUUID(), name, ...(location === undefined ? {} : { location }), wateringHistory: []
      });
      garden.plants.push(plant);
      return plant;
    });
  }

  recordWatering(plantId: string) {
    return this.mutate(garden => {
      const plant = garden.plants.find(plant => plant.id === plantId);
      if (!plant) {
        throw new Error(`Unknown plant ID: ${plantId}`);
      }
      plant.wateringHistory.push(new Date().toISOString());
      return plant;
    });
  }

  addTask(description: string, plantId?: string) {
    return this.mutate(garden => {
      if (plantId && !garden.plants.some(plant => plant.id === plantId)) {
        throw new Error(`Unknown plant ID: ${plantId}`);
      }
      const task = taskSchema.parse({
        id: randomUUID(), description, ...(plantId === undefined ? {} : { plantId }), completed: false
      });
      garden.tasks.push(task);
      return task;
    });
  }

  completeTask(taskId: string) {
    return this.mutate(garden => {
      const task = garden.tasks.find(task => task.id === taskId);
      if (!task) {
        throw new Error(`Unknown task ID: ${taskId}`);
      }
      task.completed = true;
      return task;
    });
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      await this.queue;
      await unlink(join(this.directory, 'garden.lock'));
    }
  }
}
