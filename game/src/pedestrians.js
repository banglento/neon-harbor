// Sidewalk walkers with simple routes, reactions, and non-graphic knockdown state.
import * as THREE from 'three';
import { CITY } from './config.js';
import { choose, clamp, createRng, distanceSquared, randomRange } from './util.js';

const WALK_SPEED = 1.3;
const SIDEWALK_OFFSET = CITY.roadWidth / 2 + CITY.sidewalkWidth * 0.52;

function makeWalker(id, rng) {
  const group = new THREE.Group();
  group.name = `pedestrian/${id}`;
  const shirtColors = ['#e8a45f', '#73b8b5', '#d87868', '#8593c2', '#ded4b6', '#8bac71'];
  const skin = new THREE.MeshStandardMaterial({ color: choose(rng, ['#bd8264', '#dfb08a', '#9d6652', '#d19a78']), roughness: 0.9 });
  const shirt = new THREE.MeshStandardMaterial({ color: choose(rng, shirtColors), roughness: 0.85 });
  const pants = new THREE.MeshStandardMaterial({ color: choose(rng, ['#35454c', '#5b5960', '#493f3a', '#43524b']), roughness: 0.9 });
  const shoe = new THREE.MeshStandardMaterial({ color: '#293136', roughness: 0.9 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 0.52, 3, 6), shirt);
  torso.name = 'walker/torso';
  torso.position.y = 1.04;
  torso.castShadow = true;
  group.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), skin);
  head.name = 'walker/head';
  head.position.y = 1.52;
  head.castShadow = true;
  group.add(head);
  const legs = [];
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.095, 0.42, 2, 5), pants);
    leg.name = 'walker/leg';
    leg.position.set(side * 0.12, 0.49, 0);
    leg.castShadow = true;
    group.add(leg);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.1, 0.28), shoe);
    foot.name = 'walker/shoe';
    foot.position.set(side * 0.12, 0.12, 0.06);
    group.add(foot);
    legs.push(leg);
  }
  const arms = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.38, 2, 5), shirt);
    arm.name = 'walker/arm';
    arm.position.set(side * 0.3, 1.1, 0);
    arm.rotation.z = side * -0.12;
    group.add(arm);
    arms.push(arm);
  }
  return { group, legs, arms };
}

