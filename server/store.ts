import { initialFreshness, validDate, RETURN_MS, type Freshness, type ProductEvent, type resolveProduct } from './freshness.ts';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type Item = { id: string; name: string; quantity: number; createdAt: string; notes?: string | null; icon?: string | null; freshness?: Freshness };
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
  if (!(db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).some(column => column.name === 'freshness')) {
    db.exec('BEGIN IMMEDIATE');
    try { db.exec('ALTER TABLE items ADD COLUMN freshness TEXT'); db.prepare('UPDATE items SET freshness = ?').run(JSON.stringify(initialFreshness(true))); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  db.exec('CREATE TABLE IF NOT EXISTS recording_events (recordingId TEXT NOT NULL, eventIndex INTEGER NOT NULL, result TEXT NOT NULL, PRIMARY KEY(recordingId, eventIndex))');
  const decode = (row: unknown): Item => { const item = row as Item & { freshness: string }; return { ...item, freshness: item.freshness ? JSON.parse(item.freshness) : initialFreshness(true) }; };
  const listPackages = () => db.prepare('SELECT * FROM items ORDER BY createdAt DESC, id').all().map(decode);
  const saveFreshness = (id: string, value: Freshness) => db.prepare('UPDATE items SET freshness = ? WHERE id = ?').run(JSON.stringify(value), id);
  function transaction<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const listItems = () => listPackages().filter(item => item.freshness!.state === 'in_fridge');
  function log(before: Item | null, after: Item | null, source: string, recordingId: string | null, reason: string) {
    db.prepare('INSERT INTO inventory_log VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), (after ?? before)!.id,
      !before ? 'added' : !after || (before.freshness?.state === 'in_fridge' && after.freshness?.state !== 'in_fridge') ? 'removed' : 'updated', before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
      source, recordingId, reason, new Date().toISOString());
  }
  function insert(name: string, quantity: number, notes: string | null = null, icon: string | null = null) {
    if (!name.trim() || name.length > 100 || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) throw new Error('Invalid inventory item.');
    const item = { id: randomUUID(), name: name.trim(), quantity, createdAt: new Date().toISOString(), notes, icon };
    db.prepare('INSERT INTO items (id, name, quantity, createdAt, notes, icon) VALUES (?, ?, ?, ?, ?, ?)').run(item.id, item.name, item.quantity, item.createdAt, item.notes, item.icon);
    const freshness = initialFreshness(); saveFreshness(item.id, freshness);
    return { ...item, freshness };
  }
  return {
    listItems,
    listPackages,
    expireTakenOut: (now = new Date().toISOString()) => transaction(() => {
      // Pending footage may contain a return before the deadline: reconcile it first.
      for (const item of listPackages()) {
        const f = item.freshness!;
        if (f.state !== 'taken_out' || !f.deadline || f.deadline > now) continue;
        const pending = db.prepare("SELECT 1 FROM recordings WHERE status NOT IN ('completed','dismissed') AND createdAt <= ? LIMIT 1").get(f.deadline);
        if (pending) continue;
        const after = { ...item, freshness: { ...f, state: 'finished' as const, finishReason: 'timeout' as const } };
        saveFreshness(item.id, after.freshness); log(item, after, 'timeout', null, 'No return within three hours');
      }
    }),
    correctFreshness: (id: string, patch: { expirationDate?: string | null; openedAt?: string | null; state?: Freshness['state']; returnId?: string; newPackage?: boolean }, source = 'correction') => transaction(() => {
      const before = listPackages().find(item => item.id === id);
      if (!before) throw new Error('Unknown package.');
      if (patch.expirationDate && !validDate(patch.expirationDate)) throw new Error('Invalid date.');
      if (patch.openedAt && !validDate(patch.openedAt)) throw new Error('Invalid opening date.');
      if (patch.returnId) {
        const target = listPackages().find(item => item.id === patch.returnId);
        if (!target || !before.freshness!.candidates.includes(target.id) || target.freshness!.state === 'in_fridge') throw new Error('Invalid return candidate.');
        saveFreshness(before.id, { ...before.freshness!, state: 'finished', finishReason: 'explicit', candidates: [] });
        const after = { ...target, freshness: { ...target.freshness!, state: 'in_fridge' as const, deadline: null, finishReason: null } };
        saveFreshness(target.id, after.freshness); log(before, after, 'correction', null, 'Confirmed returning package'); return after;
      }
      if (patch.newPackage) {
        const old = { ...before.freshness! };
        old.state = old.removedAt && !old.candidates.length ? 'taken_out' : 'finished';
        old.finishReason = old.state === 'finished' ? 'explicit' : null;
        old.deadline = old.state === 'taken_out' ? new Date(Date.parse(old.removedAt!) + RETURN_MS).toISOString() : null;
        saveFreshness(id, old); log(before, { ...before, freshness: old }, 'correction', null, 'Previous package retained after new-package correction');
        const added = insert(before.name, before.quantity, before.notes, before.icon);
        log(null, added, 'correction', null, 'Confirmed new package'); return added;
      }
      const f = { ...before.freshness! };
      if (patch.expirationDate !== undefined) { f.expirationDate = patch.expirationDate; f.dateSource = patch.expirationDate ? 'supplied' : 'unknown'; f.originalText = patch.expirationDate; f.conflict = null; f.needsEstimate = false; }
      if (patch.openedAt !== undefined) { f.openedAt = patch.openedAt; f.possiblyOpened = false; f.needsEstimate = true; }
      if (patch.state) { f.state = patch.state; f.deadline = null; f.finishReason = patch.state === 'finished' ? 'explicit' : null; }
      saveFreshness(id, f); const after = { ...before, freshness: f }; log(before, after, source, null, 'Freshness corrected'); return after;
    }),
    saveEstimate: (expected: Item, freshness: Freshness) => transaction(() => {
      const current = listPackages().find(item => item.id === expected.id);
      if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
      saveFreshness(expected.id, freshness); log(expected, { ...expected, freshness }, 'estimate', null, 'Freshness estimate updated'); return true;
    }),
    eventApplied: (id: string, index: number) => !!db.prepare('SELECT 1 FROM recording_events WHERE recordingId = ? AND eventIndex = ?').get(id, index),
    applyProductEvent: (id: string, index: number, expected: Item[], event: ProductEvent, resolved: Awaited<ReturnType<typeof resolveProduct>>, at: string) => transaction(() => {
      if (db.prepare('SELECT 1 FROM recording_events WHERE recordingId = ? AND eventIndex = ?').get(id, index)) return;
      if (db.prepare('SELECT status FROM recordings WHERE id = ?').get(id)?.status !== 'processing') throw new Error('Recording is not processing.');
      if (JSON.stringify(listPackages()) !== JSON.stringify(expected)) throw new Error('Inventory changed; retry recording.');
      const { result, freshness } = resolved;
      if (event.action === 'removed' && result.resolution !== 'existing') throw new Error('Removal identity needs review.');
      let before = expected.find(item => item.id === result.productId);
      if (result.resolution === 'existing' && !before) throw new Error('Unknown package.');
      if (event.action === 'removed' && before?.freshness!.state !== 'in_fridge') throw new Error('Package is not in the fridge.');
      if (event.action === 'added' && before?.freshness!.state === 'in_fridge') throw new Error('Cannot return an already present package.');
      // A legacy quantity row represents a batch. Split off one physical unit on removal.
      if (before && before.quantity > 1 && event.action === 'removed') {
        db.prepare('UPDATE items SET quantity = quantity - 1 WHERE id = ?').run(before.id);
        log(before, { ...before, quantity: before.quantity - 1 }, 'door-video', id, 'One unit taken from batch');
        const split = insert(before.name, 1, before.notes, before.icon);
        db.prepare('UPDATE items SET createdAt = ? WHERE id = ?').run(before.createdAt, split.id);
        before = { ...split, createdAt: before.createdAt, freshness: before.freshness };
      }
      const item = before ?? insert(result.product, 1);
      if (!before) db.prepare('UPDATE items SET createdAt = ? WHERE id = ?').run(at, item.id);
      freshness.state = event.action === 'removed' ? 'taken_out' : 'in_fridge';
      freshness.finishReason = null;
      if (event.action === 'removed') { freshness.removedAt = at; freshness.deadline = new Date(Date.parse(at) + RETURN_MS).toISOString(); }
      else freshness.deadline = null;
      saveFreshness(item.id, freshness);
      const after = { ...item, createdAt: before?.createdAt ?? at, freshness };
      log(before ?? null, after, 'door-video', id, `${event.action}: ${result.resolution}${freshness.candidates.length ? ' (identity unresolved)' : ''}`);
      db.prepare('INSERT INTO recording_events VALUES (?, ?, ?)').run(id, index, JSON.stringify({ event, result, packageId: item.id }));
    }),
    listLog: (limit = 100) => db.prepare('SELECT * FROM inventory_log ORDER BY rowid DESC LIMIT ?').all(limit),
    addItem: (name: string, quantity: number, notes: string | null = null, icon: string | null = null, source = 'manual') => transaction(() => {
      const item = insert(name, quantity, notes, icon); log(null, item, source, null, 'Item added'); return item;
    }),
    updateItem: (id: string, name: string, quantity: number, notes: string | null, source = 'agent') => transaction(() => {
      if (!name.trim() || name.length > 100 || !Number.isInteger(quantity) || quantity < 1 || quantity > 999 || (notes !== null && notes.length > 2000)) throw new Error('Invalid inventory item.');
      const before = listPackages().find(item => item.id === id);
      if (!before || before.freshness!.state !== 'in_fridge') throw new Error('Item no longer exists. Read inventory again.');
      const after = { ...before, name: name.trim(), quantity, notes, icon: name.trim() === before.name ? before.icon : null };
      db.prepare('UPDATE items SET name = ?, quantity = ?, notes = ?, icon = ? WHERE id = ?').run(after.name, quantity, notes, after.icon ?? null, id);
      log(before, after, source, null, 'Item updated'); return after;
    }),
    removeItem: (id: string, source = 'manual') => transaction(() => {
      const item = listPackages().find(item => item.id === id);
      if (!item || item.freshness!.state === 'finished') return false;
      const after = { ...item, freshness: { ...item.freshness!, state: 'finished' as const, finishReason: 'explicit' as const, deadline: null } };
      saveFreshness(id, after.freshness); log(item, after, source, null, 'Explicitly finished'); return true;
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
