import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import express from 'express';
import type WebSocket from 'ws';
import { createSummarySpeech, pcmToWav, spokenSummary, synthesizeSummary } from './summary-speech.ts';

class FakeSocket extends EventEmitter {
  sent: any[] = [];
  closed = false;
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.closed = true; }
  event(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}
test('summary narrator requests audio only, assembles WAV, and rejects incomplete speech', async () => {
  const ws = new FakeSocket();
  const result = synthesizeSummary('Added 2 × apples.', new AbortController().signal, () => ws as unknown as WebSocket);
  ws.emit('open'); ws.event({ type: 'session.updated' }); ws.event({ type: 'session.updated' });
  assert.equal(ws.sent.length, 2);
  assert.deepEqual(ws.sent[0].session.tools, []);
  assert.equal(ws.sent[1].response.conversation, 'none');
  assert.match(ws.sent[1].response.input[0].content[0].text, /2  times  apples/);
  ws.event({ type: 'response.output_audio.delta', delta: Buffer.from([0, 0, 1, 0]).toString('base64') });
  ws.event({ type: 'response.done', response: { status: 'completed' } });
  const wav = await result;
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt32LE(40), 4); assert.equal(ws.closed, true);
  const bad = new FakeSocket(); const failed = synthesizeSummary('text', new AbortController().signal, () => bad as unknown as WebSocket);
  bad.event({ type: 'response.done', response: { status: 'incomplete' } });
  await assert.rejects(failed, /incomplete/);
  const aborted = new AbortController(); const abortWs = new FakeSocket();
  const cancelled = synthesizeSummary('text', aborted.signal, () => abortWs as unknown as WebSocket);
  aborted.abort(); await assert.rejects(cancelled, /cancelled/); assert.equal(abortWs.closed, true);
  assert.ok(spokenSummary('x'.repeat(5000)).length < 4000);
});

test('speech endpoint uses saved summaries only, caches concurrent requests and hides provider failures', async () => {
  let calls = 0;
  const speech = createSummarySpeech(id => id === 'saved' ? 'Added milk.' : undefined, async text => {
    calls++; await new Promise(resolve => setTimeout(resolve, 10));
    if (text.startsWith('Hi Roman')) throw new Error('private provider response');
    assert.equal(text, 'Added milk.'); return pcmToWav(Buffer.from([0, 0]));
  });
  const app = express(); app.use(express.json(), speech.router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/summary-speech`;
  const post = (body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post({ text: 'arbitrary input' })).status, 400);
    assert.equal((await post({ notificationId: 'missing' })).status, 404);
    const results = await Promise.all([post({ notificationId: 'saved' }), post({ notificationId: 'saved' })]);
    for (const response of results) { assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /audio\/wav/); }
    await post({ notificationId: 'saved' }); assert.equal(calls, 1);
    const failed = await post({ preview: true }); assert.equal(failed.status, 502); assert.doesNotMatch(await failed.text(), /private/);
    assert.equal((await fetch(url, { method: 'POST', headers: { Origin: 'https://another.example', 'Content-Type': 'application/json' }, body: '{"preview":true}' })).status, 403);
  } finally { speech.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('summary feed skips old messages and orders delayed delivery without losing updates', async () => {
  const { createChat } = await import('./chat.ts');
  const chat = createChat(':memory:', async () => { throw new Error('unused'); });
  const app = express(); app.use(express.json(), chat.router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const feed = (after?: number) => fetch(`${url}/summary-notifications${after === undefined ? '' : `?after=${after}`}`).then(r => r.json());
  try {
    chat.notify('old', 'Old summary');
    const baseline = await feed(); assert.equal(baseline.notifications.length, 0);
    const threads = await (await fetch(`${url}/threads`)).json();
    const voice = chat.beginVoice(threads[0].id);
    chat.notify('delayed', 'Wait for voice');
    assert.equal((await feed(baseline.cursor)).notifications.length, 0);
    assert.equal(chat.notificationText('delayed'), undefined);
    voice.finish();
    const arrived = await feed(baseline.cursor);
    assert.deepEqual(arrived.notifications.map((n: { id: string }) => n.id), ['delayed']);
    assert.equal(chat.notificationText('delayed'), 'Wait for voice');
    assert.equal((await feed(arrived.cursor)).notifications.length, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); chat.close(); }
});

test('Speaking fridge results feed publishes only finished analysis and includes busy calls', async () => {
  const { createChat } = await import('./chat.ts');
  const chat = createChat(':memory:', async () => { throw new Error('unused'); });
  const app = express(); app.use(express.json(), chat.router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const feed = (after?: number) => fetch(`${base}/speaking-fridge/results${after === undefined ? '' : `?after=${after}`}`).then(r => r.json());
  try {
    chat.notify('old-result', 'Old result', 'old-recording');
    const baseline = await feed(); assert.deepEqual(baseline.results, []);
    const thread = chat.prepareDoorConversation('recording');
    assert.deepEqual((await feed(baseline.cursor)).results, []); // Opening a conversation is not a result.
    const call = chat.beginVoice(thread.id);
    chat.notify('scan', 'Uploaded scan');
    chat.notify('result', 'Removed milk.', 'recording');
    const next = await feed(baseline.cursor);
    assert.deepEqual(next.results.map((r: { recordingId: string }) => r.recordingId), ['recording']);
    assert.ok(Date.now() - Date.parse(next.results[0].createdAt) < 5000);
    assert.equal(chat.notificationText('result'), undefined); // Text delivery waits for call end; the result feed does not.
    assert.deepEqual((await feed(next.cursor)).results, []);
    call.finish();
    assert.deepEqual((await feed(next.cursor)).results, []); // No second call on chat delivery.
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); chat.close(); }
});
