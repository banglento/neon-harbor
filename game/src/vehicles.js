// Low-poly vehicle construction, shared car state, and arcade driving physics.
import * as THREE from 'three';
import { CAR_MODELS, CITY } from './config.js';
import { clamp, circleIntersectsRect, distanceSquared } from './util.js';

const BODY_Y = 0.1;

function material(color, options = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.08, ...options });
}

function addPart(parent, name, geometry, mat, position, castShadow = true) {
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.name = name;
  mesh.position.set(position[0], position[1], position[2]);
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function createCarMesh(model, options = {}) {
  const root = new THREE.Group();
  root.name = `vehicle/${model.id}${options.police ? '/police' : ''}`;
  const police = Boolean(options.police);
  const paint = material(options.color ?? (police ? '#e8e9df' : model.color), { metalness: 0.18 });
  const trim = material(police ? '#243b48' : model.accent, { metalness: 0.12 });
  const glass = material('#a9d5d7', { roughness: 0.25, metalness: 0.18, transparent: true, opacity: 0.86 });
  const rubber = material('#20282b', { roughness: 0.93 });
  const hub = material('#b8c0b8', { metalness: 0.6, roughness: 0.42 });
  const headlamp = material('#fff0bd', { emissive: '#ffe29a', emissiveIntensity: 1.4, roughness: 0.28 });
  const tailLamp = material('#ed6255', { emissive: '#d52c2b', emissiveIntensity: 0.9, roughness: 0.35 });
  const length = model.length;
  const width = model.width;
  const height = model.height;
  const wheelR = Math.max(0.34, Math.min(0.43, height * 0.27));
  const bodyH = height * (model.className === 'utility' ? 0.42 : 0.39);
  const bodyW = width * 0.94;
  const bodyL = length * 0.91;
  const vanShape = model.className === 'electric';

  addPart(root, 'car/chassis', new THREE.BoxGeometry(bodyW, bodyH, bodyL), paint, [0, BODY_Y + wheelR * 0.72, 0]);
  addPart(root, 'car/hood', new THREE.BoxGeometry(bodyW * 0.94, bodyH * 0.48, length * 0.3), paint, [0, BODY_Y + wheelR * 0.72 + bodyH * 0.63, length * 0.27]);
  addPart(root, 'car/front-bumper', new THREE.BoxGeometry(bodyW * 0.97, 0.2, 0.16), trim, [0, BODY_Y + wheelR * 0.62, length * 0.48]);
  addPart(root, 'car/rear-bumper', new THREE.BoxGeometry(bodyW * 0.97, 0.2, 0.16), trim, [0, BODY_Y + wheelR * 0.62, -length * 0.48]);

  const cabinLength = length * (model.className === 'utility' ? 0.45 : vanShape ? 0.59 : model.className === 'compact' ? 0.43 : 0.47);
  const cabinWidth = width * (vanShape ? 0.88 : model.className === 'compact' ? 0.77 : 0.79);
  const cabinHeight = Math.max(0.48, height * (vanShape ? 0.46 : 0.39));
  const cabinZ = model.className === 'utility' ? -length * 0.05 : vanShape ? -length * 0.025 : -length * 0.045;
  addPart(root, 'car/cabin', new THREE.BoxGeometry(cabinWidth, cabinHeight, cabinLength), trim, [0, BODY_Y + wheelR * 0.72 + bodyH * 0.62 + cabinHeight * 0.49, cabinZ]);
  addPart(root, 'car/windshield', new THREE.BoxGeometry(cabinWidth * 0.91, cabinHeight * 0.7, 0.055), glass, [0, BODY_Y + wheelR * 0.72 + bodyH * 0.62 + cabinHeight * 0.52, cabinZ + cabinLength * 0.36]);
  addPart(root, 'car/rear-window', new THREE.BoxGeometry(cabinWidth * 0.88, cabinHeight * 0.64, 0.05), glass, [0, BODY_Y + wheelR * 0.72 + bodyH * 0.62 + cabinHeight * 0.52, cabinZ - cabinLength * 0.39]);
  for (const side of [-1, 1]) {
    addPart(root, 'car/side-window', new THREE.BoxGeometry(0.045, cabinHeight * 0.56, cabinLength * 0.68), glass, [side * (cabinWidth * 0.5 + 0.012), BODY_Y + wheelR * 0.72 + bodyH * 0.62 + cabinHeight * 0.53, cabinZ]);
  }

  if (model.className === 'utility') {
    addPart(root, 'car/utility-bed', new THREE.BoxGeometry(width * 0.78, 0.12, length * 0.27), trim, [0, BODY_Y + wheelR * 0.72 + bodyH * 0.84, -length * 0.29]);
    for (const side of [-1, 1]) addPart(root, 'car/bed-rail', new THREE.BoxGeometry(0.12, 0.34, length * 0.28), paint, [side * width * 0.38, BODY_Y + wheelR * 0.72 + bodyH * 0.97, -length * 0.29]);
  }
  if (vanShape) {
    addPart(root, 'car/van-side-panel', new THREE.BoxGeometry(0.05, cabinHeight * 0.62, cabinLength * 0.73), paint, [width * 0.42, BODY_Y + wheelR * 0.72 + bodyH * 0.62 + cabinHeight * 0.42, cabinZ - 0.02]);
  }

  const wheelGeo = new THREE.CylinderGeometry(wheelR, wheelR, 0.22, 10);
  const hubGeo = new THREE.CylinderGeometry(wheelR * 0.48, wheelR * 0.48, 0.235, 8);
  const wheelX = width * 0.49;
  const wheelZ = length * 0.32;
  const wheels = [];
  for (const x of [-wheelX, wheelX]) for (const z of [-wheelZ, wheelZ]) {
    const wheel = addPart(root, 'car/wheel', wheelGeo, rubber, [x, BODY_Y + wheelR, z]);
    wheel.rotation.z = Math.PI / 2;
    const center = addPart(root, 'car/wheel-hub', hubGeo, hub, [x * 1.012, BODY_Y + wheelR, z]);
    center.rotation.z = Math.PI / 2;
    wheels.push(wheel);
  }
  for (const x of [-width * 0.34, width * 0.34]) {
    addPart(root, 'car/headlamp', new THREE.BoxGeometry(width * 0.22, 0.19, 0.09), headlamp, [x, BODY_Y + wheelR * 1.15, length * 0.49]);
    addPart(root, 'car/taillamp', new THREE.BoxGeometry(width * 0.2, 0.18, 0.09), tailLamp, [x, BODY_Y + wheelR * 1.12, -length * 0.49]);
  }
  if (police) {
    addPart(root, 'police/door-marking', new THREE.BoxGeometry(0.055, 0.23, length * 0.22), material('#d9e4df'), [width * 0.49, BODY_Y + wheelR * 1.65, -0.02], false);
    const bar = new THREE.Group();
    bar.name = 'police/lightbar';
    const red = material('#ff625a', { emissive: '#ff271e', emissiveIntensity: 1.7 });
    const blue = material('#54c7ff', { emissive: '#148cff', emissiveIntensity: 1.7 });
    addPart(bar, 'police/red-beacon', new THREE.BoxGeometry(0.28, 0.16, 0.22), red, [-0.17, 0, 0]);
    addPart(bar, 'police/blue-beacon', new THREE.BoxGeometry(0.28, 0.16, 0.22), blue, [0.17, 0, 0]);
    bar.position.set(0, BODY_Y + height * 0.93, cabinZ);
    root.add(bar);
  }

  const smoke = new THREE.Group();
  smoke.name = 'car/damage-smoke';
  const smokeMat = new THREE.MeshBasicMaterial({ color: '#777b78', transparent: true, opacity: 0.27, depthWrite: false });
  for (let i = 0; i < 3; i += 1) {
    const puff = new THREE.Mesh(new THREE.SphereGeometry(0.2 + i * 0.035, 7, 5), smokeMat);
    puff.position.set((i - 1) * 0.13, 0.16 + i * 0.19, -length * 0.3 - i * 0.14);
    puff.scale.set(1, 1.25, 1);
    smoke.add(puff);
  }
  smoke.visible = false;
  root.add(smoke);
  return { root, wheels, smoke };
}

export function createVehicles(ctx) {
  const cars = [];
  const colliders = ctx.city?.colliders ?? ctx.colliders ?? [];
  let nextId = 1;

  function getModel(modelId) {
    return CAR_MODELS.find((model) => model.id === modelId) ?? CAR_MODELS[0];
  }

  function createCar(options = {}) {
    const model = getModel(options.modelId);
    const visuals = createCarMesh(model, options);
    const position = new THREE.Vector3(options.x ?? options.position?.x ?? 0, 0, options.z ?? options.position?.z ?? 0);
    const car = {
      id: options.id ?? `car-${nextId++}`,
      name: options.name ?? model.name,
      modelId: model.id,
      model,
      className: model.className,
      mesh: visuals.root,
      position,
      heading: options.heading ?? 0,
      speed: options.speed ?? 0,
      damage: 0,
      radius: model.width * 0.56,
      length: model.length,
      width: model.width,
      maxSpeed: model.maxSpeed,
      police: Boolean(options.police),
      parked: Boolean(options.parked),
      active: true,
      ai: options.ai ?? null,
      controls: { throttle: 0, steer: 0, brake: 0 },
      wheels: visuals.wheels,
      smoke: visuals.smoke,
      collisionCooldown: 0,
    };
    car.mesh.position.copy(position);
    car.mesh.rotation.y = car.heading;
    ctx.scene.add(car.mesh);
    cars.push(car);
    return car;
  }

  function removeCar(carOrId) {
    const car = typeof carOrId === 'string' ? cars.find((entry) => entry.id === carOrId) : carOrId;
    if (!car || !car.active) return false;
    car.active = false;
    ctx.scene.remove(car.mesh);
    return true;
  }

  function setControls(car, controls = {}) {
    if (!car?.active) return;
    car.controls.throttle = clamp(controls.throttle ?? 0, -1, 1);
    car.controls.steer = clamp(controls.steer ?? 0, -1, 1);
    car.controls.brake = clamp(controls.brake ?? 0, 0, 1);
    car.parked = false;
  }

  function damageCar(car, amount = 0.08) {
    if (!car?.active) return 0;
    car.damage = clamp(car.damage + Math.max(0, amount), 0, 1);
    car.smoke.visible = car.damage >= 0.68;
    return car.damage;
  }

  function resolveBuildings(car, oldX, oldZ) {
    for (const collider of colliders) {
      if (collider.type === 'water' || collider.type === 'street') continue;
      if (!circleIntersectsRect(car.position.x, car.position.z, car.radius * 0.72, collider)) continue;
      car.position.x = oldX;
      car.position.z = oldZ;
      if (car.collisionCooldown <= 0 && Math.abs(car.speed) > 2.4) {
        damageCar(car, Math.min(0.08, Math.abs(car.speed) * 0.0018));
        car.collisionCooldown = 0.45;
      }
      car.speed *= -0.08;
      return;
    }
    car.position.x = clamp(car.position.x, CITY.worldMinX + 2, CITY.worldMaxX - 2);
    car.position.z = clamp(car.position.z, CITY.worldMinZ + 2, CITY.coastZ - 1);
  }

  function resolveCarContacts() {
    const active = cars.filter((car) => car.active);
    for (let i = 0; i < active.length; i += 1) for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i];
      const b = active[j];
      const dx = b.position.x - a.position.x;
      const dz = b.position.z - a.position.z;
      const reach = (a.radius + b.radius) * 0.76;
      const distSq = dx * dx + dz * dz;
      if (distSq >= reach * reach) continue;
      const dist = Math.sqrt(distSq) || 0.001;
      const nx = dx / dist;
      const nz = dz / dist;
      const overlap = reach - dist;
      a.position.x -= nx * overlap * 0.5;
      a.position.z -= nz * overlap * 0.5;
      b.position.x += nx * overlap * 0.5;
      b.position.z += nz * overlap * 0.5;
      const closing = Math.abs(a.speed - b.speed);
      if (closing > 3 && (a.collisionCooldown <= 0 || b.collisionCooldown <= 0)) {
        damageCar(a, Math.min(0.12, closing * 0.002));
        damageCar(b, Math.min(0.12, closing * 0.002));
        a.collisionCooldown = Math.max(a.collisionCooldown, 0.4);
        b.collisionCooldown = Math.max(b.collisionCooldown, 0.4);
      }
      if (!a.parked) a.speed *= 0.78;
      if (!b.parked) b.speed *= 0.78;
    }
  }

  function update(dt) {
    const step = Math.min(0.05, Math.max(0, dt));
    for (const car of cars) {
      if (!car.active) continue;
      car.collisionCooldown = Math.max(0, car.collisionCooldown - step);
      const { throttle, steer, brake } = car.controls;
      const maxSpeed = car.maxSpeed * (1 - car.damage * 0.35);
      if (brake > 0) car.speed = Math.abs(car.speed) > 0.18 ? car.speed - Math.sign(car.speed) * (20 + brake * 25) * step : 0;
      if (throttle !== 0) {
        if (Math.sign(throttle) !== Math.sign(car.speed) && Math.abs(car.speed) > 0.3) car.speed -= Math.sign(car.speed) * car.model.acceleration * 2.2 * step;
        else car.speed += throttle * car.model.acceleration * step;
      } else if (Math.abs(car.speed) > 0.04) {
        car.speed -= Math.sign(car.speed) * Math.min(Math.abs(car.speed), (car.parked ? 5.2 : 1.7) * step);
      }
      car.speed = clamp(car.speed, -maxSpeed * 0.38, maxSpeed);
      const speedRatio = clamp(Math.abs(car.speed) / maxSpeed, 0, 1);
      const turnRate = car.model.handling * (0.22 + speedRatio * 0.78);
      car.heading += steer * turnRate * Math.sign(car.speed || 1) * step;
      const oldX = car.position.x;
      const oldZ = car.position.z;
      car.position.x += Math.sin(car.heading) * car.speed * step;
      car.position.z += Math.cos(car.heading) * car.speed * step;
      resolveBuildings(car, oldX, oldZ);
      car.mesh.position.copy(car.position);
      car.mesh.rotation.y = car.heading;
      for (const wheel of car.wheels) wheel.rotation.x -= car.speed * step / 0.38;
      car.smoke.visible = car.damage >= 0.68;
      if (car.smoke.visible) {
        car.smoke.rotation.y += step * 0.8;
        car.smoke.scale.setScalar(0.85 + 0.12 * Math.sin(performance.now() * 0.002 + car.id.length));
      }
    }
    resolveCarContacts();
    for (const car of cars) if (car.active) car.mesh.position.copy(car.position);
  }

  function nearestCar(position, maxDistance = Infinity, predicate = () => true) {
    let nearest = null;
    let bestSq = maxDistance * maxDistance;
    for (const car of cars) {
      if (!car.active || !predicate(car)) continue;
      const distanceSq = distanceSquared(position, car.position);
      if (distanceSq < bestSq) {
        bestSq = distanceSq;
        nearest = car;
      }
    }
    return nearest;
  }

  const api = {
    cars,
    createCar,
    spawnCar: createCar,
    removeCar,
    setControls,
    update,
    damageCar,
    getCar(id) { return cars.find((car) => car.id === id && car.active) ?? null; },
    nearestCar,
    getCars() { return cars.filter((car) => car.active); },
  };
  ctx.vehicles = api;
  return api;
}
