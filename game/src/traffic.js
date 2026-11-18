// traffic.js — AI drivers on the road grid and the parked cars you can steal.
//
//   const traffic = createTraffic(ctx);      // registers ctx.traffic
//   traffic.update(dt, player);              // drives every AI car, recycles distant ones
//   traffic.spawnParked(24);                 // fills kerbside bays with stealable cars
//
// Every car here is a vehicles.js car, so the player steals one by walking up
// and pressing E — main.js calls ctx.vehicles.findEnterable() and sets
// car.occupiedBy / car.role itself. Traffic never touches a car that is
// occupied or that another module has claimed.
//
// traffic = {
//   root, cars, parkedCars, update(dt, player), spawnParked(count),
//   spawnTrafficCar(ix, iz), respawnNear(player), stats(),
//   registerHooks({ onHorn })
// }
//
// Each AI car carries car.ai = { ix, iz, tx, tz, cruise, wait, stuck, lastHorn, ... }

import * as THREE from 'three';
import { TRAFFIC, CITY } from './config.js';
import { laneTarget } from './vehicles.js';
import {
  mulberry32,
  rand,
  randInt,
  pick,
  clamp,
  lerp,
  angleDelta,
  dist2D,
  distSq2D,
  TAU,
} from './util.js';

const AI = {
  arriveRadius: 4.2,
  cruiseMin: 8.5,
  cruiseMax: 12.5,
  stopGap: 2.2,
  avoidLateral: 2.6,
  stuckTime: 5.5,
  turnLookahead: 12,
  spawnClearance: 8,
  recycleCheck: 1.4,
  bayLateral: 3.4, // further off-lane than this while stopped = parked, not blocking
};

export function createTraffic(ctx) {
  const fleet = ctx.vehicles;
  if (!fleet) throw new Error('createTraffic needs ctx.vehicles (call createVehicleSystem first)');
  const network = ctx.city?.network ?? ctx.network;
  if (!network) throw new Error('createTraffic needs ctx.city.network');

  const rng = mulberry32((CITY.seed ^ 0x7a1c) >>> 0);
  const root = new THREE.Group();
  root.name = 'Traffic';
  if (ctx.scene) ctx.scene.add(root);

  const cars = [];
  const parkedCars = [];
  const hooks = { onHorn: null };
  let recycleTimer = 0;

  const traffic = {
    root,
    cars,
    parkedCars,
    hooks,
    registerHooks(h) {
      if (h && typeof h.onHorn === 'function') hooks.onHorn = h.onHorn;
    },

    // ------------------------------------------------------------ spawning
    spawnTrafficCar(ix, iz) {
      const node = network.nodes(ix, iz);
      const options = network.neighbours(ix, iz);
      if (!options.length) return null;
      const next = pick(rng, options);
      const lane = laneTarget(network, { ix, iz }, next);
      const modelId = pick(rng, ['coral', 'vista', 'marlin', 'kestrel', 'pelican', 'sandpiper']);
      const car = fleet.spawn({
        modelId,
        x: lane.x,
        z: lane.z,
        heading: lane.heading,
        role: 'traffic',
        lights: 'on',
      });
      car.ai = {
        ix,
        iz,
        nix: next.ix,
        niz: next.iz,
        tx: lane.ex,
        tz: lane.ez,
        laneHeading: lane.heading,
        cruise: rand(rng, AI.cruiseMin, AI.cruiseMax),
        wait: 0,
        stuck: 0,
        lastHorn: -99,
        blocked: false,
        wobble: rand(rng, 0, TAU),
      };
      cars.push(car);
      fleet.makeTicking(car);
      return car;
    },

    spawnParked(count = 24) {
      const spots = ctx.city?.parkingSpots ?? [];
      if (!spots.length) return [];
      const used = [];
      // Walk the list with a random start so parked cars are spread over the map.
      const order = [];
      for (let i = 0; i < spots.length; i += 1) order.push(i);
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        const t = order[i];
        order[i] = order[j];
        order[j] = t;
      }

      for (const index of order) {
        if (parkedCars.length >= count) break;
        const spot = spots[index];
        let free = true;
        for (const other of used) {
          if (dist2D(spot.x, spot.z, other.x, other.z) < 7.6) {
            free = false;
            break;
          }
        }
        if (!free) continue;
        // Keep the spawn point and the first mission pickup clear.
        const spawn = CITY.playerStart;
        if (dist2D(spot.x, spot.z, spawn.x, spawn.z) < 12) continue;
        used.push(spot);
        const car = fleet.spawn({
          modelId: pick(rng, ['kestrel', 'marlin', 'coral', 'vista', 'pelican', 'sandpiper']),
          x: spot.x,
          z: spot.z,
          heading: spot.heading,
          role: 'parked',
        });
        car.ai = null;
        parkedCars.push(car);
      }
      return parkedCars;
    },

    // ------------------------------------------------------------- driving
    update(dt, player) {
      if (!(dt > 0)) return;
      const playerPos = readPlayerPosition(player ?? ctx.player);

      for (let i = cars.length - 1; i >= 0; i -= 1) {
        const car = cars[i];
        if (car.removed || car.role !== 'traffic') {
          // The player stole it (or it was cleaned up): forget it.
          cars.splice(i, 1);
          continue;
        }
        driveCar(car, dt, traffic, ctx, playerPos);
      }

      recycleTimer -= dt;
      if (recycleTimer <= 0) {
        recycleTimer = AI.recycleCheck;
        recycleTraffic(traffic, ctx, playerPos);
      }
    },

    respawnNear(player) {
      const pos = readPlayerPosition(player ?? ctx.player);
      const node = network.nearestNodeIndex(pos.x, pos.z);
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const ix = clamp(node.ix + randInt(rng, -2, 2), 0, network.nodeCount.x - 1);
        const iz = clamp(node.iz + randInt(rng, -2, 2), 0, network.nodeCount.z - 1);
        const n = network.nodes(ix, iz);
        const d = dist2D(n.x, n.z, pos.x, pos.z);
        if (d < 24 || d > TRAFFIC.spawnRange) continue;
        if (fleet.nearest(n.x, n.z, AI.spawnClearance)) continue;
        return traffic.spawnTrafficCar(ix, iz);
      }
      return null;
    },

    stats() {
      return { traffic: cars.length, parked: parkedCars.length };
    },
  };

  ctx.traffic = traffic;
  return traffic;
}

