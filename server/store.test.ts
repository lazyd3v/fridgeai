import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from './store.ts';

test('notes migration preserves old inventory and supports new and legacy additions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fridge-migration-'));
  const path = join(dir, 'fridge.sqlite');
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL, quantity INTEGER NOT NULL, createdAt TEXT NOT NULL); INSERT INTO items VALUES ('old', 'Eggs', 6, '2026-01-01');");
  old.close();
  try {
    const store = createStore(path);
    assert.deepEqual({ ...store.listItems()[0] }, { id: 'old', name: 'Eggs', quantity: 6, createdAt: '2026-01-01', notes: null });
    store.addItem('Milk', 1, 'Blue cap.');
    store.addItem('Apples', 2);
    store.close();
    const reopened = createStore(path);
    assert.equal(reopened.listItems().find(item => item.name === 'Milk')?.notes, 'Blue cap.');
    assert.equal(reopened.listItems().find(item => item.name === 'Apples')?.notes, null);
    reopened.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
