import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DoorSensor, doorConfig } from './door.ts';
import { CameraStream } from './stream.ts';

test('door contact debounces startup, opening, closing and bounce', () => {
  const changes: (boolean | null)[] = [];
  const sensor = new DoorSensor({ ...doorConfig({}), enabled: true }, value => changes.push(value));
  sensor.sample(0, 0); sensor.sample(0, 250);
  assert.deepEqual(changes, [false]);
  sensor.sample(1, 300); sensor.sample(0, 400); sensor.sample(1, 500);
  sensor.sample(1, 749);
  assert.deepEqual(changes, [false]);
  sensor.sample(1, 750);
  assert.deepEqual(changes, [false, true]);
  sensor.sample(0, 800); sensor.sample(0, 1050);
  assert.deepEqual(changes, [false, true, false]);
});

test('inverted contacts and GPIO errors default camera off and debounce recovery', () => {
  const changes: (boolean | null)[] = [];
  const sensor = new DoorSensor({ ...doorConfig({ DOOR_CLOSED_LEVEL: '1' }), enabled: true }, value => changes.push(value));
  sensor.sample(1, 0); sensor.sample(1, 250);
  assert.equal(sensor.status().state, 'closed');
  sensor.fault(new Error('GPIO missing'));
  assert.equal(changes.at(-1), null);
  assert.equal(sensor.status().state, 'error');
  sensor.sample(0, 300); sensor.sample(0, 549);
  assert.equal(sensor.status().state, 'error');
  sensor.sample(0, 550);
  assert.equal(sensor.status().state, 'open');
  assert.equal(sensor.status().error, null);
});

test('disabled sensor never reads hardware', async () => {
  const sensor = new DoorSensor(doorConfig({}), () => assert.fail(), async () => { assert.fail('GPIO read'); });
  sensor.start();
  assert.equal(sensor.status().state, 'disabled');
  sensor.close();
  assert.throws(() => doorConfig({ DOOR_CLOSED_LEVEL: '2' }));
});

test('closed and unknown door prevent snapshots and stream requests', async () => {
  const camera = new CameraStream({ mode: 'usb', device: '/not-a-camera' });
  for (const state of [false, null]) {
    camera.setDoor(state);
    assert.equal(camera.status().allowed, false);
    assert.equal(camera.status().running, false);
    await assert.rejects(camera.snapshot(), /Camera is off/);
    let status = 0;
    const response = { status(code: number) { status = code; return this; }, json() {} };
    camera.attach(response as never);
    assert.equal(status, 409);
  }
  camera.close();
});
