// city.js — builds Solmar Bay: the road grid, blocks and buildings, street
// furniture, park, plaza, beach, harbour quay, pier and lighthouse.
//
// buildCity(ctx) returns the city object and registers itself on ctx:
//   ctx.city = city
//   ctx.colliders.push(...)  // { minX, maxX, minZ, maxZ, height, kind }
//
// city = {
//   root, network, blocks, colliders, buildings, parkingSpots, sidewalkPaths,
//   landmarks: { park, plaza, pier, lighthouse, escape, spawn },
//   sun, hemi, water, update(dt, time, focus), groundHeightAt(x,z), isWater(x,z)
// }
//
// network = {
//   xs, zs, halfX, halfZ, roadWidth, laneOffset,
//   nodes: (ix, iz) -> { x, z },
//   nodeCount: { x, z },
//   neighbors(ix, iz) -> [{ ix, iz, dx, dz, heading }],
//   randomNode(rng),
//   nearestNodeIndex(x, z) -> { ix, iz },
//   segment(a, b) -> { x, z, heading, laneX, laneZ },   // lane-correct entry for traffic
//   headingTo(dx, dz) -> heading in radians,
//   isOnRoad(x, z) -> boolean
// }
//
// Traffic/police drive the network; HUD draws it on the minimap.

import * as THREE from 'three';
import { CITY, COLORS, FACADES, GAME } from './config.js';
import {
  mulberry32,
  rand,
  randInt,
  pick,
  chance,
  clamp,
  lerp,
  dist2D,
  rectFromCenter,
  pointInRect,
  TAU,
} from './util.js';

const MODULE_W = 6; // world units per facade texture tile horizontally
const MODULE_H = 3.6; // per tile vertically

export function buildCity(ctx) {
  const scene = ctx.scene;
  const rng = mulberry32(CITY.seed);
  const root = new THREE.Group();
  root.name = 'SolmarBay';
  scene.add(root);

  const colliders = ctx.colliders ?? (ctx.colliders = []);
  const network = createRoadNetwork();
  const blocks = [];
  const buildings = [];
  const parkingSpots = [];

  // ------------------------------------------------------------- atmosphere
  const sky = createSky();
  root.add(sky);

  const hemi = new THREE.HemisphereLight(0xbfe4ff, 0xd9b483, 0.85);
  scene.add(hemi);

  const ambient = new THREE.AmbientLight(0xffe9cf, 0.35);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(COLORS.sun, 2.1);
  sun.position.set(-120, 190, 130);
  sun.castShadow = true;
  sun.shadow.mapSize.set(GAME.shadowMapSize, GAME.shadowMapSize);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 460;
  sun.shadow.camera.left = -GAME.shadowRange;
  sun.shadow.camera.right = GAME.shadowRange;
  sun.shadow.camera.top = GAME.shadowRange;
  sun.shadow.camera.bottom = -GAME.shadowRange;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target);

  scene.fog = new THREE.Fog(COLORS.fog, GAME.fogNear, GAME.fogFar);

  // ------------------------------------------------------------ ground plane
  root.add(createLandmass(rng));
  root.add(createRoadSurface(network, rng));

  // ------------------------------------------------------------ the blocks
  const textures = createFacadeTextures(rng);
  const slabGeo = new THREE.BoxGeometry(CITY.block, CITY.curbHeight, CITY.block);
  const sidewalkMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 });
  const sidewalkTex = createPavingTexture(0xd9cfbb);
  sidewalkMat.map = sidewalkTex;
  sidewalkMat.map.wrapS = sidewalkMat.map.wrapT = THREE.RepeatWrapping;
  sidewalkMat.map.repeat.set(6, 6);

  const palmPositions = [];
  const lampPositions = [];
  const benchPositions = [];
  const treePositions = [];
  const hedgeBoxes = [];

  for (let iz = 0; iz < CITY.gridZ; iz += 1) {
    for (let ix = 0; ix < CITY.gridX; ix += 1) {
      const centre = network.nodes(ix, iz).blockCentre;
      const rect = rectFromCenter(centre.x, centre.z, CITY.block, CITY.block);
      const kind = blockKind(ix, iz);
      blocks.push({ ...rect, ix, iz, kind });

      const slab = new THREE.Mesh(slabGeo, slabMaterialFor(kind, sidewalkMat, rng));
      slab.position.set(centre.x, CITY.curbHeight / 2, centre.z);
      slab.receiveShadow = true;
      root.add(slab);

      if (kind === 'park') {
        addPark({ root, rng, centre, rect, palmPositions, treePositions, benchPositions, hedgeBoxes });
      } else if (kind === 'plaza') {
        addPlaza({ root, rng, centre, palmPositions, treePositions, benchPositions });
      } else {
        addCityBlock({
          root,
          rng,
          centre,
          rect,
          ix,
          iz,
          kind,
          textures,
          buildings,
          colliders,
          palmPositions,
          lampPositions,
          benchPositions,
        });
      }

      // Parking bays along the block's road edges.
      addParkingSpots(parkingSpots, rect);
      // Streetlights on two corners, palms on the other two.
      addCornerFurniture(rect, rng, lampPositions, palmPositions, benchPositions, kind);
    }
  }

  // Intersection streetlights, so the grid reads as a lit city at a glance.
  for (let iz = 0; iz < network.nodeCount.z; iz += 1) {
    for (let ix = 0; ix < network.nodeCount.x; ix += 1) {
      if ((ix + iz) % 2 !== 0) continue;
      const node = network.nodes(ix, iz);
      const s = 9.4;
      lampPositions.push({ x: node.x + s, z: node.z + s, rot: Math.PI * 0.25 });
    }
  }

  // --------------------------------------------------------------- scenery
  addInstancedPalms(root, palmPositions);
  addInstancedLamps(root, lampPositions);
  addInstancedBenches(root, benchPositions);
  addInstancedTrees(root, treePositions);
  addHedges(root, hedgeBoxes);

  const waterfront = addWaterfront(root, rng, palmPositions);
  const water = createWater(root, rng);

  // Wire everything into the returned object.
  const city = {
    root,
    network,
    blocks,
    colliders,
    buildings,
    parkingSpots,
    sidewalkPaths: blocks.map((b) => ({
      minX: b.minX + CITY.sidewalk,
      maxX: b.maxX - CITY.sidewalk,
      minZ: b.minZ + CITY.sidewalk,
      maxZ: b.maxZ - CITY.sidewalk,
      cx: (b.minX + b.maxX) / 2,
      cz: (b.minZ + b.maxZ) / 2,
      kind: b.kind,
    })),
    landmarks: {
      park: { x: network.nodes(CITY.parkBlock.cx, CITY.parkBlock.cz).blockCentre.x, z: network.nodes(CITY.parkBlock.cx, CITY.parkBlock.cz).blockCentre.z },
      plaza: { x: network.nodes(CITY.plazaBlock.cx, CITY.plazaBlock.cz).blockCentre.x, z: network.nodes(CITY.plazaBlock.cx, CITY.plazaBlock.cz).blockCentre.z },
      pier: { x: CITY.pier.endX - 10, z: CITY.pier.z },
      lighthouse: { x: CITY.lighthouse.x, z: CITY.lighthouse.z },
      escape: { x: CITY.pier.endX - 12, z: CITY.pier.z },
      spawn: { x: CITY.playerStart.x, z: CITY.playerStart.z, heading: CITY.playerStart.heading },
      quay: { x: (CITY.quayStartX + CITY.quayEndX) / 2, z: 0 },
    },
    sun,
    hemi,
    water,
    groundHeightAt(x, z) {
      if (waterfront.isOnPier(x, z)) return waterfront.pierHeight;
      if (x > CITY.quayStartX && x < CITY.quayEndX && Math.abs(z) < CITY.halfZ) return CITY.quayHeight;
      if (x > CITY.quayStartX && Math.abs(z) < CITY.halfZ) return 0.02;
      for (const b of blocks) if (pointInRect(x, z, b)) return CITY.curbHeight;
      return 0;
    },
    isWater(x, z) {
      return x > CITY.waterEdgeX && !waterfront.isOnPier(x, z);
    },
    onPier(x, z) {
      return waterfront.isOnPier(x, z);
    },
    update(dt, time, focus) {
      updateWater(water, time);
      updateSky(sky, time);
      if (focus) {
        sun.position.set(focus.x - 90, 180, focus.z + 110);
        sun.target.position.set(focus.x, 0, focus.z);
        sun.target.updateMatrixWorld();
      }
    },
  };

  ctx.city = city;
  return city;
}

