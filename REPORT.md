NEON HARBOR — SESSION 4 BUILD REPORT

Systems checklist
[✓] Solmar Bay city, street grid, neighborhoods, coast and harbor landmarks
[✓] On-foot movement and camera
[✓] Cars, theft/entry/exit, driving and vehicle damage
[✓] Ambient traffic
[✓] Pedestrians, sidewalk routes and reactions
[✓] Wanted level and police pursuit
[✓] Combat-lite shove and non-graphic knockdown
[✓] Three linked story missions
[✓] Repeatable courier side activity
[✓] Save / continue
[✓] HUD, objective markers and minimap
[✓] Procedural synth audio and effects
[✓] Start screen
[✓] Pause / resume

Verification
- `MAKEFUN_OUTPUT_DIR=out node main.ts` completed successfully. Confirmed `out/game`, `out/screenshots`, and `out/dossier.json` existed; the temporary `out/` directory was removed afterwards.
- Dossier totals: 18 files and directories, 788,301 bytes. Game source files: 15 (117,620 bytes); vendored files: 1 (670,681 bytes). Four screenshots included.
- Browser staged captures used Chromium and waited for `window.__shotReady === true`. Console errors: 0 across all four states.
- Screenshot inventory: exactly four JPEGs. All are 1280x720 and below the 256 KiB limit:
  - 1-cover.jpg — 91,348 bytes
  - 2-chase.jpg — 89,644 bytes
  - 3-foot.jpg — 78,055 bytes
  - 4-start.jpg — 61,818 bytes
- Final game/ tree: 16 files, 788,301 bytes (well below 993 entries and 48 MiB).

Revision in this session
- In `game/src/pedestrians.js`, lowered the speed and distance thresholds for pedestrian vehicle-avoidance reactions. Walkers now flee from a car traveling over 4 units/second within 12 units, rather than requiring over 8 units/second within 18 units. This makes the near-miss response easier to trigger in normal city driving. Re-shot all staged screenshots; the change did not affect their staged results. Shoot rerun: zero page console errors.
- Added an empty data-URL favicon to `game/index.html` to avoid a browser-generated missing-favicon 404 during captures.

Weaknesses / next iteration ideas
- The city is a compact, low-poly grid with relatively simple building silhouettes and limited visual variety; expand the map and landmarks.
- Police are represented by chase cars and wanted stars, but pursuit behavior and route finding remain arcade-simple; improve traffic-aware navigation and stronger visual police cues.
- On-foot combat is intentionally minimal, and NPC behavior/animation variety is limited; add richer reactions and more distinct pedestrian routines.
- Add more vehicle interaction feedback and additional mission branches, route variety, and progression beyond the three core story missions.
