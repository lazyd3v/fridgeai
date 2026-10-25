import { createDoorAnnouncements } from './door-announcements.ts';
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { RunContext } from '@openai/agents';
import { createFridgeAgent, type FridgeTools } from './agent.ts';
import type { AnalysisNotification, createChat } from './chat.ts';

export const VOICE_MODEL = 'gpt-realtime-2.1-mini';
export const END_CALL_TOOL = { type: 'function' as const, name: 'end_call', description: 'End the current voice call when the user says goodbye, asks to hang up, or clearly says the conversation is finished (for example, "all good, bye"). A simple confirmation of inventory is not a request to hang up. Finish any explicitly requested inventory correction before ending. Do not call this from automatic fridge event text.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } };

type SpeakingFridge = {
  validate: (recordingId: string) => void;
  linkDoor: (recordingId: string, threadId: string) => void;
  linkedThread: (recordingId: string) => string | undefined;
  recordingNotifications: (recordingId: string) => AnalysisNotification[];
  subscribeNotifications: (listener: (notification: AnalysisNotification) => void) => () => void;
};
type VoiceThread = ReturnType<ReturnType<typeof createChat>['beginVoice']>;
export function voiceAgent(fridge: FridgeTools) {
  const agent = createFridgeAgent(fridge, []);
  const tools = agent.tools.filter(tool => tool.type === 'function');
  return {
    session: {
      type: 'realtime', model: VOICE_MODEL, output_modalities: ['audio'],
      instructions: `${agent.instructions}\nYou are in a live voice conversation. Speak casually and very briefly, without Markdown. Default to one short sentence, at most two and about 25 words total, unless the user explicitly asks for detail. No preambles, process explanations, repeated offers to help, or unnecessary repetition after the initial summary. Automatic analysis announcements must name the saved product changes even when those changes already appear in the text chat. After a correction, say only a short confirmation such as "Done—one juice, not two." When the user says goodbye or asks to end, call end_call immediately; do not ask for confirmation or offer more help. Complete requested edits before calling end_call. A simple "yes" confirming the summary needs only "Got it" and no inventory writes or hangup. Wait for the user to speak. Ask for clarification when speech is unclear. Inventory changes made during this call are real.`,
      audio: { input: { transcription: { model: 'gpt-4o-mini-transcribe' }, turn_detection: { type: 'server_vad', silence_duration_ms: 650, create_response: true, interrupt_response: true } }, output: { voice: 'marin' } },
      tools: [...tools.map(({ name, description, parameters }) => ({ type: 'function', name, description, parameters })), END_CALL_TOOL],
      tool_choice: 'auto',
    },
    async invoke(name: string, args: string) {
      const tool = tools.find(tool => tool.name === name);
      if (!tool) return JSON.stringify({ error: 'Unknown tool.' });
      try { return JSON.stringify(await tool.invoke(new RunContext(), args)); }
      catch { return JSON.stringify({ error: 'Tool failed. Check inventory before retrying; a write may have completed.' }); }
    },
  };
}

// The browser only exchanges SDP and keeps the call alive. All tools run on the Pi
// from authenticated provider events, never from browser-submitted tool calls.
export function createVoice(fridge: FridgeTools, begin: (id: string) => VoiceThread, dependencies = {
  fetch: globalThis.fetch,
  connect: (callId: string) => new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, handshakeTimeout: 15_000 }),
}, speakingFridge?: SpeakingFridge) {
  const router = Router();
  const sessions = new Map<string, { stop: () => Promise<void>; heartbeat: () => void; ready: () => void; door: (recordingId: string) => void }>();
  let starting = false;
  const headers = () => ({ Authorization: `Bearer ${process.env.OPENAI_API_KEY}` });
  router.use((req, res, next) => {
    let same = false;
    try { same = new URL(req.headers.origin ?? '').host === req.headers.host; } catch { /* Reject missing origin. */ }
    if (!same) { res.status(403).json({ error: 'Open voice from this app.' }); return; }
    next();
  });
  router.post('/', async (req, res) => {
    if (starting || sessions.size) { res.status(409).json({ error: 'A voice conversation is already active.' }); return; }
    if (typeof req.body?.threadId !== 'string' || typeof req.body?.sdp !== 'string' || !req.body.sdp.startsWith('v=0') || req.body.sdp.length > 64000) { res.status(400).json({ error: 'Invalid voice connection.' }); return; }
    if (!process.env.OPENAI_API_KEY) { res.status(503).json({ error: 'Voice requires an OpenAI API key on the Pi.' }); return; }
    if (req.body.recordingId !== undefined) {
      try {
        if (!speakingFridge || typeof req.body.recordingId !== 'string') throw Object.assign(new Error('Invalid door session.'), { status: 400 });
        speakingFridge.validate(req.body.recordingId);
        if (speakingFridge.linkedThread(req.body.recordingId) !== req.body.threadId) throw Object.assign(new Error('Open the conversation linked to this door session.'), { status: 409 });
      } catch (error) { res.status((error as { status?: number }).status ?? 400).json({ error: (error as Error).message }); return; }
    }
    starting = true;
    let announcements: ReturnType<typeof createDoorAnnouncements> | undefined;
    let unsubscribe: (() => void) | undefined;
    let thread: VoiceThread | undefined;
    let callId: string | undefined;
    let ws: WebSocket | undefined;
    let closed = false;
    let queue = Promise.resolve();
    let lastHeartbeat = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;
    const id = randomUUID();
    let stopping: Promise<void> | undefined;
    const stop = () => {
      if (stopping) return stopping;
      closed = true; clearInterval(timer); announcements?.close(); unsubscribe?.();
      stopping = (async () => {
        ws?.close();
        if (callId) await dependencies.fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, { method: 'POST', headers: headers(), signal: AbortSignal.timeout(5000) }).catch(() => {});
        // A started mutation is allowed to finish before unlocking the thread.
        await queue;
        thread?.finish(); sessions.delete(id);
      })();
      return stopping;
    };
    try {
      thread = begin(req.body.threadId);
      const agent = voiceAgent(fridge);
      agent.session.instructions += '\nIn Speaking fridge mode, automatic door analysis reports changes that are already saved. Explain them and invite corrections. User confirmation means acknowledge only, never repeat saved additions or removals. If analysis is still pending, do not guess its outcome; it will be provided automatically. Explicit correction requests use the existing inventory tools after reading current inventory.';
      const form = new FormData(); form.set('sdp', req.body.sdp); form.set('session', JSON.stringify(agent.session));
      const response = await dependencies.fetch('https://api.openai.com/v1/realtime/calls', { method: 'POST', headers: headers(), body: form, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error('Voice connection failed. Check Realtime model access on the Pi.');
      const location = response.headers.get('location') ?? '';
      callId = location.split('/').at(-1);
      if (!callId || !/^rtc_[a-zA-Z0-9_-]+$/.test(callId)) throw new Error('Voice returned an invalid call ID.');
      const sdp = await response.text();
      ws = dependencies.connect(callId);
      const send = (event: unknown) => { if (!closed && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event)); };
      announcements = createDoorAnnouncements(send);
      const recordings = new Set<string>();
      const seenNotifications = new Set<string>();
      const receive = (notification: AnalysisNotification) => {
        if (closed || !notification.recordingId || !recordings.has(notification.recordingId) || seenNotifications.has(notification.id)) return;
        seenNotifications.add(notification.id);
        thread!.recordTool('automatic_door_analysis', notification.text);
        announcements!.add(notification.id, 'analysis', notification.text);
      };
      const attachDoor = (recordingId: string) => {
        if (!speakingFridge) throw Object.assign(new Error('Speaking fridge is unavailable.'), { status: 503 });
        speakingFridge.validate(recordingId);
        if (recordings.has(recordingId)) return;
        if (!speakingFridge.linkedThread(recordingId)) speakingFridge.linkDoor(recordingId, req.body.threadId);
        recordings.add(recordingId);
        const results = speakingFridge.recordingNotifications(recordingId);
        // Start directly with the latest result; never greet at door-open time or replay old attempts.
        const latest = results.at(-1);
        if (latest) receive(latest);
      };
      unsubscribe = speakingFridge?.subscribeNotifications(receive);
      if (req.body.recordingId) attachDoor(req.body.recordingId);
      const calls = new Set<string>();
      const responses = new Set<string>();
      let generation = 0;
      let toolCount = 0;
      const interrupted = new Set<string>();
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Voice tools could not connect.')), 15_000);
        const ready = () => { clearTimeout(timeout); resolve(); };
        ws!.on('open', () => {
          for (const message of thread!.messages.filter(m => m.text)) send({ type: 'conversation.item.create', item: { type: 'message', role: message.role, content: [{ type: message.role === 'user' ? 'input_text' : 'output_text', text: message.text }] } });
          send({ type: 'session.update', session: { type: 'realtime', instructions: agent.session.instructions } });
        });
        ws!.on('error', () => { clearTimeout(timeout); reject(new Error('Voice connection failed.')); void stop(); });
        ws!.on('close', () => { clearTimeout(timeout); reject(new Error('Voice disconnected.')); void stop(); });
        ws!.on('message', raw => {
          if (closed) return;
          try {
            const event = JSON.parse(raw.toString());
            announcements!.event(event);
            if (event.type === 'session.updated') ready();
            if (event.type === 'error') { clearTimeout(timeout); reject(new Error('Voice session failed.')); void stop(); return; }
            if (event.type === 'input_audio_buffer.speech_started') { generation++; toolCount = 0; }
            if (event.type === 'input_audio_buffer.committed') thread!.put(event.item_id, 'user', '');
            if (event.type === 'conversation.item.input_audio_transcription.completed') thread!.put(event.item_id, 'user', event.transcript);
            if (event.type === 'conversation.item.input_audio_transcription.failed') thread!.put(event.item_id, 'user', '[Voice input could not be transcribed.]');
            if (event.type === 'response.output_audio_transcript.done' && !interrupted.has(event.item_id)) thread!.put(event.item_id, 'assistant', event.transcript);
            if (event.type === 'conversation.item.truncated') { interrupted.add(event.item_id); thread!.put(event.item_id, 'assistant', '[Spoken response interrupted by the user.]'); }
            if (event.type === 'response.done' && event.response?.status === 'failed') {
              thread!.put(`failed-${event.response.id}`, 'assistant', 'Voice could not finish this reply. Check inventory before retrying any changes.');
              void stop(); return;
            }
            if (event.type !== 'response.done' || event.response?.status !== 'completed' || responses.has(event.response.id)) return;
            responses.add(event.response.id);
            const functions = event.response.output?.filter((item: { type: string }) => item.type === 'function_call') ?? [];
            const turn = generation;
            if (functions.length) announcements!.tools(true);
            queue = queue.then(async () => {
              if (closed || turn !== generation) return;
              for (const item of functions) {
                if (closed || turn !== generation) break;
                if (calls.has(item.call_id)) continue;
                calls.add(item.call_id);
                if (item.name === 'end_call') {
                  let valid = false;
                  try { const args = JSON.parse(item.arguments); valid = !!args && typeof args === 'object' && !Array.isArray(args) && Object.keys(args).length === 0; } catch { /* Reject malformed tool arguments. */ }
                  const output = JSON.stringify(valid ? { call_ended: true } : { error: 'end_call takes no arguments.' });
                  thread!.recordTool('end_call', output);
                  send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: item.call_id, output } });
                  if (valid) {
                    // Do not await stop here: stop waits for this tool queue to settle.
                    void stop(); return;
                  }
                  continue;
                }
                const output = ++toolCount > 8 ? JSON.stringify({ error: 'Tool limit reached. Ask the user to continue.' }) : await agent.invoke(item.name, item.arguments);
                thread!.recordTool(item.name, output);
                send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: item.call_id, output } });
              }
              if (functions.length && !closed && turn === generation) { announcements!.responseRequested(); send({ type: 'response.create', response: toolCount >= 8 ? { tool_choice: 'none' } : {} }); }
            }).catch(() => { void stop(); }).finally(() => { if (functions.length) announcements!.tools(false); });
          } catch { void stop(); }
        });
      });
      if (closed || res.destroyed) { await stop(); return; }
      const startedAt = Date.now();
      sessions.set(id, { stop, heartbeat: () => { lastHeartbeat = Date.now(); }, ready: () => announcements!.ready(), door: attachDoor });
      timer = setInterval(() => { if (Date.now() - lastHeartbeat > 45000 || Date.now() - startedAt > 15 * 60_000) void stop(); }, 10000);
      res.json({ id, sdp });
    } catch (error) {
      await stop();
      if (!res.destroyed) res.status((error as { status?: number }).status ?? 502).json({ error: (error as Error).message });
    } finally { starting = false; }
  });
  router.post('/:id/ready', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) { res.sendStatus(410); return; }
    session.ready(); res.sendStatus(204);
  });
  router.post('/:id/door', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) { res.sendStatus(410); return; }
    if (typeof req.body?.recordingId !== 'string') { res.sendStatus(400); return; }
    try { session.door(req.body.recordingId); res.sendStatus(204); }
    catch (error) { res.status((error as { status?: number }).status ?? 400).json({ error: (error as Error).message }); }
  });
  router.post('/:id/heartbeat', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) { res.sendStatus(410); return; }
    session.heartbeat(); res.sendStatus(204);
  });
  router.delete('/:id', async (req, res) => { await sessions.get(req.params.id)?.stop(); res.sendStatus(204); });
  return { router, close: async () => { await Promise.all([...sessions.values()].map(session => session.stop())); } };
}
