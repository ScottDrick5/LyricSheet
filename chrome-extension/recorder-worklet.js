// Runs on the audio thread. Collects raw stereo samples and posts them to the
// offscreen page in ~4096-frame batches so the main thread isn't flooded.
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 4096;
    this.left = new Float32Array(this.size);
    this.right = new Float32Array(this.size);
    this.fill = 0;
    this.startFrame = 0;  // audio-clock frame of the first sample in the batch
    this.active = true;
    this.port.onmessage = (e) => {
      if (e.data.type === 'pause') {
        this.post();
        this.active = false;
      }
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
    this.port.postMessage({ type: 'data', left: l, right: r, frame: this.startFrame }, [l.buffer, r.buffer]);
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!this.active || !input || !input.length) return true;
    const l = input[0];
    const r = input[1] || input[0];
    // Keep each batch continuous on the audio clock (after a gap in input).
    if (this.fill && currentFrame !== this.startFrame + this.fill) this.post();
    for (let i = 0; i < l.length; i++) {
      if (this.fill === 0) this.startFrame = currentFrame + i;
      this.left[this.fill] = l[i];
      this.right[this.fill] = r[i];
      if (++this.fill === this.size) this.post();
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