// --------------------------------------------------------------- the driving

function driveCar(car, dt, traffic, ctx, playerPos) {
  const ai = car.ai;
  if (!ai) return;
  const network = ctx.city.network;

  // Reached the end of this segment: pick the next node and re-aim.
  if (dist2D(car.x, car.z, ai.tx, ai.tz) < AI.arriveRadius) {
    advanceNode(car, traffic, ctx);
    if (!car.ai) return;
  }

  // Aim at the lane end point, but start turning into the next lane a little
  // early so corners look like corners rather than pivots.
  let aimX = car.ai.tx;
  let aimZ = car.ai.tz;
  const dEnd = dist2D(car.x, car.z, aimX, aimZ);
  if (dEnd < AI.turnLookahead) {
    const pull = 1 - dEnd / AI.turnLookahead;
    const ahead = car.ai.aimNext;
    if (ahead) {
      aimX = lerp(aimX, ahead.x, pull * 0.55);
      aimZ = lerp(aimZ, ahead.z, pull * 0.55);
    }
  }

  const desiredHeading = Math.atan2(aimX - car.x, aimZ - car.z);
  const err = angleDelta(car.heading, desiredHeading);

  // ---- obstacle scan: anything in the forward corridor slows us down.
  const scan = scanAhead(car, traffic, ctx, playerPos);
  ai.blocked = scan.blocked;

  let targetSpeed = ai.cruise;
  if (scan.nearest < TRAFFIC.slowRadius) {
    const t = clamp(scan.nearest / TRAFFIC.slowRadius, 0, 1);
    targetSpeed = scan.blocked ? 0 : ai.cruise * lerp(0.15, 1, t);
  }
  if (Math.abs(err) > 0.85) targetSpeed = Math.min(targetSpeed, 4.5);

  // Slow down for a turn onto a new lane.
  if (car.ai.pendingTurn) {
    targetSpeed = Math.min(targetSpeed, 6.0);
    if (Math.abs(err) < 0.4) car.ai.pendingTurn = false;
  }

  const speed = car.speed;
  let throttle = 0;
  let brake = 0;
  if (targetSpeed < 0.4) {
    throttle = speed > 1.2 ? -0.5 : 0;
    brake = speed > 0.6 ? 1 : 0;
  } else if (speed < targetSpeed - 0.6) {
    throttle = clamp((targetSpeed - speed) / 5, 0.25, 1);
  } else if (speed > targetSpeed + 0.8) {
    throttle = 0;
    brake = clamp((speed - targetSpeed) / 6, 0, 1);
  }

  const steer = clamp(err * 1.9, -1, 1);
  car.setControls({ throttle, steer, brake });

  // Stuck detection: if we have wanted to move for a while and nothing happens,
  // lean on the horn, then back up, then eventually respawn elsewhere.
  if (targetSpeed > 3 && Math.abs(speed) < 0.35) {
    ai.stuck += dt;
    const now = ctx.time ?? 0;
    if (ai.stuck > 1.4 && now - ai.lastHorn > TRAFFIC.hornCooldown) {
      ai.lastHorn = now;
      if (typeof traffic.hooks.onHorn === 'function') {
        traffic.hooks.onHorn({ car, x: car.x, z: car.z, kind: 'traffic' });
      }
    }
  } else {
    ai.stuck = Math.max(0, ai.stuck - dt * 0.8);
  }

  if (ai.stuck > AI.stuckTime) {
    ai.stuck = 0;
    // Back up briefly then re-aim; if still stuck next time, recycle.
    if (!ai.unstick) {
      ai.unstick = 1.1;
      car.setControls({ throttle: -1, steer: -steer, brake: 0 });
    } else {
      ai.unstick = 0;
      if (ctx.traffic && ctx.traffic.cars.includes(car)) {
        recycleOne(car, ctx);
      }
    }
  } else if (ai.unstick > 0) {
    ai.unstick -= dt;
  }

  // Left-hand traffic wobble in the lane, tiny and purely cosmetic.
  ai.wobble += dt * 0.6;
}

