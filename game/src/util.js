// Deterministic math and geometry helpers shared by the simulation modules.
export function createRng(seed = 1) {
  let value = seed >>> 0;
  return function rng() {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomRange(rng, min, max) {
  return min + rng() * (max - min);
}

export function choose(rng, values) {
  return values[Math.floor(rng() * values.length)];
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

export function distanceSquared(a, b) {
  const dx = a.x - b.x;
  const dz = (a.z ?? a.y) - (b.z ?? b.y);
  return dx * dx + dz * dz;
}

export function distance(a, b) {
  return Math.sqrt(distanceSquared(a, b));
}

export function normalizeAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

export function rectsOverlap(a, b) {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}

export function circleIntersectsRect(x, z, radius, rect) {
  const nearestX = clamp(x, rect.minX, rect.maxX);
  const nearestZ = clamp(z, rect.minZ, rect.maxZ);
  const dx = x - nearestX;
  const dz = z - nearestZ;
  return dx * dx + dz * dz < radius * radius;
}

export function circleIntersectsCircle(a, b, radiusA, radiusB) {
  const reach = radiusA + radiusB;
  return distanceSquared(a, b) < reach * reach;
}

export function pointInRect(x, z, rect) {
  return x >= rect.minX && x <= rect.maxX && z >= rect.minZ && z <= rect.maxZ;
}
