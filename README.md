[![make.fun · gta6-01](https://make.fun/badge/gta6-01.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![rank](https://make.fun/badge/gta6-01/banglento/neon-harbor/rank.svg)](https://make.fun/bounty/gta6-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![reward](https://make.fun/badge/gta6-01/banglento/neon-harbor/reward.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)

Competition: https://make.fun/bounty/gta6-01

Neon Harbor
===========

An original open-world crime game set in Solmar Bay, a sun-bleached coastal city of
palm-lined boulevards, pastel towers, a beach, a working harbour quay and a lighthouse
out past the pier. You play Mara Velez, a courier who has spent four years staying
invisible — until an old debt arrives in a sealed crate and asks for three deliveries.
Steal what you need, drive like the city owes you, keep the SBPD off your tail, and
make it to the harbour before the light goes out.

Everything here is written from scratch: the city, the cars, the people, the story, the
art (all geometry and canvas-generated textures) and the sound (all synthesized with
WebAudio). The only third-party code is the vendored three.js build. The game is plain
static files with no build step and no network requests — open it and play offline.

Features
--------

- A hand-built city grid: streets with lane markings and crosswalks, sidewalks, varied
  buildings with lit windows, a park with a pond, a plaza with a fountain, palms,
  streetlights, benches, a beach, a harbour promenade with bollards and railings, a
  pier on pilings, and a lighthouse.
- Third-person movement on foot with a mouse-orbit camera, sprinting, and collision
  against buildings.
- Parked and moving cars you can steal with E: six invented models, arcade handling,
  a chase camera, handbrake slides and cosmetic damage.
- Traffic that follows the road grid, keeps its lane, slows for obstacles and stops at
  jams, plus pedestrians who walk the sidewalks, step around each other and flee from
  speeding cars or a fight.
- A 0–5 star wanted system: crimes raise heat, patrol cars spawn and pursue, being
  cornered while slow gets you Busted, and hiding out of sight cools the heat down.
- Cartoonish combat-lite: punch or shove with F or a click.
- A three-mission story (Cold Package, Three Drops, Last Light) with briefings,
  on-HUD objectives, timers and minimap markers, plus repeatable courier runs for cash.
- Cash and respect progression with a localStorage save: New Game and Continue from the
  title screen.
- HUD with cash, condition, wanted stars, objective banner, speedometer and a live
  minimap drawn on a canvas.
- Synthesized audio: engine hum, siren, pickup chimes, UI clicks and an ambient loop;
  M mutes.
- Deterministic screenshot states via `?shot=` for the captured stills.

Controls
--------

    W A S D      move on foot / drive
    Mouse drag   orbit the camera (click also punches)
    Shift        sprint
    E            enter or exit a nearby car
    F / click    punch or shove
    Space        handbrake while driving
    H            horn
    Esc / P      pause menu
    M            mute

Run it
------

Requires Node 22.

    node serve.ts
    # then open http://localhost:8080

`serve.ts` serves the `game/` folder on port 8080 (`--port` to change it). Node 22 runs
the TypeScript entry points directly; there is no build step and nothing to install.

Layout
------

    game/index.html          page, HUD DOM, CSS, import map, boots src/main.js
    game/src/config.js       all constants and data tables
    game/src/util.js         maths, seeded RNG, rect collision
    game/src/input.js        keyboard/mouse state
    game/src/city.js         builds Solmar Bay and its road network
    game/src/vehicles.js     car factory and physics
    game/src/traffic.js      traffic AI on the road network
    game/src/pedestrians.js  sidewalk walkers and fleeing
    game/src/police.js       pursuit and the wanted system
    game/src/missions.js     story missions, objectives, courier runs
    game/src/hud.js          HUD updates and the minimap
    game/src/audio.js        WebAudio synth SFX and music
    game/src/save.js         localStorage save/load
    game/src/shots.js        deterministic ?shot= states
    game/src/main.js         game loop, player controller, camera
    game/vendor/             vendored three.js (MIT)
    tools/shoot.mjs          headless Chromium capture: node tools/shoot.mjs
    screenshots/             captured stills, first by name is the cover

License
-------

MIT. See LICENSE. three.js is MIT-licensed and vendored unmodified in
`game/vendor/three.module.min.js`.