// Pick the next node when the current lane end is reached.
function advanceNode(car, traffic, ctx) {
  const network = ctx.city.network;
  const ai = car.ai;
  const options = network.neighbours(ai.nix, ai.niz);
  if (!options.length) {
    recycleOne(car, ctx);
    return;
  }
  // Prefer not to U-turn: drop the node we came from unless it is the only way.
  const filtered = options.filter((o) => !(o.ix === ai.ix && o.iz === ai.iz));
  const pool = filtered.length ? filtered : options;

  // Straight on is favoured, then right, then left; a little randomness.
  let next = pool[0];
  let bestScore = -Infinity;
  for (const o of pool) {
    const heading = network.headingTo(o.dx, o.dz);
    const turn = Math.abs(angleDelta(ai.laneHeading, heading));
    let score = -turn * 1.2 + Math.random() * 0.9;
    if (turn < 0.1) score += 1.4;
    if (score > bestScore) {
      bestScore = score;
      next = o;
    }
  }

  const lane = laneTarget(network, { ix: ai.nix, iz: ai.niz }, next);
  ai.ix = ai.nix;
  ai.iz = ai.niz;
  ai.nix = next.ix;
  ai.niz = next.iz;
  ai.tx = lane.ex;
  ai.tz = lane.ez;
  ai.laneHeading = lane.heading;
  ai.pendingTurn = Math.abs(angleDelta(car.heading, lane.heading)) > 0.25;
  ai.cruise = clamp(ai.cruise + rand(Math.random, -1.2, 1.2), AI.cruiseMin, AI.cruiseMax);

  // Pre-aim at the lane after that, for a smoother corner blend.
  const after = network.neighbours(ai.nix, ai.niz).filter((o) => !(o.ix === ai.ix && o.iz === ai.iz));
  if (after.length) {
    const pickAfter = after[0];
    const laneAfter = laneTarget(network, { ix: ai.nix, iz: ai.niz }, pickAfter);
    ai.aimNext = { x: laneAfter.ex, z: laneAfter.ez };
  } else {
    ai.aimNext = null;
  }
}

