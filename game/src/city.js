// Build Solmar Bay's road grid, coastal neighborhoods, park and harbor landmarks.
import * as THREE from 'three';
import { CITY, COLORS } from './config.js';
import { choose, createRng, randomRange } from './util.js';

const UP = new THREE.Vector3(0, 1, 0);
const halfRoad = CITY.roadWidth / 2;

function mat(color, options = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.88, ...options });
}

function box(scene, name, size, x, y, z, material, shadows = true) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
  mesh.name = name;
  mesh.position.set(x, y, z);
  mesh.castShadow = shadows;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

function beam(scene, name, from, to, radius, material) {
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const direction = new THREE.Vector3().subVectors(b, a);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, direction.length(), 6), material);
  mesh.name = name;
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(UP, direction.normalize());
  mesh.castShadow = true;
  scene.add(mesh);
  return mesh;
}

function addRoadGrid(scene) {
  const asphalt = mat(COLORS.road);
  const sidewalk = mat(COLORS.sidewalk);
  const curb = mat(COLORS.curb);
  const paint = mat(COLORS.roadMark, { emissive: COLORS.roadMark, emissiveIntensity: 0.055 });
  const roads = [];
  const intersections = [];
  const minX = CITY.worldMinX;
  const maxX = CITY.worldMaxX;
  const minZ = CITY.worldMinZ;
  const maxZ = CITY.coastZ;
  const side = CITY.sidewalkWidth;

  for (const x of CITY.gridX) {
    box(scene, 'street/avenue', [CITY.roadWidth, 0.055, maxZ - minZ], x, 0.02, (minZ + maxZ) / 2, asphalt, false);
    for (const direction of [-1, 1]) {
      box(scene, 'street/sidewalk', [side, 0.13, maxZ - minZ], x + direction * (halfRoad + side / 2), 0.065, (minZ + maxZ) / 2, sidewalk, false);
      box(scene, 'street/curb', [0.22, 0.16, maxZ - minZ], x + direction * (halfRoad + 0.06), 0.08, (minZ + maxZ) / 2, curb, false);
    }
    roads.push({ id: `avenue-${x}`, axis: 'z', coordinate: x, start: minZ, end: maxZ, width: CITY.roadWidth, lanes: 2 });
    for (let z = minZ + 4; z < maxZ - 3; z += 9) box(scene, 'street/lane-dash', [0.12, 0.012, 3.1], x, 0.054, z, paint, false);
  }
  for (const z of CITY.gridZ) {
    box(scene, 'street/boulevard', [maxX - minX, 0.055, CITY.roadWidth], (minX + maxX) / 2, 0.022, z, asphalt, false);
    for (const direction of [-1, 1]) {
      box(scene, 'street/sidewalk', [maxX - minX, 0.13, side], (minX + maxX) / 2, 0.065, z + direction * (halfRoad + side / 2), sidewalk, false);
      box(scene, 'street/curb', [maxX - minX, 0.16, 0.22], (minX + maxX) / 2, 0.08, z + direction * (halfRoad + 0.06), curb, false);
    }
    roads.push({ id: `boulevard-${z}`, axis: 'x', coordinate: z, start: minX, end: maxX, width: CITY.roadWidth, lanes: 2 });
    for (let x = minX + 4; x < maxX - 3; x += 9) box(scene, 'street/lane-dash', [3.1, 0.012, 0.12], x, 0.055, z, paint, false);
  }
  for (const x of CITY.gridX) for (const z of CITY.gridZ) {
    intersections.push({ x, z });
    for (let stripe = -3; stripe <= 3; stripe += 2) {
      box(scene, 'street/crosswalk', [0.72, 0.014, 0.13], x + stripe, 0.058, z + halfRoad - 0.45, curb, false);
      box(scene, 'street/crosswalk', [0.13, 0.014, 0.72], x + halfRoad - 0.45, 0.058, z + stripe, curb, false);
    }
  }
  return { roads, intersections };
}

// Blocks are the cells BETWEEN adjacent roads, so a cell boundary is always a road centre line.
function boundsFor(index, values, min, max) {
  const upper = index === values.length ? max : values[index];
  const lower = index === 0 ? min : values[index - 1];
  return [lower, upper];
}

