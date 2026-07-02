import { decodeAiff } from './aiff-decoder.mjs';

const $ = id => document.getElementById(id);
const controls = {
  file: $('fileInput'), play: $('playButton'), pause: $('pauseButton'), stop: $('stopButton'), reverse: $('reverseButton'),
  position: $('position'), stretch: $('stretch'), pitch: $('pitch'), delayTime: $('delayTime'),
  feedback: $('feedback'), delayMix: $('delayMix'), reverbSize: $('reverbSize'),
  reverbMix: $('reverbMix'), drive: $('drive'), distMix: $('distMix'),
  eqLow: $('eqLow'), eqMid: $('eqMid'), eqHigh: $('eqHigh'),
  random: $('randomButton'), randomCadence: $('randomCadence'), randomLength: $('randomLength')
};

const presetControls = ['stretch', 'pitch', 'randomCadence', 'randomLength', 'eqLow', 'eqMid', 'eqHigh', 'delayTime', 'feedback', 'delayMix', 'reverbSize', 'reverbMix', 'drive', 'distMix'];
const PRESET_STORAGE_KEY = 'multieffetto-presets-v1';
const effectLabels = { eq: 'EQ', distortion: 'Distorsione', delay: 'Delay', reverb: 'Riverbero' };
let effectOrder = ['eq', 'distortion', 'delay', 'reverb'];

let context;
let player;
let graph;
let loaded = false;
let seeking = false;
let decodedDuration = 0;
let delayChangeTimer;
let applyingPreset = false;
let routingTimer;
let reversed = false;
let randomEnabled = false;
let sampleLoadPromise = null;
let waveformPeaks = null;

function buildWaveformPeaks(buffer, resolution = 2400) {
  const bins = Math.min(resolution, buffer.length);
  const minimum = new Float32Array(bins);
  const maximum = new Float32Array(bins);
  const channels = Array.from(
    { length: buffer.numberOfChannels },
    (_, channel) => buffer.getChannelData(channel)
  );
  let absolutePeak = 0;

  for (let bin = 0; bin < bins; bin++) {
    const start = Math.floor(bin * buffer.length / bins);
    const end = Math.max(start + 1, Math.floor((bin + 1) * buffer.length / bins));
    let low = 1;
    let high = -1;
    for (const channel of channels) {
      for (let sample = start; sample < end; sample++) {
        const value = channel[sample];
        if (value < low) low = value;
        if (value > high) high = value;
      }
    }
    minimum[bin] = low;
    maximum[bin] = high;
    absolutePeak = Math.max(absolutePeak, Math.abs(low), Math.abs(high));
  }

  return { minimum, maximum, absolutePeak: absolutePeak || 1 };
}

function drawWaveform() {
  const canvas = $('waveform');
  const bounds = canvas.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.round(bounds.width * scale);
  canvas.height = Math.round(bounds.height * scale);
  const drawing = canvas.getContext('2d');
  drawing.scale(scale, scale);
  drawing.clearRect(0, 0, bounds.width, bounds.height);

  const center = bounds.height / 2;
  drawing.strokeStyle = '#282622';
  drawing.lineWidth = 1;
  drawing.beginPath();
  drawing.moveTo(0, center + 0.5);
  drawing.lineTo(bounds.width, center + 0.5);
  drawing.stroke();
  if (!waveformPeaks) return;

  const { minimum, maximum, absolutePeak } = waveformPeaks;
  drawing.strokeStyle = '#8d8981';
  drawing.lineWidth = 1;
  drawing.beginPath();
  for (let x = 0; x < Math.ceil(bounds.width); x++) {
    const first = Math.floor(x * minimum.length / bounds.width);
    const last = Math.max(first + 1, Math.ceil((x + 1) * minimum.length / bounds.width));
    let low = 1;
    let high = -1;
    for (let bin = first; bin < Math.min(last, minimum.length); bin++) {
      low = Math.min(low, minimum[bin]);
      high = Math.max(high, maximum[bin]);
    }
    const top = center - high / absolutePeak * (center - 5);
    const bottom = center - low / absolutePeak * (center - 5);
    drawing.moveTo(x + 0.5, top);
    drawing.lineTo(x + 0.5, bottom);
  }
  drawing.stroke();
}

function setWaveform(buffer) {
  waveformPeaks = buffer ? buildWaveformPeaks(buffer) : null;
  drawWaveform();
}

if ('ResizeObserver' in window) {
  new ResizeObserver(drawWaveform).observe($('waveform'));
} else {
  window.addEventListener('resize', drawWaveform);
}

