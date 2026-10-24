import { Router } from 'express';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { qwenConfig, scanError, scanWithQwen, type ScanResult } from './qwen.ts';

const exec = promisify(execFile);
const MAX_BYTES = 512 * 1024 * 1024;
const TTL = 60 * 60 * 1000;
export async function prepareVideo(input: string, output: string, signal: AbortSignal) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', input], { signal, timeout: 30_000, killSignal: 'SIGKILL' });
  const info = JSON.parse(stdout);
  const duration = Number(info.format?.duration);
  if (!Number.isFinite(duration) || duration < 2 || duration > 300 || !info.streams?.some((s: { codec_type: string }) => s.codec_type === 'video')) throw scanError('Provide a video between 2 seconds and 5 minutes.');
  await exec('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', input, '-map', '0:v:0', '-an', '-c:v', 'copy', '-movflags', '+faststart', '-y', output], { signal, timeout: 120_000, killSignal: 'SIGKILL' });
}
type Job = { scanId: string; status: 'processing' | 'completed' | 'failed'; result?: ScanResult; error?: string; expires: number };
type Video = { directory: string; path: string; expires: number; scanId?: string };
type Options = {
  ready?: () => void;
  prepare?: typeof prepareVideo;
  scan?: (path: string, signal: AbortSignal) => Promise<ScanResult>;
  maxBytes?: number;
};
export function createScans(dataDir: string, options: Options = {}) {
  const videos = new Map<string, Video>();
  const jobs = new Map<string, Job>();
  const controller = new AbortController();
  const tasks = new Set<Promise<unknown>>();
  let busy = false;
  let uploading = false;
  let closed = false;
  const router = Router();
  const ready = options.ready ?? (() => { qwenConfig(); });
  const track = <T>(task: Promise<T>) => { tasks.add(task); void task.finally(() => tasks.delete(task)).catch(() => {}); return task; };
  const timer = setInterval(() => {
    for (const [id, video] of videos) if (!video.scanId && video.expires < Date.now()) {
      videos.delete(id); track(rm(video.directory, { recursive: true, force: true })).catch(() => {});
    }
    for (const [id, job] of jobs) if (job.status !== 'processing' && job.expires < Date.now()) {
      jobs.delete(id);
      for (const [videoId, video] of videos) if (video.scanId === id) videos.delete(videoId);
    }
  }, 60_000);
  timer.unref();
  function get(scanId: string) {
    const job = jobs.get(scanId);
    if (!job) throw scanError('Scan not found or expired.', 404);
    const { expires: _, ...publicJob } = job;
    return publicJob;
  }
  function start(videoId: string) {
    if (closed) throw scanError('Scan service is shutting down.', 503);
    const video = videos.get(videoId);
    if (!video) throw scanError('Video not found or expired. Upload it again.', 404);
    if (video.scanId) return get(video.scanId);
    ready();
    if (busy) throw scanError('A scan is already running.', 409);
    busy = true;
    const job: Job = { scanId: randomUUID(), status: 'processing', expires: Date.now() + TTL };
    jobs.set(job.scanId, job); video.scanId = job.scanId;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60_000)]);
    track((async () => {
      try {
        const output = join(video.directory, 'prepared.mp4');
        await (options.prepare ?? prepareVideo)(video.path, output, signal);
        job.result = await (options.scan ?? scanWithQwen)(output, signal);
        job.status = 'completed';
      } catch (error) {
        job.status = 'failed';
        job.error = error instanceof Error && 'status' in error ? error.message : 'Video scan failed or timed out. Check video format, FFmpeg, OpenRouter and Hetzner configuration.';
      } finally {
        await rm(video.directory, { recursive: true, force: true }).catch(() => {});
        job.expires = Date.now() + TTL; busy = false;
      }
    })());
    return get(job.scanId);
  }
  // A raw video body avoids multipart buffering and needs no upload dependency.
  router.post('/videos', async (req, res) => {
    if (closed) throw scanError('Scan service is shutting down.', 503);
    if (!['video/mp4', 'video/quicktime', 'application/octet-stream'].includes(req.get('content-type')?.split(';')[0] ?? '')) throw scanError('Send MP4/MOV bytes with Content-Type video/mp4 or video/quicktime.', 415);
    if (uploading || busy || [...videos.values()].filter(v => !v.scanId).length >= 2) throw scanError('Upload capacity reached. Scan an uploaded video first.', 409);
    const limit = options.maxBytes ?? MAX_BYTES;
    if (Number(req.get('content-length')) > limit) throw scanError('Video exceeds the 512 MiB upload limit.', 413);
    uploading = true;
    const task = (async () => {
      let directory: string | undefined;
      try {
        directory = await mkdtemp(join(dataDir, 'scan-'));
        const path = join(directory, 'input.mov');
        let bytes = 0;
        const limiter = new Transform({ transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > limit ? scanError('Video exceeds the upload limit.', 413) : null, chunk);
        } });
        await pipeline(req, limiter, createWriteStream(path, { flags: 'wx', mode: 0o600 }), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60_000)]) });
        if (!(await stat(path)).size) throw scanError('Video is empty.');
        const videoId = randomUUID();
        videos.set(videoId, { directory, path, expires: Date.now() + TTL });
        res.status(201).json({ videoId });
      } catch (error) {
        if (directory) await rm(directory, { recursive: true, force: true });
        throw error;
      } finally { uploading = false; }
    })();
    await track(task);
  });
  router.post('/initial-scans', (req, res) => {
    if (typeof req.body?.videoId !== 'string') throw scanError('Provide videoId.');
    res.status(202).json(start(req.body.videoId));
  });
  router.get('/initial-scans/:id', (req, res) => res.json(get(req.params.id)));
  router.get('/initial-scans/:id/result', (req, res) => {
    const job = get(req.params.id);
    if (job.status !== 'completed') throw scanError(job.error ?? 'Scan is still processing.', 409);
    res.json(job.result);
  });
  router.use((error: Error & { status?: number }, _req: import('express').Request, res: import('express').Response, _next: import('express').NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.status ? error.message : 'Video upload or scan failed.' });
  });
  async function close() {
    closed = true; clearInterval(timer); controller.abort();
    await Promise.allSettled([...tasks]);
    await Promise.all([...videos.values()].map(v => rm(v.directory, { recursive: true, force: true })));
    videos.clear(); jobs.clear();
  }
  return { router, start, get, close };
}
