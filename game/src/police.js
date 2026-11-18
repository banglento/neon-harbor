// police.js — the wanted system, the SBPD spawner, pursuit driving and Busted.
//
//   const police = createPolice(ctx);        // registers ctx.police
//   police.raise(26, 'car theft');           // heat in, stars out
//   police.update(dt, player);               // spawn / pursue / decay / busted
//
//   police.level        // 0..5 whole stars (HUD reads this)
//   police.stars        // alias of level
//   police.heat         // 0..WANTED.heatMax continuous heat
//   police.busted       // { meter: 0..1, active, time, cooldown }
//   police.seen         // true while a unit has line of sight on the player
//
// Everything the rest of the game needs is an explicit call or an event:
//   police.raise(amount) / police.setLevel(n) / police.clear() / police.coolDown(amount)
//   ctx.events.emit('crime', { type, amount })   // optional, mapped through WANTED.crimes
//   ctx.events.on('wantedChanged', ({ level, heat }) => ...)
//   ctx.events.on('busted', ({ fine, level }) => ...)   // main.js applies the fine
//
// Police drive vehicles.js cars with role 'police'; while far from the player
// they follow the city road network, and inside ~45 m they steer straight at
// the player and try to ram or box them in.

import * as THREE from 'three';
import { WANTED, CITY, POLICE_CAR } from './config.js';
import { laneTarget } from './vehicles.js';
import {
  mulberry32,
  clamp,
  lerp,
  angleDelta,
  dist2D,
  distSq2D,
  segmentHitsRect,
} from './util.js';

const PURSUIT = {
  freeSteerRange: 45, // closer than this: steer straight at the player
  ramRange: 9,
  stopRange: 3.0,
  approachDecel: 9.5, // braking budget for the closing-speed envelope
  spawnMinRange: 40,
  spawnMaxRange: 150,
  spawnCooldown: 2.6,
  roadLookahead: 22,
  brakeAngle: 1.05,
  interceptLead: 1.1,
};

const OFFICER_RANGE = 6.5;

