// main.js — builds the renderer, the shared context and every system, then
// runs the frame loop. This is the only file that knows how the pieces fit.
//
// Shared-context convention: one ctx object is created here and handed to each
// module factory. Modules publish themselves on it (ctx.city, ctx.vehicles,
// ctx.traffic, ctx.pedestrians, ctx.police, ctx.missions, ctx.hud, ctx.audio,
// ctx.save) and talk to each other through ctx.events.
//
//   ctx = { scene, camera, renderer, events, colliders, time, state, player, ... }
//
// Player controller: Mara on foot (WASD, camera-relative, Shift sprint, mouse
// orbit, building collision) and in a car (E to enter the nearest one, WASD to
// drive, Space handbrake, chase camera). Crime hooks feed police.js; Busted
// applies the fine and resets the street.
//
// Screenshot states: when the URL carries ?shot=<name>, control goes to
// shots.js instead of the title screen. Seed the world from util.js's RNG so
// the same state renders the same frame.

import * as THREE from 'three';
import {
  CITY,
  PLAYER,
  VEHICLE,
  WANTED,
  GAME,
  COLORS,
} from './config.js';
import {
  createEmitter,
  clamp,
  damp,
  lerp,
  lerpAngle,
  dist2D,
} from './util.js';
import { createInput } from './input.js';
import { buildCity } from './city.js';
import { createVehicleSystem } from './vehicles.js';
import { createTraffic } from './traffic.js';
import { createPedestrians } from './pedestrians.js';
import { createPolice } from './police.js';
import { createMissions } from './missions.js';
import { createHud } from './hud.js';
import { createAudio, rememberMuted } from './audio.js';
import { createSave } from './save.js';
import { stageShot } from './shots.js';

// ------------------------------------------------------------------ params

const params = new URLSearchParams(window.location.search);
const shotName = params.get('shot');
const shotSeed = Number(params.get('seed')) || 1;

// ---------------------------------------------------------------- renderer

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = GAME.exposure;

const scene = new THREE.Scene();
scene.background = new THREE.Color(COLORS.skyHorizon);

const camera = new THREE.PerspectiveCamera(GAME.fov, window.innerWidth / window.innerHeight, GAME.near, GAME.far);
camera.position.set(CITY.playerStart.x, 3.2, CITY.playerStart.z + 8);

// ------------------------------------------------------------------ context

const events = createEmitter();
const input = createInput(canvas);

const ctx = {
  scene,
  camera,
  renderer,
  input,
  events,
  colliders: [],
  time: 0,
  net: 'offline',
  state: {
    cash: 0,
    respect: 0,
    missionsCompleted: 0,
    sideDeliveries: 0,
    storyComplete: false,
  },
  // Set by shots.js while it stages a still: police units are posed by hand.
  policeFrozen: false,
  gameOver: false,
};

// --------------------------------------------------------------- the systems

const city = buildCity(ctx);
const fleet = createVehicleSystem(ctx);
const traffic = createTraffic(ctx);
const peds = createPedestrians(ctx);
const police = createPolice(ctx);
const save = createSave(ctx);
const audio = createAudio(ctx);
const hud = createHud(ctx);
const missions = createMissions(ctx);

peds.spawn();
traffic.spawnParked(28);
for (let i = 0; i < 14; i += 1) {
  traffic.spawnTrafficCar(1 + (i % 5), 1 + ((i * 2) % 5));
}

// Traffic leans on the horn when it is wedged; that hook was declared in
// traffic.js but nothing ever registered it, so the sound was silent. Wire it
// to the horn blip and let the people on the pavement flinch clear.
traffic.registerHooks({
  onHorn: ({ x, z }) => {
    audio.horn();
    peds.startle(x, z, 15, 'horn');
  },
});

// ------------------------------------------------------------------- player

const player = createPlayer();
ctx.player = player;

