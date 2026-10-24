import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type AudioSource = { subscribe(data: (pcm: Buffer) => void, fault: () => void): () => void };

// Match the ALSA capture card to the camera's physical USB device, not card order.
export function webcamMicrophone(videoDevice: string, sys = '/sys') {
  let device = realpathSync(join(sys, 'class/video4linux', basename(realpathSync(videoDevice)), 'device'));
  while (!existsSync(join(device, 'idVendor'))) {
    const parent = dirname(device);
    if (parent === device) throw new Error('Cannot find the webcam USB device. Set CAMERA_AUDIO_DEVICE.');
    device = parent;
  }
  for (const card of readdirSync(join(sys, 'class/sound')).filter(name => /^card\d+$/.test(name))) {
    const sound = realpathSync(join(sys, 'class/sound', card, 'device'));
    if (sound.startsWith(`${device}/`)) {
      const id = readFileSync(join(sys, 'class/sound', card, 'id'), 'utf8').trim();
      return `plughw:CARD=${id},DEV=0`;
    }
  }
  throw new Error('Webcam microphone not found. Set CAMERA_AUDIO_DEVICE to its ALSA capture device.');
}

// A single ALSA reader serves overlapping door and Debug recordings.
export class WebcamAudio implements AudioSource {
  private child?: ChildProcessWithoutNullStreams;
  private retiring?: ChildProcessWithoutNullStreams;
  private listeners = new Set<{ data: (pcm: Buffer) => void; fault: () => void }>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(private videoDevice: string, private audioDevice?: string) {}
  subscribe(data: (pcm: Buffer) => void, fault: () => void) {
    if (!this.child && !this.retiring) this.start();
    const listener = { data, fault };
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stop();
    };
  }
  private start() {
    const device = this.audioDevice?.trim() || webcamMicrophone(this.videoDevice);
    const child = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
      '-f', 'alsa', '-i', device, '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1']);
    this.child = child;
    let lastData = Date.now();
    child.stderr.resume();
    const fail = () => {
      if (this.child !== child) return;
      const listeners = [...this.listeners]; this.listeners.clear(); this.stop();
      for (const listener of listeners) listener.fault();
    };
    child.stdout.on('data', (pcm: Buffer) => {
      lastData = Date.now();
      for (const listener of [...this.listeners]) listener.data(pcm);
    });
    child.once('error', fail); child.once('close', fail);
    this.timer = setInterval(() => { if (Date.now() - lastData > 5000) fail(); }, 1000);
  }
  private stop() {
    clearInterval(this.timer);
    const child = this.child; this.child = undefined;
    if (child) {
      this.retiring = child;
      child.once('close', () => {
        this.retiring = undefined;
        if (this.listeners.size) {
          try { this.start(); } catch {
            const listeners = [...this.listeners]; this.listeners.clear();
            for (const listener of listeners) listener.fault();
          }
        }
      });
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      timer.unref(); child.once('close', () => clearTimeout(timer));
    }
  }
}
