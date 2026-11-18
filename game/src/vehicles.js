// vehicles.js — the car factory, the world car registry and arcade physics.
//
//   const fleet = createVehicleSystem(ctx);   // registers ctx.vehicles
//   const car = fleet.spawn({ modelId: 'kestrel', x, z, heading, role: 'parked' });
//   fleet.update(dt);                          // physics, damage smoke, registry sync
//
// Pitch convention matches util.js: heading 0 faces +Z and forward is
// (sin(heading), cos(heading)). The model's nose is +Z in local space too,
// so the mesh only ever needs rotation.y = heading.
//
// car = {
//   id, model (config entry), modelId, name, role,        // 'parked'|'traffic'|'police'|'player'|'mission'
//   mesh, body, root, wheels[], lights, lightState,
//   x, z, heading, speed,                                  // speed in m/s along forward
//   forwardX, forwardZ, rightX, rightZ,
//   length, width, radius, halfWidth, mass,
//   health, damage, smoke, occupiedBy,                     // health 0..1, damage 1-health
//   controls,                                              // { throttle, steer, brake } for self-driven cars
//   ai,                                                    // free-form slot for traffic.js / police.js
//   spawnIndex,
//   position: { x, z },                                    // tiny stable object for HUD/audio
//   setControls(t), clearControls(), applyImpulse(dx, dz, amount),
//   damageFrom(amount), repair(), setLights(state), despawn()
// }
//
// fleet = {
//   root, list, get(id), count, nearest(x, z, maxDist, filter),
//   spawn(opts), remove(car), update(dt),
//   forwardX(angle), forwardZ(angle),
//   findEnterable(playerX, playerZ, range),                 // nearest car the player may sit in
//   ticking: []                                             // cars that need physics each frame
// }

import * as THREE from 'three';
import { CAR_MODELS, POLICE_CAR, VEHICLE, CITY } from './config.js';
import {
  mulberry32,
  rand,
  pick,
  clamp,
  lerp,
  wrapAngle,
  distSq2D,
  resolveCircleRect,
  rotateXZ,
  TAU,
} from './util.js';

// Internal handling constants that the rest of the game never needs to know.
const PHYS = {
  steerRate: 3.4, // how fast the front wheels reach the requested angle
  handbrakeDrag: 1.9,
  rollingDrag: 0.42,
  topSpeedFactor: 1.0,
  collisionDamage: 0.06,
  impactDamagePerSpeed: 0.022,
  maxStep: 1 / 30,
  lightDistance: 140,
  // Below this health the engine is gone: the car still rolls and steers, but
  // the throttle only produces a fraction of its normal pull.
  wreckedHealth: 0.12,
  wreckedThrottle: 0.22,
};

const LIGHT_STATES = {
  off: { head: 0.15, tail: 0.5 },
  on: { head: 3.4, tail: 1.2 },
  brake: { head: 3.4, tail: 4.2 },
  police: { head: 3.4, tail: 1.4 },
};

const MODEL_BY_ID = new Map();
for (const model of CAR_MODELS) MODEL_BY_ID.set(model.id, model);
MODEL_BY_ID.set(POLICE_CAR.id, POLICE_CAR);

export function getModel(id) {
  return MODEL_BY_ID.get(id) ?? null;
}

export function modelIds() {
  return CAR_MODELS.map((m) => m.id);
}

// ------------------------------------------------------------------ registry

export function createVehicleSystem(ctx) {
  const rng = mulberry32((CITY.seed ^ 0x51c0) >>> 0);
  const root = new THREE.Group();
  root.name = 'Vehicles';
  if (ctx.scene) ctx.scene.add(root);

  const list = [];
  const byId = new Map();
  const smokePool = [];
  let nextId = 1;
  let time = 0;

  const fleet = {
    root,
    list,
    ticking: [],
    get(id) {
      return byId.get(id) ?? null;
    },
    count() {
      return list.length;
    },
    spawn(opts) {
      const car = buildCar(opts, rng, nextId);
      nextId += 1;
      car.id = `car-${nextId}-${opts.modelId ?? 'm'}`;
      root.add(car.root);
      list.push(car);
      byId.set(car.id, car);
      car.registry = { fleet, list, byId };
      return car;
    },
    remove(car) {
      if (!car || car.removed) return;
      car.removed = true;
      const i = list.indexOf(car);
      if (i >= 0) list.splice(i, 1);
      byId.delete(car.id);
      const t = fleet.ticking.indexOf(car);
      if (t >= 0) fleet.ticking.splice(t, 1);
      root.remove(car.root);
      releaseSmoke(car);
      car.despawn();
    },
    nearest(x, z, maxDist, filter) {
      let best = null;
      let bestD = maxDist * maxDist;
      for (const car of list) {
        if (filter && !filter(car)) continue;
        const d = distSq2D(x, z, car.x, car.z);
        if (d < bestD) {
          bestD = d;
          best = car;
        }
      }
      return best;
    },
    findEnterable(playerX, playerZ, range = VEHICLE.enterRange) {
      return fleet.nearest(playerX, playerZ, range, (car) => !car.occupiedBy && !car.removed);
    },
    update(dt) {
      time += dt;
      // Physics only for cars that are being driven, pushed or coasting.
      const active = fleet.ticking;
      for (let i = active.length - 1; i >= 0; i -= 1) {
        const car = active[i];
        if (car.removed) {
          active.splice(i, 1);
          continue;
        }
        stepCar(car, dt, fleet, ctx);
        if (car.idleFor > 0.6) active.splice(i, 1);
      }
      // Car-car repulsion runs on everything active plus parked cars near a mover.
      resolveCarPairs(fleet, ctx);
      for (const car of list) {
        updateCarVisuals(car, dt, ctx, time);
      }
    },
    forwardX: (angle) => Math.sin(angle),
    forwardZ: (angle) => Math.cos(angle),
    makeTicking(car) {
      car.idleFor = 0;
      if (!fleet.ticking.includes(car)) fleet.ticking.push(car);
    },
    clearAll() {
      for (const car of list.slice()) fleet.remove(car);
    },
    stats() {
      let police = 0;
      let moving = 0;
      for (const car of list) {
        if (car.role === 'police') police += 1;
        if (Math.abs(car.speed) > 1) moving += 1;
      }
      return { total: list.length, police, moving };
    },
  };

  ctx.vehicles = fleet;
  return fleet;
}

