import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeDoorVideoUrl, doorEventsSchema, toMovements } from './door-ai.ts';

test('door observation receives only product titles and returns product/action pairs', async () => {
  const inventory = [{ id: 'cola', name: 'Cola', quantity: 2, createdAt: 'today', notes: '330 ml cans' }];
  const expected = { events: [{ product: 'Potatoes', action: 'removed' as const }, { product: 'Cola', action: 'removed' as const }] };
  const request: typeof fetch = async (_url, options) => {
    const body = JSON.parse(options!.body as string);
    assert.match(body.messages[0].content, /untrusted data/);
    assert.equal(body.messages[1].content[0].video_url.url, 'https://example.test/clip.mp4');
    assert.deepEqual(JSON.parse(body.messages[1].content[1].text).knownInventory, ['Cola']);
    assert.doesNotMatch(JSON.stringify(body.messages), /330 ml cans|createdAt/);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(expected) } }] });
  };
  assert.deepEqual(await observeDoorVideoUrl('https://example.test/clip.mp4', inventory, new AbortController().signal, request, 'test-key'), expected);
});

test('door events reject extra fields and preserve downstream movement compatibility', () => {
  assert.deepEqual(doorEventsSchema.parse({ events: [] }), { events: [] });
  for (const event of [
    { product: 'Milk', action: 'uncertain' },
    { product: 'Milk', action: 'added', notes: 'extra' },
    { product: '', action: 'added' },
  ]) assert.equal(doorEventsSchema.safeParse({ events: [event] }).success, false);
  assert.deepEqual(toMovements({ events: [{ product: 'Milk', action: 'removed' }] }), {
    movements: [{ name: 'Milk', direction: 'removed', quantity: 1, evidence: 'Video-reported removed: Milk' }], uncertainties: [],
  });
});
