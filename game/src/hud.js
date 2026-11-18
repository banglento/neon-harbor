// hud.js — binds the HUD DOM written in index.html and draws the minimap.
//
//   const hud = createHud(ctx);       // registers ctx.hud
//   hud.bindMenus({ onNewGame, ... }); // wire the title / pause / end buttons
//   hud.update(dt, ctx.player, ctx.missions);
//   hud.toast('Parcel up', 'good');
//   hud.banner('Mission 1', 'Cold Package');
//   hud.showScreen('pause');
//
// The DOM ids are the contract with index.html: cash, respect-fill, wanted
// stars, condition-fill, objective-*, minimap, vehicle-hud, toasts, prompt,
// crosshair, district, flash and the five overlays.
//
// The minimap draws straight from the city's road network: roads, blocks, the
// water, the pier, moving traffic, police units and mission markers, with the
// player as an arrow at the centre. It redraws on a timer (not every frame) so
// a 60 fps game does not spend its budget on a 190 px canvas.

import { HUD, CITY } from './config.js';
import { clamp, formatCash, formatTime, dist2D } from './util.js';

const MAP_REDRAW = 1 / 9; // seconds between minimap redraws
const TOAST_LIMIT = 4;

export function createHud(ctx) {
  const el = {
    hud: document.getElementById('hud'),
    cash: document.getElementById('cash'),
    respectFill: document.getElementById('respect-fill'),
    respectValue: document.getElementById('respect-value'),
    wanted: document.getElementById('wanted'),
    stars: Array.from(document.querySelectorAll('#wanted span')),
    conditionFill: document.getElementById('condition-fill'),
    objectiveBox: document.getElementById('objective-box'),
    objectiveTag: document.getElementById('objective-tag'),
    objectiveText: document.getElementById('objective-text'),
    objectiveSub: document.getElementById('objective-sub'),
    objectiveTimer: document.getElementById('objective-timer'),
    minimap: document.getElementById('minimap'),
    district: document.getElementById('district'),
    vehicleHud: document.getElementById('vehicle-hud'),
    vehicleName: document.getElementById('vehicle-name'),
    speed: document.getElementById('speed'),
    carHealth: document.getElementById('car-health-fill'),
    toasts: document.getElementById('toasts'),
    prompt: document.getElementById('prompt'),
    crosshair: document.getElementById('crosshair'),
    flash: document.getElementById('flash'),
    missionBanner: document.getElementById('mission-banner'),
    missionKicker: document.querySelector('#mission-banner .kicker'),
    missionName: document.querySelector('#mission-banner .name'),
    screens: {
      start: document.getElementById('start-screen'),
      pause: document.getElementById('pause-screen'),
      busted: document.getElementById('busted-screen'),
      complete: document.getElementById('complete-screen'),
    },
    startInfo: document.getElementById('save-info'),
    loadingNote: document.getElementById('loading-note'),
    bustedFine: document.getElementById('busted-fine'),
    bustedText: document.getElementById('busted-text'),
    completeCash: document.getElementById('complete-cash'),
    completeRespect: document.getElementById('complete-respect'),
    completeTime: document.getElementById('complete-time'),
    muteButton: document.getElementById('btn-mute'),
    continueButton: document.getElementById('btn-continue'),
  };

  const mapCtx = el.minimap ? el.minimap.getContext('2d') : null;
  const mapSize = el.minimap ? el.minimap.width : HUD.minimapSize;
  const mapRange = HUD.minimapRange;

  let mapTimer = 0;
  let lastCash = null;
  let lastRespect = null;
  let lastStars = -1;
  let lastObjective = '';
  let lastObjectiveShown = null;
  let lastTimer = -2;
  let bannerTimer = 0;
  let promptText = '';
  let promptShown = false;
  let flashTimer = 0;
  let clock = 0;
  let districtName = 'Solmar Bay';

  // Cached road layout — the network never changes after buildCity().
  const roads = buildRoadLayout(ctx);

  const hud = {
    el,
    clock: 0,
    update,
    toast,
    banner,
    prompt,
    hidePrompt,
    flash,
    showScreen,
    hideScreens,
    setSaveInfo,
    setMuteLabel,
    setDistrict(name) {
      districtName = name;
      if (el.district) el.district.textContent = name;
    },
    setBustedText(text, fine) {
      if (el.bustedText && text) el.bustedText.textContent = text;
      if (el.bustedFine) el.bustedFine.textContent = `Fine ${formatCash(fine)}`;
    },
    setCompleteStats(stats) {
      if (el.completeCash) el.completeCash.textContent = formatCash(stats.cash ?? 0);
      if (el.completeRespect) el.completeRespect.textContent = String(Math.round(stats.respect ?? 0));
      if (el.completeTime) el.completeTime.textContent = formatTime(stats.time ?? 0);
    },
    bindMenus,
    bindKeys(state) {
      // Filled in by main.js: keyboard short-cuts are game logic, not DOM.
      hud.keys = state;
    },
    redrawMap,
  };

  // ---------------------------------------------------------------- DOM setup

  function showScreen(name) {
    hideScreens();
    const screen = el.screens[name];
    if (screen) screen.classList.add('visible');
    if (el.hud) {
      if (name === 'start') el.hud.classList.remove('visible');
      else el.hud.classList.add('visible');
    }
  }

  function hideScreens() {
    for (const screen of Object.values(el.screens)) {
      if (screen) screen.classList.remove('visible');
    }
  }

  function bindMenus(handlers = {}) {
    const on = (id, fn) => {
      const node = document.getElementById(id);
      if (!node || typeof fn !== 'function') return;
      node.addEventListener('click', (event) => {
        event.preventDefault();
        fn();
      });
    };
    on('btn-new', handlers.onNewGame);
    on('btn-continue', handlers.onContinue);
    on('btn-help', handlers.onHelp);
    on('btn-resume', handlers.onResume);
    on('btn-save', handlers.onSave);
    on('btn-restart', handlers.onRestart);
    on('btn-mute', handlers.onMute);
    on('btn-quit', handlers.onQuitToTitle);
    on('btn-busted-continue', handlers.onBustedContinue);
    on('btn-free-roam', handlers.onFreeRoam);
    on('btn-credits', handlers.onTitle);
  }

  function setSaveInfo(text, canContinue) {
    if (el.startInfo) el.startInfo.textContent = text;
    if (el.continueButton) el.continueButton.disabled = !canContinue;
  }

  function setMuteLabel(muted) {
    if (el.muteButton) el.muteButton.textContent = muted ? 'Sound: Off' : 'Sound: On';
  }

  // ------------------------------------------------------------------- toasts

  function toast(text, kind = '') {
    if (!el.toasts || !text) return;
    const node = document.createElement('div');
    node.className = `toast${kind ? ` ${kind}` : ''}`;
    node.textContent = text;
    el.toasts.appendChild(node);
    while (el.toasts.children.length > TOAST_LIMIT) el.toasts.removeChild(el.toasts.firstChild);
    window.setTimeout(() => {
      node.style.transition = 'opacity 280ms ease, transform 280ms ease';
      node.style.opacity = '0';
      node.style.transform = 'translateY(-6px)';
      window.setTimeout(() => {
        if (node.parentNode) node.parentNode.removeChild(node);
      }, 300);
    }, HUD.toastTime * 1000);
  }

  function banner(kicker, name) {
    if (!el.missionBanner) return;
    if (el.missionKicker) el.missionKicker.textContent = kicker ?? 'Mission';
    if (el.missionName) el.missionName.textContent = name ?? '';
    el.missionBanner.classList.add('show');
    bannerTimer = 2.8;
  }

  function flash(color = '#ff3b30', strength = 0.5) {
    if (!el.flash) return;
    el.flash.style.background = color;
    el.flash.style.opacity = String(strength);
    flashTimer = 0.38;
  }

  // ------------------------------------------------------------------- prompt

  function prompt(html) {
    if (!el.prompt) return;
    if (promptText !== html) {
      el.prompt.innerHTML = html;
      promptText = html;
    }
    if (!promptShown) {
      el.prompt.classList.add('show');
      promptShown = true;
    }
  }

  function hidePrompt() {
    if (!el.prompt || !promptShown) return;
    el.prompt.classList.remove('show');
    promptShown = false;
    promptText = '';
  }

  // ------------------------------------------------------------------- update

  function update(dt, player, missions) {
    const step = dt > 0 ? dt : 0;
    clock += step;
    hud.clock = clock;

    const state = ctx.state ?? { cash: 0, respect: 0 };
    updateMoney(state);
    updateWanted(ctx.police);
    updateCondition(player);
    updateVehicle(player);
    updateObjective(missions?.objective, state);
    updatePromptAndCrosshair(player);
    updateTimers(step);

    mapTimer -= step;
    if (mapTimer <= 0) {
      mapTimer = MAP_REDRAW;
      redrawMap(player, missions);
    }
  }

  function updateMoney(state) {
    const cash = Math.round(state.cash ?? 0);
    if (cash !== lastCash) {
      lastCash = cash;
      if (el.cash) el.cash.textContent = formatCash(cash);
    }
    const respect = Math.round(state.respect ?? 0);
    if (respect !== lastRespect) {
      lastRespect = respect;
      if (el.respectValue) el.respectValue.textContent = String(respect);
      // Respect is open-ended: each 100 points fills the bar again.
      if (el.respectFill) el.respectFill.style.width = `${clamp((respect % 100) / 100 || (respect > 0 ? 1 : 0), 0.02, 1) * 100}%`;
    }
  }

  function updateWanted(police) {
    const level = police ? police.level : 0;
    if (level === lastStars) return;
    lastStars = level;
    el.stars.forEach((star, i) => {
      star.classList.toggle('on', i < level);
    });
    if (el.wanted) el.wanted.classList.toggle('flash', level >= 3);
  }

  function updateCondition(player) {
    if (!el.conditionFill) return;
    const condition = clamp(player?.condition ?? 1, 0, 1);
    el.conditionFill.style.width = `${condition * 100}%`;
    el.conditionFill.classList.toggle('hurt', condition <= 0.6 && condition > 0.3);
    el.conditionFill.classList.toggle('bad', condition <= 0.3);
  }

  function updateVehicle(player) {
    const car = player?.car;
    const driving = Boolean(car && player.onFoot === false);
    if (el.vehicleHud) el.vehicleHud.classList.toggle('show', driving);
    if (!driving) return;
    if (el.vehicleName) el.vehicleName.textContent = car.name ?? 'Car';
    if (el.speed) el.speed.textContent = String(Math.round(Math.abs(car.speed) * 3.6));
    if (el.carHealth) el.carHealth.style.width = `${clamp(car.health ?? 1, 0, 1) * 100}%`;
  }

  function updateObjective(objective, state) {
    if (!el.objectiveBox) return;
    const show = Boolean(objective && objective.show);
    if (show !== lastObjectiveShown) {
      lastObjectiveShown = show;
      el.objectiveBox.classList.toggle('show', show);
    }
    if (!show) return;

    const text = objective.text ?? '';
    if (text !== lastObjective) {
      lastObjective = text;
      if (el.objectiveText) el.objectiveText.textContent = text;
    }
    if (el.objectiveTag) {
      const tag = objective.tag || 'Mission';
      if (el.objectiveTag.textContent !== tag) el.objectiveTag.textContent = tag;
    }
    if (el.objectiveSub) {
      const sub = objective.sub || '';
      if (el.objectiveSub.textContent !== sub) el.objectiveSub.textContent = sub;
    }
    if (el.objectiveTimer) {
      const timer = typeof objective.timer === 'number' ? objective.timer : -1;
      const rounded = timer < 0 ? -2 : Math.max(0, Math.ceil(timer));
      if (rounded !== lastTimer) {
        lastTimer = rounded;
        if (timer < 0) {
          el.objectiveTimer.classList.add('hidden');
          el.objectiveTimer.textContent = '';
        } else {
          el.objectiveTimer.classList.remove('hidden');
          el.objectiveTimer.textContent = formatTime(timer);
        }
      }
      el.objectiveTimer.classList.toggle('urgent', Boolean(objective.urgent));
    }
    // A quiet tie-in: the district label doubles as a progress read-out.
    if (state && state.missionsCompleted >= 3 && districtName !== 'Solmar Bay · Free Roam') {
      hud.setDistrict('Solmar Bay · Free Roam');
    }
  }

  function updatePromptAndCrosshair(player) {
    if (el.crosshair) el.crosshair.classList.toggle('show', Boolean(player && player.onFoot));
  }

  function updateTimers(dt) {
    if (bannerTimer > 0) {
      bannerTimer -= dt;
      if (bannerTimer <= 0 && el.missionBanner) el.missionBanner.classList.remove('show');
    }
    if (flashTimer > 0) {
      flashTimer -= dt;
      if (flashTimer <= 0 && el.flash) el.flash.style.opacity = '0';
    }
  }

  // ------------------------------------------------------------------ minimap

  function buildRoadLayout(ctx) {
    const network = ctx.city?.network;
    if (!network) return { xs: [], zs: [], blocks: [], roadWidth: CITY.road };
    return {
      xs: network.xs,
      zs: network.zs,
      roadWidth: network.roadWidth,
      blocks: (ctx.city.blocks ?? []).map((b) => ({
        minX: b.minX,
        maxX: b.maxX,
        minZ: b.minZ,
        maxZ: b.maxZ,
        kind: b.kind,
      })),
      piers: [{ minX: CITY.pier.startX, maxX: CITY.pier.endX, minZ: CITY.pier.z - CITY.pier.width / 2, maxZ: CITY.pier.z + CITY.pier.width / 2 }],
    };
  }

  // World → canvas. North (-Z) is up, east (+X) is right.
  function makeProjection(centreX, centreZ) {
    const scale = mapSize / mapRange;
    const half = mapSize / 2;
    return {
      scale,
      x: (worldX) => half + (worldX - centreX) * scale,
      y: (worldZ) => half + (worldZ - centreZ) * scale,
      rect(rect) {
        return {
          x: half + (rect.minX - centreX) * scale,
          y: half + (rect.minZ - centreZ) * scale,
          w: (rect.maxX - rect.minX) * scale,
          h: (rect.maxZ - rect.minZ) * scale,
        };
      },
    };
  }

  function redrawMap(player, missions) {
    if (!mapCtx || !player) return;
    const centreX = player.x;
    const centreZ = player.z;
    const p = makeProjection(centreX, centreZ);
    const half = mapSize / 2;

    mapCtx.save();
    mapCtx.clearRect(0, 0, mapSize, mapSize);

    // Base: warm sand-toned land.
    mapCtx.fillStyle = '#2a3440';
    mapCtx.fillRect(0, 0, mapSize, mapSize);

    // Water east of the waterline, drawn as one band.
    const waterX = p.x(CITY.waterEdgeX);
    if (waterX < mapSize) {
      mapCtx.fillStyle = '#1b4b5c';
      mapCtx.fillRect(Math.max(0, waterX), 0, mapSize - Math.max(0, waterX), mapSize);
    }

    // Blocks: dark slabs, parks and the plaza in green.
    for (const block of roads.blocks) {
      const r = p.rect(block);
      if (r.x > mapSize || r.x + r.w < 0 || r.y > mapSize || r.y + r.h < 0) continue;
      mapCtx.fillStyle = block.kind === 'park' || block.kind === 'plaza' ? '#33543f' : '#3a3f47';
      mapCtx.fillRect(r.x, r.y, r.w, r.h);
    }

    // Roads: every grid line, full length, so the grid reads at a glance.
    mapCtx.strokeStyle = '#67707c';
    mapCtx.lineWidth = Math.max(2, roads.roadWidth * p.scale * 0.62);
    mapCtx.lineCap = 'butt';
    mapCtx.beginPath();
    for (const x of roads.xs) {
      const sx = p.x(x);
      if (sx < -20 || sx > mapSize + 20) continue;
      mapCtx.moveTo(sx, 0);
      mapCtx.lineTo(sx, mapSize);
    }
    for (const z of roads.zs) {
      const sy = p.y(z);
      if (sy < -20 || sy > mapSize + 20) continue;
      mapCtx.moveTo(0, sy);
      mapCtx.lineTo(mapSize, sy);
    }
    mapCtx.stroke();

    // The pier.
    mapCtx.fillStyle = '#8a6b47';
    for (const pier of roads.piers) {
      const r = p.rect(pier);
      mapCtx.fillRect(r.x, r.y, r.w, Math.max(2, r.h));
    }

    // Traffic: small pale dots. Police: larger blue/red dots.
    const vehicles = ctx.vehicles?.list ?? [];
    for (const car of vehicles) {
      if (car.removed) continue;
      if (Math.abs(car.x - centreX) > mapRange && Math.abs(car.z - centreZ) > mapRange) continue;
      const cx = p.x(car.x);
      const cy = p.y(car.z);
      if (cx < 0 || cx > mapSize || cy < 0 || cy > mapSize) continue;
      if (car.role === 'police') continue;
      if (car === player.car) continue;
      mapCtx.fillStyle = 'rgba(232, 226, 210, 0.7)';
      mapCtx.beginPath();
      mapCtx.arc(cx, cy, 2.6, 0, Math.PI * 2);
      mapCtx.fill();
    }
    for (const car of ctx.police?.cars ?? []) {
      if (car.removed) continue;
      const cx = p.x(car.x);
      const cy = p.y(car.z);
      if (cx < -10 || cx > mapSize + 10 || cy < -10 || cy > mapSize + 10) continue;
      // Alternating blue/red so a pursuit reads on the map.
      mapCtx.fillStyle = Math.floor(clock * 4) % 2 === 0 ? '#3f7bff' : '#ff5b47';
      mapCtx.beginPath();
      mapCtx.arc(cx, cy, 4.4, 0, Math.PI * 2);
      mapCtx.fill();
      mapCtx.strokeStyle = 'rgba(255,255,255,0.5)';
      mapCtx.lineWidth = 1;
      mapCtx.stroke();
    }

    // Pedestrian hint dots, only the ones really close: the map must stay legible.
    for (const ped of ctx.pedestrians?.list ?? []) {
      if (dist2D(ped.x, ped.z, centreX, centreZ) > 46) continue;
      const cx = p.x(ped.x);
      const cy = p.y(ped.z);
      if (cx < 0 || cx > mapSize || cy < 0 || cy > mapSize) continue;
      mapCtx.fillStyle = 'rgba(255, 240, 214, 0.28)';
      mapCtx.beginPath();
      mapCtx.arc(cx, cy, 1.7, 0, Math.PI * 2);
      mapCtx.fill();
    }

    // Mission markers: a pulsing ring, clamped to the map edge when far away.
    const markerList = missions?.markers ?? [];
    for (const marker of markerList) {
      let mx = p.x(marker.x);
      let my = p.y(marker.z);
      const edge = 14;
      const inside = mx >= edge && mx <= mapSize - edge && my >= edge && my <= mapSize - edge;
      mx = clamp(mx, edge, mapSize - edge);
      my = clamp(my, edge, mapSize - edge);
      const color = marker.kind === 'pickup' ? '#7fe3c6' : marker.kind === 'escape' ? '#ff8a72' : '#ffd166';
      const pulse = 1 + Math.sin(clock * 4) * 0.16;

      mapCtx.strokeStyle = color;
      mapCtx.lineWidth = 2.6;
      mapCtx.beginPath();
      mapCtx.arc(mx, my, 8 * pulse, 0, Math.PI * 2);
      mapCtx.stroke();

      mapCtx.fillStyle = color;
      mapCtx.beginPath();
      mapCtx.arc(mx, my, 3.2, 0, Math.PI * 2);
      mapCtx.fill();

      if (!inside) {
        // An off-map chevron pointing the way.
        const angle = Math.atan2(my - half, mx - half);
        mapCtx.save();
        mapCtx.translate(mx, my);
        mapCtx.rotate(angle);
        mapCtx.beginPath();
        mapCtx.moveTo(9, 0);
        mapCtx.lineTo(-3, 5);
        mapCtx.lineTo(-3, -5);
        mapCtx.closePath();
        mapCtx.fill();
        mapCtx.restore();
      }
    }

    // Player arrow at the centre, pointing along the heading (0 = +Z = down).
    const heading = player.onFoot ? player.heading ?? 0 : player.car?.heading ?? 0;
    mapCtx.save();
    mapCtx.translate(half, half);
    mapCtx.rotate(-heading + Math.PI);
    mapCtx.fillStyle = '#fff6e2';
    mapCtx.strokeStyle = 'rgba(20, 28, 38, 0.9)';
    mapCtx.lineWidth = 2;
    mapCtx.beginPath();
    mapCtx.moveTo(0, -11);
    mapCtx.lineTo(8, 8);
    mapCtx.lineTo(0, 4);
    mapCtx.lineTo(-8, 8);
    mapCtx.closePath();
    mapCtx.fill();
    mapCtx.stroke();
    mapCtx.restore();

    // Vignette so the map sits inside its panel.
    const gradient = mapCtx.createRadialGradient(half, half, mapSize * 0.28, half, half, mapSize * 0.62);
    gradient.addColorStop(0, 'rgba(0,0,0,0)');
    gradient.addColorStop(1, 'rgba(6,10,16,0.5)');
    mapCtx.fillStyle = gradient;
    mapCtx.fillRect(0, 0, mapSize, mapSize);

    mapCtx.restore();
  }

  if (el.district) el.district.textContent = districtName;
  ctx.hud = hud;
  return hud;
}
