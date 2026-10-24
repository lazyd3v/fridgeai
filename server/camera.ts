import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
export type CameraConfig = { mode: 'demo' | 'replay' | 'usb'; replayImage?: string; device: string; size?: string; fps?: number; inputFormat?: string };

export async function captureImage(config: CameraConfig, directory: string) {
  await mkdir(directory, { recursive: true });
  const id = randomUUID();
  let extension = '.jpg';
  if (config.mode === 'demo') extension = '.svg';
  if (config.mode === 'replay') {
    extension = extname(config.replayImage ?? '').toLowerCase();
    if (!['.jpg', '.jpeg', '.png'].includes(extension)) throw new Error('Set REPLAY_IMAGE to a JPEG or PNG file.');
  }
  const filename = `${id}${extension}`;
  const destination = join(directory, filename);
  if (config.mode === 'demo') {
    await copyFile(new URL('../fixtures/fridge.svg', import.meta.url), destination);
  } else if (config.mode === 'replay') {
    await copyFile(config.replayImage!, destination);
  } else {
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'video4linux2', '-i', config.device, '-frames:v', '1', '-y', destination], { timeout: 15000 });
  }
  return { id, url: `/captures/${filename}` };
}