// ---------------------------------------------------------------- road grid

function createRoadNetwork() {
  const xs = [];
  const zs = [];
  for (let i = 0; i < CITY.gridX + 1; i += 1) {
    xs.push(-CITY.halfX + CITY.road / 2 + i * (CITY.block + CITY.road));
    zs.push(-CITY.halfZ + CITY.road / 2 + i * (CITY.block + CITY.road));
  }

  const nodes = (ix, iz) => {
    const x = xs[clamp(ix, 0, xs.length - 1)];
    const z = zs[clamp(iz, 0, zs.length - 1)];
    // Block (ix, iz) sits between roads ix..ix+1 and iz..iz+1.
    const bx = ix < xs.length - 1 ? (xs[ix] + xs[ix + 1]) / 2 : x;
    const bz = iz < zs.length - 1 ? (zs[iz] + zs[iz + 1]) / 2 : z;
    return { x, z, ix, iz, blockCentre: { x: bx, z: bz } };
  };

  const neighbours = (ix, iz) => {
    const out = [];
    if (ix > 0) out.push({ ix: ix - 1, iz, dx: -1, dz: 0, heading: -Math.PI / 2 });
    if (ix < xs.length - 1) out.push({ ix: ix + 1, iz, dx: 1, dz: 0, heading: Math.PI / 2 });
    if (iz > 0) out.push({ ix, iz: iz - 1, dx: 0, dz: -1, heading: Math.PI });
    if (iz < zs.length - 1) out.push({ ix, iz: iz + 1, dx: 0, dz: 1, heading: 0 });
    return out;
  };

  const headingTo = (dx, dz) => {
    if (dx > 0) return Math.PI / 2;
    if (dx < 0) return -Math.PI / 2;
    if (dz < 0) return Math.PI;
    return 0;
  };

  // Entry point of the lane that runs from node a to node b.
  function segment(a, b) {
    const from = nodes(a.ix, a.iz);
    const to = nodes(b.ix, b.iz);
    const dx = Math.sign(to.x - from.x);
    const dz = Math.sign(to.z - from.z);
    const heading = headingTo(dx, dz);
    let x = from.x;
    let z = from.z;
    if (dx !== 0) z += dx * CITY.laneOffset; // eastbound keeps to +Z
    else x -= dz * CITY.laneOffset; // southbound keeps to -X
    // Same offset at the far end, so a straight segment stays on one lane.
    let ex = to.x;
    let ez = to.z;
    if (dx !== 0) ez += dx * CITY.laneOffset;
    else ex -= dz * CITY.laneOffset;
    return { x, z, ex, ez, heading, dx, dz };
  }

  function isOnRoad(x, z) {
    for (const rx of xs) if (Math.abs(x - rx) <= CITY.road / 2) return true;
    for (const rz of zs) if (Math.abs(z - rz) <= CITY.road / 2) return true;
    return false;
  }

  function nearestNodeIndex(x, z) {
    let bi = 0;
    let bj = 0;
    let best = Infinity;
    for (let i = 0; i < xs.length; i += 1) {
      for (let j = 0; j < zs.length; j += 1) {
        const d = (xs[i] - x) ** 2 + (zs[j] - z) ** 2;
        if (d < best) {
          best = d;
          bi = i;
          bj = j;
        }
      }
    }
    return { ix: bi, iz: bj };
  }

  function randomNode(rng) {
    return { ix: randInt(rng, 0, xs.length - 1), iz: randInt(rng, 0, zs.length - 1) };
  }

  return {
    xs,
    zs,
    halfX: CITY.halfX,
    halfZ: CITY.halfZ,
    roadWidth: CITY.road,
    laneOffset: CITY.laneOffset,
    nodes,
    nodeCount: { x: xs.length, z: zs.length },
    neighbours,
    segment,
    headingTo,
    isOnRoad,
    nearestNodeIndex,
    randomNode,
  };
}

export { createRoadNetwork };

// ------------------------------------------------------------- block types

function blockKind(ix, iz) {
  if (ix === CITY.parkBlock.cx && iz === CITY.parkBlock.cz) return 'park';
  if (ix === CITY.plazaBlock.cx && iz === CITY.plazaBlock.cz) return 'plaza';
  if (ix === CITY.gridX - 1 && iz % 2 === 0) return 'waterfront';
  if (ix === 0 && iz === CITY.gridZ - 1) return 'warehouse';
  return 'city';
}

function slabMaterialFor(kind, sidewalkMat, rng) {
  if (kind === 'park') return new THREE.MeshStandardMaterial({ color: COLORS.grass, roughness: 1 });
  if (kind === 'plaza') return new THREE.MeshStandardMaterial({ color: 0xd8cdb6, roughness: 0.9 });
  if (kind === 'warehouse') return new THREE.MeshStandardMaterial({ color: 0xb0a795, roughness: 0.95 });
  return sidewalkMat;
}

// ------------------------------------------------------------ city buildings

function addCityBlock(opts) {
  const { root, rng, centre, rect, kind, textures, buildings, colliders, palmPositions, lampPositions, benchPositions } = opts;
  const inner = CITY.block - CITY.sidewalk * 2; // 54
  const pad = 2.4;
  const layout = chance(rng, 0.34) ? 'single' : chance(rng, 0.6) ? 'split' : 'quad';

  const cells = [];
  const minX = rect.minX + CITY.sidewalk;
  const maxX = rect.maxX - CITY.sidewalk;
  const minZ = rect.minZ + CITY.sidewalk;
  const maxZ = rect.maxZ - CITY.sidewalk;

  if (layout === 'single') {
    cells.push({ minX, maxX, minZ, maxZ });
  } else if (layout === 'split') {
    if (chance(rng, 0.5)) {
      const mid = (minX + maxX) / 2;
      cells.push({ minX, maxX: mid, minZ, maxZ }, { minX: mid, maxX, minZ, maxZ });
    } else {
      const mid = (minZ + maxZ) / 2;
      cells.push({ minX, maxX, minZ, maxZ: mid }, { minX, maxX, minZ: mid, maxZ });
    }
  } else {
    const mx = (minX + maxX) / 2;
    const mz = (minZ + maxZ) / 2;
    cells.push(
      { minX, maxX: mx, minZ, maxZ: mz },
      { minX: mx, maxX, minZ, maxZ: mz },
      { minX, maxX: mx, minZ: mz, maxZ },
      { minX: mx, maxX, minZ: mz, maxZ },
    );
  }

  for (const cell of cells) {
    if (chance(rng, 0.12)) continue; // a gap / small yard
    const cw = cell.maxX - cell.minX - pad * 2;
    const cd = cell.maxZ - cell.minZ - pad * 2;
    if (cw < 8 || cd < 8) continue;
    const w = Math.min(cw, rand(rng, cw * 0.62, cw));
    const d = Math.min(cd, rand(rng, cd * 0.62, cd));
    const cx = rand(rng, cell.minX + pad + w / 2, cell.maxX - pad - w / 2);
    const cz = rand(rng, cell.minZ + pad + d / 2, cell.maxZ - pad - d / 2);
    const tall = kind === 'city' && dist2D(cx, cz, centre.x, centre.z) < 70;
    const height = tall ? rand(rng, 16, 46) : rand(rng, 7, 20);
    buildings.push(makeBuilding({ root, rng, cx, cz, w, d, height, textures, kind, colliders }));
  }

  // Awnings and a couple of shop signs facing the street for low blocks.
  if (kind === 'waterfront' || kind === 'warehouse') {
    palmPositions.push({ x: minX + 2.4, z: minZ + 2.4, scale: rand(rng, 0.9, 1.2) });
    palmPositions.push({ x: maxX - 2.4, z: maxZ - 2.4, scale: rand(rng, 0.9, 1.2) });
  }

  // Parked-car safety: a hydrant, a bench and a bin on the sidewalk.
  benchPositions.push({
    x: minX + inner * 0.5,
    z: rect.minZ + CITY.sidewalk * 0.5,
    rot: 0,
  });
  lampPositions.push({ x: minX + 1, z: maxZ - 1, rot: 0 });
}