export function createPolice(ctx) {
  const network = ctx.city?.network ?? ctx.network;
  if (!network) throw new Error('createPolice needs ctx.city.network');
  const fleet = ctx.vehicles;
  if (!fleet) throw new Error('createPolice needs ctx.vehicles (call createVehicleSystem first)');

  const rng = mulberry32((CITY.seed ^ 0x9b17) >>> 0);
  const root = new THREE.Group();
  root.name = 'Police';
  if (ctx.scene) ctx.scene.add(root);

  const state = {
    heat: 0,
    level: 0,
    seen: false,
    timeSinceSeen: 999,
    timeSinceIncrease: 999,
    spawnTimer: 0,
    bustedMeter: 0,
    bustedCooldown: 0,
    bustedTime: 0,
    sirenOn: false,
    totalCrimes: 0,
    bustedCount: 0,
  };

  const cars = [];
  const dep = { rng, state, cars, network, fleet, root };

  const police = {
    root,
    cars,
    state,
    // ------------------------------------------------------------- getters
    get heat() {
      return state.heat;
    },
    get level() {
      return state.level;
    },
    get stars() {
      return state.level;
    },
    get wantedLevel() {
      return state.level;
    },
    get seen() {
      return state.seen;
    },
    get busted() {
      return {
        meter: state.bustedMeter,
        active: state.level > 0 && state.bustedMeter > 0.02,
        time: state.bustedTime,
        cooldown: state.bustedCooldown,
      };
    },
    // Flat aliases so the HUD can read police.bustedMeter directly.
    get bustedMeter() {
      return state.bustedMeter;
    },
    get bustedTime() {
      return state.bustedTime;
    },
    get sirenOn() {
      return state.sirenOn;
    },

    // ----------------------------------------------------------------- heat
    raise(amount, reason = 'crime') {
      if (!(amount > 0)) return state.level;
      const before = state.level;
      state.heat = clamp(state.heat + amount, 0, WANTED.heatMax);
      state.timeSinceIncrease = 0;
      state.timeSinceSeen = Math.min(state.timeSinceSeen, 0.5);
      state.totalCrimes += 1;
      applyLevel(police, ctx, before, reason);
      return state.level;
    },

    coolDown(amount) {
      if (!(amount > 0)) return state.level;
      const before = state.level;
      state.heat = clamp(state.heat - amount, 0, WANTED.heatMax);
      applyLevel(police, ctx, before, 'cooldown');
      return state.level;
    },

    setLevel(level, reason = 'set') {
      const target = clamp(Math.round(level), 0, WANTED.maxStars);
      const before = state.level;
      state.heat = clamp(WANTED.starHeat[target] ?? 0, 0, WANTED.heatMax);
      applyLevel(police, ctx, before, reason);
      return state.level;
    },

    clear(reason = 'clear') {
      const before = state.level;
      state.heat = 0;
      state.bustedMeter = 0;
      applyLevel(police, ctx, before, reason);
      for (const car of cars.slice()) removeUnit(police, ctx, car);
      return 0;
    },

    setHeat(value) {
      const before = state.level;
      state.heat = clamp(value, 0, WANTED.heatMax);
      applyLevel(police, ctx, before, 'setHeat');
      return state.level;
    },

    // --------------------------------------------------------------- pursuit
    update(dt, player) {
      if (!(dt > 0)) return;
      const actor = player ?? ctx.player;
      const pos = readPos(actor);
      const speed = playerSpeedOf(actor);
      const onFoot = playerOnFoot(actor, speed);

      state.bustedCooldown = Math.max(0, state.bustedCooldown - dt);
      state.timeSinceIncrease += dt;

      // ---- line of sight from every unit, honouring buildings.
      let seen = false;
      if (pos) {
        for (const car of cars) {
          if (car.removed) continue;
          if (dist2D(car.x, car.z, pos.x, pos.z) > WANTED.visionRange) continue;
          if (!hasLineOfSight(car.x, car.z, pos.x, pos.z, ctx)) continue;
          seen = true;
          car.ai.hasSeen = true;
          car.ai.lastSeenX = pos.x;
          car.ai.lastSeenZ = pos.z;
          break;
        }
      }
      state.seen = seen;
      state.timeSinceSeen = seen ? 0 : state.timeSinceSeen + dt;

      // ---- heat decay while hidden.
      if (state.level > 0 && !seen && state.timeSinceSeen > WANTED.decayDelay) {
        const before = state.level;
        state.heat = clamp(state.heat - WANTED.decayRate * dt, 0, WANTED.heatMax);
        applyLevel(police, ctx, before, 'decay', true);
      }

      // ---- spawn to match the wanted level.
      state.spawnTimer -= dt;
      if (state.level > 0 && state.spawnTimer <= 0 && pos) {
        state.spawnTimer = PURSUIT.spawnCooldown;
        const target = WANTED.unitsPerStar[clamp(state.level, 0, WANTED.maxStars)] ?? 0;
        const live = cars.filter((c) => !c.removed).length;
        if (live < target) spawnUnit(police, ctx, pos);
      }

      // ---- drive every unit.
      for (let i = cars.length - 1; i >= 0; i -= 1) {
        const car = cars[i];
        if (car.removed || car.role !== 'police') {
          cars.splice(i, 1);
          continue;
        }
        if (!pos) continue;
        driveUnit(car, dt, police, ctx, pos, speed, onFoot);
        const d = dist2D(car.x, car.z, pos.x, pos.z);
        if (d > WANTED.despawnRange && state.level === 0) removeUnit(police, ctx, car);
        else if (d > WANTED.despawnRange && !state.seen && state.level < 2) removeUnit(police, ctx, car);
      }

      // ---- busted meter.
      updateBusted(police, ctx, pos, speed, onFoot, dt);

      // ---- siren flag for the audio module.
      state.sirenOn = state.level > 0 && cars.length > 0;
    },

    // ------------------------------------------------------------- utilities
    spawnUnit(x, z) {
      const pos = typeof x === 'number' ? { x, z } : readPos(x);
      return spawnUnit(police, ctx, pos ?? readPos(ctx.player));
    },
    despawnAll() {
      for (const car of cars.slice()) removeUnit(police, ctx, car);
    },
    nearest(x, z, maxDist = Infinity) {
      let best = null;
      let bestD = maxDist === Infinity ? Infinity : maxDist * maxDist;
      for (const car of cars) {
        if (car.removed) continue;
        const d = distSq2D(x, z, car.x, car.z);
        if (d < bestD) {
          bestD = d;
          best = car;
        }
      }
      return best;
    },
    // Closest unit inside the busted ring, or null.
    officerNear(x, z, range = OFFICER_RANGE) {
      for (const car of cars) {
        if (car.removed) continue;
        if (dist2D(car.x, car.z, x, z) <= range) return car;
      }
      return null;
    },
    stats() {
      return {
        level: state.level,
        heat: Math.round(state.heat),
        units: cars.length,
        bustedMeter: state.bustedMeter,
        seen: state.seen,
      };
    },
  };

  // Optional convention: any module can emit a crime by type and let the
  // wanted table price it.
  if (ctx.events) {
    ctx.events.on('crime', (payload) => {
      if (!payload) return;
      const amount = payload.amount ?? WANTED.crimes[payload.type] ?? 0;
      if (amount > 0) police.raise(amount, payload.type ?? 'crime');
    });
  }

  ctx.police = police;
  return police;
}

