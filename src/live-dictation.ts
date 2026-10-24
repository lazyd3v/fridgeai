export type DictationEvent = { type: string; itemId?: string; text?: string; message?: string };
// Completion replaces a provisional transcript; it must never append it twice.
export function createTranscript(initialText: string, update: (text: string) => void) {
  const items = new Map<string, string>();
  return (event: DictationEvent) => {
    if (!event.itemId || typeof event.text !== 'string') return;
    if (event.type === 'delta') items.set(event.itemId, (items.get(event.itemId) ?? '') + event.text);
    else if (event.type === 'completed') items.set(event.itemId, event.text);
    else return;
    update([initialText.trim(), ...[...items.values()].map(text => text.trim())].filter(Boolean).join(' '));
  };
}
export function startLiveDictation(options: { initialText: string; onText: (text: string) => void; onState: (state: 'starting' | 'recording' | 'transcribing' | 'idle') => void; onError: (message: string) => void }) {
  let cancelled = false;
  let stopping = false;
  let settled = false;
  let stream: MediaStream | undefined;
  let socket: WebSocket | undefined;
  let context: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: AudioWorkletNode | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  const transcript = createTranscript(options.initialText, options.onText);
  function cleanup() {
    clearTimeout(timer); clearTimeout(finishTimer);
    stream?.getTracks().forEach(track => track.stop());
    source?.disconnect(); processor?.disconnect();
    void context?.close().catch(() => {});
    socket?.close();
  }
  function finish(error?: string) {
    if (settled || cancelled) return;
    settled = true; cleanup();
    if (error) options.onError(error);
    options.onState('idle');
  }
  function stop() {
    if (stopping || cancelled || settled) return;
    stopping = true; clearTimeout(timer);
    options.onState('transcribing');
    // The worklet flushes its last audio chunk before the stop event on the same socket.
    processor?.port.postMessage('stop');
    stream?.getTracks().forEach(track => track.stop());
    finishTimer = setTimeout(() => finish('Could not finalize dictation. Review the text already in the composer.'), 20_000);
  }
  options.onState('starting');
  void (async () => {
    try {
      // Construct/resume audio directly from the microphone button's user gesture.
      context = new AudioContext();
      await context.resume();
      if (cancelled) return;
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (cancelled) { cleanup(); return; }
      await context.audioWorklet.addModule('/dictation-worklet.js');
      if (cancelled) return;
      processor = new AudioWorkletNode(context, 'dictation-pcm');
      source = context.createMediaStreamSource(stream);
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/dictation/live`);
      timer = setTimeout(() => finish('Live dictation could not connect. Please try again.'), 25_000);
      processor.port.onmessage = ({ data }) => {
        if (cancelled || settled || socket?.readyState !== WebSocket.OPEN) return;
        if (data.type === 'audio') {
          if (socket.bufferedAmount > 256 * 1024) { finish('The connection is too slow for live dictation. Your partial text is still available.'); return; }
          socket.send(data.bytes);
        } else if (data.type === 'flushed') socket.send(JSON.stringify({ type: 'stop' }));
      };
      socket.onmessage = ({ data }) => {
        if (cancelled || settled) return;
        let event: DictationEvent;
        try { event = JSON.parse(data); } catch { finish('Invalid dictation response.'); return; }
        if (event.type === 'ready') {
          clearTimeout(timer);
          source!.connect(processor!); processor!.connect(context!.destination);
          options.onState('recording');
          timer = setTimeout(stop, 60_000);
        } else if (event.type === 'done') finish();
        else if (event.type === 'error') finish(event.message ?? 'Live dictation failed.');
        else transcript(event);
      };
      socket.onerror = () => finish('Could not connect to live dictation. Your partial text is still available.');
      socket.onclose = () => { if (!settled && !cancelled) finish('Dictation disconnected. Your partial text is still available.'); };
    } catch (error) {
      if (!cancelled) finish(error instanceof DOMException && error.name === 'NotAllowedError' ? 'Allow microphone access in your browser to dictate.' : 'Could not start your microphone. Try again or upload a recording.');
    }
  })();
  return { stop, cancel() { cancelled = true; cleanup(); } };
}
