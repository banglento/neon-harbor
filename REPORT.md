NEON HARBOR — SOLMAR BAY
Session 4 build report (finishing pass)

What this is
------------
An original three.js open-world crime game: Mara Velez, a courier in the
coastal city of Solmar Bay, running three story jobs and repeatable side work
while the SBPD closes in. Everything is hand-written — the city geometry, the
cars, the people, the story, the HUD, the WebAudio synth — with the vendored
three.js build as the only third-party code. Plain static files, no build step,
no network requests.

This session wrote tools/shoot.mjs from scratch, re-shot all four screenshots
from real Chromium renders of this build, ran the hand-in, and made one
revision to an earlier session's game code.


Systems checklist
-----------------
[x] The city of Solmar Bay — 6x6 block grid with lane-marked streets,
    crosswalks, sidewalks, varied lit buildings, a park with a pond, a plaza
    with a fountain, palms, streetlights, benches, a beach, a harbour
    promenade with bollards and railings, a pier on pilings and a lighthouse
[x] On-foot movement — camera-relative WASD, sprint, mouse orbit, building
    collision, walk cycle and punch animation
[x] Cars — six invented models, enter/exit with E, arcade handling, handbrake
    slides, chase camera, cosmetic damage plus smoke past the damage threshold
[x] Car theft as a crime — witnesses count, heat rises if someone saw it
[x] Ambient traffic — lane-following AI on the road network, junction turns,
    obstacle braking, jam detection, horn when wedged, recycling when stuck
[x] Pedestrians — 46 walkers on sidewalk loops, mutual avoidance, shoving out
    of cars, fleeing from fast traffic / police / violence, knockdown and get-up
[x] Wanted level and police — 0-5 stars from a crime feed, patrol cars spawn
    and pursue, Busted when cornered while slow, heat decays out of sight
[x] Combat-lite — punch/shove with F or click, non-graphic knockdowns
[x] Three story missions — Cold Package (timed delivery), Three Drops (three
    pickups, heat climbing), Last Light (reach the pier under four stars, then
    hold while the heat scrubs off)
[x] Courier side activity — repeatable pickup-and-drop runs for cash (C key)
[x] Save / continue — localStorage, autosave every 30s, resume at the first
    unfinished job
[x] HUD — objective panel with timer, cash, respect bar, wanted stars,
    condition, speedometer and car health, district label, toasts, prompts
[x] Minimap — canvas-rendered city, player heading, objective marker
[x] Synth audio — all WebAudio: engine, tyres, horn, crash, sirens, chimes,
    wanted sting, ambient music bed, mute toggle
[x] Start screen — title card, story blurb, New Game / Continue / Controls,
    save info
[x] Pause — Esc/Tab overlay with Resume, Save, Restart, Sound, Quit to title
[x] Boot guard — a readable error box if the module graph fails


Verification results
--------------------
1. Screenshot capture — tools/shoot.mjs
   Written this session. It starts `node serve.ts`, waits for
   http://localhost:8080 to answer, launches the Playwright Chromium under
   ~/.cache/ms-playwright (chromium-1255) with --headless=new --disable-gpu
   --enable-unsafe-swiftshader --hide-scrollbars --window-size=1280,720, drives
   it over the DevTools protocol using Node's built-in fetch and WebSocket (no
   npm dependency), records console and page errors, polls
   window.__shotReady === true for each ?shot= state, captures a 1280x720 PNG,
   converts it with ffmpeg to JPEG at -q:v 4 (stepping the quality down if a
   file would exceed 256 KiB), and kills Chromium and the server when done.

   Each capture has to clear a render check first: the tool reads
   renderer.info.render and refuses a frame with zero draw calls or zero
   triangles, so a blank composite cannot pass as a screenshot.

2. Capture run
   1-cover.jpg  1280x720  105,332 B (q 4; 1513 draw calls, 43,300 tris,
                46 vehicles, 17 traffic, 46 pedestrians)
   2-chase.jpg  1280x720  112,511 B (q 4; 1205 draw calls, 37,416 tris,
                2 police cruisers on the bumper, 16 traffic)
   3-foot.jpg   1280x720   85,034 B (q 4;  647 draw calls, 28,704 tris,
                on foot, pedestrians dressed along the sidewalk)
   4-start.jpg  1280x720   73,993 B (q 4;  282 draw calls, 21,550 tris,
                title card over the harbour)

   All four are 1280x720 JPEGs, all well under the 256 KiB cap. Screenshots
   hold exactly those four files and nothing else.
   Frame content was checked numerically, not just by byte size: unique colour
   counts of 5,256-11,441 per frame on a 200x112 sample, full 0-254 luminance
   range, and mean luma of 42-92, so none of them is a blank or black frame.

