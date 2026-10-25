import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFocus } from './focus.ts';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'focus-test-'));
  let auto = 1, value = 128;
  const calls: string[] = [];
  let failManual = false;
  const run = async (args: string[]) => {
    const command = args[0]; calls.push(command);
    if (command === '--list-ctrls') return `focus_absolute 0x009a090a (int) : min=0 max=255 step=1 default=0 value=${value}\nfocus_automatic_continuous 0x009a090c (bool) : default=1 value=${auto}`;
    if (command.startsWith('--set-ctrl=focus_automatic_continuous=')) auto = Number(command.split('=').at(-1));
    else {
      assert.equal(auto, 0, 'autofocus must be disabled before writing manual focus');
      if (failManual) throw new Error('Camera disconnected');
      value = Number(command.split('=').at(-1));
    }
    return '';
  };
  return { dir, calls, run, focus: createFocus(dir, '/dev/video0', true, run), fail: () => { failManual = true; }, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
test('manual focus is applied in order, persisted and restored by a new controller', async () => {
  const f = await fixture();
  try {
    await f.focus.restore(); assert.equal(f.calls.length, 0, 'unsaved settings leave hardware alone');
    assert.equal((await f.focus.update({ mode: 'manual', value: 73 })).value, 73);
    assert.deepEqual(JSON.parse(await readFile(join(f.dir, 'camera-focus.json'), 'utf8')), { mode: 'manual', value: 73 });
    await f.run(['--set-ctrl=focus_automatic_continuous=1']);
    const restarted = createFocus(f.dir, '/dev/video0', true, f.run);
    await restarted.restore();
    assert.equal((await restarted.read()).mode, 'manual');
    await restarted.update({ mode: 'auto', value: 73 });
    await restarted.restore();
    assert.equal((await restarted.read()).mode, 'auto');
  } finally { await f.cleanup(); }
});
test('invalid values never write controls; failed updates preserve saved settings and restore auto mode', async () => {
  const f = await fixture();
  try {
    for (const setting of [null, {}, { mode: 'bad', value: 1 }, { mode: 'manual', value: 256 }, { mode: 'manual', value: 1.5 }, { mode: 'manual', value: '23' }]) {
      await assert.rejects(f.focus.update(setting));
    }
    assert.ok(f.calls.every(call => call === '--list-ctrls'));
    await f.focus.update({ mode: 'auto', value: 128 });
    f.fail();
    await assert.rejects(f.focus.update({ mode: 'manual', value: 20 }), /disconnected/);
    assert.equal((await f.focus.read()).mode, 'auto');
    assert.equal(JSON.parse(await readFile(join(f.dir, 'camera-focus.json'), 'utf8')).mode, 'auto');
  } finally { await f.cleanup(); }
});
test('unsupported cameras and non-USB modes report unavailable', async () => {
  await assert.rejects(createFocus('/tmp', '/dev/video0', false).read(), /USB/);
  await assert.rejects(createFocus('/tmp', '/dev/video0', true, async () => '').read(), /does not expose/);
});