function createPlayer() {
  const root = new THREE.Group();
  root.name = 'MaraVelez';
  const parts = buildMaraModel(root);
  scene.add(root);

  return {
    root,
    parts,
    x: CITY.playerStart.x,
    z: CITY.playerStart.z,
    heading: CITY.playerStart.heading,
    onFoot: true,
    car: null,
    speed: 0,
    condition: 1,
    velocity: { x: 0, z: 0 },
    punchTimer: 0,
    punchCooldown: 0,
    stride: 0,
    hurtTimer: 0,
    frozen: false,
    promptHint: null,

    placeOnFoot(x, z, heading = 0) {
      if (player.car) exitCar(false);
      player.x = x;
      player.z = z;
      player.heading = heading;
      player.onFoot = true;
      player.speed = 0;
      player.velocity.x = 0;
      player.velocity.z = 0;
      player.root.visible = true;
      syncPlayerMesh();
    },
    placeInCar(car) {
      player.car = car;
      player.onFoot = false;
      player.root.visible = false;
      car.occupiedBy = player;
      car.role = 'player';
      if (car.ai) car.ai = null;
      car.setControls(null);
    },
  };
}

// Mara: a courier's silhouette — coral windbreaker, courier satchel, teal cap.
function buildMaraModel(root) {
  const jacket = new THREE.MeshStandardMaterial({ color: 0xe4604f, roughness: 0.82 });
  const jeans = new THREE.MeshStandardMaterial({ color: 0x2f3a52, roughness: 0.9 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xd9a077, roughness: 0.72 });
  const cap = new THREE.MeshStandardMaterial({ color: 0x2fb5c4, roughness: 0.75 });
  const bag = new THREE.MeshStandardMaterial({ color: 0x3d3a34, roughness: 0.85 });
  const shoe = new THREE.MeshStandardMaterial({ color: 0x22242a, roughness: 0.9 });

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.62, 0.28), jacket);
  torso.position.y = 1.16;
  torso.castShadow = true;
  root.add(torso);

  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, 0.26), jeans);
  hips.position.y = 0.83;
  hips.castShadow = true;
  root.add(hips);

  const head = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.28, 0.26), skin);
  head.position.y = 1.62;
  head.castShadow = true;
  root.add(head);

  const crown = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.1, 0.28), cap);
  crown.position.y = 1.77;
  root.add(crown);
  const brim = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.04, 0.12), cap);
  brim.position.set(0, 1.73, 0.17);
  root.add(brim);

  // Couriers live out of a shoulder bag; hers sits across the left hip.
  const satchel = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.26, 0.14), bag);
  satchel.position.set(-0.24, 0.94, -0.06);
  satchel.rotation.z = 0.16;
  root.add(satchel);
  const strap = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.5, 0.05), bag);
  strap.position.set(-0.12, 1.2, -0.05);
  strap.rotation.z = 0.42;
  root.add(strap);

  const arms = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.28, 1.42, 0);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.52, 0.14), jacket);
    arm.position.y = -0.26;
    arm.castShadow = true;
    pivot.add(arm);
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), skin);
    hand.position.y = -0.56;
    pivot.add(hand);
    root.add(pivot);
    arms.push({ pivot, side });
  }

  const legs = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.12, 0.8, 0);
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.74, 0.18), jeans);
    leg.position.y = -0.37;
    leg.castShadow = true;
    pivot.add(leg);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.27), shoe);
    boot.position.set(0, -0.76, 0.04);
    pivot.add(boot);
    root.add(pivot);
    legs.push({ pivot, side });
  }

  return { torso, head, arms, legs, hips };
}

// ------------------------------------------------------------------- camera

const cam = {
  yaw: 0,
  pitch: 0.22,
  distance: PLAYER.cameraDistance,
  lookAt: new THREE.Vector3(),
  height: PLAYER.cameraHeight,
};

function resetCameraBehindPlayer() {
  cam.yaw = player.heading + Math.PI;
  cam.pitch = 0.2;
  cam.distance = PLAYER.cameraDistance;
}

