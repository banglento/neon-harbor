// pedestrians.js — sidewalk walkers with waypoint paths, avoidance and reactions.
//
//   const peds = createPedestrians(ctx);   // registers ctx.pedestrians
//   peds.update(dt, player);               // walk, avoid, react, animate
//   peds.hit(ped, { fromX, fromZ, power });  // knock one down (missions/vehicles call this)
//   peds.nearestTo(x, z, maxDist)
//
// ped = {
//   id, mesh, x, z, heading, speed, state,        // 'walk'|'idle'|'flee'|'down'|'getup'
//   downTimer, fleeTimer, panicSource,            // 'car'|'fight'|'police'
//   path (array of {x,z}), pathIndex, lap,
//   homeBlock, body parts for the walk cycle,
//   isDown(), scared(), getUp(), hitBy(), moveTo(x,z)
// }
//
// The wanted system reads ctx.pedestrians.recentHits and calls hit() when a car
// clips someone; missions can call scare() to clear a street.

import * as THREE from 'three';
import { PEDESTRIANS, CITY } from './config.js';
import {
  mulberry32,
  rand,
  randInt,
  pick,
  chance,
  clamp,
  lerp,
  angleDelta,
  dist2D,
  distSq2D,
  resolveCircleRect,
  TAU,
} from './util.js';

const SHIRTS = [0xf2e3c6, 0x7fc4bd, 0xf2a6a0, 0x5f7d8c, 0xd9b46a, 0xe8e2d4, 0xb56b57, 0x8fa8bd, 0xcf9ec4, 0x9cc78f];
const PANTS = [0x39414d, 0x6b5a44, 0x2f3a46, 0x8d8577, 0x4a3f52, 0x5d6b5a];
const SKINS = [0xe6b48c, 0xc98a5f, 0x8d5a3b, 0xf0c8a4, 0xa9714a];

const PED = {
  arriveRadius: 1.4,
  avoidRadius: 1.1,
  avoidPush: 2.4,
  hitCooldown: 1.1,
  downTime: 3.4,
  getUpTime: 0.7,
  walkCycleSpeed: 3.4,
  fleeCheck: 0.28,
  carAlertRadius: 20, // a car this close and moving fast is worth running from
  fallFlat: Math.PI * 0.47,
  hornFleeTime: 1.7, // a horn is a flinch, not a reason to abandon the block
};