function addBuildings(scene, rng, colliders) {
  const baseMats = COLORS.buildings.map((color) => mat(color));
  const roofMats = ['#f0d8b1', '#c5b7a0', '#b9c9bb'].map((color) => mat(color));
  const windowLit = mat('#f1c87d', { emissive: '#f6ae50', emissiveIntensity: 0.38, roughness: 0.55 });
  const windowDim = mat('#63818a', { emissive: '#35606a', emissiveIntensity: 0.16, roughness: 0.7 });
  const windowGeo = new THREE.BoxGeometry(0.88, 0.98, 0.055);
  const litMatrices = [];
  const dimMatrices = [];
  const object = new THREE.Object3D();
  const park = CITY.park;

  for (let zi = 0; zi < CITY.gridZ.length; zi += 1) {
    const zb = boundsFor(zi, CITY.gridZ, CITY.worldMinZ, CITY.coastZ - 13);
    for (let xi = 0; xi < CITY.gridX.length; xi += 1) {
      const xb = boundsFor(xi, CITY.gridX, CITY.worldMinX, CITY.worldMaxX);
      const bx = [xb[0] + halfRoad + CITY.blockInset, xb[1] - halfRoad - CITY.blockInset];
      const bz = [zb[0] + halfRoad + CITY.blockInset, zb[1] - halfRoad - CITY.blockInset];
      if (park.x - park.width / 2 < bx[1] && park.x + park.width / 2 > bx[0] && park.z - park.depth / 2 < bz[1] && park.z + park.depth / 2 > bz[0]) continue;
      const blockWidth = bx[1] - bx[0];
      const blockDepth = bz[1] - bz[0];
      if (blockWidth < 9 || blockDepth < 9) continue;
      const count = 2 + Math.floor(rng() * 2);
      for (let index = 0; index < count; index += 1) {
        const sx = randomRange(rng, 11, Math.min(19, blockWidth * 0.55));
        const sz = randomRange(rng, 10, Math.min(18, blockDepth * 0.55));
        const x = randomRange(rng, bx[0] + 2.5, Math.max(bx[0] + 2.5, bx[1] - sx - 2.5));
        const z = randomRange(rng, bz[0] + 2.5, Math.max(bz[0] + 2.5, bz[1] - sz - 2.5));
        const floors = 2 + Math.floor(rng() * 6);
        const height = floors * 3.05 + randomRange(rng, 0.2, 1.25);
        const building = box(scene, `building/block-${zi}-${xi}-${index}`, [sx, height, sz], x + sx / 2, height / 2, z + sz / 2, choose(rng, baseMats));
        building.rotation.y = Math.round(randomRange(rng, -0.04, 0.04) / 0.02) * 0.02;
        box(scene, 'building/roof-cap', [sx + 0.42, 0.26, sz + 0.42], x + sx / 2, height + 0.12, z + sz / 2, choose(rng, roofMats), false);
        colliders.push({ minX: x, maxX: x + sx, minZ: z, maxZ: z + sz, height, type: 'building', mesh: building });

        const rows = Math.max(1, Math.floor(sz / 1.9));
        const columns = Math.max(1, Math.floor(sx / 1.8));
        for (let floor = 0; floor < floors; floor += 1) {
          const y = 1.65 + floor * 3.05;
          for (let col = 0; col < columns; col += 1) {
            const px = x + (col + 0.65) * sx / (columns + 0.3);
            for (const back of [-1, 1]) {
              object.position.set(px, y, back < 0 ? z - 0.035 : z + sz + 0.035);
              object.rotation.set(0, 0, 0);
              object.scale.set(0.88, 0.98, 0.055);
              object.updateMatrix();
              (rng() > 0.72 ? litMatrices : dimMatrices).push(object.matrix.clone());
            }
          }
          for (let col = 0; col < rows; col += 1) {
            const pz = z + (col + 0.65) * sz / (rows + 0.3);
            for (const side of [-1, 1]) {
              object.position.set(x + (side < 0 ? -0.035 : sx + 0.035), y, pz);
              object.rotation.set(0, Math.PI / 2, 0);
              object.scale.set(0.88, 0.98, 0.055);
              object.updateMatrix();
              (rng() > 0.77 ? litMatrices : dimMatrices).push(object.matrix.clone());
            }
          }
        }
        if (floors < 5) {
          const balcony = mat('#e9d8bd');
          for (let floor = 1; floor < floors; floor += 1) box(scene, 'building/balcony', [sx * 0.72, 0.12, 0.38], x + sx / 2, floor * 3.05, z - 0.2, balcony, false);
        }
      }
    }
  }
  for (const [matr, windowMat, name] of [[litMatrices, windowLit, 'building/windows-warm-lit'], [dimMatrices, windowDim, 'building/windows-cool-lit']]) {
    const windows = new THREE.InstancedMesh(windowGeo, windowMat, matr.length);
    windows.name = name;
    matr.forEach((matrix, index) => windows.setMatrixAt(index, matrix));
    windows.instanceMatrix.needsUpdate = true;
    windows.frustumCulled = false;
    scene.add(windows);
  }
}

