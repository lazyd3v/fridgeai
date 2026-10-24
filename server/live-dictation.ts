import type { Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

export const LIVE_TRANSCRIPTION_SESSION = {
  type: 'transcription',
  audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'gpt-live-transcribe', delay: 'low' }, turn_detection: null } },
};
export function attachLiveDictation(server: Server, connect = () => new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', {
  headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, handshakeTimeout: 15_000,
})) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/api/dictation/live') { socket.destroy(); return; }
    // A page on another origin must not be able to use the LAN server's credentials.
    let allowed = false;
    try { allowed = new URL(req.headers.origin ?? '').host === req.headers.host; } catch { /* Invalid or absent origin. */ }
    if (!allowed || wss.clients.size >= 2) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client));
  });
  wss.on('connection', client => {
    let upstream: WebSocket;
    let ready = false;
    let committed = false;
    let bytes = 0;
    let finished = false;
    const send = (value: unknown) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value)); };
    const fail = (message: string) => { if (!finished) { finished = true; send({ type: 'error', message }); client.close(); } };
    try { upstream = connect(); } catch { fail('Could not connect to live dictation. Please try again.'); return; }
    const timeout = setTimeout(() => fail('Dictation timed out. Your partial text is still in the composer.'), 90_000);
    const setupTimeout = setTimeout(() => fail('Live dictation could not connect. Please try again.'), 20_000);
    let finalTimeout: ReturnType<typeof setTimeout> | undefined;
    client.on('close', () => { clearTimeout(timeout); clearTimeout(setupTimeout); clearTimeout(finalTimeout); upstream.close(); });
    client.on('error', () => client.close());
    upstream.on('open', () => {
      if (client.readyState !== WebSocket.OPEN) { upstream.close(); return; }
      upstream.send(JSON.stringify({ type: 'session.update', session: LIVE_TRANSCRIPTION_SESSION }));
    });
    upstream.on('error', () => fail('Live dictation connection failed. Your partial text is still available.'));
    upstream.on('close', () => { if (!finished) fail('Live dictation disconnected. Your partial text is still available.'); });
    upstream.on('message', raw => {
      let event;
      try { event = JSON.parse(raw.toString()); } catch { fail('Invalid transcription response.'); return; }
      if (event.type === 'session.updated' || event.type === 'transcription_session.updated') {
        if (!ready) { clearTimeout(setupTimeout); ready = true; send({ type: 'ready' }); }
      } else if (event.type === 'conversation.item.input_audio_transcription.delta') {
        send({ type: 'delta', itemId: event.item_id, text: event.delta });
      } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
        send({ type: 'completed', itemId: event.item_id, text: event.transcript });
        if (committed) { finished = true; send({ type: 'done' }); client.close(); }
      } else if (event.type === 'error' || event.type === 'conversation.item.input_audio_transcription.failed') {
        fail('OpenAI could not transcribe this session. Your partial text is still available; try again.');
      }
    });
    client.on('message', (raw, binary) => {
      if (!ready || committed || upstream.readyState !== WebSocket.OPEN) { fail('Dictation is not ready for audio.'); return; }
      if (binary) {
        const audio = Buffer.from(raw as Buffer);
        bytes += audio.length;
        if (audio.length % 2 || bytes > 62 * 24000 * 2) { fail('Dictation reached its audio limit. Your partial text is still available.'); return; }
        upstream.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: audio.toString('base64') }));
      } else {
        let event;
        try { event = JSON.parse(raw.toString()); } catch { fail('Invalid dictation request.'); return; }
        if (event.type !== 'stop') { fail('Invalid dictation request.'); return; }
        committed = true;
        if (bytes < 4800) { finished = true; send({ type: 'done' }); client.close(); return; }
        upstream.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        finalTimeout = setTimeout(() => fail('The final transcript took too long. Review the partial text in the composer.'), 15_000);
      }
    });
  });
  return () => { for (const client of wss.clients) client.close(); wss.close(); };
}