export function createPedestrians(ctx) {
  const rng = mulberry32((CITY.seed ^ 0x3ec4) >>> 0);
  const root = new THREE.Group();
  root.name = 'Pedestrians';
  if (ctx.scene) ctx.scene.add(root);

  const list = [];
  const sidewalks = ctx.city?.sidewalkPaths ?? [];
  const recentHits = [];
  let nextId = 1;
  let clock = 0;
  let fleeTimerAcc = 0;

  const peds = {
    root,
    list,
    recentHits,

    spawn(count = PEDESTRIANS.count) {
      for (let i = 0; i < count; i += 1) {
        const ped = makePedestrian(rng, sidewalks, nextId);
        if (!ped) continue;
        nextId += 1;
        root.add(ped.mesh);
        list.push(ped);
      }
      return list;
    },

    update(dt, player) {
      if (!(dt > 0)) return;
      clock += dt;
      const playerPos = readPos(player ?? ctx.player);
      const carHazards = collectCarHazards(ctx, playerPos);

      fleeTimerAcc -= dt;
      const checkThreats = fleeTimerAcc <= 0;
      if (checkThreats) fleeTimerAcc = PED.fleeCheck;

      for (const ped of list) {
        if (ped.state === 'down' || ped.state === 'getup') {
          updateDowned(ped, dt);
          continue;
        }
        if (checkThreats) senseThreats(ped, ctx, carHazards, playerPos);
        if (ped.state === 'flee') {
          stepFlee(ped, dt);
        } else {
          stepWalk(ped, dt);
        }
        animatePed(ped, dt);
      }

      separatePedestrians(list);
      pushOutOfCars(list, ctx);
      pushOutOfBuildings(list, ctx);
      if (recentHits.length > 60) recentHits.splice(0, recentHits.length - 60);
      peds.clock = clock;
    },

    // ------------------------------------------------------------- reactions
    hit(ped, opts = {}) {
      if (!ped || ped.state === 'down') return false;
      const fromX = opts.fromX ?? ped.x;
      const fromZ = opts.fromZ ?? ped.z;
      const power = opts.power ?? 1;
      const dirX = ped.x - fromX;
      const dirZ = ped.z - fromZ;
      const len = Math.hypot(dirX, dirZ) || 1;
      ped.state = 'down';
      ped.downTimer = PED.downTime * clamp(0.7 + power * 0.4, 0.6, 1.6);
      ped.fallDir = { x: dirX / len, z: dirZ / len };
      ped.fallSpin = rand(rng, 1.4, 2.4) * (rng() < 0.5 ? -1 : 1);
      ped.vy = 0;
      ped.hitBy = opts.source ?? 'car';
      ped.speed = 0;
      ped.fleeTimer = 0;
      recentHits.push({ x: ped.x, z: ped.z, t: clock, source: ped.hitBy, power });
      if (ctx.events) ctx.events.emit('pedHit', { ped, source: ped.hitBy, power });
      return true;
    },

    scare(x, z, radius = 18, source = 'fight') {
      let scaredCount = 0;
      for (const ped of list) {
        if (ped.state === 'down') continue;
        if (dist2D(ped.x, ped.z, x, z) > radius) continue;
        if (ped.state !== 'flee') startFlee(ped, source, x, z);
        scaredCount += 1;
      }
      return scaredCount;
    },

    // A horn: people in front of the car hop out of the way for a moment, then
    // go back to their errand. Distinct from scare(), which empties the street.
    startle(x, z, radius = 14, source = 'horn') {
      let startled = 0;
      for (const ped of list) {
        if (ped.state === 'down' || ped.state === 'getup') continue;
        if (ped.state === 'flee' && ped.panicSource !== 'horn') continue;
        if (dist2D(ped.x, ped.z, x, z) > radius) continue;
        startFlee(ped, source, x, z);
        ped.fleeTimer = Math.min(ped.fleeTimer, PED.hornFleeTime);
        startled += 1;
      }
      return startled;
    },

    nearestTo(x, z, maxDist = 12) {
      let best = null;
      let bestD = maxDist * maxDist;
      for (const ped of list) {
        const d = distSq2D(x, z, ped.x, ped.z);
        if (d < bestD) {
          bestD = d;
          best = ped;
        }
      }
      return best;
    },

    countDown() {
      let n = 0;
      for (const ped of list) if (ped.state === 'down') n += 1;
      return n;
    },

    stats() {
      let fleeing = 0;
      let down = 0;
      for (const ped of list) {
        if (ped.state === 'flee') fleeing += 1;
        if (ped.state === 'down') down += 1;
      }
      return { total: list.length, fleeing, down };
    },

    // Re-home a walker on the sidewalk nearest a point (used after a long haul).
    relocateNear(x, z) {
      const spot = nearestSidewalkPoint(sidewalks, x, z, rng);
      if (spot) return;
      return null;
    },
  };

  ctx.pedestrians = peds;
  return peds;
}

// -------------------------------------------------------------------- build

