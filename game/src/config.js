// Shared world scale, gameplay tuning, authored vehicle roster and city palette.
export const STEP = 1 / 60;
export const SAVE_KEY = 'neon-harbor-save-v1';

export const CITY = {
  name: 'Solmar Bay',
  gridX: [-100, -50, 0, 50, 100],
  gridZ: [-90, -45, 0, 45, 90],
  roadWidth: 10,
  sidewalkWidth: 2.3,
  worldMinX: -125,
  worldMaxX: 125,
  worldMinZ: -115,
  coastZ: 103,
  waterZ: 139,
  waterDepth: 90,
  blockInset: 7,
  landmark: { pierX: 64, pierStartZ: 103, pierEndZ: 162, lighthouseZ: 157 },
  park: { x: -25, z: -22.5, width: 34, depth: 30 },
};

export const PLAYER = {
  walkSpeed: 8.2,
  sprintSpeed: 12.5,
  radius: 0.68,
  height: 1.72,
  health: 100,
  vehicleEnterRange: 4.1,
  punchRange: 2.2,
  punchCooldown: 0.72,
};

export const CAMERA = {
  orbitSensitivity: 0.0032,
  walkDistance: 8.4,
  walkHeight: 4.4,
  driveDistance: 11.8,
  driveHeight: 5.1,
  smoothing: 7.5,
  minPitch: -0.28,
  maxPitch: 0.72,
};

export const CAR_MODELS = [
  { id: 'tide', name: 'Tide Runner', className: 'compact', color: '#e9b454', accent: '#873d31', length: 4.2, width: 1.85, height: 1.42, maxSpeed: 25, acceleration: 13, handling: 2.7 },
  { id: 'cielo', name: 'Cielo GT', className: 'sport', color: '#36a8b2', accent: '#163f4b', length: 4.7, width: 1.96, height: 1.28, maxSpeed: 32, acceleration: 17, handling: 3.15 },
  { id: 'marina', name: 'Marina LX', className: 'sedan', color: '#d96c51', accent: '#572e39', length: 4.8, width: 2.02, height: 1.53, maxSpeed: 27, acceleration: 12, handling: 2.4 },
  { id: 'dorado', name: 'Dorado Utility', className: 'utility', color: '#7c8790', accent: '#283a43', length: 5.2, width: 2.12, height: 1.8, maxSpeed: 23, acceleration: 10, handling: 2.05 },
  { id: 'lumen', name: 'Lumen EV', className: 'electric', color: '#87b77c', accent: '#355d52', length: 4.45, width: 1.9, height: 1.38, maxSpeed: 29, acceleration: 16, handling: 2.85 },
];

export const WANTED = {
  maxStars: 5,
  decayDelay: 18,
  decayPerSecond: 0.045,
  policeSpawnAt: 1,
  catchDistance: 4.4,
  catchTime: 3.2,
  stolenCarCrime: 0.85,
  hitPedestrianCrime: 1.15,
  combatCrime: 0.55,
  missionCrime: 0.72,
  sightRange: 52,
  wantedToPoliceRatio: 0.8,
};

export const MISSION = {
  firstDeadline: 150,
  firstReward: 1400,
  secondReward: 900,
  dropCount: 3,
  finalReward: 2600,
  sideDeliveryReward: 260,
  packageRadius: 4.2,
  deliveryRadius: 5,
  dropRadius: 4,
  respectPerJob: 15,
};

export const COLORS = {
  sky: '#8fd8e4',
  horizon: '#f5d3a0',
  grass: '#88aa72',
  grassDark: '#72956c',
  sand: '#e8d1a0',
  water: '#2796a5',
  deepWater: '#1b7186',
  road: '#49545a',
  roadMark: '#f5d48b',
  sidewalk: '#c7c0aa',
  curb: '#f0e3c8',
  buildings: ['#e6b985', '#d88c72', '#c0c5ad', '#deb875', '#89adb0', '#d7a199', '#e9d9b7'],
  windowGlow: '#ffd58a',
  windowDim: '#52707a',
  palm: '#547d56',
  trunk: '#8d6845',
  lamp: '#f8e0a8',
  pier: '#b38a61',
};

export const SPAWN = { x: -80, z: 84, heading: Math.PI };
