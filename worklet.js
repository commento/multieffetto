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
    this.randomEnabled = false;
    this.randomCadence = 0.5;
    this.randomLength = 0.2;
    this.randomCountdown = 0;
    this.randomSliceStart = 0;
    this.randomSliceEnd = 0;
    this.playing = false;
    this.grains = [];
    this.samplesUntilGrain = 0;
    // Otto grani sovrapposti danno una tessitura molto più continua rispetto
    // alla vecchia configurazione a quattro grani, soprattutto su voci e pad.
    this.grainSize = 4096;
    this.hopOut = 512;
    this.windowGain = this.hopOut * 2 / this.grainSize;
    this.reportCountdown = 0;

    this.port.onmessage = ({ data }) => {
      if (data.type === 'load') {
        this.channels = data.channels.map(buffer => new Float32Array(buffer));
        this.length = data.length;
        this.sourceRate = data.sampleRate;
        this.position = 0;
        this.grains = [];
        this.randomCountdown = 0;
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
        this.randomCountdown = 0;
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
      } else if (data.type === 'random') {
        this.randomEnabled = Boolean(data.enabled);
        this.randomCountdown = 0;
        this.grains = [];
        this.samplesUntilGrain = 0;
      } else if (data.type === 'randomCadence') {
        this.randomCadence = Math.max(0.05, Math.min(4, data.value));
      } else if (data.type === 'randomLength') {
        this.randomLength = Math.max(0.02, Math.min(2, data.value));
        this.randomCountdown = 0;
      } else if (data.type === 'seek') {
        this.position = Math.max(0, Math.min(this.length - 1, data.ratio * this.length));
        this.grains = [];
      }
    };
  }

  sample(channel, index, sliceStart, sliceEnd) {
    const data = this.channels[Math.min(channel, this.channels.length - 1)];
    if (!data) return 0;
    if (sliceEnd > sliceStart) {
      const sliceLength = sliceEnd - sliceStart;
      index = sliceStart + ((index - sliceStart) % sliceLength + sliceLength) % sliceLength;
    }
    if (index < 0 || index >= data.length) return 0;
    return data[index];
  }

  readCubic(channel, position, sliceStart, sliceEnd) {
    const index = Math.floor(position);
    const fraction = position - index;
    const a = this.sample(channel, index - 1, sliceStart, sliceEnd);
    const b = this.sample(channel, index, sliceStart, sliceEnd);
    const c = this.sample(channel, index + 1, sliceStart, sliceEnd);
    const d = this.sample(channel, index + 2, sliceStart, sliceEnd);
    const c0 = b;
    const c1 = 0.5 * (c - a);
    const c2 = a - 2.5 * b + 2 * c - 0.5 * d;
    const c3 = 0.5 * (d - a) + 1.5 * (b - c);
    return ((c3 * fraction + c2) * fraction + c1) * fraction + c0;
  }

  read(channel, position, step, sliceStart, sliceEnd) {
    // Quando si alza il pitch si saltano campioni. Un piccolo interpolatore
    // sinc a banda limitata evita che le alte frequenze si ripieghino in alias.
    if (step <= 1.02) return this.readCubic(channel, position, sliceStart, sliceEnd);

    const radius = 6;
    const cutoff = 1 / step;
    const center = Math.floor(position);
    let value = 0;
    let weightSum = 0;
    for (let offset = -radius + 1; offset <= radius; offset++) {
      const distance = position - (center + offset);
      if (Math.abs(distance) >= radius) continue;
      const sincArgument = Math.PI * cutoff * distance;
      const sinc = Math.abs(sincArgument) < 1e-7 ? 1 : Math.sin(sincArgument) / sincArgument;
      const window = 0.5 + 0.5 * Math.cos(Math.PI * distance / radius);
      const weight = cutoff * sinc * window;
      value += this.sample(channel, center + offset, sliceStart, sliceEnd) * weight;
      weightSum += weight;
    }
    return weightSum ? value / weightSum : 0;
  }

  alignGrainStart(expectedStart, step, direction, sliceStart, sliceEnd) {
    const previous = this.grains[this.grains.length - 1];
    if (!previous) return expectedStart;

    const referenceStart = previous.sourceStart + previous.direction * previous.age * previous.step;
    const searchRadius = 96;
    const searchStep = 4;
    const compareLength = 128;
    const compareStep = 4;
    let bestStart = expectedStart;
    let bestScore = -Infinity;

    for (let offset = -searchRadius; offset <= searchRadius; offset += searchStep) {
      const candidateStart = expectedStart + direction * offset;
      let correlation = 0;
      let referenceEnergy = 0;
      let candidateEnergy = 0;
      for (let age = 0; age < compareLength; age += compareStep) {
        const reference = this.readCubic(0, referenceStart + direction * age * step, previous.sliceStart, previous.sliceEnd);
        const candidate = this.readCubic(0, candidateStart + direction * age * step, sliceStart, sliceEnd);
        correlation += reference * candidate;
        referenceEnergy += reference * reference;
        candidateEnergy += candidate * candidate;
      }
      if (referenceEnergy < 1e-8 || candidateEnergy < 1e-8) continue;
      const normalized = correlation / Math.sqrt(referenceEnergy * candidateEnergy);
      const score = normalized - Math.abs(offset) / searchRadius * 0.025;
      if (score > bestScore) {
        bestScore = score;
        bestStart = candidateStart;
      }
    }
    return bestStart;
  }

  spawnGrain() {
    const direction = this.reverse ? -1 : 1;
    const rateConversion = this.sourceRate / sampleRate;
    const step = rateConversion * this.pitch;
    const sliceStart = this.randomEnabled ? this.randomSliceStart : undefined;
    const sliceEnd = this.randomEnabled ? this.randomSliceEnd : undefined;
    const sourceStart = this.alignGrainStart(this.position, step, direction, sliceStart, sliceEnd);
    this.grains.push({
      sourceStart,
      age: 0,
      step,
      direction,
      sliceStart,
      sliceEnd
    });
    this.position += direction * (this.hopOut / this.stretch) * rateConversion;
    if (this.randomEnabled && sliceEnd > sliceStart) {
      const sliceLength = sliceEnd - sliceStart;
      this.position = sliceStart + ((this.position - sliceStart) % sliceLength + sliceLength) % sliceLength;
    } else if (this.position >= this.length) {
      this.position = this.length;
    } else if (this.position < 0) {
      this.position = -1;
    }
  }

  chooseRandomSlice() {
    const sliceFrames = Math.max(1, Math.min(this.length, Math.round(this.randomLength * this.sourceRate)));
    const maxStart = Math.max(0, this.length - sliceFrames);
    this.randomSliceStart = Math.floor(Math.random() * (maxStart + 1));
    this.randomSliceEnd = this.randomSliceStart + sliceFrames;
    this.position = this.reverse ? this.randomSliceEnd - 1 : this.randomSliceStart;
    this.grains = [];
    this.samplesUntilGrain = 0;
    this.randomCountdown = Math.max(1, Math.round(this.randomCadence * sampleRate));
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output?.length) return true;

    for (let i = 0; i < output[0].length; i++) {
      if (this.playing && this.channels.length) {
        if (this.randomEnabled) {
          if (this.randomCountdown <= 0) this.chooseRandomSlice();
          this.randomCountdown--;
        }
        const hasSource = this.randomEnabled || (this.reverse ? this.position >= 0 : this.position < this.length);
        if (this.samplesUntilGrain <= 0 && hasSource) {
          this.spawnGrain();
          this.samplesUntilGrain = this.hopOut;
        }

        for (const grain of this.grains) {
          const phase = grain.age / this.grainSize;
          const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
          const sourcePosition = grain.sourceStart + grain.direction * grain.age * grain.step;
          for (let channel = 0; channel < output.length; channel++) {
            output[channel][i] += this.read(channel, sourcePosition, grain.step, grain.sliceStart, grain.sliceEnd) * window * this.windowGain;
          }
          grain.age++;
        }

        this.grains = this.grains.filter(grain => grain.age < this.grainSize);
        this.samplesUntilGrain--;

        const reachedEnd = this.reverse ? this.position < 0 : this.position >= this.length;
        if (!this.randomEnabled && reachedEnd && this.grains.length === 0) {
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
