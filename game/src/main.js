// Integrate Solmar Bay's world, player controls, missions, HUD, audio and saves.
import * as THREE from 'three';
import { CAMERA, CITY, PLAYER, SPAWN, WANTED } from './config.js';
import { createRng, clamp, distanceSquared, circleIntersectsRect } from './util.js';
import { createInput } from './input.js';
import { createCity } from './city.js';
import { createVehicles } from './vehicles.js';
import { createPedestrians } from './pedestrians.js';
import { createTraffic } from './traffic.js';
import { createPolice } from './police.js';
import { createMissions } from './missions.js';
import { createHud } from './hud.js';
import { createAudio } from './audio.js';
import { createSave } from './save.js';
import { createShots } from './shots.js';

const canvas = document.getElementById('world');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#8fd8e4');
const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 650);
const rng = createRng(4162026);
const player = {
  position: new THREE.Vector3(SPAWN.x, 0, SPAWN.z),
  heading: SPAWN.heading,
  health: PLAYER.health,
  car: null,
  vehicle: null,
  active: true,
  combatActive: false,
  punchCooldown: 0,
  mesh: new THREE.Group(),
};
player.mesh.name = 'Mara Velez';
player.mesh.position.copy(player.position);
const bodyMaterial = new THREE.MeshStandardMaterial({ color: '#274e58', roughness: 0.82 });
const skinMaterial = new THREE.MeshStandardMaterial({ color: '#c88f6d', roughness: 0.92 });
const legMaterial = new THREE.MeshStandardMaterial({ color: '#38434a', roughness: 0.9 });
const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.62, 4, 7), bodyMaterial);
torso.position.y = 1.05; torso.castShadow = true; player.mesh.add(torso);
const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 9, 7), skinMaterial);
head.position.y = 1.62; head.castShadow = true; player.mesh.add(head);
for (const side of [-1, 1]) {
  const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.48, 3, 6), legMaterial);
  leg.position.set(side * 0.13, 0.48, 0); leg.castShadow = true; player.mesh.add(leg);
}
scene.add(player.mesh);

const state = { cash: 850, respect: 0, sideDeliveries: 0, paused: false, busted: false, started: false };
const hud = createHud();
const audio = createAudio();
const save = createSave();
const input = createInput(canvas);
const ctx = { scene, renderer, camera, rng, player, colliders: [], onToast: (text) => hud.toast(text) };
const city = createCity(ctx);
ctx.city = city;
const vehicles = createVehicles(ctx);
const pedestrians = createPedestrians(ctx);
const traffic = createTraffic(ctx);
const police = createPolice(ctx);
ctx.vehicles = vehicles; ctx.pedestrians = pedestrians; ctx.traffic = traffic; ctx.police = police;
ctx.audio = audio;
const missions = createMissions(ctx);
ctx.missions = missions;
const startScreen = document.getElementById('start-screen');
const pauseScreen = document.getElementById('pause-screen');
const bustedScreen = document.getElementById('busted-screen');
const completeScreen = document.getElementById('complete-screen');
const briefingScreen = document.getElementById('briefing-screen');
const briefingTitle = document.getElementById('briefing-title');
const briefingCopy = document.getElementById('briefing-copy');
const bustedCopy = document.getElementById('busted-copy');
const continueButton = document.getElementById('continue-game');
ctx.startScreen = startScreen; ctx.pauseScreen = pauseScreen; ctx.bustedScreen = bustedScreen; ctx.completeScreen = completeScreen; ctx.briefingScreen = briefingScreen; ctx.hud = hud;

ctx.onMissionComplete = ({ cash: reward, respect: rep, label }) => {
  state.cash += reward; state.respect += rep; audio.success(); hud.toast(`${label} complete · +$${reward.toLocaleString()} · +${rep} respect`, 3300); saveProgress();
};
ctx.onSideDelivery = () => { state.sideDeliveries += 1; };
ctx.onStoryComplete = () => { completeScreen.hidden = false; audio.success(); saveProgress(); };
ctx.onBriefing = ({ title, copy }) => { briefingTitle.textContent = title; briefingCopy.textContent = copy; briefingScreen.hidden = false; };
ctx.onBusted = ({ wanted: level }) => {
  state.busted = true; audio.busted();
  const fine = Math.floor(state.cash * 0.18);
  bustedCopy.textContent = `The police caught you at ${Math.ceil(level)} stars. $${fine.toLocaleString()} went toward the fine.`;
  state.cash = Math.max(0, state.cash - fine); saveProgress(); bustedScreen.hidden = false;
};

