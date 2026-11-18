// config.js — every tunable number and data table in one place.
// City coordinates: the road grid is centred on the origin, +X is east
// (toward the harbour), -Z is north.

export const SAVE_KEY = 'neon-harbor-save-v1';

export const GAME_TITLE = 'Neon Harbor';
export const CITY_NAME = 'Solmar Bay';
export const PROTAGONIST = 'Mara Velez';

// ------------------------------------------------------------------ the city
export const CITY = {
  seed: 20261118,
  gridX: 6, // blocks east-west
  gridZ: 6, // blocks north-south
  block: 62, // block edge including its sidewalks
  road: 16, // asphalt width between block kerbs
  sidewalk: 4, // walkway inside each block edge
  laneOffset: 4.2, // lane centre distance from the road centre line
  parkingOffset: 6.1, // kerbside parking lane
  curbHeight: 0.14,
  // East of the grid: promenade (quay), then sand, then water.
  quayStartX: 242,
  quayEndX: 256,
  quayHeight: 0.42, // promenade deck top, above the sand
  beachStartX: 256, // sand begins east of the promenade
  beachEndX: 318, // waterline
  waterEdgeX: 318,
  waterLevel: -0.35,
  pier: { z: 62, startX: 300, endX: 412, width: 13 },
  lighthouse: { x: 444, z: 150 },
  parkBlock: { cx: 1, cz: 2 },
  plazaBlock: { cx: 3, cz: 3 },
  playerStart: { x: -6, z: 34, heading: Math.PI },
  waterSize: 2600,
};

// Road grid extent derived from the numbers above.
CITY.spanX = CITY.gridX * CITY.block + (CITY.gridX + 1) * CITY.road;
CITY.spanZ = CITY.gridZ * CITY.block + (CITY.gridZ + 1) * CITY.road;
CITY.halfX = CITY.spanX / 2;
CITY.halfZ = CITY.spanZ / 2;

// Sun-soaked palette. All colours are three.js hex ints.
export const COLORS = {
  skyTop: 0x2f7fd0,
  skyHorizon: 0xffd9a8,
  sun: 0xfff0d0,
  fog: 0xf6dcc0,
  asphalt: 0x3c3f46,
  asphaltLine: 0xf1e6c8,
  sidewalk: 0xd9cfbb,
  curb: 0xb8ad98,
  sand: 0xf0d9a8,
  water: 0x1e8fa8,
  waterDeep: 0x136474,
  grass: 0x6fae63,
  concrete: 0xbdb5a5,
  stone: 0x9d9588,
  wood: 0x8a5f3c,
  roof: 0x6b6259,
  palmTrunk: 0x8a6b47,
  palmLeaf: 0x3f8a45,
  lampPost: 0x4a4d55,
  lampGlow: 0xffe6a8,
  policeLight: 0x3f7bff,
  policeRed: 0xff3b30,
  glassDark: 0x1e2a35,
};

// Facade palettes: [base colour, window colour, lit-window colour].
export const FACADES = [
  { base: '#f0d6b4', frame: '#c9a882', glass: '#5f7f93', lit: '#ffe9b0', litChance: 0.32 },
  { base: '#e7c7a1', frame: '#b99b78', glass: '#4d6f83', lit: '#ffd48a', litChance: 0.26 },
  { base: '#d7e0dc', frame: '#a9b8b3', glass: '#41616f', lit: '#ffeec2', litChance: 0.22 },
  { base: '#e9c2bb', frame: '#c49b93', glass: '#4a6a7d', lit: '#ffdca0', litChance: 0.3 },
  { base: '#cfd8e6', frame: '#a5b2c6', glass: '#3d5d76', lit: '#ffe4ad', litChance: 0.24 },
  { base: '#efe2c8', frame: '#c4b294', glass: '#587a8c', lit: '#fff0c8', litChance: 0.2 },
];

// Building tints used for low-rise blocks near the waterfront.
export const BUILDING_TINTS = [0xffd8b8, 0xf6c9c2, 0xd9e6dc, 0xf3e0bb, 0xd7dcec, 0xf2d4a8];

// --------------------------------------------------------------------- cars
// Every car the game builds comes from this table. One invented marque
// ("Marlin", "Kestrel", ...) per model; the player can steal any of them.
export const CAR_MODELS = [
  {
    id: 'kestrel',
    name: 'Kestrel GT',
    style: 'coupe',
    length: 4.3,
    width: 1.92,
    height: 1.22,
    topSpeed: 36,
    accel: 15,
    brake: 26,
    turnRate: 2.2,
    grip: 0.9,
    colors: [0xd94f45, 0xf2b23e, 0x2f6f9f, 0x212429, 0xece4d6],
  },
  {
    id: 'marlin',
    name: 'Marlin 440',
    style: 'muscle',
    length: 4.75,
    width: 2.0,
    height: 1.32,
    topSpeed: 33,
    accel: 13,
    brake: 22,
    turnRate: 1.85,
    grip: 0.86,
    colors: [0x3b6b4f, 0xb23a2e, 0xe8dcc2, 0x2a3d63, 0x8a5a2b],
  },
  {
    id: 'coral',
    name: 'Coral Compact',
    style: 'hatch',
    length: 3.62,
    width: 1.74,
    height: 1.5,
    topSpeed: 26,
    accel: 11,
    brake: 20,
    turnRate: 2.35,
    grip: 0.92,
    colors: [0xf6e5b1, 0x7fc4bd, 0xf2a6a0, 0xdfe3e8, 0x5b7f6d],
  },
  {
    id: 'vista',
    name: 'Vista Wagon',
    style: 'wagon',
    length: 4.62,
    width: 1.86,
    height: 1.62,
    topSpeed: 25,
    accel: 10,
    brake: 19,
    turnRate: 1.8,
    grip: 0.9,
    colors: [0x9fbfa8, 0xe6d7c3, 0x6f88a8, 0xc06b58],
  },
  {
    id: 'pelican',
    name: 'Pelican Pickup',
    style: 'pickup',
    length: 5.0,
    width: 1.98,
    height: 1.58,
    topSpeed: 28,
    accel: 11.5,
    brake: 20,
    turnRate: 1.7,
    grip: 0.84,
    colors: [0xe0c9a0, 0x5f7d8c, 0x9c4b3c, 0x33413c],
  },
  {
    id: 'sandpiper',
    name: 'Sandpiper Buggy',
    style: 'buggy',
    length: 3.82,
    width: 1.94,
    height: 1.44,
    topSpeed: 31,
    accel: 14,
    brake: 20,
    turnRate: 2.1,
    grip: 0.8,
    colors: [0xf2b23e, 0x4fa6b8, 0xd96248, 0xd9d2c2],
  },
];