function makeBuilding({ root, rng, cx, cz, w, d, height, textures, kind, colliders }) {
  const facade = pick(rng, FACADES);
  const tex = textures.get(facade.base);
  const geo = boxWithTiledUV(w, height, d);
  const mat = new THREE.MeshStandardMaterial({
    map: tex.map,
    emissiveMap: tex.emissive,
    emissive: new THREE.Color(0xffcf87),
    emissiveIntensity: 0.55,
    roughness: 0.82,
    metalness: 0.04,
  });
  const roofMat = new THREE.MeshStandardMaterial({ color: COLORS.roof, roughness: 0.95 });
  const mesh = new THREE.Mesh(geo, [mat, mat, roofMat, roofMat, mat, mat]);
  mesh.position.set(cx, CITY.curbHeight + height / 2, cz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  root.add(mesh);

  colliders.push({
    minX: cx - w / 2,
    maxX: cx + w / 2,
    minZ: cz - d / 2,
    maxZ: cz + d / 2,
    height,
    kind: 'building',
  });

  // Setback tower on tall buildings: a thin upper shaft plus a roof detail.
  if (height > 26 && chance(rng, 0.55)) {
    const sw = w * rand(rng, 0.4, 0.6);
    const sd = d * rand(rng, 0.4, 0.6);
    const sh = rand(rng, 6, 16);
    const upper = new THREE.Mesh(boxWithTiledUV(sw, sh, sd), [mat, mat, roofMat, roofMat, mat, mat]);
    upper.position.set(cx, CITY.curbHeight + height + sh / 2, cz);
    upper.castShadow = true;
    root.add(upper);
    colliders.push({
      minX: cx - sw / 2,
      maxX: cx + sw / 2,
      minZ: cz - sd / 2,
      maxZ: cz + sd / 2,
      height: height + sh,
      kind: 'building',
    });
    if (chance(rng, 0.6)) addAntenna(root, rng, cx, CITY.curbHeight + height + sh, cz, rand(rng, 4, 12));
    else addWaterTank(root, cx + rand(rng, -sw * 0.25, sw * 0.25), CITY.curbHeight + height + sh, cz + rand(rng, -sd * 0.25, sd * 0.25), rng);
  } else {
    if (chance(rng, 0.28)) addAntenna(root, rng, cx, CITY.curbHeight + height, cz, rand(rng, 2.5, 7));
    else if (chance(rng, 0.4)) addWaterTank(root, cx + rand(rng, -w * 0.25, w * 0.25), CITY.curbHeight + height, cz + rand(rng, -d * 0.25, d * 0.25), rng);
  }

  // A warm emissive shop sign on some street-level facades.
  if (height < 22 && chance(rng, 0.4)) {
    const signColor = pick(rng, [0xff9a5c, 0xffd166, 0x7fd6c1, 0xff7d9a, 0xa9c8ff]);
    const signMat = new THREE.MeshStandardMaterial({
      color: signColor,
      emissive: new THREE.Color(signColor),
      emissiveIntensity: 1.1,
      roughness: 0.5,
    });
    const sign = new THREE.Mesh(new THREE.BoxGeometry(w * 0.62, 0.9, 0.16), signMat);
    sign.position.set(cx, CITY.curbHeight + 4.2, cz + d / 2 + 0.1);
    root.add(sign);
  }

  return { cx, cz, w, d, height, kind };
}

// A BoxGeometry whose side-face UVs tile a facade texture once per module.
function boxWithTiledUV(w, h, d) {
  const geo = new THREE.BoxGeometry(w, h, d);
  const uv = geo.attributes.uv;
  const uW = w / MODULE_W;
  const uD = d / MODULE_W;
  const vH = h / (MODULE_H * 3);
  for (let i = 0; i < uv.count; i += 1) {
    const face = Math.floor(i / 4);
    let su;
    let sv;
    if (face === 0 || face === 1) {
      su = uD;
      sv = vH;
    } else if (face === 2 || face === 3) {
      su = uW;
      sv = uD;
    } else {
      su = uW;
      sv = vH;
    }
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  uv.needsUpdate = true;
  return geo;
}

function addAntenna(root, rng, x, y, z, height) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x8d8a83, roughness: 0.8 });
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, height, 5), mat);
  mast.position.set(x, y + height / 2, z);
  mast.castShadow = true;
  root.add(mast);
  if (chance(rng, 0.6)) {
    const lightMat = new THREE.MeshStandardMaterial({ color: 0xff5a4a, emissive: 0xff3b30, emissiveIntensity: 1.4 });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.22, 6, 5), lightMat);
    bulb.position.set(x, y + height + 0.15, z);
    root.add(bulb);
  }
}

function addWaterTank(root, x, y, z, rng) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x9a8b74, roughness: 0.9 });
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.3, 2.2, 9), mat);
  tank.position.set(x, y + 1.1, z);
  tank.castShadow = true;
  root.add(tank);
  const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.6, 4), mat);
  legs.position.set(x, y - 0.4, z);
  root.add(legs);
}

// ------------------------------------------------------------------- park

function addPark({ root, rng, centre, rect, palmPositions, treePositions, benchPositions, hedgeBoxes }) {
  const pathMat = new THREE.MeshStandardMaterial({ color: 0xcbbf9f, roughness: 0.95 });
  const half = CITY.block / 2 - CITY.sidewalk;

  // Criss-cross paths.
  const px = new THREE.Mesh(new THREE.BoxGeometry(CITY.block - CITY.sidewalk * 2, 0.12, 5), pathMat);
  px.position.set(centre.x, CITY.curbHeight + 0.06, centre.z);
  px.receiveShadow = true;
  root.add(px);
  const pz = new THREE.Mesh(new THREE.BoxGeometry(5, 0.12, CITY.block - CITY.sidewalk * 2), pathMat);
  pz.position.set(centre.x, CITY.curbHeight + 0.06, centre.z);
  pz.receiveShadow = true;
  root.add(pz);

  // A round pond in one quadrant.
  const pondMat = new THREE.MeshStandardMaterial({ color: 0x2f8f9e, roughness: 0.25, metalness: 0.1 });
  const pond = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 0.3, 20), pondMat);
  pond.position.set(centre.x - half * 0.45, CITY.curbHeight + 0.03, centre.z + half * 0.45);
  root.add(pond);
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(9.1, 0.35, 6, 22),
    new THREE.MeshStandardMaterial({ color: 0xbdb29b, roughness: 0.9 }),
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.copy(pond.position).setY(CITY.curbHeight + 0.2);
  root.add(rim);

  // Trees in loose rows, kept off the paths.
  for (let i = 0; i < 22; i += 1) {
    const x = centre.x + rand(rng, -half * 0.92, half * 0.92);
    const z = centre.z + rand(rng, -half * 0.92, half * 0.92);
    if (Math.abs(x - centre.x) < 4 || Math.abs(z - centre.z) < 4) continue;
    if (dist2D(x, z, pond.position.x, pond.position.z) < 11) continue;
    treePositions.push({ x, z, scale: rand(rng, 0.8, 1.35), rot: rand(rng, 0, TAU) });
  }
  for (let i = 0; i < 6; i += 1) {
    benchPositions.push({
      x: centre.x + rand(rng, -half * 0.8, half * 0.8),
      z: centre.z + rand(rng, -half * 0.8, half * 0.8),
      rot: rand(rng, 0, TAU),
    });
  }
  for (let i = 0; i < 8; i += 1) {
    palmPositions.push({
      x: rect.minX + rand(rng, 3, 8),
      z: rect.minZ + rand(rng, 3, CITY.block - 3),
      scale: rand(rng, 0.9, 1.2),
    });
  }
  hedgeBoxes.push({ x: centre.x, z: rect.minZ + CITY.sidewalk + 0.9, w: CITY.block - CITY.sidewalk * 2, d: 1.2, h: 0.9 });
}

