import { useEffect, useRef, useState } from 'react';
import { FocusControls } from './FocusControls';
import { WebcamPreview } from './WebcamPreview';

type State = { available: boolean; status: 'idle' | 'recording' | 'uploading' | 'completed' | 'failed'; startedAt?: string; url?: string; expiresAt?: string; error?: string; canRetry?: boolean };
async function request(action = ''): Promise<State> {
  const response = await fetch(`/api/debug/recording${action ? `/${action}` : ''}`, { method: action ? 'POST' : 'GET', cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? 'Test recorder unavailable.');
  return body;
}
export function DebugPage() {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const field = useRef<HTMLTextAreaElement>(null);
  const changing = useRef(false);
  const revision = useRef(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!changing.current) {
        const current = revision.current;
        try { const next = await request(); if (!cancelled && current === revision.current) { setState(next); setConnectionError(''); } }
        catch (e) { if (!cancelled && current === revision.current) setConnectionError((e as Error).message); }
      }
      if (!cancelled) { setNow(Date.now()); timer = setTimeout(() => void poll(), 1000); }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);
  async function act(action: string) {
    revision.current++; changing.current = true; setBusy(true); setError(''); setCopied(false);
    try { setState(await request(action)); }
    catch (e) { setError((e as Error).message); }
    finally { changing.current = false; setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(state!.url!); setCopied(true); }
    catch { field.current?.focus(); field.current?.select(); setError('URL selected. Use your browser’s Copy command to copy it.'); }
  }
  const recording = state?.status === 'recording';
  const uploading = state?.status === 'uploading';
  const seconds = state?.startedAt ? Math.max(0, Math.floor((now - Date.parse(state.startedAt)) / 1000)) : 0;
  return <><WebcamPreview /><FocusControls /><section className="panel debug-panel">
    <div className="section-heading"><h2>Test video</h2><span className="badge" role="status">{recording ? `Recording · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : uploading ? 'Saving and uploading…' : state?.status === 'completed' ? 'Uploaded' : state?.status === 'failed' ? 'Failed' : state ? 'Ready' : 'Connecting…'}</span></div>
    <p>Start recording with the Pi camera, then press the same button to stop and upload the video to Hetzner.</p>
    <p className="muted">Test capture temporarily keeps the camera on, including when the door is closed. It stops automatically after five minutes. Leaving this page does not stop recording.</p>
    {state && !state.available && <p role="status">Connect the Pi USB camera to record a test video.</p>}
    <button className="primary" disabled={busy || !state?.available || uploading} onClick={() => void act(recording ? 'stop' : 'start')}>{busy ? 'Please wait…' : recording ? 'Stop recording & upload' : uploading ? 'Uploading…' : 'Start test recording'}</button>
    {state?.canRetry && <button className="secondary" disabled={busy} onClick={() => void act('retry')}>Retry upload</button>}
    {(error || connectionError || state?.error) && <p className="error" role="alert">{error || connectionError || state?.error}</p>}
    {state?.url && <div className="debug-result">
      <label htmlFor="test-video-url">Video URL</label>
      <textarea ref={field} id="test-video-url" rows={4} readOnly value={state.url} onFocus={e => e.target.select()} />
      <div className="debug-actions"><a className="secondary" href={state.url} target="_blank" rel="noreferrer">Open video</a><button className="secondary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy URL'}</button></div>
      <p className="muted">Available until approximately {new Date(state.expiresAt!).toLocaleString()}. Anyone with this signed link can view the video until it expires.</p>
    </div>}
  </section></>;
}