const cameraRig = {
  yaw: Math.PI * 0.18,
  pitch: 0.24,
  snap(yawOffset = null, lift = null) {
    if (yawOffset !== null) this.yaw = yawOffset;
    const focus = player.car?.position ?? player.position;
    const heading = player.car?.heading ?? player.heading;
    const back = player.car ? CAMERA.driveDistance : CAMERA.walkDistance;
    const height = lift ?? (player.car ? CAMERA.driveHeight : CAMERA.walkHeight);
    const yaw = this.yaw + (player.car ? heading : 0);
    const horizontal = back * Math.cos(this.pitch);
    camera.position.set(
      focus.x - Math.sin(yaw) * horizontal,
      focus.y + height + Math.sin(this.pitch) * back,
      focus.z - Math.cos(yaw) * horizontal,
    );
    camera.lookAt(focus.x, focus.y + (player.car ? 1.3 : 1.1), focus.z);
  },
};
ctx.cameraRig = cameraRig;
ctx.updateHud = (dt) => updateHud(dt);
let lastSaveAt = 0;
let lastFrame = performance.now();
let hitCheckTimer = 0;
let interactionStarted = false;

function saveProgress() {
  save.save({ cash: state.cash, respect: state.respect, missionsCompleted: missions.getCompleted(), sideDeliveries: state.sideDeliveries, player, wantedLevel: police.wanted });
  lastSaveAt = performance.now();
}

function loadProgress() {
  const data = save.load();
  if (!data) return false;
  state.cash = Math.max(0, data.cash || 0);
  state.respect = Math.max(0, data.respect || 0);
  state.sideDeliveries = Math.max(0, data.sideDeliveries || 0);
  player.position.set(data.playerPosition?.x ?? SPAWN.x, 0, data.playerPosition?.z ?? SPAWN.z);
  player.heading = SPAWN.heading;
  missions.restore(data);
  police.clearWanted();
  if (data.wantedLevel > 0) police.raiseWanted(data.wantedLevel, 'continued game');
  return true;
}

function resetPlayer() {
  if (player.car) { player.car.speed = 0; player.car.parked = true; player.car = null; player.vehicle = null; }
  player.position.set(SPAWN.x, 0, SPAWN.z);
  player.heading = SPAWN.heading;
  player.health = PLAYER.health;
  player.mesh.visible = true;
  player.mesh.position.copy(player.position);
  player.mesh.rotation.y = player.heading;
  police.resetBusted();
  state.busted = false;
  bustedScreen.hidden = true;
}

function beginGame(isNew = false) {
  audio.unlock();
  interactionStarted = true;
  if (isNew) {
    save.clear(); state.cash = 850; state.respect = 0; state.sideDeliveries = 0;
    missions.reset(); police.clearWanted(); resetPlayer();
  } else if (!loadProgress()) {
    state.cash = 850; state.respect = 0; missions.reset();
  }
  state.started = true; state.paused = false;
  startScreen.hidden = true; pauseScreen.hidden = true; hud.setVisible(true);
  input.requestPointerLock();
  hud.toast(isNew ? 'Mara Velez · Solmar Bay' : 'Welcome back to Solmar Bay');
  cameraRig.snap();
}

function pauseGame() {
  if (!state.started || state.busted || missions.storyComplete) return;
  state.paused = true; pauseScreen.hidden = false; input.exitPointerLock();
}
function resumeGame() { state.paused = false; pauseScreen.hidden = true; audio.unlock(); }

function nearestWalker(maxRange) {
  let best = null; let bestSq = maxRange * maxRange;
  for (const walker of pedestrians.getPedestrians()) {
    if (walker.hit) continue;
    const sq = distanceSquared(player.position, walker.position);
    if (sq < bestSq) { best = walker; bestSq = sq; }
  }
  return best;
}

function makeCrime(reason, amount) {
  const witnessed = pedestrians.getPedestrians().some((walker) => distanceSquared(walker.position, player.position) < 44 * 44);
  const observedByPolice = police.getUnits().some((unit) => police.canSeePlayer(unit));
  if (witnessed || observedByPolice) police.raiseWanted(amount, reason);
}