async function ensureAudio() {
  if (context) {
    if (context.state === 'suspended') await context.resume();
    return;
  }

  context = new AudioContext({ latencyHint: 'interactive' });
  await context.audioWorklet.addModule('worklet.js?v=3');
  player = new AudioWorkletNode(context, 'granular-stretch', {
    outputChannelCount: [2]
  });

  const distortionDry = context.createGain();
  const distortionWet = context.createGain();
  const shaper = context.createWaveShaper();
  const distortionInput = context.createGain();
  const distortionBus = context.createGain();
  shaper.oversample = '4x';

  const eqInput = context.createGain();
  const eqLow = context.createBiquadFilter();
  const eqMid = context.createBiquadFilter();
  const eqHigh = context.createBiquadFilter();
  const eqBus = context.createGain();
  eqLow.type = 'lowshelf';
  eqLow.frequency.value = 160;
  eqMid.type = 'peaking';
  eqMid.frequency.value = 1000;
  eqMid.Q.value = 0.8;
  eqHigh.type = 'highshelf';
  eqHigh.frequency.value = 6500;

  const delayDry = context.createGain();
  const delayInputs = [context.createGain(), context.createGain()];
  const delayWets = [context.createGain(), context.createGain()];
  const delays = [context.createDelay(2), context.createDelay(2)];
  const feedbacks = [context.createGain(), context.createGain()];
  const delayInput = context.createGain();
  const delayBus = context.createGain();

  const reverbDry = context.createGain();
  const reverbWet = context.createGain();
  const convolver = context.createConvolver();
  const reverbInput = context.createGain();
  const reverbBus = context.createGain();
  const master = context.createGain();
  master.gain.value = 0.82;

  distortionInput.connect(distortionDry).connect(distortionBus);
  distortionInput.connect(shaper).connect(distortionWet).connect(distortionBus);
  eqInput.connect(eqLow).connect(eqMid).connect(eqHigh).connect(eqBus);
  delayInput.connect(delayDry).connect(delayBus);
  for (let i = 0; i < 2; i++) {
    delayInput.connect(delayInputs[i]).connect(delays[i]).connect(delayWets[i]).connect(delayBus);
    delays[i].connect(feedbacks[i]).connect(delays[i]);
  }
  // Entrambe le linee restano alimentate: quella nascosta è già piena di audio
  // quando viene portata in primo piano, evitando buchi durante il cambio.
  delayInputs[0].gain.value = 1;
  delayInputs[1].gain.value = 1;
  delayWets[1].gain.value = 0;
  reverbInput.connect(reverbDry).connect(reverbBus);
  reverbInput.connect(convolver).connect(reverbWet).connect(reverbBus);
  master.connect(context.destination);

  graph = { distortionDry, distortionWet, shaper, delayDry, delayInputs, delayWets,
    delays, feedbacks, activeDelay: 0, reverbDry, reverbWet, convolver, master,
    eqFilters: { low: eqLow, mid: eqMid, high: eqHigh },
    stages: {
      eq: { input: eqInput, output: eqBus },
      distortion: { input: distortionInput, output: distortionBus },
      delay: { input: delayInput, output: delayBus },
      reverb: { input: reverbInput, output: reverbBus }
    } };
  routeEffects(false);
  updateAllEffects();

  player.port.onmessage = ({ data }) => {
    if (data.type === 'position' && !seeking) updateTimeline(data.position, data.duration);
    if (data.type === 'ended') {
      setPlaying(false);
      updateTimeline(reversed ? 0 : decodedDuration, decodedDuration);
    }
  };
}

function routeEffects(smooth = true) {
  if (!graph || !player) return;
  const connectChain = () => {
    player.disconnect();
    Object.values(graph.stages).forEach(stage => stage.output.disconnect());
    player.connect(graph.stages[effectOrder[0]].input);
    for (let i = 0; i < effectOrder.length - 1; i++) {
      graph.stages[effectOrder[i]].output.connect(graph.stages[effectOrder[i + 1]].input);
    }
    graph.stages[effectOrder[effectOrder.length - 1]].output.connect(graph.master);
  };

  if (!smooth) {
    connectChain();
    return;
  }

  clearTimeout(routingTimer);
  const now = context.currentTime;
  graph.master.gain.cancelScheduledValues(now);
  graph.master.gain.setValueAtTime(graph.master.gain.value, now);
  graph.master.gain.linearRampToValueAtTime(0, now + 0.015);
  routingTimer = setTimeout(() => {
    connectChain();
    const resumeAt = context.currentTime;
    graph.master.gain.cancelScheduledValues(resumeAt);
    graph.master.gain.setValueAtTime(0, resumeAt);
    graph.master.gain.linearRampToValueAtTime(0.82, resumeAt + 0.02);
  }, 18);
}