// ------------------------------------------------------------------ plaza

function addPlaza({ root, rng, centre, palmPositions, treePositions, benchPositions }) {
  const paving = new THREE.MeshStandardMaterial({ color: 0xe4d8bf, roughness: 0.88 });
  const half = CITY.block / 2 - CITY.sidewalk;

  // Fountain: basin, inner plinth, water disc and a warm jet.
  const basinMat = new THREE.MeshStandardMaterial({ color: 0xd6c7a8, roughness: 0.85 });
  const basin = new THREE.Mesh(new THREE.CylinderGeometry(6.4, 6.8, 1.0, 24), basinMat);
  basin.position.set(centre.x, CITY.curbHeight + 0.5, centre.z);
  basin.castShadow = true;
  basin.receiveShadow = true;
  root.add(basin);

  const waterMat = new THREE.MeshStandardMaterial({ color: 0x57b6c4, roughness: 0.15, metalness: 0.2 });
  const pool = new THREE.Mesh(new THREE.CylinderGeometry(5.9, 5.9, 0.14, 24), waterMat);
  pool.position.set(centre.x, CITY.curbHeight + 0.98, centre.z);
  root.add(pool);

  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.7, 2.2, 12), basinMat);
  plinth.position.set(centre.x, CITY.curbHeight + 1.9, centre.z);
  plinth.castShadow = true;
  root.add(plinth);

  const jetMat = new THREE.MeshStandardMaterial({
    color: 0xcdeef5,
    emissive: 0x7fd6e8,
    emissiveIntensity: 0.4,
    transparent: true,
    opacity: 0.75,
    roughness: 0.2,
  });
  const jet = new THREE.Mesh(new THREE.ConeGeometry(0.7, 3.4, 9, 1, true), jetMat);
  jet.position.set(centre.x, CITY.curbHeight + 4.4, centre.z);
  root.add(jet);

  // Palms and benches framing the square.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      palmPositions.push({ x: centre.x + sx * half * 0.7, z: centre.z + sz * half * 0.7, scale: rand(rng, 1.0, 1.3) });
      benchPositions.push({ x: centre.x + sx * half * 0.55, z: centre.z + sz * half * 0.28, rot: rand(rng, 0, TAU) });
    }
  }
  for (let i = 0; i < 4; i += 1) {
    treePositions.push({
      x: centre.x + rand(rng, -half * 0.9, half * 0.9),
      z: centre.z + rand(rng, -half * 0.9, half * 0.9),
      scale: rand(rng, 0.7, 1.0),
      rot: rand(rng, 0, TAU),
    });
  }
}

// ------------------------------------------------------- parking & furniture

function addParkingSpots(spots, rect) {
  // Both long edges of every block, facing along the street.
  const zEdges = [rect.minZ - CITY.road / 2, rect.maxZ + CITY.road / 2];
  for (const edgeZ of zEdges) {
    for (let x = rect.minX + 10; x < rect.maxX - 10; x += 7.4) {
      const northSide = edgeZ < rect.minZ; // kerb north of the block
      spots.push({
        x,
        z: edgeZ + (northSide ? -CITY.parkingOffset : CITY.parkingOffset),
        heading: northSide ? 0 : Math.PI,
      });
    }
  }
  const xEdges = [rect.minX - CITY.road / 2, rect.maxX + CITY.road / 2];
  for (const edgeX of xEdges) {
    for (let z = rect.minZ + 10; z < rect.maxZ - 10; z += 7.4) {
      const westSide = edgeX < rect.minX;
      spots.push({
        x: edgeX + (westSide ? -CITY.parkingOffset : CITY.parkingOffset),
        z,
        heading: westSide ? Math.PI / 2 : -Math.PI / 2,
      });
    }
  }
}

function addCornerFurniture(rect, rng, lamps, palms, benches, kind) {
  const inset = CITY.sidewalk * 0.55;
  const corners = [
    { x: rect.minX + inset, z: rect.minZ + inset },
    { x: rect.maxX - inset, z: rect.minZ + inset },
    { x: rect.minX + inset, z: rect.maxZ - inset },
    { x: rect.maxX - inset, z: rect.maxZ - inset },
  ];
  for (let i = 0; i < corners.length; i += 1) {
    const c = corners[i];
    if (kind === 'plaza' || kind === 'park') {
      if (i % 2 === 0) palms.push({ x: c.x, z: c.z, scale: rand(rng, 0.95, 1.3) });
      else lamps.push({ x: c.x, z: c.z, rot: rand(rng, 0, TAU) });
      continue;
    }
    if (i % 2 === 0) lamps.push({ x: c.x, z: c.z, rot: rand(rng, 0, TAU) });
    else palms.push({ x: c.x, z: c.z, scale: rand(rng, 0.9, 1.25) });
  }
  if (chance(rng, 0.5)) {
    benches.push({ x: rect.minX + inset * 2, z: rect.maxZ - inset, rot: rand(rng, 0, TAU) });
  }
}

// ------------------------------------------------------------- instancing

function fillInstances(mesh, list, makeMatrix) {
  const dummy = new THREE.Object3D();
  for (let i = 0; i < list.length; i += 1) {
    makeMatrix(dummy, list[i], i);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.count = list.length;
  return mesh;
}

function addInstancedPalms(root, positions) {
  if (!positions.length) return;
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.32, 6.4, 7, 1);
  trunkGeo.translate(0, 3.2, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: COLORS.palmTrunk, roughness: 0.95 });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, positions.length);
  trunks.castShadow = true;
  trunks.receiveShadow = true;

  const crownGeo = makePalmCrownGeometry();
  const crownMat = new THREE.MeshStandardMaterial({
    color: COLORS.palmLeaf,
    roughness: 0.86,
    side: THREE.DoubleSide,
  });
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, positions.length);
  crowns.castShadow = true;

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  positions.forEach((p, i) => {
    const s = p.scale ?? 1;
    dummy.position.set(p.x, 0.14, p.z);
    dummy.rotation.set(0, p.rot ?? rand(mulberry32(i + 7), 0, TAU), 0);
    dummy.scale.set(s, s * rand(mulberry32(i + 3), 0.9, 1.2), s);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    dummy.position.y = 0.14 + 6.4 * s * 0.96;
    dummy.scale.set(s, s, s);
    dummy.updateMatrix();
    crowns.setMatrixAt(i, dummy.matrix);
    color.setHSL(0.26, 0.42, 0.34 + ((i * 37) % 10) * 0.008);
    crowns.setColorAt(i, color);
  });
  trunks.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
  root.add(trunks);
  root.add(crowns);
}