function makePedestrian(rng, sidewalks, id) {
  if (!sidewalks.length) return null;
  const block = pick(rng, sidewalks);
  const path = pathForBlock(block, rng);
  if (path.length < 2) return null;

  const shirt = pick(rng, SHIRTS);
  const pants = pick(rng, PANTS);
  const skin = pick(rng, SKINS);
  const build = rand(rng, 0.92, 1.1);
  const height = rand(rng, 0.94, 1.06);

  const mesh = new THREE.Group();
  mesh.name = `ped:${id}`;

  const shirtMat = new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.9 });
  const pantsMat = new THREE.MeshStandardMaterial({ color: pants, roughness: 0.92 });
  const skinMat = new THREE.MeshStandardMaterial({ color: skin, roughness: 0.75 });
  const hairMat = new THREE.MeshStandardMaterial({
    color: pick(rng, [0x2a1e17, 0x4a3322, 0x8a6a3f, 0x1c1f24, 0xb9a184]),
    roughness: 0.95,
  });
  const shoeMat = new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.9 });

  // Torso: a slightly tapered box, shoulders wider than hips.
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.44 * build, 0.6, 0.26 * build), shirtMat);
  torso.position.y = 1.16 * height;
  torso.castShadow = true;
  mesh.add(torso);

  // Hips.
  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.38 * build, 0.2, 0.24 * build), pantsMat);
  hips.position.y = 0.83 * height;
  hips.castShadow = true;
  mesh.add(hips);

  // Head + hair cap.
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.28, 0.26), skinMat);
  head.position.y = 1.62 * height;
  head.castShadow = true;
  mesh.add(head);
  const hair = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.12, 0.28), hairMat);
  hair.position.y = 1.75 * height;
  mesh.add(hair);

  // Arms on shoulder pivots so they can swing.
  const arms = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.26 * build, 1.42 * height, 0);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.52, 0.14), shirtMat);
    arm.position.y = -0.26;
    arm.castShadow = true;
    pivot.add(arm);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), skinMat);
    hand.position.y = -0.56;
    pivot.add(hand);
    mesh.add(pivot);
    arms.push({ pivot, side });
  }

  // Legs on hip pivots.
  const legs = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.12 * build, 0.8 * height, 0);
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.74, 0.17), pantsMat);
    leg.position.y = -0.37;
    leg.castShadow = true;
    pivot.add(leg);
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.1, 0.26), shoeMat);
    shoe.position.set(0, -0.76, 0.04);
    pivot.add(shoe);
    mesh.add(pivot);
    legs.push({ pivot, side });
  }

  const path0 = path[0];
  mesh.position.set(path0.x, 0, path0.z);
  const heading = Math.atan2(path[1].x - path0.x, path[1].z - path0.z);
  mesh.rotation.y = heading;

  const ped = {
    id: `ped-${id}`,
    mesh,
    parts: { torso, head, arms, legs, hips, hair },
    x: path0.x,
    z: path0.z,
    y: 0,
    heading,
    speed: 0,
    state: 'walk',
    stride: rand(rng, 0, TAU),
    path,
    pathIndex: 1,
    lap: 0,
    waitTimer: 0,
    idleTimer: 0,
    fleeTimer: 0,
    fleeHeading: heading,
    panicSource: null,
    downTimer: 0,
    getUpTimer: 0,
    fallT: 0,
    fallDir: { x: 0, z: 1 },
    fallSpin: 0,
    vy: 0,
    hitBy: null,
    walkSpeed: PEDESTRIANS.walkSpeed * rand(rng, 0.82, 1.16),
    block,
    homeX: path0.x,
    homeZ: path0.z,
    fleeTarget: null,
  };

  return ped;
}

