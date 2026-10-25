import { useEffect, useRef, useState } from 'react';

const preferenceKey = 'miso.speaking-fridge';
export type SpeakingFridgeMode = { enabled: boolean; ready: boolean; microphone: MediaStream | null; audio: HTMLAudioElement | null };
export function useSpeakingFridge() {
  const [enabled, setEnabled] = useState(() => { try { return localStorage.getItem(preferenceKey) === 'true'; } catch { return false; } });
  const [ready, setReady] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const microphone = useRef<MediaStream | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const generation = useRef(0);
  const desiredEnabled = useRef(enabled); desiredEnabled.current = enabled;
  const supported = !!navigator.mediaDevices?.getUserMedia && typeof RTCPeerConnection !== 'undefined';
  function release() {
    generation.current++;
    microphone.current?.getTracks().forEach(track => track.stop()); microphone.current = null;
    audio.current?.pause(); audio.current = null;
  }
  async function arm() {
    if (!desiredEnabled.current) return;
    if (!supported) { setError('Open the app over HTTPS or the localhost SSH tunnel to allow microphone access.'); return; }
    release(); const attempt = generation.current;
    setPreparing(true); setError(''); setReady(false);
    try {
      // Prime the same playback element with a silent WAV during the click gesture.
      const element = new Audio(); element.autoplay = true; audio.current = element;
      const bytes = new Uint8Array(46); const view = new DataView(bytes.buffer);
      for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVEfmt '], [36, 'data']] as const) for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
      view.setUint32(4, 38, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, 24000, true); view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, 2, true);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })); element.src = url;
      void element.play().catch(() => {}).finally(() => URL.revokeObjectURL(url));
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (attempt !== generation.current) { stream.getTracks().forEach(track => track.stop()); return; }
      stream.getTracks().forEach(track => { track.enabled = false; track.onended = () => { setReady(false); setError('Microphone disconnected. Enable Speaking fridge again when it is available.'); }; });
      microphone.current = stream; setReady(true);
    } catch { if (attempt === generation.current) setError('Allow microphone access, then enable Speaking fridge for this visit.'); }
    finally { if (attempt === generation.current) setPreparing(false); }
  }
  function toggle(value: boolean) {
    desiredEnabled.current = value;
    setEnabled(value); setReady(false); setError('');
    try { localStorage.setItem(preferenceKey, String(value)); } catch { /* This visit still works. */ }
    if (value) void arm(); else { release(); setPreparing(false); }
  }
  useEffect(() => {
    // Restore an enabled mode after a reload. Existing microphone permission is reused;
    // denied permission still leaves an explicit retry control instead of prompting in a loop.
    const timer = enabled ? setTimeout(() => void arm(), 0) : undefined;
    return () => { clearTimeout(timer); release(); };
  }, []);
  const enableButton = <button className="secondary" disabled={preparing || !supported} onClick={() => void arm()}>{preparing ? 'Preparing microphone…' : 'Enable microphone'}</button>;
  return {
    mode: { enabled, ready, microphone: microphone.current, audio: audio.current } satisfies SpeakingFridgeMode,
    settings: <div className="summary-speech-settings"><h3>Speaking fridge</h3>
      <label><input type="checkbox" checked={enabled} onChange={event => toggle(event.target.checked)}/> Speaking fridge mode</label>
      <p className="muted">When fridge processing finishes, MISO starts a live conversation with a short summary, then listens for your confirmation or corrections. If a call is already connected, the results arrive in that call.</p>
      <p className="muted">Uses an AI voice. Your microphone stays ready while enabled; audio is sent to OpenAI only during a live call. Keep this page open. Turn the mode off or end the call to stop listening.</p>
      {!supported && <p className="chat-error">Microphone access requires HTTPS or the <a href="http://127.0.0.1:3002">localhost SSH tunnel</a>. Start the tunnel on your Mac before opening that link.</p>}
      {enabled && !ready && enableButton}
      {ready && <p role="status">Ready for the next recognition result.</p>}
      {error && <p role="alert" className="chat-error">{error}</p>}
    </div>,
    notice: enabled ? <div className="summary-speech-notice" role="status"><span>{ready ? 'Speaking fridge is ready. MISO will speak when processing finishes.' : error || 'Speaking fridge is on. Preparing your microphone…'}</span>{!ready && enableButton}</div> : null,
  };
}
