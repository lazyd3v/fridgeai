import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { RunAgentInputSchema } from '@ag-ui/core/schemas';
import { EventEncoder } from '@ag-ui/encoder';
import { createAgUiBridge } from './agui.ts';
import type { AgentInputItem, RunStreamEvent } from '@openai/agents';

export type AnalysisNotification = { id: string; threadId: string; text: string; recordingId: string | null; createdAt: string };
type Message = { id?: string; role: 'user' | 'assistant'; text: string; error?: boolean };
type Thread = { id: string; title: string; messages: Message[]; history: AgentInputItem[]; busy: boolean };
type Run = (prompt: string, history: AgentInputItem[], onEvent?: (event: RunStreamEvent) => void) => Promise<{ output: string; history: AgentInputItem[]; toolCalls: string[] }>;
export function createChat(path: string, run: Run) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, messages TEXT NOT NULL, history TEXT NOT NULL, busy INTEGER NOT NULL DEFAULT 0, updatedAt TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, threadId TEXT NOT NULL, text TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS chat_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.exec(`CREATE TABLE IF NOT EXISTS spoken_notifications (sequence INTEGER PRIMARY KEY AUTOINCREMENT, notificationId TEXT NOT NULL UNIQUE);
    CREATE TRIGGER IF NOT EXISTS spoken_notification_ready AFTER UPDATE OF delivered ON notifications
    WHEN NEW.delivered = 1 AND OLD.delivered = 0
    BEGIN INSERT OR IGNORE INTO spoken_notifications (notificationId) VALUES (NEW.id); END;`);
  if (!(db.prepare('PRAGMA table_info(notifications)').all() as { name: string }[]).some(column => column.name === 'recordingId')) db.exec('ALTER TABLE notifications ADD COLUMN recordingId TEXT');
  if (!(db.prepare('PRAGMA table_info(notifications)').all() as { name: string }[]).some(column => column.name === 'createdAt')) db.exec("ALTER TABLE notifications ADD COLUMN createdAt TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE TABLE IF NOT EXISTS door_threads (recordingId TEXT PRIMARY KEY, threadId TEXT NOT NULL)');
  const notificationListeners = new Set<(notification: AnalysisNotification) => void>();
  const recordingNotifications = (recordingId: string) => db.prepare('SELECT id, threadId, text, recordingId, createdAt FROM notifications WHERE recordingId = ? ORDER BY rowid').all(recordingId) as AnalysisNotification[];
  const linkedThread = (recordingId: string) => { const row = db.prepare('SELECT threadId FROM door_threads WHERE recordingId = ?').get(recordingId); return row ? String(row.threadId) : undefined; };
  function linkDoor(recordingId: string, threadId: string) {
    const previous = linkedThread(recordingId);
    if (previous && previous !== threadId) throw Object.assign(new Error('This door session already belongs to another conversation.'), { status: 409 });
    db.prepare('INSERT OR IGNORE INTO door_threads VALUES (?, ?)').run(recordingId, threadId);
  }
  function deliver(thread: Thread) {
    if (thread.busy) return;
    for (const row of db.prepare('SELECT id, text FROM notifications WHERE threadId = ? AND delivered = 0 ORDER BY rowid').all(thread.id)) {
      const text = String(row.text);
      thread.messages.push({ id: `analysis-${row.id}`, role: 'assistant', text });
      thread.history.push({ role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text }] });
      db.prepare('UPDATE notifications SET delivered = 1 WHERE id = ?').run(row.id);
    }
  }
  function get(id: string): Thread | undefined {
    const row = db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
    return row ? { id: String(row.id), title: String(row.title), messages: (JSON.parse(String(row.messages)) as Message[]).map((message, index) => ({ ...message, id: message.id ?? `${id}-${index}` })), history: JSON.parse(String(row.history)), busy: !!row.busy } : undefined;
  }
  function save(thread: Thread) {
    db.exec('BEGIN IMMEDIATE');
    try {
      deliver(thread);
      const previous = db.prepare('SELECT messages, updatedAt FROM threads WHERE id = ?').get(thread.id);
      const messages = JSON.stringify(thread.messages);
      const updatedAt = previous?.messages === messages ? String(previous.updatedAt) : new Date().toISOString();
      db.prepare('INSERT OR REPLACE INTO threads VALUES (?, ?, ?, ?, ?, ?)').run(thread.id, thread.title, messages, JSON.stringify(thread.history), Number(thread.busy), updatedAt);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function fail(thread: Thread, message: string) {
    thread.messages.push({ id: randomUUID(), role: 'assistant', text: message, error: true });
    // A failed turn may already have performed writes. Preserve a warning in model context.
    thread.history.push({ role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: message }] });
    thread.busy = false; save(thread);
  }
  for (const row of db.prepare('SELECT id FROM threads WHERE busy = 1').all()) {
    fail(get(String(row.id))!, 'The service restarted during this reply. Some inventory changes may have completed. Check inventory before trying again.');
  }
  const publicThread = ({ history: _history, ...thread }: Thread) => ({ ...thread, messages: thread.messages.filter(message => message.text.trim()) });
  const wireMessages = (thread: Thread) => thread.messages.map(message => ({ id: message.id!, role: message.role, content: message.text }));
  const router = Router();
  router.get('/speaking-fridge/results', (req, res) => {
    const latest = Number(db.prepare('SELECT COALESCE(MAX(rowid), 0) AS cursor FROM notifications').get()!.cursor);
    if (req.query.after === undefined) { res.json({ cursor: latest, results: [] }); return; }
    const after = Number(req.query.after);
    if (!Number.isSafeInteger(after) || after < 0) { res.sendStatus(400); return; }
    // Include busy conversations too: voice calls must not wait for chat delivery.
    const results = db.prepare('SELECT rowid AS sequence, id, recordingId, threadId, createdAt FROM notifications WHERE rowid > ? AND recordingId IS NOT NULL ORDER BY rowid LIMIT 50').all(after);
    res.json({ cursor: results.length ? results.at(-1)!.sequence : latest, results });
  });
  router.get('/summary-notifications', (req, res) => {
    const latest = Number(db.prepare('SELECT COALESCE(MAX(sequence), 0) AS cursor FROM spoken_notifications').get()!.cursor);
    if (req.query.after === undefined) { res.json({ cursor: latest, notifications: [] }); return; }
    const after = Number(req.query.after);
    if (!Number.isSafeInteger(after) || after < 0) { res.sendStatus(400); return; }
    const notifications = db.prepare('SELECT s.sequence, n.id, n.threadId FROM spoken_notifications s JOIN notifications n ON n.id = s.notificationId WHERE s.sequence > ? ORDER BY s.sequence LIMIT 50').all(after);
    res.json({ cursor: notifications.length ? notifications.at(-1)!.sequence : latest, notifications });
  });
  router.get('/threads', (_req, res) => res.json(db.prepare('SELECT id, title, updatedAt FROM threads ORDER BY updatedAt DESC').all()));
  router.post('/threads', (_req, res) => {
    const thread: Thread = { id: randomUUID(), title: 'New conversation', messages: [], history: [], busy: false };
    save(thread); res.status(201).json(publicThread(thread));
  });
  router.post('/threads/:id/activate', (req, res) => {
    if (!get(req.params.id)) { res.sendStatus(404); return; }
    db.prepare("INSERT OR REPLACE INTO chat_settings VALUES ('active', ?)").run(req.params.id);
    res.sendStatus(204);
  });
  router.get('/threads/:id', (req, res) => {
    const thread = get(req.params.id);
    if (!thread) { res.status(404).json({ error: 'Conversation not found.' }); return; }
    res.json(publicThread(thread));
  });
  router.post('/threads/:id/run', async (req, res) => {
    const parsed = RunAgentInputSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid AG-UI run request.' }); return; }
    const input = parsed.data;
    const thread = get(req.params.id);
    if (!thread || input.threadId !== thread.id) { res.status(404).json({ error: 'Conversation not found.' }); return; }
    const message = input.messages.at(-1);
    if (message?.role !== 'user' || typeof message.content !== 'string' || !message.content.trim() || message.content.length > 4000) { res.status(400).json({ error: 'Write a message of 1–4000 characters.' }); return; }
    if (thread.busy) { res.status(409).json({ error: 'MISO is still replying. Reload to check its progress.' }); return; }
    const encoder = new EventEncoder();
    const emit = (event: BaseEvent) => { if (!res.destroyed) res.write(encoder.encode(event)); };
    const start = () => {
      res.set({ 'Content-Type': encoder.getContentType(), 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.flushHeaders(); emit({ type: EventType.RUN_STARTED, threadId: thread.id, runId: input.runId } as BaseEvent);
    };
    // Replaying a previously accepted message never repeats inventory writes.
    if (thread.messages.some(saved => saved.id === message.id)) {
      start(); emit({ type: EventType.MESSAGES_SNAPSHOT, messages: wireMessages(thread) } as BaseEvent);
      emit({ type: EventType.RUN_FINISHED, threadId: thread.id, runId: input.runId } as BaseEvent); res.end(); return;
    }
    if (thread.messages.length >= 100) { res.status(409).json({ error: 'This conversation is full. Start a new chat.' }); return; }
    const history = [...thread.history];
    const prompt = message.content.trim();
    if (!thread.messages.length) thread.title = prompt.slice(0, 60);
    thread.messages.push({ id: message.id, role: 'user', text: prompt });
    thread.history.push({ role: 'user', content: prompt });
    thread.busy = true; save(thread); start();
    const keepAlive = setInterval(() => { if (!res.destroyed) res.write(': keep-alive\n\n'); }, 15_000);
    const bridge = createAgUiBridge(emit);
    try {
      // Ignore browser-supplied history, tools, and instructions; use persisted SDK context.
      const result = await run(prompt, history, bridge.event);
      const output = result.output || 'Done. Check your inventory for the latest changes.';
      thread.messages.push({ id: randomUUID(), role: 'assistant', text: output });
      thread.history = result.history; thread.busy = false; save(thread);
      bridge.finish(output);
      emit({ type: EventType.RUN_FINISHED, threadId: thread.id, runId: input.runId } as BaseEvent);
    } catch {
      const error = 'MISO could not finish this reply. Some inventory changes may have completed. Check your inventory before trying again.';
      fail(thread, error); bridge.finish('');
      emit({ type: EventType.MESSAGES_SNAPSHOT, messages: wireMessages(thread) } as BaseEvent);
      emit({ type: EventType.RUN_ERROR, message: error, code: 'AGENT_RUN_FAILED' } as BaseEvent);
    } finally { clearInterval(keepAlive); res.end(); }
  });
  router.post('/threads/:id/messages', async (req, res) => {
    const thread = get(req.params.id);
    if (!thread) { res.status(404).json({ error: 'Conversation not found.' }); return; }
    const prompt = req.body?.prompt;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) { res.status(400).json({ error: 'Write a message of 1–4000 characters.' }); return; }
    if (thread.busy) { res.status(409).json({ error: 'MISO is still replying to this conversation.' }); return; }
    if (thread.messages.length >= 100) { res.status(409).json({ error: 'This conversation is full. Start a new conversation to keep chatting.' }); return; }
    const history = [...thread.history];
    if (!thread.messages.length) thread.title = prompt.trim().slice(0, 60);
    thread.messages.push({ id: randomUUID(), role: 'user', text: prompt.trim() });
    thread.history.push({ role: 'user', content: prompt.trim() });
    thread.busy = true; save(thread);
    try {
      const result = await run(prompt.trim(), history);
      thread.messages.push({ id: randomUUID(), role: 'assistant', text: result.output || 'Done. Check your inventory for the latest changes.' });
      thread.history = result.history; thread.busy = false; save(thread);
      res.json(publicThread(thread));
    } catch {
      fail(thread, 'MISO could not finish this reply. Some inventory changes may have completed. Check your inventory before trying again.');
      res.status(502).json({ error: thread.messages.at(-1)!.text, thread: publicThread(thread) });
    }
  });
  function beginVoice(id: string) {
    const thread = get(id);
    if (!thread) throw Object.assign(new Error('Conversation not found.'), { status: 404 });
    if (thread.busy || thread.messages.length >= 100) throw Object.assign(new Error('This conversation is busy or full. Try a new chat.'), { status: 409 });
    thread.busy = true; save(thread);
    const originalHistory = [...thread.history];
    const originalCount = thread.messages.length;
    let ended = false;
    const receipts: AgentInputItem[] = [];
    return {
      messages: thread.messages.map(message => ({ ...message })),
      put(itemId: string, role: 'user' | 'assistant', text: string) {
        if (ended) return;
        const id = `voice-${itemId}`;
        const existing = thread.messages.find(message => message.id === id);
        if (existing) existing.text = text.slice(0, 8000);
        else {
          if (thread.messages.length >= 100) throw new Error('Conversation full.');
          thread.messages.push({ id, role, text: text.slice(0, 8000) });
        }
        if (thread.title === 'New conversation' && role === 'user' && text) thread.title = text.slice(0, 60);
        // Persist each transcript so a service restart can recover the conversation.
        thread.history = [...originalHistory, ...receipts, ...thread.messages.slice(originalCount).filter(m => m.text).map(m => m.role === 'user'
          ? { role: 'user' as const, content: m.text }
          : { role: 'assistant' as const, type: 'message' as const, status: 'completed' as const, content: [{ type: 'output_text' as const, text: m.text }] })];
        save(thread);
      },
      recordTool(name: string, output: string) {
        const receipt: AgentInputItem = { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: `Voice tool result (${name}): ${output.slice(0, 16000)}` }] };
        receipts.push(receipt); thread.history.push(receipt); save(thread);
      },
      finish() { if (!ended) { ended = true; thread.messages = thread.messages.filter(message => message.text.trim()); thread.busy = false; save(thread); } },
    };
  }
  function selectUpdateThread(recordingId?: string) {
    const linked = recordingId && linkedThread(recordingId);
    if (linked) { const thread = get(linked); if (thread) return thread; }
    const active = db.prepare("SELECT value FROM chat_settings WHERE key = 'active'").get();
    const latest = db.prepare('SELECT id FROM threads ORDER BY updatedAt DESC LIMIT 1').get();
    let thread = get(String(active?.value ?? latest?.id ?? ''));
    const lastMessage = thread ? db.prepare('SELECT updatedAt FROM threads WHERE id = ?').get(thread.id) : undefined;
    if (!thread || thread.messages.length >= 96 || (lastMessage && Date.now() - Date.parse(String(lastMessage.updatedAt)) > 60 * 60_000)) {
      thread = { id: randomUUID(), title: 'Fridge updates', messages: [], history: [], busy: false };
      save(thread);
      db.prepare("INSERT OR REPLACE INTO chat_settings VALUES ('active', ?)").run(thread.id);
    }
    return thread;
  }
  function prepareDoorConversation(recordingId: string) {
    const thread = selectUpdateThread(recordingId);
    if (thread.busy) throw Object.assign(new Error('MISO is still replying. Try again shortly.'), { status: 409 });
    linkDoor(recordingId, thread.id);
    db.prepare("INSERT OR REPLACE INTO chat_settings VALUES ('active', ?)").run(thread.id);
    return publicThread(thread);
  }
  function notify(id: string, text: string, recordingId?: string) {
    if (db.prepare('SELECT 1 FROM notifications WHERE id = ?').get(id)) return;
    const thread = selectUpdateThread(recordingId);
    if (recordingId) linkDoor(recordingId, thread.id);
    const createdAt = new Date().toISOString();
    db.prepare('INSERT INTO notifications (id, threadId, text, recordingId, createdAt) VALUES (?, ?, ?, ?, ?)').run(id, thread.id, text, recordingId ?? null, createdAt);
    save(thread);
    for (const listener of notificationListeners) listener({ id, threadId: thread.id, text, recordingId: recordingId ?? null, createdAt });
  }
  // Recover notifications queued during an interrupted voice or text reply.
  for (const row of db.prepare('SELECT DISTINCT threadId FROM notifications WHERE delivered = 0').all()) {
    const thread = get(String(row.threadId));
    if (thread && !thread.busy) save(thread);
  }
  return { router, beginVoice, notify, prepareDoorConversation, linkDoor, linkedThread, recordingNotifications,
    subscribeNotifications: (listener: (notification: AnalysisNotification) => void) => { notificationListeners.add(listener); return () => { notificationListeners.delete(listener); }; },
    notificationText: (id: string) => { const row = db.prepare('SELECT text FROM notifications WHERE id = ? AND delivered = 1').get(id); return row ? String(row.text) : undefined; }, close: () => db.close() };
}
