// tools/shoot.mjs — capture the four hand-in screenshots from the real game.
//
//   node tools/shoot.mjs
//
// What it does, in order:
//   1. starts `node serve.ts` on 127.0.0.1:8080 and waits for it to answer;
//   2. launches the Playwright Chromium build found under ~/.cache/ms-playwright
//      with --headless=new and software WebGL (--enable-unsafe-swiftshader),
//      then drives it over the DevTools protocol. No npm dependencies: Node 24
//      ships fetch and WebSocket, which is everything CDP needs;
//   3. for each ?shot=<state> it navigates, records console/page errors, and
//      waits for window.__shotReady === true before taking a 1280x720 PNG;
//   4. converts each PNG to JPEG in screenshots/ with ffmpeg, stepping the
//      quality down if a file would exceed 256 KiB;
//   5. kills Chromium and the server.
//
// It never invents pixels: every JPEG is a conversion of a frame Chromium
// actually rendered.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const scratch = join(repo, '.shoot'); // PNGs and the Chromium profile live here
const SHOTS = join(repo, 'screenshots');

const PORT = 8080;
const BASE = `http://localhost:${PORT}`;
const WIDTH = 1280;
const HEIGHT = 720;
const MAX_BYTES = 256 * 1024;
const READY_TIMEOUT_MS = 120000;

// screenshots/ name, ?shot= state, seed
const STATES = [
  { file: '1-cover.jpg', shot: 'cover', seed: 1 },
  { file: '2-chase.jpg', shot: 'chase', seed: 1 },
  { file: '3-foot.jpg', shot: 'foot', seed: 1 },
  { file: '4-start.jpg', shot: 'start', seed: 1 },
];

// `--only=cover,foot` re-shoots a subset after a game edit.
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim()) : null;
const STATES_TO_RUN = only ? STATES.filter((s) => only.includes(s.shot)) : STATES;

const CHROMIUM_CANDIDATES = [
  join(homedir(), '.cache/ms-playwright/chromium-1255/chrome-linux64/chrome'),
  join(homedir(), '.cache/ms-playwright/chromium-1255/chrome-linux/chrome'),
  join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell'),
];

