export type VoiceStatus = 'idle' | 'connecting' | 'listening' | 'speaking' | 'thinking';
export function startVoiceConversation(options: {
  threadId: string;
  onStatus: (status: VoiceStatus) => void;
  onTranscript: (role: 'user' | 'assistant', text: string) => void;
  onError: (text: string) => void;
  onAudioBlocked: (blocked: boolean) => void;
  onEnd: () => void;
}) {
  let ended = false;
  let stream: MediaStream | undefined;
  let peer: RTCPeerConnection | undefined;
  let channel: RTCDataChannel | undefined;
  let id: string | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const audio = new Audio(); audio.autoplay = true;
  const controller = new AbortController();
  const setup = setTimeout(() => finish('Voice could not connect. Try again.'), 40000);
  const closeRemote = async () => {
    if (id) await fetch(`/api/voice/${id}`, { method: 'DELETE', keepalive: true }).catch(() => {});
  };
  function finish(error?: string) {
    if (ended) return;
    ended = true; clearTimeout(setup); clearInterval(heartbeat); controller.abort();
    stream?.getTracks().forEach(track => track.stop());
    channel?.close(); peer?.close(); audio.pause(); audio.srcObject = null;
    window.removeEventListener('pagehide', unload);
    if (error) options.onError(error);
    void closeRemote().finally(() => { options.onStatus('idle'); options.onEnd(); });
  }
  function unload() { finish(); }
  async function resumeAudio() {
    try { await audio.play(); options.onAudioBlocked(false); }
    catch { options.onAudioBlocked(true); }
  }
  window.addEventListener('pagehide', unload);
  options.onStatus('connecting');
  void (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (ended) { stream.getTracks().forEach(track => track.stop()); return; }
      peer = new RTCPeerConnection();
      peer.ontrack = event => { audio.srcObject = event.streams[0] ?? new MediaStream([event.track]); void resumeAudio(); };
      peer.onconnectionstatechange = () => {
        if (peer?.connectionState === 'failed' || peer?.connectionState === 'disconnected') finish('Voice disconnected. Your saved conversation is still available.');
      };
      for (const track of stream.getTracks()) { track.enabled = false; peer.addTrack(track, stream); }
      channel = peer.createDataChannel('oai-events');
      channel.onopen = () => {
        if (ended) return;
        clearTimeout(setup);
        stream!.getTracks().forEach(track => { track.enabled = true; });
        options.onStatus('listening');
      };
      channel.onclose = () => { if (!ended) finish('Voice conversation ended.'); };
      let assistantText = '';
      channel.onmessage = ({ data }) => {
        if (ended) return;
        let event;
        try { event = JSON.parse(data); } catch { return; }
        if (event.type === 'input_audio_buffer.speech_started') { options.onStatus('listening'); assistantText = ''; }
        if (event.type === 'input_audio_buffer.speech_stopped' || event.type === 'response.created') options.onStatus('thinking');
        if (event.type === 'output_audio_buffer.started') options.onStatus('speaking');
        if (event.type === 'output_audio_buffer.stopped' || event.type === 'output_audio_buffer.cleared') options.onStatus('listening');
        if (event.type === 'conversation.item.input_audio_transcription.completed') options.onTranscript('user', event.transcript);
        if (event.type === 'response.output_audio_transcript.delta') { assistantText += event.delta; options.onTranscript('assistant', assistantText); }
        if (event.type === 'response.output_audio_transcript.done') { options.onTranscript('assistant', event.transcript); assistantText = ''; }
        if (event.type === 'error' || (event.type === 'response.done' && event.response?.status === 'failed')) finish('Voice encountered a problem. Check inventory before retrying any changes.');
      };
      const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
      if (ended) return;
      const response = await fetch('/api/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ threadId: options.threadId, sdp: offer.sdp }), signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Voice could not connect.');
      id = result.id;
      if (ended) { await closeRemote(); return; }
      await peer.setRemoteDescription({ type: 'answer', sdp: result.sdp });
      heartbeat = setInterval(() => {
        void fetch(`/api/voice/${id}/heartbeat`, { method: 'POST' }).then(r => { if (!r.ok) finish('Voice conversation ended.'); }).catch(() => finish('Connection lost. Your saved conversation is still available.'));
      }, 10000);
    } catch (error) {
      if (!ended) finish(error instanceof DOMException && error.name === 'NotAllowedError' ? 'Allow microphone access to talk to MISO.' : (error as Error).message);
    }
  })();
  return { stop: () => finish(), resumeAudio };
}