// --------------------------------------------------------------------- build

function buildCar(opts, rng, spawnIndex) {
  const model = getModel(opts.modelId) ?? CAR_MODELS[0];
  const police = opts.police ?? model.id === POLICE_CAR.id;
  const color = opts.color ?? (police ? model.bodyColor : pick(rng, model.colors ?? [0xcccccc]));

  const root = new THREE.Group();
  root.name = `car:${model.name}`;

  const bodyMat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.42,
    metalness: 0.35,
  });
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.7, metalness: 0.25 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x1e2a35,
    roughness: 0.12,
    metalness: 0.55,
    transparent: true,
    opacity: 0.86,
  });
  const chromeMat = new THREE.MeshStandardMaterial({ color: 0xd7dbe0, roughness: 0.28, metalness: 0.8 });

  const group = new THREE.Group(); // body group, origin at the ride height
  const L = model.length;
  const W = model.width;
  const H = model.height;

  // Lower shell: a chamfered slab that gives every model a car-like mass.
  const lower = new THREE.Mesh(new THREE.BoxGeometry(W, H * 0.42, L * 0.98), bodyMat);
  lower.position.y = H * 0.21 + 0.28;
  lower.castShadow = true;
  lower.receiveShadow = true;
  group.add(lower);

  // Slightly tapered side skirts / rocker panels.
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(W + 0.04, 0.16, L * 0.9), trimMat);
  skirt.position.y = 0.3;
  group.add(skirt);

  // Cabin timing and roofline per style.
  let cabinFront = 0.58;
  let cabinBack = -0.78;
  let cabinHeight = H * 0.52;
  let cabinInset = 0.16;
  if (model.style === 'coupe') {
    cabinFront = 0.34;
    cabinBack = -0.82;
    cabinHeight = H * 0.5;
  } else if (model.style === 'muscle') {
    cabinFront = 0.2;
    cabinBack = -0.86;
    cabinHeight = H * 0.48;
  } else if (model.style === 'hatch') {
    cabinFront = 0.62;
    cabinBack = -0.92;
    cabinHeight = H * 0.62;
  } else if (model.style === 'wagon') {
    cabinFront = 0.62;
    cabinBack = -0.94;
    cabinHeight = H * 0.6;
  } else if (model.style === 'pickup') {
    cabinFront = 0.62;
    cabinBack = -0.2;
    cabinHeight = H * 0.66;
  } else if (model.style === 'buggy') {
    cabinFront = 0.4;
    cabinBack = -0.66;
    cabinHeight = H * 0.6;
  } else if (model.style === 'sedan') {
    cabinFront = 0.5;
    cabinBack = -0.74;
    cabinHeight = H * 0.55;
  }

  if (model.style === 'pickup') {
    // Cab block plus an open bed with rails.
    const cab = new THREE.Mesh(new THREE.BoxGeometry(W * 0.9, cabinHeight, L * 0.4), bodyMat);
    cab.position.set(0, 0.28 + H * 0.42 + cabinHeight / 2 - 0.1, (L * cabinFront + L * cabinBack) / 2 + L * 0.06);
    cab.castShadow = true;
    group.add(cab);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(W * 0.82, cabinHeight * 0.62, L * 0.4 + 0.02), glassMat);
    glass.position.copy(cab.position).setY(cab.position.y + cabinHeight * 0.08);
    group.add(glass);

    const bedLen = L * 0.42;
    const bedZ = -L * 0.34;
    const bedFloor = new THREE.Mesh(new THREE.BoxGeometry(W * 0.86, 0.1, bedLen), trimMat);
    bedFloor.position.set(0, 0.28 + H * 0.44, bedZ);
    group.add(bedFloor);
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.34, bedLen), bodyMat);
      rail.position.set(side * (W * 0.43), 0.28 + H * 0.5, bedZ);
      rail.castShadow = true;
      group.add(rail);
    }
    const tailgate = new THREE.Mesh(new THREE.BoxGeometry(W * 0.86, 0.34, 0.1), bodyMat);
    tailgate.position.set(0, 0.28 + H * 0.5, bedZ - bedLen / 2);
    group.add(tailgate);
  } else if (model.style === 'buggy') {
    // Exposed roll cage over an open tub.
    const tub = new THREE.Mesh(new THREE.BoxGeometry(W * 0.94, H * 0.34, L * 0.86), bodyMat);
    tub.position.y = 0.28 + H * 0.3;
    tub.castShadow = true;
    group.add(tub);
    const cageMat = new THREE.MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.5, metalness: 0.7 });
    const cageGeo = new THREE.CylinderGeometry(0.06, 0.06, cabinHeight, 5);
    const cagePositions = [
      [W * 0.4, cabinFront * L * 0.7],
      [-W * 0.4, cabinFront * L * 0.7],
      [W * 0.4, cabinBack * L * 0.7],
      [-W * 0.4, cabinBack * L * 0.7],
    ];
    for (const [cx, cz] of cagePositions) {
      const post = new THREE.Mesh(cageGeo, cageMat);
      post.position.set(cx, 0.28 + H * 0.5 + cabinHeight / 2, cz);
      group.add(post);
    }
    const roofBar = new THREE.Mesh(new THREE.BoxGeometry(W * 0.84, 0.1, 0.1), cageMat);
    roofBar.position.set(0, 0.28 + H * 0.5 + cabinHeight, 0);
    group.add(roofBar);
  } else {
    // Closed cabin: a trapezoid-ish block with a glass band. The taper and the
    // roofline change per style so a coupe does not read as a wagon.
    const cabinLen = L * (cabinFront - cabinBack);
    const cabinZ = (L * cabinFront + L * cabinBack) / 2;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(W, cabinHeight, cabinLen), bodyMat);
    cabin.position.set(0, 0.28 + H * 0.42 + cabinHeight / 2, cabinZ);
    cabin.castShadow = true;
    group.add(cabin);

    const glass = new THREE.Mesh(new THREE.BoxGeometry(W + 0.02, cabinHeight * 0.56, cabinLen + 0.04), glassMat);
    glass.position.set(0, cabin.position.y + cabinHeight * 0.05, cabinZ);
    group.add(glass);

    const roof = new THREE.Mesh(new THREE.BoxGeometry(W * 0.94, 0.12, cabinLen * 0.92), bodyMat);
    roof.position.set(0, cabin.position.y + cabinHeight / 2, cabinZ);
    roof.castShadow = true;
    group.add(roof);

    // Style-specific silhouette work.
    if (model.style === 'coupe' || model.style === 'muscle') {
      // Fastback: a sloped rear deck closing the roof to the tail.
      const slope = new THREE.Mesh(new THREE.BoxGeometry(W * 0.9, 0.1, cabinLen * 0.7), bodyMat);
      slope.position.set(0, cabin.position.y + cabinHeight * 0.22, cabinZ - cabinLen * 0.62);
      slope.rotation.x = -0.34;
      slope.castShadow = true;
      group.add(slope);
    }
    if (model.style === 'coupe') {
      // Ducktail spoiler.
      const spoiler = new THREE.Mesh(new THREE.BoxGeometry(W * 0.8, 0.07, 0.34), trimMat);
      spoiler.position.set(0, 0.28 + H * 0.44, -L * 0.45);
      group.add(spoiler);
    }
    if (model.style === 'muscle') {
      // Bonnet scoop and a fatter rear haunch.
      const scoop = new THREE.Mesh(new THREE.BoxGeometry(W * 0.34, 0.12, 0.9), trimMat);
      scoop.position.set(0, 0.28 + H * 0.44, L * 0.26);
      group.add(scoop);
      for (const side of [-1, 1]) {
        const haunch = new THREE.Mesh(new THREE.BoxGeometry(0.1, H * 0.3, L * 0.3), bodyMat);
        haunch.position.set(side * (W / 2 + 0.03), 0.28 + H * 0.26, -L * 0.24);
        group.add(haunch);
      }
    }
    if (model.style === 'wagon') {
      // Roof rails plus a squared-off tailgate window.
      for (const side of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, cabinLen * 0.9), chromeMat);
        rail.position.set(side * W * 0.38, roof.position.y + 0.1, cabinZ);
        group.add(rail);
      }
      const tailGlass = new THREE.Mesh(new THREE.BoxGeometry(W * 0.78, cabinHeight * 0.5, 0.05), glassMat);
      tailGlass.position.set(0, cabin.position.y + cabinHeight * 0.1, cabinZ - cabinLen / 2 - 0.02);
      group.add(tailGlass);
    }
    if (model.style === 'hatch') {
      // Short, upright hatch: a small rear window and a stubby bumper lip.
      const hatchGlass = new THREE.Mesh(new THREE.BoxGeometry(W * 0.8, cabinHeight * 0.46, 0.05), glassMat);
      hatchGlass.position.set(0, cabin.position.y + cabinHeight * 0.12, cabinZ - cabinLen / 2 - 0.02);
      group.add(hatchGlass);
      const lip = new THREE.Mesh(new THREE.BoxGeometry(W * 0.86, 0.1, 0.3), trimMat);
      lip.position.set(0, 0.28 + H * 0.42, -L * 0.46);
      group.add(lip);
    }
    if (model.style === 'sedan') {
      // Roof beacon mast stub and a spotlight post: patrol silhouette.
      const spotlight = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.3, 5), trimMat);
      spotlight.position.set(W * 0.34, 0.28 + H * 0.46, L * 0.3);
      group.add(spotlight);
    }
  }

  // Bonnet and boot lips read as panel gaps from a distance.
  const noseLip = new THREE.Mesh(new THREE.BoxGeometry(W * 0.96, 0.06, 0.12), trimMat);
  noseLip.position.set(0, 0.28 + H * 0.42, L * 0.48);
  group.add(noseLip);

  // Lights: two emissive headlight blocks and two taillight bars.
  const lightMat = new THREE.MeshStandardMaterial({
    color: 0xfff6dc,
    emissive: new THREE.Color(0xfff0c0),
    emissiveIntensity: LIGHT_STATES.off.head,
    roughness: 0.3,
  });
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x8f1414,
    emissive: new THREE.Color(0xff2418),
    emissiveIntensity: LIGHT_STATES.off.tail,
    roughness: 0.35,
  });
  const headlights = new THREE.Group();
  for (const side of [-1, 1]) {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(W * 0.22, 0.16, 0.08), lightMat);
    lamp.position.set(side * W * 0.32, 0.28 + H * 0.3, L * 0.49);
    headlights.add(lamp);
  }
  group.add(headlights);

  const taillights = new THREE.Group();
  for (const side of [-1, 1]) {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(W * 0.24, 0.14, 0.07), tailMat);
    lamp.position.set(side * W * 0.32, 0.28 + H * 0.34, -L * 0.49);
    taillights.add(lamp);
  }
  group.add(taillights);

  // Bumpers.
  const bumper = new THREE.Mesh(new THREE.BoxGeometry(W * 0.92, 0.16, 0.14), chromeMat);
  bumper.position.set(0, 0.32, L * 0.5);
  group.add(bumper);
  const rearBumper = new THREE.Mesh(new THREE.BoxGeometry(W * 0.92, 0.16, 0.14), chromeMat);
  rearBumper.position.set(0, 0.32, -L * 0.5);
  group.add(rearBumper);

  // Police dress-up: door band, roof bar, push bar, door decal panel.
  const emergency = { bar: null, blue: null, red: null };
  if (police) {
    const accent = new THREE.MeshStandardMaterial({ color: model.accentColor ?? 0x1f3f8c, roughness: 0.5 });
    for (const side of [-1, 1]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.04, H * 0.2, L * 0.56), accent);
      band.position.set(side * (W / 2 + 0.01), 0.28 + H * 0.24, 0);
      group.add(band);
    }
    const pushBar = new THREE.Mesh(new THREE.BoxGeometry(W * 0.7, 0.34, 0.12), trimMat);
    pushBar.position.set(0, 0.34, L * 0.54);
    group.add(pushBar);

    const bar = new THREE.Group();
    const barBase = new THREE.Mesh(new THREE.BoxGeometry(W * 0.6, 0.1, 0.22), trimMat);
    barBase.position.y = 0.02;
    bar.add(barBase);
    const blueMat = new THREE.MeshStandardMaterial({
      color: 0x3f7bff,
      emissive: new THREE.Color(0x3f7bff),
      emissiveIntensity: 0.2,
      roughness: 0.3,
    });
    const redMat = new THREE.MeshStandardMaterial({
      color: 0xff3b30,
      emissive: new THREE.Color(0xff3b30),
      emissiveIntensity: 0.2,
      roughness: 0.3,
    });
    const blueLamp = new THREE.Mesh(new THREE.BoxGeometry(W * 0.26, 0.14, 0.16), blueMat);
    blueLamp.position.set(-W * 0.16, 0.14, 0);
    bar.add(blueLamp);
    const redLamp = new THREE.Mesh(new THREE.BoxGeometry(W * 0.26, 0.14, 0.16), redMat);
    redLamp.position.set(W * 0.16, 0.14, 0);
    bar.add(redLamp);
    bar.position.set(0, 0.28 + H * 0.84 + (model.style === 'sedan' ? 0 : 0.04), -0.1);
    group.add(bar);
    emergency.bar = bar;
    emergency.blue = blueLamp.material;
    emergency.red = redLamp.material;
  }

  // Wheels: four cylinders lying on their sides, parented to steer pivots in front.
  const wheelRadius = VEHICLE.wheelRadius;
  const wheelGeo = new THREE.CylinderGeometry(wheelRadius, wheelRadius, 0.26, 12);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x191b1f, roughness: 0.92 });
  const hubGeo = new THREE.CylinderGeometry(wheelRadius * 0.5, wheelRadius * 0.5, 0.28, 8);
  const wheels = [];
  const wheelZ = L * (model.style === 'pickup' ? 0.38 : 0.34);
  const wheelX = W / 2 - 0.08;
  for (const [fx, fz, front] of [
    [-wheelX, wheelZ, true],
    [wheelX, wheelZ, true],
    [-wheelX, -wheelZ, false],
    [wheelX, -wheelZ, false],
  ]) {
    const pivot = new THREE.Group();
    pivot.position.set(fx, wheelRadius, fz);
    const spin = new THREE.Group();
    const tyre = new THREE.Mesh(wheelGeo, wheelMat);
    tyre.rotation.z = Math.PI / 2;
    tyre.castShadow = true;
    spin.add(tyre);
    const hub = new THREE.Mesh(hubGeo, chromeMat);
    hub.rotation.z = Math.PI / 2;
    spin.add(hub);
    pivot.add(spin);
    group.add(pivot);
    wheels.push({ pivot, spin, front, radius: wheelRadius });
  }

  group.position.y = VEHICLE.rideHeight;
  root.add(group);

  // Damage smoke: a few soft puffs in a pool, parented to the body so they
  // inherit the car's position and heading, hidden until the car is hurt.
  const smoke = buildSmoke();
  root.add(smoke.group);

  const car = {
    id: '',
    model,
    modelId: model.id,
    name: model.name,
    police,
    role: opts.role ?? 'parked',
    root,
    body: group,
    wheels,
    lights: { head: lightMat, tail: tailMat, emergency },
    lightState: 'off',
    x: opts.x ?? 0,
    z: opts.z ?? 0,
    heading: opts.heading ?? 0,
    speed: 0,
    steer: 0,
    yawRate: 0,
    forwardX: Math.sin(opts.heading ?? 0),
    forwardZ: Math.cos(opts.heading ?? 0),
    rightX: Math.cos(opts.heading ?? 0),
    rightZ: -Math.sin(opts.heading ?? 0),
    length: L,
    width: W,
    radius: Math.hypot(L, W) / 2 + 0.05,
    halfWidth: W / 2 + 0.1,
    mass: 1 + L * W * 0.05,
    health: 1,
    damage: 0,
    smoke,
    smokeLevel: 0,
    occupiedBy: null,
    controls: null,
    ai: null,
    driver: null,
    spawnIndex,
    sparkTimer: 0,
    wheelSpin: 0,
    idleFor: 0,
    bobPhase: rand(rng, 0, TAU),
    position: { x: opts.x ?? 0, z: opts.z ?? 0 },
    setControls(c) {
      if (!c) {
        car.controls = null;
        return;
      }
      car.controls = {
        throttle: clamp(c.throttle ?? 0, -1, 1),
        steer: clamp(c.steer ?? 0, -1, 1),
        brake: c.brake ? clamp(c.brake, 0, 1) : 0,
      };
      if (car.registry) car.registry.fleet.makeTicking(car);
    },
    clearControls() {
      car.controls = null;
    },
    applyImpulse(dx, dz, amount) {
      // Nudge position and add a little sideways speed; used by ramming passes.
      const len = Math.hypot(dx, dz) || 1;
      car.x += (dx / len) * amount * 0.6;
      car.z += (dz / len) * amount * 0.6;
      const side = (dx / len) * car.rightX + (dz / len) * car.rightZ;
      car.speed += (dx / len) * car.forwardX * amount * 2.2 + side * Math.abs(amount) * 0.8;
      car.damageFrom(Math.abs(amount) * 0.05);
      syncTransform(car);
      if (car.registry) car.registry.fleet.makeTicking(car);
    },
    damageFrom(amount) {
      if (!(amount > 0)) return car.health;
      car.health = clamp(car.health - amount, 0, 1);
      car.damage = 1 - car.health;
      return car.health;
    },
    repair() {
      car.health = 1;
      car.damage = 0;
      car.smokeLevel = 0;
      setSmokeVisible(car, false);
    },
    setLights(state) {
      car.lightState = LIGHT_STATES[state] ? state : 'off';
      applyLightState(car);
    },
    despawn() {
      setSmokeVisible(car, false);
    },
    isStationary() {
      return Math.abs(car.speed) < 0.4;
    },
  };

  syncTransform(car);
  applyLightState(car);
  if (opts.lights) car.setLights(opts.lights);
  if (opts.health !== undefined) car.damageFrom(1 - opts.health);
  return car;
}

