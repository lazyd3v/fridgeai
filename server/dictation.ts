import express from 'express';

export function createDictation(transcribe = transcribeAudio) {
  const router = express.Router();
  let busy = false;
  router.post('/dictation', express.raw({ type: () => true, limit: '20mb' }), async (req, res) => {
    const type = (req.headers['content-type'] ?? '').split(';')[0];
    const extension = ({ 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'video/webm': 'webm', 'video/mp4': 'mp4' } as Record<string, string>)[type];
    if (!extension || !Buffer.isBuffer(req.body) || !req.body.length) { res.status(400).json({ error: 'Choose a WebM, M4A, MP3, MP4, WAV, or Ogg recording (up to 20 MB).' }); return; }
    if (busy) { res.status(409).json({ error: 'Another recording is being transcribed. Please try again shortly.' }); return; }
    busy = true;
    try { res.json({ text: await transcribe(req.body, type, extension) }); }
    catch { res.status(502).json({ error: 'Could not transcribe this recording. Try a shorter recording or type your message.' }); }
    finally { busy = false; }
  });
  return router;
}
async function transcribeAudio(bytes: Buffer, type: string, extension: string) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Missing API key');
  const form = new FormData();
  form.append('model', 'gpt-4o-mini-transcribe');
  form.append('file', new Blob([new Uint8Array(bytes)], { type }), `dictation.${extension}`);
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error('Transcription failed');
  const result = await response.json() as { text?: string };
  if (!result.text?.trim()) throw new Error('No speech detected');
  return result.text.trim();
}