function makePalmCrownGeometry() {
  const blades = 9;
  const positions = [];
  const indices = [];
  const normals = [];
  for (let b = 0; b < blades; b += 1) {
    const a = (b / blades) * TAU + (b % 2) * 0.14;
    const len = 3.0 + (b % 3) * 0.45;
    const droop = 1.5 + (b % 2) * 0.5;
    const dirX = Math.sin(a);
    const dirZ = Math.cos(a);
    const perpX = Math.cos(a);
    const perpZ = -Math.sin(a);
    const base = positions.length / 3;
    const inner = 0.25;
    const midW = 0.55;
    const tipW = 0.12;
    // inner left, inner right, mid left, mid right, tip
    positions.push(dirX * inner + perpX * midW * 0.5, 0.1, dirZ * inner + perpZ * midW * 0.5);
    positions.push(dirX * inner - perpX * midW * 0.5, 0.1, dirZ * inner - perpZ * midW * 0.5);
    positions.push(dirX * len * 0.55 + perpX * midW, -droop * 0.35, dirZ * len * 0.55 + perpZ * midW);
    positions.push(dirX * len * 0.55 - perpX * midW, -droop * 0.35, dirZ * len * 0.55 - perpZ * midW);
    positions.push(dirX * len, -droop, dirZ * len);
    for (let n = 0; n < 5; n += 1) normals.push(0, 1, 0);
    indices.push(base, base + 1, base + 2);
    indices.push(base + 1, base + 3, base + 2);
    indices.push(base + 2, base + 3, base + 4);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}

function addInstancedLamps(root, positions) {
  if (!positions.length) return;
  const poleGeo = new THREE.CylinderGeometry(0.09, 0.13, 5.6, 6);
  poleGeo.translate(0, 2.8, 0);
  const poleMat = new THREE.MeshStandardMaterial({ color: COLORS.lampPost, roughness: 0.7, metalness: 0.3 });
  const poles = new THREE.InstancedMesh(poleGeo, poleMat, positions.length);
  poles.castShadow = true;

  const headGeo = new THREE.BoxGeometry(0.62, 0.2, 0.34);
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xfff2cf,
    emissive: new THREE.Color(COLORS.lampGlow),
    emissiveIntensity: 1.2,
    roughness: 0.4,
  });
  const heads = new THREE.InstancedMesh(headGeo, headMat, positions.length);

  const dummy = new THREE.Object3D();
  positions.forEach((p, i) => {
    dummy.position.set(p.x, CITY.curbHeight, p.z);
    dummy.rotation.set(0, p.rot ?? 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    poles.setMatrixAt(i, dummy.matrix);
    dummy.position.set(p.x, CITY.curbHeight + 5.6, p.z);
    dummy.rotation.set(0, p.rot ?? 0, 0);
    dummy.updateMatrix();
    heads.setMatrixAt(i, dummy.matrix);
  });
  poles.instanceMatrix.needsUpdate = true;
  heads.instanceMatrix.needsUpdate = true;
  root.add(poles);
  root.add(heads);
}

function addInstancedTrees(root, positions) {
  if (!positions.length) return;
  const trunkGeo = new THREE.CylinderGeometry(0.2, 0.32, 2.6, 6);
  trunkGeo.translate(0, 1.3, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x7a5a3c, roughness: 1 });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, positions.length);
  trunks.castShadow = true;

  const canopyGeo = new THREE.IcosahedronGeometry(2.4, 1);
  const canopyMat = new THREE.MeshStandardMaterial({ color: 0x4f9c52, roughness: 0.95, flatShading: true });
  const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, positions.length);
  canopies.castShadow = true;

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  positions.forEach((p, i) => {
    const s = p.scale ?? 1;
    dummy.position.set(p.x, CITY.curbHeight, p.z);
    dummy.rotation.set(0, p.rot ?? 0, 0);
    dummy.scale.set(s, s, s);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    dummy.position.set(p.x, CITY.curbHeight + 3.0 * s, p.z);
    dummy.scale.set(s * rand(mulberry32(i + 11), 0.85, 1.2), s * rand(mulberry32(i + 19), 0.8, 1.1), s);
    dummy.updateMatrix();
    canopies.setMatrixAt(i, dummy.matrix);
    color.setHSL(0.29, 0.38, 0.3 + ((i * 13) % 8) * 0.014);
    canopies.setColorAt(i, color);
  });
  trunks.instanceMatrix.needsUpdate = true;
  canopies.instanceMatrix.needsUpdate = true;
  if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true;
  root.add(trunks);
  root.add(canopies);
}

function addInstancedBenches(root, positions) {
  if (!positions.length) return;
  const seatGeo = new THREE.BoxGeometry(1.9, 0.16, 0.6);
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x9c6f47, roughness: 0.9 });
  const seats = new THREE.InstancedMesh(seatGeo, seatMat, positions.length);
  seats.castShadow = true;
  const backGeo = new THREE.BoxGeometry(1.9, 0.5, 0.12);
  const backs = new THREE.InstancedMesh(backGeo, seatMat, positions.length);

  const dummy = new THREE.Object3D();
  positions.forEach((p, i) => {
    dummy.position.set(p.x, CITY.curbHeight + 0.5, p.z);
    dummy.rotation.set(0, p.rot ?? 0, 0);
    dummy.updateMatrix();
    seats.setMatrixAt(i, dummy.matrix);
    dummy.position.y = CITY.curbHeight + 0.82;
    dummy.position.x += Math.sin(p.rot ?? 0) * -0.24;
    dummy.position.z += Math.cos(p.rot ?? 0) * -0.24;
    dummy.updateMatrix();
    backs.setMatrixAt(i, dummy.matrix);
  });
  seats.instanceMatrix.needsUpdate = true;
  backs.instanceMatrix.needsUpdate = true;
  root.add(seats);
  root.add(backs);
}

function addHedges(root, hedges) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x4c8b4d, roughness: 0.95 });
  for (const h of hedges) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(h.w, h.h, h.d), mat);
    mesh.position.set(h.x, CITY.curbHeight + h.h / 2, h.z);
    mesh.castShadow = true;
    root.add(mesh);
  }
}

// --------------------------------------------------------------- waterfront