function addPalm(scene, rng, x, z, scale = 1) {
  const trunkMat = mat(COLORS.trunk);
  const fronds = [mat(COLORS.palm), mat('#6c965e')];
  const height = randomRange(rng, 5.4, 7.5) * scale;
  const lean = randomRange(rng, -0.45, 0.45) * scale;
  const crown = [x + lean, height, z + lean * 0.5];
  beam(scene, 'palm/trunk', [x, 0.16, z], crown, 0.25 * scale, trunkMat);
  for (let index = 0; index < 7; index += 1) {
    const angle = index / 7 * Math.PI * 2 + randomRange(rng, -0.18, 0.18);
    const reach = randomRange(rng, 2.6, 3.4) * scale;
    const tip = [crown[0] + Math.cos(angle) * reach, height - randomRange(rng, 0.25, 0.9) * scale, crown[2] + Math.sin(angle) * reach];
    beam(scene, 'palm/frond-stem', crown, tip, 0.085 * scale, fronds[index % 2]);
    for (let leaf = 0; leaf < 4; leaf += 1) {
      const t = 0.27 + leaf * 0.16;
      const base = new THREE.Vector3(...crown).lerp(new THREE.Vector3(...tip), t);
      const end = base.clone().add(new THREE.Vector3(Math.cos(angle) * 0.54, -0.5 - leaf * 0.13, Math.sin(angle) * 0.54).multiplyScalar(scale));
      beam(scene, 'palm/leaf', base.toArray(), end.toArray(), 0.1 * scale, fronds[(leaf + index) % 2]);
    }
  }
}

function addPark(scene, rng) {
  const { x, z, width, depth } = CITY.park;
  box(scene, 'park/green', [width, 0.16, depth], x, 0.02, z, mat(COLORS.grass), false);
  box(scene, 'park/path-cross', [width - 4, 0.045, 1.45], x, 0.11, z, mat('#dfd1aa'), false);
  box(scene, 'park/path-cross', [1.45, 0.05, depth - 4], x, 0.12, z, mat('#dfd1aa'), false);
  box(scene, 'park/pond', [8.5, 0.1, 5.4], x + 8, 0.11, z - 7, mat('#54a99d', { emissive: '#237b73', emissiveIntensity: 0.12 }), false);
  const hedge = mat('#537b55');
  for (let i = 0; i < 14; i += 1) {
    const edge = i % 4;
    const px = edge < 2 ? x + randomRange(rng, -width * 0.43, width * 0.43) : x + (edge === 2 ? -width * 0.43 : width * 0.43);
    const pz = edge < 2 ? z + (edge === 0 ? -depth * 0.4 : depth * 0.4) : z + randomRange(rng, -depth * 0.4, depth * 0.4);
    box(scene, 'park/hedge', [2.3, 0.65, 0.9], px, 0.43, pz, hedge, false);
  }
  for (const [dx, dz] of [[-12, -10], [-12, 10], [12, 10], [3, 11], [12, -9]]) addPalm(scene, rng, x + dx, z + dz, 0.86);
}

