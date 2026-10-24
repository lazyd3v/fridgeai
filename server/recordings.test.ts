import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';
import { execFileSync } from 'node:child_process';
import { createRecordings, encodeRecording } from './recordings.ts';
import { prepareVideo } from './scans.ts';
import { reconcileMatches, type Movements } from './door-ai.ts';

const observations: Movements = { movements: [{ direction: 'added', name: 'Milk carton', quantity: 2, evidence: 'Two cartons placed inside.' }], uncertainties: [] };
test('every mutation is logged atomically; stale, invalid and duplicate session updates are safe', () => {
  const store = createStore(':memory:');
  try {
    const milk = store.addItem('Milk', 1);
    store.createRecording('video', '/tmp/video.mp4'); store.setRecording('video', 'processing');
    const snapshot = store.listItems();
    assert.throws(() => store.applyRecording('video', snapshot, [
      { itemId: milk.id, name: milk.name, delta: 2, reason: 'added' },
      { itemId: 'unknown', name: 'unknown', delta: -1, reason: 'removed' },
    ]), /Unknown/);
    assert.equal(store.listItems()[0].quantity, 1);
    assert.equal(store.listLog().length, 1);
    store.addItem('Eggs', 6, null, null, 'agent');
    assert.throws(() => store.applyRecording('video', snapshot, []), /changed/);
    assert.equal(store.recording('video')?.status, 'processing');
    const changes = [{ itemId: milk.id, name: milk.name, delta: -1, reason: 'Removed carton' }];
    assert.equal(store.applyRecording('video', store.listItems(), changes), true);
    assert.equal(store.applyRecording('video', [], changes), false);
    assert.equal(store.listLog().length, 3);
    const log = store.listLog()[0];
    assert.equal(log.recordingId, 'video'); assert.equal(log.source, 'door-video');
    assert.equal(JSON.parse(log.beforeJson as string).quantity, 1); assert.equal(log.afterJson, null);
    assert.equal(store.removeItem('missing'), false); assert.equal(store.listLog().length, 3);
    assert.equal(store.removeItem(store.listItems()[0].id), true); assert.equal(store.listLog().length, 4);
  } finally { store.close(); }
});

test('AI mapping uses observed quantities, matches existing IDs, nets returned items and rejects uncertain mappings', () => {
  const inventory = [{ id: 'milk', name: 'Milk', quantity: 1, createdAt: 'now' }];
  const matches = [{ movementIndex: 0, itemId: 'milk', name: 'invented name', unresolved: false }];
  assert.deepEqual(reconcileMatches(inventory, observations, { matches }), [{ itemId: 'milk', name: 'Milk', delta: 2, reason: 'Two cartons placed inside.' }]);
  assert.throws(() => reconcileMatches(inventory, observations, { matches: [] }), /Incomplete/);
  assert.throws(() => reconcileMatches(inventory, observations, { matches: [{ ...matches[0], itemId: 'unknown' }] }), /Unknown/);
  assert.throws(() => reconcileMatches(inventory, { ...observations, uncertainties: ['hidden hand'] }, { matches }), /Uncertain/);
  assert.deepEqual(reconcileMatches(inventory, { movements: [...observations.movements, { ...observations.movements[0], direction: 'removed' }], uncertainties: [] }, { matches: [...matches, { ...matches[0], movementIndex: 1 }] }), []);
});

