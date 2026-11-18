// Wanted escalation, police pursuit, line of sight, and the Busted meter.
import { WANTED, CITY } from './config.js';
import { clamp, createRng, distance, normalizeAngle } from './util.js';

function segmentHitsRect(a, b, rect) {
  let low = 0;
  let high = 1;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  for (const [origin, delta, minimum, maximum] of [[a.x, dx, rect.minX, rect.maxX], [a.z, dz, rect.minZ, rect.maxZ]]) {
    if (Math.abs(delta) < 1e-6) {
      if (origin < minimum || origin > maximum) return false;
      continue;
    }
    let first = (minimum - origin) / delta;
    let last = (maximum - origin) / delta;
    if (first > last) [first, last] = [last, first];
    low = Math.max(low, first);
    high = Math.min(high, last);
    if (low > high) return false;
  }
  return high > 0.025 && low < 0.975;
}

export function createPolice(ctx) {
  const vehicles = ctx.vehicles;
  const city = ctx.city;
  const rng = ctx.rng ?? createRng(937421);
  const units = [];
  let wanted = 0;
  let unseenTime = 0;
  let bustedMeter = 0;
  let busted = false;
  let lastSeen = false;

  function playerPosition() {
    const player = ctx.player;
    const subject = player?.car ?? player?.vehicle ?? player;
    if (!subject) return null;
    const position = subject.position;
    if (!position) return null;
    return { x: position.x, y: position.y ?? 1, z: position.z ?? position.y };
  }

  function playerSpeed() {
    const player = ctx.player;
    const car = player?.car ?? player?.vehicle;
    return Math.abs(car?.speed ?? player?.speed ?? 0);
  }

  function lineOfSight(from, to) {
    for (const collider of city.colliders) {
      if (collider.height < 1.2) continue;
      if (segmentHitsRect(from, to, collider)) return false;
    }
    return true;
  }

  function canSeePlayer(unitOrPosition, target = playerPosition()) {
    if (!target) return false;
    const source = unitOrPosition?.car?.position ?? unitOrPosition?.position ?? unitOrPosition;
    if (!source || typeof source.x !== 'number') return false;
    const sightRange = WANTED.sightRange + Math.max(0, wanted - 1) * 5;
    if (distance(source, target) > sightRange) return false;
    return lineOfSight(source, target);
  }

  function spawnUnit(position) {
    const roadPoint = city.nearestRoadPoint(position.x, position.z);
    const policeCar = vehicles.createCar({
      modelId: 'marina', police: true,
      x: roadPoint.x, z: roadPoint.z,
      heading: Math.atan2(position.x - roadPoint.x, position.z - roadPoint.z),
      ai: 'police', name: 'Solmar Bay Police',
    });
    const unit = { id: `unit-${policeCar.id}`, car: policeCar, target: null, blockedTime: 0, ramSide: rng() < 0.5 ? -1 : 1 };
    units.push(unit);
    return unit;
  }

  function desiredUnits() {
    if (wanted < WANTED.policeSpawnAt) return 0;
    return Math.min(5, Math.max(1, Math.ceil(wanted * WANTED.wantedToPoliceRatio)));
  }

  function chooseSpawn(player) {
    const candidates = [];
    for (const road of city.roads) {
      const along = road.axis === 'z' ? player.z : player.x;
      const low = road.axis === 'z' ? Math.max(road.start + 4, CITY.worldMinZ + 4) : road.start + 4;
      const high = road.axis === 'z' ? Math.min(road.end - 4, CITY.coastZ - 4) : road.end - 4;
      for (const direction of [-1, 1]) {
        const at = clamp(along + direction * 34, low, high);
        const candidate = road.axis === 'z' ? { x: road.coordinate, z: at } : { x: at, z: road.coordinate };
        const gap = distance(candidate, player);
        if (gap >= 22) candidates.push({ ...candidate, gap });
      }
    }
    candidates.sort((a, b) => Math.abs(a.gap - 34) - Math.abs(b.gap - 34));
    if (candidates.length) return candidates[Math.floor(rng() * Math.min(candidates.length, 6))];
    const angle = rng() * Math.PI * 2;
    const x = clamp(player.x + Math.cos(angle) * 32, CITY.worldMinX + 8, CITY.worldMaxX - 8);
    const z = clamp(player.z + Math.sin(angle) * 32, CITY.worldMinZ + 8, CITY.coastZ - 8);
    return city.nearestRoadPoint(x, z);
  }

  function syncUnits() {
    const desired = desiredUnits();
    while (units.length < desired) {
      const player = playerPosition();
      if (!player) break;
      spawnUnit(chooseSpawn(player));
    }
    while (units.length > desired) {
      const unit = units.pop();
      vehicles.removeCar(unit.car);
    }
  }

  function raiseWanted(amount = 1, reason = 'crime') {
    const previous = wanted;
    wanted = clamp(wanted + Math.max(0, Number(amount) || 0), 0, WANTED.maxStars);
    unseenTime = 0;
    if (wanted > previous) syncUnits();
    ctx.onWantedChanged?.(wanted, reason);
    return wanted;
  }

  function lowerWanted(amount = 1) {
    wanted = clamp(wanted - Math.max(0, Number(amount) || 0), 0, WANTED.maxStars);
    if (wanted === 0) { unseenTime = 0; bustedMeter = 0; busted = false; }
    syncUnits();
    ctx.onWantedChanged?.(wanted, 'lowered');
    return wanted;
  }

  function clearWanted() {
    return lowerWanted(wanted);
  }

  function applyBusted() {
    if (bustedMeter < 1 || busted) return;
    bustedMeter = 1;
    busted = true;
    const caughtLevel = wanted;
    wanted = 0;
    unseenTime = 0;
    syncUnits();
    ctx.onWantedChanged?.(wanted, 'busted');
    ctx.onBusted?.({ wanted: caughtLevel, meter: bustedMeter });
  }

  function steerTo(unit, target, closeRange) {
    const car = unit.car;
    const dx = target.x - car.position.x;
    const dz = target.z - car.position.z;
    const gap = Math.hypot(dx, dz);
    let aimX = target.x;
    let aimZ = target.z;
    if (!closeRange) {
      const road = city.nearestRoadPoint(car.position.x, car.position.z);
      const destination = city.nearestRoadPoint(target.x, target.z);
      if (Math.abs(road.x - car.position.x) + Math.abs(road.z - car.position.z) > 6) {
        aimX = road.x; aimZ = road.z;
      } else if (Math.abs(destination.x - road.x) > Math.abs(destination.z - road.z)) {
        aimX = destination.x; aimZ = road.z;
      } else {
        aimX = road.x; aimZ = destination.z;
      }
    }
    const desiredHeading = Math.atan2(aimX - car.position.x, aimZ - car.position.z);
    const difference = normalizeAngle(desiredHeading - car.heading);
    const steer = clamp(difference / 0.8, -1, 1);
    const targetSpeed = closeRange ? (gap > 8 ? car.maxSpeed * 0.82 : car.maxSpeed * 0.42) : car.maxSpeed * 0.68;
    const throttle = Math.abs(car.speed) < targetSpeed - 1 ? 0.78 : 0;
    const brake = gap < 5 ? clamp((5 - gap) / 5, 0.25, 1) : 0;
    vehicles.setControls(car, { throttle, steer, brake });
    unit.target = { x: target.x, z: target.z };
  }

  function update(dt) {
    const step = Math.min(0.05, Math.max(0, dt));
    const player = playerPosition();
    syncUnits();
    if (!player) return;
    let seen = false;
    let closest = Infinity;
    const chaseActive = wanted >= WANTED.policeSpawnAt;
    for (const unit of units) {
      const gap = distance(unit.car.position, player);
      closest = Math.min(closest, gap);
      const sight = canSeePlayer(unit, player);
      seen ||= sight;
      if (!chaseActive) {
        vehicles.setControls(unit.car, { throttle: 0, brake: 0.45, steer: 0 });
        continue;
      }
      const target = { x: player.x, z: player.z };
      if (gap < 11) {
        const side = unit.ramSide * (unit === units[0] ? 1 : -1);
        target.x += Math.cos(unit.car.heading) * side * 3.2;
        target.z -= Math.sin(unit.car.heading) * side * 3.2;
      }
      steerTo(unit, target, gap < 42);
      if (unit.car.speed < 3 && gap > 10) unit.blockedTime += step;
      else unit.blockedTime = 0;
      if (unit.blockedTime > 3.5) {
        unit.ramSide *= -1;
        unit.blockedTime = 0;
      }
    }
    lastSeen = seen;
    if (wanted > 0) {
      if (seen) unseenTime = 0;
      else unseenTime += step;
      if (unseenTime >= WANTED.decayDelay) {
        wanted = Math.max(0, wanted - WANTED.decayPerSecond * step);
        if (wanted < 0.02) wanted = 0;
        if (wanted === 0) syncUnits();
      }
    }
    const slowOrOnFoot = (!ctx.player?.car && !ctx.player?.vehicle) || playerSpeed() < 2.3;
    if (!busted && chaseActive && closest <= WANTED.catchDistance && slowOrOnFoot) {
      bustedMeter = clamp(bustedMeter + step / WANTED.catchTime, 0, 1);
      applyBusted();
    } else if (!busted) {
      bustedMeter = Math.max(0, bustedMeter - step * 0.34);
    }
    ctx.pedestrians?.reactToPoliceChase?.(chaseActive, player);
  }

  const api = {
    units,
    update,
    raiseWanted,
    addWanted: raiseWanted,
    lowerWanted,
    clearWanted,
    canSeePlayer,
    resetBusted() { bustedMeter = 0; busted = false; },
    getUnits() { return units.filter((unit) => unit.car.active); },
    getState() { return { level: wanted, stars: Math.ceil(wanted), fraction: wanted % 1, unseenTime, seen: lastSeen, bustedMeter, busted, policeCount: units.length }; },
    get wanted() { return wanted; },
    get level() { return Math.ceil(wanted); },
    get bustedMeter() { return bustedMeter; },
    get busted() { return busted; },
  };
  ctx.police = api;
  return api;
}
