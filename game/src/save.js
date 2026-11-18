// Versioned local progress persistence for Neon Harbor.
import { SAVE_KEY } from './config.js';

const VERSION = 1;

export function createSave(ctx = {}) {
  function read() {
    try {
      const text = localStorage.getItem(SAVE_KEY);
      if (!text) return null;
      const payload = JSON.parse(text);
      if (payload?.version !== VERSION || !payload.state || typeof payload.state !== 'object') return null;
      return payload.state;
    } catch {
      return null;
    }
  }

  function save(state = {}) {
    const player = state.player ?? ctx.player;
    const position = player?.car?.position ?? player?.vehicle?.position ?? player?.position ?? { x: -80, z: 69 };
    const payload = {
      version: VERSION,
      savedAt: Date.now(),
      state: {
        cash: Math.max(0, Math.floor(state.cash ?? ctx.cash ?? 0)),
        respect: Math.max(0, Math.floor(state.respect ?? ctx.respect ?? 0)),
        missionsCompleted: [...(state.missionsCompleted ?? ctx.missions?.getCompleted?.() ?? [])],
        sideDeliveries: Math.max(0, Math.floor(state.sideDeliveries ?? ctx.sideDeliveries ?? 0)),
        playerPosition: { x: Number(position.x) || 0, z: Number(position.z ?? position.y) || 0 },
        wantedLevel: Math.max(0, Math.min(5, Number(state.wantedLevel ?? ctx.police?.wanted ?? 0))),
      },
    };
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(payload)); return true; } catch { return false; }
  }

  function clear() {
    try { localStorage.removeItem(SAVE_KEY); return true; } catch { return false; }
  }

  return { save, load: read, clear, get version() { return VERSION; } };
}