test('door starts immediately, shares frames, closes and applies once; rapid reopening queues separately', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'door-recording-'));
  const store = createStore(join(dir, 'test.sqlite'));
  let encodes = 0, frames = 0, scans = 0;
  const recordings = createRecordings(dir, store, 10, {
    encode: () => { encodes++; return { write: () => { frames++; return true; }, finish: async () => {} }; },
    observe: async () => { scans++; return observations; },
    reconcile: async inventory => [{ itemId: inventory[0]?.id ?? null, name: 'Milk', delta: 2, reason: 'Added two cartons' }],
  });
  try {
    recordings.setDoor(true); recordings.setDoor(true); assert.equal(encodes, 1);
    recordings.frame(Buffer.from('jpeg')); recordings.setDoor(false);
    recordings.setDoor(true); recordings.frame(Buffer.from('jpeg')); recordings.setDoor(false);
    await recordings.idle();
    assert.equal(encodes, 2); assert.equal(frames, 2); assert.equal(scans, 2);
    assert.equal(store.listItems()[0].quantity, 4); assert.equal(store.listLog().length, 2);
    assert.ok(store.listRecordings().every(row => row.status === 'completed'));
  } finally { await recordings.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('sensor faults, camera loss, no frames and encoder failures never analyze partial footage', async () => {
  for (const fault of ['sensor', 'camera', 'empty', 'encoder', 'buffer', 'shutdown']) {
    const dir = await mkdtemp(join(tmpdir(), 'door-fault-'));
    const store = createStore(':memory:');
    let scans = 0;
    const recordings = createRecordings(dir, store, 10, {
      encode: () => ({ write: () => fault !== 'buffer', finish: async () => { if (fault === 'encoder') throw new Error('broken'); } }),
      observe: async () => { scans++; return observations; },
    });
    try {
      recordings.setDoor(true);
      if (fault !== 'empty') recordings.frame(Buffer.from('jpeg'));
      if (fault === 'sensor') recordings.setDoor(null);
      if (fault === 'camera') recordings.fault();
      if (fault === 'shutdown') await recordings.close();
      recordings.setDoor(false); await recordings.idle();
      assert.equal(scans, 0, fault); assert.equal(store.listRecordings()[0].status, 'incomplete', fault);
      assert.equal(store.listLog().length, 0);
    } finally { await recordings.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
  }
});

test('restart recovers queued analysis, preserves ordering and never replays committed recordings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'door-recovery-'));
  const store = createStore(join(dir, 'test.sqlite'));
  store.createRecording('first', '/tmp/first.mp4'); store.setRecording('first', 'processing');
  store.createRecording('second', '/tmp/second.mp4'); store.setRecording('second', 'queued');
  let scans = 0;
  const recordings = createRecordings(dir, store, 10, { observe: async () => { scans++; throw new Error('provider unavailable'); } });
  try {
    await recordings.idle();
    assert.equal(scans, 1); assert.equal(store.recording('first')?.status, 'failed'); assert.equal(store.recording('second')?.status, 'queued');
    await recordings.close();
    store.setRecording('first', 'queued');
    const recovered = createRecordings(dir, store, 10, { observe: async () => observations, reconcile: async () => [] });
    await recovered.idle(); await recovered.close();
    assert.equal(store.recording('first')?.status, 'completed'); assert.equal(store.recording('second')?.status, 'completed');
    const again = createRecordings(dir, store, 10, { observe: async () => { throw new Error('must not replay'); } });
    await again.idle(); await again.close();
    assert.equal(store.recording('first')?.status, 'completed');
  } finally { await recordings.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});


test('real FFmpeg encoder creates a playable H.264 MP4 from shared JPEG frames', async t => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); execFileSync('ffprobe', ['-version'], { stdio: 'ignore' }); }
  catch { t.skip('FFmpeg and ffprobe are required for the encoding smoke test.'); return; }
  const dir = await mkdtemp(join(tmpdir(), 'door-encoder-'));
  try {
    const frame = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']);
    const path = join(dir, 'recording.mp4');
    const encoder = encodeRecording(path, 10);
    for (let i = 0; i < 20; i++) assert.equal(encoder.write(frame), true);
    await encoder.finish();
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,nb_frames:format=duration', '-of', 'json', path], { encoding: 'utf8' }));
    assert.equal(probe.streams[0].codec_name, 'h264');
    assert.equal(Number(probe.streams[0].nb_frames), 20);
    assert.equal(Number(probe.format.duration), 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('duration limit produces incomplete footage and waits for the next door cycle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'door-duration-'));
  const store = createStore(':memory:');
  const recordings = createRecordings(dir, store, 10, {
    maxDurationMs: 5, encode: () => ({ write: () => true, finish: async () => {} }),
    observe: async () => { throw new Error('Partial footage must not be analyzed'); },
  });
  try {
    recordings.setDoor(true); recordings.frame(Buffer.from('jpeg'));
    await new Promise(resolve => setTimeout(resolve, 20)); await recordings.idle();
    assert.equal(store.listRecordings()[0].status, 'incomplete');
    recordings.setDoor(true); assert.equal(store.listRecordings().length, 1);
  } finally { await recordings.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});


test('audio recordings retain AAC through upload preparation; missing microphone fails', async t => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); }
  catch { t.skip('FFmpeg required'); return; }
  const dir = await mkdtemp(join(tmpdir(), 'audio-recording-'));
  try {
    const frame = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']);
    const path = join(dir, 'audio.mp4');
    let released = false;
    const encoder = encodeRecording(path, 10, { subscribe(data) {
      const timer = setInterval(() => {
        const pcm = Buffer.alloc(9600);
        for (let i = 0; i < 4800; i++) pcm.writeInt16LE(Math.round(10000 * Math.sin(i * 2 * Math.PI * 440 / 48000)), i * 2);
        data(pcm);
      }, 100);
      return () => { clearInterval(timer); released = true; };
    } });
    for (let i = 0; i < 25; i++) {
      assert.equal(encoder.write(frame), true);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await encoder.finish();
    assert.equal(released, true);
    for (const file of [path, join(dir, 'prepared.mp4')]) {
      if (file !== path) await prepareVideo(path, file, new AbortController().signal);
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], { encoding: 'utf8' }));
      assert.ok(probe.streams.some((s: { codec_name: string }) => s.codec_name === 'h264'));
      const audio = probe.streams.find((s: { codec_name: string }) => s.codec_name === 'aac');
      assert.ok(audio); assert.ok(Number(audio.duration) >= 2);
    }
    const failed = encodeRecording(join(dir, 'failed.mp4'), 10, { subscribe() { throw new Error('Microphone missing'); } });
    assert.equal(failed.write(frame), false);
    await assert.rejects(failed.finish(), /microphone|encoder/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
