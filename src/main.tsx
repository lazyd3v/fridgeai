import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { Icon, FoodIcon, Miso, type IconName } from './ui';

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
  const [page, setPage] = useState('Fridge');
  const [expanded, setExpanded] = useState(false);
  const [activity, setActivity] = useState<{ id: number; name: string; action: string; time: string }[]>([]);
  const [filter, setFilter] = useState('All');
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  function record(name: string, action: string) { setActivity(current => [{ id: Date.now(), name, action, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }, ...current].slice(0, 30)); }
  useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(false); }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, []);
  async function load() {
    setError(''); setLoading(true);
    try {
      const [inventory, latest, status] = await Promise.all([api<Item[]>('/items'), api<Capture | null>('/captures/latest'), api<{ cameraMode: string }>('/status')]);
      setItems(inventory); setCapture(latest); setMode(status.cameraMode); setUpdatedAt(new Date());
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
      setItems(current => [item, ...current]); record(item.name, 'Added'); setName(''); setQuantity('1');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function removeItem(id: string) {
    setBusy(true); setError('');
    try { await api(`/items/${id}`, { method: 'DELETE' }); record(items.find(item => item.id === id)?.name ?? 'Item', 'Removed'); setItems(current => current.filter(item => item.id !== id)); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const nav: { label: string; icon: IconName }[] = [{ label: 'Fridge', icon: 'fridge' }, { label: 'Recipes', icon: 'recipes' }, { label: 'Shopping', icon: 'shopping' }, { label: 'Settings', icon: 'settings' }];
  const isLive = mode === 'usb' && live && cameraAllowed && streamState === 'Live from your webcam';
  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Fridge AI home"><Icon name="fridge" size={29}/><span>Fridge AI</span></a>
      <nav aria-label="Main navigation">{nav.map(({ label, icon }) => <button key={label} className={`nav-link ${page === label ? 'active' : ''}`} aria-current={page === label ? 'page' : undefined} onClick={() => setPage(label)}><Icon name={icon}/><span>{label}</span>{(label === 'Recipes' || label === 'Shopping') && <span className="nav-soon">Soon</span>}</button>)}</nav>
      <div className="sidebar-bottom"><span className="home-note"><span className="status-dot"/> A little less food waste.</span><div className="profile"><span className="avatar">R</span><span>Roman<small>My kitchen</small></span><Icon name="leaf" size={18}/></div></div>
    </aside>
    <main className="workspace">
      <header className="page-header"><div><div className="title-row"><h1>{page === 'Fridge' ? 'Your fridge' : page}</h1>{page === 'Fridge' && <span className={`badge ${isLive ? 'live' : ''}`}><span className="status-dot"/>{isLive ? 'Live' : mode === 'connecting' ? 'Connecting' : mode === 'demo' ? 'Demo' : mode === 'replay' ? 'Saved photo' : !cameraAllowed ? 'Camera off' : !live ? 'Paused' : 'Connecting'}</span>}</div><p>{page === 'Fridge' ? updatedAt ? `Inventory updated at ${updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Connecting to your kitchen…' : 'A home for everything in your kitchen.'}</p></div><div className="header-actions"><button className="icon-button" aria-label="Refresh inventory" disabled={loading} onClick={() => void load()}><Icon name="refresh"/></button><button className="icon-button" aria-label="Open settings" onClick={() => setPage('Settings')}><Icon name="settings"/></button></div></header>
      {error && <div className="error" role="alert">{error}<button onClick={() => void load()}>Try again</button></div>}
      {page === 'Fridge' ? <>
        <section className={`camera ${expanded ? 'expanded' : ''}`} aria-label="Fridge camera">
          <div className="camera-view">{mode === 'usb' && !cameraAllowed ? <div className="camera-empty"><Icon name="fridge" size={46}/><h2>{door.state === 'closed' ? 'All tucked away.' : 'Waiting for your fridge'}</h2><p>{door.state === 'closed' ? 'The camera rests while the door is closed.' : 'Waiting for the door sensor to connect.'}</p><span className="camera-hint">The view returns when you open the door.</span></div> : mode === 'usb' && live ? <img key={streamKey} src={`/api/camera/stream?session=${streamKey}`} alt="Live view inside your fridge" onError={() => setStreamState('Camera unavailable — try reconnecting')} /> : capture ? <img src={capture.url} alt="Latest saved fridge snapshot" /> : <div className="camera-empty"><Icon name="camera" size={46}/><h2>{mode === 'usb' ? 'A moment of pause.' : 'A fresh perspective.'}</h2><p>{mode === 'usb' ? 'Start the preview to see inside your fridge.' : 'Take your first snapshot to see what’s inside.'}</p></div>}
            <button className="camera-expand icon-button" aria-label={expanded ? 'Close expanded camera' : 'Expand camera'} aria-pressed={expanded} onClick={() => setExpanded(value => !value)}><Icon name={expanded ? 'close' : 'expand'}/></button>
            <div className="camera-caption"><span className="status-dot"/>{mode === 'demo' ? 'Illustrated demo · not a live feed' : mode === 'usb' && !cameraAllowed ? `Door ${door.state} · Camera off` : mode === 'usb' && live ? streamState : capture ? 'Latest snapshot' : 'Your kitchen, in view'}</div>
          </div>
          <div className="camera-toolbar"><span><Icon name="camera" size={16}/>{capture ? `Last snapshot · ${new Date(capture.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : 'A little less guessing. A little more freshness.'}</span><div>{mode === 'usb' && <><button className="text-button" onClick={() => setLive(value => !value)}>{live ? 'Pause preview' : 'Start preview'}</button><button className="icon-button compact" aria-label="Reconnect camera" onClick={() => { setStreamState('Connecting to camera…'); setStreamKey(value => value + 1); }}><Icon name="refresh" size={16}/></button></>}<button className="secondary" disabled={capturing || loading || mode === 'connecting' || !cameraAllowed} onClick={() => void takeSnapshot()}>{capturing ? 'Capturing…' : 'Take snapshot'}</button></div></div>
        </section>
        <div className="dashboard-bottom">
          <section className="panel inventory"><div className="section-heading"><h2>Current items</h2><span className="count">{items.length} {items.length === 1 ? 'item' : 'items'}</span></div>
            <div className="items" aria-live="polite">{loading ? <div className="empty"><p>Checking your shelves…</p></div> : items.length ? items.map(item => <article className="item" key={item.id}><FoodIcon name={item.name}/><div className="item-detail"><h3>{item.name}</h3><p>{item.quantity} {item.quantity === 1 ? 'unit' : 'units'}</p><small><span className="tiny-dot"/> In your fridge</small></div><button className="remove" aria-label={`Remove ${item.name}`} disabled={busy} onClick={() => void removeItem(item.id)}><Icon name="close" size={14}/></button></article>) : <div className="empty"><span className="empty-symbol"><Icon name="leaf" size={28}/></span><h3>A fresh start</h3><p>Add what’s on your shelves.<br/>Good things start with what you have.</p></div>}</div>
            <form onSubmit={addItem}><label htmlFor="name">Add to your fridge</label><div className="form-row"><input id="name" placeholder="e.g. Tomatoes" maxLength={100} required value={name} onChange={e => setName(e.target.value)}/><input aria-label="Quantity" className="quantity" type="number" min="1" max="999" required value={quantity} onChange={e => setQuantity(e.target.value)}/><button className="primary" disabled={busy || loading || mode === 'connecting'}><Icon name="plus" size={16}/> Add</button></div></form>
          </section>
          <section className="panel activity"><div className="section-heading"><h2>Recent activity</h2><select aria-label="Filter activity" value={filter} onChange={e => setFilter(e.target.value)}><option>All</option><option>Added</option><option>Removed</option></select></div><p className="section-note">Changes made in this session</p><div className="activity-list">{activity.filter(event => filter === 'All' || event.action === filter).length ? activity.filter(event => filter === 'All' || event.action === filter).map(event => <div className="activity-row" key={event.id}><span className={`activity-arrow ${event.action === 'Removed' ? 'removed' : ''}`}><Icon name="arrow" size={15}/></span><FoodIcon name={event.name}/><div><strong>{event.action} {event.name}</strong><small>Today, {event.time}</small></div></div>) : <div className="empty activity-empty"><Icon name="refresh" size={25}/><h3>{activity.length ? 'Nothing here yet' : 'A quiet kitchen'}</h3><p>{activity.length ? 'No matching changes this session.' : 'Your additions and removals will appear here.'}</p></div>}</div></section>
        </div><p className="workspace-footnote">A little care for what’s inside. <span>Freshness tracking is coming soon.</span></p>
      </> : page === 'Settings' ? <section className="panel settings-panel"><h2>Your kitchen connection</h2><p className="muted">Camera and sensor status from your Raspberry Pi.</p><dl><div><dt>Camera source</dt><dd>{mode}</dd></div><div><dt>Door sensor</dt><dd>{door.enabled ? door.state : 'Not enabled'}</dd></div><div><dt>Preview</dt><dd>{live ? 'Enabled' : 'Paused'}</dd></div></dl><button className="secondary" onClick={() => setPage('Fridge')}>Back to your fridge</button></section> : <section className="panel coming-soon"><span className="empty-symbol"><Icon name={page === 'Recipes' ? 'recipes' : 'shopping'} size={32}/></span><span className="eyebrow">A LITTLE SOMETHING IN THE MAKING</span><h2>{page === 'Recipes' ? 'Good food starts here.' : 'Just what you need.'}</h2><p>{page === 'Recipes' ? 'A place for ideas that make the most of your fridge.' : 'A thoughtful shopping list for your next kitchen adventure.'}</p><span className="count">Coming soon</span><button className="secondary" onClick={() => setPage('Fridge')}>Back to your fridge</button></section>}
    </main>
    <aside className="assistant" aria-label="MISO assistant preview"><div className="assistant-heading"><h2>MISO</h2><span className="wip">Work in progress</span></div><div className="miso-greeting"><Miso/><div><p>Hello, Roman.</p><h2>What’s cooking?</h2></div><span className="sound-wave" aria-hidden="true"><i/><i/><i/><i/><i/></span></div>
      <div className="assistant-body"><div className="assistant-message"><span className="mini-miso"><Miso small/></span><div><h3>Your kitchen companion,<br/>coming to life.</h3><p>One place to turn what’s in your fridge into something good.</p></div></div><div className="assistant-preview"><span className="eyebrow">A TASTE OF WHAT’S NEXT</span><div className="preview-feature"><span className="feature-icon peach"><Icon name="recipes"/></span><div><h3>A little dinner inspiration</h3><p>Ideas built around what you have.</p></div></div><div className="preview-feature"><span className="feature-icon sage"><Icon name="leaf"/></span><div><h3>Freshness, first</h3><p>A gentle nudge to use things up.</p></div></div><div className="preview-feature"><span className="feature-icon lavender"><Icon name="shopping"/></span><div><h3>Smarter little lists</h3><p>The missing bits, remembered.</p></div></div></div><p className="assistant-note">We’re getting the kitchen ready.<br/>MISO’s chat is still in the making.</p></div>
      <div className="assistant-bottom"><div className="suggestions"><span>What can I cook?</span><span>What’s in my fridge?</span></div><div className="composer"><input aria-label="Assistant chat coming soon" placeholder="Ask MISO about your fridge…" disabled/><button disabled aria-label="Send message — coming soon"><Icon name="send" size={18}/></button></div><small>Made for your kitchen. A little magic to come.</small></div>
    </aside>
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