export function createPedestrians(ctx) {
  const rng = ctx.rng ?? createRng(520031);
  const pedestrians = [];
  const count = ctx.pedestrianCount ?? 20;
  const combatFright = { active: false, position: null, time: 0 };
  let policeFear = 0;

  function sidewalkRoute() {
    const road = choose(rng, ctx.city.roads);
    const direction = rng() < 0.5 ? -1 : 1;
    const side = rng() < 0.5 ? -1 : 1;
    const low = road.axis === 'z' ? CITY.worldMinZ + 5 : CITY.worldMinX + 5;
    const high = road.axis === 'z' ? CITY.coastZ - 5 : CITY.worldMaxX - 5;
    const along = randomRange(rng, low, high);
    const coordinate = road.coordinate + side * SIDEWALK_OFFSET;
    const position = road.axis === 'z' ? { x: coordinate, z: along } : { x: along, z: coordinate };
    return { axis: road.axis, coordinate, direction, position, side };
  }

  function spawnWalker(id) {
    const route = sidewalkRoute();
    const visuals = makeWalker(id, rng);
    const walker = {
      id: `walker-${id}`,
      mesh: visuals.group,
      legs: visuals.legs,
      arms: visuals.arms,
      position: new THREE.Vector3(route.position.x, 0, route.position.z),
      velocity: new THREE.Vector3(),
      axis: route.axis,
      coordinate: route.coordinate,
      direction: route.direction,
      side: route.side,
      speed: WALK_SPEED * randomRange(rng, 0.82, 1.18),
      active: true,
      hit: false,
      hitTimer: 0,
      fleeing: 0,
      fleeFrom: null,
      radius: 0.4,
      width: 0.8,
      phase: rng() * Math.PI * 2,
    };
    walker.mesh.position.copy(walker.position);
    ctx.scene.add(walker.mesh);
    pedestrians.push(walker);
    return walker;
  }

  function hitPedestrian(target, impulse = 1) {
    const walker = typeof target === 'string' ? pedestrians.find((person) => person.id === target) : target;
    if (!walker?.active || walker.hit) return false;
    walker.hit = true;
    walker.hitTimer = 4.5;
    walker.speed = 0;
    walker.velocity.set(randomRange(rng, -1, 1) * impulse, 0, randomRange(rng, -1, 1) * impulse);
    walker.mesh.rotation.x = -Math.PI / 2;
    walker.mesh.position.y = 0.15;
    return true;
  }

  function reactToCombat(position, radius = 26) {
    combatFright.active = true;
    combatFright.position = { x: position.x, z: position.z ?? position.y };
    combatFright.time = 7;
    for (const walker of pedestrians) {
      if (distanceSquared(walker.position, combatFright.position) < radius * radius) {
        walker.fleeing = Math.max(walker.fleeing, 4.5);
        walker.fleeFrom = combatFright.position;
      }
    }
  }

  function reactToPoliceChase(active = true, position = null) {
    policeFear = active ? 6 : 0;
    if (active && position) reactToCombat(position, 34);
  }

  function nearestVehicle(position, maxDistance = 22) {
    const cars = ctx.vehicles?.getCars?.() ?? [];
    let nearest = null;
    let best = maxDistance * maxDistance;
    for (const car of cars) {
      const sq = distanceSquared(position, car.position);
      if (sq < best) { best = sq; nearest = car; }
    }
    return nearest ? { car: nearest, distanceSq: best } : null;
  }

  function update(dt) {
    const step = Math.min(0.05, Math.max(0, dt));
    combatFright.time = Math.max(0, combatFright.time - step);
    if (!combatFright.time) combatFright.active = false;
    policeFear = Math.max(0, policeFear - step);
    const player = ctx.player;
    for (const walker of pedestrians) {
      if (!walker.active) continue;
      walker.phase += step * (walker.hit ? 2 : 8);
      if (walker.hit) {
        walker.hitTimer -= step;
        walker.position.x += walker.velocity.x * step;
        walker.position.z += walker.velocity.z * step;
        walker.velocity.multiplyScalar(Math.max(0, 1 - step * 2.5));
        if (walker.hitTimer <= 0) {
          walker.hit = false;
          walker.mesh.rotation.x = 0;
          walker.mesh.position.y = 0;
          walker.fleeing = 2;
        } else {
          walker.mesh.position.x = walker.position.x;
          walker.mesh.position.z = walker.position.z;
        }
        continue;
      }

      const nearby = nearestVehicle(walker.position, 20);
      let fleePosition = null;
      if (nearby && Math.abs(nearby.car.speed) > 4 && nearby.distanceSq < 12 * 12) fleePosition = nearby.car.position;
      if (player?.combatActive) fleePosition = player.position;
      if (combatFright.active && combatFright.position && distanceSquared(walker.position, combatFright.position) < 24 * 24) fleePosition = combatFright.position;
      if (policeFear > 0 && ctx.police?.getUnits?.().length) {
        const unit = ctx.police.getUnits()[0];
        if (distanceSquared(walker.position, unit.car.position) < 30 * 30) fleePosition = unit.car.position;
      }
      if (fleePosition) {
        walker.fleeing = Math.max(walker.fleeing, 2.2);
        walker.fleeFrom = fleePosition;
      }
      walker.fleeing = Math.max(0, walker.fleeing - step);

      let vx = walker.axis === 'x' ? walker.direction : 0;
      let vz = walker.axis === 'z' ? walker.direction : 0;
      let speed = walker.speed;
      if (walker.fleeing > 0 && walker.fleeFrom) {
        const dx = walker.position.x - walker.fleeFrom.x;
        const dz = walker.position.z - walker.fleeFrom.z;
        const length = Math.hypot(dx, dz) || 1;
        vx = dx / length;
        vz = dz / length;
        speed = WALK_SPEED * 2.15;
      }
      let avoidX = 0;
      let avoidZ = 0;
      for (const other of pedestrians) {
        if (other === walker || !other.active || other.hit) continue;
        const dx = walker.position.x - other.position.x;
        const dz = walker.position.z - other.position.z;
        const sq = dx * dx + dz * dz;
        if (sq > 2.8 || sq < 0.001) continue;
        avoidX += dx / sq;
        avoidZ += dz / sq;
      }
      const avoidLength = Math.hypot(avoidX, avoidZ);
      if (avoidLength > 0.01) {
        vx = vx * 0.72 + avoidX / avoidLength * 0.28;
        vz = vz * 0.72 + avoidZ / avoidLength * 0.28;
        const length = Math.hypot(vx, vz) || 1;
        vx /= length; vz /= length;
      }
      walker.position.x += vx * speed * step;
      walker.position.z += vz * speed * step;
      walker.position.x = clamp(walker.position.x, CITY.worldMinX + 2, CITY.worldMaxX - 2);
      walker.position.z = clamp(walker.position.z, CITY.worldMinZ + 2, CITY.coastZ - 2);
      walker.mesh.position.copy(walker.position);
      walker.mesh.rotation.y = Math.atan2(vx, vz);
      for (let index = 0; index < walker.legs.length; index += 1) walker.legs[index].rotation.x = Math.sin(walker.phase + index * Math.PI) * (walker.fleeing ? 0.72 : 0.4);
      for (let index = 0; index < walker.arms.length; index += 1) walker.arms[index].rotation.x = Math.sin(walker.phase + index * Math.PI + 1) * 0.25;
    }
  }

  for (let index = 0; index < count; index += 1) spawnWalker(index + 1);
  const api = {
    pedestrians,
    update,
    spawnWalker,
    hitPedestrian,
    reactToCombat,
    reactToPoliceChase,
    getPedestrians() { return pedestrians.filter((walker) => walker.active); },
    getHitPedestrians() { return pedestrians.filter((walker) => walker.active && walker.hit); },
    getHitCount() { return pedestrians.filter((walker) => walker.active && walker.hit).length; },
  };
  ctx.pedestrians = api;
  return api;
}
