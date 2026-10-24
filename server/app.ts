import express from 'express';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createStore } from './store.ts';
import { captureImage, type CameraConfig } from './camera.ts';
import { CameraStream } from './stream.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DoorSensor, type DoorConfig } from './door.ts';

export function createApp(dataDir: string, camera: CameraConfig, doorConfig?: DoorConfig) {
  mkdirSync(dataDir, { recursive: true });
  const store = createStore(join(dataDir, 'fridge.sqlite'));
  const app = express();
  const stream = camera.mode === 'usb' ? new CameraStream(camera) : null;
  if (doorConfig?.enabled && !stream) throw new Error('Door sensor requires USB camera mode.');
  const door = new DoorSensor(doorConfig ?? { enabled: false, chip: 'gpiochip0', line: 17, closedLevel: 0, debounceMs: 250 }, open => stream?.setDoor(open));
  door.start();
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/status', (_req, res) => res.json({ cameraMode: camera.mode, recognitionEnabled: false, stream: stream?.status() ?? null, door: door.status() }));
  app.get('/api/camera/stream', (_req, res) => {
    if (!stream) { res.status(409).json({ error: 'Live streaming requires USB camera mode.' }); return; }
    stream.attach(res);
  });
  app.get('/api/items', (_req, res) => res.json(store.listItems()));
  app.post('/api/items', (req, res) => {
    const { name, quantity = 1 } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      res.status(400).json({ error: 'Enter an item name (1–100 characters) and a quantity from 1 to 999.' });
      return;
    }
    res.status(201).json(store.addItem(name.trim(), quantity));
  });
  app.delete('/api/items/:id', (req, res) => {
    if (!store.removeItem(req.params.id)) { res.status(404).json({ error: 'Item not found.' }); return; }
    res.status(204).end();
  });
  app.get('/api/captures/latest', (_req, res) => res.json(store.latestCapture()));
  let capturing = false;
  app.post('/api/captures', async (_req, res) => {
    if (stream && !stream.status().allowed) { res.status(409).json({ error: 'Camera is off: door closed or sensor unavailable.' }); return; }
    if (capturing) { res.status(409).json({ error: 'A capture is already in progress.' }); return; }
    capturing = true;
    try {
      let image;
      if (stream) {
        const frame = await stream.snapshot();
        const id = randomUUID();
        await mkdir(join(dataDir, 'captures'), { recursive: true });
        await writeFile(join(dataDir, 'captures', `${id}.jpg`), frame);
        image = { id, url: `/captures/${id}.jpg` };
      } else image = await captureImage(camera, join(dataDir, 'captures'));
      res.status(201).json(store.addCapture(image.id, image.url));
    } catch (error) {
      console.error('Camera capture failed:', error);
      res.status(503).json({ error: 'Could not capture an image. Check the camera configuration and server logs.' });
    } finally { capturing = false; }
  });
  app.use('/captures', express.static(join(dataDir, 'captures')));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route.' }));
  app.use(express.static(resolve('dist')));
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(error);
    res.status(error.status ?? 500).json({ error: error.status === 400 ? 'Invalid JSON request.' : 'Request failed.' });
  });
  const stopCamera = () => { door.close(); stream?.setDoor(false); };
  return { app, stopCamera, close: () => { stopCamera(); store.close(); } };
}