// A rectangular loop around the sidewalk inset of one block.
function pathForBlock(block, rng) {
  const inset = PEDESTRIANS.sidewalkInset;
  const minX = block.minX + inset;
  const maxX = block.maxX - inset;
  const minZ = block.minZ + inset;
  const maxZ = block.maxZ - inset;
  if (maxX - minX < 4 || maxZ - minZ < 4) return [];
  // A random walk around the loop in either direction, started at a random side.
  const corners = [
    { x: minX, z: minZ },
    { x: maxX, z: minZ },
    { x: maxX, z: maxZ },
    { x: minX, z: maxZ },
  ];
  const start = randInt(rng, 0, 3);
  const dir = rng() < 0.5 ? 1 : -1;
  const out = [];
  for (let i = 0; i < corners.length; i += 1) {
    out.push(corners[(start + dir * i + 8) % 4]);
  }
  // Add a mid-point on each edge so walkers do not cut corners through benches.
  const dense = [];
  for (let i = 0; i < out.length; i += 1) {
    const a = out[i];
    const b = out[(i + 1) % out.length];
    dense.push(a);
    dense.push({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
  }
  return dense.slice(0, 4 + randInt(rng, 0, 4));
}

function nearestSidewalkPoint(sidewalks, x, z, rng) {
  let best = null;
  let bestD = Infinity;
  for (const b of sidewalks) {
    const d = dist2D(x, z, b.cx, b.cz);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  if (!best) return null;
  return { x: best.cx, z: best.cz };
}

// --------------------------------------------------------------- behaviours

function stepWalk(ped, dt) {
  if (ped.waitTimer > 0) {
    ped.waitTimer -= dt;
    ped.speed = lerp(ped.speed, 0, Math.min(1, dt * 6));
    return;
  }

  const target = ped.path[ped.pathIndex] ?? ped.path[0];
  const d = dist2D(ped.x, ped.z, target.x, target.z);
  if (d < PED.arriveRadius) {
    ped.pathIndex = (ped.pathIndex + 1) % ped.path.length;
    if (ped.pathIndex === 0) ped.lap += 1;
    // Occasionally stop to look at a shop window.
    if (chance(Math.random, 0.16)) ped.waitTimer = rand(Math.random, 0.8, 2.4);
    return;
  }

  const desired = Math.atan2(target.x - ped.x, target.z - ped.z);
  ped.heading = lerpAngleTowards(ped.heading, desired, dt * 4.2);
  ped.speed = lerp(ped.speed, ped.walkSpeed, Math.min(1, dt * 3.4));

  const step = ped.speed * dt;
  ped.x += Math.sin(ped.heading) * step;
  ped.z += Math.cos(ped.heading) * step;
}

function stepFlee(ped, dt) {
  ped.fleeTimer -= dt;
  if (ped.fleeTimer <= 0) {
    ped.state = 'walk';
    ped.panicSource = null;
    ped.fleeTarget = null;
    return;
  }
  // Run along the sidewalk, away from whatever scared us.
  const tgt = ped.fleeTarget ?? ped.path[ped.pathIndex] ?? ped.path[0];
  ped.heading = lerpAngleTowards(ped.heading, Math.atan2(tgt.x - ped.x, tgt.z - ped.z), dt * 6);
  ped.speed = lerp(ped.speed, PEDESTRIANS.fleeSpeed, Math.min(1, dt * 4.5));
  const step = ped.speed * dt;
  ped.x += Math.sin(ped.heading) * step;
  ped.z += Math.cos(ped.heading) * step;
  // Drop the flee target once we are close to it and keep running the loop.
  if (dist2D(ped.x, ped.z, tgt.x, tgt.z) < 2) {
    ped.pathIndex = (ped.pathIndex + 1) % ped.path.length;
    ped.fleeTarget = ped.path[ped.pathIndex] ?? ped.path[0];
  }
}

function startFlee(ped, source, fromX, fromZ) {
  ped.state = 'flee';
  ped.panicSource = source;
  ped.fleeTimer = PEDESTRIANS.fleeTime * rand(Math.random, 0.75, 1.25);
  // Aim for a path point roughly opposite the threat.
  const away = Math.atan2(ped.x - fromX, ped.z - fromZ);
  let best = null;
  let bestScore = -Infinity;
  for (const p of ped.path) {
    const a = Math.atan2(p.x - ped.x, p.z - ped.z);
    const score = Math.cos(angleDelta(a, away)) * 2 - dist2D(ped.x, ped.z, p.x, p.z) * 0.02;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  ped.fleeTarget = best ?? ped.path[0];
}

function senseThreats(ped, ctx, carHazards, playerPos) {
  // 1. A fast car near us, or one heading our way down this sidewalk.
  for (const h of carHazards) {
    const d = dist2D(ped.x, ped.z, h.x, h.z);
    if (d > PED.carAlertRadius) continue;
    // Only care if it is coming toward us.
    const dot = ((ped.x - h.x) * h.forwardX + (ped.z - h.z) * h.forwardZ) / (d || 1);
    if (dot > -0.35) {
      if (ped.state !== 'flee') startFlee(ped, 'car', h.x, h.z);
      return;
    }
  }

  // 2. Nearby police with lights on, or a wanted chase passing through.
  const police = ctx.police;
  if (police && police.wantedLevel >= 2) {
    for (const pc of ctx.vehicles.list) {
      if (pc.role !== 'police' || pc.removed) continue;
      if (dist2D(ped.x, ped.z, pc.x, pc.z) < 22) {
        if (ped.state !== 'flee') startFlee(ped, 'police', pc.x, pc.z);
        return;
      }
    }
  }

  // 3. Recent violence (a hit or a punch) close by.
  for (const ev of ctx.pedestrians.recentHits) {
    if (clockRecent(ctx, ev) && dist2D(ped.x, ped.z, ev.x, ev.z) < 26) {
      if (ped.state !== 'flee') startFlee(ped, 'fight', ev.x, ev.z);
      return;
    }
  }
}

function clockRecent(ctx, ev) {
  const now = ctx.pedestrians.clock ?? 0;
  return now - ev.t < PEDESTRIANS.fleeTime;
}

function collectCarHazards(ctx, playerPos) {
  const out = [];
  const list = ctx.vehicles?.list ?? [];
  for (const car of list) {
    if (car.removed) continue;
    const speed = Math.abs(car.speed);
    if (speed < 7) continue;
    out.push({
      x: car.x,
      z: car.z,
      forwardX: car.forwardX * Math.sign(car.speed),
      forwardZ: car.forwardZ * Math.sign(car.speed),
      speed,
    });
  }
  return out;
}

function updateDowned(ped, dt) {
  if (ped.state === 'down') {
    ped.fallT = Math.min(1, ped.fallT + dt * 5.5);
    ped.downTimer -= dt;
    // Ragdoll-ish slide: keep sliding along the fall direction and settle.
    const slide = Math.max(0, 1 - ped.fallT) * 3.2 * dt;
    ped.x += ped.fallDir.x * slide;
    ped.z += ped.fallDir.z * slide;
    if (ped.downTimer <= 0) {
      ped.state = 'getup';
      ped.getUpTimer = PED.getUpTime;
    }
  } else if (ped.state === 'getup') {
    ped.getUpTimer -= dt;
    ped.fallT = Math.max(0, ped.fallT - dt * 4.5);
    if (ped.getUpTimer <= 0) {
      ped.state = 'flee';
      ped.fleeTimer = PEDESTRIANS.fleeTime * 0.7;
      ped.panicSource = 'fight';
      startFlee(ped, 'fight', ped.x - ped.fallDir.x, ped.z - ped.fallDir.z);
    }
  }

  // Lay the body flat and give it a spin as it lands. The pivot is at the feet,
  // so rotating about X drops the whole figure onto its back.
  const t = ped.fallT;
  ped.mesh.rotation.x = lerp(0, -PED.fallFlat, easeOut(t));
  ped.mesh.rotation.z = lerp(0, ped.fallSpin * 0.25, t);
  ped.mesh.position.y = 0.2 * t;
  ped.mesh.rotation.y = ped.heading;
  // Limbs go slack.
  for (const arm of ped.parts.arms) arm.pivot.rotation.x = lerp(arm.pivot.rotation.x, -0.9, t * 0.4);
  for (const leg of ped.parts.legs) leg.pivot.rotation.x = lerp(leg.pivot.rotation.x, 0.5, t * 0.4);
}

function animatePed(ped, dt) {
  const moving = Math.abs(ped.speed) > 0.15;
  const cycle = ped.stride;
  if (moving) ped.stride += dt * (PED.walkCycleSpeed + ped.speed * 1.6);

  const swing = moving ? Math.sin(ped.stride) * clamp(ped.speed / 2, 0.24, 1.1) * 0.6 : 0;
  const counter = -swing;
  const [lLeg, rLeg] = ped.parts.legs;
  const [lArm, rArm] = ped.parts.arms;
  lLeg.pivot.rotation.x = swing;
  rLeg.pivot.rotation.x = counter;
  lArm.pivot.rotation.x = counter * 0.8;
  rArm.pivot.rotation.x = swing * 0.8;
  // Fleeing raises the arms in a cartoonish flail.
  if (ped.state === 'flee') {
    lArm.pivot.rotation.x = -1.1 + Math.sin(ped.stride * 1.4) * 0.5;
    rArm.pivot.rotation.x = -1.1 - Math.sin(ped.stride * 1.4) * 0.5;
    lArm.pivot.rotation.z = 0.4;
    rArm.pivot.rotation.z = -0.4;
  } else {
    lArm.pivot.rotation.z = lerp(lArm.pivot.rotation.z, 0, Math.min(1, dt * 4));
    rArm.pivot.rotation.z = lerp(rArm.pivot.rotation.z, 0, Math.min(1, dt * 4));
  }

  ped.mesh.rotation.x = lerp(0, 0.06, moving ? 1 : 0);
  ped.mesh.rotation.y = ped.heading;
  ped.mesh.position.x = ped.x;
  ped.mesh.position.z = ped.z;
  ped.mesh.position.y = ped.y;
}

// ------------------------------------------------------------------ physics

function separatePedestrians(list) {
  const r = PED.avoidRadius;
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a.state === 'down') continue;
    for (let j = i + 1; j < list.length; j += 1) {
      const b = list[j];
      if (b.state === 'down') continue;
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r * r || d2 < 1e-5) continue;
      const d = Math.sqrt(d2);
      const push = ((r - d) / d) * 0.5;
      a.x -= dx * push;
      a.z -= dz * push;
      b.x += dx * push;
      b.z += dz * push;
    }
  }
}

// Pedestrians get shoved out of the way of moving cars rather than overlapping
// them — the actual hit/down decision belongs to the caller (main/police).
function pushOutOfCars(list, ctx) {
  const cars = ctx.vehicles?.list ?? [];
  for (const ped of list) {
    if (ped.state === 'down') continue;
    for (const car of cars) {
      if (car.removed) continue;
      const dx = ped.x - car.x;
      const dz = ped.z - car.z;
      const reach = car.halfWidth + PEDESTRIANS.radius;
      if (dx * dx + dz * dz > (reach + 1.6) * (reach + 1.6)) continue;
      const d = Math.hypot(dx, dz) || 1;
      // Lean on the near side of the car so nobody stands inside a bonnet.
      const fwd = (dx * car.forwardX + dz * car.forwardZ);
      const lat = (dx * car.rightX + dz * car.rightZ);
      if (Math.abs(lat) < reach && Math.abs(fwd) < car.length * 0.55) {
        const side = lat >= 0 ? 1 : -1;
        ped.x = car.x + car.rightX * side * reach + car.forwardX * fwd * 0.5;
        ped.z = car.z + car.rightZ * side * reach + car.forwardZ * fwd * 0.5;
        if (Math.abs(car.speed) > 7 && ped.state !== 'flee') startFlee(ped, 'car', car.x, car.z);
      }
    }
  }
}

function pushOutOfBuildings(list, ctx) {
  const colliders = ctx.colliders ?? [];
  for (const ped of list) {
    if (ped.state === 'down') continue;
    for (let i = 0; i < colliders.length; i += 1) {
      const rect = colliders[i];
      if (rect.height !== undefined && rect.height < 0.6) continue;
      if (ped.x + 1 < rect.minX || ped.x - 1 > rect.maxX || ped.z + 1 < rect.minZ || ped.z - 1 > rect.maxZ) continue;
      const res = resolveCircleRect(ped.x, ped.z, PEDESTRIANS.radius, rect);
      if (res.hit) {
        ped.x = res.x;
        ped.z = res.z;
      }
    }
  }
}

// ---------------------------------------------------------------- helpers

function lerpAngleTowards(from, to, t) {
  return from + angleDelta(from, to) * clamp(t, 0, 1);
}

function easeOut(t) {
  return 1 - (1 - t) * (1 - t);
}

export function readPos(entity) {
  if (!entity) return null;
  if (typeof entity.x === 'number' && typeof entity.z === 'number') return { x: entity.x, z: entity.z };
  const p = entity.position;
  if (p && typeof p.x === 'number') return { x: p.x, z: p.z };
  return null;
}
