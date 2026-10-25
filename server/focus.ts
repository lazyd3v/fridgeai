import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';

const exec = promisify(execFile);
type Setting = { mode: 'auto' | 'manual'; value: number };
type Focus = Setting & { min: number; max: number; step: number };
type Run = (args: string[]) => Promise<string>;

export function createFocus(dataDir: string, device: string, available: boolean, run: Run = async args =>
  (await exec('v4l2-ctl', ['-d', device, ...args], { timeout: 5000 })).stdout) {
  const path = join(dataDir, 'camera-focus.json');
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  }
  async function read(): Promise<Focus> {
    if (!available) throw new Error('Focus controls require a USB camera.');
    const output = await run(['--list-ctrls']);
    const absolute = output.match(/^\s*focus_absolute\s+.*min=(-?\d+) max=(-?\d+) step=(\d+).*value=(-?\d+)/m);
    const auto = output.match(/^\s*focus_automatic_continuous\s+.*value=(\d+)/m);
    if (!absolute || !auto) throw new Error('This camera does not expose manual focus controls.');
    return { mode: auto[1] === '1' ? 'auto' : 'manual', min: +absolute[1], max: +absolute[2], step: +absolute[3], value: +absolute[4] };
  }
  function validate(value: unknown, bounds: Focus): asserts value is Setting {
    const setting = value as Setting | null;
    if (!setting || !['auto', 'manual'].includes(setting.mode) || !Number.isInteger(setting.value) ||
      setting.value < bounds.min || setting.value > bounds.max || (setting.value - bounds.min) % bounds.step !== 0) {
      throw Object.assign(new Error(`Choose auto or manual and a focus value from ${bounds.min} to ${bounds.max} in steps of ${bounds.step}.`), { status: 400 });
    }
  }
  async function apply(setting: Setting) {
    await run([`--set-ctrl=focus_automatic_continuous=${setting.mode === 'auto' ? 1 : 0}`]);
    // The manual control becomes writable only after autofocus is disabled.
    if (setting.mode === 'manual') await run([`--set-ctrl=focus_absolute=${setting.value}`]);
  }
  const restore = () => serial(async () => {
    let saved: string;
    try { saved = await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const setting: unknown = JSON.parse(saved);
    validate(setting, await read());
    await apply(setting);
  });
  const update = (value: unknown) => serial(async () => {
    const previous = await read();
    validate(value, previous);
    const setting: Setting = { mode: value.mode, value: value.value };
    try {
      await apply(setting);
      const actual = await read();
      if (actual.mode !== setting.mode || (setting.mode === 'manual' && actual.value !== setting.value)) throw new Error('Camera did not accept the focus setting.');
      await writeFile(`${path}.tmp`, JSON.stringify(setting), { mode: 0o600 });
      await rename(`${path}.tmp`, path);
      return actual;
    } catch (error) {
      await apply(previous).catch(() => {});
      throw error;
    }
  });
  const router = Router();
  router.get('/', async (_req, res) => {
    try { res.json(await serial(read)); }
    catch (error) { res.status(503).json({ error: message(error) }); }
  });
  router.put('/', async (req, res) => {
    try { res.json(await update(req.body)); }
    catch (error) { res.status((error as { status?: number }).status ?? 503).json({ error: message(error) }); }
  });
  return { router, restore, update, read: () => serial(read) };
}
function message(error: unknown) {
  const text = (error as Error).message;
  return text.startsWith('Command failed:') || (error as NodeJS.ErrnoException).code === 'ENOENT'
    ? 'Could not access camera focus controls. Check the camera connection and v4l2-ctl installation.' : text;
}
