// Bind the browser HUD and draw a compact, throttled Solmar Bay minimap.
import { CITY } from './config.js';

export function createHud(ctx) {
  const byId = (id) => document.getElementById(id);
  const elements = {
    root: byId('hud'), cash: byId('cash'), respect: byId('respect'), condition: byId('condition-fill'),
    wanted: byId('wanted'), objective: byId('objective-text'), objectiveLabel: byId('objective-label'),
    toast: byId('toast'), minimap: byId('minimap'), location: document.querySelector('.location small'),
  };
  const canvas = elements.minimap;
  const paint = canvas?.getContext('2d');
  let toastUntil = 0;
  let redrawIn = 0;
  let current = {};
  let lastRoads = null;

  function toast(text, duration = 2400) {
    if (!elements.toast) return;
    elements.toast.textContent = text;
    elements.toast.classList.add('show');
    toastUntil = performance.now() + duration;
  }

  function setVisible(visible) {
    if (elements.root) elements.root.hidden = !visible;
  }

  function drawMinimap(state) {
    if (!paint || !canvas) return;
    const width = canvas.width;
    const height = canvas.height;
    const scale = Math.min(width / (CITY.worldMaxX - CITY.worldMinX), height / (CITY.coastZ - CITY.worldMinZ));
    const mapWidth = (CITY.worldMaxX - CITY.worldMinX) * scale;
    const mapHeight = (CITY.coastZ - CITY.worldMinZ) * scale;
    const ox = (width - mapWidth) / 2;
    const oy = (height - mapHeight) / 2;
    const point = (p) => ({ x: ox + (p.x - CITY.worldMinX) * scale, y: oy + (CITY.coastZ - p.z) * scale });
    paint.clearRect(0, 0, width, height);
    paint.fillStyle = '#1d7886';
    paint.fillRect(0, 0, width, height);
    paint.fillStyle = '#344b4b';
    paint.fillRect(ox, oy, mapWidth, mapHeight);
    paint.fillStyle = '#bcae88';
    paint.fillRect(ox, oy + mapHeight * 0.94, mapWidth, mapHeight * 0.06);
    const roads = state.roads ?? lastRoads ?? [];
    lastRoads = roads;
    paint.lineCap = 'butt';
    for (const road of roads) {
      paint.strokeStyle = '#727d78';
      paint.lineWidth = Math.max(2, road.width * scale);
      paint.beginPath();
      if (road.axis === 'z') {
        const x = point({ x: road.coordinate, z: 0 }).x;
        paint.moveTo(x, point({ x: 0, z: road.start }).y);
        paint.lineTo(x, point({ x: 0, z: road.end }).y);
      } else {
        const y = point({ x: 0, z: road.coordinate }).y;
        paint.moveTo(point({ x: road.start, z: 0 }).x, y);
        paint.lineTo(point({ x: road.end, z: 0 }).x, y);
      }
      paint.stroke();
    }
    const markerColors = { pickup: '#ffd27a', delivery: '#68f1ce', drop: '#f07bb1', escape: '#ff765f' };
    for (const marker of state.markers ?? []) {
      const p = point(marker);
      paint.fillStyle = markerColors[marker.type] ?? '#fff';
      paint.beginPath();
      paint.arc(p.x, p.y, marker.type === 'escape' ? 6 : 5, 0, Math.PI * 2);
      paint.fill();
      paint.strokeStyle = '#142b31'; paint.lineWidth = 2; paint.stroke();
    }
    for (const car of state.traffic ?? []) {
      if (!car.position) continue;
      const p = point(car.position);
      paint.fillStyle = '#e5c77e'; paint.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    for (const unit of state.police ?? []) {
      const position = unit.car?.position ?? unit.position;
      if (!position) continue;
      const p = point(position);
      paint.fillStyle = '#72d6ff'; paint.beginPath(); paint.arc(p.x, p.y, 3, 0, Math.PI * 2); paint.fill();
    }
    const actor = state.player;
    if (actor?.position) {
      const p = point(actor.position);
      paint.save();
      paint.translate(p.x, p.y);
      paint.rotate(actor.heading ?? 0);
      paint.fillStyle = '#fff6d5';
      paint.beginPath(); paint.moveTo(0, -8); paint.lineTo(5.2, 5); paint.lineTo(0, 2.6); paint.lineTo(-5.2, 5); paint.closePath(); paint.fill();
      paint.restore();
    }
    paint.strokeStyle = 'rgba(217,239,220,.4)'; paint.lineWidth = 1;
    paint.strokeRect(ox + .5, oy + .5, mapWidth - 1, mapHeight - 1);
  }

  function update(state = {}, dt = 0) {
    current = state;
    if (elements.cash) elements.cash.textContent = Math.max(0, Math.floor(state.cash ?? 0)).toLocaleString('en-US');
    if (elements.respect) elements.respect.textContent = `RESPECT ${Math.max(0, Math.floor(state.respect ?? 0))}`;
    if (elements.condition) elements.condition.style.width = `${Math.max(0, Math.min(100, state.condition ?? 100))}%`;
    if (elements.wanted) {
      const stars = Math.max(0, Math.min(5, Math.ceil(state.wanted ?? 0)));
      elements.wanted.setAttribute('aria-label', `Wanted level ${stars} of 5`);
      elements.wanted.innerHTML = Array.from({ length: 5 }, (_, index) => `<span class="${index < stars ? 'active' : ''}">★</span>`).join('');
    }
    if (elements.objective) elements.objective.textContent = state.objective ?? 'Find your next lead';
    if (elements.objectiveLabel) elements.objectiveLabel.textContent = state.sideJob ? 'Courier side run' : state.storyComplete ? 'Story complete' : 'Current job';
    if (elements.location) elements.location.textContent = state.location ?? 'SOLMAR BAY';
    redrawIn -= Math.max(0, dt);
    if (redrawIn <= 0) { drawMinimap(state); redrawIn = 0.12; }
    if (toastUntil && performance.now() >= toastUntil) {
      elements.toast?.classList.remove('show');
      toastUntil = 0;
    }
  }

  return { update, toast, setVisible, drawMinimap, get current() { return current; } };
}
