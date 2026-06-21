const $ = id => document.getElementById(id);
const controls = {
  file: $('fileInput'), play: $('playButton'), pause: $('pauseButton'), stop: $('stopButton'),
  position: $('position'), stretch: $('stretch'), delayTime: $('delayTime'),
  feedback: $('feedback'), delayMix: $('delayMix'), reverbSize: $('reverbSize'),
  reverbMix: $('reverbMix'), drive: $('drive'), distMix: $('distMix')
};

let context;
let player;
let graph;
let loaded = false;
let seeking = false;
let decodedDuration = 0;
let delayChangeTimer;

async function ensureAudio() {
  if (context) {
    if (context.state === 'suspended') await context.resume();
    return;
  }

  context = new AudioContext({ latencyHint: 'interactive' });
  await context.audioWorklet.addModule('worklet.js');
  player = new AudioWorkletNode(context, 'granular-stretch', {
    outputChannelCount: [2]
  });

  const distortionDry = context.createGain();
  const distortionWet = context.createGain();
  const shaper = context.createWaveShaper();
  const distortionBus = context.createGain();
  shaper.oversample = '4x';

  const delayDry = context.createGain();
  const delayInputs = [context.createGain(), context.createGain()];
  const delayWets = [context.createGain(), context.createGain()];
  const delays = [context.createDelay(2), context.createDelay(2)];
  const feedbacks = [context.createGain(), context.createGain()];
  const delayBus = context.createGain();

  const reverbDry = context.createGain();
  const reverbWet = context.createGain();
  const convolver = context.createConvolver();
  const master = context.createGain();
  master.gain.value = 0.82;

  player.connect(distortionDry).connect(distortionBus);
  player.connect(shaper).connect(distortionWet).connect(distortionBus);
  distortionBus.connect(delayDry).connect(delayBus);
  for (let i = 0; i < 2; i++) {
    distortionBus.connect(delayInputs[i]).connect(delays[i]).connect(delayWets[i]).connect(delayBus);
    delays[i].connect(feedbacks[i]).connect(delays[i]);
  }
  // Entrambe le linee restano alimentate: quella nascosta è già piena di audio
  // quando viene portata in primo piano, evitando buchi durante il cambio.
  delayInputs[0].gain.value = 1;
  delayInputs[1].gain.value = 1;
  delayWets[1].gain.value = 0;
  delayBus.connect(reverbDry).connect(master);
  delayBus.connect(convolver).connect(reverbWet).connect(master);
  master.connect(context.destination);

  graph = { distortionDry, distortionWet, shaper, delayDry, delayInputs, delayWets,
    delays, feedbacks, activeDelay: 0, reverbDry, reverbWet, convolver };
  updateAllEffects();

  player.port.onmessage = ({ data }) => {
    if (data.type === 'position' && !seeking) updateTimeline(data.position, data.duration);
    if (data.type === 'ended') {
      setPlaying(false);
      updateTimeline(decodedDuration, decodedDuration);
    }
  };
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
  graph.delays.forEach(delay => delay.delayTime.value = +controls.delayTime.value);
  graph.feedbacks.forEach(feedback => feedback.gain.value = +controls.feedback.value);
  updateDelayMix(+controls.delayMix.value);
  equalPowerMix(+controls.reverbMix.value, graph.reverbDry, graph.reverbWet);
  equalPowerMix(+controls.distMix.value, graph.distortionDry, graph.distortionWet);
  graph.shaper.curve = distortionCurve(+controls.drive.value);
  graph.convolver.buffer = makeImpulse(+controls.reverbSize.value);
}

controls.file.addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    await ensureAudio();
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    const channels = [];
    for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i).slice().buffer);
    player.port.postMessage({
      type: 'load', channels, length: buffer.length, sampleRate: buffer.sampleRate
    }, channels);
    loaded = true;
    decodedDuration = buffer.duration;
    $('sampleName').textContent = file.name;
    $('sampleMeta').textContent = `${buffer.numberOfChannels === 1 ? 'Mono' : 'Stereo'} · ${(buffer.sampleRate / 1000).toFixed(1)} kHz · ${formatTime(buffer.duration)}`;
    updateTimeline(0, buffer.duration);
    setPlaying(false);
  } catch (error) {
    console.error(error);
    $('sampleName').textContent = 'Formato non supportato';
    $('sampleMeta').textContent = 'Prova un file WAV o MP3';
  }
});

controls.play.addEventListener('click', async () => {
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
bind('delayTime', 'delayTimeValue', value => `${Math.round(value * 1000)} ms`, scheduleDelayTime);
bind('feedback', 'feedbackValue', value => `${Math.round(value * 100)}%`, value => graph.feedbacks.forEach(feedback => feedback.gain.setTargetAtTime(value, context.currentTime, 0.01)));
bind('delayMix', 'delayMixValue', value => `${Math.round(value * 100)}%`, updateDelayMix);
bind('reverbMix', 'reverbMixValue', value => `${Math.round(value * 100)}%`, value => equalPowerMix(value, graph.reverbDry, graph.reverbWet));
bind('drive', 'driveValue', value => `${value.toFixed(1)} dB`, value => graph.shaper.curve = distortionCurve(value));
bind('distMix', 'distMixValue', value => `${Math.round(value * 100)}%`, value => equalPowerMix(value, graph.distortionDry, graph.distortionWet));
bind('reverbSize', 'reverbSizeValue', value => `${value.toFixed(1)} s`);
controls.reverbSize.addEventListener('change', () => {
  if (graph) graph.convolver.buffer = makeImpulse(+controls.reverbSize.value);
});
