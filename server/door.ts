import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export type DoorConfig = { enabled: boolean; chip: string; line: number; closedLevel: 0 | 1; debounceMs: number };
export type DoorStatus = { enabled: boolean; state: 'disabled' | 'unknown' | 'open' | 'closed' | 'error'; raw: number | null; error: string | null };

export function doorConfig(env: NodeJS.ProcessEnv): DoorConfig {
  const enabled = env.DOOR_SENSOR_ENABLED ?? 'false';
  const line = Number(env.DOOR_GPIO_LINE ?? 17);
  const closedLevel = Number(env.DOOR_CLOSED_LEVEL ?? 0);
  const debounceMs = Number(env.DOOR_DEBOUNCE_MS ?? 250);
  if (!['true', 'false'].includes(enabled) || !Number.isInteger(line) || line < 0 || ![0, 1].includes(closedLevel) || !Number.isFinite(debounceMs) || debounceMs < 0 || debounceMs > 5000) throw new Error('Invalid door sensor configuration.');
  return { enabled: enabled === 'true', chip: env.DOOR_GPIO_CHIP ?? 'gpiochip0', line, closedLevel: closedLevel as 0 | 1, debounceMs };
}

export async function readGpio(config: DoorConfig): Promise<0 | 1> {
  const { stdout } = await exec('gpioget', ['--chip', config.chip, '--bias', 'pull-up', '--hold-period', '10ms', '--numeric', String(config.line)], { timeout: 2000 });
  if (!/^[01]$/.test(stdout.trim())) throw new Error('Unexpected GPIO reading.');
  return Number(stdout.trim()) as 0 | 1;
}

export class DoorSensor {
  private value: DoorStatus;
  private candidate: number | null = null;
  private since = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(private config: DoorConfig, private onChange: (open: boolean | null) => void, private reader = readGpio) {
    this.value = { enabled: config.enabled, state: config.enabled ? 'unknown' : 'disabled', raw: null, error: null };
  }
  status() { return { ...this.value }; }
  sample(raw: 0 | 1, now = Date.now()) {
    this.value.raw = raw;
    if (this.candidate !== raw) { this.candidate = raw; this.since = now; }
    if (now - this.since < this.config.debounceMs) return;
    const state = raw === this.config.closedLevel ? 'closed' : 'open';
    if (this.value.state !== state) {
      this.value.state = state; this.value.error = null;
      this.onChange(state === 'open');
      console.log(`Door sensor: ${state} (GPIO ${this.config.line} = ${raw})`);
    }
  }
  fault(error: Error) {
    this.candidate = null;
    this.value = { enabled: true, state: 'error', raw: null, error: error.message };
    this.onChange(null);
  }
  start() {
    if (!this.config.enabled) return;
    this.onChange(null);
    const poll = async () => {
      try { const raw = await this.reader(this.config); if (!this.stopped) this.sample(raw); }
      catch (error) { if (!this.stopped) this.fault(error as Error); }
      if (!this.stopped) this.timer = setTimeout(poll, 100);
    };
    void poll();
  }
  close() { this.stopped = true; clearTimeout(this.timer); }
}
