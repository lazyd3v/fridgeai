import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { availableIcons, createIconSelector } from '../server/icons.ts';

const path = process.argv[2];
if (!path || !process.env.OPENAI_API_KEY) throw new Error('Provide database path and configure OPENAI_API_KEY on the Pi.');
const icons = availableIcons();
if (!icons.length) throw new Error('No built icon artwork found.');
const db = new DatabaseSync(path);
db.exec('PRAGMA busy_timeout = 5000');
type Row = { id: string; name: string; notes: string | null; icon?: string | null };
try {
  const rows = db.prepare('SELECT * FROM items').all() as Row[];
  const updates: { row: Row; icon: string }[] = [];
  for (const row of rows) {
    let apiFailed = false;
    const select = createIconSelector(icons, { fetch: async (url, init) => {
      try {
        const response = await fetch(url, init);
        if (!response.ok) { apiFailed = true; console.error(`Decisions HTTP ${response.status}`); }
        else {
          const body = await response.clone().json();
          if (!Array.isArray(body?.answers) || !body.answers.length || body.answers.some((answer: { type?: string; choice?: string }) => answer?.type !== 'choice' || ![...icons, 'none'].includes(answer.choice ?? ''))) apiFailed = true;
        }
        return response;
      } catch { apiFailed = true; throw new Error('Decisions request failed'); }
    } });
    const icon = await select(row.name, row.notes);
    if (apiFailed) throw new Error('Classification failed; no inventory icons have been changed.');
    updates.push({ row, icon });
    console.log(`${row.name}: ${icon}`);
  }
  const backup = `${path}.icons-before-${Date.now()}.json`;
  writeFileSync(backup, JSON.stringify(rows.map(({ id, name, icon }) => ({ id, name, icon: icon ?? null })), null, 2), { mode: 0o600, flag: 'wx' });
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!(db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).some(c => c.name === 'icon')) db.exec('ALTER TABLE items ADD COLUMN icon TEXT');
    const update = db.prepare('UPDATE items SET icon = ? WHERE id = ? AND name = ? AND notes IS ?');
    for (const { row, icon } of updates) {
      if (update.run(icon, row.id, row.name, row.notes).changes !== 1) throw new Error('Inventory changed during classification; retry.');
    }
    db.exec('COMMIT');
    console.log(`Updated ${updates.length} icons. Previous icons saved on Pi: ${backup}`);
  } catch (error) { db.exec('ROLLBACK'); throw error; }
} finally { db.close(); }
