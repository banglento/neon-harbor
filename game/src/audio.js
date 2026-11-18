// audio.js — every sound in the game, synthesized with WebAudio. No files.
//
//   const audio = createAudio(ctx);        // registers ctx.audio
//   audio.unlock();                        // call from a real click/keypress
//   audio.update(dt, ctx.player, ctx.police);
//   audio.chime() / .click() / .thud() / .busted() / .success() / .pickup()
//   audio.toggleMute();   audio.muted
//
// Design constraints that shaped this file:
//   - Browsers refuse to start an AudioContext before a gesture, so nothing is
//     built until unlock() runs; every play call is a safe no-op before that.
//   - One master gain feeds a gentle compressor so overlapping sirens and
//     traffic never clip.
//   - The engine is two sawtooth oscillators an offset against each other,
//     pitch-tracked to the car's speed; the siren is a single sine whose
//     frequency is swept by an LFO. Both stay alive at zero gain when idle,
//     which is cheaper and click-free compared to creating them per frame.
//   - The music loop is a scheduler: a lookahead timer queues the next bar of
//     notes on the audio clock, so it never drifts with frame rate.

import { AUDIO } from './config.js';

const MUSIC = {
  bpm: 84,
  lookahead: 0.35, // seconds of notes queued ahead of the playhead
  schedulerTick: 0.2, // how often the timer wakes up
  // A minor pentatonic-ish loop in D: warm, unhurried, coastal at dusk.
  // Each entry is [midi note, beats]. A null note is a rest.
  bass: [
    [38, 2], [38, 1], [45, 1],
    [36, 2], [43, 1], [36, 1],
    [41, 2], [48, 1], [41, 1],
    [33, 2], [40, 1], [33, 1],
  ],
  pad: [
    [62, 4], [69, 4],
    [60, 4], [67, 4],
    [65, 4], [72, 4],
    [57, 4], [64, 4],
  ],
};

