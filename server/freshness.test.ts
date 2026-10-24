import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.ts';
import { deterministicMatch, initialFreshness, localDate, processFreshnessRecording, resolveProduct, validDate, type Resolver } from './freshness.ts';
const signal = () => new AbortController().signal;
const forbidden: Resolver = async () => { throw new Error('Unexpected model call'); };
const estimate: Resolver = async input => ({ resolution: input.fixedMatch?.resolution ?? 'new', productId: input.fixedMatch?.productId ?? null, product: input.observedProduct.product, expirationDate: '2026-11-01' });
function recording(store: ReturnType<typeof createStore>, id: string) { store.createRecording(id, '/test.mp4'); store.setRecording(id, 'processing'); }

test('date validation and recording local date handle timezone and invalid calendar dates', () => {
  assert.equal(validDate('2026-02-30'), false);
  assert.equal(validDate('2028-02-29'), true);
  assert.equal(localDate('2026-10-24T23:30:00Z'), '2026-10-25');
});
test('one package removal and return retain date; retries do not duplicate events', async () => {
  const store = createStore(':memory:');
  try {
    const item = store.addItem('Eggs', 1);
    store.correctFreshness(item.id, { expirationDate: '2026-11-01' });
    recording(store, 'one');
    const events = [{ name: ' eggs ', direction: 'removed' as const, quantity: 1 }, { name: 'EGGS', direction: 'added' as const, quantity: 1 }];
    await processFreshnessRecording(store, 'one', events, signal(), forbidden);
    assert.equal(store.listItems()[0].id, item.id);
    assert.equal(store.listItems()[0].freshness!.expirationDate, '2026-11-01');
    await processFreshnessRecording(store, 'one', events, signal(), forbidden);
    assert.equal(store.listPackages().length, 1);
    assert.equal(store.listLog().length, 4);
  } finally { store.close(); }
});
test('deadlines survive reopening and automatic completion retains history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'freshness-'));
  let store = createStore(join(dir, 'test.sqlite'));
  try {
    const item = store.addItem('Eggs', 1); recording(store, 'out');
    await processFreshnessRecording(store, 'out', [{ name: 'Eggs', direction: 'removed', quantity: 1 }], signal(), forbidden);
    const deadline = store.listPackages()[0].freshness!.deadline!;
    assert.equal(store.listItems().length, 0);
    store.close(); store = createStore(join(dir, 'test.sqlite'));
    store.expireTakenOut(deadline);
    const old = store.listPackages()[0];
    assert.equal(old.freshness!.finishReason, 'timeout');
    assert.equal(old.id, item.id);
    recording(store, 'back');
    await processFreshnessRecording(store, 'back', [{ name: 'Eggs', direction: 'added', quantity: 1 }], signal(), async () => ({ resolution: 'existing', productId: item.id, product: 'Eggs', expirationDate: null }));
    assert.equal(store.listItems()[0].id, item.id);
    store.removeItem(item.id);
    assert.equal(store.listPackages()[0].freshness!.finishReason, 'explicit');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('legacy batch splits one removed unit without losing the original age', async () => {
  const store = createStore(':memory:');
  try {
    const item = store.addItem('Milk', 3); store.correctFreshness(item.id, { expirationDate: '2026-10-30' });
    recording(store, 'split');
    await processFreshnessRecording(store, 'split', [{ name: 'Milk', direction: 'removed', quantity: 1 }], signal(), forbidden);
    assert.equal(store.listItems()[0].quantity, 2);
    const outside = store.listPackages().find(p => p.freshness!.state === 'taken_out')!;
    assert.equal(outside.quantity, 1); assert.equal(outside.createdAt, item.createdAt);
    assert.equal(outside.freshness!.expirationDate, '2026-10-30');
  } finally { store.close(); }
});
test('new products use one Luna call each and supplied absolute dates skip it', async () => {
  const store = createStore(':memory:'); let calls = 0;
  try {
    recording(store, 'new');
    await processFreshnessRecording(store, 'new', [{ name: 'Bananas', direction: 'added', quantity: 1 }, { name: 'Rice', direction: 'added', quantity: 1, expirationDate: '2026-10-29' }], signal(), async input => { calls++; return estimate(input, signal()); });
    assert.equal(calls, 1); assert.equal(store.listItems().length, 2);
    assert.equal(store.listItems().find(i => i.name === 'Rice')!.freshness!.dateSource, 'supplied');
  } finally { store.close(); }
});
test('fixed identities cannot change and provider failure does not block a new item', async () => {
  const r = await resolveProduct([], { product: 'Bananas', action: 'added', expirationDate: null }, '2026-10-24T12:00:00Z', signal(), forbidden);
  assert.equal(r.result.resolution, 'new'); assert.equal(r.freshness.needsEstimate, true);
  const invalid = await resolveProduct([], { product: 'Bananas', action: 'added', expirationDate: null }, '2026-10-24T12:00:00Z', signal(), async () => ({ resolution: 'existing', productId: 'fake', product: 'Bananas', expirationDate: '2026-10-30' }));
  assert.equal(invalid.result.resolution, 'new'); assert.equal(invalid.result.expirationDate, null);
});
test('relative wording uses recording anchor; returns cannot extend stored dates', async () => {
  const item = { id: 'one', name: 'Eggs', quantity: 1, createdAt: '2026-10-20T10:00:00Z', freshness: { ...initialFreshness(), state: 'taken_out' as const, deadline: '2026-10-24T15:00:00Z', removedAt: '2026-10-24T12:00:00Z', expirationDate: '2026-10-26' } };
  const result = await resolveProduct([item], { product: 'Eggs', action: 'added', expirationDate: '3 days from today' }, '2026-10-24T13:00:00Z', signal(), async input => {
    assert.equal(input.recordingDate, '2026-10-24');
    return { resolution: 'existing', productId: 'one', product: 'Eggs', expirationDate: '2026-10-27' };
  });
  assert.equal(result.freshness.expirationDate, '2026-10-26'); assert.match(result.freshness.conflict!, /2026-10-27/);
});
test('multiple identical packages remain ambiguous with a provisional earlier date', async () => {
  const items = ['2026-10-27', '2026-10-29'].map((date, i) => ({ id: `id-${i}`, name: 'Milk', quantity: 1, createdAt: '2026-10-24T12:00:00Z', freshness: { ...initialFreshness(), state: 'taken_out' as const, expirationDate: date, deadline: '2026-10-24T15:00:00Z' } }));
  const event = { product: 'Milk', action: 'added' as const, expirationDate: null };
  assert.equal(deterministicMatch(items, event, '2026-10-24T13:00:00Z'), null);
  const resolved = await resolveProduct(items, event, '2026-10-24T13:00:00Z', signal(), async () => ({ resolution: 'uncertain', productId: null, product: 'Milk', expirationDate: null }));
  assert.equal(resolved.freshness.expirationDate, '2026-10-27'); assert.equal(resolved.freshness.candidates.length, 2);
});

test('partial recording retries skip saved events and stale inventory cannot be applied', async () => {
  const store = createStore(':memory:');
  try {
    recording(store, 'retry');
    const events = [{ name: 'Eggs', direction: 'added' as const, quantity: 1, expirationDate: '2026-11-01' }, { name: 'Unknown', direction: 'removed' as const, quantity: 1 }];
    await assert.rejects(processFreshnessRecording(store, 'retry', events, signal(), forbidden));
    assert.equal(store.eventApplied('retry', 0), true);
    assert.equal(store.listItems().length, 1);
    const item = store.listItems()[0];
    await processFreshnessRecording(store, 'retry', events, signal(), async () => ({ resolution: 'existing', productId: item.id, product: 'Eggs', expirationDate: null }));
    assert.equal(store.listPackages().length, 1); assert.equal(store.listItems().length, 0);
    recording(store, 'race');
    const before = store.listPackages();
    const resolved = await resolveProduct(before, { product: 'Rice', action: 'added', expirationDate: null }, new Date().toISOString(), signal(), estimate, { resolution: 'new', productId: null });
    store.addItem('Apple', 1);
    assert.throws(() => store.applyProductEvent('race', 0, before, { product: 'Rice', action: 'added', expirationDate: null }, resolved, new Date().toISOString()), /Inventory changed/);
  } finally { store.close(); }
});
test('opening failures preserve the opening anchor for retry and never extend dates', async () => {
  const item = { id: 'cream', name: 'Sour cream', quantity: 1, createdAt: '2026-10-20T10:00:00Z', freshness: { ...initialFreshness(), needsEstimate: false, state: 'taken_out' as const, removedAt: '2026-10-24T12:00:00Z', deadline: '2026-10-24T15:00:00Z', expirationDate: '2026-10-30' } };
  const event = { product: 'Sour cream', action: 'added' as const, expirationDate: null };
  const failed = await resolveProduct([item], event, '2026-10-24T13:00:00Z', signal(), forbidden);
  assert.equal(failed.freshness.needsEstimate, true); assert.equal(failed.freshness.openedAt, item.freshness.removedAt);
  const retry = { ...item, freshness: { ...failed.freshness, state: 'in_fridge' as const } };
  let calls = 0;
  const corrected = await resolveProduct([retry], event, '2026-10-24T13:00:00Z', signal(), async () => { calls++; return { resolution: 'existing', productId: item.id, product: item.name, expirationDate: '2026-11-05' }; }, { resolution: 'existing', productId: item.id });
  assert.equal(calls, 1); assert.equal(corrected.freshness.expirationDate, '2026-10-30');
});

function returnedPackage(name = 'Sour cream') {
  return { id: 'return-package', name, quantity: 1, createdAt: '2026-10-20T10:00:00Z', freshness: {
    ...initialFreshness(), needsEstimate: false, state: 'taken_out' as const,
    removedAt: '2026-10-24T12:00:00Z', deadline: '2026-10-24T15:00:00Z', expirationDate: '2026-10-30',
  } };
}

test('unique late returns retain identity and date after timeout, even if the resolver attempts a new purchase', async () => {
  for (const timedOut of [false, true]) {
    const item = returnedPackage('Eggs');
    const previous = { ...item, freshness: { ...item.freshness,
      state: timedOut ? 'finished' as const : 'taken_out' as const,
      finishReason: timedOut ? 'timeout' as const : null,
      needsEstimate: true,
    } };
    const result = await resolveProduct([previous], { product: ' eggs ', action: 'added', expirationDate: null },
      '2026-10-24T16:00:00Z', signal(), async () => ({ resolution: 'new', productId: null, product: 'Eggs', expirationDate: '2026-11-14' }));
    assert.equal(result.result.resolution, 'existing');
    assert.equal(result.result.productId, item.id);
    assert.equal(result.freshness.expirationDate, '2026-10-30');
    assert.equal(result.freshness.needsEstimate, true);
  }
});

test('ambiguous late returns cannot become new packages with fresh dates', async () => {
  const items = ['2026-10-28', '2026-10-30'].map((date, i) => ({ ...returnedPackage('Eggs'), id: `eggs-${i}`,
    freshness: { ...returnedPackage('Eggs').freshness, state: 'finished' as const, finishReason: 'timeout' as const, expirationDate: date },
  }));
  const result = await resolveProduct(items, { product: 'Eggs', action: 'added', expirationDate: null },
    '2026-10-24T16:00:00Z', signal(), async () => ({ resolution: 'new', productId: null, product: 'Eggs', expirationDate: '2026-11-14' }));
  assert.equal(result.result.resolution, 'uncertain');
  assert.equal(result.freshness.expirationDate, '2026-10-28');
  assert.equal(result.freshness.dateSource, 'provisional');
  assert.deepEqual(result.freshness.candidates, ['eggs-0', 'eggs-1']);
});

test('explicit completion and expired return window still allow genuinely new packages', async () => {
  for (const finishReason of ['explicit', 'timeout'] as const) {
    const item = { ...returnedPackage('Eggs'), freshness: { ...returnedPackage('Eggs').freshness,
      state: 'finished' as const, finishReason,
    } };
    const at = finishReason === 'explicit' ? '2026-10-24T16:00:00Z' : '2026-11-02T16:00:00Z';
    const result = await resolveProduct([item], { product: 'Eggs', action: 'added', expirationDate: '2026-11-14' }, at, signal(), forbidden);
    assert.equal(result.result.resolution, 'new');
    assert.equal(result.freshness.expirationDate, '2026-11-14');
  }
});

test('confirmed opening dates stay confirmed for exact and semantic returns', async () => {
  for (const product of ['Sour cream', 'cream tub']) {
    const item = returnedPackage(); item.freshness.openedAt = '2026-10-23';
    item.freshness.needsEstimate = true;
    const result = await resolveProduct([item], { product, action: 'added', expirationDate: null },
      '2026-10-24T13:00:00Z', signal(), async () => ({ resolution: 'existing', productId: item.id, product: item.name, expirationDate: '2026-10-29' }));
    assert.equal(result.freshness.openedAt, '2026-10-23');
    assert.equal(result.freshness.possiblyOpened, false);
    assert.equal(result.freshness.expirationDate, '2026-10-29');
  }
});

test('semantic returns infer an opening anchor once and preserve it on later uses', async () => {
  const item = returnedPackage();
  const resolver: Resolver = async () => ({ resolution: 'existing', productId: item.id, product: item.name, expirationDate: '2026-10-29' });
  const first = await resolveProduct([item], { product: 'cream tub', action: 'added', expirationDate: null }, '2026-10-24T13:00:00Z', signal(), resolver);
  assert.equal(first.freshness.openedAt, item.freshness.removedAt);
  assert.equal(first.freshness.possiblyOpened, true);
  const next = { ...item, freshness: { ...first.freshness, removedAt: '2026-10-25T12:00:00Z', deadline: '2026-10-25T15:00:00Z' } };
  const second = await resolveProduct([next], { product: 'cream tub', action: 'added', expirationDate: null }, '2026-10-25T13:00:00Z', signal(), resolver);
  assert.equal(second.freshness.openedAt, item.freshness.removedAt);
  assert.equal(second.freshness.expirationDate, '2026-10-29');
});

test('a timed-out return is persisted on the original package without resetting age', async () => {
  const store = createStore(':memory:');
  try {
    const old = store.addItem('Eggs', 1);
    store.correctFreshness(old.id, { expirationDate: '2026-10-30' });
    recording(store, 'late-out');
    await processFreshnessRecording(store, 'late-out', [{ name: 'Eggs', direction: 'removed', quantity: 1 }], signal(), forbidden);
    const outside = store.listPackages()[0];
    store.expireTakenOut(outside.freshness!.deadline!);
    const at = new Date(Date.parse(outside.freshness!.deadline!) + 3600000).toISOString();
    recording(store, 'late-back');
    const snapshot = store.listPackages();
    const event = { product: 'Eggs', action: 'added' as const, expirationDate: null };
    const resolved = await resolveProduct(snapshot, event, at, signal(), forbidden);
    store.applyProductEvent('late-back', 0, snapshot, event, resolved, at);
    const returned = store.listItems()[0];
    assert.equal(returned.id, old.id);
    assert.equal(returned.createdAt, old.createdAt);
    assert.equal(returned.freshness!.expirationDate, '2026-10-30');
    assert.equal(store.listPackages().length, 1);
    assert.equal(returned.freshness!.finishReason, null);
  } finally { store.close(); }
});

test('new-package correction creates a new ID and preserves the original history', () => {
  const store = createStore(':memory:');
  try {
    const old = store.addItem('Milk', 1); store.correctFreshness(old.id, { expirationDate: '2026-10-28' });
    const replacement = store.correctFreshness(old.id, { newPackage: true });
    assert.notEqual(replacement.id, old.id);
    assert.equal(store.listItems().length, 1);
    assert.equal(store.listPackages().find(i => i.id === old.id)!.freshness!.expirationDate, '2026-10-28');
    assert.equal(replacement.freshness!.expirationDate, null);
  } finally { store.close(); }
});

test('a pre-existing failed recording does not block manual product date estimation', async () => {
  const { startFreshnessMaintenance } = await import('./freshness-worker.ts');
  const store = createStore(':memory:');
  let calls = 0;
  store.addItem('Bananas', 1);
  recording(store, 'old-failed'); store.setRecording('old-failed', 'failed');
  const stop = startFreshnessMaintenance(store, async input => { calls++; return estimate(input, signal()); });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(store.listItems()[0].freshness!.expirationDate, '2026-11-01');
  } finally { await stop(); store.close(); }
});