function updateCamera(dt) {
  const targetY = player.car ? VEHICLE.playerCameraHeight : PLAYER.cameraHeight * 0.9;
  const focusX = player.onFoot ? player.x : player.car.x;
  const focusZ = player.onFoot ? player.z : player.car.z;

  // Orbit input: drag or pointer lock, both accumulate on the input module.
  const look = input.lookDelta(PLAYER.mouseSensitivity);
  if (input.mouse.dragging || input.mouse.locked) {
    cam.yaw += look.yaw;
    cam.pitch = clamp(cam.pitch + look.pitch, -0.35, 0.95);
  }

  if (player.car) {
    // Chase camera: settle behind the car, but keep the orbit offset the
    // player has dialled in by easing toward the trail position.
    const behind = player.car.heading + Math.PI;
    cam.yaw = damp(cam.yaw, lerpAngle(cam.yaw, behind, 0.65), 6, dt);
    cam.distance = damp(cam.distance, VEHICLE.chaseDistance + Math.abs(player.car.speed) * 0.05, 4, dt);
    cam.pitch = damp(cam.pitch, 0.16, 3, dt);
  } else {
    cam.distance = damp(cam.distance, PLAYER.cameraDistance, 5, dt);
  }

  const cosPitch = Math.cos(cam.pitch);
  const distance = cam.distance;
  const desired = new THREE.Vector3(
    focusX + Math.sin(cam.yaw) * cosPitch * distance,
    targetY + Math.sin(cam.pitch) * distance,
    focusZ + Math.cos(cam.yaw) * cosPitch * distance,
  );

  // Keep the camera out of buildings and above the pavement.
  const groundY = city.groundHeightAt(desired.x, desired.z) + 0.9;
  if (desired.y < groundY) desired.y = groundY;
  const pushed = resolveCameraAgainstBuildings(desired, focusX, focusZ);
  camera.position.lerp(pushed, clamp(dt * 9, 0, 1));

  const lookHeight = player.car ? 1.0 : 1.45;
  cam.lookAt.set(focusX, (player.car ? city.groundHeightAt(focusX, focusZ) : city.groundHeightAt(focusX, focusZ)) + lookHeight, focusZ);
  camera.lookAt(cam.lookAt);
}

function resolveCameraAgainstBuildings(position, focusX, focusZ) {
  const colliders = ctx.colliders;
  if (!colliders.length) return position;
  // Pull the camera in along the focus→camera ray if a building is in the way.
  const dirX = position.x - focusX;
  const dirZ = position.z - focusZ;
  const length = Math.hypot(dirX, dirZ) || 1;
  let allowed = length;
  for (let i = 0; i < colliders.length; i += 1) {
    const rect = colliders[i];
    if (rect.height !== undefined && rect.height < 3) continue;
    // Cheap sample along the ray; 6 samples is plenty for a 5 m boom.
    for (let s = 1; s <= 6; s += 1) {
      const t = (s / 6) * length;
      const px = focusX + (dirX / length) * t;
      const pz = focusZ + (dirZ / length) * t;
      if (px >= rect.minX && px <= rect.maxX && pz >= rect.minZ && pz <= rect.maxZ) {
        allowed = Math.min(allowed, Math.max(1.6, t - 0.6));
        s = 7;
      }
    }
  }
  if (allowed >= length) return position;
  const out = position.clone();
  out.x = focusX + (dirX / length) * allowed;
  out.z = focusZ + (dirZ / length) * allowed;
  return out;
}

// ----------------------------------------------------------------- activity

const activity = {
  mode: 'title', // title | playing | paused | busted | complete
  elapsed: 0,
  playTime: 0,
  saveTimer: 0,
  lastCondition: 1,
};

// -------------------------------------------------------------------- input

let audioArmed = false;
function armAudio() {
  if (audioArmed) return;
  audioArmed = true;
  audio.unlock();
  audio.setMuted(audio.muted);
  hud.setMuteLabel(audio.muted);
  rememberMuted(audio.muted);
}
window.addEventListener('pointerdown', armAudio, { once: false });
window.addEventListener('keydown', armAudio, { once: false });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

hud.bindMenus({
  onNewGame: () => {
    armAudio();
    audio.click();
    newGame();
  },
  onContinue: () => {
    armAudio();
    audio.click();
    continueGame();
  },
  onHelp: () => {
    audio.click();
    const grid = document.querySelector('.controls-grid');
    if (grid) grid.classList.toggle('hidden');
  },
  onResume: () => {
    audio.click();
    setPaused(false);
  },
  onSave: () => {
    audio.click();
    writeSave();
    hud.toast('Saved.', 'good');
    hud.setSaveInfo(save.describe().text, true);
  },
  onRestart: () => {
    audio.click();
    setPaused(false);
    newGame();
  },
  onMute: () => {
    toggleMute();
  },
  onQuitToTitle: () => {
    audio.click();
    writeSave();
    quitToTitle();
  },
  onBustedContinue: () => {
    audio.click();
    walkItOff();
  },
  onFreeRoam: () => {
    audio.click();
    hud.hideScreens();
    hud.showScreen(null);
    activity.mode = 'playing';
    hud.el.hud.classList.add('visible');
  },
  onTitle: () => {
    audio.click();
    writeSave();
    quitToTitle();
  },
});

