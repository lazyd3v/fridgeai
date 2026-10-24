import type { Writable } from 'node:stream';
import type { AudioSource } from './microphone.ts';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Store } from './store.ts';
import { observeDoorVideo, reconcileDoorInventory, movementSchema } from './door-ai.ts';

export type Encoder = { write(frame: Buffer): boolean; finish(): Promise<void> };
// This process reads JPEGs from the one shared camera process, never /dev/video0.
export function encodeRecording(path: string, fps: number, audio?: AudioSource): Encoder {
  const child = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-vcodec', 'mjpeg', '-framerate', String(fps), '-i', 'pipe:0',
    ...(audio ? ['-thread_queue_size', '512', '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', 'pipe:3',
      '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '96k', '-shortest'] : ['-an']), '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-n', path], { stdio: ['pipe', 'pipe', 'pipe', ...(audio ? ['pipe' as const] : [])] });
  child.stdout!.resume(); child.stderr!.resume();
  let broken = false;
  let audioBytes = 0;
  let startedAt = 0, frameCount = 0;
  let lastFrame: Buffer | undefined;
  const writeFrame = (frame: Buffer) => { child.stdin!.write(frame); frameCount++; };
  // JPEG pipes have no timestamps: duplicate dropped frames to keep audio in sync.
  const fillFrames = (target: number) => {
    while (lastFrame && frameCount < target) {
      if (child.stdin!.writableLength >= 8 * 1024 * 1024) { broken = true; child.kill('SIGKILL'); return; }
      writeFrame(lastFrame);
    }
  };
  let releaseAudio: (() => void) | undefined;
  const audioPipe = child.stdio[3] as Writable | undefined;
  const failAudio = () => { broken = true; child.kill('SIGKILL'); };
  audioPipe?.on('error', failAudio);
  child.stdin!.on('error', () => { broken = true; });
  let finishing: Promise<void> | undefined;
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', () => { broken = true; reject(new Error('Recording encoder unavailable.')); });
    child.once('close', code => { releaseAudio?.(); broken = true; code === 0 && (!audio || audioBytes > 0) ? resolve() : reject(new Error('Recording encoder or webcam microphone failed.')); });
  });
  // Observe early encoder failure even before the door closes.
  void done.catch(() => {});
  return {
    write(frame) {
      if (audio && !releaseAudio && !broken) {
        try { startedAt = performance.now(); releaseAudio = audio.subscribe(pcm => {
          if (!audioPipe || audioPipe.writableLength > 1024 * 1024) { failAudio(); return; }
          audioBytes += pcm.length; audioPipe.write(pcm);
        }, failAudio); } catch { failAudio(); }
      }
      if (broken || child.stdin!.writableLength >= 8 * 1024 * 1024) return false;
      if (audio) {
        const index = Math.round((performance.now() - startedAt) * fps / 1000);
        fillFrames(index);
        if (broken) return false;
        if (frameCount <= index) writeFrame(frame);
        lastFrame = frame;
      } else writeFrame(frame);
      return true;
    },
    finish() {
      if (!finishing) finishing = (async () => {
        if (audio && !broken) fillFrames(Math.ceil((performance.now() - startedAt) * fps / 1000));
        releaseAudio?.(); releaseAudio = undefined;
        audioPipe?.end(); child.stdin!.end();
        const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
        try { await done; } finally { clearTimeout(timer); }
      })();
      return finishing;
    },
  };
}
type Options = { encode?: typeof encodeRecording; observe?: typeof observeDoorVideo; reconcile?: typeof reconcileDoorInventory; maxDurationMs?: number };
export function createRecordings(dataDir: string, store: Store, fps: number, options: Options = {}) {
  const directory = join(dataDir, 'recordings');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  store.recoverRecordings();
  let active: { id: string; encoder: Encoder; frames: number; bytes: number; timer: ReturnType<typeof setTimeout> } | undefined;
  let open = false;
  let closed = false;
  let processing: Promise<void> | undefined;
  const finalizers = new Set<Promise<void>>();
  const controller = new AbortController();
  const router = Router();
  function pump() {
    if (closed || processing) return;
    processing = (async () => {
      while (!closed) {
        // A failed earlier session blocks later sessions to preserve event order.
        const next = store.nextRecording();
        if (!next || next.status !== 'queued') return;
        store.setRecording(next.id, 'processing');
        try {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60_000)]);
          const observations = next.observations ? movementSchema.parse(JSON.parse(next.observations)) : await (options.observe ?? observeDoorVideo)(next.path, signal, store.listItems());
          store.setRecording(next.id, 'processing', null, observations);
          const inventory = store.listItems();
          const changes = await (options.reconcile ?? reconcileDoorInventory)(inventory, observations, signal);
          signal.throwIfAborted();
          store.applyRecording(next.id, inventory, changes);
        } catch {
          store.setRecording(next.id, closed ? 'queued' : 'failed', 'Analysis could not be applied. Check configuration, observations and inventory, then retry or dismiss.');
          return;
        }
      }
    })().finally(() => { processing = undefined; });
  }
  function finish(problem?: string) {
    const session = active;
    active = undefined;
    if (!session) return;
    clearTimeout(session.timer);
    const task = (async () => {
      try {
        await session.encoder.finish();
        if (problem || !session.frames) store.setRecording(session.id, 'incomplete', problem ?? 'No camera frames captured.');
        else store.setRecording(session.id, 'queued');
      } catch { store.setRecording(session.id, 'incomplete', problem ?? 'Recording encoder failed.'); }
    })().finally(() => { finalizers.delete(task); pump(); });
    finalizers.add(task);
  }
  function setDoor(value: boolean | null) {
    if (closed) return;
    if (value === true) {
      if (open) return;
      open = true;
      const id = randomUUID();
      const path = join(directory, `${id}.mp4`);
      store.createRecording(id, path);
      try {
        active = { id, encoder: (options.encode ?? encodeRecording)(path, fps), frames: 0, bytes: 0,
          timer: setTimeout(() => finish('Door remained open beyond the five-minute recording limit; footage is incomplete.'), options.maxDurationMs ?? 300_000) };
      } catch { store.setRecording(id, 'incomplete', 'Could not start recording.'); }
    } else {
      open = false;
      finish(value === null ? 'Door sensor unavailable; footage is incomplete.' : undefined);
    }
  }
  function frame(frame: Buffer) {
    if (!active) return;
    active.bytes += frame.length;
    if (active.bytes > 512 * 1024 * 1024 || !active.encoder.write(frame)) {
      finish('Recording exceeded its buffer or size limit; footage is incomplete.'); return;
    }
    active.frames++;
  }
  router.get('/recordings', (_req, res) => res.json(store.listRecordings().map(({ path: _, ...recording }) => recording)));
  router.get('/recordings/:id/video', (req, res) => {
    const recording = store.recording(req.params.id);
    if (!recording) { res.status(404).json({ error: 'Recording not found.' }); return; }
    if (recording.status === 'recording') { res.status(409).json({ error: 'Recording is still being saved.' }); return; }
    res.sendFile(recording.path);
  });
  router.post('/recordings/:id/retry', (req, res) => {
    const recording = store.recording(req.params.id);
    if (!recording) { res.status(404).json({ error: 'Recording not found.' }); return; }
    if (recording.status !== 'failed') { res.status(409).json({ error: 'Only failed analysis can be retried. Incomplete footage requires a manual inventory check.' }); return; }
    store.setRecording(recording.id, 'queued'); pump(); res.status(202).json({ id: recording.id });
  });
  router.post('/recordings/:id/dismiss', (req, res) => {
    const recording = store.recording(req.params.id);
    if (!recording) { res.status(404).json({ error: 'Recording not found.' }); return; }
    if (!['failed', 'incomplete'].includes(recording.status)) { res.status(409).json({ error: 'Only failed or incomplete sessions can be dismissed.' }); return; }
    store.setRecording(recording.id, 'dismissed', 'Manually dismissed; this session made no inventory changes.');
    pump(); res.json({ id: recording.id, status: 'dismissed' });
  });
  pump();
  return {
    router, setDoor, frame, fault: () => finish('Camera interrupted; footage is incomplete.'),
    status: () => ({ recordingId: active?.id ?? null, processing: !!processing, next: store.nextRecording()?.status ?? null }),
    async idle() { await Promise.all([...finalizers]); await processing; },
    async close() {
      closed = true; controller.abort(); finish('Service stopped during recording; footage is incomplete.');
      await Promise.all([...finalizers]); await processing;
    },
  };
}
