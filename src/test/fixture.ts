import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

export async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'garden-test-'));
  const cleanups: (() => Promise<void>)[] = [
    () => rm(directory, { recursive: true, force: true })
  ];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, 'Test cleanup failed');
    }
  });
  return { directory, after: (cleanup: () => Promise<void>) => cleanups.push(cleanup) };
}