// -------------------------------------------------------------- heat → stars

export function starsForHeat(heat) {
  let stars = 0;
  for (let i = 1; i < WANTED.starHeat.length; i += 1) {
    if (heat >= WANTED.starHeat[i]) stars = i;
  }
  return clamp(stars, 0, WANTED.maxStars);
}

export function heatForStars(stars) {
  return WANTED.starHeat[clamp(Math.round(stars), 0, WANTED.maxStars)] ?? 0;
}

function applyLevel(police, ctx, before, reason, quiet = false) {
  const state = police.state;
  const next = starsForHeat(state.heat);
  state.level = next;
  if (next !== before) {
    if (next > before) {
      state.spawnTimer = Math.min(state.spawnTimer, next > before + 1 ? 0.4 : 1.6);
      // A fresh crime re-opens the arrest window instead of inheriting the
      // cooldown from the last bust.
      state.bustedCooldown = 0;
      // Restart the unseen clock. Without this, a level 1 (16 heat) raised from
      // a quiet state begins decaying on the very next frame — 8 heat/s drains a
      // single star in two seconds, before a unit can cross the map and see you.
      state.timeSinceSeen = 0;
    }
    if (next === 0) {
      state.bustedMeter = 0;
      state.timeSinceSeen = 999;
      // Drop residual heat too: leaving 15 heat parked just under one star
      // means the next jaywalk would snap the player straight to two stars.
      state.heat = 0;
    }
    if (ctx.events) ctx.events.emit('wantedChanged', { level: next, heat: state.heat, before, reason });
  } else if (!quiet && ctx.events && reason !== 'decay') {
    ctx.events.emit('wantedHeat', { level: next, heat: state.heat, reason });
  }
}

// ------------------------------------------------------------------ spawning

