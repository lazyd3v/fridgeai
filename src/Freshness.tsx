import { useState } from 'react';
import type { Freshness as Details } from '../server/freshness';
export type Package = { id: string; name: string; quantity: number; freshness?: Details };
export function Freshness({ item, refresh }: { item: Package; refresh: () => void }) {
  const f = item.freshness;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function correct(patch: object) {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/items/${item.id}/freshness`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      if (!response.ok) throw new Error((await response.json()).error);
      refresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  if (!f) return null;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const days = f.expirationDate ? (Date.parse(f.expirationDate) - Date.parse(today)) / 86400000 : null;
  return <details className="freshness-details">
    <summary>{f.expirationDate ? `${f.dateSource === 'supplied' ? 'Date' : f.dateSource === 'provisional' ? 'Provisional use by' : 'Estimated use by'} ${f.expirationDate}${days !== null && days < 0 ? ' · Date passed' : days !== null && days <= 2 ? ' · Use soon' : ''}` : f.needsEstimate ? 'Freshness estimate pending' : 'Freshness unknown'}</summary>
    {f.originalText && <p>Recorded: {f.originalText}</p>}
    {f.possiblyOpened && <p>Possibly opened during use{f.openedAt ? ` · ${f.openedAt.slice(0, 10)}` : ''}.</p>}
    {f.conflict && <p>Different date reported: {f.conflict}. Existing date retained.</p>}
    {f.legacy && <p>Age before tracking is unknown.</p>}
    {f.candidates.length > 0 && <p>Package identity is uncertain; the earliest candidate date is shown.</p>}
    <p>Estimates are planning guidance, not a guarantee of food safety.</p>
    <label>Correct date <input type="date" disabled={busy} defaultValue={f.expirationDate ?? ''} onChange={e => { if (e.target.value) void correct({ expirationDate: e.target.value }); }}/></label>
    <label>Opened on <input type="date" disabled={busy} defaultValue={f.openedAt?.slice(0, 10) ?? ''} onChange={e => { if (e.target.value) void correct({ openedAt: e.target.value }); }}/></label>
    <div className="freshness-actions">
      <button type="button" disabled={busy} onClick={() => void correct({ newPackage: true })}>New package</button>
      {f.state !== 'finished' && <button type="button" disabled={busy} onClick={() => void correct({ state: 'finished' })}>Finished</button>}
      {f.state !== 'in_fridge' && <button type="button" disabled={busy} onClick={() => void correct({ state: 'in_fridge' })}>Put back</button>}
    </div>
    {f.candidates.map(id => <button type="button" disabled={busy} key={id} onClick={() => void correct({ returnId: id })}>Returning package {id.slice(0, 8)}</button>)}
    {error && <p role="alert">{error}</p>}
  </details>;
}
