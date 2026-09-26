// Runs on the audio thread. Collects raw stereo samples and posts them to the
// offscreen page in ~4096-frame batches so the main thread isn't flooded.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 4096;
    this.left = new Float32Array(this.size);
    this.right = new Float32Array(this.size);
    this.fill = 0;
    this.active = true;
    this.port.onmessage = (e) => {
      if (e.data.type === 'pause') this.active = false;
      if (e.data.type === 'resume') this.active = true;
      if (e.data.type === 'flush') {
        this.post();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  post() {
    if (!this.fill) return;
    const l = this.left.slice(0, this.fill);
    const r = this.right.slice(0, this.fill);
    this.port.postMessage({ type: 'data', left: l, right: r }, [l.buffer, r.buffer]);
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!this.active || !input || !input.length) return true;
    const l = input[0];
    const r = input[1] || input[0];
    for (let i = 0; i < l.length; i++) {
      this.left[this.fill] = l[i];
      this.right[this.fill] = r[i];
      if (++this.fill === this.size) this.post();
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