function enterOrExitCar() {
  if (player.car) {
    const car = player.car;
    player.position.set(car.position.x + Math.cos(car.heading) * 2.1, 0, car.position.z - Math.sin(car.heading) * 2.1);
    player.heading = car.heading; player.car = null; player.vehicle = null; player.mesh.visible = true;
    return;
  }
  const car = vehicles.nearestCar(player.position, PLAYER.vehicleEnterRange, (entry) => !entry.police && entry.ai !== 'traffic');
  if (!car) { hud.toast('Move closer to a parked car'); return; }
  const stolen = car.parked;
  player.car = car; player.vehicle = car;
  player.position.copy(car.position); player.heading = car.heading; player.mesh.visible = false;
  if (stolen) makeCrime('car theft witnessed', WANTED.stolenCarCrime);
  audio.uiClick();
}

function combat() {
  if (player.car || player.punchCooldown > 0) return;
  player.punchCooldown = PLAYER.punchCooldown;
  const walker = nearestWalker(PLAYER.punchRange);
  if (walker) {
    pedestrians.hitPedestrian(walker, 1.6); pedestrians.reactToCombat(player.position);
    makeCrime('pedestrian assault', WANTED.combatCrime); audio.punch(); hud.toast('Cartoon shove · the block noticed');
  } else { audio.punch(); hud.toast('A quick shove into the sea breeze'); }
}

function updatePlayer(dt) {
  player.punchCooldown = Math.max(0, player.punchCooldown - dt);
  const mouse = input.consumeMouseDelta();
  if (!state.paused && !state.busted) {
    cameraRig.yaw -= mouse.x * CAMERA.orbitSensitivity;
    cameraRig.pitch = clamp(cameraRig.pitch + mouse.y * CAMERA.orbitSensitivity, CAMERA.minPitch, CAMERA.maxPitch);
  }
  if (!state.started || state.busted || (missions.storyComplete && missions.getHUD().sideAvailable)) return;
  if (input.consumePressed('Escape') || input.consumePressed('KeyP')) { state.paused ? resumeGame() : pauseGame(); return; }
  if (state.paused) return;
  if (input.consumePressed('KeyM')) audio.setMuted();
  if (input.consumePressed('KeyE')) enterOrExitCar();
  if (input.consumePressed('KeyF')) combat();
  if (input.consumePressed('KeyQ') && !missions.startSideJob()) hud.toast('Finish the current side run first');
  if (player.car) {
    const car = player.car;
    const throttle = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
    const steer = (input.isDown('KeyA') ? 1 : 0) - (input.isDown('KeyD') ? 1 : 0);
    vehicles.setControls(car, { throttle, steer, brake: input.isDown('Space') ? 1 : 0 });
    player.position.copy(car.position); player.heading = car.heading;
    return;
  }
  const forward = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
  const lateral = (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0);
  const length = Math.hypot(forward, lateral) || 1;
  const speed = input.isDown('ShiftLeft') || input.isDown('ShiftRight') ? PLAYER.sprintSpeed : PLAYER.walkSpeed;
  const sin = Math.sin(cameraRig.yaw); const cos = Math.cos(cameraRig.yaw);
  const dx = (lateral * cos + forward * sin) / length * speed * dt;
  const dz = (-lateral * sin + forward * cos) / length * speed * dt;
  const nextX = clamp(player.position.x + dx, CITY.worldMinX + 1, CITY.worldMaxX - 1);
  const nextZ = clamp(player.position.z + dz, CITY.worldMinZ + 1, CITY.coastZ - 1);
  const blocked = city.colliders.some((collider) => collider.height > 0.7 && circleIntersectsRect(nextX, nextZ, PLAYER.radius, collider));
  if (!blocked) player.position.set(nextX, 0, nextZ);
  if (Math.abs(forward) + Math.abs(lateral) > 0) player.heading = Math.atan2(dx, dz);
  player.mesh.position.copy(player.position); player.mesh.rotation.y = player.heading;
}

function updateCollisions(dt) {
  hitCheckTimer -= dt;
  if (hitCheckTimer > 0 || !player.car || Math.abs(player.car.speed) < 8) return;
  hitCheckTimer = 0.12;
  const target = pedestrians.getPedestrians().find((walker) => !walker.hit && distanceSquared(walker.position, player.car.position) < 2.1 * 2.1);
  if (target && pedestrians.hitPedestrian(target, Math.abs(player.car.speed) * 0.1)) {
    pedestrians.reactToCombat(player.car.position);
    makeCrime('pedestrian hit by car', WANTED.hitPedestrianCrime); hud.toast('A pedestrian was knocked down · police attention increased');
  }
}

