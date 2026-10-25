import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startVoiceConversation } from '../src/voice-conversation.ts';

test('proactive WebRTC starts only after readiness, reuses permission, and releases only the call microphone', async () => {
  const globals = globalThis as any;
  const originals = new Map(['window', 'RTCPeerConnection', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const statuses: string[] = [];
  const requests: { url: string; body: any }[] = [];
  let track = { enabled: false, stopped: false, stop() { this.stopped = true; } };
  let originalStopped = false, ended = false, cloneCount = 0;
  const microphone = { clone() { cloneCount++; track = { enabled: false, stopped: false, stop() { this.stopped = true; } }; return { getTracks: () => [track] }; }, getTracks: () => [{ stop() { originalStopped = true; } }] };
  const audio = { autoplay: false, srcObject: null, pause() {}, async play() {} };
  let channel: any;
  class Peer {
    ontrack: unknown; onconnectionstatechange: unknown; connectionState = 'connected';
    addTrack(value: typeof track) { assert.equal(value.enabled, false); }
    createDataChannel() { return channel = { onopen: () => {}, onclose: () => {}, close() {} }; }
    async createOffer() { return { sdp: 'v=0-test-offer' }; }
    async setLocalDescription() {}
    async setRemoteDescription() { assert.equal(requests.at(-1)!.url, '/api/voice'); channel.onopen(); }
    close() {}
  }
  Object.defineProperty(globals, 'window', { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globals, 'RTCPeerConnection', { configurable: true, value: Peer });
  globals.fetch = async (url: string, options: RequestInit) => {
    requests.push({ url, body: options?.body ? JSON.parse(String(options.body)) : null });
    return url === '/api/voice' ? Response.json({ id: 'call-one', sdp: 'v=0-answer' }) : new Response(null, { status: 204 });
  };
  let call: ReturnType<typeof startVoiceConversation> | undefined;
  try {
    call = startVoiceConversation({ threadId: 'thread-one', recordingId: 'door-one', microphone: microphone as unknown as MediaStream, audio: audio as unknown as HTMLAudioElement,
      onStatus: status => { statuses.push(status); }, onTranscript() {}, onError: message => assert.fail(message), onAudioBlocked() {}, onEnd: () => { ended = true; } });
    for (let i = 0; i < 20 && !requests.some(r => r.url.endsWith('/ready')); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(cloneCount, 1); assert.equal(track.enabled, true);
    assert.equal(requests[0].body.recordingId, 'door-one');
    assert.ok(requests.some(r => r.url === '/api/voice/call-one/ready'));
    await call.doorOpened('door-two'); assert.equal(requests.at(-1)!.body.recordingId, 'door-two');
    channel.onmessage({ data: JSON.stringify({ type: 'response.done', response: { status: 'completed', output: [{ type: 'function_call', name: 'end_call', arguments: '{ }' }] } }) });
    assert.equal(track.enabled, false); assert.equal(statuses.at(-1), 'ending');
    channel.onclose();
    for (let i = 0; i < 20 && !ended; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(ended, true); assert.equal(track.stopped, true); assert.equal(originalStopped, false);
    const firstTrack = track;
    ended = false;
    call = startVoiceConversation({ threadId: 'thread-one', recordingId: 'door-three', microphone: microphone as unknown as MediaStream, audio: audio as unknown as HTMLAudioElement,
      onStatus: status => { statuses.push(status); }, onTranscript() {}, onError: message => assert.fail(message), onAudioBlocked() {}, onEnd: () => { ended = true; } });
    for (let i = 0; i < 20 && requests.filter(r => r.url.endsWith('/ready')).length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(cloneCount, 2); assert.notEqual(track, firstTrack); assert.equal(track.enabled, true);
    assert.equal(requests.filter(r => r.url === '/api/voice').at(-1)!.body.recordingId, 'door-three');
    call.stop();
    for (let i = 0; i < 20 && !ended; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(track.stopped, true); assert.equal(originalStopped, false);

  } finally {
    call?.stop();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globals, key, descriptor); else delete globals[key]; }
  }
});
