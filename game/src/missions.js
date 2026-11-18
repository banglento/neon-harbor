// missions.js — the three-mission story chain, the repeatable courier run and
// the world markers both of them use.
//
//   const missions = createMissions(ctx);   // registers ctx.missions
//   missions.update(dt, ctx.player);         // call once per frame
//   missions.startNext(player);              // begin the next story job
//   missions.startCourier(player);           // repeatable cash run (C key)
//   missions.cancel('busted');               // drop the current job
//
// The HUD only ever reads plain data:
//   missions.objective = { show, tag, text, sub, timer, urgent }
//   missions.markers   = [{ x, z, kind, label }]    // kind: pickup|drop|escape
//   missions.active    = { def, stage, timer, hold, drops } | null
//   missions.storyComplete, missions.completedCount
//
// Rewards are paid straight into the shared state object (ctx.state) and
// announced on the event bus, so no module has to import the HUD or the audio
// system directly:
//   ctx.events.emit('missionBanner', { kicker, name })
//   ctx.events.emit('missionComplete', { index, def })
//   ctx.events.emit('storyComplete',  { cash, respect })
//   ctx.events.emit('courierComplete', { reward, deliveries })
//   ctx.events.emit('toast', { text, kind })     // kind: good|bad|gold
//
// Mission beats (titles come from config.MISSIONS; the codenames are the
// in-story names for the same jobs):
//   1 Cold Package / First Run   — collect a crate, deliver it across town on a clock
//   2 Three Drops                — three pickups, heat climbing with every one
//   3 Last Light / Harbor Lights — reach the pier under a heavy wanted level,
//                                  then hold there until the heat scrubs off

import * as THREE from 'three';
import { MISSIONS, CITY } from './config.js';
import { mulberry32, rand, randInt, clamp, dist2D, formatTime } from './util.js';

const CODENAME = {
  'cold-package': 'First Run',
  'three-drops': 'Three Drops',
  'last-light': 'Harbor Lights',
};

const MARKER_COLOR = {
  pickup: 0x7fe3c6,
  drop: 0xffd166,
  escape: 0xff6f61,
};

const POINT = {
  pickupMin: 36,
  pickupMax: 95,
  deliveryMin: 110,
  deliveryMax: 235,
  dropMin: 55,
  dropMax: 210,
  dropGap: 55,
  courierPickupMin: 24,
  courierPickupMax: 70,
  courierDropMin: 90,
  courierDropMax: 195,
};

// Mission 3's hold phase: stand in the harbour light while the heat scrubs off.
const HOLD_SECONDS = 15;
const HOLD_DRAIN = 12; // wanted heat removed per second while holed up there
const HOLD_STRAY = 0.5; // seconds of progress lost per second spent outside the ring
const RETRY_DELAY = 6;
const NEXT_DELAY = 6;

