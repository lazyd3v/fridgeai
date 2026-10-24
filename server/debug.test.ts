import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { once } from 'node:events';
import { createDebugRecorder } from './debug.ts';
import { CameraStream } from './stream.ts';

function fakeCamera() {
  let frames: (frame: Buffer) => void = () => {};
  let fault: () => void = () => {};
  let holds = 0, releases = 0;
  return {
    holdForTest() { holds++; return () => { releases++; }; },
    onFrame(fn: typeof frames) { frames = fn; return () => { frames = () => {}; }; },
    onFault(fn: typeof fault) { fault = fn; return () => { fault = () => {}; }; },
    frame() { frames(Buffer.from('jpeg')); }, fault() { fault(); },
    counts: () => ({ holds, releases }),
  };
}
test('test camera override survives door changes and restores sensor gating', () => {
  const stream = new CameraStream({ mode: 'usb', device: '/dev/video0' });
  // Test ownership/gating without starting a camera runtime on the Mac.
  Object.assign(stream, { start() {} });
  try {
    stream.setDoor(false); assert.equal(stream.status().allowed, false);
    const release = stream.holdForTest(); assert.equal(stream.status().allowed, true);
    stream.setDoor(null); assert.equal(stream.status().allowed, true);
    release(); release(); assert.equal(stream.status().allowed, false);
    const releaseAgain = stream.holdForTest(); stream.setDoor(true); releaseAgain();
    assert.equal(stream.status().allowed, true);
    stream.setDoor(false); assert.equal(stream.status().allowed, false);
  } finally { stream.close(); }
});

test('start/stop API uploads once, returns URL, restores camera and supports failed upload retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'debug-video-'));
  const camera = fakeCamera();
  let uploads = 0, finishes = 0, rejectUpload = true;
  const recorder = createDebugRecorder(dir, camera, 10, {
    ready() {}, encode: () => ({ write: () => true, finish: async () => { finishes++; } }),
    upload: async path => { assert.ok(path.startsWith(join(dir, 'test-recordings'))); uploads++; if (rejectUpload) throw new Error('secret signed URL'); return 'https://example.test/video.mp4?signed=test'; },
  });
  const app = express(); app.use('/api/debug/recording', recorder.router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/debug/recording`;
  const post = (action: string) => fetch(`${base}/${action}`, { method: 'POST' });
  try {
    assert.equal((await post('start')).status, 201);
    assert.equal((await post('start')).status, 409);
    camera.frame();
    assert.equal((await post('stop')).status, 202); await recorder.idle();
    assert.equal(finishes, 1); assert.equal(uploads, 1);
    assert.equal(recorder.status().status, 'failed'); assert.equal(recorder.status().canRetry, true);
    assert.doesNotMatch(recorder.status().error!, /secret/);
    assert.deepEqual(camera.counts(), { holds: 1, releases: 1 });
    rejectUpload = false;
    assert.equal((await post('retry')).status, 202); await recorder.idle();
    const response = await fetch(base);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.status, 'completed'); assert.equal(result.url, 'https://example.test/video.mp4?signed=test');
    assert.ok(Date.parse(result.expiresAt) > Date.now());
    await post('stop'); await recorder.idle(); assert.equal(uploads, 2);
    assert.equal((await post('retry')).status, 409);
  } finally { await recorder.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});

test('empty, broken and shutdown captures do not upload; duration limit uploads a valid test', async () => {
  for (const mode of ['empty', 'fault', 'buffer', 'shutdown', 'limit']) {
    const dir = await mkdtemp(join(tmpdir(), 'debug-fault-'));
    const camera = fakeCamera(); let uploads = 0;
    const recorder = createDebugRecorder(dir, camera, 10, {
      ready() {}, maxDurationMs: mode === 'limit' ? 5 : 300_000,
      encode: () => ({ write: () => mode !== 'buffer', finish: async () => {} }),
      upload: async () => { uploads++; return 'https://example.test/video'; },
    });
    try {
      recorder.start(); if (mode !== 'empty') camera.frame();
      if (mode === 'fault') camera.fault();
      if (mode === 'shutdown') await recorder.close();
      if (mode === 'limit') await new Promise(resolve => setTimeout(resolve, 20));
      else recorder.stop();
      await recorder.idle();
      assert.equal(uploads, mode === 'limit' ? 1 : 0, mode);
      assert.equal(recorder.status().status, mode === 'limit' ? 'completed' : 'failed', mode);
      assert.equal(camera.counts().releases, 1, mode);
    } finally { await recorder.close(); await rm(dir, { recursive: true, force: true }); }
  }
});

test('unsupported camera or missing storage configuration never acquires the camera', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'debug-config-'));
  const camera = fakeCamera();
  const unavailable = createDebugRecorder(dir, null, 10);
  const unconfigured = createDebugRecorder(dir, camera, 10, { ready() { throw new Error('Missing storage configuration'); } });
  try {
    assert.throws(() => unavailable.start(), /USB camera/);
    assert.throws(() => unconfigured.start(), /Missing storage/);
    assert.deepEqual(camera.counts(), { holds: 0, releases: 0 });
  } finally { await unavailable.close(); await unconfigured.close(); await rm(dir, { recursive: true, force: true }); }
});