function addWaterfront(root, rng, palmPositions) {
  const quayWidth = CITY.quayEndX - CITY.quayStartX;
  const quayCentreX = (CITY.quayStartX + CITY.quayEndX) / 2;

  // Promenade deck, raised above the sand.
  const quayMat = new THREE.MeshStandardMaterial({ color: 0xc9bda6, roughness: 0.9 });
  const quay = new THREE.Mesh(new THREE.BoxGeometry(quayWidth, 0.7, CITY.halfZ * 2), quayMat);
  quay.position.set(quayCentreX, 0.0, 0);
  quay.receiveShadow = true;
  root.add(quay);
  const quayTop = new THREE.Mesh(
    new THREE.BoxGeometry(quayWidth - 0.6, 0.12, CITY.halfZ * 2),
    new THREE.MeshStandardMaterial({ color: 0xdfd4bb, roughness: 0.88 }),
  );
  quayTop.position.set(quayCentreX, 0.36, 0);
  quayTop.receiveShadow = true;
  root.add(quayTop);

  // Seawall face dropping into the water on the seaward side.
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x9c9384, roughness: 0.95 });
  const wall = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.4, CITY.halfZ * 2), wallMat);
  wall.position.set(CITY.quayEndX, -0.8, 0);
  root.add(wall);

  // Railings: instanced posts plus a continuous top rail.
  const postGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.0, 5);
  postGeo.translate(0, 0.5, 0);
  const postMat = new THREE.MeshStandardMaterial({ color: 0xf0e7d6, roughness: 0.6, metalness: 0.4 });
  const postCount = Math.floor((CITY.halfZ * 2) / 4);
  const posts = new THREE.InstancedMesh(postGeo, postMat, postCount);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < postCount; i += 1) {
    dummy.position.set(CITY.quayEndX - 0.9, 0.42, -CITY.halfZ + i * 4 + 2);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    posts.setMatrixAt(i, dummy.matrix);
  }
  posts.instanceMatrix.needsUpdate = true;
  root.add(posts);
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, CITY.halfZ * 2), postMat);
  rail.position.set(CITY.quayEndX - 0.9, 1.42, 0);
  root.add(rail);

  // Sand.
  const sandTex = createSandTexture(rng);
  sandTex.wrapS = sandTex.wrapT = THREE.RepeatWrapping;
  sandTex.repeat.set(6, 40);
  const sandMat = new THREE.MeshStandardMaterial({ map: sandTex, color: 0xffffff, roughness: 1 });
  const sand = new THREE.Mesh(new THREE.PlaneGeometry(CITY.beachEndX - CITY.beachStartX, CITY.halfZ * 2 + 60, 1, 1), sandMat);
  sand.rotation.x = -Math.PI / 2;
  sand.position.set((CITY.beachStartX + CITY.beachEndX) / 2, 0.02, 0);
  sand.receiveShadow = true;
  root.add(sand);

  // Beach umbrellas + towels, all instanced.
  const umbPositions = [];
  for (let i = 0; i < 14; i += 1) {
    umbPositions.push({
      x: rand(rng, CITY.beachStartX + 12, CITY.beachEndX - 14),
      z: rand(rng, -CITY.halfZ + 10, CITY.halfZ - 10),
      hue: rand(rng, 0, 1),
    });
  }
  const poleGeo = new THREE.CylinderGeometry(0.06, 0.06, 2.2, 5);
  poleGeo.translate(0, 1.1, 0);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xf3ece0, roughness: 0.7 });
  const poles = new THREE.InstancedMesh(poleGeo, poleMat, umbPositions.length);
  const shadeGeo = new THREE.ConeGeometry(1.9, 0.9, 9, 1, true);
  const shadeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, side: THREE.DoubleSide });
  const shades = new THREE.InstancedMesh(shadeGeo, shadeMat, umbPositions.length);
  shades.castShadow = true;
  const color = new THREE.Color();
  umbPositions.forEach((p, i) => {
    dummy.position.set(p.x, 0.02, p.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    poles.setMatrixAt(i, dummy.matrix);
    dummy.position.set(p.x, 2.5, p.z);
    dummy.updateMatrix();
    shades.setMatrixAt(i, dummy.matrix);
    color.setHSL((p.hue * 0.7 + 0.02) % 1, 0.62, 0.56);
    shades.setColorAt(i, color);
  });
  poles.instanceMatrix.needsUpdate = true;
  shades.instanceMatrix.needsUpdate = true;
  if (shades.instanceColor) shades.instanceColor.needsUpdate = true;
  root.add(poles);
  root.add(shades);

  for (let i = 0; i < 10; i += 1) {
    palmPositions.push({
      x: rand(rng, CITY.beachStartX + 2, CITY.beachStartX + 6),
      z: rand(rng, -CITY.halfZ + 6, CITY.halfZ - 6),
      scale: rand(rng, 0.9, 1.25),
    });
  }

  // The pier: deck on pilings, with railings and a crane-ish end structure.
  const pierLength = CITY.pier.endX - CITY.pier.startX;
  const pierCentreX = (CITY.pier.startX + CITY.pier.endX) / 2;
  const pierHeight = 1.0;
  const deckMat = new THREE.MeshStandardMaterial({ color: 0x9a7248, roughness: 0.95 });
  const deck = new THREE.Mesh(new THREE.BoxGeometry(pierLength, 0.32, CITY.pier.width), deckMat);
  deck.position.set(pierCentreX, pierHeight, CITY.pier.z);
  deck.castShadow = true;
  deck.receiveShadow = true;
  root.add(deck);

  const pilingGeo = new THREE.CylinderGeometry(0.3, 0.34, 3.4, 6);
  pilingGeo.translate(0, -1.7, 0);
  const pilingMat = new THREE.MeshStandardMaterial({ color: 0x6d5138, roughness: 1 });
  const pilings = [];
  for (let x = CITY.pier.startX + 6; x < CITY.pier.endX; x += 8) {
    for (const side of [-1, 1]) pilings.push({ x, z: CITY.pier.z + side * (CITY.pier.width / 2 - 0.7) });
  }
  const pilingMesh = new THREE.InstancedMesh(pilingGeo, pilingMat, pilings.length);
  pilings.forEach((p, i) => {
    dummy.position.set(p.x, pierHeight - 0.2, p.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    pilingMesh.setMatrixAt(i, dummy.matrix);
  });
  pilingMesh.instanceMatrix.needsUpdate = true;
  root.add(pilingMesh);

  // Pier railings.
  const railMat = new THREE.MeshStandardMaterial({ color: 0xeadfc8, roughness: 0.7, metalness: 0.3 });
  for (const side of [-1, 1]) {
    const railBar = new THREE.Mesh(new THREE.BoxGeometry(pierLength, 0.1, 0.12), railMat);
    railBar.position.set(pierCentreX, pierHeight + 1.1, CITY.pier.z + side * (CITY.pier.width / 2 - 0.25));
    root.add(railBar);
  }
  const pierPosts = [];
  for (let x = CITY.pier.startX + 4; x < CITY.pier.endX; x += 6) {
    for (const side of [-1, 1]) pierPosts.push({ x, z: CITY.pier.z + side * (CITY.pier.width / 2 - 0.25) });
  }
  const pierPostGeo = new THREE.CylinderGeometry(0.07, 0.07, 1.1, 5);
  pierPostGeo.translate(0, 0.55, 0);
  const pierPostMesh = new THREE.InstancedMesh(pierPostGeo, railMat, pierPosts.length);
  pierPosts.forEach((p, i) => {
    dummy.position.set(p.x, pierHeight, p.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    pierPostMesh.setMatrixAt(i, dummy.matrix);
  });
  pierPostMesh.instanceMatrix.needsUpdate = true;
  root.add(pierPostMesh);

  // A small harbour shed at the pier root and a shipping bollard line.
  const shedMat = new THREE.MeshStandardMaterial({ color: 0x8e6f52, roughness: 0.95 });
  const shed = new THREE.Mesh(new THREE.BoxGeometry(10, 4.2, 8), shedMat);
  shed.position.set(CITY.pier.startX - 12, 2.1, CITY.pier.z - 12);
  shed.castShadow = true;
  root.add(shed);
  const shedRoof = new THREE.Mesh(new THREE.BoxGeometry(11.4, 0.4, 9.2), new THREE.MeshStandardMaterial({ color: 0x6f5a44, roughness: 0.9 }));
  shedRoof.position.set(shed.position.x, 4.4, shed.position.z);
  root.add(shedRoof);

  const bollardGeo = new THREE.CylinderGeometry(0.34, 0.44, 0.9, 8);
  bollardGeo.translate(0, 0.45, 0);
  const bollardMat = new THREE.MeshStandardMaterial({ color: 0x3d4248, roughness: 0.8, metalness: 0.4 });
  const bollardPositions = [];
  for (let z = -CITY.halfZ + 12; z < CITY.halfZ - 12; z += 24) {
    bollardPositions.push({ x: CITY.quayEndX - 3.2, z });
  }
  const bollards = new THREE.InstancedMesh(bollardGeo, bollardMat, bollardPositions.length);
  bollardPositions.forEach((p, i) => {
    dummy.position.set(p.x, 0.36, p.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    bollards.setMatrixAt(i, dummy.matrix);
  });
  bollards.instanceMatrix.needsUpdate = true;
  root.add(bollards);

  addLighthouse(root);

  function isOnPier(x, z) {
    return (
      x > CITY.pier.startX - 2 &&
      x < CITY.pier.endX &&
      Math.abs(z - CITY.pier.z) < CITY.pier.width / 2
    );
  }

  return { isOnPier, pierHeight: pierHeight + 0.16 };
}

function addLighthouse(root) {
  const { x, z } = CITY.lighthouse;
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x8b8274, roughness: 1 });
  const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(13, 0), rockMat);
  rock.position.set(x, -2.2, z);
  rock.scale.set(1.4, 0.5, 1.2);
  root.add(rock);

  const baseMat = new THREE.MeshStandardMaterial({ color: 0xf2ece0, roughness: 0.8 });
  const bandMat = new THREE.MeshStandardMaterial({ color: 0xc4453c, roughness: 0.8 });
  const segments = 6;
  const towerHeight = 26;
  for (let i = 0; i < segments; i += 1) {
    const t = i / segments;
    const h = towerHeight / segments;
    const rBottom = 3.4 - t * 1.3;
    const rTop = 3.4 - ((i + 1) / segments) * 1.3;
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, 14), i % 2 === 0 ? baseMat : bandMat);
    seg.position.set(x, 3.4 + h / 2 + i * h, z);
    seg.castShadow = true;
    root.add(seg);
  }

  const galleryMat = new THREE.MeshStandardMaterial({ color: 0x3f464e, roughness: 0.7, metalness: 0.4 });
  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(2.9, 3.0, 0.4, 16), galleryMat);
  gallery.position.set(x, 3.4 + towerHeight + 0.2, z);
  root.add(gallery);
  const railGeo = new THREE.TorusGeometry(2.75, 0.06, 5, 20);
  for (const y of [0.9, 1.5]) {
    const r = new THREE.Mesh(railGeo, galleryMat);
    r.rotation.x = Math.PI / 2;
    r.position.set(x, 3.4 + towerHeight + y, z);
    root.add(r);
  }

  const lanternMat = new THREE.MeshStandardMaterial({
    color: 0xfff4d2,
    emissive: 0xffe08a,
    emissiveIntensity: 1.6,
    roughness: 0.25,
    transparent: true,
    opacity: 0.9,
  });
  const lantern = new THREE.Mesh(new THREE.CylinderGeometry(1.85, 1.95, 2.8, 12), lanternMat);
  lantern.position.set(x, 3.4 + towerHeight + 1.9, z);
  root.add(lantern);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(2.5, 2.0, 12), bandMat);
  cap.position.set(x, 3.4 + towerHeight + 4.3, z);
  cap.castShadow = true;
  root.add(cap);

  const doorMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.9 });
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.4, 0.4), doorMat);
  door.position.set(x, 4.6, z + 3.3);
  root.add(door);
}