function toggleMute() {
  const muted = audio.toggleMute();
  rememberMuted(muted);
  hud.setMuteLabel(muted);
  hud.toast(muted ? 'Sound off.' : 'Sound on.', muted ? '' : 'good');
  if (!muted) audio.click();
}

// ---------------------------------------------------------------- flow

function newGame() {
  save.clear();
  ctx.state.cash = 0;
  ctx.state.respect = 0;
  ctx.state.missionsCompleted = 0;
  ctx.state.sideDeliveries = 0;
  ctx.state.storyComplete = false;
  player.condition = 1;
  police.clear('new-game');
  player.placeOnFoot(CITY.playerStart.x, CITY.playerStart.z, CITY.playerStart.heading);
  resetCameraBehindPlayer();
  missions.reset();
  activity.mode = 'playing';
  activity.playTime = 0;
  hud.showScreen(null);
  hud.el.hud.classList.add('visible');
  hud.setDistrict('Solmar Bay');
  hud.toast('Solmar Bay. One last job.', 'gold');
  missions.startNext(player);
  audio.startMusic();
}

function continueGame() {
  const record = save.describe();
  if (!record.exists) {
    newGame();
    return;
  }
  const data = save.apply(record.data);
  player.condition = 1;
  const spawn = CITY.playerStart;
  const x = data.player.x ?? spawn.x;
  const z = data.player.z ?? spawn.z;
  player.placeOnFoot(x, z, data.player.heading ?? spawn.heading);
  resetCameraBehindPlayer();
  activity.mode = 'playing';
  activity.playTime = 0;
  hud.showScreen(null);
  hud.el.hud.classList.add('visible');
  hud.toast('Welcome back to Solmar Bay.', 'good');
  missions.restoreProgress(player);
  audio.startMusic();
}

function quitToTitle() {
  activity.mode = 'title';
  hud.showScreen('start');
  hud.setSaveInfo(save.describe().text, save.describe().exists);
  missions.cancel('title');
}

function setPaused(paused) {
  if (activity.mode === 'busted' || activity.mode === 'complete') return;
  if (paused) {
    if (activity.mode !== 'playing') return;
    activity.mode = 'paused';
    hud.showScreen('pause');
    input.releasePointerLock();
    writeSave();
  } else {
    if (activity.mode !== 'paused') return;
    activity.mode = 'playing';
    hud.hideScreens();
    hud.el.hud.classList.add('visible');
  }
}

function writeSave() {
  save.write({
    cash: ctx.state.cash,
    respect: ctx.state.respect,
    missionsCompleted: ctx.state.missionsCompleted,
    storyComplete: ctx.state.storyComplete,
    sideDeliveries: ctx.state.sideDeliveries,
    wanted: police.level,
    player: {
      x: player.car ? player.car.x : player.x,
      z: player.car ? player.car.z : player.z,
      heading: player.car ? player.car.heading : player.heading,
      inCar: Boolean(player.car),
    },
  });
  hud.setSaveInfo(save.describe().text, save.describe().exists);
}

// ------------------------------------------------------------- crime + busted

events.on('busted', ({ fine }) => {
  if (activity.mode === 'busted') return;
  const payment = Math.min(ctx.state.cash, fine);
  ctx.state.cash = Math.max(0, ctx.state.cash - fine);
  audio.busted();
  hud.flash('#ff3b30', 0.55);
  hud.setBustedText(
    payment > 0
      ? 'The SBPD had the block closed. They took the cash in your pocket and let you walk.'
      : 'The SBPD had the block closed before you cleared the lights.',
    fine,
  );
  hud.toast(`Busted — fine $${fine}`, 'bad');
  activity.mode = 'busted';
  missions.cancel('busted');
  hud.showScreen('busted');
  input.releasePointerLock();
  writeSave();
});