function spawnUnit(police, ctx, playerPos) {
  if (!playerPos) return null;
  const network = ctx.city.network;
  const fleet = ctx.vehicles;
  const rng = police._rng ?? (police._rng = mulberry32((CITY.seed ^ 0x4d21) >>> 0));

  // Road nodes sit on a coarse lattice (~78 m apart), so a narrow distance band
  // holds only a handful of candidates and a random search mostly misses. Build
  // the candidate list once per call, ranked by distance, then pick from it.
  const candidates = [];
  for (let ix = 0; ix < network.nodeCount.x; ix += 1) {
    for (let iz = 0; iz < network.nodeCount.z; iz += 1) {
      const n = network.nodes(ix, iz);
      const d = dist2D(n.x, n.z, playerPos.x, playerPos.z);
      if (d < PURSUIT.spawnMinRange) continue;
      // A node with a car parked on it cannot take a unit: the car would spawn
      // overlapping and the pair would shove each other apart on frame one.
      if (fleet.nearest(n.x, n.z, 9)) continue;
      candidates.push({ ix, iz, d });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.d - b.d);
  // Prefer the near band, falling back to the closest clear node if none is in it.
  const band = candidates.filter((c) => c.d <= PURSUIT.spawnMaxRange);
  const pool = band.length ? band : candidates.slice(0, 3);
  const chosen = pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];

  const node = network.nodes(chosen.ix, chosen.iz);
  const options = network.neighbours(chosen.ix, chosen.iz);
  let lane = null;
  if (options.length) {
    const next = options[Math.floor(rng() * options.length)];
    lane = laneTarget(network, chosen, next);
  }
  const car = fleet.spawn({
    modelId: POLICE_CAR.id,
    x: lane ? lane.x : node.x,
    z: lane ? lane.z : node.z,
    heading: lane ? lane.heading : 0,
    role: 'police',
    police: true,
    lights: 'police',
  });
  car.ai = {
    mode: 'road',
    lastSeenX: playerPos.x,
    lastSeenZ: playerPos.z,
    hasSeen: false,
    stuck: 0,
    reverseTimer: 0,
    spawnGrace: 0.8,
  };
  police.cars.push(car);
  fleet.makeTicking(car);
  if (ctx.events) ctx.events.emit('policeSpawned', { car });
  return car;
}

function removeUnit(police, ctx, car) {
  const i = police.cars.indexOf(car);
  if (i >= 0) police.cars.splice(i, 1);
  if (!car.removed) ctx.vehicles.remove(car);
}

// ------------------------------------------------------------------ pursuit

