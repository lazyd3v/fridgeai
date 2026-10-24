import { useEffect, useMemo, useRef, useState } from 'react';
import { AssistantRuntimeProvider, ComposerPrimitive, ThreadPrimitive, MessagePrimitive, AuiIf, ExportedMessageRepository, type ToolCallMessagePartProps } from '@assistant-ui/react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import { useAgUiRuntime, fromAgUiMessages } from '@assistant-ui/react-ag-ui';
import { HttpAgent } from '@ag-ui/client';
import { startLiveDictation } from './live-dictation';
import { Icon, Miso } from './ui';

type Thread = { id: string; title: string; messages: { id: string; role: 'user' | 'assistant'; text: string; error?: boolean }[]; busy: boolean };
type Summary = Pick<Thread, 'id' | 'title'>;
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'Could not connect to MISO.');
  return data;
}
const starters = ['Suggest me what to cook tonight', 'What’s in my fridge?', 'Help me update my inventory'];
export function Assistant() {
  const [threads, setThreads] = useState<Summary[]>([]);
  const [thread, setThread] = useState<Thread | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const initial = useRef<Promise<{ list: Summary[]; current: Thread }> | null>(null);
  async function refreshList() { setThreads(await request<Summary[]>('/threads')); }
  useEffect(() => {
    let cancelled = false;
    initial.current ??= (async () => {
      const list = await request<Summary[]>('/threads');
      const current = list.length ? await request<Thread>(`/threads/${list[0].id}`) : await request<Thread>('/threads', { method: 'POST' });
      return { list: list.length ? list : [current], current };
    })();
    void initial.current.then(({ list, current }) => { if (!cancelled) { setThreads(list); setThread(current); } }).catch(e => { if (!cancelled) setError(e.message); }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!thread?.busy) return;
    const id = thread.id;
    const timer = setInterval(() => { void request<Thread>(`/threads/${id}`).then(setThread).catch(() => setError('Connection lost. Reload to recover the conversation.')); }, 2000);
    return () => clearInterval(timer);
  }, [thread?.id, thread?.busy]);
  async function choose(id: string) {
    if (busy || thread?.busy) return;
    setBusy(true); setError('');
    try { setThread(id ? await request<Thread>(`/threads/${id}`) : await request<Thread>('/threads', { method: 'POST' })); await refreshList(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <aside className="assistant miso-chat" aria-label="MISO assistant">
    <div className="assistant-heading"><h2>MISO</h2><button className="new-chat" disabled={busy || !!thread?.busy} onClick={() => void choose('')}><Icon name="plus" size={15}/> New chat</button></div>
    {thread && <select className="thread-picker" aria-label="Conversation" value={thread.id} disabled={busy || thread.busy} onChange={event => void choose(event.target.value)}>{threads.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>}
    {error && <p className="chat-error" role="alert">{error}</p>}
    {thread?.busy ? <p role="status" className="chat-thinking">MISO is finishing your reply. Reconnecting…</p> : thread ? <ChatThread key={thread.id} thread={thread} onBusy={setBusy} onFinished={() => { void refreshList().catch(() => setError('Could not refresh conversations.')); }}/> : <p role="status">Connecting to MISO…</p>}
  </aside>;
}
function ToolProgress({ toolName, result }: ToolCallMessagePartProps) {
  const labels: Record<string, string> = { get_inventory: 'Checking your fridge', add_inventory_item: 'Adding to your fridge', update_inventory_item: 'Updating your inventory', remove_inventory_item: 'Removing an item', get_fridge_status: 'Checking the fridge connection' };
  return <div className="tool-progress"><Icon name="fridge" size={14}/>{labels[toolName] ?? 'Working on your request'}{result !== undefined ? ' · Done' : '…'}</div>;
}
function MarkdownText() { return <MarkdownTextPrimitive/>; }
function AssistantMessage() {
  return <MessagePrimitive.Root className="chat-message chat-assistant"><span className="chat-author">MISO</span><div className="chat-markdown"><MessagePrimitive.Parts components={{ Text: MarkdownText, tools: { Fallback: ToolProgress } }}/></div></MessagePrimitive.Root>;
}
function UserMessage() {
  return <MessagePrimitive.Root className="chat-message chat-user"><span className="chat-author">You</span><div><MessagePrimitive.Parts/></div></MessagePrimitive.Root>;
}
function ChatThread({ thread, onBusy, onFinished }: { thread: Thread; onBusy: (busy: boolean) => void; onFinished: () => void }) {
  const [error, setError] = useState('');
  const [voice, setVoice] = useState<'idle' | 'starting' | 'recording' | 'transcribing'>('idle');
  const [voiceHelp, setVoiceHelp] = useState(false);
  const [running, setRunning] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const liveDictation = useRef<ReturnType<typeof startLiveDictation> | null>(null);
  const active = useRef(true);
  const callbacks = useRef({ onBusy, onFinished }); callbacks.current = { onBusy, onFinished };
  const agent = useMemo(() => new HttpAgent({ url: `/api/threads/${thread.id}/run`, threadId: thread.id }), [thread.id]);
  const adapters = useMemo(() => ({ history: {
    async load() { return ExportedMessageRepository.fromArray(fromAgUiMessages(thread.messages.map(message => ({ id: message.id, role: message.role, content: message.text })))); },
    async append() { /* The Pi persists each accepted user turn and agent result. */ },
  } }), [thread]);
  const runtime = useAgUiRuntime({ agent, adapters, showThinking: false, isDisabled: voice !== 'idle', onError: e => setError(`${e.message} Reload to recover the saved reply before retrying inventory changes.`) });
  useEffect(() => {
    let wasRunning = false;
    return runtime.thread.subscribe(() => {
      const next = runtime.thread.getState().isRunning;
      setRunning(next);
      if (wasRunning && !next) callbacks.current.onFinished();
      if (next && !wasRunning) setError('');
      wasRunning = next;
    });
  }, [runtime]);
  useEffect(() => { callbacks.current.onBusy(running || voice !== 'idle'); }, [running, voice]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      liveDictation.current?.cancel();
    };
  }, []);
  const disabled = running || voice !== 'idle';
  async function transcribe(blob: Blob) {
    setVoice('transcribing'); setError('');
    try {
      if (blob.size > 20 * 1024 * 1024) throw new Error('Use a recording smaller than 20 MB.');
      const { text } = await request<{ text: string }>('/dictation', { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/mp4' }, body: blob });
      if (active.current) { runtime.thread.composer.setText([runtime.thread.composer.getState().text.trim(), text].filter(Boolean).join(' ')); }
    } catch (e) { if (active.current) setError((e as Error).message); }
    finally { if (active.current) setVoice('idle'); }
  }
  function dictate() {
    if (voice === 'starting') { liveDictation.current?.cancel(); setVoice('idle'); return; }
    if (voice === 'recording') { liveDictation.current?.stop(); return; }
    if (disabled) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') { setVoiceHelp(true); return; }
    setError('');
    liveDictation.current = startLiveDictation({
      initialText: runtime.thread.composer.getState().text,
      onText: text => { if (active.current) runtime.thread.composer.setText(text); },
      onState: state => { if (active.current) setVoice(state); },
      onError: message => { if (active.current) setError(message); },
    });
  }
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="miso-thread">
    <div className="miso-greeting"><Miso/><div><p>Hello, Roman.</p><h2>What’s cooking?</h2></div></div>
    <ThreadPrimitive.Viewport className="chat-scroll" aria-label="Conversation messages">
      <AuiIf condition={s => s.thread.isEmpty}><div className="chat-welcome"><span className="eyebrow">A LITTLE KITCHEN INSPIRATION</span><h3>Good things start<br/>with what you have.</h3><p>Let’s find something delicious, see what’s in your fridge, or keep it up to date.</p><div className="starter-prompts">{starters.map((prompt, index) => <ThreadPrimitive.Suggestion key={prompt} prompt={prompt} send disabled={disabled}><Icon name={index === 0 ? 'recipes' : index === 1 ? 'fridge' : 'leaf'} size={20}/><span>{prompt}</span><Icon name="arrow" size={16}/></ThreadPrimitive.Suggestion>)}</div></div></AuiIf>
      <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }}/>
      <AuiIf condition={s => s.thread.isRunning}><p className="chat-thinking" role="status">MISO is working…</p></AuiIf>
      <ThreadPrimitive.ViewportFooter/>
    </ThreadPrimitive.Viewport>
    <div className="assistant-bottom">
      {error && <p className="chat-error" role="alert">{error}</p>}
      {voiceHelp && <div className="voice-help">For live dictation, open the app through the localhost SSH tunnel or HTTPS. Here you can upload a voice recording or use your keyboard’s dictation.<button disabled={disabled} onClick={() => fileInput.current?.click()}>Upload voice recording</button></div>}
      {voice !== 'idle' && <p className="voice-status" role="status">{voice === 'recording' ? 'Listening… Text appears as you speak. Tap stop when done.' : voice === 'starting' ? 'Connecting your microphone…' : 'Finalizing your transcript…'}</p>}
      <ComposerPrimitive.Root className="composer">
        <ComposerPrimitive.Input aria-label="Message MISO" placeholder="Ask MISO about your fridge…" rows={2} maxLength={4000} disabled={disabled}/>
        <div className="composer-actions"><button type="button" className={voice === 'recording' ? 'recording' : ''} disabled={voice !== 'recording' && voice !== 'starting' && disabled} onClick={() => void dictate()} aria-label={voice === 'starting' ? 'Cancel dictation' : voice === 'recording' ? 'Stop dictation' : 'Dictate a message'} title="Dictate a message">{voice === 'recording' ? <span>■</span> : <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>}</button><ComposerPrimitive.Send className="chat-send" aria-label="Send message" disabled={disabled}><Icon name="send" size={18}/></ComposerPrimitive.Send></div>
      </ComposerPrimitive.Root>
      <input hidden ref={fileInput} type="file" accept="audio/*,.m4a,.mp4,.webm" onChange={event => { const file = event.target.files?.[0]; if (file) void transcribe(file); event.target.value = ''; }}/>
      <small>Your fridge, a little more inspired.</small>
    </div>
  </ThreadPrimitive.Root></AssistantRuntimeProvider>;
}