function updateCamera(dt) {
  if (ctx.shotMode) { cameraRig.snap(); return; }
  const target = player.car?.position ?? player.position;
  const heading = player.car?.heading ?? player.heading;
  const distanceBack = player.car ? CAMERA.driveDistance : CAMERA.walkDistance;
  const height = player.car ? CAMERA.driveHeight : CAMERA.walkHeight;
  const yaw = cameraRig.yaw + (player.car ? heading : 0);
  const pitch = cameraRig.pitch;
  const horizontal = distanceBack * Math.cos(pitch);
  const desired = new THREE.Vector3(target.x - Math.sin(yaw) * horizontal, target.y + height + Math.sin(pitch) * distanceBack, target.z - Math.cos(yaw) * horizontal);
  const alpha = 1 - Math.exp(-CAMERA.smoothing * dt);
  camera.position.lerp(desired, alpha);
  camera.lookAt(target.x, target.y + (player.car ? 1.3 : 1.1), target.z);
}

function updateHud(dt) {
  const mission = missions.getHUD();
  const actor = player.car ?? player;
  const policeState = police.getState();
  hud.update({
    cash: state.cash, respect: state.respect, condition: player.health, wanted: policeState.level,
    objective: mission.objective, markers: mission.markers, storyComplete: mission.storyComplete,
    sideJob: !mission.sideAvailable, player: { position: actor.position, heading: actor.heading },
    traffic: traffic.getCars(), police: police.getUnits(), roads: city.roads,
    location: actor.position.z > 90 ? 'HARBOR FRONT' : actor.position.z < -50 ? 'NORTH POINT' : 'SOLMAR BAY',
  }, dt);
}

function resize() {
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false); renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
}
window.addEventListener('resize', resize);
window.addEventListener('pointerdown', () => { if (!interactionStarted) audio.unlock(); interactionStarted = true; }, { once: true });
window.addEventListener('keydown', () => { if (!interactionStarted) audio.unlock(); interactionStarted = true; }, { once: true });
for (const button of document.querySelectorAll('button')) button.addEventListener('click', () => audio.uiClick());
document.getElementById('new-game').addEventListener('click', () => beginGame(true));
continueButton.addEventListener('click', () => beginGame(false));
document.getElementById('resume-game').addEventListener('click', () => { resumeGame(); input.requestPointerLock(); });
document.getElementById('pause-new-game').addEventListener('click', () => beginGame(true));
document.getElementById('busted-continue').addEventListener('click', () => { resetPlayer(); saveProgress(); });
document.getElementById('complete-continue').addEventListener('click', () => { completeScreen.hidden = true; missions.startSideJob(); });
briefingScreen.addEventListener('click', (event) => { if (event.target.closest('#briefing-continue')) briefingScreen.hidden = true; });
canvas.addEventListener('click', () => { if (state.started && !state.paused && !state.busted && !player.car) combat(); });
continueButton.disabled = !save.load();
hud.setVisible(false);
// Debug handle for automated checks and the reviewer capture harness.
window.__neon = { state, player, missions, police, vehicles, traffic, pedestrians, city, camera, cameraRig, save };
const shots = createShots(ctx);
window.__neon.shots = shots;
if (shots.active) { state.started = true; startScreen.hidden = true; shots.stage(); }

function frame(now) {
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  if (!shots.active) {
    updatePlayer(dt);
    if (state.started && !state.paused && !state.busted && (!missions.storyComplete || !missions.getHUD().sideAvailable)) {
      traffic.update(dt); pedestrians.update(dt); police.update(dt); vehicles.update(dt); updateCollisions(dt); missions.update(dt);
      audio.update({ speed: player.car?.speed ?? 0, wanted: police.wanted, inCar: Boolean(player.car) });
      if (now - lastSaveAt > 12000) saveProgress();
    }
  }
  updateCamera(dt); updateHud(dt); renderer.render(scene, camera);
  if (shots.active && !shotsRendered) { shots.markRendered(); shotsRendered = true; }
  requestAnimationFrame(frame);
}
let shotsRendered = false;
requestAnimationFrame(frame);