function walkItOff() {
  // Reset the street: the player reappears at the spawn kerb with the heat gone.
  const spawn = CITY.playerStart;
  if (player.car) exitCar(false);
  player.condition = Math.max(player.condition, 0.65);
  player.placeOnFoot(spawn.x, spawn.z, spawn.heading);
  resetCameraBehindPlayer();
  police.clear('walk-it-off');
  activity.mode = 'playing';
  hud.hideScreens();
  hud.el.hud.classList.add('visible');
  hud.toast('Back on the street.', 'good');
}

// --------------------------------------------------------------- HUD events

events.on('toast', ({ text, kind }) => hud.toast(text, kind));
events.on('missionBanner', ({ kicker, name }) => {
  hud.banner(kicker, name);
  audio.chime();
});
events.on('missionComplete', ({ def }) => {
  audio.success();
  writeSave();
  if (def.number === 1) hud.setDistrict('Solmar Bay');
});
events.on('missionFailed', () => audio.busted());
events.on('storyComplete', ({ cash, respect }) => {
  audio.success();
  hud.setCompleteStats({ cash, respect, time: activity.playTime });
  hud.showScreen('complete');
  activity.mode = 'complete';
  input.releasePointerLock();
  writeSave();
});
events.on('courierComplete', () => audio.chime());
events.on('wantedChanged', ({ level, before }) => {
  if (level > before) audio.click();
});
events.on('carCrash', ({ car, impact }) => {
  if (!car || car !== player.car) return;
  if (impact < 6) return;
  player.condition = clamp(player.condition - impact * 0.006, 0.05, 1);
  audio.crash(clamp(impact / 22, 0.2, 1.6));
  hud.flash('#ffb347', 0.14);
});

// ------------------------------------------------------------------- driving

function tryEnterCar() {
  if (!player.onFoot) return;
  const car = fleet.findEnterable(player.x, player.z, Math.max(VEHICLE.enterRange, 4));
  if (!car) return;
  const witnesses = countWitnesses(car.x, car.z);
  player.placeInCar(car);
  player.heading = car.heading;
  cam.yaw = car.heading + Math.PI;
  audio.click();
  hud.toast(`You take the ${car.name}.`, 'gold');
  if (witnesses > 0) {
    police.raise(WANTED.crimes.carTheft, 'car theft');
    hud.toast('Someone saw that.', 'bad');
    peds.scare(car.x, car.z, 16, 'fight');
  } else {
    hud.toast('Nobody was watching.', '');
  }
  writeSave();
}

function exitCar(announce = true) {
  const car = player.car;
  if (!car) return;
  const heading = car.heading;
  // Step out on the kerb side of the car.
  const offsetX = Math.cos(heading) * VEHICLE.exitOffset * 1.15;
  const offsetZ = -Math.sin(heading) * VEHICLE.exitOffset * 1.15;
  car.speed = 0;
  car.clearControls();
  car.occupiedBy = null;
  car.role = 'parked';
  player.car = null;
  player.onFoot = true;
  player.root.visible = true;
  player.x = car.x + offsetX;
  player.z = car.z + offsetZ;
  player.heading = heading;
  player.speed = 0;
  player.velocity.x = 0;
  player.velocity.z = 0;
  resetCameraBehindPlayer();
  if (announce) audio.click();
}

// Is anybody in a position to notice a car being lifted?
function countWitnesses(x, z) {
  let witnesses = 0;
  for (const ped of peds.list) {
    if (ped.state === 'down') continue;
    if (dist2D(ped.x, ped.z, x, z) < 22) witnesses += 1;
    if (witnesses >= 2) return witnesses;
  }
  for (const unit of police.cars) {
    if (unit.removed) continue;
    if (dist2D(unit.x, unit.z, x, z) < 45) return witnesses + 1;
  }
  return witnesses;
}

// -------------------------------------------------------------- on-foot move

const carry = { vx: 0, vz: 0 };