function findChromium() {
  for (const candidate of CHROMIUM_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  // Any other Playwright Chromium build, newest directory name first.
  const root = join(homedir(), '.cache/ms-playwright');
  if (existsSync(root)) {
    for (const dir of readdirSync(root).sort().reverse()) {
      if (!dir.startsWith('chromium')) continue;
      for (const tail of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
        const p = join(root, dir, tail);
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error('no Playwright Chromium found under ~/.cache/ms-playwright');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/index.html`, { cache: 'no-store' });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`server did not answer on ${BASE} within ${timeoutMs}ms`);
}

async function waitForDebugger(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error('Chromium did not open its debugging port');
}

// ---------------------------------------------------------------- CDP client
// One socket for the browser target; page work runs through a flat session.
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) for (const fn of this.listeners) fn(msg);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP socket failed')), { once: true });
    });
    return new Cdp(ws);
  }

  on(fn) {
    this.listeners.push(fn);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

// ------------------------------------------------------------------- ffmpeg
function toJpeg(pngPath, jpgPath) {
  // q:v 4 first, then step down until the file fits the 256 KiB budget.
  for (const q of [4, 6, 8, 11, 14]) {
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', pngPath,
      '-vf', `scale=${WIDTH}:${HEIGHT}:flags=lanczos`,
      '-pix_fmt', 'yuvj420p',
      '-q:v', String(q),
      jpgPath,
    ]);
    const size = statSync(jpgPath).size;
    if (size <= MAX_BYTES) return { size, quality: q };
  }
  throw new Error(`${jpgPath} is ${statSync(jpgPath).size} bytes even at q:v 14`);
}

function imageSize(path) {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0',
    path,
  ]).toString().trim();
  const [w, h] = out.split(',').map(Number);
  return { width: w, height: h };
}

// --------------------------------------------------------------------- main
async function main() {
  for (const dir of [scratch, SHOTS]) mkdirSync(dir, { recursive: true });

  const chromium = findChromium();
  console.log(`chromium: ${chromium}`);

  // ---- 1. the static server
  const serverLog = join(scratch, 'server.log');
  const server = spawn(process.execPath, ['serve.ts'], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLogText = '';
  server.stdout.on('data', (d) => {
    serverLogText += d.toString();
  });
  server.stderr.on('data', (d) => {
    serverLogText += d.toString();
  });
  let serverDead = false;
  server.on('exit', () => {
    serverDead = true;
  });

  let chrome = null;
  let cdp = null;
  const consoleErrors = [];
  const pageErrors = [];

  try {
    await waitForServer();
    console.log(`server: ${BASE} is up`);

    // ---- 2. Chromium
    const port = 9333;
    const profile = join(scratch, 'profile');
    rmSync(profile, { recursive: true, force: true });
    mkdirSync(profile, { recursive: true });

    chrome = spawn(
      chromium,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        // Software WebGL is the only backend on this VM; without this flag
        // every WebGL context creation fails and the frames come out blank.
        '--enable-unsafe-swiftshader',
        '--disable-dev-shm-usage',
        '--hide-scrollbars',
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--force-device-scale-factor=1',
        `--window-size=${WIDTH},${HEIGHT}`,
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${port}`,
        'about:blank',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Chromium's process-singleton socket lives in TMPDIR, and the session
        // scratch path is long enough to overflow the 108-byte unix limit.
        env: { ...process.env, TMPDIR: '/tmp' },
      },
    );
    chrome.stdout.on('data', () => {});
    chrome.stderr.on('data', () => {});

    const info = await waitForDebugger(port);
    cdp = await Cdp.connect(info.webSocketDebuggerUrl);

    cdp.on((msg) => {
      if (msg.method === 'Runtime.exceptionThrown') {
        const details = msg.params?.exceptionDetails ?? {};
        pageErrors.push(details.exception?.description ?? details.text ?? 'unknown exception');
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        const text = (msg.params.args ?? [])
          .map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
          .join(' ');
        consoleErrors.push(text);
      } else if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
        consoleErrors.push(`${msg.params.entry.source}: ${msg.params.entry.text}`);
      } else if (msg.method === 'Network.responseReceived' && msg.params?.response?.status >= 400) {
        // Name the URL, not just "a 404", so a stray asset request is obvious.
        consoleErrors.push(`HTTP ${msg.params.response.status} ${msg.params.response.url}`);
      }
    });

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: S } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    await cdp.send('Page.enable', {}, S);
    await cdp.send('Runtime.enable', {}, S);
    await cdp.send('Log.enable', {}, S);
    await cdp.send('Network.enable', {}, S);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false },
      S,
    );

    const results = [];

    for (const state of STATES_TO_RUN) {
      const url = `${BASE}/?shot=${state.shot}&seed=${state.seed}`;
      const errorsBefore = consoleErrors.length + pageErrors.length;
      const started = Date.now();
      console.log(`[${new Date().toISOString().slice(11, 19)}] ${state.shot}: ${url}`);
      await cdp.send('Page.navigate', { url }, S);

      // Poll the game's own ready flag. shots.js freezes the world, renders a
      // few held frames and only then flips window.__shotReady.
      const deadline = Date.now() + READY_TIMEOUT_MS;
      let ready = false;
      let bootError = '';
      while (Date.now() < deadline) {
        try {
          const res = await cdp.send(
            'Runtime.evaluate',
            { expression: 'window.__shotReady === true', returnByValue: true },
            S,
          );
          if (res?.result?.value === true) {
            ready = true;
            break;
          }
          // Surface a boot failure instead of polling for two minutes.
          const failed = await cdp.send(
            'Runtime.evaluate',
            {
              expression:
                "(() => { const b = document.getElementById('boot-error'); return b && b.style.display === 'flex' ? b.textContent : ''; })()",
              returnByValue: true,
            },
            S,
          );
          bootError = failed?.result?.value ?? '';
          if (bootError) break;
        } catch {
          /* document not ready to evaluate yet */
        }
        await sleep(120);
      }

      if (!ready) {
        throw new Error(`shot ${state.shot} never became ready${bootError ? `: ${bootError}` : ''}`);
      }

      // Prove the frame is a real render, not an empty composite: draw calls,
      // triangles and live actors, straight out of the game's own renderer.
      const diag = await cdp.send(
        'Runtime.evaluate',
        {
          expression: `(() => {
            const n = window.__neon;
            if (!n) return null;
            const info = n.ctx.renderer.info.render;
            return JSON.stringify({
              calls: info.calls,
              triangles: info.triangles,
              sceneChildren: n.ctx.scene.children.length,
              vehicles: n.ctx.vehicles.list ? n.ctx.vehicles.list.length : -1,
              peds: n.peds.list ? n.peds.list.length : -1,
              traffic: n.ctx.traffic.cars ? n.ctx.traffic.cars.length : -1,
              police: n.police.cars ? n.police.cars.length : -1,
              onFoot: !!(n.player.onFoot),
            });
          })()`,
          returnByValue: true,
        },
        S,
      );
      const stats = diag?.result?.value ? JSON.parse(diag.result.value) : null;
      if (stats && (!stats.calls || !stats.triangles)) {
        throw new Error(`shot ${state.shot} rendered nothing (calls ${stats.calls}, tris ${stats.triangles})`);
      }

      // A short settle so the compositor definitely holds the frozen frame.
      await sleep(220);

      const capture = await cdp.send(
        'Page.captureScreenshot',
        { format: 'png', fromSurface: true, captureBeyondViewport: false },
        S,
      );
      const pngPath = join(scratch, `${state.shot}.png`);
      writeFileSync(pngPath, Buffer.from(capture.data, 'base64'));

      const jpgPath = join(SHOTS, state.file);
      const { size, quality } = toJpeg(pngPath, jpgPath);
      const { width, height } = imageSize(jpgPath);
      const newErrors = consoleErrors.length + pageErrors.length - errorsBefore;

      results.push({ ...state, bytes: size, width, height, quality, errors: newErrors, stats });
      console.log(
        `${state.file}: ${width}x${height} ${(size / 1024).toFixed(1)} KiB (q ${quality}, png ${(statSync(pngPath).size / 1024).toFixed(0)} KiB)` +
          (newErrors ? ` — ${newErrors} console error(s)` : ' — clean') +
          ` [${((Date.now() - started) / 1000).toFixed(1)}s]`,
      );
      if (stats) {
        console.log(
          `    draw calls ${stats.calls}, ${stats.triangles.toLocaleString('en-US')} tris, ` +
            `${stats.vehicles} vehicles, ${stats.traffic} traffic, ${stats.police} cruisers, ` +
            `${stats.peds} peds, onFoot=${stats.onFoot}`,
        );
      }
    }

    console.log('');
    console.log(`console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors.slice(0, 20)) console.log(`  - ${e}`);
    console.log(`page errors: ${pageErrors.length}`);
    for (const e of pageErrors.slice(0, 20)) console.log(`  - ${e}`);
    console.log('');
    console.log(results.map((r) => `${r.file}=${(r.bytes / 1024).toFixed(1)}KiB`).join(' '));

    if (pageErrors.length || consoleErrors.length) process.exitCode = 1;
  } finally {
    try {
      if (cdp) cdp.close();
    } catch {
      /* ignore */
    }
    if (chrome && !chrome.killed) {
      try {
        chrome.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    if (server && !serverDead) {
      try {
        server.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      await sleep(200);
      try {
        if (!serverDead) server.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    writeFileSync(join(scratch, 'server.log'), serverLogText);
    rmSync(join(scratch, 'profile'), { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`shoot failed: ${err.message}`);
  try {
    const log = readFileSync(join(scratch, 'server.log'), 'utf8');
    if (log) console.error(`--- server.log ---\n${log.slice(-2000)}`);
  } catch {
    /* no log */
  }
  process.exitCode = 1;
}).finally(() => {
  // The Chromium socket and child stdio streams can keep the event loop warm
  // after everything is captured; the work is done, so leave deliberately.
  setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
});