// Forward corridor test: returns { nearest, blocked, target }.
function scanAhead(car, traffic, ctx, playerPos) {
  const fx = Math.sin(car.heading);
  const fz = Math.cos(car.heading);
  const rx = Math.cos(car.heading);
  const rz = -Math.sin(car.heading);
  let nearest = Infinity;
  let blocked = false;
  let target = null;

  const consider = (x, z, radius) => {
    const dx = x - car.x;
    const dz = z - car.z;
    const ahead = dx * fx + dz * fz;
    if (ahead <= 0.2 || ahead > TRAFFIC.slowRadius * 1.5) return;
    const lateral = Math.abs(dx * rx + dz * rz);
    if (lateral > AI.avoidLateral + radius) return;
    if (ahead < nearest) {
      nearest = ahead;
      target = { x, z };
    }
    if (ahead < TRAFFIC.stopDistance && lateral < AI.avoidLateral + radius * 0.6) blocked = true;
  };

  // Other cars (traffic, the player's car, police cars). A car that is sitting
  // still and off to the side is in the kerbside bay, not the travel lane: the
  // bays are ~2.7 m from the lane centre, so counting those as blockers would
  // wedge traffic against every parked car on the street.
  const list = ctx.vehicles.list;
  for (const other of list) {
    if (other === car || other.removed) continue;
    const lateral = Math.abs((other.x - car.x) * rx + (other.z - car.z) * rz);
    if (Math.abs(other.speed) < 1 && lateral > AI.bayLateral) continue;
    const otherFwd = other.speed * (other.forwardX * fx + other.forwardZ * fz);
    // Ignore cars travelling away from us fast enough that they are pulling clear.
    if (otherFwd > 6 && (other.x - car.x) * fx + (other.z - car.z) * fz > 4) continue;
    consider(other.x, other.z, other.halfWidth);
  }

  // The player on foot is a hazard too.
  if (playerPos) {
    const pdx = playerPos.x - car.x;
    const pdz = playerPos.z - car.z;
    if (pdx * pdx + pdz * pdz < 400) consider(playerPos.x, playerPos.z, 0.9);
  }

  // Pedestrians crossing the corridor.
  const peds = ctx.pedestrians;
  if (peds && peds.list) {
    for (const ped of peds.list) {
      if (!ped || ped.state === 'down') continue;
      const dx = ped.x - car.x;
      const dz = ped.z - car.z;
      if (dx * dx + dz * dz > 900) continue;
      consider(ped.x, ped.z, 0.7);
    }
  }

  return { nearest, blocked, target };
}

// ---------------------------------------------------------------- recycling

function recycleOne(car, ctx) {
  const traffic = ctx.traffic;
  if (!traffic) return;
  const list = traffic.cars;
  const i = list.indexOf(car);
  if (i >= 0) list.splice(i, 1);
  ctx.vehicles.remove(car);
  traffic.respawnNear(ctx.player);
}

function recycleTraffic(traffic, ctx, playerPos) {
  if (!playerPos) return;
  const network = ctx.city.network;
  const slow = TRAFFIC.despawnRange * TRAFFIC.despawnRange;
  for (const car of traffic.cars.slice()) {
    const d2 = distSq2D(car.x, car.z, playerPos.x, playerPos.z);
    const occupied = car.occupiedBy || car.role !== 'traffic';
    if (occupied) continue;
    if (d2 > slow) {
      const i = traffic.cars.indexOf(car);
      if (i >= 0) traffic.cars.splice(i, 1);
      ctx.vehicles.remove(car);
    }
  }

  // Top the population back up around the player.
  let guard = 0;
  while (traffic.cars.length < TRAFFIC.count && guard < 8) {
    guard += 1;
    const node = network.nearestNodeIndex(playerPos.x, playerPos.z);
    const ix = clamp(node.ix + randInt(Math.random, -3, 3), 0, network.nodeCount.x - 1);
    const iz = clamp(node.iz + randInt(Math.random, -3, 3), 0, network.nodeCount.z - 1);
    const n = network.nodes(ix, iz);
    const d = dist2D(n.x, n.z, playerPos.x, playerPos.z);
    if (d < 18 || d > TRAFFIC.spawnRange) continue;
    if (ctx.vehicles.nearest(n.x, n.z, AI.spawnClearance)) continue;
    traffic.spawnTrafficCar(ix, iz);
  }
}

// --------------------------------------------------------------- shared bits

// Player position fallback across candidates, so traffic works whether the
// player is on foot or in a car (main.js exposes ctx.player with x/z).
export function readPlayerPosition(player) {
  if (!player) return null;
  if (typeof player.x === 'number' && typeof player.z === 'number') {
    return { x: player.x, z: player.z };
  }
  if (player.position && typeof player.position.x === 'number') {
    return { x: player.position.x, z: player.position.z };
  }
  return null;
}
