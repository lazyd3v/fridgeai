import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from './app.ts';

test('inventory validation, persistence, deletion, and demo snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fridge-test-'));
  const instance = createApp(directory, { mode: 'demo', device: '' }, undefined, async (name, notes) => {
    assert.equal(name, 'Milk');
    assert.equal(notes, 'Blue cap');
    return 'milk_bottle';
  });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const post = (body: unknown) => fetch(`${base}/api/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${base}/api/agent/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: '' }) })).status, 400);
    assert.equal((await post({ name: '  ', quantity: 1 })).status, 400);
    assert.equal((await post({ name: 'Milk', quantity: 0 })).status, 400);
    assert.equal((await post({ name: 'Milk', quantity: 1.5 })).status, 400);
    assert.equal((await post({ name: 'Milk', notes: 123 })).status, 400);
    const response = await post({ name: ' Milk ', quantity: 2, notes: ' Blue cap ' });
    assert.equal(response.status, 201);
    const item = await response.json();
    assert.equal(item.name, 'Milk');
    assert.equal(item.icon, 'milk_bottle');
    assert.equal(item.notes, 'Blue cap');
    const { createStore } = await import('./store.ts');
    const reopened = createStore(join(directory, 'fridge.sqlite'));
    assert.equal(reopened.listItems()[0].name, 'Milk');
    reopened.close();
    const inventory = await (await fetch(`${base}/api/items`)).json();
    assert.equal(inventory[0].quantity, 2);
    assert.equal(inventory[0].icon, 'milk_bottle');
    const shot = await fetch(`${base}/api/captures`, { method: 'POST' });
    assert.equal(shot.status, 201);
    const capture = await shot.json();
    assert.match(await (await fetch(`${base}${capture.url}`)).text(), /<svg/);
    assert.equal((await (await fetch(`${base}/api/captures/latest`)).json()).id, capture.id);
    assert.equal((await fetch(`${base}/api/items/${item.id}`, { method: 'DELETE' })).status, 204);
    assert.deepEqual(await (await fetch(`${base}/api/items`)).json(), []);
    assert.equal((await fetch(`${base}/api/items/${item.id}`, { method: 'DELETE' })).status, 404);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('replay captures preserve image bytes and report a missing image', async () => {
  const { captureImage } = await import('./camera.ts');
  const directory = await mkdtemp(join(tmpdir(), 'fridge-replay-'));
  try {
    const source = join(directory, 'source.png');
    const bytes = Buffer.from('replay-test-fixture');
    await writeFile(source, bytes);
    const capture = await captureImage({ mode: 'replay', replayImage: source, device: '' }, join(directory, 'captures'));
    const { readFile } = await import('node:fs/promises');
    assert.deepEqual(await readFile(join(directory, capture.url)), bytes);
    await assert.rejects(captureImage({ mode: 'replay', replayImage: join(directory, 'missing.png'), device: '' }, join(directory, 'captures')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