function setPlaying(value) {
  controls.play.classList.toggle('active', value);
  $('audioStatus').classList.toggle('live', value);
  $('audioStatus').lastChild.textContent = value ? ' in riproduzione' : ' pronto';
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00.0';
  const minutes = Math.floor(seconds / 60);
  const remainder = (seconds % 60).toFixed(1).padStart(4, '0');
  return `${minutes}:${remainder}`;
}

function updateTimeline(position, duration = decodedDuration) {
  decodedDuration = duration || decodedDuration;
  controls.position.value = decodedDuration ? position / decodedDuration : 0;
  $('currentTime').textContent = formatTime(position);
  $('duration').textContent = formatTime(decodedDuration);
}

function equalPowerMix(value, dry, wet) {
  dry.gain.setTargetAtTime(Math.cos(value * Math.PI / 2), context.currentTime, 0.01);
  wet.gain.setTargetAtTime(Math.sin(value * Math.PI / 2), context.currentTime, 0.01);
}

function updateDelayMix(value) {
  const now = context.currentTime;
  const wetLevel = Math.sin(value * Math.PI / 2);
  graph.delayDry.gain.setTargetAtTime(Math.cos(value * Math.PI / 2), now, 0.01);
  graph.delayWets.forEach((wet, index) => {
    wet.gain.setTargetAtTime(index === graph.activeDelay ? wetLevel : 0, now, 0.01);
  });
}

function switchDelayTime(value) {
  const now = context.currentTime;
  const fadeTime = 0.05;
  const previous = graph.activeDelay;
  const next = previous === 0 ? 1 : 0;
  const wetLevel = Math.sin(+controls.delayMix.value * Math.PI / 2);

  graph.delays[next].delayTime.cancelScheduledValues(now);
  graph.delays[next].delayTime.setValueAtTime(value, now);

  graph.delayWets[previous].gain.cancelScheduledValues(now);
  graph.delayWets[next].gain.cancelScheduledValues(now);
  graph.delayWets[previous].gain.setValueAtTime(wetLevel, now);
  graph.delayWets[next].gain.setValueAtTime(0, now);
  graph.delayWets[previous].gain.linearRampToValueAtTime(0, now + fadeTime);
  graph.delayWets[next].gain.linearRampToValueAtTime(wetLevel, now + fadeTime);
  graph.activeDelay = next;
}

function scheduleDelayTime(value) {
  clearTimeout(delayChangeTimer);
  delayChangeTimer = setTimeout(() => switchDelayTime(value), 60);
}

function distortionCurve(db) {
  const samples = 8192;
  const curve = new Float32Array(samples);
  const gain = Math.pow(10, db / 20);
  const normalizer = Math.tanh(gain);
  for (let i = 0; i < samples; i++) {
    const x = i * 2 / (samples - 1) - 1;
    curve[i] = Math.tanh(x * gain) / normalizer;
  }
  return curve;
}

function makeImpulse(seconds) {
  const length = Math.floor(context.sampleRate * seconds);
  const impulse = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const envelope = Math.pow(1 - i / length, 2.4);
      data[i] = (Math.random() * 2 - 1) * envelope;
    }
  }
  return impulse;
}

function updateAllEffects() {
  if (!graph) return;
  player.port.postMessage({ type: 'stretch', value: +controls.stretch.value });
  player.port.postMessage({ type: 'pitch', semitones: +controls.pitch.value });
  player.port.postMessage({ type: 'reverse', value: reversed });
  player.port.postMessage({ type: 'random', enabled: randomEnabled });
  player.port.postMessage({ type: 'randomCadence', value: +controls.randomCadence.value });
  player.port.postMessage({ type: 'randomLength', value: +controls.randomLength.value });
  graph.delays.forEach(delay => delay.delayTime.value = +controls.delayTime.value);
  graph.feedbacks.forEach(feedback => feedback.gain.value = +controls.feedback.value);
  updateDelayMix(+controls.delayMix.value);
  equalPowerMix(+controls.reverbMix.value, graph.reverbDry, graph.reverbWet);
  equalPowerMix(+controls.distMix.value, graph.distortionDry, graph.distortionWet);
  graph.shaper.curve = distortionCurve(+controls.drive.value);
  graph.convolver.buffer = makeImpulse(+controls.reverbSize.value);
  graph.eqFilters.low.gain.value = +controls.eqLow.value;
  graph.eqFilters.mid.gain.value = +controls.eqMid.value;
  graph.eqFilters.high.gain.value = +controls.eqHigh.value;
}

