// Story mission state machine and repeatable courier jobs for Solmar Bay.
import { MISSION } from './config.js';
import { choose, createRng, distance } from './util.js';

const STORY = [
  { id: 'first-run', title: 'First Run', pickup: 'courierPickup', drop: 'firstDelivery' },
  { id: 'three-drops', title: 'Three Drops', drops: 'drops' },
  { id: 'harbor-lights', title: 'Harbor Lights', escape: 'escape' },
];

export function createMissions(ctx) {
  const rng = ctx.rng ?? createRng(64031);
  const completed = new Set();
  let missionIndex = 0;
  let phase = 'pickup';
  let elapsed = 0;
  let dropIndex = 0;
  let sideJob = null;
  let resumePhase = 'pickup';
  let sideDeliveries = 0;
  let storyComplete = false;
  let hudOverride = null;
  let objective = 'Find your next lead';
  let markers = [];
  let lastWanted = 0;

  function award(cash, respect, label) {
    ctx.onMissionComplete?.({ cash, respect, label });
  }

  function point(key) {
    return ctx.city.landmarks[key];
  }

  function position() {
    const actor = ctx.player?.car ?? ctx.player?.vehicle ?? ctx.player;
    return actor?.position ?? { x: 0, z: 0 };
  }

  function refresh() {
    if (hudOverride) {
      objective = hudOverride.objective;
      markers = hudOverride.markers.map((marker) => ({ ...marker }));
      return;
    }
    markers = [];
    if (sideJob) {
      const target = phase === 'side-pickup' ? sideJob.pickup : sideJob.drop;
      objective = phase === 'side-pickup' ? `Courier run: collect the parcel at ${target.label}` : `Deliver the parcel to ${target.label}`;
      markers.push({ ...target, type: phase === 'side-pickup' ? 'pickup' : 'delivery' });
      return;
    }
    if (storyComplete) {
      objective = 'Solmar Bay story complete — take one more run or explore the coast';
      return;
    }
    const mission = STORY[missionIndex];
    if (!mission) return;
    if (mission.id === 'first-run') {
      const pickup = point(mission.pickup);
      const drop = point(mission.drop);
      if (phase === 'pickup') {
        objective = `First Run: pick up the package at ${pickup.label}`;
        markers.push({ ...pickup, type: 'pickup' });
      } else {
        objective = `First Run: deliver the package to ${drop.label} · ${Math.max(0, Math.ceil(MISSION.firstDeadline - elapsed))}s`;
        markers.push({ ...drop, type: 'delivery' });
      }
    } else if (mission.id === 'three-drops') {
      const target = point(mission.drops)[dropIndex];
      objective = `Three Drops: collect drop ${dropIndex + 1} of ${MISSION.dropCount} · police attention rising`;
      markers.push({ ...target, type: 'drop' });
    } else {
      const escape = point(mission.escape);
      if (phase === 'escape') {
        objective = `Harbor Lights: reach ${escape.label} with 3+ wanted stars`;
        markers.push({ ...escape, type: 'escape' });
      } else {
        objective = `Harbor Lights: hold at the escape point and evade until the harbor is clear (${Math.ceil(elapsed)}s)`;
        markers.push({ ...escape, type: 'escape' });
      }
    }
  }

  function completeStoryMission(mission) {
    completed.add(mission.id);
    const reward = mission.id === 'first-run' ? MISSION.firstReward : mission.id === 'three-drops' ? MISSION.secondReward : MISSION.finalReward;
    award(reward, MISSION.respectPerJob * (mission.id === 'three-drops' ? 2 : 1), mission.title);
    missionIndex += 1;
    elapsed = 0;
    dropIndex = 0;
    if (missionIndex >= STORY.length) {
      storyComplete = true;
      ctx.onStoryComplete?.();
    } else {
      phase = missionIndex === 1 ? 'drops' : 'escape';
      ctx.onBriefing?.({ title: STORY[missionIndex].title, copy: missionIndex === 1 ? 'Three packages, three corners of town. Every handoff draws a little more heat.' : 'Make the harbor with the police on your tail, then stay moving until the sirens fade.' });
    }
    refresh();
  }

  function startSideJob() {
    if (sideJob || !ctx.city) return false;
    const places = [
      { x: -24, z: -20, label: 'Park Courier' },
      { x: 100, z: 67, label: 'Marina Parcels' },
      { x: -80, z: 69, label: 'Bodega Luna' },
      { x: 80, z: -68, label: 'Mirador Court' },
      { x: 25, z: -22, label: 'Garden Arcade' },
    ];
    resumePhase = phase;
    sideJob = { pickup: choose(rng, places), drop: null };
    do { sideJob.drop = choose(rng, places); } while (sideJob.drop === sideJob.pickup);
    phase = 'side-pickup';
    elapsed = 0;
    refresh();
    ctx.onToast?.('Courier side run accepted');
    return true;
  }

  function update(dt) {
    const step = Math.max(0, Math.min(0.05, dt));
    const here = position();
    if (sideJob) {
      const target = phase === 'side-pickup' ? sideJob.pickup : sideJob.drop;
      if (distance(here, target) <= MISSION.packageRadius) {
        if (phase === 'side-pickup') {
          phase = 'side-drop';
          ctx.audio?.pickup?.();
          ctx.onToast?.(`Parcel collected — deliver to ${sideJob.drop.label}`);
        } else {
          sideJob = null;
          sideDeliveries += 1;
          ctx.audio?.pickup?.();
          award(MISSION.sideDeliveryReward, Math.max(2, Math.round(MISSION.respectPerJob / 3)), 'Courier side run');
          ctx.onSideDelivery?.();
          phase = resumePhase;
          elapsed = 0;
          ctx.onToast?.('Side delivery complete · cash earned');
        }
        refresh();
      }
      return;
    }
    if (storyComplete) { refresh(); return; }
    const mission = STORY[missionIndex];
    if (!mission) return;
    elapsed += step;
    if (mission.id === 'first-run') {
      const pickup = point(mission.pickup);
      if (phase === 'pickup' && distance(here, pickup) <= MISSION.packageRadius) {
        phase = 'deliver'; elapsed = 0;
        ctx.audio?.pickup?.();
        ctx.onToast?.('Package secured — the clock is running');
      } else if (phase === 'deliver') {
        if (elapsed >= MISSION.firstDeadline) ctx.onToast?.('The delivery window is closing — keep moving');
        if (distance(here, point(mission.drop)) <= MISSION.deliveryRadius) completeStoryMission(mission);
      }
    } else if (mission.id === 'three-drops') {
      const target = point(mission.drops)[dropIndex];
      if (distance(here, target) <= MISSION.dropRadius) {
        dropIndex += 1;
        ctx.police?.raiseWanted?.(MISSION.missionCrime, 'mission drop');
        ctx.audio?.pickup?.();
        ctx.onToast?.(`Drop ${dropIndex} secured · police attention increased`);
        if (dropIndex >= MISSION.dropCount) completeStoryMission(mission);
      }
    } else {
      const escape = point(mission.escape);
      if (phase === 'escape' && distance(here, escape) <= MISSION.deliveryRadius && (ctx.police?.wanted ?? 0) >= 3) {
        phase = 'evade'; elapsed = 0;
        lastWanted = ctx.police.wanted;
        ctx.onToast?.('At the harbor — keep evading until the sirens clear');
      } else if (phase === 'evade') {
        if ((ctx.police?.wanted ?? 0) < lastWanted) lastWanted = ctx.police.wanted;
        if ((ctx.police?.wanted ?? 0) <= 0) completeStoryMission(mission);
      }
    }
    refresh();
  }

  function restore(data = {}) {
    const ids = Array.isArray(data.missionsCompleted) ? data.missionsCompleted : [];
    completed.clear();
    ids.forEach((id) => completed.add(id));
    missionIndex = Math.min(STORY.length, completed.has('harbor-lights') ? 3 : completed.has('three-drops') ? 2 : completed.has('first-run') ? 1 : 0);
    storyComplete = missionIndex >= STORY.length;
    phase = missionIndex === 0 ? 'pickup' : missionIndex === 1 ? 'drops' : 'escape';
    dropIndex = 0;
    elapsed = 0;
    sideJob = null;
    sideDeliveries = Math.max(0, Number(data.sideDeliveries) || 0);
    hudOverride = null;
    refresh();
  }

  function reset() {
    completed.clear(); missionIndex = 0; phase = 'pickup'; elapsed = 0; dropIndex = 0; sideJob = null; resumePhase = 'pickup'; sideDeliveries = 0; storyComplete = false; lastWanted = 0; hudOverride = null;
    refresh();
  }

  function overrideHUD(text, nextMarkers = []) {
    hudOverride = { objective: text, markers: nextMarkers.map((marker) => ({ ...marker })) };
    refresh();
  }

  refresh();
  return {
    update,
    startSideJob,
    reset,
    restore,
    overrideHUD,
    getHUD() { return { objective, markers: markers.map((marker) => ({ ...marker })), missionIndex, phase, storyComplete, sideAvailable: !sideJob }; },
    getCompleted() { return [...completed]; },
    getSideDeliveries() { return sideDeliveries; },
    get storyComplete() { return storyComplete; },
    get missionIndex() { return missionIndex; },
  };
}