// -------------------------------------------------------------------- water

function createWater(root, rng) {
  const tex = createWaterTexture(rng);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(60, 60);
  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    color: 0xffffff,
    roughness: 0.28,
    metalness: 0.25,
  });
  const geo = new THREE.PlaneGeometry(CITY.waterSize, CITY.waterSize);
  const water = new THREE.Mesh(geo, mat);
  water.rotation.x = -Math.PI / 2;
  water.position.set(CITY.waterSize / 2 - 200, CITY.waterLevel, 0);
  water.receiveShadow = false;
  root.add(water);

  // Foam line where the sand meets the water.
  const foamMat = new THREE.MeshStandardMaterial({
    color: 0xeaf7f8,
    emissive: 0xbfe9ee,
    emissiveIntensity: 0.25,
    transparent: true,
    opacity: 0.75,
    roughness: 0.5,
  });
  const foam = new THREE.Mesh(new THREE.PlaneGeometry(6, CITY.halfZ * 2 + 60), foamMat);
  foam.rotation.x = -Math.PI / 2;
  foam.position.set(CITY.waterEdgeX - 1, CITY.waterLevel + 0.03, 0);
  root.add(foam);

  return { mesh: water, material: mat, texture: tex, foam };
}

function updateWater(water) {
  if (!water) return;
  water.texture.offset.x += 0.00016;
  water.texture.offset.y += 0.00009;
  if (water.foam) water.foam.material.opacity = 0.6 + Math.sin(performance.now() * 0.0011) * 0.12;
}

function createSky() {
  const geo = new THREE.SphereGeometry(1200, 24, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color(COLORS.skyTop) },
      horizonColor: { value: new THREE.Color(COLORS.skyHorizon) },
      sunDirection: { value: new THREE.Vector3(-0.35, 0.55, 0.45).normalize() },
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform vec3 sunDirection;
      varying vec3 vWorld;
      void main() {
        vec3 dir = normalize(vWorld);
        float h = clamp(dir.y * 1.35, 0.0, 1.0);
        vec3 col = mix(horizonColor, topColor, pow(h, 0.75));
        float sun = pow(max(dot(dir, sunDirection), 0.0), 220.0);
        col += vec3(1.0, 0.92, 0.72) * sun * 1.2;
        float halo = pow(max(dot(dir, sunDirection), 0.0), 8.0);
        col += vec3(1.0, 0.75, 0.45) * halo * 0.18;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.name = 'Sky';
  sky.frustumCulled = false;
  return sky;
}

function updateSky(sky) {
  if (!sky) return;
  // Keep the dome centred on the camera so it never clips.
  const camera = sky.userData.camera;
  if (camera) sky.position.copy(camera.position);
}

// ------------------------------------------------------- canvas textures

function makeCanvas(size, height = size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = height;
  return { canvas, ctx: canvas.getContext('2d') };
}

function toTexture(canvas, srgb = true) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 4;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function createFacadeTextures(rng) {
  const map = new Map();
  for (const facade of FACADES) {
    const size = 128;
    const albedo = makeCanvas(size);
    const emissive = makeCanvas(size);
    const a = albedo.ctx;
    const e = emissive.ctx;

    a.fillStyle = facade.base;
    a.fillRect(0, 0, size, size);
    e.fillStyle = '#000000';
    e.fillRect(0, 0, size, size);

    // Faint horizontal floor bands and vertical pilasters.
    a.fillStyle = facade.frame;
    for (let row = 0; row < 3; row += 1) {
      a.globalAlpha = 0.5;
      a.fillRect(0, row * (size / 3), size, 3);
      a.globalAlpha = 1;
    }
    a.globalAlpha = 0.25;
    for (let col = 0; col < 4; col += 1) a.fillRect(col * (size / 4), 0, 2, size);
    a.globalAlpha = 1;

    const cols = 4;
    const rows = 3;
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const w = size / cols;
        const h = size / rows;
        const x = col * w + w * 0.2;
        const y = row * h + h * 0.22;
        const ww = w * 0.6;
        const wh = h * 0.5;
        // Frame.
        a.fillStyle = facade.frame;
        a.fillRect(x - 2, y - 2, ww + 4, wh + 4);
        const lit = rng() < facade.litChance;
        a.fillStyle = lit ? facade.lit : facade.glass;
        a.fillRect(x, y, ww, wh);
        // Glass reflection streak.
        a.globalAlpha = 0.28;
        a.fillStyle = '#ffffff';
        a.fillRect(x, y, ww, wh * 0.22);
        a.globalAlpha = 1;
        // Sill.
        a.fillStyle = facade.frame;
        a.fillRect(x - 3, y + wh + 2, ww + 6, 2.5);

        if (lit) {
          e.fillStyle = facade.lit;
          e.fillRect(x, y, ww, wh);
          e.globalAlpha = 0.35;
          e.fillRect(x - 3, y - 3, ww + 6, wh + 6);
          e.globalAlpha = 1;
        }
      }
    }

    // Grime along the bottom edge so buildings do not look like plastic.
    const grad = a.createLinearGradient(0, size * 0.75, 0, size);
    grad.addColorStop(0, 'rgba(60,45,30,0)');
    grad.addColorStop(1, 'rgba(60,45,30,0.18)');
    a.fillStyle = grad;
    a.fillRect(0, size * 0.75, size, size * 0.25);

    map.set(facade.base, { map: toTexture(albedo.canvas), emissive: toTexture(emissive.canvas) });
  }
  return map;
}

function createPavingTexture(base) {
  const { canvas, ctx } = makeCanvas(128);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = 'rgba(120,110,95,0.35)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 4; i += 1) {
    const p = i * 32;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, 128);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(128, p);
    ctx.stroke();
  }
  for (let i = 0; i < 220; i += 1) {
    ctx.fillStyle = `rgba(255,255,255,${0.02 + Math.random() * 0.05})`;
    ctx.fillRect(Math.random() * 128, Math.random() * 128, 3, 3);
  }
  return toTexture(canvas);
}

function createSandTexture(rng) {
  const { canvas, ctx } = makeCanvas(128);
  ctx.fillStyle = '#f0d9a8';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 1400; i += 1) {
    const shade = 190 + Math.floor(rng() * 40);
    ctx.fillStyle = `rgba(${shade + 40},${shade + 25},${shade - 20},${0.25 + rng() * 0.35})`;
    ctx.fillRect(rng() * 128, rng() * 128, 1 + rng() * 2, 1 + rng() * 2);
  }
  // Ripple bands.
  ctx.strokeStyle = 'rgba(200,168,118,0.35)';
  ctx.lineWidth = 2;
  for (let i = 0; i < 8; i += 1) {
    ctx.beginPath();
    const y = i * 16 + rng() * 6;
    ctx.moveTo(0, y);
    ctx.bezierCurveTo(40, y + 5, 80, y - 5, 128, y + 2);
    ctx.stroke();
  }
  return toTexture(canvas);
}