export function createMissions(ctx) {
  const root = new THREE.Group();
  root.name = 'MissionMarkers';
  if (ctx.scene) ctx.scene.add(root);

  const rng = mulberry32((CITY.seed ^ 0x3f19) >>> 0);
  const state = ctx.state ?? (ctx.state = { cash: 0, respect: 0, missionsCompleted: 0, sideDeliveries: 0, storyComplete: false });

  const objective = { show: false, tag: '', text: '', sub: '', timer: -1, urgent: false };
  const markers = [];
  const visuals = [];
  let clock = 0;

  const api = {
    root,
    objective,
    markers,
    active: null,
    staged: null,
    retry: null,
    pendingNext: null,
    storyComplete: false,
    courier: { active: null, cooldown: 0 },

    get completedCount() {
      return state.missionsCompleted || 0;
    },
    get busy() {
      return Boolean(api.active || api.courier.active || api.retry || api.pendingNext);
    },

    update,
    startMission,
    startNext,
    startCourier,
    cancel,
    reset,
    restoreProgress,
    stageObjective,
    objectiveText() {
      return objective.text;
    },
  };

  // --------------------------------------------------------------- objectives

  function setObjective(tag, text, sub = '', timer = -1, urgent = false) {
    objective.show = true;
    objective.tag = tag;
    objective.text = text;
    objective.sub = sub;
    objective.timer = timer;
    objective.urgent = urgent;
  }

  function clearObjective() {
    objective.show = false;
    objective.tag = '';
    objective.text = '';
    objective.sub = '';
    objective.timer = -1;
    objective.urgent = false;
  }

  function announce(kicker, name) {
    if (ctx.events) ctx.events.emit('missionBanner', { kicker, name });
  }

  function toast(text, kind = 'gold') {
    if (ctx.events) ctx.events.emit('toast', { text, kind });
  }

  // ------------------------------------------------------------------ markers

  function buildMarkerVisual(kind) {
    const color = MARKER_COLOR[kind] ?? 0xffd166;
    const group = new THREE.Group();
    group.name = `marker:${kind}`;

    const ringMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.62,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.55, 2.15, 26), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.08;
    group.add(ring);

    const innerMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const inner = new THREE.Mesh(new THREE.CircleGeometry(1.5, 22), innerMat);
    inner.rotation.x = -Math.PI / 2;
    inner.position.y = 0.07;
    group.add(inner);

    const beamMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.5, 8.5, 18, 1, true), beamMat);
    beam.position.y = 4.25;
    group.add(beam);

    const gemMat = new THREE.MeshBasicMaterial({ color: 0xfff6e2 });
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.55, 0), gemMat);
    gem.position.y = 2.6;
    group.add(gem);

    return { group, gem, ring, kind };
  }

  function setMarkers(specs) {
    clearMarkers();
    for (const spec of specs) {
      const groundY = ctx.city && ctx.city.groundHeightAt ? ctx.city.groundHeightAt(spec.x, spec.z) : 0;
      const visual = buildMarkerVisual(spec.kind);
      visual.group.position.set(spec.x, groundY, spec.z);
      root.add(visual.group);
      visuals.push(visual);
      markers.push({
        x: spec.x,
        z: spec.z,
        kind: spec.kind,
        label: spec.label ?? '',
        radius: spec.kind === 'escape' ? MISSIONS.escapeRadius : spec.kind === 'pickup' ? MISSIONS.pickupRadius : MISSIONS.dropRadius,
      });
    }
  }

  function clearMarkers() {
    for (const visual of visuals) {
      root.remove(visual.group);
      visual.group.traverse((node) => {
        if (node.geometry) node.geometry.dispose();
        if (node.material) node.material.dispose();
      });
    }
    visuals.length = 0;
    markers.length = 0;
  }

  function animateMarkers(dt) {
    clock += dt;
    for (const visual of visuals) {
      visual.gem.rotation.y = clock * 1.4;
      visual.gem.position.y = 2.6 + Math.sin(clock * 2.1) * 0.18;
      visual.ring.scale.setScalar(1 + Math.sin(clock * 2.6) * 0.05);
    }
  }

  // ------------------------------------------------------------- point offers

  function networkNodes() {
    const network = ctx.city && ctx.city.network;
    if (!network) return null;
    return network;
  }

  // A reachable point somewhere in the grid, at least `minDist` from (px, pz)
  // and clear of the other points already chosen for this job.
  function pickPoint(px, pz, minDist, maxDist, used = []) {
    const network = networkNodes();
    if (!network) return { x: px + 20, z: pz + 20 };
    let fallback = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const ix = randInt(rng, 0, network.nodeCount.x - 1);
      const iz = randInt(rng, 0, network.nodeCount.z - 1);
      const node = network.nodes(ix, iz);
      const x = node.x + rand(rng, -5, 5);
      const z = node.z + rand(rng, -5, 5);
      const d = dist2D(px, pz, x, z);
      if (d < minDist || d > maxDist) continue;
      if (used.some((other) => dist2D(other.x, other.z, x, z) < POINT.dropGap)) continue;
      return { x, z };
    }
    // Deterministic fallback: the far corner of the grid.
    const node = network.nodes(network.nodeCount.x - 2, network.nodeCount.z - 2);
    fallback = { x: node.x, z: node.z };
    return fallback;
  }

  function playerOf(player) {
    const p = player ?? ctx.player;
    if (!p) return { x: CITY.playerStart.x, z: CITY.playerStart.z };
    return { x: p.x, z: p.z };
  }

  // ------------------------------------------------------------ story starts

  function startMission(index, player) {
    const def = MISSIONS.list[index];
    if (!def) return null;
    api.staged = null;
    api.retry = null;
    api.pendingNext = null;
    api.courier.active = null;
    api.courier.cooldown = Math.max(api.courier.cooldown, MISSIONS.courier.cooldown);

    const p = playerOf(player);
    const job = {
      def,
      index,
      stage: '',
      timer: def.timeLimit || 0,
      hold: 0,
      drops: 0,
      elapsed: 0,
    };

    if (def.id === 'cold-package') {
      job.pickup = pickPoint(p.x, p.z, POINT.pickupMin, POINT.pickupMax);
      job.drop = pickPoint(job.pickup.x, job.pickup.z, POINT.deliveryMin, POINT.deliveryMax, [job.pickup]);
      job.stage = 'pickup';
      setMarkers([{ x: job.pickup.x, z: job.pickup.z, kind: 'pickup', label: 'Crate' }]);
    } else if (def.id === 'three-drops') {
      const used = [];
      for (let i = 0; i < 3; i += 1) {
        const point = pickPoint(p.x, p.z, POINT.dropMin, POINT.dropMax, used);
        used.push(point);
        job.points = used;
      }
      job.stage = 'drop';
      setMarkers([{ x: job.points[0].x, z: job.points[0].z, kind: 'drop', label: 'Drop 1' }]);
    } else {
      const escape = { x: CITY.pier.endX - 16, z: CITY.pier.z };
      job.escape = escape;
      job.stage = 'reach';
      setMarkers([{ x: escape.x, z: escape.z, kind: 'escape', label: 'Harbour' }]);
      // The getaway opens hot: the SBPD already knows the crate is moving.
      if (ctx.police) ctx.police.setLevel(4, 'mission');
    }

    api.active = job;
    announce(`Mission ${def.number} · ${CODENAME[def.id] ?? 'Job'}`, def.title);
    if (ctx.events) ctx.events.emit('missionStarted', { index, def });
    return job;
  }

  function startNext(player) {
    const next = clamp(state.missionsCompleted || 0, 0, MISSIONS.list.length - 1);
    if ((state.missionsCompleted || 0) >= MISSIONS.list.length) return null;
    return startMission(next, player);
  }

  // --------------------------------------------------------------- story loop

  function updateStory(dt, player) {
    const job = api.active;
    if (!job) return;
    const def = job.def;
    job.elapsed += dt;

    if (job.timer > 0) {
      job.timer -= dt;
      if (job.timer <= 0) {
        job.timer = 0;
        failJob('The clock ran out.');
        return;
      }
    }

    const p = playerOf(player);
    const marker = markers[0];
    const distance = marker ? dist2D(p.x, p.z, marker.x, marker.z) : Infinity;
    const urgent = job.timer > 0 && job.timer < 20;

    if (def.id === 'cold-package') {
      if (job.stage === 'pickup') {
        setObjective(
          `Mission 1 · ${CODENAME[def.id]}`,
          'Collect the crate from the marked corner.',
          'Then run it across town before the clock runs out.',
          job.timer,
          urgent,
        );
        if (distance <= MISSIONS.pickupRadius) {
          job.stage = 'deliver';
          setMarkers([{ x: job.drop.x, z: job.drop.z, kind: 'drop', label: 'Drop' }]);
          toast('Crate secured — deliver it across town.', 'good');
        }
      } else if (job.stage === 'deliver') {
        setObjective(
          `Mission 1 · ${CODENAME[def.id]}`,
          'Deliver the crate to the drop across town.',
          `${Math.round(distance)} m to the marker.`,
          job.timer,
          urgent,
        );
        if (distance <= MISSIONS.dropRadius) completeStory();
      }
      return;
    }

    if (def.id === 'three-drops') {
      const n = Math.min(job.drops + 1, 3);
      const level = ctx.police ? ctx.police.level : 0;
      setObjective(
        `Mission 2 · ${CODENAME[def.id]}`,
        `Collect drop ${n} of 3.`,
        level > 0 ? `The scanner is warm — ${level} star${level === 1 ? '' : 's'}.` : 'Nobody is watching. Yet.',
      );
      if (distance <= MISSIONS.dropRadius) {
        job.drops += 1;
        // Every hand-off pings the scanner, exactly as the brief warns.
        if (ctx.police) ctx.police.raise((def.heatOnComplete || 60) / 3, 'delivery');
        if (job.drops >= 3) {
          completeStory();
        } else {
          const point = job.points[job.drops];
          setMarkers([{ x: point.x, z: point.z, kind: 'drop', label: `Drop ${job.drops + 1}` }]);
          toast(`Drop ${job.drops} of 3 — keep moving.`, 'gold');
        }
      }
      return;
    }

    // Last Light / Harbor Lights.
    if (job.stage === 'reach') {
      const level = ctx.police ? ctx.police.level : 0;
      setObjective(
        `Mission 3 · ${CODENAME[def.id]}`,
        'Reach the pier with the crate.',
        `Wanted ${level} — get to the harbour and hold.`,
      );
      if (distance <= MISSIONS.escapeRadius) {
        job.stage = 'hold';
        job.hold = 0;
        toast('You made the harbour — hold until the heat dies.', 'good');
      }
      return;
    }

    // hold: stand in the light, the heat scrubs off.
    if (distance <= MISSIONS.escapeRadius + 3) {
      job.hold = Math.min(HOLD_SECONDS, job.hold + dt);
      if (ctx.police && ctx.police.level > 0) ctx.police.coolDown(HOLD_DRAIN * dt);
    } else {
      job.hold = Math.max(0, job.hold - dt * HOLD_STRAY);
    }
    const level = ctx.police ? ctx.police.level : 0;
    const remaining = Math.max(0, HOLD_SECONDS - job.hold);
    setObjective(
      `Mission 3 · ${CODENAME[def.id]}`,
      'Hold the harbour until the heat clears.',
      level > 0 ? `Still ${level} star${level === 1 ? '' : 's'} — stay in the light.` : 'Clear — keep holding.',
      remaining,
    );
    if (job.hold >= HOLD_SECONDS && level === 0) completeStory();
  }

  function failJob(reason) {
    const job = api.active;
    if (!job) return;
    api.active = null;
    clearMarkers();
    api.retry = { index: job.index, timer: RETRY_DELAY, text: reason };
    setObjective(`Mission ${job.def.number} failed`, reason, 'The job comes back around — stand by.', RETRY_DELAY);
    toast(`${job.def.title} failed — ${reason}`, 'bad');
    if (ctx.events) ctx.events.emit('missionFailed', { index: job.index, def: job.def, reason });
  }

  function completeStory() {
    const job = api.active;
    if (!job) return;
    const def = job.def;
    const index = job.index;
    api.active = null;
    clearMarkers();

    state.cash = (state.cash || 0) + def.reward;
    state.respect = (state.respect || 0) + def.respect;
    state.missionsCompleted = Math.max(state.missionsCompleted || 0, def.number);

    toast(`${def.title} complete — +$${def.reward}`, 'good');
    toast(`+${def.respect} respect`, 'gold');
    if (ctx.events) ctx.events.emit('missionComplete', { index, def });

    if (state.missionsCompleted >= MISSIONS.list.length) {
      api.storyComplete = true;
      state.storyComplete = true;
      setObjective('Story complete', 'The harbour lights are behind you.', 'Free roam — press C for courier work.');
      if (ctx.events) {
        ctx.events.emit('storyComplete', {
          cash: state.cash,
          respect: state.respect,
          deliveries: state.sideDeliveries || 0,
        });
      }
      return;
    }

    api.pendingNext = { index: index + 1, timer: NEXT_DELAY };
    announce('Next job', MISSIONS.list[index + 1].title);
  }

  // ------------------------------------------------------------- the courier

  function startCourier(player) {
    if (api.active || api.courier.active || api.retry || api.pendingNext) return false;
    if (api.courier.cooldown > 0) return false;
    const p = playerOf(player);
    const pickup = pickPoint(p.x, p.z, POINT.courierPickupMin, POINT.courierPickupMax);
    const drop = pickPoint(pickup.x, pickup.z, POINT.courierDropMin, POINT.courierDropMax, [pickup]);
    api.courier.active = { stage: 'pickup', pickup, drop, timer: MISSIONS.courier.timeLimit };
    setMarkers([{ x: pickup.x, z: pickup.z, kind: 'pickup', label: 'Parcel' }]);
    toast('Courier run — collect the parcel.', 'gold');
    return true;
  }

  function updateCourier(dt, player) {
    const run = api.courier.active;
    if (!run) return;
    run.timer -= dt;
    if (run.timer <= 0) {
      api.courier.active = null;
      clearMarkers();
      api.courier.cooldown = MISSIONS.courier.cooldown;
      setObjective('Courier run', 'The parcel went cold.', 'Another run is available shortly.', 0, true);
      toast('Courier run expired — the parcel went cold.', 'bad');
      return;
    }

    const p = playerOf(player);
    const marker = markers[0];
    const distance = marker ? dist2D(p.x, p.z, marker.x, marker.z) : Infinity;

    if (run.stage === 'pickup') {
      setObjective('Courier run', 'Collect the parcel at the marked corner.', `${Math.round(distance)} m to go.`, run.timer, run.timer < 20);
      if (distance <= MISSIONS.pickupRadius) {
        run.stage = 'deliver';
        setMarkers([{ x: run.drop.x, z: run.drop.z, kind: 'drop', label: 'Drop-off' }]);
        toast('Parcel up — clock is running.', 'good');
      }
      return;
    }

    setObjective('Courier run', 'Drop the parcel across town.', `${Math.round(distance)} m to go.`, run.timer, run.timer < 20);
    if (distance <= MISSIONS.dropRadius) {
      const reward = MISSIONS.courier.reward;
      api.courier.active = null;
      api.courier.cooldown = MISSIONS.courier.cooldown;
      clearMarkers();
      state.cash = (state.cash || 0) + reward;
      state.respect = (state.respect || 0) + MISSIONS.courier.respect;
      state.sideDeliveries = (state.sideDeliveries || 0) + 1;
      toast(`Courier run paid — +$${reward}`, 'good');
      if (ctx.events) ctx.events.emit('courierComplete', { reward, deliveries: state.sideDeliveries });
      setObjective('Courier run', 'Paid and clear.', 'Press C for another run.');
    }
  }

  // ------------------------------------------------------------------- update

  function update(dt, player) {
    animateMarkers(dt > 0 ? dt : 0);
    if (!(dt > 0)) return;

    if (api.courier.cooldown > 0) api.courier.cooldown = Math.max(0, api.courier.cooldown - dt);

    // A staged screenshot owns the objective outright.
    if (api.staged) return;

    if (api.active) {
      updateStory(dt, player);
      return;
    }

    if (api.retry) {
      api.retry.timer -= dt;
      if (api.retry.timer <= 0) {
        const index = api.retry.index;
        const reason = api.retry.text;
        api.retry = null;
        if (index != null && MISSIONS.list[index]) {
          startMission(index, player);
          toast(`Back on the job — ${reason}`, 'gold');
        }
      } else {
        setObjective(`Mission ${(MISSIONS.list[api.retry.index]?.number ?? '')} retry`, api.retry.text, 'The job comes back around.', api.retry.timer);
      }
      return;
    }

    if (api.courier.active) {
      updateCourier(dt, player);
      return;
    }

    if (api.pendingNext) {
      api.pendingNext.timer -= dt;
      const def = MISSIONS.list[api.pendingNext.index];
      if (api.pendingNext.timer <= 0) {
        const index = api.pendingNext.index;
        api.pendingNext = null;
        startMission(index, player);
        return;
      }
      setObjective(
        'Next job',
        `${def.title} — inbound in ${Math.ceil(api.pendingNext.timer)}s`,
        'Press C for a courier run while you wait.',
      );
      return;
    }

    if (api.storyComplete) {
      setObjective('Free roam', 'The city is yours. Press C for a courier run.', `${state.sideDeliveries || 0} deliveries run.`);
    } else if (api.courier.cooldown > 0) {
      setObjective('Solmar Bay', 'Catch your breath.', `Courier runs again in ${Math.ceil(api.courier.cooldown)}s.`);
    } else {
      setObjective('Solmar Bay', 'The next job is close. Press C for a courier run.', '');
    }
  }

  // -------------------------------------------------------------- lifecycle

  function cancel(reason = 'cancelled') {
    const job = api.active;
    const courierWasActive = Boolean(api.courier.active);
    api.active = null;
    api.courier.active = null;
    api.staged = null;
    api.pendingNext = null;
    clearMarkers();
    if (job) {
      api.retry = { index: job.index, timer: RETRY_DELAY, text: 'The job slipped.' };
      setObjective(`Mission ${job.def.number} on ice`, 'The job slipped.', 'It comes back around.', RETRY_DELAY);
    } else if (courierWasActive) {
      api.courier.cooldown = MISSIONS.courier.cooldown;
      clearObjective();
    } else if (reason !== 'reset') {
      clearObjective();
    }
  }

  function reset() {
    api.active = null;
    api.courier.active = null;
    api.courier.cooldown = 0;
    api.retry = null;
    api.pendingNext = null;
    api.staged = null;
    api.storyComplete = false;
    state.missionsCompleted = 0;
    state.storyComplete = false;
    clearMarkers();
    clearObjective();
  }

  // Called by main after Continue: resume at the first job not yet finished.
  function restoreProgress(player) {
    api.staged = null;
    api.retry = null;
    api.pendingNext = null;
    api.courier.active = null;
    api.courier.cooldown = 0;
    clearMarkers();
    const done = state.missionsCompleted || 0;
    api.storyComplete = Boolean(state.storyComplete) || done >= MISSIONS.list.length;
    if (api.storyComplete) {
      setObjective('Free roam', 'The story is behind you. Press C for a courier run.', `${state.sideDeliveries || 0} deliveries run.`);
      return;
    }
    startMission(done, player);
  }

  // ------------------------------------------------- deterministic shot helper
  // shots.js frames a scene by handing over an objective and a marker set, so
  // the stills show a real job on the HUD without running the clock.
  function stageObjective(spec) {
    api.active = null;
    api.retry = null;
    api.pendingNext = null;
    api.courier.active = null;
    api.staged = spec ?? null;
    if (!spec) {
      clearMarkers();
      clearObjective();
      return;
    }
    setObjective(spec.tag ?? 'Mission', spec.text ?? '', spec.sub ?? '', spec.timer ?? -1, Boolean(spec.urgent));
    setMarkers(spec.markers ?? []);
  }

  api.update = update;
  ctx.missions = api;
  return api;
}

// Formatting helper kept next to the module that owns clock text.
export function missionClock(seconds) {
  return formatTime(seconds);
}
