import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { CameraConfig } from './camera.ts';

// FFmpeg's image2pipe output may split JPEG markers across arbitrary chunks.
export class JpegFrames {
  private buffer = Buffer.alloc(0);
  push(chunk: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: Buffer[] = [];
    while (true) {
      const start = this.buffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) { this.buffer = this.buffer.subarray(-1); break; }
      if (start > 0) this.buffer = this.buffer.subarray(start);
      const end = this.buffer.indexOf(Buffer.from([0xff, 0xd9]), 2);
      if (end < 0) break;
      frames.push(this.buffer.subarray(0, end + 2));
      this.buffer = this.buffer.subarray(end + 2);
    }
    if (this.buffer.length > 8 * 1024 * 1024) throw new Error('Camera frame exceeded 8 MB.');
    return frames;
  }
}

export class CameraStream {
  private child?: ChildProcessWithoutNullStreams;
  private clients = new Set<Response>();
  private latest?: Buffer;
  private lastFrameAt = 0;
  private sessionId: string | null = null;
  private error: string | null = null;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  private waiters = new Set<(frame?: Buffer) => void>();
  private allowed = true;
  private sensorAllowed = true;
  private manual = false;
  private previews = new Set<symbol>();
  private doorOpen = false;
  private retiring?: ChildProcessWithoutNullStreams;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private frameListeners = new Set<(frame: Buffer) => void>();
  private faultListeners = new Set<() => void>();
  onFrame(listener: (frame: Buffer) => void) { this.frameListeners.add(listener); return () => { this.frameListeners.delete(listener); }; }
  onFault(listener: () => void) { this.faultListeners.add(listener); return () => { this.faultListeners.delete(listener); }; }
  private starting = false;
  private generation = 0;
  constructor(private config: CameraConfig, private beforeStart?: () => Promise<void>) {}

  status() { return { running: !!this.child, sessionId: this.sessionId, allowed: this.allowed, lastFrameAt: this.lastFrameAt || null, error: this.error, viewers: this.clients.size }; }

  setDoor(open: boolean | null) {
    this.sensorAllowed = open === true;
    this.allowed = this.sensorAllowed || this.manual || this.previews.size > 0;
    this.doorOpen = open === true;
    if (this.allowed) this.start();
    else this.close();
  }

