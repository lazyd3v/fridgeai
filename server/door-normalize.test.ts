import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDoorObservation } from './door-normalize.ts';
import { observeDoorVideoUrl } from './door-ai.ts';
const signal = () => new AbortController().signal;
const event = { product: 'Cheese', action: 'added', expirationDate: 'July 2027' };
function response(value: unknown, status = 'completed'): typeof fetch {
  return async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(options!.body as string);
    assert.equal(body.model, 'gpt-6-luna'); assert.equal(body.store, false);
    assert.equal(body.text.format.strict, true); assert.equal(body.text.format.type, 'json_schema');
    return Response.json({ status, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
  };
}
test('normalizer wraps bare arrays and preserves date wording and duplicate movements', async () => {
  const events = [event, { ...event, action: 'removed' }, event];
  assert.deepEqual(await normalizeDoorObservation(JSON.stringify(events), signal(), response({ events, error: null }), 'test'), { events });
  assert.deepEqual(await normalizeDoorObservation('```json\n'+JSON.stringify({ events })+'\n```', signal(), response({ events, error: null }), 'test'), { events });
});
test('normalizer fills missing dates with null and accepts explicit empty lists', async () => {
  const events = [{ product: 'Bananas', action: 'added', expirationDate: null }];
  assert.deepEqual(await normalizeDoorObservation('[{"product":"Bananas","action":"added"}]', signal(), response({ events, error: null }), 'test'), { events });
  assert.deepEqual(await normalizeDoorObservation('[]', signal(), response({ events: [], error: null }), 'test'), { events: [] });
});
test('normalizer rejects hallucinations, date arithmetic, dropping events, and invalid directions', async () => {
  for (const events of [[], [{ ...event, product: 'Milk' }], [{ ...event, expirationDate: '2027-07-31' }]]) {
    await assert.rejects(normalizeDoorObservation(JSON.stringify([event]), signal(), response({ events, error: null }), 'test'), /changed/);
  }
  await assert.rejects(normalizeDoorObservation('[{"product":"Milk","action":"uncertain"}]', signal(), response({ events: [], error: null }), 'test'), /unsupported/);
});
test('normalizer rejects refusals, incomplete responses, provider errors, and conversion uncertainty', async () => {
  await assert.rejects(normalizeDoorObservation('unclear', signal(), response({ events: [], error: 'Unknown direction' }), 'test'), /without guessing/);
  await assert.rejects(normalizeDoorObservation('[]', signal(), response({}, 'incomplete'), 'test'), /incomplete/);
  await assert.rejects(normalizeDoorObservation('[]', signal(), async()=>Response.json({ status:'completed', output:[{content:[{type:'refusal',refusal:'No'}]}]}), 'test'), /invalid structured/);
  await assert.rejects(normalizeDoorObservation('[]', signal(), async()=>new Response('private provider error',{status:500}), 'test'), /HTTP 500/);
});
test('door pipeline forwards raw Qwen array to formatter before inventory reconciliation', async () => {
  const raw = JSON.stringify([event]); let normalized = false;
  const result = await observeDoorVideoUrl('https://example.test/video.mp4', [], signal(), async()=>Response.json({choices:[{finish_reason:'stop',message:{content:raw}}]}), 'qwen-test', undefined, async text => {
    assert.equal(text, raw); normalized = true;
    return normalizeDoorObservation(text, signal(), response({events:[event],error:null}), 'openai-test');
  });
  assert.equal(normalized,true); assert.deepEqual(result,{events:[event]});
});
