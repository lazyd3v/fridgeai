import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { RunAgentInputSchema } from '@ag-ui/core/schemas';
import { EventEncoder } from '@ag-ui/encoder';
import { createAgUiBridge } from './agui.ts';
import type { AgentInputItem, RunStreamEvent } from '@openai/agents';

type Message = { id?: string; role: 'user' | 'assistant'; text: string; error?: boolean };
type Thread = { id: string; title: string; messages: Message[]; history: AgentInputItem[]; busy: boolean };
type Run = (prompt: string, history: AgentInputItem[], onEvent?: (event: RunStreamEvent) => void) => Promise<{ output: string; history: AgentInputItem[]; toolCalls: string[] }>;
export function createChat(path: string, run: Run) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, messages TEXT NOT NULL, history TEXT NOT NULL, busy INTEGER NOT NULL DEFAULT 0, updatedAt TEXT NOT NULL)');
  function get(id: string): Thread | undefined {
    const row = db.prepare('SELECT * FROM threads WHERE id = ?').get(id);
    return row ? { id: String(row.id), title: String(row.title), messages: (JSON.parse(String(row.messages)) as Message[]).map((message, index) => ({ ...message, id: message.id ?? `${id}-${index}` })), history: JSON.parse(String(row.history)), busy: !!row.busy } : undefined;
  }
  function save(thread: Thread) {
    db.prepare('INSERT OR REPLACE INTO threads VALUES (?, ?, ?, ?, ?, ?)').run(thread.id, thread.title, JSON.stringify(thread.messages), JSON.stringify(thread.history), Number(thread.busy), new Date().toISOString());
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
  const publicThread = ({ history: _history, ...thread }: Thread) => thread;
  const wireMessages = (thread: Thread) => thread.messages.map(message => ({ id: message.id!, role: message.role, content: message.text }));
  const router = Router();
  router.get('/threads', (_req, res) => res.json(db.prepare('SELECT id, title, updatedAt FROM threads ORDER BY updatedAt DESC').all()));
  router.post('/threads', (_req, res) => {
    const thread: Thread = { id: randomUUID(), title: 'New conversation', messages: [], history: [], busy: false };
    save(thread); res.status(201).json(publicThread(thread));
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
  return { router, close: () => db.close() };
}