function addLandmarks(scene, rng, colliders) {
  box(scene, 'terrain/sunlit-ground', [360, 0.3, 300], 0, -0.32, 26, mat(COLORS.grass), false);
  box(scene, 'coast/sand', [270, 0.32, 23], 0, -0.015, 105.5, mat(COLORS.sand), false);
  box(scene, 'coast/promenade', [270, 0.2, 3.5], 0, 0.08, 95.2, mat('#bdb39b'), false);
  box(scene, 'harbor/water', [340, 0.5, CITY.waterDepth], 0, -0.32, CITY.waterZ, mat(COLORS.water, { roughness: 0.3, metalness: 0.06, emissive: '#106274', emissiveIntensity: 0.09 }), false);
  box(scene, 'harbor/deep-water', [270, 0.22, 28], 0, -0.43, 204, mat(COLORS.deepWater), false);
  box(scene, 'harbor/quay-edge', [270, 0.65, 1.25], 0, 0.1, 117, mat('#b6aa8f'));
  for (let x = -132; x <= 132; x += 12) box(scene, 'harbor/quay-post', [0.38, 0.84, 0.38], x, 0.39, 117.15, mat('#e7d5b5'), false);

  const pierX = CITY.landmark.pierX;
  const pierLength = CITY.landmark.pierEndZ - CITY.landmark.pierStartZ;
  const pierCenter = (CITY.landmark.pierStartZ + CITY.landmark.pierEndZ) / 2;
  box(scene, 'pier/deck', [10, 0.5, pierLength], pierX, 0.28, pierCenter, mat(COLORS.pier));
  const rail = mat('#dfc69e');
  for (const direction of [-1, 1]) {
    const x = pierX + direction * 4.7;
    box(scene, 'pier/rail', [0.18, 0.75, pierLength], x, 0.77, pierCenter, rail);
    for (let z = CITY.landmark.pierStartZ; z <= CITY.landmark.pierEndZ; z += 5) box(scene, 'pier/post', [0.25, 1.4, 0.25], x, 0.55, z, rail);
  }
  for (let z = CITY.landmark.pierStartZ + 4; z < CITY.landmark.pierEndZ - 2; z += 9) for (const direction of [-1, 1]) {
    const x = pierX + direction * 3.7;
    beam(scene, 'pier/light-post', [x, 0.52, z], [x, 3.4, z], 0.075, mat('#515c5a'));
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.16, 7, 5), new THREE.MeshBasicMaterial({ color: '#ffe4a1' }));
    glow.name = 'pier/warm-light';
    glow.position.set(x, 3.4, z);
    scene.add(glow);
  }

  const lx = pierX;
  const lz = CITY.landmark.lighthouseZ;
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 3.1, 15, 12), mat('#f5e9ce'));
  tower.name = 'lighthouse/tower';
  tower.position.set(lx, 7.8, lz);
  tower.castShadow = true;
  scene.add(tower);
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(2.56, 2.88, 1.35, 12), mat('#ce775f'));
  stripe.name = 'lighthouse/painted-band';
  stripe.position.set(lx, 3.55, lz);
  scene.add(stripe);
  box(scene, 'lighthouse/lantern-room', [4.5, 2.1, 4.5], lx, 16.25, lz, mat('#536b70', { emissive: '#f7c66d', emissiveIntensity: 0.32 }));
  const roof = new THREE.Mesh(new THREE.ConeGeometry(3.4, 1.7, 12), mat('#ce775f'));
  roof.name = 'lighthouse/roof';
  roof.position.set(lx, 18.1, lz);
  roof.castShadow = true;
  scene.add(roof);
  colliders.push({ minX: lx - 3.2, maxX: lx + 3.2, minZ: lz - 3.2, maxZ: lz + 3.2, height: 19, type: 'landmark', mesh: tower });

  for (let i = 0; i < 4; i += 1) {
    const x = -64 + i * 21;
    const height = 5 + randomRange(rng, 0, 1.4);
    box(scene, 'harbor/boat-shed', [14, height, 9], x, height / 2, 83, mat(i % 2 ? '#ad8b68' : '#a18f72'));
    colliders.push({ minX: x - 7, maxX: x + 7, minZ: 78.5, maxZ: 87.5, height, type: 'building' });
  }
  for (let i = 0; i < 6; i += 1) {
    const x = -87 + i * 28;
    const z = 132 + (i % 2) * 13;
    const hull = box(scene, 'harbor/sailboat-hull', [5.2, 0.65, 1.65], x, -0.13, z, mat(i % 2 ? '#e6e0ce' : '#d18e62'));
    hull.rotation.y = 0.12 * (i % 3 - 1);
    beam(scene, 'harbor/mast', [x, 0.2, z], [x, 5.8, z], 0.065, mat('#e4e1d5'));
    const sail = box(scene, 'harbor/sail', [0.11, 3.8, 2.3], x + 0.45, 2.6, z + 0.12, mat('#fbf3dd'));
    sail.rotation.y = 0.15;
  }
}

