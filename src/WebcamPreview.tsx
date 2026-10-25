import { useEffect, useRef, useState } from 'react';

export function WebcamPreview() {
  const [playing, setPlaying] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [message, setMessage] = useState('Connecting…');
  const failed = useRef(false);
  useEffect(() => {
    if (!playing) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    async function poll() {
      try {
        const response = await fetch('/api/status', { cache: 'no-store' });
        if (!response.ok) throw new Error('Camera status unavailable');
        const status = await response.json();
        if (cancelled) return;
        const stream = status.stream;
        if (!stream) { setMessage('Connect the Pi USB webcam to use the live preview.'); return; }
        const fresh = stream.lastFrameAt && Date.now() - stream.lastFrameAt < 5000;
        setMessage(fresh ? 'Live' : stream.error ? 'Camera unavailable — reconnecting…' : 'Connecting…');
        if (failed.current || (!fresh && Date.now() - started > 15000)) {
          failed.current = false; setAttempt(value => value + 1); return;
        }
      } catch { if (!cancelled) setMessage('Connection lost — retrying…'); }
      if (!cancelled) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [playing, attempt]);
  return <section className="panel debug-panel focus-panel">
    <div className="section-heading"><h2>Webcam stream</h2><span className="badge" role="status">{playing ? message : 'Paused'}</span></div>
    <p className="muted">Live preview keeps the camera on while this page is open, even with the door closed. Previewing does not start a test recording.</p>
    {playing && <div className="debug-preview"><img key={attempt} src={`/api/debug/stream?attempt=${attempt}`} alt="Live webcam stream" onError={() => { failed.current = true; setMessage('Camera unavailable — reconnecting…'); }} /></div>}
    <div className="debug-actions">
      <button className="secondary" onClick={() => { failed.current = false; setMessage('Connecting…'); setPlaying(value => !value); }}>{playing ? 'Pause stream' : 'Start stream'}</button>
      {playing && <button className="text-button" onClick={() => { failed.current = false; setMessage('Connecting…'); setAttempt(value => value + 1); }}>Reconnect</button>}
    </div>
  </section>;
}
