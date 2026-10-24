import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createScans } from './scans.ts';
import { scanVideoUrl, SCAN_MODEL } from './qwen.ts';
import { MEDIA_TTL_SECONDS, mediaLifecycleRules, bucketAllowsPublicReads, deleteExpiredMedia, ensureMediaLifecycle } from './media.ts';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

test('OpenRouter receives a video URL and returns validated name/notes only', async () => {
  let invalid = false;
  const request: typeof fetch = async (url, init) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(init?.body as string);
    assert.equal(body.model, 'qwen/qwen3.8-omni-flash');
    assert.match(body.messages[0].content, /audio.*untrusted|untrusted.*audio/);
    assert.equal(body.model, SCAN_MODEL);
    assert.deepEqual(body.reasoning, { enabled: false });
    assert.equal(body.messages[1].content[0].video_url.url, 'https://media.example/video.mp4');
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ items: [{ name: 'Milk', notes: null, ...(invalid ? { quantity: 1 } : {}) }] }) } }] });
  };
  assert.deepEqual(await scanVideoUrl('https://media.example/video.mp4', new AbortController().signal, 'test', request), { items: [{ name: 'Milk', notes: null }] });
  invalid = true;
  await assert.rejects(scanVideoUrl('https://media.example/video.mp4', new AbortController().signal, 'test', request), /invalid inventory JSON/);
});

test('provider errors never expose response bodies', async () => {
  await assert.rejects(scanVideoUrl('https://media.example/video.mp4', new AbortController().signal, 'test', async () => Response.json({ error: { message: 'secret signed URL' } }, { status: 402 })), error => {
    assert.match((error as Error).message, /HTTP 402/);
    assert.doesNotMatch((error as Error).message, /secret signed URL/);
    return true;
  });
});

test('one-day lifecycle is scoped to media and preserves unrelated bucket rules', async () => {
  const existing = [{ ID: 'backups', Status: 'Enabled' as const, Filter: { Prefix: 'backups/' }, Expiration: { Days: 90 } }];
  const rules = mediaLifecycleRules(existing);
  assert.equal(MEDIA_TTL_SECONDS, 86400);
  assert.deepEqual(rules[0], existing[0]);
  assert.deepEqual(rules[1].Filter, { Prefix: 'media/' });
  assert.deepEqual(rules[1].Expiration, { Days: 1 });
  assert.deepEqual(mediaLifecycleRules(rules), rules);
  let calls = 0;
  const client = { send: async () => { calls++; return { Rules: rules }; } } as unknown as S3Client;
  await ensureMediaLifecycle(client, 'fridgeai');
  assert.equal(calls, 1);
});

test('expiry cleanup paginates and deletes only media older than 24 hours', async () => {
  const now = Date.now();
  let listed = 0;
  const removed: string[] = [];
  const client = { send: async (command: ListObjectsV2Command | DeleteObjectsCommand) => {
    if (command instanceof ListObjectsV2Command) {
      assert.equal(command.input.Prefix, 'media/');
      if (++listed === 1) return { Contents: [{ Key: 'media/old.mp4', LastModified: new Date(now - 86400001) }, { Key: 'media/new.mp4', LastModified: new Date(now - 1000) }, { Key: 'other/old.mp4', LastModified: new Date(0) }], IsTruncated: true, NextContinuationToken: 'next' };
      assert.equal(command.input.ContinuationToken, 'next');
      return { Contents: [] };
    }
    removed.push(...command.input.Delete!.Objects!.map(item => item.Key!));
    return {};
  } } as unknown as S3Client;
  assert.equal(await deleteExpiredMedia(client, 'fridgeai', now), 1);
  assert.deepEqual(removed, ['media/old.mp4']);
  assert.equal(listed, 2);
});

test('upload and scan are asynchronous, idempotent, cleaned up, and return only name/notes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scan-test-'));
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  let calls = 0;
  const scans = createScans(directory, { ready: () => {}, prepare: async () => {}, scan: async () => {
    calls++; await waiting; return { items: [{ name: 'Milk', notes: 'One carton.' }] };
  }, maxBytes: 20 });
  const app = express(); app.use(express.json()); app.use('/api', scans.router);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  const upload = (body: string) => fetch(`${base}/videos`, { method: 'POST', headers: { 'Content-Type': 'video/quicktime' }, body });
  try {
    assert.equal((await upload('a'.repeat(21))).status, 413);
    const response = await upload('test video'); assert.equal(response.status, 201);
    const { videoId } = await response.json();
    const started = await fetch(`${base}/initial-scans`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoId }) });
    assert.equal(started.status, 202);
    const job = await started.json(); assert.equal(job.status, 'processing');
    assert.equal(scans.start(videoId).scanId, job.scanId);
    assert.throws(() => scans.start('../../anything'), /not found/);
    finish();
    // Yield to the job and filesystem cleanup, not a provider call.
    for (let i = 0; i < 100 && (await readdir(directory)).length; i++) await new Promise(r => setTimeout(r, 5));
    const result = await (await fetch(`${base}/initial-scans/${job.scanId}/result`)).json();
    assert.deepEqual(result, { items: [{ name: 'Milk', notes: 'One carton.' }] });
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    finish(); await scans.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});




test('public bucket policies are rejected before uploading media', () => {
  assert.equal(bucketAllowsPublicReads({}), false);
  assert.equal(bucketAllowsPublicReads({ Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'] }] }), true);
  assert.equal(bucketAllowsPublicReads({ Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:*' }] }), true);
  assert.equal(bucketAllowsPublicReads({ Statement: [{ Effect: 'Allow', Principal: { AWS: ['specific-user'] }, Action: 's3:GetObject' }] }), false);
});