3. Console status
   Final run: 0 console errors, 0 page errors, across all four states.

4. Hand-in
   `mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts` completed with exit 0.
   out/game, out/screenshots and out/dossier.json all present; out/game holds
   the full 16-file game tree and out/screenshots the four JPEGs, and the
   dossier embeds all four with sha256 hashes.
   Dossier totals: 18 files and directories, 972,150 bytes. Source files: 15
   (301,469 bytes), vendored: 1 (three.module.min.js, 670,681 bytes), assets:
   none. Dossier text: 163,813 of the 163,840-byte cap — it fits, but only just,
   and the tail of the source listing is cut with a note. out/ was deleted
   afterwards.

5. Caps
   game/: 16 files in 3 directories, 972,150 bytes (~0.93 MiB).
   Caps are 993 entries and 48 MiB, so there is roughly 50x headroom on size.
   screenshots/: exactly 4 JPEGs, 376,870 bytes total.

6. shots.json
   Lists the four names with their queries:
   ?shot=cover&seed=1, ?shot=chase&seed=1, ?shot=foot&seed=1,
   ?shot=start&seed=1


The revision made this session
------------------------------
Honking did nothing except play a blip, and the traffic system's horn was
entirely silent. Two connected fixes to earlier sessions' code:

game/src/pedestrians.js — new `peds.startle(x, z, radius, source)` reaction.
  Walkers within the radius break into a short flinch (flee timer capped at
  1.7 s by a new PED.hornFleeTime) and then go back to their errand, which is
  deliberately different from scare(), which empties the whole street. It
  skips anyone already down or getting up, and it will not overwrite a real
  panic: if a pedestrian is already fleeing because of a car, the police or a
  fight, the horn leaves that alone.

game/src/main.js — registered the traffic horn hook. traffic.js has declared
  `hooks.onHorn` and fired it when a car is wedged, but nothing ever called
  registerHooks, so the callback was always null and the horn never sounded.
  It now plays the horn blip and startles the nearby pavement, so a jam is
  audible and visible. The player's own horn (H) does the same within 15 m.

Verified live in Chromium against ?shot=foot: startle flagged 2 walkers, both
with a 1.7 s timer; a pedestrian already fleeing from a fight stayed on the
fight panic after a horn; traffic.hooks.onHorn is now a function rather than
null.

Also fixed: the only console error in the whole capture run was a
/favicon.ico 404 the browser requested on its own. game/index.html now carries
an inline SVG data-URI favicon, so the run is clean at zero errors rather than
one benign one.

Because main.js and pedestrians.js changed, all four screenshots were
re-captured afterwards and re-verified at 1280x720 and under 256 KiB.


Known weaknesses / next iteration
---------------------------------
- The dossier text is at 99.98% of its byte cap. Any further source growth
  pushes another file out of the listing the judge reads, so the next session
  should trim comments rather than add files, or the listing will thin out.
- The city is a compact low-poly grid. Building silhouettes repeat, there are
  no interiors, and the districts differ in palette and props more than in
  layout.
- Police pursuit is arcade-simple: cruisers drive at the player rather than
  running a road-network pursuit with roadblocks or PIT manoeuvres, and stars
  are the only feedback for how close a bust is.
- On-foot combat is one punch. There is no aiming, no weapons, no cover and no
  health beyond the condition bar.
- Pedestrian routines are loops around one block; nobody crosses a street,
  enters a shop or reacts to the player by name.
- Traffic is lane-following only; it does not yield to the player or to police
  lights, and it recycles rather than routing around a long blockage.
- Three story missions is a short arc, and the courier run reuses the same
  pickup-then-drop shape every time with randomised points.
- Screenshots are software-rendered through SwiftShader (the only WebGL path
  on this machine), so shadows and antialiasing look softer than the game does
  on real hardware.
- The start screen is a still camera over the harbour with a live city behind
  the card; there is no attract-mode driving.