export const POLICE_CAR = {
  id: 'patrol',
  name: 'SBPD Cruiser',
  style: 'sedan',
  length: 4.6,
  width: 1.9,
  height: 1.44,
  topSpeed: 32,
  accel: 13.5,
  brake: 24,
  turnRate: 1.95,
  grip: 0.9,
  bodyColor: 0xf3f5f7,
  accentColor: 0x1f3f8c,
};

export const VEHICLE = {
  wheelRadius: 0.36,
  rideHeight: 0.12,
  driftGrip: 0.7,
  handbrakeGrip: 0.4,
  enterRange: 3.2,
  exitOffset: 1.6,
  collisionBounce: 0.35,
  playerCameraHeight: 2.1,
  chaseDistance: 6.4,
  chaseHeight: 3.0,
  chaseLag: 3.5,
  damageSmokeAt: 0.55,
};

// ------------------------------------------------------------------- player
export const PLAYER = {
  walkSpeed: 4.3,
  sprintSpeed: 8.0,
  accel: 26,
  radius: 0.42,
  height: 1.8,
  maxHealth: 100,
  punchRange: 2.3,
  punchArc: 0.55,
  punchCooldown: 0.42,
  punchKnockback: 3.2,
  swimSpeed: 2.6,
  cameraDistance: 5.4,
  cameraHeight: 2.2,
  cameraMinPitch: -0.55,
  cameraMaxPitch: 0.95,
  mouseSensitivity: 0.0032,
};

export const PEDESTRIANS = {
  count: 46,
  walkSpeed: 1.35,
  fleeSpeed: 3.4,
  radius: 0.4,
  fleeRadius: 9,
  fleeTime: 6,
  sidewalkInset: 1.6,
  despawnRange: 220,
};

export const TRAFFIC = {
  count: 16,
  spawnRange: 220,
  despawnRange: 260,
  laneChangeChance: 0.12,
  stopDistance: 9,
  slowRadius: 16,
  hornCooldown: 4,
};

// -------------------------------------------------------------- wanted system
export const WANTED = {
  maxStars: 5,
  heatMax: 220,
  // Heat required for 1..5 stars (index 0 is the zero-star threshold).
  starHeat: [0, 16, 40, 72, 112, 165],
  crimes: {
    carTheft: 26,
    pedHit: 34,
    assault: 20,
    mission: 18,
    policeCarHit: 12,
    ramPolice: 14,
    propertyDamage: 8,
  },
  decayDelay: 9, // seconds out of sight before heat starts falling
  decayRate: 8, // heat per second while hidden
  spawnRange: 130,
  despawnRange: 340,
  unitsPerStar: [0, 1, 2, 3, 4, 5],
  bustedRange: 4.6,
  bustedSpeed: 2.0,
  bustedTime: 3.2,
  bustedFine: 250,
  bustedHeatLoss: 0.55,
  sirenRange: 130,
  visionRange: 90,
};

// ------------------------------------------------------------------- missions
// Mission 1: package run. Mission 2: three drops. Mission 3: harbour getaway.
export const MISSIONS = {
  list: [
    {
      id: 'cold-package',
      number: 1,
      title: 'Cold Package',
      reward: 900,
      respect: 12,
      timeLimit: 165,
      heatOnComplete: 30,
    },
    {
      id: 'three-drops',
      number: 2,
      title: 'Three Drops',
      reward: 1500,
      respect: 20,
      timeLimit: 0,
      heatOnComplete: 70,
    },
    {
      id: 'last-light',
      number: 3,
      title: 'Last Light',
      reward: 2600,
      respect: 35,
      timeLimit: 0,
      heatOnStart: 70,
    },
  ],
  courier: {
    reward: 160,
    timeLimit: 95,
    cooldown: 12,
    respect: 2,
  },
  pickupRadius: 4.5,
  dropRadius: 6,
  escapeRadius: 8,
};

export const HUD = {
  minimapSize: 380, // backing-store pixels
  minimapRange: 165, // world units from edge to edge
  toastTime: 3.2,
};

export const AUDIO = {
  master: 0.55,
  musicVolume: 0.16,
  engineVolume: 0.3,
  sirenVolume: 0.24,
  sfxVolume: 0.4,
};

export const GAME = {
  fov: 62,
  near: 0.1,
  far: 1000,
  maxDt: 0.05,
  fogNear: 200,
  fogFar: 840,
  shadowMapSize: 1024,
  shadowRange: 90,
  exposure: 1.0,
};