function addStreetFurniture(scene, rng) {
  const pole = mat('#5c6864', { metalness: 0.36, roughness: 0.68 });
  const lampGeometry = new THREE.SphereGeometry(0.23, 8, 6);
  const lampMaterial = mat(COLORS.lamp, { emissive: COLORS.lamp, emissiveIntensity: 1.2, roughness: 0.35 });
  const lampMatrices = [];
  const temp = new THREE.Object3D();
  // Lamps stand on the opposite sidewalk corners of each junction, clear of both carriageways,
  // with the arm cantilevered back over the roadway it lights.
  for (const x of CITY.gridX) for (const z of CITY.gridZ) for (const [sideX, sideZ] of [[1, 1], [-1, -1]]) {
    const px = x + sideX * (halfRoad + 0.85);
    const pz = z + sideZ * (halfRoad + 0.85);
    const lampX = px - sideX * 1.45;
    const lampZ = pz - sideZ * 1.45;
    beam(scene, 'streetlight/pole', [px, 0.14, pz], [px, 5.4, pz], 0.11, pole);
    beam(scene, 'streetlight/arm', [px, 5.2, pz], [lampX, 5.2, lampZ], 0.08, pole);
    temp.position.set(lampX, 5.1, lampZ);
    temp.updateMatrix();
    lampMatrices.push(temp.matrix.clone());
  }
  const lamps = new THREE.InstancedMesh(lampGeometry, lampMaterial, lampMatrices.length);
  lamps.name = 'streetlight/warm-lanterns';
  lampMatrices.forEach((matrix, i) => lamps.setMatrixAt(i, matrix));
  lamps.instanceMatrix.needsUpdate = true;
  scene.add(lamps);
  for (const x of [-113, -63, -13, 37, 87, 113]) addPalm(scene, rng, x, 98 + randomRange(rng, -1.2, 1.2), 0.92);
  for (const z of [-67, -22, 23, 68]) for (const x of [-113, 113]) addPalm(scene, rng, x, z, 0.78);
}

export function createRoadNetwork() {
  const roads = [];
  const intersections = [];
  for (const x of CITY.gridX) roads.push({ id: `avenue-${x}`, axis: 'z', coordinate: x, start: CITY.worldMinZ, end: CITY.coastZ, width: CITY.roadWidth, lanes: 2 });
  for (const z of CITY.gridZ) roads.push({ id: `boulevard-${z}`, axis: 'x', coordinate: z, start: CITY.worldMinX, end: CITY.worldMaxX, width: CITY.roadWidth, lanes: 2 });
  for (const x of CITY.gridX) for (const z of CITY.gridZ) intersections.push({ x, z });
  return { roads, intersections };
}

export function nearestRoadPoint(x, z) {
  let nearest = null;
  for (const coordinate of CITY.gridX) {
    const candidate = { x: coordinate, z: Math.max(CITY.worldMinZ, Math.min(CITY.coastZ, z)), axis: 'z' };
    candidate.distance = Math.abs(x - coordinate);
    if (!nearest || candidate.distance < nearest.distance) nearest = candidate;
  }
  for (const coordinate of CITY.gridZ) {
    const candidate = { x: Math.max(CITY.worldMinX, Math.min(CITY.worldMaxX, x)), z: coordinate, axis: 'x' };
    candidate.distance = Math.abs(z - coordinate);
    if (candidate.distance < nearest.distance) nearest = candidate;
  }
  return nearest;
}

export function createCity(ctx) {
  const rng = ctx.rng ?? createRng(4162026);
  const colliders = ctx.colliders ?? [];
  ctx.colliders = colliders;
  ctx.scene.background = new THREE.Color(COLORS.sky);
  ctx.scene.fog = new THREE.Fog(COLORS.sky, 180, 390);
  const hemi = new THREE.HemisphereLight('#ddf6f1', '#75806b', 2.15);
  hemi.name = 'sun/sky-fill';
  ctx.scene.add(hemi);
  const sun = new THREE.DirectionalLight('#fff1cd', 3.1);
  sun.name = 'sun/coastal-afternoon';
  sun.position.set(-78, 115, 55);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -175, right: 175, top: 175, bottom: -175, near: 10, far: 330 });
  sun.shadow.bias = -0.00025;
  ctx.scene.add(sun);

  box(ctx.scene, 'terrain/base', [360, 0.3, 300], 0, -0.32, 26, mat(COLORS.grass), false);
  const network = addRoadGrid(ctx.scene);
  addBuildings(ctx.scene, rng, colliders);
  addPark(ctx.scene, rng);
  addLandmarks(ctx.scene, rng, colliders);
  addStreetFurniture(ctx.scene, rng);
  const city = {
    colliders,
    roads: network.roads,
    intersections: network.intersections,
    nearestRoadPoint,
    landmarks: {
      courierPickup: { x: -80, z: 69, label: 'BODEGA LUNA' },
      firstDelivery: { x: 80, z: -68, label: 'MIRADOR COURT' },
      drops: [{ x: -80, z: -68 }, { x: 70, z: 22 }, { x: 25, z: -22 }],
      escape: { x: 64, z: 153, label: 'HARBOR ESCAPE' },
      sidePickup: { x: -24, z: -20, label: 'PARK COURIER' },
      sideDelivery: { x: 100, z: 67, label: 'MARINA PARCELS' },
    },
  };
  ctx.city = city;
  return city;
}
