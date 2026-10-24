import { resolveProduct, type Resolver, resolveWithLuna } from './freshness.ts';
import type { Store } from './store.ts';

export function startFreshnessMaintenance(store: Store, resolver: Resolver = resolveWithLuna) {
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  const attempts = new Map<string, number>();
  const tick = () => {
    if (running || controller.signal.aborted) return;
    running = (async () => {
      store.expireTakenOut();
      for (const item of store.listItems()) {
        if (!item.freshness?.needsEstimate || item.freshness.candidates.length || (attempts.get(item.id) ?? 0) > Date.now()) continue;
        // Never estimate legacy inventory as newly purchased. No API calls while recording reconciliation is active.
        if (['queued', 'processing', 'recording'].includes(store.nextRecording()?.status ?? '')) break;
        attempts.set(item.id, Date.now() + 15 * 60_000);
        const event = { product: item.name, action: 'added' as const, expirationDate: item.freshness.originalText };
        const resolved = await resolveProduct([item], event, item.freshness.dateAnchor ?? item.createdAt, controller.signal, resolver, { resolution: 'existing', productId: item.id });
        controller.signal.throwIfAborted();
        store.saveEstimate(item, resolved.freshness);
      }
    })().catch(() => { /* Keep inventory available; retry later without logging provider bodies. */ }).finally(() => { running = undefined; });
  };
  tick();
  const timer = setInterval(tick, 15_000); timer.unref();
  return async () => { clearInterval(timer); controller.abort(); await running; };
}