export function createAudio(ctx) {
  const state = {
    ac: null,
    master: null,
    musicBus: null,
    sfxBus: null,
    engineBus: null,
    sirenBus: null,
    muted: false,
    ready: false,
    engine: null,
    siren: null,
    music: null,
    noiseBuffer: null,
    lastSpeed: 0,
    sirenWasOn: false,
  };

  const audio = {
    get ready() {
      return state.ready;
    },
    get muted() {
      return state.muted;
    },
    get context() {
      return state.ac;
    },
    unlock,
    suspend,
    update,
    toggleMute,
    setMuted,
    click,
    chime,
    pickup,
    success,
    thud,
    busted,
    horn,
    crash,
    startMusic,
    stopMusic,
  };

  // ------------------------------------------------------------------ unlock

  function unlock() {
    if (state.ac) {
      if (state.ac.state === 'suspended') state.ac.resume();
      return;
    }
    const Ctor = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctor) return;
    const ac = new Ctor();
    state.ac = ac;

    const master = ac.createGain();
    master.gain.value = state.muted ? 0 : AUDIO.master;
    const compressor = ac.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 18;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.22;
    master.connect(compressor);
    compressor.connect(ac.destination);
    state.master = master;

    state.musicBus = makeBus(ac, master, AUDIO.musicVolume);
    state.sfxBus = makeBus(ac, master, AUDIO.sfxVolume);
    state.engineBus = makeBus(ac, master, AUDIO.engineVolume);
    state.sirenBus = makeBus(ac, master, AUDIO.sirenVolume);
    state.noiseBuffer = makeNoise(ac, 1.0);

    buildEngine();
    buildSiren();
    state.ready = true;
    startMusic();
    if (ac.state === 'suspended') ac.resume();
  }

  function makeBus(ac, destination, volume) {
    const gain = ac.createGain();
    gain.gain.value = volume;
    gain.connect(destination);
    return gain;
  }

  function suspend() {
    if (state.ac && state.ac.state === 'running') state.ac.suspend();
  }

  // ------------------------------------------------------------------- mute

  function setMuted(muted) {
    state.muted = Boolean(muted);
    if (state.master && state.ac) {
      const now = state.ac.currentTime;
      state.master.gain.cancelScheduledValues(now);
      state.master.gain.setTargetAtTime(state.muted ? 0 : AUDIO.master, now, 0.03);
    }
    return state.muted;
  }

  function toggleMute() {
    return setMuted(!state.muted);
  }

  // ----------------------------------------------------------- engine + siren

  function buildEngine() {
    const ac = state.ac;
    const gain = ac.createGain();
    gain.gain.value = 0;

    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 520;
    filter.Q.value = 2.4;

    const fundamental = ac.createOscillator();
    fundamental.type = 'sawtooth';
    fundamental.frequency.value = 46;

    const harmonic = ac.createOscillator();
    harmonic.type = 'square';
    harmonic.frequency.value = 69;

    const harmonicGain = ac.createGain();
    harmonicGain.gain.value = 0.36;

    fundamental.connect(filter);
    harmonic.connect(harmonicGain);
    harmonicGain.connect(filter);
    filter.connect(gain);
    gain.connect(state.engineBus);

    fundamental.start();
    harmonic.start();
    state.engine = { gain, filter, fundamental, harmonic };
  }

  function buildSiren() {
    const ac = state.ac;
    const gain = ac.createGain();
    gain.gain.value = 0;

    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 720;

    // A square LFO pushes the pitch between the two-tone wail.
    const lfo = ac.createOscillator();
    lfo.type = 'triangle';
    lfo.frequency.value = 1.6;
    const lfoGain = ac.createGain();
    lfoGain.gain.value = 300;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);

    const shape = ac.createBiquadFilter();
    shape.type = 'bandpass';
    shape.frequency.value = 900;
    shape.Q.value = 1.1;

    osc.connect(shape);
    shape.connect(gain);
    gain.connect(state.sirenBus);

    osc.start();
    lfo.start();
    state.siren = { gain, osc, lfo, lfoGain };
  }

  // ------------------------------------------------------------ per-frame mix

  function update(dt, player, police) {
    if (!state.ready || !state.ac) return;
    const ac = state.ac;
    const now = ac.currentTime;
    const step = dt > 0 ? dt : 0;

    // ---- engine: pitch and level follow the car's speed.
    const car = player && player.onFoot === false ? player.car : null;
    const speed = car ? Math.min(Math.abs(car.speed), 40) : 0;
    const target = car ? 0.5 + (speed / 40) * 0.5 : 0;
    const engine = state.engine;
    if (engine) {
      const throttle = car?.controls?.throttle ?? 0;
      const base = 42 + speed * 2.4 + Math.max(0, throttle) * 8;
      engine.fundamental.frequency.setTargetAtTime(base, now, 0.08);
      engine.harmonic.frequency.setTargetAtTime(base * 1.51, now, 0.08);
      engine.filter.frequency.setTargetAtTime(380 + speed * 42, now, 0.1);
      engine.gain.gain.setTargetAtTime(car ? target * 0.5 : 0, now, 0.12);
    }

    // ---- siren: on while a unit is chasing, panned by distance.
    const sirenOn = Boolean(police && police.sirenOn && police.level > 0);
    const near = sirenDistance(player, police);
    let sirenTarget = 0;
    if (sirenOn) {
      sirenTarget = 0.9 * Math.max(0, 1 - Math.min(near, 130) / 130);
      if (state.sirenWasOn && sirenTarget > 0.02) sirenTarget = Math.min(1, sirenTarget + 0.15);
    }
    if (state.siren) {
      state.siren.gain.gain.setTargetAtTime(sirenTarget * 0.5, now, 0.18);
      state.siren.lfo.frequency.setTargetAtTime(police?.level >= 4 ? 2.4 : 1.6, now, 0.4);
      state.siren.lfoGain.gain.setTargetAtTime(police?.level >= 3 ? 380 : 280, now, 0.4);
    }
    state.sirenWasOn = sirenOn;

    // ---- music scheduler keeps its own clock; just keep the head moving.
    state.lastSpeed = speed;
    if (step > 0) tickMusic();
  }

  function sirenDistance(player, police) {
    if (!player || !police || !police.cars) return 999;
    let best = Infinity;
    for (const car of police.cars) {
      if (car.removed) continue;
      const d = Math.hypot(car.x - player.x, car.z - player.z);
      if (d < best) best = d;
    }
    return best === Infinity ? 999 : best;
  }

  // ------------------------------------------------------------------- music

  function startMusic() {
    if (!state.ready) return;
    const ac = state.ac;
    if (state.music) return;
    const bus = ac.createGain();
    bus.gain.value = 0;
    bus.connect(state.musicBus);
    bus.gain.setTargetAtTime(1, ac.currentTime + 0.05, 1.6);
    state.music = {
      bus,
      nextBass: ac.currentTime + 0.25,
      nextPad: ac.currentTime + 0.25,
      bassIndex: 0,
      padIndex: 0,
      timer: window.setInterval(tickMusic, MUSIC.schedulerTick * 1000),
    };
  }

  function stopMusic() {
    if (!state.music) return;
    const ac = state.ac;
    const music = state.music;
    music.bus.gain.setTargetAtTime(0, ac.currentTime, 0.3);
    window.clearInterval(music.timer);
    state.music = null;
    window.setTimeout(() => {
      try {
        music.bus.disconnect();
      } catch {
        /* already gone */
      }
    }, 1600);
  }

  function tickMusic() {
    const music = state.music;
    if (!music || !state.ac) return;
    const ac = state.ac;
    const secPerBeat = 60 / MUSIC.bpm;
    const horizon = ac.currentTime + MUSIC.lookahead;

    let guard = 0;
    while (music.nextBass < horizon && guard < 24) {
      guard += 1;
      const [note, beats] = MUSIC.bass[music.bassIndex % MUSIC.bass.length];
      music.bassIndex += 1;
      const length = beats * secPerBeat;
      if (note != null) playVoice(music.bus, midiToHz(note), music.nextBass, length * 0.9, 'triangle', 0.36);
      music.nextBass += length;
      if (music.nextBass < ac.currentTime - 4) music.nextBass = ac.currentTime + 0.1;
    }

    guard = 0;
    while (music.nextPad < horizon && guard < 12) {
      guard += 1;
      const [note, beats] = MUSIC.pad[music.padIndex % MUSIC.pad.length];
      music.padIndex += 1;
      const length = beats * secPerBeat;
      if (note != null) {
        playVoice(music.bus, midiToHz(note), music.nextPad, length * 0.95, 'sine', 0.16);
        playVoice(music.bus, midiToHz(note + 7), music.nextPad + 0.02, length * 0.8, 'sine', 0.06);
      }
      music.nextPad += length;
      if (music.nextPad < ac.currentTime - 4) music.nextPad = ac.currentTime + 0.1;
    }
  }

  function midiToHz(midi) {
    return 440 * 2 ** ((midi - 69) / 12);
  }

  // A soft, slow-attack voice, used only by the music.
  function playVoice(destination, frequency, when, duration, type, level) {
    const ac = state.ac;
    const osc = ac.createOscillator();
    osc.type = type;
    osc.frequency.value = frequency;
    const gain = ac.createGain();
    gain.gain.value = 0;
    const attack = Math.min(0.9, duration * 0.3);
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(level, when + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    osc.connect(gain);
    gain.connect(destination);
    osc.start(when);
    osc.stop(when + duration + 0.05);
  }

  // ----------------------------------------------------------------- effects

  function blip(frequency, when, duration, type, level, destination) {
    const ac = state.ac;
    const osc = ac.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, when);
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(level, when + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    osc.connect(gain);
    gain.connect(destination ?? state.sfxBus);
    osc.start(when);
    osc.stop(when + duration + 0.05);
    return osc;
  }

  function noiseBurst(when, duration, level, filterHz, type = 'bandpass') {
    const ac = state.ac;
    if (!state.noiseBuffer) return;
    const src = ac.createBufferSource();
    src.buffer = state.noiseBuffer;
    const filter = ac.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = filterHz;
    filter.Q.value = 1.2;
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(level, when + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(state.sfxBus);
    src.start(when);
    src.stop(when + duration + 0.02);
  }

  function makeNoise(ac, seconds) {
    const length = Math.floor(ac.sampleRate * seconds);
    const buffer = ac.createBuffer(1, length, ac.sampleRate);
    const data = buffer.getChannelData(0);
    // A tiny local PRNG so the noise bed is identical run to run.
    let seed = 0x9e3779b9;
    for (let i = 0; i < length; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 0xffffffff) * 2 - 1;
    }
    return buffer;
  }

  function guard() {
    if (!state.ready || !state.ac) return null;
    return state.ac.currentTime;
  }

  // UI button: a dry wooden click.
  function click() {
    const now = guard();
    if (now === null) return;
    blip(880, now, 0.05, 'square', 0.1);
    noiseBurst(now, 0.04, 0.06, 2600, 'highpass');
  }

  // Package collected: two rising notes.
  function pickup() {
    const now = guard();
    if (now === null) return;
    blip(660, now, 0.12, 'triangle', 0.16);
    blip(990, now + 0.09, 0.16, 'triangle', 0.13);
  }

  // Mission paid: a small major arpeggio.
  function chime() {
    const now = guard();
    if (now === null) return;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) => blip(f, now + i * 0.075, 0.28, 'triangle', 0.15));
  }

  // Story beat: the same arpeggio, longer and brighter.
  function success() {
    const now = guard();
    if (now === null) return;
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
    notes.forEach((f, i) => {
      blip(f, now + i * 0.1, 0.5, 'sine', 0.16);
      blip(f * 2, now + i * 0.1, 0.22, 'triangle', 0.05);
    });
    noiseBurst(now, 0.5, 0.05, 4200, 'highpass');
  }

  // Punch: a short low thud with a noise slap on top.
  function thud() {
    const now = guard();
    if (now === null) return;
    const ac = state.ac;
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(52, now + 0.16);
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0.28, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    osc.connect(gain);
    gain.connect(state.sfxBus);
    osc.start(now);
    osc.stop(now + 0.2);
    noiseBurst(now, 0.09, 0.14, 900, 'lowpass');
  }

  // Busted: a two-note descending sting with a squashed siren tail.
  function busted() {
    const now = guard();
    if (now === null) return;
    blip(392, now, 0.36, 'sawtooth', 0.14);
    blip(311, now + 0.28, 0.5, 'sawtooth', 0.14);
    blip(233, now + 0.6, 0.9, 'sine', 0.16);
    noiseBurst(now, 0.7, 0.06, 600, 'lowpass');
  }

  // Horn: two detuned squares, tapped by main when H is held.
  function horn() {
    const now = guard();
    if (now === null) return;
    blip(330, now, 0.3, 'square', 0.09);
    blip(415, now, 0.3, 'square', 0.06);
  }

  // Crash: filtered noise plus a metal tick.
  function crash(intensity = 1) {
    const now = guard();
    if (now === null) return;
    const level = Math.min(0.2, 0.05 + intensity * 0.06);
    noiseBurst(now, 0.22, level, 1500, 'bandpass');
    blip(140, now, 0.14, 'square', level * 0.5);
  }

  audio.setMuted(loadMuted());
  ctx.audio = audio;
  return audio;
}

// The mute choice survives a reload; it is a preference, not save-game state.
function loadMuted() {
  try {
    return window.localStorage.getItem('neon-harbor-muted') === '1';
  } catch {
    return false;
  }
}

export function rememberMuted(muted) {
  try {
    window.localStorage.setItem('neon-harbor-muted', muted ? '1' : '0');
  } catch {
    /* private mode: the preference simply does not persist */
  }
}