function driveUnit(car, dt, police, ctx, playerPos, playerSpeed, onFoot) {
  const ai = car.ai;
  const network = ctx.city.network;
  const state = police.state;
  ai.spawnGrace = Math.max(0, ai.spawnGrace - dt);

  const distToPlayer = dist2D(car.x, car.z, playerPos.x, playerPos.z);

  // Where the player is heading, so the unit can cut the corner.
  const lead = clamp(distToPlayer / 26, 0, 1) * PURSUIT.interceptLead;
  const vel = actorVelocity(ctx);
  const aimX = playerPos.x + vel.x * lead;
  const aimZ = playerPos.z + vel.z * lead;

  let targetX = aimX;
  let targetZ = aimZ;

  if (state.level === 0) {
    ai.mode = 'patrol';
  } else if (distToPlayer > PURSUIT.freeSteerRange) {
    const roadTarget = roadWaypoint(car, playerPos, network);
    if (roadTarget) {
      targetX = roadTarget.x;
      targetZ = roadTarget.z;
      ai.mode = 'road';
    } else {
      ai.mode = 'free';
    }
  } else {
    ai.mode = 'free';
  }

  // Box-in behaviour: at 3+ stars, units that are already close split wide so
  // the player has to break through a wall of cars rather than one bumper.
  if (state.level >= 3 && distToPlayer < 16 && distToPlayer > 6) {
    const side = police.cars.indexOf(car) % 2 === 0 ? 1 : -1;
    targetX += Math.cos(car.heading) * side * 3.4;
    targetZ += -Math.sin(car.heading) * side * 3.4;
  }

  const desiredHeading = Math.atan2(targetX - car.x, targetZ - car.z);
  const err = angleDelta(car.heading, desiredHeading);

  // Speed policy: flat out when chasing, brake into hard corners, and close on
  // the player at a speed the brakes can actually shed before contact.
  const model = car.model;
  let targetSpeed = model.topSpeed * 0.92;
  if (Math.abs(err) > PURSUIT.brakeAngle) {
    const excess = clamp((Math.abs(err) - PURSUIT.brakeAngle) / 1.4, 0, 1);
    targetSpeed = Math.min(targetSpeed, lerp(16, 5, excess));
  }
  if (state.level === 0) targetSpeed = Math.min(targetSpeed, 12);

  // Approach envelope: v = sqrt(2 * a * d), so a unit arriving at 30 m/s is
  // already slowing by the time it reaches the bumper instead of overshooting
  // and orbiting the player at full lock.
  const gap = onFoot && state.level > 0 ? PURSUIT.stopRange : PURSUIT.ramRange * 0.6;
  const approach = Math.sqrt(Math.max(0, 2 * PURSUIT.approachDecel * (distToPlayer - gap)));
  targetSpeed = Math.min(targetSpeed, approach);

  // Inside the ring: stop the car and hold, rather than driving circles round
  // the player. The units fan out so several can sit on the block at once.
  // The hold distance must stay inside WANTED.bustedRange, or a player standing
  // still is never arrested: the ring would sit just outside the arrest radius.
  const holdAt = Math.min(gap + 1.2, WANTED.bustedRange - 0.9);
  if (distToPlayer < holdAt && state.level > 0) {
    ai.holding = true;
    targetSpeed = 0;
    car.setControls({ throttle: 0, steer: clamp(err * 0.6, -0.2, 0.2), brake: 1 });
    if (state.level > 0 && car.lightState !== 'police') car.setLights('police');
    return;
  }
  ai.holding = false;

  const speed = car.speed;
  let throttle = 0;
  let brake = 0;
  if (targetSpeed < 0.5) {
    throttle = speed > 1 ? -0.4 : 0;
    brake = speed > 1.2 ? 1 : 0;
  } else if (speed < targetSpeed - 1) {
    throttle = clamp((targetSpeed - speed) / 8, 0.3, 1);
  } else if (speed > targetSpeed + 1.2) {
    brake = clamp((speed - targetSpeed) / 8, 0, 1);
  }

  let steer = clamp(err * 2.1, -1, 1);
  // Handbrake into a tight corner at speed.
  if (Math.abs(err) > 0.8 && Math.abs(speed) > 12) brake = Math.max(brake, 0.55);

  // Stuck: reverse out, then try again. Traffic jams and kerbs happen.
  if (targetSpeed > 4 && Math.abs(speed) < 0.4 && ai.spawnGrace <= 0) ai.stuck += dt;
  else ai.stuck = Math.max(0, ai.stuck - dt * 0.6);
  if (ai.stuck > 1.8) {
    ai.stuck = 0;
    ai.reverseTimer = 0.9;
  }
  if (ai.reverseTimer > 0) {
    ai.reverseTimer -= dt;
    throttle = -1;
    steer = -steer;
    brake = 0;
  }

  car.setControls({ throttle, steer, brake });

  // Keep the light bar cycling whenever the unit is on duty.
  if (state.level > 0 && car.lightState !== 'police') car.setLights('police');
  else if (state.level === 0 && car.lightState === 'police') car.setLights('on');
}

// One road-network hop toward the player, so chases start cleanly from spawn.
function roadWaypoint(car, playerPos, network) {
  const here = network.nearestNodeIndex(car.x, car.z);
  const options = network.neighbours(here.ix, here.iz);
  if (!options.length) return null;

  let best = null;
  let bestScore = Infinity;
  for (const o of options) {
    const n = network.nodes(o.ix, o.iz);
    const d = dist2D(n.x, n.z, playerPos.x, playerPos.z);
    const turn = Math.abs(angleDelta(car.heading, network.headingTo(o.dx, o.dz)));
    const score = d + turn * 4;
    if (score < bestScore) {
      bestScore = score;
      best = o;
    }
  }
  if (!best) return null;
  const lane = laneTarget(network, here, best);
  return { x: lane.ex, z: lane.ez };
}

// ------------------------------------------------------------- the busted meter