  holdForTest() {
    if (this.manual) throw new Error('A test recording already owns the camera.');
    this.manual = true; this.allowed = true; this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true; this.manual = false; this.allowed = this.sensorAllowed || this.previews.size > 0;
      if (!this.allowed) this.close(); else this.idle();
    };
  }

  attachDebug(response: Response) {
    const token = Symbol();
    this.previews.add(token);
    this.allowed = true;
    response.once('close', () => {
      if (!this.previews.delete(token)) return;
      this.allowed = this.sensorAllowed || this.manual || this.previews.size > 0;
      if (!this.allowed) this.close(); else this.idle();
    });
    this.attach(response);
  }

  private start() {
    clearTimeout(this.idleTimer);
    if (!this.allowed || this.child || this.retiring || this.starting) return;
    if (this.beforeStart) {
      this.starting = true;
      const generation = this.generation;
      void this.beforeStart().then(() => {
        if (generation !== this.generation) return;
        this.starting = false;
        if (this.allowed) this.startCapture();
      }).catch(error => {
        if (generation !== this.generation) return;
        this.starting = false;
        this.fail(`Could not restore camera focus: ${(error as Error).message}`);
        if (this.doorOpen) this.retryTimer = setTimeout(() => this.start(), 3000);
      });
    } else this.startCapture();
  }

  private startCapture() {
    this.error = null;
    this.latest = undefined;
    this.lastFrameAt = 0;
    this.sessionId = randomUUID();
    const parser = new JpegFrames();
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'video4linux2',
      '-framerate', String(this.config.fps ?? 10), '-video_size', this.config.size ?? '640x480',
      ...(this.config.inputFormat ? ['-input_format', this.config.inputFormat] : []),
      '-i', this.config.device, '-an',
      ...(this.config.inputFormat === 'mjpeg' ? ['-c:v', 'copy'] : ['-c:v', 'mjpeg', '-q:v', '5', '-threads', '1']),
      '-f', 'image2pipe', 'pipe:1']);
    this.child = child;
    let diagnostics = '';
    const startedAt = Date.now();
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-2000); });
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child !== child || !this.allowed) return;
      try {
        for (const frame of parser.push(chunk)) {
          this.latest = frame; this.lastFrameAt = Date.now();
          for (const listener of this.frameListeners) listener(frame);
          for (const client of this.clients) this.writeFrame(client, frame);
          for (const waiter of [...this.waiters]) waiter(frame);
        }
      } catch (error) { this.fail((error as Error).message); }
    });
    child.on('error', error => { if (this.child === child) this.fail(error.message); });
    child.on('close', code => {
      if (this.child !== child) return;
      this.child = undefined;
      clearInterval(this.watchdog);
      if (this.manual || this.doorOpen || this.clients.size || this.waiters.size) {
        this.fail(diagnostics || `Camera stopped (${code}).`);
        if (this.doorOpen) this.retryTimer = setTimeout(() => this.start(), 3000);
      }
    });
    this.watchdog = setInterval(() => {
      if (Date.now() - (this.lastFrameAt || startedAt) > 15000) this.fail('No camera frames received for 15 seconds.');
    }, 3000);
  }

  private writeFrame(client: Response, frame: Buffer) {
    // Drop frames for slow viewers instead of building an unbounded queue.
    if (client.destroyed || client.writableLength > 256 * 1024) return;
    client.write(Buffer.concat([Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`), frame, Buffer.from('\r\n')]));
  }

  private fail(message: string) {
    this.error = message;
    for (const listener of this.faultListeners) listener();
    console.error('Camera stream:', message);
    for (const client of this.clients) client.end();
    this.clients.clear();
    for (const waiter of [...this.waiters]) waiter();
    this.stop();
  }

  private idle() {
    if (this.manual || this.doorOpen || this.clients.size || this.waiters.size) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), 5000);
  }

  attach(response: Response) {
    if (!this.allowed) { response.status(409).json({ error: 'Camera is off: door closed or sensor unavailable.' }); return; }
    response.set({ 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    response.flushHeaders();
    this.clients.add(response);
    response.on('close', () => { this.clients.delete(response); this.idle(); });
    this.start();
    if (this.latest) this.writeFrame(response, this.latest);
  }

  snapshot(): Promise<Buffer> {
    if (!this.allowed) return Promise.reject(new Error('Camera is off: door closed or sensor unavailable.'));
    this.start();
    if (this.latest && Date.now() - this.lastFrameAt < 2000) { this.idle(); return Promise.resolve(this.latest); }
    return new Promise((resolve, reject) => {
      const finish = (frame?: Buffer) => {
        clearTimeout(timeout); this.waiters.delete(finish); this.idle();
        if (frame) resolve(frame); else reject(new Error(this.error ?? 'Camera snapshot timed out.'));
      };
      const timeout = setTimeout(() => finish(), 16000);
      this.waiters.add(finish);
    });
  }

  stop() {
    this.generation++; this.starting = false;
    clearTimeout(this.idleTimer); clearTimeout(this.retryTimer); clearInterval(this.watchdog);
    const child = this.child;
    this.child = undefined; this.latest = undefined;
    if (child) {
      this.retiring = child;
      child.once('close', () => {
        if (this.retiring === child) this.retiring = undefined;
        if (this.allowed && (this.manual || this.doorOpen || this.clients.size || this.waiters.size)) {
          this.retryTimer = setTimeout(() => this.start(), this.error ? 3000 : 0);
        }
      });
    }
    child?.kill('SIGTERM');
    if (child) {
      const force = setTimeout(() => child.kill('SIGKILL'), 2000);
      force.unref(); child.once('close', () => clearTimeout(force));
    }
  }

  close() {
    this.allowed = false; this.doorOpen = false; this.manual = false;
    this.previews.clear();
    for (const client of this.clients) client.end();
    this.clients.clear();
    for (const waiter of [...this.waiters]) waiter();
    this.stop();
  }
}
