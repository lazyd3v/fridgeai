import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChat } from './chat.ts';
import { createDictation } from './dictation.ts';
import type { AgentInputItem } from '@openai/agents';

test('threads isolate history, reject concurrent sends, persist and record failed turns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'miso-chat-'));
  const path = join(dir, 'chat.sqlite');
  const inputs: AgentInputItem[][] = [];
  let release: () => void = () => {};
  const chat = createChat(path, async (prompt, history) => {
    inputs.push(history);
    if (prompt === 'wait') await new Promise<void>(resolve => { release = resolve; });
    if (prompt === 'fail') throw new Error('tool already wrote');
    return { output: 'hello', toolCalls: [], history: [...history, { role: 'user', content: prompt }, { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'hello' }] }] };
  });
  const app = express(); app.use(express.json()); app.use(chat.router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, prompt?: string) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) });
  let firstId = '';
  try {
    const first = await (await post('/threads')).json(); firstId = first.id;
    const second = await (await post('/threads')).json();
    assert.equal((await post(`/threads/${first.id}/messages`, '')).status, 400);
    await post(`/threads/${first.id}/messages`, 'hello');
    await post(`/threads/${first.id}/messages`, 'remember');
    await post(`/threads/${second.id}/messages`, 'separate');
    assert.equal(inputs[0].length, 0); assert.equal(inputs[1].length, 2); assert.equal(inputs[2].length, 0);
    const pending = post(`/threads/${first.id}/messages`, 'wait');
    while (inputs.length < 4) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await post(`/threads/${first.id}/messages`, 'duplicate')).status, 409);
    chat.notify('door-during-reply', 'Added 2 × apples after analyzing the door recording.');
    release(); await pending;
    const withUpdate = await (await fetch(`${base}/threads/${first.id}`)).json();
    assert.match(withUpdate.messages.at(-1).text, /Added 2 × apples/);
    assert.equal((await post(`/threads/${first.id}/messages`, 'fail')).status, 502);
    const result = await (await fetch(`${base}/threads/${first.id}`)).json();
    assert.equal(result.busy, false); assert.equal(result.messages.at(-1).error, true);
    assert.equal(result.history, undefined);
    await post(`/threads/${first.id}/messages`, 'check again');
    assert.match(JSON.stringify(inputs.at(-1)), /Some inventory changes may have completed/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); chat.close(); }
  const reopened = createChat(path, async () => { throw new Error('unused'); });
  const app2 = express(); app2.use(reopened.router);
  const server2 = app2.listen(0, '127.0.0.1'); await once(server2, 'listening');
  try {
    const result = await (await fetch(`http://127.0.0.1:${(server2.address() as { port: number }).port}/threads/${firstId}`)).json();
    assert.equal(result.messages.length, 11);
  } finally { await new Promise<void>(resolve => server2.close(() => resolve())); reopened.close(); await rm(dir, { recursive: true, force: true }); }
});

test('dictation rejects invalid uploads and returns transcription without running the agent', async () => {
  const app = express();
  app.use(createDictation(async (bytes, type, extension) => { assert.equal(bytes.toString(), 'audio'); assert.equal(type, 'audio/webm'); assert.equal(extension, 'webm'); return 'Add two apples'; }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/dictation`;
  try {
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'audio' })).status, 400);
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: 'audio' });
    assert.deepEqual(await response.json(), { text: 'Add two apples' });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