function updateBusted(police, ctx, playerPos, playerSpeed, onFoot, dt) {
  const state = police.state;
  if (!playerPos || state.level === 0 || state.bustedCooldown > 0) {
    state.bustedMeter = Math.max(0, state.bustedMeter - dt * 0.9);
    state.bustedTime = 0;
    return;
  }

  let ringed = false;
  for (const car of police.cars) {
    if (car.removed) continue;
    if (dist2D(car.x, car.z, playerPos.x, playerPos.z) <= WANTED.bustedRange) {
      ringed = true;
      break;
    }
  }

  const slow = onFoot || playerSpeed < WANTED.bustedSpeed;
  if (ringed && slow) {
    state.bustedMeter = clamp(state.bustedMeter + dt / WANTED.bustedTime, 0, 1);
    state.bustedTime += dt;
  } else {
    state.bustedMeter = Math.max(0, state.bustedMeter - dt * 0.65);
    state.bustedTime = 0;
  }

  if (state.bustedMeter < 1) return;

  state.bustedMeter = 0;
  state.bustedTime = 0;
  state.bustedCooldown = 4;
  state.bustedCount += 1;
  const level = state.level;

  // The arrest ends the chase. The brief calls for the wanted level to clear
  // outright; WANTED.bustedHeatLoss is the softer alternative (a partial
  // write-off) if a future balance pass wants arrests to sting but not reset.
  const BUSTED_CLEARS_WANTED = true;
  state.heat = BUSTED_CLEARS_WANTED
    ? 0
    : clamp(state.heat * (1 - WANTED.bustedHeatLoss), 0, WANTED.heatMax);
  state.level = starsForHeat(state.heat);
  for (const car of police.cars.slice()) removeUnit(police, ctx, car);
  // Breathing room: no fresh unit rolls up the instant the cuffs go on.
  state.spawnTimer = 9;

  if (ctx.events) {
    ctx.events.emit('busted', {
      fine: WANTED.bustedFine,
      level,
      x: playerPos.x,
      z: playerPos.z,
    });
    if (state.level !== level) {
      ctx.events.emit('wantedChanged', { level: state.level, heat: state.heat, before: level, reason: 'busted' });
    }
  }
}

// ------------------------------------------------------------------- sensing

function hasLineOfSight(ax, az, bx, bz, ctx) {
  const colliders = ctx?.colliders;
  if (!colliders || !colliders.length) return true;
  // Broad phase: only colliders whose rect intersects the segment's bounds.
  const minX = Math.min(ax, bx);
  const maxX = Math.max(ax, bx);
  const minZ = Math.min(az, bz);
  const maxZ = Math.max(az, bz);
  for (let i = 0; i < colliders.length; i += 1) {
    const rect = colliders[i];
    if (rect.height !== undefined && rect.height < 2.4) continue;
    if (rect.maxX < minX || rect.minX > maxX || rect.maxZ < minZ || rect.minZ > maxZ) continue;
    if (segmentHitsRect(ax, az, bx, bz, rect)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- player read

export function readPos(entity) {
  if (!entity) return null;
  if (typeof entity.x === 'number' && typeof entity.z === 'number') return { x: entity.x, z: entity.z };
  const p = entity.position;
  if (p && typeof p.x === 'number') return { x: p.x, z: p.z };
  return null;
}

function playerSpeedOf(player) {
  if (!player) return 0;
  if (typeof player.speed === 'number') return Math.abs(player.speed);
  const v = player.velocity;
  if (typeof v === 'number') return Math.abs(v);
  if (v && typeof v.x === 'number') return Math.hypot(v.x, v.z);
  return 0;
}

function playerOnFoot(player, speed) {
  if (!player) return true;
  if (typeof player.onFoot === 'boolean') return player.onFoot;
  if (typeof player.inCar === 'boolean') return !player.inCar;
  if (player.car || player.vehicle) return false;
  return speed < 10;
}

function actorVelocity(ctx) {
  const player = ctx.player;
  if (player) {
    const v = player.velocity;
    if (v && typeof v.x === 'number') return { x: v.x, z: v.z };
    const car = player.car ?? player.vehicle;
    if (car && typeof car.forwardX === 'number') {
      return { x: car.forwardX * car.speed, z: car.forwardZ * car.speed };
    }
  }
  return { x: 0, z: 0 };
}

export { WANTED };
