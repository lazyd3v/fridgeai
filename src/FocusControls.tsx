import { useEffect, useRef, useState } from 'react';

type Focus = { mode: 'auto' | 'manual'; value: number; min: number; max: number; step: number };
async function request(setting?: Focus): Promise<Focus> {
  const response = await fetch('/api/debug/focus', setting ? {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: setting.mode, value: setting.value }),
  } : { cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Focus controls unavailable.');
  return body;
}
export function FocusControls() {
  const [focus, setFocus] = useState<Focus | null>(null);
  const [value, setValue] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saving = useRef(false);
  async function load() {
    setBusy(true); setError('');
    try { const next = await request(); setFocus(next); setValue(next.value); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    void load();
    return () => clearTimeout(timer.current);
  }, []);
  async function save(next: Focus) {
    clearTimeout(timer.current);
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(''); setSaved(false);
    try { const actual = await request(next); setFocus(actual); setValue(actual.value); setSaved(true); }
    catch (e) {
      setError((e as Error).message);
      try { const actual = await request(); setFocus(actual); setValue(actual.value); } catch { /* Keep the failure visible. */ }
    } finally { saving.current = false; setBusy(false); }
  }
  return <section className="panel debug-panel focus-panel">
    <div className="section-heading"><h2>Camera focus</h2><button className="text-button" disabled={busy} onClick={() => { clearTimeout(timer.current); void load(); }}>Refresh controls</button></div>
    <p>Choose manual focus to keep the same objects sharp. Your setting is saved and restored when the camera starts.</p>
    {focus && <>
      <fieldset className="focus-mode" disabled={busy}>
        <legend>Focus mode</legend>
        {(['auto', 'manual'] as const).map(mode => <label key={mode}><input type="radio" name="focus-mode" value={mode} checked={focus.mode === mode} onChange={() => void save({ ...focus, mode, value })} />{mode === 'auto' ? 'Auto' : 'Manual'}</label>)}
      </fieldset>
      {focus.mode === 'manual' && <div className="focus-slider">
        <label htmlFor="camera-focus">Manual focus <output htmlFor="camera-focus">{value}</output></label>
        <input id="camera-focus" type="range" min={focus.min} max={focus.max} step={focus.step} value={value} disabled={busy} onChange={event => {
          const next = Number(event.target.value); setValue(next); setSaved(false); clearTimeout(timer.current);
          timer.current = setTimeout(() => void save({ ...focus, value: next }), 350);
        }} />
        <div className="focus-range muted"><span>{focus.min}</span><span>{focus.max}</span></div>
      </div>}
    </>}
    <p role="status" className="muted">{busy ? 'Updating focus…' : saved ? 'Focus saved.' : !focus && !error ? 'Loading focus controls…' : ''}</p>
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
