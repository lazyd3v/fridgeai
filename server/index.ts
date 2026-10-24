import { resolve } from 'node:path';
import { createApp } from './app.ts';
import type { CameraConfig } from './camera.ts';
import { doorConfig } from './door.ts';

const mode = process.env.CAMERA_MODE ?? 'demo';
if (!['demo', 'replay', 'usb'].includes(mode)) throw new Error('CAMERA_MODE must be demo, replay, or usb.');
const { app, close, stopCamera } = createApp(resolve(process.env.DATA_DIR ?? './data'), {
  mode: mode as CameraConfig['mode'], replayImage: process.env.REPLAY_IMAGE, device: process.env.CAMERA_DEVICE ?? '/dev/video0',
  size: process.env.CAMERA_SIZE ?? '640x480', fps: Number(process.env.CAMERA_FPS ?? 10), inputFormat: process.env.CAMERA_INPUT_FORMAT,
}, doorConfig(process.env));
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3001);
const server = app.listen(port, host, () => console.log(`Fridge API: http://${host}:${port} · camera: ${mode}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  stopCamera();
  server.close(() => { void close().then(() => process.exit(0)); });
});