function applyLightState(car) {
  const state = LIGHT_STATES[car.lightState] ?? LIGHT_STATES.off;
  car.lights.head.emissiveIntensity = state.head;
  car.lights.tail.emissiveIntensity = state.tail;
  const em = car.lights.emergency;
  if (!em || !em.blue) return;
  if (car.lightState === 'police') {
    em.blue.emissiveIntensity = 2.6;
    em.red.emissiveIntensity = 0.3;
  } else {
    em.blue.emissiveIntensity = 0.15;
    em.red.emissiveIntensity = 0.15;
  }
}

// ------------------------------------------------------------------- physics

function stepCar(car, dt, fleet, ctx) {
  if (!car.controls) {
    // Coasting: let drag bring the car to rest so nothing keeps ticking forever.
    car.speed *= Math.max(0, 1 - PHYS.rollingDrag * dt);
    if (Math.abs(car.speed) < 0.25) {
      car.speed = 0;
      car.idleFor += dt;
      syncTransform(car);
      return;
    }
    car.idleFor = 0;
  }

  const model = car.model;
  const ctl = car.controls ?? { throttle: 0, steer: 0, brake: 0 };
  const maxSpeed = model.topSpeed * PHYS.topSpeedFactor;
  const before = car.speed;

  // A car battered past wreckedHealth loses most of its pull. Without this a
  // zero-health car drives exactly like a fresh one and the damage model is
  // purely cosmetic; braking (below) still works in full so you can coast out.
  const pull = car.health <= PHYS.wreckedHealth ? PHYS.wreckedThrottle : 1;

  // Longitudinal: throttle accelerates toward the cap, brake and reverse oppose.
  if (ctl.throttle > 0) {
    if (car.speed < 0) car.speed += model.brake * ctl.throttle * dt;
    else car.speed += model.accel * pull * ctl.throttle * (1 - (car.speed / maxSpeed) * 0.72) * dt;
  } else if (ctl.throttle < 0) {
    if (car.speed > 0.4) {
      car.speed += model.brake * ctl.throttle * dt;
    } else {
      // Reverse gear is slow and capped at about a third of the top speed.
      car.speed = Math.max(-maxSpeed * 0.32, car.speed + model.accel * 0.6 * pull * ctl.throttle * dt);
    }
  }

  if (ctl.brake > 0) {
    const drag = 1 - ctl.brake * Math.min(1, dt * 4.5);
    car.speed *= drag;
    if (Math.abs(car.speed) < 0.6) car.speed *= 0.5;
  }

  if (!ctl.throttle) {
    const rr = PHYS.rollingDrag * dt;
    car.speed *= Math.max(0, 1 - rr - Math.abs(car.speed) * 0.006 * dt * 60);
  }

  car.speed = clamp(car.speed, -maxSpeed * 0.4, maxSpeed);

  // Brake lights whenever the car is slowing noticeably.
  const slowing = ctl.throttle < 0 || ctl.brake > 0;
  if (car.lightState !== 'police') {
    const want = slowing && Math.abs(car.speed) > 0.5 ? 'brake' : car.lightState === 'brake' ? 'on' : car.lightState;
    if (want !== car.lightState) car.setLights(want);
  }

  // Steering: authority shrinks as speed rises so top-speed runs stay stable.
  const speedFrac = clamp(Math.abs(car.speed) / maxSpeed, 0, 1);
  const turnAuthority = model.turnRate * (1 - speedFrac * 0.42) * (Math.abs(car.speed) > 0.2 ? 1 : 0);
  const desiredSteer = ctl.steer * (ctl.brake > 0.4 ? 1.35 : 1);
  car.steer = lerp(car.steer, desiredSteer, Math.min(1, PHYS.steerRate * dt));
  const direction = car.speed < -0.1 ? -1 : 1;
  car.yawRate = car.steer * turnAuthority * direction * clamp(Math.abs(car.speed) / 3.2, 0, 1);
  car.heading = wrapAngle(car.heading + car.yawRate * dt);

  if (!car.controls) car.idleFor += 0;
  else car.idleFor = 0;

  const fx = Math.sin(car.heading);
  const fz = Math.cos(car.heading);
  car.forwardX = fx;
  car.forwardZ = fz;
  car.rightX = Math.cos(car.heading);
  car.rightZ = -Math.sin(car.heading);

  const step = clamp(dt, 0, PHYS.maxStep);
  let nx = car.x + fx * car.speed * step;
  let nz = car.z + fz * car.speed * step;

  // Speed gained this frame is the acceleration; damage scales with it plus impact.
  const gained = Math.abs(car.speed - before);

  // Buildings: resolve the car's centre circle, kill the speed on impact.
  const hitRect = collideWithBuildings(nx, nz, car, ctx);
  if (hitRect) {
    nx = hitRect.x;
    nz = hitRect.z;
    const impact = Math.abs(car.speed);
    car.speed *= VEHICLE.collisionBounce - 0.2;
    if (impact > 2.5) {
      const dmg = Math.min(0.5, PHYS.collisionDamage + impact * PHYS.impactDamagePerSpeed);
      car.damageFrom(dmg);
      if (ctx.events) ctx.events.emit('carCrash', { car, impact, x: car.x, z: car.z });
    }
  }

  // Deep water and the far edges of the map stop the car dead (soft wall).
  if (ctx.city && ctx.city.isWater && ctx.city.isWater(nx, nz)) {
    nx = car.x;
    nz = car.z;
    car.speed *= -0.1;
  }
  if (Math.abs(nx) > CITY.halfX + 140 || Math.abs(nz) > CITY.halfZ + 140) {
    nx = clamp(nx, -CITY.halfX - 140, CITY.halfX + 140);
    nz = clamp(nz, -CITY.halfZ - 140, CITY.halfZ + 140);
    car.speed *= 0.3;
  }

  if (gained > 0) {
    // Pushing the throttle into a wall still costs a sliver of condition.
  }

  car.x = nx;
  car.z = nz;
  car.wheelSpin += (car.speed / VEHICLE.wheelRadius) * step;
  syncTransform(car);
}

