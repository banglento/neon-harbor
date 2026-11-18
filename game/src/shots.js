// shots.js — deterministic screenshot states for ?shot=<name>&seed=1.
//
//   const shot = stageShot({ ctx, shotName, seed, player, camera, hud, game });
//   // main.js then calls shot.tick(dt) every frame instead of the game loop.
//
// Each state poses the world from scratch (a player car on a downtown lane, a
// pair of cruisers on the bumper, a crowded sidewalk...), warms the simulation
// for a fixed number of fixed-size steps so traffic and pedestrians settle,
// then freezes the world and keeps only the HUD alive. Every random choice
// comes from util.js's mulberry32 seeded by the ?seed= URL parameter, so the
// same query always renders the same frame.
//
// window.__shotReady flips to true once the frozen frame has been rendered,
// which is what the capture tool waits for.
//
// States: cover, chase, foot, start.

import { CITY } from './config.js';
import { mulberry32, rand, randInt, pick, dist2D } from './util.js';
import { laneTarget } from './vehicles.js';

const STEP = 1 / 60;
const WARMUP_FRAMES = 54; // fixed steps of simulation before the freeze
const HOLD_FRAMES = 4; // renders after the freeze before declaring ready

export function stageShot(options) {
  const { ctx, shotName, seed, player, camera, hud, game } = options;
  const rng = mulberry32(((seed || 1) * 0x9e3779b1) >>> 0);
  const network = ctx.city.network;

  window.__shotReady = false;

  const setups = {
    cover: setupCover,
    chase: setupChase,
    foot: setupFoot,
    start: setupStart,
  };
  const spec = (setups[shotName] ?? setupCover)();

  let frames = 0;
  let frozenFrames = 0;
  let frozen = false;

  return {
    name: shotName,
    get frozen() {
      return frozen;
    },
    tick(dt) {
      const step = Math.min(STEP, dt > 0 ? dt : STEP);

      if (!frozen) {
        // Warm the world so traffic occupies its lanes and walkers are mid-stride.
        game.updateWorld(step);
        frames += 1;
        if (frames >= WARMUP_FRAMES) {
          frozen = true;
          if (spec.applyPose) spec.applyPose();
        }
      }

      // The HUD keeps ticking so the minimap, toasts and timers are live.
      hud.update(step, player, ctx.missions);
      spec.poseCamera();
      game.render();

      if (frozen) {
        frozenFrames += 1;
        if (frozenFrames >= HOLD_FRAMES) window.__shotReady = true;
      }
    },
  };

  // ================================================================ cover ===
  // Mara driving downtown: her car on a lane, traffic around it, mission
  // objective on the HUD and the drop marker ahead up the street.
  function setupCover() {
    prepareHud('Solmar Bay');

    const from = { ix: 1, iz: 3 };
    const to = { ix: 2, iz: 3 };
    const lane = laneTarget(network, from, to);
    const car = spawnPlayerCar('marlin', lane, 8);
    car.setControls({ throttle: 0.8, steer: 0, brake: 0 });

    clearLaneAhead(car, 34);
    seedTrafficInLane(lane, to, [21, 39, 57]);

    const dropX = lane.x + lane.dx * 74;
    const dropZ = lane.z + lane.dz * 74;
    ctx.missions.stageObjective({
      tag: 'Mission 1 · First Run',
      text: 'Deliver the crate to the drop across town.',
      sub: '142 m to the marker.',
      timer: 98,
      markers: [{ x: dropX, z: dropZ, kind: 'drop', label: 'Drop' }],
    });

    const fwd = forwardOf(car);
    const right = rightOf(car);

    return {
      poseCamera() {
        const ground = groundAt(car.x, car.z);
        camera.position.set(
          car.x - fwd.x * 11.5 + right.x * 3.6,
          ground + 4.7,
          car.z - fwd.z * 11.5 + right.z * 3.6,
        );
        camera.lookAt(car.x + fwd.x * 15, ground + 1.5, car.z + fwd.z * 15);
      },
    };
  }

  // ================================================================ chase ===
  // Four stars, two cruisers on the bumper, mission banner on the HUD.
  function setupChase() {
    prepareHud('Solmar Bay · Wanted');

    const from = { ix: 2, iz: 4 };
    const to = { ix: 3, iz: 4 };
    const lane = laneTarget(network, from, to);
    const car = spawnPlayerCar('kestrel', lane, 14);
    car.setControls({ throttle: 0.9, steer: 0.05, brake: 0 });
    clearLaneAhead(car, 46);

    // Wanted first, then pose the units by hand so their spacing is exactly
    // repeatable. police.update stays frozen for the whole shot.
    ctx.police.setLevel(4, 'shot');
    ctx.policeFrozen = true;
    poseCruiser(car, -7.6, -3.1, -0.05);
    poseCruiser(car, -12.6, 3.5, 0.09);

    ctx.missions.stageObjective({
      tag: 'Mission 3 · Harbor Lights',
      text: 'Reach the pier with the crate — lose the tail.',
      sub: 'Wanted 4 — the harbour is east of the promenade.',
      markers: [{ x: CITY.pier.endX - 16, z: CITY.pier.z, kind: 'escape', label: 'Harbour' }],
    });
    hud.banner('Mission 3 · Harbor Lights', 'Last Light');

    const fwd = forwardOf(car);
    const right = rightOf(car);

    return {
      poseCamera() {
        const ground = groundAt(car.x, car.z);
        camera.position.set(
          car.x - fwd.x * 20 + right.x * -7.4,
          ground + 8.4,
          car.z - fwd.z * 20 + right.z * -7.4,
        );
        camera.lookAt(car.x - fwd.x * 3, ground + 1.1, car.z - fwd.z * 3);
      },
    };
  }

  // ================================================================= foot ===
  // On foot on a busy sidewalk with pedestrians, traffic and a job marker.
  function setupFoot() {
    prepareHud('Solmar Bay · Calloway Row');

    const block = ctx.city.blocks.find((b) => b.ix === 2 && b.iz === 3 && b.kind !== 'park') ?? ctx.city.blocks[0];
    const centreX = (block.minX + block.maxX) / 2;
    const pathZ = block.maxZ - CITY.sidewalk * 0.72;
    const startX = centreX - 20;
    player.placeOnFoot(startX, pathZ, Math.PI / 2);
    game.syncPlayerMesh();

    dressSidewalk(block, startX, pathZ);

    ctx.missions.stageObjective({
      tag: 'Courier run',
      text: 'Collect the parcel at the marked corner.',
      sub: '24 m to go.',
      timer: 71,
      markers: [{ x: startX + 25, z: pathZ - 0.5, kind: 'pickup', label: 'Parcel' }],
    });

    return {
      poseCamera() {
        const ground = groundAt(startX, pathZ);
        camera.position.set(startX - 6.8, ground + 3.2, pathZ - 2.9);
        camera.lookAt(startX + 13, ground + 1.35, pathZ + 2.4);
      },
    };
  }

  // ================================================================ start ===
  // The title card over a slow harbour view, with a few cars on the quay.
  function setupStart() {
    hud.showScreen('start');
    hud.setDistrict('Solmar Bay');

    const quayX = (CITY.quayStartX + CITY.quayEndX) / 2 - 5;
    for (let i = 0; i < 3; i += 1) {
      const z = -46 + i * 36 + rand(rng, -7, 7);
      ctx.vehicles.spawn({
        modelId: pick(rng, ['coral', 'vista', 'pelican']),
        x: quayX + rand(rng, -2.5, 2.5),
        z,
        heading: rand(rng, -0.35, 0.35) + (i % 2 === 0 ? 0 : Math.PI),
        role: 'parked',
      });
    }
    ctx.missions.stageObjective(null);

    return {
      poseCamera() {
        camera.position.set(CITY.quayStartX - 92, 28, -104);
        camera.lookAt(CITY.pier.endX - 46, 2, CITY.pier.z + 26);
      },
    };
  }

  // ---------------------------------------------------------------- helpers

  function prepareHud(district) {
    hud.hideScreens();
    hud.el.hud.classList.add('visible');
    hud.setDistrict(district);
    hud.setSaveInfo('', true);
  }

  function groundAt(x, z) {
    return ctx.city.groundHeightAt ? ctx.city.groundHeightAt(x, z) : 0;
  }

  function forwardOf(car) {
    return { x: Math.sin(car.heading), z: Math.cos(car.heading) };
  }

  function rightOf(car) {
    return { x: Math.cos(car.heading), z: -Math.sin(car.heading) };
  }

  // Spawn the player's car `back` metres behind the lane entry, so there is
  // road visible in front of it instead of a junction.
  function spawnPlayerCar(modelId, lane, back) {
    const fx = Math.sin(lane.heading);
    const fz = Math.cos(lane.heading);
    const car = ctx.vehicles.spawn({
      modelId,
      x: lane.x - fx * back,
      z: lane.z - fz * back,
      heading: lane.heading,
      role: 'player',
    });
    player.placeInCar(car);
    return car;
  }

  // Any traffic sitting in the player's lane ahead would block the shot.
  function clearLaneAhead(car, range) {
    const fwd = forwardOf(car);
    const right = rightOf(car);
    for (const other of ctx.traffic.cars.slice()) {
      const dx = other.x - car.x;
      const dz = other.z - car.z;
      const ahead = dx * fwd.x + dz * fwd.z;
      const lateral = Math.abs(dx * right.x + dz * right.z);
      if (ahead > -7 && ahead < range && lateral < 7.5) removeTrafficCar(other);
    }
  }

  function removeTrafficCar(car) {
    const i = ctx.traffic.cars.indexOf(car);
    if (i >= 0) ctx.traffic.cars.splice(i, 1);
    if (!car.removed) ctx.vehicles.remove(car);
  }

  // Put real AI cars in the lane the still looks down, so the frame has traffic
  // beyond whatever the world happened to spawn.
  function seedTrafficInLane(lane, node, distances) {
    const fwd = Math.sin(lane.heading);
    const fzd = Math.cos(lane.heading);
    for (const distance of distances) {
      if (ctx.traffic.cars.length >= 20) break;
      const x = lane.x + fwd * distance;
      const z = lane.z + fzd * distance;
      if (ctx.vehicles.nearest(x, z, 7)) continue;
      const onward = ctx.city.network.neighbours(node.ix, node.iz)
        .filter((n) => !(n.ix === node.ix - lane.dx && n.iz === node.iz - lane.dz));
      const next = onward.length ? pick(rng, onward) : node;
      const car = ctx.vehicles.spawn({
        modelId: pick(rng, ['coral', 'vista', 'pelican', 'sandpiper']),
        x,
        z,
        heading: lane.heading,
        role: 'traffic',
        lights: 'on',
      });
      car.ai = {
        ix: node.ix,
        iz: node.iz,
        nix: next.ix,
        niz: next.iz,
        tx: x + fwd * 40,
        tz: z + fzd * 40,
        laneHeading: lane.heading,
        cruise: rand(rng, 8.5, 12.5),
        wait: 0,
        stuck: 0,
        lastHorn: -99,
        blocked: false,
        wobble: rand(rng, 0, 6.28),
      };
      ctx.traffic.cars.push(car);
      ctx.vehicles.makeTicking(car);
    }
  }

  // A cruiser placed relative to the player's car, angled as if mid-pursuit.
  function poseCruiser(car, behind, side, angle) {
    const fwd = forwardOf(car);
    const right = rightOf(car);
    const unit = ctx.vehicles.spawn({
      modelId: 'patrol',
      x: car.x + fwd.x * behind + right.x * side,
      z: car.z + fwd.z * behind + right.z * side,
      heading: car.heading + angle,
      role: 'police',
      police: true,
      lights: 'police',
    });
    unit.ai = {
      mode: 'free',
      hasSeen: true,
      lastSeenX: car.x,
      lastSeenZ: car.z,
      stuck: 0,
      reverseTimer: 0,
      spawnGrace: 2,
    };
    ctx.police.cars.push(unit);
    ctx.vehicles.makeTicking(unit);
    // A little throttle so the cruiser sits nose-up under load in the frame.
    unit.setControls({ throttle: 0.55, steer: Math.max(-1, Math.min(1, angle * 3)), brake: 0 });
    unit.setLights('police');
    return unit;
  }

  // Populate the pavement the foot shot looks down: walkers in a line along the
  // kerb plus a few across the street, all re-homed from the seeded RNG.
  function dressSidewalk(block, startX, pathZ) {
    const list = ctx.pedestrians.list;
    if (!list.length) return;
    const line = [3.5, 8, 12.5, 17, 21.5, 27];
    let index = randInt(rng, 0, Math.max(0, list.length - line.length - 1));

    for (let i = 0; i < line.length; i += 1) {
      const ped = list[(index + i) % list.length];
      const x = startX + line[i] + rand(rng, -0.7, 0.7);
      const z = pathZ + rand(rng, -1.0, 1.0);
      placePed(ped, x, z, i % 3 === 0 ? -Math.PI / 2 : Math.PI / 2);
    }

    index = (index + line.length) % list.length;
    for (let i = 0; i < 3; i += 1) {
      const ped = list[(index + i) % list.length];
      const x = startX + 5 + i * 12 + rand(rng, -1.5, 1.5);
      const z = block.minZ + CITY.sidewalk * 0.9 + rand(rng, -0.5, 0.5);
      placePed(ped, x, z, i % 2 === 0 ? Math.PI / 2 : -Math.PI / 2);
    }
  }

  function placePed(ped, x, z, heading) {
    ped.x = x;
    ped.z = z;
    ped.heading = heading;
    ped.state = 'walk';
    ped.speed = 1.2;
    ped.downTimer = 0;
    ped.fallT = 0;
    ped.fleeTimer = 0;
    ped.hitBy = null;
    // A short two-point path along the pavement keeps the walk cycle heading
    // the right way for the warm-up frames instead of walking back into a block.
    ped.path = [
      { x, z },
      { x: x + Math.sin(heading) * 9, z: z + Math.cos(heading) * 9 },
    ];
    ped.pathIndex = 1;
    ped.homeX = x;
    ped.homeZ = z;
    if (ped.mesh) {
      ped.mesh.position.set(x, 0, z);
      ped.mesh.rotation.set(0, heading, 0);
    }
  }
}

// Nearby pedestrians, so a caller can decorate a still without reaching into
// the shape of the pedestrians module beyond x/z/state.
export function nearbyPeds(ctx, x, z, radius) {
  const out = [];
  for (const ped of ctx.pedestrians?.list ?? []) {
    if (dist2D(ped.x, ped.z, x, z) <= radius) out.push(ped);
  }
  return out;
}
