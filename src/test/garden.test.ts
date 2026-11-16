import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { GardenStore } from '../garden';
import { fixture } from './fixture';

test('garden persists complete workflow and concurrent writes across reopen', async t => {
  const { directory, after } = await fixture(t);
  const store = await GardenStore.open(directory);
  after(() => store.close());
  const plants = await Promise.all([
    store.addPlant('Tomato', 'Patio'),
    store.addPlant('Basil')
  ]);
  const watered = await store.recordWatering(plants[0].id);
  assert.equal(watered.wateringHistory.length, 1);
  assert.ok(Number.isFinite(Date.parse(watered.wateringHistory[0])));
  const task = await store.addTask('Prune tomato', plants[0].id);
  assert.equal((await store.completeTask(task.id)).completed, true);
  assert.equal((await store.completeTask(task.id)).completed, true);
  await store.close();
  const reopened = await GardenStore.open(directory);
  after(() => reopened.close());
  assert.deepEqual(await reopened.listPlants(), [watered, plants[1]]);
  assert.deepEqual(await reopened.listTasks(), [{ ...task, completed: true }]);
  assert.deepEqual(await readdir(directory), ['garden.json', 'garden.lock']);
});

test('invalid references fail without mutation and later writes remain usable', async t => {
  const { directory, after } = await fixture(t);
  const store = await GardenStore.open(directory);
  after(() => store.close());
  const missing = '00000000-0000-4000-8000-000000000001';
  await assert.rejects(store.recordWatering(missing), /Unknown plant/);
  await assert.rejects(store.addTask('Prune', missing), /Unknown plant/);
  await assert.rejects(store.completeTask(missing), /Unknown task/);
  await assert.rejects(store.addPlant('  '));
  assert.deepEqual(await store.listPlants(), []);
  assert.deepEqual(await store.listTasks(), []);
  await store.addPlant('Basil');
  assert.equal((await store.listPlants()).length, 1);
});

test('competing stores are rejected and shutdown waits for queued writes', async t => {
  const { directory, after } = await fixture(t);
  const store = await GardenStore.open(directory);
  after(() => store.close());
  await assert.rejects(GardenStore.open(directory), /Garden storage is locked/);
  const write = store.addPlant('Tomato');
  await store.close();
  await write;
  await assert.rejects(store.addPlant('Basil'), /closed/);
  const reopened = await GardenStore.open(directory);
  after(() => reopened.close());
  assert.equal((await reopened.listPlants()).length, 1);
});

test('malformed storage is preserved and failed startup releases its lock', async t => {
  const { directory } = await fixture(t);
  const path = join(directory, 'garden.json');
  await writeFile(path, '{broken');
  await assert.rejects(GardenStore.open(directory), /Cannot load garden data/);
  assert.equal(await readFile(path, 'utf8'), '{broken');
  assert.deepEqual(await readdir(directory), ['garden.json']);
});

test('write failures do not update in-memory state or leave temporary files', async t => {
  const { directory, after } = await fixture(t);
  const store = await GardenStore.open(directory);
  after(() => store.close());
  // A directory at the destination deterministically prevents atomic replacement, even as root.
  await mkdir(join(directory, 'garden.json'));
  await assert.rejects(store.addPlant('Tomato'));
  assert.deepEqual(await store.listPlants(), []);
  assert.deepEqual(await readdir(directory), ['garden.json', 'garden.lock']);
  await rm(join(directory, 'garden.json'), { recursive: true });
  await store.addPlant('Basil');
  assert.equal((await store.listPlants()).length, 1);
});
