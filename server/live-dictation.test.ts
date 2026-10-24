import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import WebSocket, { WebSocketServer } from 'ws';
import { attachLiveDictation, LIVE_TRANSCRIPTION_SESSION } from './live-dictation.ts';
import { createTranscript } from '../src/live-dictation.ts';

test('live dictation streams audio, returns text before stop and finalizes without exposing provider events', async () => {
  const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(provider, 'listening');
  let commits = 0;
  provider.on('connection', ws => ws.on('message', raw => {
    const event = JSON.parse(raw.toString());
    if (event.type === 'session.update') {
      assert.deepEqual(event.session, LIVE_TRANSCRIPTION_SESSION);
      ws.send(JSON.stringify({ type: 'session.updated', session: { secret: 'never forward' } }));
    } else if (event.type === 'input_audio_buffer.append') {
      assert.equal(Buffer.from(event.audio, 'base64').length, 4800);
      ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'one', delta: 'Two egg' }));
    } else if (event.type === 'input_audio_buffer.commit') {
      commits++;
      ws.send(JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'one', transcript: 'Two eggs.' }));
    }
  }));
  const server = createServer();
  const stop = attachLiveDictation(server, () => new WebSocket(`ws://127.0.0.1:${(provider.address() as { port: number }).port}`));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new WebSocket(`ws://${host}/api/dictation/live`, { origin: `http://${host}` });
  const events: { type: string; text?: string }[] = [];
  client.on('message', raw => {
    const event = JSON.parse(raw.toString()); events.push(event);
    if (event.type === 'ready') client.send(Buffer.alloc(4800));
    if (event.type === 'delta') { assert.equal(commits, 0); client.send(JSON.stringify({ type: 'stop' })); }
  });
  try {
    await once(client, 'close');
    assert.deepEqual(events.map(event => event.type), ['ready', 'delta', 'completed', 'done']);
    assert.equal(events[2].text, 'Two eggs.');
    assert.equal(commits, 1); assert.doesNotMatch(JSON.stringify(events), /secret/);
    const bad = new WebSocket(`ws://${host}/api/dictation/live`, { origin: 'https://unrelated.example' });
    const [error] = await once(bad, 'error'); assert.match(error.message, /403/);
  } finally { stop(); await new Promise<void>(resolve => server.close(() => resolve())); await new Promise<void>(resolve => provider.close(() => resolve())); }
});

test('final transcript replaces provisional text and keeps the existing draft', () => {
  let text = '';
  const accept = createTranscript('Please add', value => { text = value; });
  accept({ type: 'delta', itemId: 'a', text: 'two ' }); assert.equal(text, 'Please add two');
  accept({ type: 'delta', itemId: 'a', text: 'egg' }); assert.equal(text, 'Please add two egg');
  accept({ type: 'completed', itemId: 'a', text: 'two eggs.' }); assert.equal(text, 'Please add two eggs.');
  accept({ type: 'completed', itemId: 'a', text: 'two eggs.' }); assert.equal(text, 'Please add two eggs.');
});

test('audio worklet downsamples to PCM24k and flushes final partial chunk before stop', () => {
  let Processor: any;
  const messages: any[] = [];
  class Base { port = { onmessage: (_: unknown) => {}, postMessage: (data: unknown) => messages.push(data) }; }
  runInNewContext(readFileSync(new URL('../public/dictation-worklet.js', import.meta.url), 'utf8'), { AudioWorkletProcessor: Base, sampleRate: 48000, registerProcessor: (_: string, value: any) => { Processor = value; } });
  const processor = new Processor();
  processor.process([[new Float32Array(10000).fill(0.5)]]);
  processor.port.onmessage({ data: 'stop' });
  assert.deepEqual(messages.map(item => item.type), ['audio', 'audio', 'flushed']);
  assert.equal(messages[0].bytes.byteLength, 9600); assert.equal(messages[1].bytes.byteLength, 400);
  assert.equal(new Int16Array(messages[0].bytes)[0], 16384);
  assert.equal(processor.process([]), false);
});
