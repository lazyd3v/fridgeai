import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JpegFrames } from './stream.ts';

test('JPEG parser handles split markers, garbage, and multiple frames', () => {
  const parser = new JpegFrames();
  assert.deepEqual(parser.push(Buffer.from([0, 1, 255])), []);
  assert.deepEqual(parser.push(Buffer.from([216, 1, 2, 255])), []);
  const frames = parser.push(Buffer.from([217, 255, 216, 3, 255, 217, 9]));
  assert.deepEqual(frames, [Buffer.from([255, 216, 1, 2, 255, 217]), Buffer.from([255, 216, 3, 255, 217])]);
});

test('JPEG parser bounds malformed frame memory', () => {
  const parser = new JpegFrames();
  assert.throws(() => parser.push(Buffer.concat([Buffer.from([255, 216]), Buffer.alloc(8 * 1024 * 1024)])), /exceeded/);
});

test('camera sessions change after a quick door cycle, even between status polls', async () => {
  const { CameraStream } = await import('./stream.ts');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { setTimeout: delay } = await import('node:timers/promises');
  const directory = mkdtempSync(join(tmpdir(), 'fridge-camera-test-'));
  const previousPath = process.env.PATH;
  // A fake camera process keeps this regression test independent of USB hardware.
  writeFileSync(join(directory, 'ffmpeg'), `#!${process.execPath}\nsetInterval(() => process.stdout.write(Buffer.from([255,216,1,255,217])), 20);\n`, { mode: 0o700 });
  process.env.PATH = `${directory}:${previousPath}`;
  const stream = new CameraStream({ mode: 'usb', device: '/fake-camera' });
  try {
    stream.setDoor(true);
    await stream.snapshot();
    const first = stream.status().sessionId;
    assert.ok(first);
    stream.setDoor(false);
    stream.setDoor(true);
    await stream.snapshot();
    assert.equal(stream.status().allowed, true);
    assert.notEqual(stream.status().sessionId, first);
    const second = stream.status().sessionId;
    await stream.snapshot();
    assert.equal(stream.status().sessionId, second, 'normal frames do not trigger reconnects');
  } finally {
    stream.close();
    await delay(100);
    process.env.PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('closing the door while focus restores prevents capture from starting', async () => {
  const { CameraStream } = await import('./stream.ts');
  let finish!: () => void;
  let restores = 0;
  const stream = new CameraStream({ mode: 'usb', device: '/fake-camera' }, () => {
    restores++;
    return new Promise<void>(resolve => { finish = resolve; });
  });
  stream.setDoor(true);
  stream.setDoor(true);
  assert.equal(restores, 1, 'only one startup can wait for controls');
  assert.equal(stream.status().running, false);
  stream.setDoor(false);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stream.status().running, false);
  assert.equal(stream.status().sessionId, null);
  stream.close();
});

test('debug streams share camera ownership and release the door override on disconnect', async () => {
  const { CameraStream } = await import('./stream.ts');
  const { EventEmitter } = await import('node:events');
  function response() {
    const result = Object.assign(new EventEmitter(), {
      set() { return this; }, flushHeaders() {}, end() { result.emit('close'); },
      write() { return true; }, destroyed: false, writableLength: 0,
    });
    return result as unknown as import('express').Response;
  }
  // Defer camera startup so this ownership test never opens real hardware.
  const stream = new CameraStream({ mode: 'usb', device: '/fake-camera' }, () => new Promise(() => {}));
  stream.setDoor(false);
  const first = response(), second = response();
  stream.attachDebug(first); stream.attachDebug(second);
  assert.equal(stream.status().allowed, true);
  assert.equal(stream.status().viewers, 2);
  stream.setDoor(false);
  assert.equal(stream.status().allowed, true, 'closing door does not interrupt debug preview');
  const releaseRecording = stream.holdForTest();
  releaseRecording();
  assert.equal(stream.status().allowed, true, 'stopping a test recording preserves preview');
  first.end();
  assert.equal(stream.status().allowed, true, 'another viewer still holds the camera');
  second.end();
  assert.equal(stream.status().allowed, false);
  assert.equal(stream.status().viewers, 0);
  const third = response();
  stream.attachDebug(third);
  stream.setDoor(true);
  third.end();
  assert.equal(stream.status().allowed, true, 'physical door retains control after preview ends');
  stream.attachDebug(response());
  stream.close();
  assert.equal(stream.status().allowed, false, 'shutdown cannot be undone by a disconnect callback');
});
