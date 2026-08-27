class GenesisAudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Float32Array(2048);
    this.offset = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    if (input?.length) {
      let sourceOffset = 0;
      while (sourceOffset < input.length) {
        const length = Math.min(input.length - sourceOffset, this.pending.length - this.offset);
        this.pending.set(input.subarray(sourceOffset, sourceOffset + length), this.offset);
        this.offset += length;
        sourceOffset += length;
        if (this.offset === this.pending.length) {
          const frame = this.pending;
          this.port.postMessage(frame, [frame.buffer]);
          this.pending = new Float32Array(2048);
          this.offset = 0;
        }
      }
    }
    for (const output of outputs[0] || []) output.fill(0);
    return true;
  }
}

registerProcessor('genesis-audio-capture', GenesisAudioCaptureProcessor);

