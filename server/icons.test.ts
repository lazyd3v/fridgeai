import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { availableIcons, createIconSelector } from './icons.ts';

test('catalog contains only available, safe PNG filenames', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'food-icons-'));
  try {
    await writeFile(join(directory, 'pineapple.png'), 'fixture');
    await writeFile(join(directory, 'LICENSE.txt'), 'fixture');
    await writeFile(join(directory, 'espresso.png'), 'fixture');
    await writeFile(join(directory, 'grilled_chicken_wings.png'), 'fixture');
    await writeFile(join(directory, 'unsafe name.png'), 'fixture');
    await mkdir(join(directory, 'apple.png'));
    assert.deepEqual(availableIcons(directory), ['pineapple']);
    assert.deepEqual(availableIcons(join(directory, 'missing')), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Decisions receives title, notes and catalog and returns a validated icon', async () => {
  const select = createIconSelector(['apple', 'pineapple'], { apiKey: 'test', fetch: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/decisions');
    const body = JSON.parse(init!.body as string);
    assert.equal(body.model, 'gpt-6-luna');
    assert.deepEqual(JSON.parse(body.input), { title: 'Slices', notes: 'Pineapple in juice' });
    assert.deepEqual(body.questions[0].choices.map((c: { value: string }) => c.value), ['apple', 'pineapple', 'none']);
    assert.ok(init?.signal);
    return Response.json({ answers: [{ name: 'food_icon', type: 'choice', choice: 'pineapple' }] });
  } });
  assert.equal(await select('Slices', 'Pineapple in juice'), 'pineapple');
});

test('refusals, malformed answers, unavailable icons and errors fall back safely', async () => {
  for (const body of [null, {}, { answers: {} }, { answers: [null] }, ...[
    { type: 'refusal' }, { type: 'choice', choice: '../apple' },
    { type: 'choice', choice: 'pineapple' }, { type: 'choice', choice: 'none' },
  ].map(answer => ({ answers: [{ name: 'food_icon', ...answer }] }))]) {
    const select = createIconSelector(['apple'], { apiKey: 'test', fetch: async () => Response.json(body) });
    assert.equal(await select('Pineapple slices', null), 'none');
  }
  for (const request of [async () => new Response('', { status: 429 }), async () => { throw new DOMException('Timed out', 'TimeoutError'); }]) {
    assert.equal(await createIconSelector(['apple'], { apiKey: 'test', fetch: request })('Pineapple', null), 'none');
  }
  const neverFetch: typeof fetch = async () => { assert.fail('must not call API'); };
  assert.equal(await createIconSelector([], { apiKey: 'test', fetch: neverFetch })('Milk', null), 'none');
  assert.equal(await createIconSelector(['apple'], { apiKey: '', fetch: neverFetch })('Milk', null), 'none');
});

test('all 400 icons participate without exceeding the 255-choice API limit', async () => {
  const icons = Array.from({ length: 400 }, (_, i) => `food_${i}`);
  let calls = 0;
  const select = createIconSelector(icons, { apiKey: 'test', fetch: async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    calls++;
    for (const question of body.questions) assert.ok(question.choices.length <= 255);
    if (calls === 1) {
      assert.deepEqual(body.questions.flatMap((q: { choices: { value: string }[] }) => q.choices.map(c => c.value).filter(v => v !== 'none')), icons);
      return Response.json({ answers: [
        { name: 'food_icon_0', type: 'choice', choice: 'food_10' },
        { name: 'food_icon_1', type: 'choice', choice: 'food_399' },
      ] });
    }
    assert.deepEqual(body.questions[0].choices.map((c: { value: string }) => c.value), ['food_10', 'food_399', 'none']);
    return Response.json({ answers: [{ name: 'food_icon', type: 'choice', choice: 'food_399' }] });
  } });
  assert.equal(await select('Example', null), 'food_399');
  assert.equal(calls, 2);
});