async function loadSample(file) {
  if (!file) return;
  loaded = false;
  setWaveform(null);
  try {
    await ensureAudio();
    const fileData = await file.arrayBuffer();
    let buffer;
    try {
      // Safari puo rifiutare alcuni AIFF/AIFC anche se Web Audio li supporta
      // parzialmente. Conserviamo il decoder nativo come percorso principale.
      buffer = await context.decodeAudioData(fileData.slice(0));
    } catch (nativeError) {
      try {
        buffer = decodeAiff(fileData, context);
      } catch {
        throw nativeError;
      }
    }
    const channels = [];
    for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i).slice().buffer);
    player.port.postMessage({
      type: 'load', channels, length: buffer.length, sampleRate: buffer.sampleRate
    }, channels);
    setWaveform(buffer);
    loaded = true;
    decodedDuration = buffer.duration;
    $('sampleName').textContent = file.name;
    $('sampleMeta').textContent = `${buffer.numberOfChannels === 1 ? 'Mono' : 'Stereo'} · ${(buffer.sampleRate / 1000).toFixed(1)} kHz · ${formatTime(buffer.duration)}`;
    updateTimeline(0, buffer.duration);
    setPlaying(false);
  } catch (error) {
    console.error(error);
    $('sampleName').textContent = 'Formato non supportato';
    $('sampleMeta').textContent = 'Prova WAV, MP3, M4A oppure AIFF PCM';
  }
}

controls.file.addEventListener('change', event => {
  const file = event.target.files[0];
  if (!file) return;
  sampleLoadPromise = loadSample(file).finally(() => {
    sampleLoadPromise = null;
  });
});

controls.play.addEventListener('click', async () => {
  if (sampleLoadPromise) await sampleLoadPromise;
  if (!loaded) return controls.file.click();
  await ensureAudio();
  player.port.postMessage({ type: 'play' });
  setPlaying(true);
});
controls.pause.addEventListener('click', () => {
  if (!player) return;
  player.port.postMessage({ type: 'pause' });
  setPlaying(false);
});
controls.stop.addEventListener('click', () => {
  if (!player) return;
  player.port.postMessage({ type: 'stop' });
  setPlaying(false);
});

function setReverse(value, markManual = true) {
  reversed = Boolean(value);
  controls.reverse.classList.toggle('active', reversed);
  controls.reverse.setAttribute('aria-pressed', String(reversed));
  player?.port.postMessage({ type: 'reverse', value: reversed });
  if (markManual && !applyingPreset) {
    $('presetSelect').value = '';
    $('deletePresetButton').disabled = true;
  }
}

controls.reverse.addEventListener('click', () => setReverse(!reversed));

function setRandom(value, markManual = true) {
  randomEnabled = Boolean(value);
  controls.random.classList.toggle('active', randomEnabled);
  controls.random.setAttribute('aria-pressed', String(randomEnabled));
  controls.random.textContent = randomEnabled ? 'ON' : 'OFF';
  player?.port.postMessage({ type: 'random', enabled: randomEnabled });
  if (markManual && !applyingPreset) {
    $('presetSelect').value = '';
    $('deletePresetButton').disabled = true;
  }
}

controls.random.addEventListener('click', () => setRandom(!randomEnabled));
controls.position.addEventListener('pointerdown', () => seeking = true);
controls.position.addEventListener('input', () => {
  $('currentTime').textContent = formatTime(+controls.position.value * decodedDuration);
});
controls.position.addEventListener('change', () => {
  player?.port.postMessage({ type: 'seek', ratio: +controls.position.value });
  seeking = false;
});

