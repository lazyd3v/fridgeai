import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type Item = { id: string; name: string; quantity: number; createdAt: string; notes?: string | null; icon?: string | null };
export type InventoryChange = { itemId: string | null; name: string; delta: number; reason: string };
export type Recording = { id: string; path: string; status: string; createdAt: string; error: string | null; observations: string | null };
export function createStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT NOT NULL, quantity INTEGER NOT NULL, createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS captures (id TEXT PRIMARY KEY, url TEXT NOT NULL, createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inventory_log (id TEXT PRIMARY KEY, itemId TEXT NOT NULL, action TEXT NOT NULL, beforeJson TEXT, afterJson TEXT, source TEXT NOT NULL, recordingId TEXT, reason TEXT NOT NULL, createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS recordings (id TEXT PRIMARY KEY, path TEXT NOT NULL, status TEXT NOT NULL, createdAt TEXT NOT NULL, error TEXT, observations TEXT);`);
  if (!(db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).some(column => column.name === 'notes')) db.exec('ALTER TABLE items ADD COLUMN notes TEXT');
  if (!(db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).some(column => column.name === 'icon')) db.exec('ALTER TABLE items ADD COLUMN icon TEXT');
  function transaction<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const listItems = () => db.prepare('SELECT * FROM items ORDER BY createdAt DESC, id').all() as Item[];
  function log(before: Item | null, after: Item | null, source: string, recordingId: string | null, reason: string) {
    db.prepare('INSERT INTO inventory_log VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), (after ?? before)!.id,
      !before ? 'added' : !after ? 'removed' : 'updated', before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
      source, recordingId, reason, new Date().toISOString());
  }
  function insert(name: string, quantity: number, notes: string | null = null, icon: string | null = null) {
    if (!name.trim() || name.length > 100 || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) throw new Error('Invalid inventory item.');
    const item = { id: randomUUID(), name: name.trim(), quantity, createdAt: new Date().toISOString(), notes, icon };
    db.prepare('INSERT INTO items (id, name, quantity, createdAt, notes, icon) VALUES (?, ?, ?, ?, ?, ?)').run(item.id, item.name, item.quantity, item.createdAt, item.notes, item.icon);
    return item;
  }
  return {
    listItems,
    listLog: (limit = 100) => db.prepare('SELECT * FROM inventory_log ORDER BY rowid DESC LIMIT ?').all(limit),
    addItem: (name: string, quantity: number, notes: string | null = null, icon: string | null = null, source = 'manual') => transaction(() => {
      const item = insert(name, quantity, notes, icon); log(null, item, source, null, 'Item added'); return item;
    }),
    updateItem: (id: string, name: string, quantity: number, notes: string | null, source = 'agent') => transaction(() => {
      if (!name.trim() || name.length > 100 || !Number.isInteger(quantity) || quantity < 1 || quantity > 999 || (notes !== null && notes.length > 2000)) throw new Error('Invalid inventory item.');
      const before = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Item | undefined;
      if (!before) throw new Error('Item no longer exists. Read inventory again.');
      const after = { ...before, name: name.trim(), quantity, notes, icon: name.trim() === before.name ? before.icon : null };
      db.prepare('UPDATE items SET name = ?, quantity = ?, notes = ?, icon = ? WHERE id = ?').run(after.name, quantity, notes, after.icon ?? null, id);
      log(before, after, source, null, 'Item updated'); return after;
    }),
    removeItem: (id: string, source = 'manual') => transaction(() => {
      const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Item | undefined;
      if (!item) return false;
      db.prepare('DELETE FROM items WHERE id = ?').run(id); log(item, null, source, null, 'Item removed'); return true;
    }),
    createRecording(id: string, path: string) {
      db.prepare('INSERT INTO recordings VALUES (?, ?, ?, ?, NULL, NULL)').run(id, path, 'recording', new Date().toISOString());
    },
    recording: (id: string) => db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as Recording | undefined,
    listRecordings: () => db.prepare('SELECT * FROM recordings ORDER BY rowid DESC LIMIT 100').all() as Recording[],
    nextRecording: () => db.prepare("SELECT * FROM recordings WHERE status NOT IN ('completed', 'dismissed') ORDER BY rowid LIMIT 1").get() as Recording | undefined,
    pendingRecordings: () => db.prepare("SELECT * FROM recordings WHERE status = 'queued' ORDER BY rowid").all() as Recording[],
    setRecording(id: string, status: string, error: string | null = null, observations?: unknown) {
      db.prepare('UPDATE recordings SET status = ?, error = ?, observations = COALESCE(?, observations) WHERE id = ?').run(status, error, observations === undefined ? null : JSON.stringify(observations), id);
    },
    recoverRecordings() {
      db.prepare("UPDATE recordings SET status = 'incomplete', error = 'Recording interrupted by service restart.' WHERE status = 'recording'").run();
      db.prepare("UPDATE recordings SET status = 'queued' WHERE status = 'processing'").run();
    },
    applyRecording(id: string, expected: Item[], changes: InventoryChange[]) {
      return transaction(() => {
        const recording = db.prepare('SELECT status FROM recordings WHERE id = ?').get(id);
        if (recording?.status === 'completed') return false;
        if (recording?.status !== 'processing') throw new Error('Recording is not processing.');
        if (JSON.stringify(listItems()) !== JSON.stringify(expected)) throw new Error('Inventory changed during reconciliation; retry the recording.');
        const touched = new Set<string>();
        for (const change of changes) {
          if (!Number.isInteger(change.delta) || !change.delta || Math.abs(change.delta) > 999) throw new Error('Invalid quantity change.');
          const key = change.itemId ?? change.name.trim().toLowerCase();
          if (touched.has(key)) throw new Error('Duplicate inventory change.');
          touched.add(key);
          if (!change.itemId) {
            if (change.delta < 1 || expected.some(item => item.name.toLowerCase() === change.name.trim().toLowerCase())) throw new Error('Invalid new item.');
            const after = insert(change.name, change.delta); log(null, after, 'door-video', id, change.reason);
          } else {
            const before = expected.find(item => item.id === change.itemId);
            if (!before) throw new Error('Unknown inventory item.');
            const quantity = before.quantity + change.delta;
            if (quantity < 0 || quantity > 999) throw new Error('Quantity would be out of bounds.');
            const after = quantity ? { ...before, quantity } : null;
            if (after) db.prepare('UPDATE items SET quantity = ? WHERE id = ?').run(quantity, before.id);
            else db.prepare('DELETE FROM items WHERE id = ?').run(before.id);
            log(before, after, 'door-video', id, change.reason);
          }
        }
        db.prepare("UPDATE recordings SET status = 'completed', error = NULL WHERE id = ?").run(id);
        return true;
      });
    },
    latestCapture: () => db.prepare('SELECT * FROM captures ORDER BY createdAt DESC, rowid DESC LIMIT 1').get() ?? null,
    addCapture(id: string, url: string) {
      const capture = { id, url, createdAt: new Date().toISOString() };
      db.prepare('INSERT INTO captures VALUES (?, ?, ?)').run(id, url, capture.createdAt); return capture;
    },
    close: () => db.close(),
  };
}
export type Store = ReturnType<typeof createStore>;
