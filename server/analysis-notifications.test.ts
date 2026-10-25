import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from './store.ts';
import { createChat } from './chat.ts';
import { publishAnalysisNotifications } from './analysis-notifications.ts';

test('analysis updates persist, deduplicate delivery, and roll over after one hour', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'analysis-chat-'));
  const store = createStore(join(dir, 'store.sqlite'));
  let chat = createChat(join(dir, 'chat.sqlite'), async () => { throw new Error('unused'); });
  const db = new DatabaseSync(join(dir, 'chat.sqlite'));
  const threads = () => db.prepare('SELECT * FROM threads ORDER BY rowid').all();
  try {
    store.createRecording('one', '/unused'); store.setRecording('one', 'processing');
    store.applyRecording('one', [], [{ itemId: null, name: 'Milk', delta: 2, reason: 'Observed addition' }]);
    assert.equal(store.analysisNotifications().length, 1);
    // Simulate interruption between successful chat delivery and outbox acknowledgement.
    assert.throws(() => publishAnalysisNotifications(store, (id, text) => { chat.notify(id, text); throw new Error('interrupted'); }));
    chat.close(); chat = createChat(join(dir, 'chat.sqlite'), async () => { throw new Error('unused'); });
    publishAnalysisNotifications(store, chat.notify);
    assert.equal(store.analysisNotifications().length, 0);
    assert.equal(threads().length, 1);
    assert.equal(JSON.parse(String(threads()[0].messages)).length, 1);
    assert.match(String(threads()[0].history), /Added 2 × Milk/);
    chat.notify('no-change', 'No changes.');
    assert.equal(threads().length, 1);
    db.prepare('UPDATE threads SET updatedAt = ?').run(new Date(Date.now() - 3_600_001).toISOString());
    chat.notify('later', 'Another analysis.');
    assert.equal(threads().length, 2);
    assert.match(String(threads()[1].messages), /Another analysis/);
    store.createRecording('failed', '/unused'); store.setRecording('failed', 'processing'); store.setRecording('failed', 'failed');
    publishAnalysisNotifications(store, chat.notify);
    assert.match(String(threads()[1].messages), /couldn’t finish/);
    assert.match(String(threads()[1].messages), /No inventory changes were saved/);
  } finally { db.close(); chat.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('notifications during voice are queued and survive transcript updates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'analysis-voice-'));
  const path = join(dir, 'chat.sqlite');
  const chat = createChat(path, async () => { throw new Error('unused'); });
  const db = new DatabaseSync(path);
  try {
    chat.notify('first', 'Initial analysis');
    const id = String(db.prepare('SELECT id FROM threads').get()!.id);
    const voice = chat.beginVoice(id);
    chat.notify('during', 'Removed 1 × Milk');
    voice.put('one', 'user', 'Hello'); voice.put('two', 'assistant', 'Hi'); voice.finish();
    const row = db.prepare('SELECT * FROM threads WHERE id = ?').get(id)!;
    const messages = JSON.parse(String(row.messages));
    assert.equal(messages.length, 4);
    assert.equal(messages.at(-1).text, 'Removed 1 × Milk');
    assert.match(String(row.history), /Removed 1 × Milk/);
  } finally { db.close(); chat.close(); await rm(dir, { recursive: true, force: true }); }
});

test('door conversation uses the one-hour rule and keeps late results with the original call', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'speaking-thread-'));
  const path = join(dir, 'chat.sqlite');
  const chat = createChat(path, async () => { throw new Error('unused'); });
  const db = new DatabaseSync(path);
  try {
    chat.notify('recent', 'Recent conversation');
    const first = chat.prepareDoorConversation('first-door');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM threads').get()!.count, 1);
    db.prepare('UPDATE threads SET updatedAt = ?').run(new Date(Date.now() - 3_600_001).toISOString());
    const second = chat.prepareDoorConversation('second-door');
    assert.notEqual(first.id, second.id);
    chat.notify('late-first', 'First door finished', 'first-door');
    assert.equal(chat.recordingNotifications('first-door')[0].threadId, first.id);
    assert.equal(chat.prepareDoorConversation('second-door').id, second.id);
    assert.throws(() => chat.linkDoor('first-door', second.id), /already belongs/);
  } finally { db.close(); chat.close(); await rm(dir, { recursive: true, force: true }); }
});