function bind(id, output, format, callback) {
  controls[id].addEventListener('input', () => {
    $(output).textContent = format(+controls[id].value);
    if (graph) callback?.(+controls[id].value);
  });
}
bind('stretch', 'stretchValue', value => `${value.toFixed(2)}×`, value => player.port.postMessage({ type: 'stretch', value }));
bind('pitch', 'pitchValue', value => `${value > 0 ? '+' : ''}${value} st`, value => player.port.postMessage({ type: 'pitch', semitones: value }));
bind('randomCadence', 'randomCadenceValue', value => `${Math.round(value * 1000)} ms`, value => player.port.postMessage({ type: 'randomCadence', value }));
bind('randomLength', 'randomLengthValue', value => `${Math.round(value * 1000)} ms`, value => player.port.postMessage({ type: 'randomLength', value }));
bind('delayTime', 'delayTimeValue', value => `${Math.round(value * 1000)} ms`, scheduleDelayTime);
bind('feedback', 'feedbackValue', value => `${Math.round(value * 100)}%`, value => graph.feedbacks.forEach(feedback => feedback.gain.setTargetAtTime(value, context.currentTime, 0.01)));
bind('delayMix', 'delayMixValue', value => `${Math.round(value * 100)}%`, updateDelayMix);
bind('reverbMix', 'reverbMixValue', value => `${Math.round(value * 100)}%`, value => equalPowerMix(value, graph.reverbDry, graph.reverbWet));
bind('drive', 'driveValue', value => `${value.toFixed(1)} dB`, value => graph.shaper.curve = distortionCurve(value));
bind('distMix', 'distMixValue', value => `${Math.round(value * 100)}%`, value => equalPowerMix(value, graph.distortionDry, graph.distortionWet));
bind('reverbSize', 'reverbSizeValue', value => `${value.toFixed(1)} s`);
const formatEqGain = value => `${value > 0 ? '+' : ''}${value.toFixed(value % 1 ? 1 : 0)} dB`;
bind('eqLow', 'eqLowValue', formatEqGain, value => graph.eqFilters.low.gain.setTargetAtTime(value, context.currentTime, 0.01));
bind('eqMid', 'eqMidValue', formatEqGain, value => graph.eqFilters.mid.gain.setTargetAtTime(value, context.currentTime, 0.01));
bind('eqHigh', 'eqHighValue', formatEqGain, value => graph.eqFilters.high.gain.setTargetAtTime(value, context.currentTime, 0.01));
controls.reverbSize.addEventListener('change', () => {
  if (graph) graph.convolver.buffer = makeImpulse(+controls.reverbSize.value);
});

