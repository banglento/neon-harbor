// Deterministic visual staging for the four reviewer capture states.
import { createRng, randomRange } from './util.js';

// The downtown boulevard sits at z = 45; its two lanes are at z = 43.35 (near) and 46.65 (far).
const LANE_NEAR = 43.35;
const LANE_FAR = 46.65;
// Sidewalk bands flank the boulevard at z = 51.4 (north) and z = 38.6 (south).
const WALK_NORTH = 51.4;
const WALK_SOUTH = 38.6;
const WEST = -Math.PI / 2;
const EAST = Math.PI / 2;

export function createShots(ctx) {
  const query = new URLSearchParams(window.location.search);
  const name = query.get('shot');
  const seed = Number(query.get('seed') ?? 1) || 1;
  const rng = createRng(seed);
  const known = new Set(['cover', 'chase', 'foot', 'start']);
  const active = known.has(name);
  let staged = false;

  function setPosition(actor, x, z, heading = 0) {
    actor.position.set(x, 0, z);
    actor.heading = heading;
    actor.mesh?.position.copy(actor.position);
    if (actor.mesh) actor.mesh.rotation.y = heading;
    return actor;
  }

  function placeCar(car, x, z, heading) {
    car.position.set(x, 0, z);
    car.heading = heading;
    car.speed = 0;
    car.controls.throttle = 0;
    car.controls.steer = 0;
    car.controls.brake = 1;
    car.parked = true;
    car.mesh.position.copy(car.position);
    car.mesh.rotation.y = heading;
    return car;
  }

  function freezeCars() {
    for (const car of ctx.vehicles.getCars()) placeCar(car, car.position.x, car.position.z, car.heading);
  }

  function stageCover(traffic) {
    const car = placeCar(ctx.vehicles.createCar({ modelId: 'cielo', x: 46, z: LANE_NEAR, heading: WEST, name: 'Mara’s Cielo GT' }), 46, LANE_NEAR, WEST);
    setPosition(ctx.player, 46, LANE_NEAR, WEST);
    ctx.player.car = car;
    ctx.player.vehicle = car;
    ctx.player.mesh.visible = false;
    traffic.slice(0, 8).forEach((entry, index) => {
      const ahead = 30 - index * 9;
      placeCar(entry, ahead, index % 2 ? LANE_FAR : LANE_NEAR, index % 2 ? EAST : WEST);
    });
    traffic.slice(8, 12).forEach((entry, index) => {
      placeCar(entry, 64 + index * 9, index % 2 ? LANE_FAR : LANE_NEAR, index % 2 ? EAST : WEST);
    });
    ctx.missions.restore({ missionsCompleted: [] });
    ctx.missions.overrideHUD('First Run: deliver the package to Mirador Court · 92s', [{ x: 80, z: -68, label: 'Mirador Court', type: 'delivery' }]);
    ctx.cameraRig?.snap?.(0.12);
  }

  function stageChase(traffic) {
    const car = placeCar(ctx.vehicles.createCar({ modelId: 'tide', x: 22, z: LANE_NEAR, heading: WEST, name: 'Mara’s Tide Runner' }), 22, LANE_NEAR, WEST);
    setPosition(ctx.player, 22, LANE_NEAR, WEST);
    ctx.player.car = car;
    ctx.player.vehicle = car;
    ctx.player.mesh.visible = false;
    ctx.police.raiseWanted(4, 'shot staging');
    const units = ctx.police.getUnits();
    while (units.length > 2) { const extra = units[units.length - 1]; units.pop(); ctx.vehicles.removeCar(extra.car); }
    units.forEach((unit, index) => {
      // Ahead of the player and facing back up the boulevard, so both lightbars read clearly in the shot.
      placeCar(unit.car, index === 0 ? 9 : 15.5, index === 0 ? LANE_FAR : LANE_NEAR, index === 0 ? EAST : WEST);
    });
    traffic.slice(0, 6).forEach((entry, index) => {
      placeCar(entry, -14 - index * 9, index % 2 ? LANE_FAR : LANE_NEAR, index % 2 ? EAST : WEST);
    });
    ctx.missions.overrideHUD('Harbor Lights: evade the Solmar Bay Police and reach the harbor escape point', [{ x: 64, z: 153, label: 'Harbor Escape', type: 'escape' }]);
    ctx.cameraRig?.snap?.(0.22);
  }

  function stageFoot(traffic, walkers) {
    setPosition(ctx.player, -21.8, 49.9, WEST);
    walkers.forEach((walker, index) => {
      const north = index % 2 === 0;
      setPosition(walker, -34 + index * 4.4, (north ? WALK_NORTH : WALK_SOUTH) + randomRange(rng, -0.45, 0.45), north ? WEST : EAST);
    });
    traffic.slice(0, 8).forEach((entry, index) => {
      const westbound = index % 2 === 0;
      const x = -36 + Math.floor(index / 2) * 11;
      placeCar(entry, x, westbound ? LANE_NEAR : LANE_FAR, westbound ? WEST : EAST);
    });
    ctx.player.mesh.visible = true;
    ctx.missions.overrideHUD('First Run: pick up the package at Bodega Luna', [{ x: -80, z: 69, label: 'Bodega Luna', type: 'pickup' }]);
    ctx.cameraRig.pitch = 0.13;
    ctx.cameraRig?.snap?.(0.1, 3.2);
  }

  function stage() {
    if (!active) return false;
    window.__shotReady = false;
    staged = true;
    ctx.shotMode = name;
    ctx.startScreen.hidden = name !== 'start';
    ctx.pauseScreen.hidden = true;
    ctx.bustedScreen.hidden = true;
    ctx.completeScreen.hidden = true;
    ctx.briefingScreen.hidden = true;
    ctx.player.car = null;
    ctx.player.vehicle = null;
    ctx.player.health = 100;
    ctx.player.active = true;
    ctx.player.mesh.visible = true;
    if (name === 'start') {
      ctx.hud.setVisible(false);
      return true;
    }

    const traffic = ctx.traffic.getCars();
    const walkers = ctx.pedestrians.getPedestrians();
    freezeCars();
    if (name === 'cover') stageCover(traffic);
    else if (name === 'chase') stageChase(traffic);
    else if (name === 'foot') stageFoot(traffic, walkers);

    ctx.hud.setVisible(true);
    ctx.hud.toast(name === 'chase'
      ? 'Solmar Bay Police · hold the line'
      : name === 'foot' ? 'Courier route · Bodega Luna' : 'Package secured — the clock is running');
    ctx.updateHud?.(0.2);
    return true;
  }

  function markRendered() {
    if (staged) window.__shotReady = true;
  }

  return { name, seed, active, stage, markRendered, get rng() { return rng; } };
}
