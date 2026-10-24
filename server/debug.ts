import { Router } from 'express';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { encodeRecording, type Encoder } from './recordings.ts';
import { uploadMedia, storageConfig, MEDIA_TTL_SECONDS } from './media.ts';

type Camera = { holdForTest(): () => void; onFrame(fn: (frame: Buffer) => void): () => void; onFault(fn: () => void): () => void };
type Options = { encode?: typeof encodeRecording; upload?: typeof uploadMedia; ready?: () => void; maxDurationMs?: number };
export function createDebugRecorder(dataDir: string, camera: Camera | null, fps: number, options: Options = {}) {
  const router = Router();
  let state: { status: 'idle' | 'recording' | 'uploading' | 'completed' | 'failed'; id?: string; startedAt?: string; url?: string; expiresAt?: string; error?: string; canRetry?: boolean } = { status: 'idle' };
  let session: { encoder: Encoder; frames: number; bytes: number; release: () => void; timer: ReturnType<typeof setTimeout> } | undefined;
  let path: string | undefined;
  let pending: Promise<void> | undefined;
  let closed = false;
  const controller = new AbortController();
  const fail = (message: string) => Object.assign(new Error(message), { status: 409 });
  const status = () => ({ ...state, available: !!camera });
  function upload() {
    state = { ...state, status: 'uploading', error: undefined, canRetry: false };
    pending = (async () => {
      try {
        const expiresAt = new Date(Date.now() + MEDIA_TTL_SECONDS * 1000).toISOString();
        const url = await (options.upload ?? uploadMedia)(path!, AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60_000)]));
        state = { ...state, status: 'completed', url, expiresAt };
      } catch { state = { ...state, status: 'failed', error: 'Hetzner upload failed. Check storage configuration and retry.', canRetry: true }; }
    })();
    return pending;
  }
  function stop(problem?: string) {
    if (!session) return status();
    const current = session; session = undefined;
    clearTimeout(current.timer); current.release();
    state = { ...state, status: 'uploading' };
    pending = (async () => {
      try {
        await current.encoder.finish();
        if (problem || !current.frames) throw new Error(problem ?? 'No camera frames received. Record again once the camera is ready.');
      } catch {
        state = { ...state, status: 'failed', error: problem ?? 'Recording failed or contained no frames. Try recording again.', canRetry: false }; return;
      }
      if (!closed) await upload();
    })();
    return status();
  }
  const detachFrame = camera?.onFrame(frame => {
    if (!session) return;
    session.bytes += frame.length;
    if (session.bytes > 512 * 1024 * 1024 || !session.encoder.write(frame)) { stop('Recording exceeded its size or buffer limit. Record a shorter test.'); return; }
    session.frames++;
  });
  const detachFault = camera?.onFault(() => stop('Camera interrupted. Record the test again.'));
  function start() {
    if (closed) throw fail('Recorder is shutting down.');
    if (!camera) throw fail('Test recording requires the Pi USB camera.');
    if (session || state.status === 'uploading') throw fail('A test recording or upload is already in progress.');
    (options.ready ?? storageConfig)();
    const directory = join(dataDir, 'test-recordings');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const id = randomUUID(); const target = join(directory, `${id}.mp4`);
    const release = camera.holdForTest();
    try {
      session = { encoder: (options.encode ?? encodeRecording)(target, fps), release, frames: 0, bytes: 0,
        timer: setTimeout(() => stop(), options.maxDurationMs ?? 300_000) };
    } catch { release(); throw fail('Could not start the test recording.'); }
    path = target;
    state = { status: 'recording', id, startedAt: new Date().toISOString() };
    return status();
  }
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.get('/', (_req, res) => res.json(status()));
  router.post('/start', (_req, res) => res.status(201).json(start()));
  router.post('/stop', (_req, res) => res.status(202).json(stop()));
  router.post('/retry', (_req, res) => {
    if (closed || state.status !== 'failed' || !state.canRetry) throw fail('No failed upload to retry.');
    void upload(); res.status(202).json(status());
  });
  router.use((error: Error & { status?: number }, _req: import('express').Request, res: import('express').Response, _next: import('express').NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.status ? error.message : 'Test recorder failed.' });
  });
  return { router, start, stop, status, async idle() { await pending; }, async close() {
    closed = true; controller.abort(); stop('Service stopped during recording.'); detachFrame?.(); detachFault?.(); await pending;
  } };
}