const stretchShortcutButtons = document.querySelectorAll('[data-stretch]');
function updateStretchShortcuts() {
  stretchShortcutButtons.forEach(button => {
    const active = Math.abs(+button.dataset.stretch - +controls.stretch.value) < 0.001;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

stretchShortcutButtons.forEach(button => button.addEventListener('click', () => {
  controls.stretch.value = button.dataset.stretch;
  controls.stretch.dispatchEvent(new Event('input', { bubbles: true }));
}));
controls.stretch.addEventListener('input', updateStretchShortcuts);
updateStretchShortcuts();

const pitchShortcutButtons = document.querySelectorAll('[data-pitch]');
function updatePitchShortcuts() {
  pitchShortcutButtons.forEach(button => {
    const active = +button.dataset.pitch === +controls.pitch.value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

pitchShortcutButtons.forEach(button => button.addEventListener('click', () => {
  controls.pitch.value = button.dataset.pitch;
  controls.pitch.dispatchEvent(new Event('input', { bubbles: true }));
}));
controls.pitch.addEventListener('input', updatePitchShortcuts);
updatePitchShortcuts();

function normalizeEffectOrder(order) {
  if (!Array.isArray(order)) return null;
  const effects = Object.keys(effectLabels);
  if (order.length === effects.length && effects.every(effect => order.includes(effect))) return [...order];
  const legacyEffects = ['distortion', 'delay', 'reverb'];
  if (order.length === 3 && legacyEffects.every(effect => order.includes(effect))) return ['eq', ...order];
  return null;
}

function renderEffectChain() {
  const chain = $('effectChain');
  chain.replaceChildren();

  const fixed = document.createElement('span');
  fixed.className = 'chain-fixed';
  fixed.textContent = 'Stretch + Pitch';
  chain.append(fixed);

  effectOrder.forEach((effect, index) => {
    const stage = document.createElement('div');
    stage.className = 'chain-stage';

    const label = document.createElement('strong');
    label.textContent = effectLabels[effect];
    stage.append(label);

    const controlsContainer = document.createElement('div');
    controlsContainer.className = 'chain-controls';
    for (const [direction, symbol, description] of [[-1, '←', 'prima'], [1, '→', 'dopo']]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = symbol;
      button.disabled = index + direction < 0 || index + direction >= effectOrder.length;
      button.setAttribute('aria-label', `Sposta ${effectLabels[effect]} ${description}`);
      button.addEventListener('click', () => moveEffect(effect, direction));
      controlsContainer.append(button);
    }
    stage.append(controlsContainer);
    chain.append(stage);
  });

  const stretchCard = document.querySelector('[data-effect-card="stretch"]');
  const pitchCard = document.querySelector('[data-effect-card="pitch"]');
  stretchCard.style.order = 0;
  pitchCard.style.order = 1;
  pitchCard.querySelector('.effect-title span').textContent = '02';
  effectOrder.forEach((effect, index) => {
    const card = document.querySelector(`[data-effect-card="${effect}"]`);
    card.style.order = index + 2;
    card.querySelector('.effect-title span').textContent = String(index + 3).padStart(2, '0');
  });
}

function moveEffect(effect, direction) {
  const current = effectOrder.indexOf(effect);
  const destination = current + direction;
  if (destination < 0 || destination >= effectOrder.length) return;
  [effectOrder[current], effectOrder[destination]] = [effectOrder[destination], effectOrder[current]];
  renderEffectChain();
  routeEffects();
  if (!applyingPreset) {
    $('presetSelect').value = '';
    $('deletePresetButton').disabled = true;
  }
  showPresetStatus(`Catena: ${effectOrder.map(effectName => effectLabels[effectName]).join(' / ')}`);
}

renderEffectChain();

function readPresets() {
  try {
    return JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function writePresets(presets) {
  localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
}

function showPresetStatus(message) {
  $('presetStatus').textContent = message;
  clearTimeout(showPresetStatus.timer);
  showPresetStatus.timer = setTimeout(() => $('presetStatus').textContent = '', 2200);
}

function renderPresetList(selectedName = '') {
  const select = $('presetSelect');
  const presets = readPresets();
  select.replaceChildren(new Option('Manuale', ''));
  Object.keys(presets).sort((a, b) => a.localeCompare(b)).forEach(name => {
    select.add(new Option(name, name));
  });
  select.value = selectedName in presets ? selectedName : '';
  $('deletePresetButton').disabled = !select.value;
}

function currentPresetValues() {
  return {
    ...Object.fromEntries(presetControls.map(id => [id, +controls[id].value])),
    reverse: reversed,
    random: randomEnabled,
    effectOrder: [...effectOrder]
  };
}

function applyPreset(values) {
  applyingPreset = true;
  setReverse(Boolean(values.reverse), false);
  setRandom(Boolean(values.random), false);
  const savedOrder = normalizeEffectOrder(values.effectOrder);
  if (savedOrder) {
    effectOrder = savedOrder;
    renderEffectChain();
    routeEffects();
  }
  for (const id of presetControls) {
    if (!(id in values)) continue;
    controls[id].value = values[id];
    controls[id].dispatchEvent(new Event('input', { bubbles: true }));
    if (id === 'reverbSize') controls[id].dispatchEvent(new Event('change', { bubbles: true }));
  }
  applyingPreset = false;
}

function savePreset() {
  const input = $('presetName');
  const name = input.value.trim();
  if (!name) {
    input.focus();
    showPresetStatus('Inserisci un nome');
    return;
  }
  try {
    const presets = readPresets();
    presets[name] = currentPresetValues();
    writePresets(presets);
    renderPresetList(name);
    input.value = '';
    showPresetStatus(`Salvato: ${name}`);
  } catch {
    showPresetStatus('Impossibile salvare');
  }
}

$('savePresetButton').addEventListener('click', savePreset);
$('presetName').addEventListener('keydown', event => {
  if (event.key === 'Enter') savePreset();
});

$('presetSelect').addEventListener('change', event => {
  const name = event.target.value;
  $('deletePresetButton').disabled = !name;
  if (!name) return;
  const preset = readPresets()[name];
  if (preset) {
    applyPreset(preset);
    showPresetStatus(`Richiamato: ${name}`);
  }
});

$('deletePresetButton').addEventListener('click', () => {
  const name = $('presetSelect').value;
  if (!name) return;
  const presets = readPresets();
  delete presets[name];
  writePresets(presets);
  renderPresetList();
  showPresetStatus(`Eliminato: ${name}`);
});

presetControls.forEach(id => controls[id].addEventListener('input', () => {
  if (applyingPreset) return;
  $('presetSelect').value = '';
  $('deletePresetButton').disabled = true;
}));

renderPresetList();
