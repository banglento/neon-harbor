// util.js — small maths, seeded RNG, rectangle collision and a tiny event bus.
// No three.js here: every module may import these helpers.
//
// Heading convention used across the game: a heading of 0 faces +Z, and
// forward = (sin(heading), cos(heading)) in the XZ plane.

export const TAU = Math.PI * 2;

// ---------------------------------------------------------------- randomness

// Deterministic PRNG (Mulberry32). Same seed -> same city, same shots.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rand(rng, min = 0, max = 1) {
  return min + rng() * (max - min);
}

export function randInt(rng, min, max) {
  return Math.floor(min + rng() * (max - min + 1));
}

export function pick(rng, list) {
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

export function chance(rng, probability) {
  return rng() < probability;
}

export function shuffle(rng, list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// ------------------------------------------------------------------- scalars

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Frame-rate independent approach (exponential smoothing).
export function damp(a, b, lambda, dt) {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function wrapAngle(angle) {
  let a = (angle + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

export function lerpAngle(from, to, t) {
  return from + wrapAngle(to - from) * t;
}

// Shortest signed rotation from `from` to `to`, in radians.
export function angleDelta(from, to) {
  return wrapAngle(to - from);
}

// Move `value` toward `target` by at most `step`.
export function approach(value, target, step) {
  if (value < target) return Math.min(value + step, target);
  return Math.max(value - step, target);
}

// ------------------------------------------------------------------ geometry

export function dist2D(ax, az, bx, bz) {
  return Math.hypot(bx - ax, bz - az);
}

export function distSq2D(ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  return dx * dx + dz * dz;
}

// Heading (0 = +Z) that points from (ax,az) toward (bx,bz).
export function angleTo(ax, az, bx, bz) {
  return Math.atan2(bx - ax, bz - az);
}

export function headingToVector(heading) {
  return { x: Math.sin(heading), z: Math.cos(heading) };
}

// Rotate a local offset (x, z) by a heading, giving world space.
export function rotateXZ(x, z, heading) {
  const s = Math.sin(heading);
  const c = Math.cos(heading);
  return { x: x * c + z * s, z: -x * s + z * c };
}

// ------------------------------------------------------------ rects & colliders
// A rect is { minX, maxX, minZ, maxZ } in world units.

export function rectFromCenter(cx, cz, width, depth) {
  return {
    minX: cx - width / 2,
    maxX: cx + width / 2,
    minZ: cz - depth / 2,
    maxZ: cz + depth / 2,
  };
}

export function inflateRect(rect, amount) {
  return {
    minX: rect.minX - amount,
    maxX: rect.maxX + amount,
    minZ: rect.minZ - amount,
    maxZ: rect.maxZ + amount,
  };
}

export function pointInRect(x, z, rect) {
  return x >= rect.minX && x <= rect.maxX && z >= rect.minZ && z <= rect.maxZ;
}

export function rectsOverlap(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

export function rectCenter(rect) {
  return {
    x: (rect.minX + rect.maxX) / 2,
    z: (rect.minZ + rect.maxZ) / 2,
  };
}

// 0 when the point is inside, otherwise distance from the point to the rect edge.
export function rectDistance(x, z, rect) {
  const dx = Math.max(rect.minX - x, 0, x - rect.maxX);
  const dz = Math.max(rect.minZ - z, 0, z - rect.maxZ);
  return Math.hypot(dx, dz);
}

// Push a circle out of a rect along the shallowest axis.
// Returns { x, z, hit } — the corrected centre.
export function resolveCircleRect(x, z, radius, rect) {
  const nearestX = clamp(x, rect.minX, rect.maxX);
  const nearestZ = clamp(z, rect.minZ, rect.maxZ);
  const dx = x - nearestX;
  const dz = z - nearestZ;
  const d2 = dx * dx + dz * dz;
  if (d2 > radius * radius) return { x, z, hit: false };

  if (d2 > 1e-8) {
    const d = Math.sqrt(d2);
    const push = radius - d;
    return { x: x + (dx / d) * push, z: z + (dz / d) * push, hit: true };
  }

  // Centre is inside the rect: exit through the closest side.
  const left = x - rect.minX;
  const right = rect.maxX - x;
  const back = z - rect.minZ;
  const front = rect.maxZ - z;
  const min = Math.min(left, right, back, front);
  if (min === left) return { x: rect.minX - radius, z, hit: true };
  if (min === right) return { x: rect.maxX + radius, z, hit: true };
  if (min === back) return { x, z: rect.minZ - radius, hit: true };
  return { x, z: rect.maxZ + radius, hit: true };
}

// True when a circle overlaps a rect at all (no resolution).
export function circleHitsRect(x, z, radius, rect) {
  return rectDistance(x, z, rect) < radius;
}

// Sweep-friendly segment/rect test used by police and traffic look-ahead.
export function segmentHitsRect(ax, az, bx, bz, rect) {
  const steps = Math.max(1, Math.ceil(dist2D(ax, az, bx, bz) / 2));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    if (pointInRect(lerp(ax, bx, t), lerp(az, bz, t), rect)) return true;
  }
  return false;
}

// --------------------------------------------------------------- misc helpers

export function formatCash(value) {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  return `${sign}$${Math.abs(rounded).toLocaleString('en-US')}`;
}

export function formatTime(seconds) {
  const total = Math.max(0, Math.ceil(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// -------------------------------------------------------------- event bus
// ctx.events.on('crime', ...) — modules talk to the wanted system and HUD
// without importing each other.
export function createEmitter() {
  const listeners = new Map();
  return {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => this.off(type, fn);
    },
    off(type, fn) {
      const set = listeners.get(type);
      if (set) set.delete(fn);
    },
    emit(type, payload) {
      const set = listeners.get(type);
      if (!set) return;
      for (const fn of set) fn(payload);
    },
    clear() {
      listeners.clear();
    },
  };
}
