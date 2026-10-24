import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Item = { id: string; name: string; quantity: number };
type Capture = { id: string; url: string; createdAt: string };
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? undefined as T : response.json();
}

function App() {
  const [items, setItems] = useState<Item[]>([]);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [mode, setMode] = useState('connecting');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [live, setLive] = useState(true);
  const [streamKey, setStreamKey] = useState(0);
  const [streamState, setStreamState] = useState('Connecting to camera…');
  const [door, setDoor] = useState<{ enabled: boolean; state: string; raw: number | null }>({ enabled: false, state: 'disabled', raw: null });
  const [cameraAllowed, setCameraAllowed] = useState(true);
  async function load() {
    setError(''); setLoading(true);
    try {
      const [inventory, latest, status] = await Promise.all([api<Item[]>('/items'), api<Capture | null>('/captures/latest'), api<{ cameraMode: string }>('/status')]);
      setItems(inventory); setCapture(latest); setMode(status.cameraMode);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (mode !== 'usb') return;
    let cancelled = false;
    const check = async () => {
      try {
        const status = await api<{ stream: { allowed: boolean; lastFrameAt: number | null; error: string | null }; door: { enabled: boolean; state: string; raw: number | null } }>('/status');
        if (!cancelled) {
          setDoor(status.door); setCameraAllowed(status.stream?.allowed ?? true);
          setStreamState(status.stream?.error ? 'Camera unavailable — try reconnecting' : status.stream?.lastFrameAt && Date.now() - status.stream.lastFrameAt < 5000 ? 'Live from your webcam' : 'Waiting for camera frames…');
        }
      } catch { if (!cancelled) { setStreamState('Connection lost — try reconnecting'); setCameraAllowed(false); } }
    };
    void check();
    const timer = setInterval(() => void check(), 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [mode, live, streamKey]);
  async function takeSnapshot() {
    setCapturing(true); setError('');
    try { setCapture(await api<Capture>('/captures', { method: 'POST' })); }
    catch (e) { setError((e as Error).message); }
    finally { setCapturing(false); }
  }
  async function addItem(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const item = await api<Item>('/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, quantity: Number(quantity) }) });
      setItems(current => [item, ...current]); setName(''); setQuantity('1');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function removeItem(id: string) {
    setBusy(true); setError('');
    try { await api(`/items/${id}`, { method: 'DELETE' }); setItems(current => current.filter(item => item.id !== id)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <main>
    <header><a className="brand" href="/">▤ <span>fridge<span className="brand-dot">.</span></span></a><span className="home-label">YOUR LITTLE KITCHEN COMPANION</span></header>
    <section className="intro"><div className="eyebrow">A FRESH PERSPECTIVE</div><h1>Your kitchen,<br /><em>in view.</em></h1><p>A little less guessing. A little less waste.<br />Keep an eye on what’s inside.</p></section>
    {error && <div className="error" role="alert">{error} <button onClick={() => void load()}>Reconnect</button></div>}
    <div className="dashboard">
      <section className="camera card"><div className="section-heading"><h2>Inside the fridge</h2><span className="badge">{mode === 'demo' ? 'Demo camera' : mode === 'replay' ? 'Saved photo' : mode === 'usb' ? 'USB camera' : 'Connecting…'}</span></div>
        {mode === 'usb' && <p className="muted" role="status">{door.enabled ? `Door ${door.state} · Camera ${cameraAllowed ? 'enabled' : 'off'}` : 'Door sensor not enabled · Manual camera control'}</p>}
        <div className="camera-view">{mode === 'usb' && !cameraAllowed ? <div className="camera-empty"><span>◉</span><h3>{door.state === 'closed' ? 'Door closed · Camera off' : 'Waiting for door sensor'}</h3><p>Capture resumes automatically when the door opens.</p></div> : mode === 'usb' && live ? <img key={streamKey} src={`/api/camera/stream?session=${streamKey}`} alt="Live webcam stream" onError={() => setStreamState('Camera unavailable — try reconnecting')} /> : capture ? <img src={capture.url} alt="Latest fridge snapshot" /> : <div className="camera-empty"><span>◉</span><h3>{mode === 'usb' ? 'Stream paused' : 'A first look inside'}</h3><p>{mode === 'usb' ? 'Start the stream to see your webcam.' : 'Take a snapshot to see your fridge here.'}</p></div>}{mode === 'demo' && <span className="demo-label">ILLUSTRATED DEMO · NOT A LIVE FEED</span>}{mode === 'usb' && live && cameraAllowed && <span className="demo-label" role="status">{streamState}</span>}</div>
        {mode === 'usb' && <div className="stream-controls"><button className="primary" onClick={() => setLive(value => !value)}>{live ? (door.enabled ? 'Pause preview' : 'Pause stream') : 'Start preview'}</button>{live && <button className="secondary" onClick={() => { setStreamState('Connecting to camera…'); setStreamKey(value => value + 1); }}>Reconnect camera</button>}<small>{door.enabled ? 'Camera follows the door · Pausing hides the preview only' : 'Video only · No continuous recording'}</small></div>}
        <div className="camera-controls"><div><strong>{capture ? 'Snapshot saved' : 'Keep a still image'}</strong><small>{capture ? new Date(capture.createdAt).toLocaleString() : 'Capture a moment, keep the picture.'}</small></div><button className="primary" disabled={capturing || loading || mode === 'connecting' || !cameraAllowed} onClick={() => void takeSnapshot()}>{capturing ? 'Capturing…' : 'Take snapshot ↗'}</button></div>
      </section>
      <section className="inventory card"><div className="section-heading"><h2>On the shelves</h2><span className="count">{items.reduce((sum, item) => sum + item.quantity, 0)}</span></div><p className="muted">Your inventory, one item at a time.</p>
        <div className="items" aria-live="polite">{loading ? <p className="empty">Loading your shelves…</p> : items.length ? items.map(item => <div className="item" key={item.id}><span className="item-icon">▧</span><div><strong>{item.name}</strong><small>Quantity · {item.quantity}</small></div><button className="remove" aria-label={`Remove ${item.name}`} disabled={busy} onClick={() => void removeItem(item.id)}>×</button></div>) : <div className="empty"><span>＋</span><h3>A fresh start</h3><p>Add what’s in your fridge below.<br />Your inventory will stay saved.</p></div>}</div>
        <form onSubmit={addItem}><label htmlFor="name">Add an item</label><div className="form-row"><input id="name" placeholder="e.g. Greek yogurt" maxLength={100} required value={name} onChange={e => setName(e.target.value)} /><input aria-label="Quantity" className="quantity" type="number" min="1" max="999" required value={quantity} onChange={e => setQuantity(e.target.value)} /><button className="primary" disabled={busy || loading || mode === 'connecting'}>Add</button></div></form>
      </section>
    </div><footer><span>Made for your home.</span><span>Manual inventory for now · Automatic recognition comes next</span></footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
