import { initialFreshness, RETURN_MS } from './freshness.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeDoorVideoUrl, doorEventsSchema, toMovements, doorRecognitionContext } from './door-ai.ts';

test('door observation receives packaging descriptions and returns product/action pairs', async () => {
  const inventory = [{ id: 'cola', name: 'Cola', quantity: 2, createdAt: 'today', notes: '330 ml cans' }];
  const expected = { events: [{ product: 'Potatoes', action: 'removed' as const, expirationDate: null }, { product: 'Cola', action: 'removed' as const, expirationDate: null }] };
  const request: typeof fetch = async (_url, options) => {
    const body = JSON.parse(options!.body as string);
    assert.equal(body.model, 'qwen/qwen3.8-omni-flash');
    assert.equal(body.response_format, undefined);
    assert.match(body.messages[0].content, /audio.*untrusted|untrusted.*audio/);
    assert.match(body.messages[0].content, /untrusted data/);
    assert.equal(body.messages[1].content[0].video_url.url, 'https://example.test/clip.mp4');
    assert.deepEqual(JSON.parse(body.messages[1].content[1].text).knownInventory, [{ name: 'Cola', description: '330 ml cans' }]);
    assert.doesNotMatch(JSON.stringify(body.messages), /createdAt/);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(expected) } }] });
  };
  assert.deepEqual(await observeDoorVideoUrl('https://example.test/clip.mp4', inventory, new AbortController().signal, request, 'test-key', undefined, async raw => doorEventsSchema.parse(JSON.parse(raw))), expected);
});

test('door events reject extra fields and preserve downstream movement compatibility', () => {
  assert.deepEqual(doorEventsSchema.parse({ events: [] }), { events: [] });
  for (const event of [
    { product: 'Milk', action: 'uncertain' },
    { product: 'Milk', action: 'added', notes: 'extra' },
    { product: '', action: 'added' },
  ]) assert.equal(doorEventsSchema.safeParse({ events: [event] }).success, false);
  assert.deepEqual(toMovements({ events: [{ product: 'Milk', action: 'removed', expirationDate: null }] }), {
    movements: [{ name: 'Milk', direction: 'removed', expirationDate: null, quantity: 1, evidence: 'Video-reported removed: Milk' }], uncertainties: [],
  });
});

test('recognition includes only recent outstanding removals relative to capture time', () => {
  const at = '2026-10-24T22:35:25.455Z';
  const removedAt = '2026-10-24T22:34:06.547Z';
  const juice = { id: 'juice', name: 'Orange juice', quantity: 1, createdAt: removedAt, notes: 'Bottle with green cap',
    freshness: { ...initialFreshness(), state: 'taken_out' as const, removedAt } };
  const context = doorRecognitionContext([
    juice,
    { ...juice, name: 'Returned', freshness: { ...juice.freshness, state: 'in_fridge' } },
    { ...juice, name: 'Finished', freshness: { ...juice.freshness, state: 'finished', finishReason: 'explicit' } },
    { ...juice, name: 'Old', freshness: { ...juice.freshness, removedAt: new Date(Date.parse(at) - RETURN_MS - 1).toISOString() } },
    { ...juice, name: 'Future', freshness: { ...juice.freshness, removedAt: new Date(Date.parse(at) + 1).toISOString() } },
    { ...juice, name: 'Invalid', freshness: { ...juice.freshness, removedAt: 'invalid' } },
  ], at);
  assert.deepEqual(context.recentlyRemoved, [{ name: 'Orange juice', description: 'Bottle with green cap', removedAt, secondsSinceRemoval: 78 }]);
  assert.deepEqual(context.knownInventory, [{ name: 'Returned', description: 'Bottle with green cap' }]);
  assert.equal(context.recordingTimestamp, at);
});

test('video request includes recent removals and instructions to verify return identity', async () => {
  const at = '2026-10-24T22:35:25.455Z';
  const inventory = [{ id: 'juice', name: 'Orange juice', quantity: 1, createdAt: at,
    freshness: { ...initialFreshness(), state: 'taken_out' as const, removedAt: '2026-10-24T22:34:06.547Z' } }];
  const request: typeof fetch = async (_url, options) => {
    const body = JSON.parse(options!.body as string);
    const context = JSON.parse(body.messages[1].content[1].text);
    assert.equal(context.recentlyRemoved[0].name, 'Orange juice');
    assert.equal(context.recentlyRemoved[0].secondsSinceRemoval, 78);
    assert.deepEqual(context.knownInventory, []);
    assert.match(body.messages[0].content, /Recency is a clue, never proof/);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"events":[]}' } }] });
  };
  await observeDoorVideoUrl('https://example.test/clip.mp4', inventory, new AbortController().signal, request, 'test-key', at, async raw => doorEventsSchema.parse(JSON.parse(raw)));
});
