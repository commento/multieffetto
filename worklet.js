class GranularStretchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = [];
    this.length = 0;
    this.sourceRate = sampleRate;
    this.position = 0;
    this.stretch = 1;
    this.pitch = 1;
    this.reverse = false;
    this.playing = false;
    this.grains = [];
    this.samplesUntilGrain = 0;
    this.grainSize = 2048;
    this.hopOut = 512;
    this.reportCountdown = 0;

    this.port.onmessage = ({ data }) => {
      if (data.type === 'load') {
        this.channels = data.channels.map(buffer => new Float32Array(buffer));
        this.length = data.length;
        this.sourceRate = data.sampleRate;
        this.position = 0;
        this.grains = [];
        this.playing = false;
        this.port.postMessage({ type: 'position', position: 0, duration: this.length / this.sourceRate });
      } else if (data.type === 'play') {
        if (this.reverse && (this.position <= 0 || this.position >= this.length)) this.position = this.length - 1;
        if (!this.reverse && (this.position >= this.length - 1 || this.position < 0)) this.position = 0;
        this.playing = true;
      } else if (data.type === 'pause') {
        this.playing = false;
      } else if (data.type === 'stop') {
        this.playing = false;
        this.position = 0;
        this.grains = [];
        this.port.postMessage({ type: 'position', position: 0, duration: this.length / this.sourceRate });
      } else if (data.type === 'stretch') {
        this.stretch = Math.max(0.5, Math.min(2, data.value));
      } else if (data.type === 'pitch') {
        const semitones = Math.max(-12, Math.min(12, data.semitones));
        this.pitch = Math.pow(2, semitones / 12);
      } else if (data.type === 'reverse') {
        this.reverse = Boolean(data.value);
        if (this.reverse && this.position >= this.length) this.position = this.length - 1;
        if (!this.reverse && this.position < 0) this.position = 0;
      } else if (data.type === 'seek') {
        this.position = Math.max(0, Math.min(this.length - 1, data.ratio * this.length));
        this.grains = [];
      }
    };
  }

  read(channel, position) {
    const data = this.channels[Math.min(channel, this.channels.length - 1)];
    if (!data || position < 0 || position >= data.length - 1) return 0;
    const index = Math.floor(position);
    const fraction = position - index;
    return data[index] + (data[index + 1] - data[index]) * fraction;
  }

  spawnGrain() {
    const direction = this.reverse ? -1 : 1;
    this.grains.push({ sourceStart: this.position, age: 0, pitch: this.pitch, direction });
    const rateConversion = this.sourceRate / sampleRate;
    this.position += direction * (this.hopOut / this.stretch) * rateConversion;
    if (this.position >= this.length) {
      this.position = this.length;
    } else if (this.position < 0) {
      this.position = -1;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output?.length) return true;

    for (let i = 0; i < output[0].length; i++) {
      if (this.playing && this.channels.length) {
        const hasSource = this.reverse ? this.position >= 0 : this.position < this.length;
        if (this.samplesUntilGrain <= 0 && hasSource) {
          this.spawnGrain();
          this.samplesUntilGrain = this.hopOut;
        }

        for (const grain of this.grains) {
          const phase = grain.age / this.grainSize;
          const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
          const sourcePosition = grain.sourceStart + grain.direction * grain.age * (this.sourceRate / sampleRate) * grain.pitch;
          for (let channel = 0; channel < output.length; channel++) {
            output[channel][i] += this.read(channel, sourcePosition) * window * 0.67;
          }
          grain.age++;
        }

        this.grains = this.grains.filter(grain => grain.age < this.grainSize);
        this.samplesUntilGrain--;

        const reachedEnd = this.reverse ? this.position < 0 : this.position >= this.length;
        if (reachedEnd && this.grains.length === 0) {
          this.playing = false;
          this.port.postMessage({ type: 'ended' });
        }
      }

      if (--this.reportCountdown <= 0) {
        this.reportCountdown = Math.floor(sampleRate / 20);
        this.port.postMessage({
          type: 'position',
          position: Math.max(0, Math.min(this.length, this.position)) / this.sourceRate,
          duration: this.length / this.sourceRate
        });
      }
    }
    return true;
  }
}

registerProcessor('granular-stretch', GranularStretchProcessor);