function updateOnFoot(dt) {
  const axis = input.axis();
  const sprinting = input.sprint();
  const forwardX = -Math.sin(cam.yaw);
  const forwardZ = -Math.cos(cam.yaw);
  const rightX = -forwardZ;
  const rightZ = forwardX;

  let dirX = rightX * axis.x + forwardX * axis.z;
  let dirZ = rightZ * axis.x + forwardZ * axis.z;
  const len = Math.hypot(dirX, dirZ);
  if (len > 0.001) {
    dirX /= len;
    dirZ /= len;
  }

  const targetSpeed = len > 0.001 ? (sprinting ? PLAYER.sprintSpeed : PLAYER.walkSpeed) : 0;
  const accel = PLAYER.accel * dt;
  carry.vx = carry.vx + clamp(dirX * targetSpeed - carry.vx, -accel, accel);
  carry.vz = carry.vz + clamp(dirZ * targetSpeed - carry.vz, -accel, accel);

  let nx = player.x + carry.vx * dt;
  let nz = player.z + carry.vz * dt;

  // Buildings and street furniture with real height block the body.
  const colliders = ctx.colliders;
  for (let i = 0; i < colliders.length; i += 1) {
    const rect = colliders[i];
    if (rect.height !== undefined && rect.height < 0.6) continue;
    if (nx + 1 < rect.minX || nx - 1 > rect.maxX || nz + 1 < rect.minZ || nz - 1 > rect.maxZ) continue;
    const nearestX = clamp(nx, rect.minX, rect.maxX);
    const nearestZ = clamp(nz, rect.minZ, rect.maxZ);
    const dx = nx - nearestX;
    const dz = nz - nearestZ;
    const d2 = dx * dx + dz * dz;
    if (d2 > PLAYER.radius * PLAYER.radius) continue;
    if (d2 > 1e-6) {
      const d = Math.sqrt(d2);
      nx += (dx / d) * (PLAYER.radius - d);
      nz += (dz / d) * (PLAYER.radius - d);
    } else {
      nx = nearestX + PLAYER.radius;
    }
  }

  // The sea is a hard edge on foot; the quay and beach are walkable.
  if (city.isWater(nx, nz) && !city.onPier(nx, nz)) {
    nx = player.x;
    nz = player.z;
    carry.vx *= 0.2;
    carry.vz *= 0.2;
  }

  player.x = nx;
  player.z = nz;
  player.speed = Math.hypot(carry.vx, carry.vz);
  player.velocity.x = carry.vx;
  player.velocity.z = carry.vz;

  if (len > 0.001) {
    const wanted = Math.atan2(dirX, dirZ);
    player.heading = lerpAngle(player.heading, wanted, clamp(dt * 12, 0, 1));
  }

  // Punch: F, Space on foot, or a left click. A click is also the start of a
  // camera drag, which is deliberate: poke the air, then swing the view.
  player.punchCooldown = Math.max(0, player.punchCooldown - dt);
  player.punchTimer = Math.max(0, player.punchTimer - dt);
  if ((input.wasPressed('punch') || input.consumeClick()) && player.punchCooldown <= 0) {
    punch();
  }

  syncPlayerMesh();
  animatePlayer(dt);
}

function punch() {
  player.punchCooldown = PLAYER.punchCooldown;
  player.punchTimer = 0.24;
  audio.thud();
  const forwardX = Math.sin(player.heading);
  const forwardZ = Math.cos(player.heading);
  const reachX = player.x + forwardX * (PLAYER.punchRange * 0.6);
  const reachZ = player.z + forwardZ * (PLAYER.punchRange * 0.6);
  const ped = peds.nearestTo(reachX, reachZ, PLAYER.punchRange);
  if (ped) {
    peds.hit(ped, { fromX: player.x, fromZ: player.z, power: 1.1, source: 'fight' });
    police.raise(WANTED.crimes.assault, 'assault');
    peds.scare(player.x, player.z, 13, 'fight');
    hud.toast('Shoved. Somebody is calling it in.', 'bad');
    hud.flash('#ffcf5c', 0.1);
  } else {
    // A whiff still rattles the nearest pedestrian if one is staring.
    if (peds.countDown() === 0) hud.toast('Nothing but warm air.', '');
  }
}

function syncPlayerMesh() {
  const y = city.groundHeightAt(player.x, player.z);
  player.root.position.set(player.x, y, player.z);
  player.root.rotation.y = player.heading;
}