function createWaterTexture(rng) {
  const { canvas, ctx } = makeCanvas(256);
  ctx.fillStyle = '#1e8fa8';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 130; i += 1) {
    const x = rng() * 256;
    const y = rng() * 256;
    const w = 20 + rng() * 90;
    const h = 1 + rng() * 3;
    ctx.fillStyle = `rgba(255,255,255,${0.05 + rng() * 0.12})`;
    ctx.fillRect(x, y, w, h);
  }
  for (let i = 0; i < 60; i += 1) {
    ctx.fillStyle = `rgba(10,80,100,${0.08 + rng() * 0.14})`;
    ctx.fillRect(rng() * 256, rng() * 256, 40 + rng() * 90, 2 + rng() * 4);
  }
  return toTexture(canvas);
}

// A large ground slab under the whole grid and a grassy strip west of it, so
// there is no visible void beyond the last street. The sea plane covers east.
function createLandmass(rng) {
  const group = new THREE.Group();
  const dirtTex = createSandTexture(rng);
  dirtTex.repeat.set(30, 30);
  const mat = new THREE.MeshStandardMaterial({ map: dirtTex, color: 0xcfc3a2, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1000, 1000), mat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.04;
  ground.receiveShadow = true;
  group.add(ground);

  // Low scrub and rocks west/north of the grid, so the edge reads as land.
  const rockMat = new THREE.MeshStandardMaterial({ color: 0xa89c88, roughness: 1, flatShading: true });
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(2.2, 0), rockMat, 26);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < 26; i += 1) {
    const x = rand(rng, -CITY.halfX - 120, -CITY.halfX - 14);
    const z = rand(rng, -CITY.halfZ - 60, CITY.halfZ + 60);
    dummy.position.set(x, rand(rng, 0.2, 1.1), z);
    dummy.rotation.set(rand(rng, 0, 1), rand(rng, 0, TAU), rand(rng, 0, 1));
    const s = rand(rng, 0.6, 2.2);
    dummy.scale.set(s, s * rand(rng, 0.6, 1.2), s);
    dummy.updateMatrix();
    rocks.setMatrixAt(i, dummy.matrix);
  }
  rocks.instanceMatrix.needsUpdate = true;
  rocks.castShadow = true;
  group.add(rocks);
  return group;
}

function createRoadSurface(network, rng) {
  const size = 2048;
  const { canvas, ctx } = makeCanvas(size);
  const spanX = CITY.spanX;
  const spanZ = CITY.spanZ;

  const toPxX = (x) => ((x + spanX / 2) / spanX) * size;
  const toPxZ = (z) => ((z + spanZ / 2) / spanZ) * size;
  const scale = size / spanX;

  ctx.fillStyle = '#3c3f46';
  ctx.fillRect(0, 0, size, size);

  // Asphalt grain.
  for (let i = 0; i < 9000; i += 1) {
    const v = 40 + Math.floor(rng() * 30);
    ctx.fillStyle = `rgba(${v},${v + 2},${v + 6},0.5)`;
    ctx.fillRect(rng() * size, rng() * size, 3, 3);
  }

  const roadHalf = CITY.road / 2;
  // Road cross-sections get a slightly lighter, worn centre.
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  for (const x of network.xs) {
    ctx.fillRect(toPxX(x - roadHalf), 0, CITY.road * scale, size);
  }
  for (const z of network.zs) {
    ctx.fillRect(0, toPxZ(z - roadHalf), size, CITY.road * scale);
  }

  // Kerb edge lines and dashed lane divider down the centre of each road.
  ctx.strokeStyle = 'rgba(245,235,205,0.75)';
  ctx.lineWidth = Math.max(2, 0.22 * scale);
  for (const x of network.xs) {
    for (const off of [-roadHalf + 0.55, roadHalf - 0.55]) {
      ctx.beginPath();
      ctx.moveTo(toPxX(x + off), 0);
      ctx.lineTo(toPxX(x + off), size);
      ctx.stroke();
    }
  }
  for (const z of network.zs) {
    for (const off of [-roadHalf + 0.55, roadHalf - 0.55]) {
      ctx.beginPath();
      ctx.moveTo(0, toPxZ(z + off));
      ctx.lineTo(size, toPxZ(z + off));
      ctx.stroke();
    }
  }

  // Dashed centre lines, skipped inside intersections.
  ctx.setLineDash([2.6 * scale, 2.6 * scale]);
  ctx.strokeStyle = 'rgba(250,236,170,0.8)';
  ctx.lineWidth = Math.max(2, 0.28 * scale);
  for (const x of network.xs) {
    for (let i = 0; i < network.zs.length - 1; i += 1) {
      const z0 = network.zs[i] + roadHalf + 1.5;
      const z1 = network.zs[i + 1] - roadHalf - 1.5;
      ctx.beginPath();
      ctx.moveTo(toPxX(x), toPxZ(z0));
      ctx.lineTo(toPxX(x), toPxZ(z1));
      ctx.stroke();
    }
  }
  for (const z of network.zs) {
    for (let i = 0; i < network.xs.length - 1; i += 1) {
      const x0 = network.xs[i] + roadHalf + 1.5;
      const x1 = network.xs[i + 1] - roadHalf - 1.5;
      ctx.beginPath();
      ctx.moveTo(toPxX(x0), toPxZ(z));
      ctx.lineTo(toPxX(x1), toPxZ(z));
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);

  // Crosswalks (zebra) on all four approaches of every intersection.
  ctx.fillStyle = 'rgba(245,240,225,0.72)';
  const stripe = 0.62 * scale;
  const stripeGap = 0.75 * scale;
  for (const x of network.xs) {
    for (const z of network.zs) {
      const bandDepth = 3.2;
      // North and south approaches (bars run east-west).
      for (const dir of [-1, 1]) {
        const zStart = z + dir * (roadHalf - bandDepth);
        const zEnd = z + dir * (roadHalf - 0.4);
        for (let sx = x - roadHalf + 0.8; sx < x + roadHalf - 0.8; sx += 1.55) {
          ctx.fillRect(toPxX(sx), toPxZ(Math.min(zStart, zEnd)), stripe, Math.abs(zEnd - zStart) * scale);
        }
      }
      // East and west approaches (bars run north-south).
      for (const dir of [-1, 1]) {
        const xStart = x + dir * (roadHalf - bandDepth);
        const xEnd = x + dir * (roadHalf - 0.4);
        for (let sz = z - roadHalf + 0.8; sz < z + roadHalf - 0.8; sz += 1.55) {
          ctx.fillRect(toPxX(Math.min(xStart, xEnd)), toPxZ(sz), Math.abs(xEnd - xStart) * scale, stripe);
        }
      }
    }
  }

  // Manhole covers and a few patched repairs for texture.
  for (let i = 0; i < 26; i += 1) {
    const onX = rng() < 0.5;
    const road = onX ? network.xs[randInt(rng, 0, network.xs.length - 1)] : network.zs[randInt(rng, 0, network.zs.length - 1)];
    const along = rand(rng, -CITY.halfX + 12, CITY.halfX - 12);
    const x = onX ? road + rand(rng, -roadHalf + 1, roadHalf - 1) : along;
    const z = onX ? along : road + rand(rng, -roadHalf + 1, roadHalf - 1);
    ctx.fillStyle = 'rgba(30,32,36,0.55)';
    ctx.beginPath();
    ctx.arc(toPxX(x), toPxZ(z), 0.55 * scale, 0, TAU);
    ctx.fill();
  }

  const tex = toTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;

  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.96, metalness: 0.02 });
  const geo = new THREE.PlaneGeometry(spanX, spanZ);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.005;
  mesh.receiveShadow = true;
  mesh.name = 'road-surface';

  const group = new THREE.Group();
  group.add(mesh);
  return group;
}
