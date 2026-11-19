// save.js — the localStorage save slot. One key from config (SAVE_KEY), one
// versioned payload, no I/O anywhere else.
//
//   const save = createSave(ctx);     // registers ctx.save
//   save.write({ player, police, missions });
//   const data = save.read();         // null when there is nothing usable
//   save.apply(data);                 // push a payload into the live state
//   save.clear();
//
// Payload (version 1):
//   { version, savedAt, title, cash, respect, missionsCompleted, storyComplete,
//     sideDeliveries, wanted, player: { x, z, heading, inCar } }
//
// Everything is validated on read: a payload from a future version, a broken
// JSON blob or a save whose numbers are not finite is treated as "no save"
// rather than crashing the boot.

import { SAVE_KEY, GAME_TITLE, CITY } from './config.js';
import { clamp, wrapAngle } from './util.js';

export const SAVE_VERSION = 1;

export function createSave(ctx) {
  const key = ctx.saveKey ?? SAVE_KEY;

  const save = {
    key,
    version: SAVE_VERSION,
    available: isAvailable(key),
    read,
    write,
    apply,
    clear,
    exists() {
      return read() !== null;
    },
    describe() {
      const data = read();
      if (!data) return { exists: false, text: 'No save yet' };
      const when = new Date(data.savedAt);
      const stamp = Number.isNaN(when.getTime())
        ? 'an earlier session'
        : when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return {
        exists: true,
        text: `${data.missionsCompleted}/3 missions · $${Math.round(data.cash)} · ${stamp}`,
        data,
      };
    },
  };

  function write(snapshot) {
    if (!save.available) return false;
    const payload = {
      version: SAVE_VERSION,
      savedAt: Date.now(),
      title: GAME_TITLE,
      cash: Math.round(snapshot.cash ?? 0),
      respect: Math.round(snapshot.respect ?? 0),
      missionsCompleted: clamp(Math.round(snapshot.missionsCompleted ?? 0), 0, 3),
      storyComplete: Boolean(snapshot.storyComplete),
      sideDeliveries: Math.max(0, Math.round(snapshot.sideDeliveries ?? 0)),
      wanted: clamp(Math.round(snapshot.wanted ?? 0), 0, 5),
      player: {
        x: round(snapshot.player?.x ?? 0),
        z: round(snapshot.player?.z ?? 0),
        heading: round(snapshot.player?.heading ?? 0),
        inCar: Boolean(snapshot.player?.inCar),
      },
    };
    try {
      window.localStorage.setItem(key, JSON.stringify(payload));
      return true;
    } catch {
      save.available = false;
      return false;
    }
  }

  function read() {
    if (!save.available) return null;
    let raw = null;
    try {
      raw = window.localStorage.getItem(key);
    } catch {
      save.available = false;
      return null;
    }
    if (!raw) return null;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.version !== SAVE_VERSION) return null;

    const cash = Number(parsed.cash);
    const respect = Number(parsed.respect);
    const missionsCompleted = Number(parsed.missionsCompleted);
    const player = parsed.player && typeof parsed.player === 'object' ? parsed.player : null;
    if (!Number.isFinite(cash) || !Number.isFinite(respect) || !Number.isFinite(missionsCompleted)) return null;

    return {
      version: SAVE_VERSION,
      savedAt: Number(parsed.savedAt) || 0,
      title: typeof parsed.title === 'string' ? parsed.title : GAME_TITLE,
      cash: Math.max(0, cash),
      respect: Math.max(0, respect),
      missionsCompleted: clamp(Math.round(missionsCompleted), 0, 3),
      storyComplete: Boolean(parsed.storyComplete),
      sideDeliveries: Math.max(0, Math.round(Number(parsed.sideDeliveries) || 0)),
      wanted: clamp(Math.round(Number(parsed.wanted) || 0), 0, 5),
      player: {
        x: Number.isFinite(player?.x) ? clamp(player.x, -CITY.halfX - 140, CITY.halfX + 140) : null,
        z: Number.isFinite(player?.z) ? clamp(player.z, -CITY.halfZ - 140, CITY.halfZ + 140) : null,
        heading: Number.isFinite(player?.heading) ? wrapAngle(player.heading) : 0,
        inCar: Boolean(player?.inCar),
      },
    };
  }

  function clear() {
    if (!save.available) return;
    try {
      window.localStorage.removeItem(key);
    } catch {
      save.available = false;
    }
  }

  // Push a payload into the shared state and the police system. The caller
  // (main.js) owns the player teleport, because only it knows how to place a
  // body and a camera together.
  function apply(data) {
    if (!data) return null;
    const state = ctx.state ?? (ctx.state = {});
    state.cash = data.cash;
    state.respect = data.respect;
    state.missionsCompleted = data.missionsCompleted;
    state.storyComplete = data.storyComplete;
    state.sideDeliveries = data.sideDeliveries;
    if (ctx.police && data.wanted > 0) ctx.police.setLevel(data.wanted, 'load');
    else if (ctx.police) ctx.police.clear('load');
    return data;
  }

  ctx.save = save;
  return save;
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

function isAvailable(key) {
  try {
    const probe = '__neon_harbor_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return Boolean(key);
  } catch {
    return false;
  }
}
