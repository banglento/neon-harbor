// Populate Solmar Bay with lane-following traffic and enterable parked cars.
import { CITY } from './config.js';
import { choose, clamp, createRng, randomRange } from './util.js';

const LANE_OFFSET = 1.65;
const MOVING_MODELS = ['tide', 'cielo', 'marina', 'lumen', 'dorado'];
const PARKED_MODELS = ['tide', 'marina', 'dorado', 'lumen'];

function lanePosition(axis, coordinate, direction, along) {
  if (axis === 'z') return { x: coordinate + (direction > 0 ? -LANE_OFFSET : LANE_OFFSET), z: along };
  return { x: along, z: coordinate + (direction > 0 ? -LANE_OFFSET : LANE_OFFSET) };
}

export function createTraffic(ctx) {
  const city = ctx.city;
  const vehicles = ctx.vehicles;
  const rng = ctx.rng ?? createRng(193742);
  const cars = [];
  const pedestrians = () => ctx.pedestrians?.getPedestrians?.() ?? [];
  const movingCount = ctx.trafficCount ?? 11;
  const parkedCount = ctx.parkedCarCount ?? 9;

  function allowedSpan(road) {
    const span = road.axis === 'z'
      ? [Math.max(road.start + 10, CITY.worldMinZ + 9), Math.min(road.end - 10, CITY.coastZ - 7)]
      : [road.start + 10, road.end - 10];
    return span;
  }

  function pickRoad(exclude = null) {
    const candidates = city.roads.filter((road) => road !== exclude && allowedSpan(road)[1] > allowedSpan(road)[0]);
    return choose(rng, candidates.length ? candidates : city.roads);
  }


  function spawnMoving(index) {
    const road = pickRoad();
    const [start, end] = allowedSpan(road);
    const direction = rng() < 0.5 ? -1 : 1;
    const along = randomRange(rng, start, end);
    const position = lanePosition(road.axis, road.coordinate, direction, along);
    const car = vehicles.createCar({
      modelId: choose(rng, MOVING_MODELS),
      x: position.x,
      z: position.z,
      heading: road.axis === 'z' ? (direction > 0 ? 0 : Math.PI) : (direction > 0 ? Math.PI / 2 : -Math.PI / 2),
      ai: 'traffic',
      name: `Solmar traffic ${index + 1}`,
    });
    const state = { car, axis: road.axis, coordinate: road.coordinate, direction, goal: null, changeAt: null, stopped: false, seed: rng() };
    cars.push(state);
    chooseNextGoal(state, road);
    return state;
  }

  function chooseNextGoal(state, road) {
    const along = state.axis === 'z' ? state.car.position.z : state.car.position.x;
    const intersections = city.intersections.filter((node) => state.axis === 'z' ? node.x === state.coordinate : node.z === state.coordinate);
    const ahead = intersections
      .map((node) => ({ node, along: state.axis === 'z' ? node.z : node.x }))
      .filter((entry) => state.direction > 0 ? entry.along > along + 2 : entry.along < along - 2)
      .sort((a, b) => (a.along - b.along) * state.direction);
    if (ahead.length) {
      const cross = ahead[0];
      state.changeAt = cross.along;
      state.goal = { x: cross.node.x, z: cross.node.z };
    } else {
      const [start, end] = allowedSpan(road);
      state.changeAt = state.direction > 0 ? end : start;
      state.goal = state.axis === 'z' ? { x: state.coordinate, z: state.changeAt } : { x: state.changeAt, z: state.coordinate };
    }
  }

  function chooseTurn(state) {
    const node = state.goal;
    const previousRoad = city.roads.find((entry) => entry.axis === state.axis && entry.coordinate === state.coordinate);
    const [routeStart, routeEnd] = allowedSpan(previousRoad);
    const routeAlong = state.axis === 'z' ? node.z : node.x;
    const reachedEnd = state.direction > 0 ? routeAlong >= routeEnd - 1 : routeAlong <= routeStart + 1;
    const canTurn = state.seed > 0.35;
    state.seed = (state.seed * 16807 + 0.12345) % 1;
    if (canTurn && rng() < 0.31) {
      state.axis = state.axis === 'z' ? 'x' : 'z';
      state.coordinate = state.axis === 'z' ? node.x : node.z;
      state.direction = rng() < 0.5 ? -1 : 1;
    } else if (reachedEnd) {
      state.direction *= -1;
    }
    const place = lanePosition(state.axis, state.coordinate, state.direction, state.axis === 'z' ? node.z : node.x);
    state.car.position.set(place.x, 0, place.z);
    state.car.mesh.position.copy(state.car.position);
    state.car.heading = state.axis === 'z' ? (state.direction > 0 ? 0 : Math.PI) : (state.direction > 0 ? Math.PI / 2 : -Math.PI / 2);
    state.car.mesh.rotation.y = state.car.heading;
    state.goal = null;
    state.changeAt = null;
    const road = city.roads.find((entry) => entry.axis === state.axis && entry.coordinate === state.coordinate);
    if (road) chooseNextGoal(state, road);
  }

  function aheadDistance(car, other) {
    const dx = other.position.x - car.position.x;
    const dz = other.position.z - car.position.z;
    const forwardX = Math.sin(car.heading);
    const forwardZ = Math.cos(car.heading);
    const along = dx * forwardX + dz * forwardZ;
    const side = Math.abs(dx * forwardZ - dz * forwardX);
    const otherWidth = other.width ?? (other.radius ? other.radius * 2 : 0.8);
    return side < car.width * 0.78 + otherWidth * 0.45 && along > 0 && along < 16 ? along : Infinity;
  }

  function obstacleGap(state, player) {
    const car = state.car;
    let gap = Infinity;
    for (const other of vehicles.getCars()) {
      if (other === car || other.parked) continue;
      gap = Math.min(gap, aheadDistance(car, other));
    }
    if (player?.position) {
      const playerCar = player.car ?? player.vehicle;
      const target = playerCar?.position ?? player.position;
      const pseudo = { position: target, width: playerCar?.width ?? 0.8 };
      gap = Math.min(gap, aheadDistance(car, pseudo));
    }
    for (const walker of pedestrians()) {
      if (walker.hit || !walker.active) continue;
      gap = Math.min(gap, aheadDistance(car, walker));
    }
    return gap;
  }

  function spawnParked(index) {
    const road = pickRoad();
    const [start, end] = allowedSpan(road);
    let along = randomRange(rng, start, end);
    const minimumGap = 7.5;
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const clear = cars.every((entry) => {
        if (!entry.parked || entry.road !== road) return true;
        const otherAlong = road.axis === 'z' ? entry.car.position.z : entry.car.position.x;
        return Math.abs(otherAlong - along) > minimumGap;
      });
      if (clear) break;
      along = randomRange(rng, start, end);
    }
    const side = rng() < 0.5 ? -1 : 1;
    const position = road.axis === 'z'
      ? { x: road.coordinate + side * (CITY.roadWidth / 2 + 1.4), z: along }
      : { x: along, z: road.coordinate + side * (CITY.roadWidth / 2 + 1.4) };
    const car = vehicles.createCar({
      modelId: choose(rng, PARKED_MODELS), x: position.x, z: position.z,
      heading: road.axis === 'z' ? 0 : Math.PI / 2,
      parked: true, ai: 'parked', name: `Parked car ${index + 1}`,
    });
    cars.push({ car, parked: true, road });
    return car;
  }

  function update(dt) {
    const player = ctx.player;
    for (const state of cars) {
      const car = state.car;
      if (!car.active || state.parked) continue;
      const along = state.axis === 'z' ? car.position.z : car.position.x;
      const atIntersection = state.changeAt !== null && Math.abs(along - state.changeAt) < 1.5;
      if (atIntersection) chooseTurn(state);
      const gap = obstacleGap(state, player);
      state.stopped = gap < 5.6;
      const targetSpeed = state.stopped ? 0 : (state.car.model.maxSpeed * (gap < 12 ? 0.48 : 0.62));
      const throttle = targetSpeed > Math.abs(car.speed) + 0.8 ? 0.56 : 0;
      vehicles.setControls(car, { throttle, brake: state.stopped ? clamp((5.6 - gap) / 5.6, 0.45, 1) : 0, steer: 0 });
      if (!state.stopped && Math.abs(car.speed) > targetSpeed) car.speed = Math.sign(car.speed) * targetSpeed;
      if (state.goal) {
        const target = state.goal;
        const dx = target.x - car.position.x;
        const dz = target.z - car.position.z;
        if (Math.hypot(dx, dz) < 2) state.changeAt = state.axis === 'z' ? target.z : target.x;
      }
    }
  }

  for (let i = 0; i < movingCount; i += 1) spawnMoving(i);
  for (let i = 0; i < parkedCount; i += 1) spawnParked(i);
  const api = {
    cars,
    update,
    spawnParked,
    spawnTrafficCar: spawnMoving,
    getCars() { return cars.map((state) => state.car).filter((car) => car.active); },
    getMovingCars() { return cars.filter((state) => !state.parked).map((state) => state.car).filter((car) => car.active); },
  };
  ctx.traffic = api;
  return api;
}
