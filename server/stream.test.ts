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