function animatePlayer(dt) {
  const moving = player.speed > 0.35;
  if (moving) player.stride += dt * (3.2 + player.speed * 1.7);
  const swing = moving ? Math.sin(player.stride) * clamp(player.speed / 5, 0.2, 1) * 0.62 : 0;
  const [leftLeg, rightLeg] = player.parts.legs;
  const [leftArm, rightArm] = player.parts.arms;
  leftLeg.pivot.rotation.x = swing;
  rightLeg.pivot.rotation.x = -swing;
  leftArm.pivot.rotation.x = -swing * 0.8;
  rightArm.pivot.rotation.x = swing * 0.8;

  // Punch: the lead arm snaps forward, the body leans in.
  if (player.punchTimer > 0) {
    const t = player.punchTimer / 0.24;
    rightArm.pivot.rotation.x = -1.5 * t;
    player.parts.torso.rotation.y = -0.24 * t;
  } else {
    player.parts.torso.rotation.y = lerp(player.parts.torso.rotation.y, 0, clamp(dt * 8, 0, 1));
  }
}

// ------------------------------------------------------------------ in a car

function updateDriving(dt) {
  const car = player.car;
  if (!car) return;
  const axis = input.axis();
  const handbrake = input.isDown('handbrake') ? 1 : 0;

  car.setControls({
    throttle: axis.z,
    steer: -axis.x,
    brake: handbrake,
  });

  // Stay in the driver's seat visually: keep the body glued to the car.
  player.x = car.x;
  player.z = car.z;
  player.heading = car.heading;
  player.speed = Math.abs(car.speed);
  player.velocity.x = car.forwardX * car.speed;
  player.velocity.z = car.forwardZ * car.speed;

  // The player's horn also clears the pavement: anyone close enough to be in
  // the way hops aside for a moment instead of waiting to be clipped.
  if (input.wasPressed('horn')) {
    audio.horn();
    peds.startle(car.x, car.z, 15, 'horn');
  }

  // Clipping a pedestrian with a moving car is a crime the scanner hears.
  if (Math.abs(car.speed) > 5.5) {
    for (const ped of peds.list) {
      if (ped.state === 'down') continue;
      if (Math.abs(ped.x - car.x) > 4 || Math.abs(ped.z - car.z) > 4) continue;
      if (dist2D(ped.x, ped.z, car.x, car.z) > car.halfWidth + 0.85) continue;
      peds.hit(ped, { fromX: car.x - car.forwardX, fromZ: car.z - car.forwardZ, power: 1.4, source: 'car' });
      police.raise(WANTED.crimes.pedHit, 'pedestrian hit');
      audio.thud();
      hud.flash('#ff5f4a', 0.16);
      hud.toast('You clipped someone. Keep moving.', 'bad');
      break;
    }
    // Ramming a cruiser is its own problem.
    for (const unit of police.cars) {
      if (unit.removed) continue;
      if (dist2D(unit.x, unit.z, car.x, car.z) > (car.halfWidth + unit.halfWidth)) continue;
      if (Math.abs(car.speed) < 9) continue;
      police.raise(WANTED.crimes.ramPolice, 'rammed a cruiser');
      hud.toast('You just hit a cruiser.', 'bad');
      break;
    }
  }

  // Condition tracks the car's own damage while you are inside it.
  player.condition = clamp(1 - car.damage * 0.85, 0.05, 1);
}

// -------------------------------------------------------------- key handling

function handleKeys() {
  if (shotState) return;
  if (input.wasPressed('pause')) {
    if (activity.mode === 'playing') setPaused(true);
    else if (activity.mode === 'paused') setPaused(false);
    return;
  }
  if (input.wasPressed('mute')) {
    toggleMute();
    return;
  }
  if (activity.mode !== 'playing') return;

  if (input.wasPressed('enter') && player.onFoot) tryEnterCar();
  else if (input.wasPressed('enter') && player.car) exitCar(true);

  if (input.codePressed('KeyC')) {
    if (player.onFoot) {
      const started = missions.startCourier(player);
      if (started) {
        audio.click();
        hud.toast('Courier run started.', 'gold');
      } else {
        hud.toast(missions.busy ? 'Finish the job you are on first.' : 'The dispatcher is quiet.', '');
      }
    }
  }
}

// -------------------------------------------------------------------- prompts

