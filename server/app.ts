import express from 'express';
import { createVoice } from './voice.ts';
import { createFridgeMcpRouter } from './mcp.ts';
import { createChat } from './chat.ts';
import { createDictation } from './dictation.ts';
import { availableIcons, createIconSelector } from './icons.ts';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createStore } from './store.ts';
import { captureImage, type CameraConfig } from './camera.ts';
import { CameraStream } from './stream.ts';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DoorSensor, type DoorConfig } from './door.ts';
import { createAgentLoop } from './agent.ts';
import { createScans } from './scans.ts';
import { startMediaCleanup } from './media.ts';
import { WebcamAudio } from './microphone.ts';
import { encodeRecording, createRecordings } from './recordings.ts';
import { createDebugRecorder } from './debug.ts';

export function createApp(dataDir: string, camera: CameraConfig, doorConfig?: DoorConfig, selectIcon = createIconSelector(availableIcons())) {
  mkdirSync(dataDir, { recursive: true });
  const store = createStore(join(dataDir, 'fridge.sqlite'));
  const addItem = async (name: string, quantity: number, notes: string | null = null, source = 'manual') => store.addItem(name, quantity, notes, await selectIcon(name, notes), source);
  const app = express();
  const stream = camera.mode === 'usb' ? new CameraStream(camera) : null;
  if (doorConfig?.enabled && !stream) throw new Error('Door sensor requires USB camera mode.');
  const audio = stream ? new WebcamAudio(camera.device, camera.audioDevice) : undefined;
  const encode = (path: string, fps: number) => encodeRecording(path, fps, audio);
  const recordings = createRecordings(dataDir, store, camera.fps ?? 10, { encode });
  stream?.onFrame(recordings.frame);
  stream?.onFault(recordings.fault);
  const door = new DoorSensor(doorConfig ?? { enabled: false, chip: 'gpiochip0', line: 17, closedLevel: 0, debounceMs: 250 }, open => { recordings.setDoor(open); stream?.setDoor(open); });
  const debug = createDebugRecorder(dataDir, stream, camera.fps ?? 10, { encode });
  door.start();
  const getStatus = () => ({ cameraMode: camera.mode, recognitionEnabled: !!doorConfig?.enabled, recordings: recordings.status(), stream: stream?.status() ?? null, door: door.status() });
  const scans = createScans(dataDir);
  const stopMediaCleanup = startMediaCleanup();
  const fridgeTools: import('./agent.ts').FridgeTools = { getInventory: store.listItems, getStatus, updateItem: store.updateItem, removeItem: id => store.removeItem(id, 'agent'), addItem: (name, quantity, notes) => addItem(name, quantity, notes, 'agent'), scanInitialInventory: scans.start, getInitialScan: scans.get };
  const runAgent = createAgentLoop(fridgeTools);
  const chat = createChat(join(dataDir, 'chat.sqlite'), runAgent);
  app.use('/api', createDictation());
  app.use(express.json({ limit: '512kb' }));
  app.use('/mcp', createFridgeMcpRouter(store.listItems));
  app.use('/api', chat.router);
  const voice = createVoice(fridgeTools, chat.beginVoice);
  app.use('/api/voice', voice.router);
  app.use('/api', scans.router);
  app.use('/api', recordings.router);
  app.use('/api/debug/recording', debug.router);
  app.get('/api/inventory-log', (_req, res) => res.json(store.listLog()));
  app.get('/api/status', (_req, res) => res.json(getStatus()));
  app.post('/api/agent/run', async (req, res) => {
    const prompt = req.body?.prompt;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) {
      res.status(400).json({ error: 'Provide a prompt containing 1–4000 characters.' }); return;
    }
    try { const { history: _history, ...result } = await runAgent(prompt.trim()); res.json(result); }
    catch (error) {
      const failure = error as Error & { status?: number; toolCalls?: string[] };
      res.status(failure.status ?? 500).json({ error: failure.message, toolCalls: failure.toolCalls ?? [] });
    }
  });
  app.get('/api/camera/stream', (_req, res) => {
    if (!stream) { res.status(409).json({ error: 'Live streaming requires USB camera mode.' }); return; }
    stream.attach(res);
  });
  app.get('/api/items', (_req, res) => res.json(store.listItems()));
  app.post('/api/items', async (req, res) => {
    const { name, quantity = 1, notes = null } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100 || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      res.status(400).json({ error: 'Enter an item name (1–100 characters) and a quantity from 1 to 999.' });
      return;
    }
    if (notes !== null && (typeof notes !== 'string' || notes.length > 2000)) {
      res.status(400).json({ error: 'Notes must be text up to 2000 characters.' }); return;
    }
    res.status(201).json(await addItem(name.trim(), quantity, notes?.trim() || null));
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
  const stopCamera = () => { door.close(); debug.stop('Service stopped during recording.'); recordings.setDoor(null); stream?.setDoor(false); };
  return { app, stopCamera, close: async () => { stopCamera(); await voice.close(); await debug.close(); await recordings.close(); await scans.close(); await stopMediaCleanup(); chat.close(); store.close(); } };
}
