import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export function createStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT NOT NULL, quantity INTEGER NOT NULL, createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS captures (id TEXT PRIMARY KEY, url TEXT NOT NULL, createdAt TEXT NOT NULL);`);
  return {
    listItems: () => db.prepare('SELECT * FROM items ORDER BY createdAt DESC').all(),
    addItem(name: string, quantity: number) {
      const item = { id: randomUUID(), name, quantity, createdAt: new Date().toISOString() };
      db.prepare('INSERT INTO items VALUES (?, ?, ?, ?)').run(item.id, item.name, item.quantity, item.createdAt);
      return item;
    },
    removeItem: (id: string) => db.prepare('DELETE FROM items WHERE id = ?').run(id).changes > 0,
    latestCapture: () => db.prepare('SELECT * FROM captures ORDER BY createdAt DESC, rowid DESC LIMIT 1').get() ?? null,
    addCapture(id: string, url: string) {
      const capture = { id, url, createdAt: new Date().toISOString() };
      db.prepare('INSERT INTO captures VALUES (?, ?, ?)').run(id, url, capture.createdAt);
      return capture;
    },
    close: () => db.close(),
  };
}