function updatePrompt() {
  if (activity.mode !== 'playing') {
    hud.hidePrompt();
    return;
  }
  if (player.onFoot) {
    const car = fleet.findEnterable(player.x, player.z, Math.max(VEHICLE.enterRange, 4));
    if (car) {
      hud.prompt(`<kbd>E</kbd> Take the ${car.name}`);
    } else if (missions.markers.length && nearestMarkerDistance() < 8) {
      hud.prompt('Job marker — walk into the ring.');
    } else {
      hud.hidePrompt();
    }
  } else {
    hud.prompt('<kbd>E</kbd> Get out · <kbd>Space</kbd> handbrake · <kbd>H</kbd> horn');
  }
}

function nearestMarkerDistance() {
  let best = Infinity;
  for (const marker of missions.markers) {
    best = Math.min(best, dist2D(player.x, player.z, marker.x, marker.z));
  }
  return best;
}

// ------------------------------------------------------------------- the world

function updateWorld(dt, includePolice = true) {
  ctx.time += dt;
  const focus = { x: player.onFoot ? player.x : player.car.x, z: player.onFoot ? player.z : player.car.z };
  city.update(dt, ctx.time, focus);
  traffic.update(dt, player);
  peds.update(dt, player);
  if (includePolice && !ctx.policeFrozen) police.update(dt, player);
  fleet.update(dt);
}

// Condition slowly recovers between fights; it is a comic-book bruise, not a
// hard health bar.
function updateCondition(dt) {
  if (!player.car) {
    player.condition = clamp(player.condition + dt * 0.018, 0.05, 1);
  }
}

// ------------------------------------------------------------------- the loop

let shotState = null;
let lastFrame = performance.now();

function frame(now) {
  const rawDt = (now - lastFrame) / 1000;
  lastFrame = now;
  const dt = Math.min(GAME.maxDt, Math.max(0, rawDt));

  if (shotState) {
    shotState.tick(dt);
    input.endFrame();
    requestAnimationFrame(frame);
    return;
  }

  handleKeys();

  if (activity.mode === 'playing') {
    activity.playTime += dt;
    activity.saveTimer += dt;
    if (player.onFoot) updateOnFoot(dt);
    else updateDriving(dt);
    updateCondition(dt);
    updateWorld(dt);
    missions.update(dt, player);
    audio.update(dt, player, police);
    // Autosave roughly every half minute of play.
    if (activity.saveTimer > 30) {
      activity.saveTimer = 0;
      writeSave();
    }
    updateCamera(dt);
  } else if (activity.mode === 'title') {
    // The title screen keeps the city alive behind the card while the camera
    // drifts slowly over the quay instead of following a player.
    titleCamera(dt);
    updateWorld(dt, false);
    missions.update(0, player);
  }

  hud.update(dt, player, missions);
  updatePrompt();

  renderer.render(scene, camera);
  input.endFrame();
  requestAnimationFrame(frame);
}

// A slow orbit over the harbour behind the title card.
let titleClock = 0;
function titleCamera(dt) {
  titleClock += dt;
  const radius = 168;
  const angle = -2.32 + Math.sin(titleClock * 0.06) * 0.22;
  camera.position.set(
    Math.cos(angle) * radius + 60,
    30 + Math.sin(titleClock * 0.11) * 2.4,
    Math.sin(angle) * radius + 30,
  );
  camera.lookAt(CITY.pier.endX - 60, 3, CITY.pier.z - 20);
}

// ---------------------------------------------------------------- boot

function boot() {
  if (shotName) {
    hud.hideScreens();
    if (shotName === 'start') hud.el.hud.classList.remove('visible');
    else hud.el.hud.classList.add('visible');
    shotState = stageShot({
      ctx,
      shotName,
      seed: shotSeed,
      player,
      camera,
      cam,
      renderer,
      hud,
      game: {
        updateWorld,
        render: () => renderer.render(scene, camera),
        updateCamera,
        resetCameraBehindPlayer,
        syncPlayerMesh,
      },
    });
    requestAnimationFrame(frame);
    return;
  }

  hud.showScreen('start');
  const record = save.describe();
  hud.setSaveInfo(record.text, record.exists);
  hud.setMuteLabel(audio.muted);
  hud.setDistrict('Solmar Bay');
  // A slow drift over the harbour keeps the title card from feeling frozen.
  camera.position.set(150, 26, 150);
  camera.lookAt(60, 4, 40);
  requestAnimationFrame(frame);
}

window.__neon = { ctx, player, missions, police, fleet, traffic, peds, hud, audio, save, activity };
boot();
