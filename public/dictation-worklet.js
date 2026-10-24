// Convert the browser's actual sample rate to mono PCM16 at 24 kHz.
class DictationProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Int16Array(4800);
    this.length = 0;
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data === 'stop') {
        this.stopped = true;
        this.flush();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }
  flush() {
    if (!this.length) return;
    const bytes = this.buffer.slice(0, this.length).buffer;
    this.port.postMessage({ type: 'audio', bytes }, [bytes]);
    this.length = 0;
  }
  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const value of input) {
      this.sum += value;
      this.count++;
      this.phase += 24000;
      if (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        const sample = Math.max(-1, Math.min(1, this.sum / this.count));
        this.buffer[this.length++] = Math.round(sample * (sample < 0 ? 32768 : 32767));
        this.sum = 0;
        this.count = 0;
        if (this.length === this.buffer.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('dictation-pcm', DictationProcessor);