// Resolve the car centre against every nearby building collider. Cheap because
// the grid is coarse: skip anything further than the car radius away.
function collideWithBuildings(x, z, car, ctx) {
  const colliders = ctx.colliders ?? [];
  const r = car.radius * 0.78;
  let cx = x;
  let cz = z;
  let hit = false;
  for (let i = 0; i < colliders.length; i += 1) {
    const rect = colliders[i];
    if (rect.height !== undefined && rect.height < 0.6) continue;
    if (x + r < rect.minX || x - r > rect.maxX || z + r < rect.minZ || z - r > rect.maxZ) continue;
    const res = resolveCircleRect(cx, cz, r, rect);
    if (res.hit) {
      cx = res.x;
      cz = res.z;
      hit = true;
    }
  }
  return hit ? { x: cx, z: cz } : null;
}

// Car-car separation. Cars are treated as circles of half their width plus a
// length bias so side-by-side lanes do not fight each other.
function resolveCarPairs(fleet, ctx) {
  const list = fleet.list;
  const n = list.length;
  for (let i = 0; i < n; i += 1) {
    const a = list[i];
    for (let j = i + 1; j < n; j += 1) {
      const b = list[j];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const minDist = (a.halfWidth + b.halfWidth) * 0.92 + 0.2;
      const d2 = dx * dx + dz * dz;
      if (d2 > minDist * minDist || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const push = (minDist - d) / d;
      const totalMass = a.mass + b.mass;
      const wa = b.mass / totalMass;
      const wb = a.mass / totalMass;
      a.x -= dx * push * wa;
      a.z -= dz * push * wa;
      b.x += dx * push * wb;
      b.z += dz * push * wb;

      const relSpeed = Math.abs(a.speed - b.speed);
      if (relSpeed > 3) {
        const dmg = Math.min(0.35, relSpeed * 0.012);
        a.damageFrom(dmg * 0.7);
        b.damageFrom(dmg * 0.7);
        if (ctx.events && (a.role === 'player' || b.role === 'player')) {
          ctx.events.emit('carCrash', { car: a.role === 'player' ? a : b, impact: relSpeed, x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
        }
      }
      // Bleed a little speed on contact; nobody should drive through traffic.
      a.speed *= 0.94;
      b.speed *= 0.94;
      a.idleFor = 0;
      b.idleFor = 0;
      fleet.makeTicking(a);
      fleet.makeTicking(b);
      syncTransform(a);
      syncTransform(b);
    }
  }
}

function syncTransform(car) {
  car.position.x = car.x;
  car.position.z = car.z;
  car.forwardX = Math.sin(car.heading);
  car.forwardZ = Math.cos(car.heading);
  car.rightX = Math.cos(car.heading);
  car.rightZ = -Math.sin(car.heading);
  if (!car.root) return;
  const ground = car.groundY ?? 0;
  car.root.position.set(car.x, ground, car.z);
  car.root.rotation.y = car.heading;
}

// ------------------------------------------------------------- presentation

function updateCarVisuals(car, dt, ctx, time) {
  if (car.removed) return;

  // Ride height follows the kerb/pier so cars do not float on sidewalks.
  if (ctx.city && ctx.city.groundHeightAt) {
    const g = ctx.city.groundHeightAt(car.x, car.z);
    car.groundY = car.root.position.y ? lerp(car.root.position.y, g, Math.min(1, dt * 8)) : g;
    car.root.position.y = car.groundY;
  }

  // Wheels spin with speed, and the front pair steers.
  for (const wheel of car.wheels) {
    wheel.spin.rotation.x = car.wheelSpin;
    if (wheel.front) wheel.pivot.rotation.y = car.steer * 0.5;
  }

  // Suspension lean: pitch under acceleration, roll in corners.
  const targetRoll = clamp(-car.steer * clamp(Math.abs(car.speed) / 20, 0, 1) * 0.09, -0.08, 0.08);
  const targetPitch = clamp(((car.controls?.throttle ?? 0) * -0.02), -0.03, 0.03);
  car.body.rotation.z = lerp(car.body.rotation.z, targetRoll, Math.min(1, dt * 6));
  car.body.rotation.x = lerp(car.body.rotation.x, targetPitch, Math.min(1, dt * 6));
  car.body.position.y = VEHICLE.rideHeight + Math.sin(time * 9 + car.bobPhase) * 0.012 * clamp(Math.abs(car.speed) / 12, 0, 1);

  // Police light bar: alternate blue/red while the siren is on.
  const em = car.lights.emergency;
  if (em && em.blue && car.lightState === 'police') {
    const phase = Math.floor(time * 6) % 2;
    em.blue.emissiveIntensity = phase === 0 ? 3.2 : 0.2;
    em.red.emissiveIntensity = phase === 0 ? 0.2 : 3.2;
  }

  // Damage smoke past the threshold in config (0.55 damage = 45% health).
  const wantSmoke = car.damage > VEHICLE.damageSmokeAt;
  if (wantSmoke) {
    car.smokeLevel = clamp((car.damage - VEHICLE.damageSmokeAt) / (1 - VEHICLE.damageSmokeAt), 0, 1);
    updateSmoke(car, dt, time);
  } else if (car.smoke.active) {
    setSmokeVisible(car, false);
  }
}

function buildSmoke() {
  const group = new THREE.Group();
  group.name = 'smoke';
  const puffs = [];
  const geo = new THREE.SphereGeometry(0.42, 7, 5);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xb9b5ae,
    transparent: true,
    opacity: 0.55,
    roughness: 1,
    depthWrite: false,
  });
  for (let i = 0; i < 4; i += 1) {
    const puff = new THREE.Mesh(geo, mat.clone());
    puff.visible = false;
    puff.userData.t = i / 4;
    group.add(puff);
    puffs.push(puff);
  }
  group.visible = false;
  return { group, puffs, active: false };
}

function setSmokeVisible(car, visible) {
  car.smoke.active = visible;
  car.smoke.group.visible = visible;
  for (const p of car.smoke.puffs) p.visible = visible;
}

function updateSmoke(car, dt, time) {
  const smoke = car.smoke;
  if (!smoke.active) setSmokeVisible(car, true);
  const level = car.smokeLevel;
  const rate = 0.55 + level * 1.4;
  for (const puff of smoke.puffs) {
    puff.userData.t = (puff.userData.t + dt * rate) % 1;
    const t = puff.userData.t;
    const life = 1 - t;
    // Anchored at the engine bay, drifting up and back with the car's motion.
    const origin = rotateXZ(0.2, car.length * 0.36, car.heading);
    puff.position.set(
      origin.x - car.forwardX * t * 2.2 + Math.sin(time * 3 + puff.id) * 0.2,
      0.5 + t * 2.4 * (0.6 + level),
      origin.z - car.forwardZ * t * 2.2,
    );
    const s = 0.5 + t * (1.4 + level * 1.6);
    puff.scale.setScalar(s);
    puff.material.opacity = Math.max(0, 0.42 * life * (0.5 + level));
    puff.visible = true;
  }
}

// Parked cars never tick; release their smoke slots when removed.
function releaseSmoke(car) {
  if (car.smoke) setSmokeVisible(car, false);
}

// ------------------------------------------------------------------ helpers

// Lane side of the road for a given direction, used by traffic and police.
export function laneOffsets(offset = CITY.laneOffset) {
  return { offset };
}

// Lane entry/exit points for driving from node `from` to node `to`, pulled
// slightly toward the road centre line. city.js's laneOffset (4.2) and
// parkingOffset (6.1) leave only ~1.9 m between a travel lane and the kerbside
// bays, so a full-width car would scrape every parked one; the inset buys that
// clearance without touching session 1's config.
export const LANE_INSET = 0.85;

export function laneTarget(network, from, to, inset = LANE_INSET) {
  const a = network.nodes(from.ix, from.iz);
  const b = network.nodes(to.ix, to.iz);
  const dx = Math.sign(b.x - a.x);
  const dz = Math.sign(b.z - a.z);
  const offset = Math.max(0, network.laneOffset - inset);
  // Mirrors city.js segment(): east/westbound keeps to its side in Z,
  // north/southbound keeps to its side in X. Shrinking the offset moves the
  // car toward the middle of the road, away from the kerb.
  let x = a.x;
  let z = a.z;
  let ex = b.x;
  let ez = b.z;
  if (dx !== 0) {
    z += dx * offset;
    ez += dx * offset;
  } else {
    x -= dz * offset;
    ex -= dz * offset;
  }
  return { x, z, ex, ez, heading: network.headingTo(dx, dz), dx, dz };
}

export function parkSlotFor(spot, model) {
  return {
    x: spot.x,
    z: spot.z,
    heading: spot.heading,
    modelId: model,
  };
}

export { CAR_MODELS, POLICE_CAR };
