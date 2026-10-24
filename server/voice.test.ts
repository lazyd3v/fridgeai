import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { createFridgeAgent } from './agent.ts';
import { createVoice, voiceAgent, VOICE_MODEL } from './voice.ts';
import { createChat } from './chat.ts';
import { createStore } from './store.ts';

const waitFor = async (check: () => boolean) => { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('Timed out'); };
test('voice uses the exact chat tools, validates inputs and mutates the same store', async () => {
  const store = createStore(':memory:');
  const fridge = { getInventory: store.listItems, getStatus: () => ({}), addItem: store.addItem, updateItem: store.updateItem, removeItem: store.removeItem, scanInitialInventory: () => ({}), getInitialScan: () => ({}) };
  const voice = voiceAgent(fridge);
  try {
    assert.equal(voice.session.model, 'gpt-realtime-2.1-mini');
    assert.deepEqual(voice.session.tools.map(t => t.name), createFridgeAgent(fridge, []).tools.map(t => t.name));
    await voice.invoke('add_inventory_item', JSON.stringify({ name: 'Eggs', quantity: -1 }));
    assert.equal(store.listItems().length, 0);
    await voice.invoke('add_inventory_item', JSON.stringify({ name: 'Eggs', quantity: 2 }));
    const item = store.listItems()[0]; assert.equal(item.quantity, 2);
    await voice.invoke('update_inventory_item', JSON.stringify({ id: item.id, name: 'Eggs', quantity: 3, notes: null }));
    assert.equal(store.listItems()[0].quantity, 3);
    assert.match(await voice.invoke('get_inventory', '{}'), /Eggs/);
    await voice.invoke('remove_inventory_item', JSON.stringify({ id: item.id }));
    assert.equal(store.listItems().length, 0);
    assert.match(await voice.invoke('invented', '{}'), /Unknown tool/);
  } finally { store.close(); }
});

test('WebRTC sideband executes provider tools once, persists voice, rejects cross-origin, and unlocks on end', async () => {
  const oldKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'isolated-test-key';
  const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(provider, 'listening');
  let socket: WebSocket | undefined;
  const sent: any[] = [];
  provider.on('connection', ws => { socket = ws; ws.on('message', raw => { const e = JSON.parse(raw.toString()); sent.push(e); if (e.type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated' })); }); });
  const store = createStore(':memory:');
  const histories: unknown[] = [];
  const chat = createChat(':memory:', async (prompt, history) => { histories.push(history); return { output: 'OK', history, toolCalls: [] }; });
  let hangups = 0;
  const voice = createVoice({ getInventory: store.listItems, getStatus: () => ({}), addItem: store.addItem }, chat.beginVoice, {
    fetch: async (url, init) => {
      if (String(url).endsWith('/hangup')) { hangups++; return new Response(null, { status: 200 }); }
      const form = init!.body as FormData;
      const config = JSON.parse(String(form.get('session')));
      assert.equal(config.model, VOICE_MODEL); assert.equal(config.tools.length, 3);
      return new Response('v=0\r\nanswer', { headers: { location: 'https://api.openai.com/v1/realtime/calls/rtc_test' } });
    },
    connect: () => new WebSocket(`ws://127.0.0.1:${(provider.address() as { port: number }).port}`),
  });
  const app = express(); app.use(express.json()); app.use(chat.router); app.use('/voice', voice.router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body = {}, origin = base) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
  try {
    const thread = await (await post('/threads')).json();
    assert.equal((await post('/voice', { threadId: thread.id, sdp: 'v=0' }, 'https://evil.example')).status, 403);
    await post(`/threads/${thread.id}/messages`, { prompt: 'Earlier chat' });
    const call = await (await post('/voice', { threadId: thread.id, sdp: 'v=0' })).json(); assert.ok(call.id);
    assert.equal(sent.find(e => e.item?.role === 'assistant').item.content[0].type, 'output_text');
    assert.equal((await post(`/threads/${thread.id}/messages`, { prompt: 'overlap' })).status, 409);
    assert.equal((await post('/voice', { threadId: thread.id, sdp: 'v=0' })).status, 409);
    socket!.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'u1' }));
    socket!.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Add two eggs.' }));
    const event = { type: 'response.done', response: { id: 'r1', status: 'completed', output: [{ type: 'function_call', name: 'add_inventory_item', call_id: 'c1', arguments: '{"name":"Eggs","quantity":2}' }] } };
    socket!.send(JSON.stringify(event)); socket!.send(JSON.stringify(event));
    await waitFor(() => sent.some(e => e.type === 'response.create'));
    assert.equal(store.listItems().length, 1);
    assert.equal(sent.filter(e => e.item?.type === 'function_call_output').length, 1);
    socket!.send(JSON.stringify({ type: 'input_audio_buffer.committed', item_id: 'unfinished' }));
    socket!.send(JSON.stringify({ type: 'response.output_audio_transcript.done', item_id: 'a1', transcript: 'Added two eggs.' }));
    socket!.send(JSON.stringify({ type: 'conversation.item.truncated', item_id: 'a1' }));
    await waitFor(() => store.listItems().length === 1);
    await new Promise(r => setTimeout(r, 30));
    await fetch(base + '/voice/' + call.id, { method: 'DELETE', headers: { Origin: base } });
    const saved = await (await fetch(base + '/threads/' + thread.id)).json();
    assert.equal(saved.busy, false); assert.equal(saved.messages[2].text, 'Add two eggs.');
    assert.match(saved.messages[3].text, /interrupted/); assert.equal(saved.messages.length, 4);
    await post(`/threads/${thread.id}/messages`, { prompt: 'continue' });
    assert.match(JSON.stringify(histories), /Voice tool result/);
    assert.equal(hangups, 1);
    assert.equal((await post('/voice/' + call.id + '/heartbeat')).status, 410);
  } finally {
    await voice.close(); await new Promise<void>(r => server.close(() => r())); await new Promise<void>(r => provider.close(() => r())); chat.close(); store.close();
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  }
});
