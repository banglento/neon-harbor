// Procedural WebAudio effects and a small scheduled ambient music bed.
export function createAudio(ctx = {}) {
  let audio = null;
  let master = null;
  let engineGain = null;
  let engineOsc = null;
  let sirenGain = null;
  let sirenOsc = null;
  let musicTimer = 0;
  let musicIndex = 0;
  let muted = false;
  let unlocked = false;
  const notes = [110, 164.81, 146.83, 196, 130.81, 174.61, 98, 146.83];

  function ensureAudio() {
    if (audio) return audio;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;
    audio = new AudioContext();
    master = audio.createGain();
    master.gain.value = muted ? 0 : 0.42;
    master.connect(audio.destination);
    engineOsc = audio.createOscillator();
    engineOsc.type = 'sawtooth';
    engineGain = audio.createGain();
    engineGain.gain.value = 0;
    engineOsc.connect(engineGain).connect(master);
    engineOsc.start();
    sirenOsc = audio.createOscillator();
    sirenOsc.type = 'triangle';
    sirenGain = audio.createGain();
    sirenGain.gain.value = 0;
    sirenOsc.connect(sirenGain).connect(master);
    sirenOsc.start();
    return audio;
  }

  function scheduleMusic() {
    if (!audio || audio.state !== 'running') return;
    const now = audio.currentTime;
    const frequency = notes[musicIndex % notes.length];
    musicIndex += 1;
    const oscillator = audio.createOscillator();
    const envelope = audio.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, now);
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(0.038, now + 0.04);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.72);
    oscillator.connect(envelope).connect(master);
    oscillator.start(now);
    oscillator.stop(now + 0.76);
    musicTimer = window.setTimeout(scheduleMusic, 820);
  }

  async function unlock() {
    const context = ensureAudio();
    if (!context) return false;
    if (context.state === 'suspended') await context.resume();
    if (!unlocked) { unlocked = true; scheduleMusic(); }
    return true;
  }

  function tone(frequency, duration = 0.14, type = 'sine', volume = 0.16, slide = 0) {
    const context = ensureAudio();
    if (!context || context.state !== 'running') return;
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    if (slide) oscillator.frequency.exponentialRampToValueAtTime(Math.max(25, frequency + slide), now + duration);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain).connect(master);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  function update({ speed = 0, wanted = 0, inCar = false } = {}) {
    const context = ensureAudio();
    if (!context) return;
    const now = context.currentTime;
    const speedRatio = Math.min(1, Math.abs(speed) / 30);
    engineOsc.frequency.setTargetAtTime(46 + speedRatio * 105, now, 0.12);
    engineGain.gain.setTargetAtTime(inCar ? 0.025 + speedRatio * 0.1 : 0, now, 0.16);
    const siren = wanted > 0 ? 0.035 + Math.min(0.035, wanted * 0.006) : 0;
    sirenGain.gain.setTargetAtTime(siren, now, 0.18);
    sirenOsc.frequency.setTargetAtTime(520 + (Math.sin(now * 4.3) * 160), now, 0.09);
  }

  function setMuted(value = !muted) {
    muted = Boolean(value);
    if (master && audio) master.gain.setTargetAtTime(muted ? 0 : 0.42, audio.currentTime, 0.025);
    ctx.onMuteChanged?.(muted);
    return muted;
  }

  const api = {
    unlock,
    update,
    setMuted,
    get muted() { return muted; },
    uiClick() { tone(520, 0.055, 'triangle', 0.08, -130); },
    pickup() { tone(620, 0.1, 'sine', 0.14, 210); window.setTimeout(() => tone(830, 0.12, 'sine', 0.12, 100), 70); },
    success() { tone(440, 0.13, 'sine', 0.14, 0); window.setTimeout(() => tone(660, 0.16, 'sine', 0.14, 100), 105); },
    punch() { tone(95, 0.09, 'square', 0.12, -34); },
    busted() { tone(260, 0.5, 'sawtooth', 0.13, -180); },
    destroy() { window.clearTimeout(musicTimer); audio?.close?.(); audio = null; },
  };
  return api;
}
