import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const root = resolve(new URL('..', import.meta.url).pathname);
const shotsDir = join(root, 'screenshots');
const states = [
  ['cover', '1-cover.jpg'],
  ['chase', '2-chase.jpg'],
  ['foot', '3-foot.jpg'],
  ['start', '4-start.jpg'],
];
const browserCandidates = [
  join(homedir(), '.cache/ms-playwright/chromium-1255/chrome-linux64/chrome'),
  join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell'),
];
const chromium = browserCandidates.find(existsSync);
if (!chromium) throw new Error('Chromium 1255 binary not found in ~/.cache/ms-playwright');
if (typeof WebSocket !== 'function') throw new Error('This Node build does not provide the WebSocket API needed for CDP');

const scratch = mkdtempSync(join('/tmp', 'neon-harbor-shoot-'));
const profileAlias = join(root, '.shoot-profile');
symlinkSync(scratch, profileAlias, 'dir');
let server;
let browser;
let stderr = '';
let socket;
let nextId = 1;
const pending = new Map();
const sessions = new Map();
const consoleErrors = [];

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const message = { id, method, params };
  if (sessionId) message.sessionId = sessionId;
  return new Promise((resolvePromise, rejectPromise) => {
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
    socket.send(JSON.stringify(message));
  });
}

function connectDebugger(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    socket = new WebSocket(url);
    socket.addEventListener('open', () => resolvePromise());
    socket.addEventListener('error', (event) => rejectPromise(new Error(`CDP websocket error: ${event.message ?? 'unknown'}`)));
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const task = pending.get(message.id);
        if (!task) return;
        pending.delete(message.id);
        if (message.error) task.reject(new Error(message.error.message));
        else task.resolve(message.result);
        return;
      }
      if (message.method === 'Target.attachedToTarget') sessions.set(message.params.targetInfo.targetId, message.params.sessionId);
      if (message.method === 'Runtime.exceptionThrown') {
        consoleErrors.push({ type: 'exception', text: message.params.exceptionDetails.text, description: message.params.exceptionDetails.exception?.description ?? '' });
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        consoleErrors.push({ type: 'console.error', text: message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ') });
      }
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        consoleErrors.push({ type: 'page-log', text: message.params.entry.text });
      }
    });
  });
}

async function waitForServer() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://localhost:8080/');
      if (response.ok) return;
    } catch {}
    await delay(200);
  }
  throw new Error('node serve.ts did not answer at http://localhost:8080 within 20 seconds');
}

async function launchBrowser() {
  browser = spawn(chromium, [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1280,720',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profileAlias}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } });
  browser.stderr.setEncoding('utf8');
  browser.stderr.on('data', (chunk) => { stderr += chunk; });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) {
      await connectDebugger(match[1]);
      return;
    }
    if (browser.exitCode !== null) throw new Error(`Chromium exited early (${browser.exitCode}): ${stderr}`);
    await delay(100);
  }
  throw new Error(`Timed out starting Chromium: ${stderr}`);
}

function runFfmpeg(input, output, quality) {
  const result = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', input, '-frames:v', '1', '-q:v', String(quality), output], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr}`);
}

try {
  mkdirSync(shotsDir, { recursive: true });
  server = spawn('node', ['serve.ts'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverOutput = '';
  server.stdout.setEncoding('utf8');
  server.stderr.setEncoding('utf8');
  server.stdout.on('data', (chunk) => { serverOutput += chunk; });
  server.stderr.on('data', (chunk) => { serverOutput += chunk; });
  await waitForServer();
  await launchBrowser();

  for (const [state, filename] of states) {
    consoleErrors.length = 0;
    const target = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Log.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send('Page.navigate', { url: `http://localhost:8080/?shot=${state}&seed=1` }, sessionId);

    const deadline = Date.now() + 60000;
    let ready = false;
    while (Date.now() < deadline) {
      const result = await send('Runtime.evaluate', { expression: 'window.__shotReady === true', returnByValue: true }, sessionId);
      if (result.result?.value === true) { ready = true; break; }
      await delay(150);
    }
    if (!ready) throw new Error(`Timed out waiting for __shotReady on shot=${state}`);
    await delay(400);
    const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true }, sessionId);
    const pngPath = join(scratch, `${state}.png`);
    const jpgPath = join(shotsDir, filename);
    writeFileSync(pngPath, Buffer.from(image.data, 'base64'));
    let quality = 4;
    runFfmpeg(pngPath, jpgPath, quality);
    while ((await import('node:fs')).statSync(jpgPath).size > 256 * 1024 && quality < 31) {
      quality += 1;
      runFfmpeg(pngPath, jpgPath, quality);
    }
    if ((await import('node:fs')).statSync(jpgPath).size > 256 * 1024) throw new Error(`${filename} exceeds the 256 KiB cap`);
    const shotErrors = consoleErrors.slice();
    console.log(JSON.stringify({ state, file: filename, bytes: (await import('node:fs')).statSync(jpgPath).size, quality, consoleErrors: shotErrors }));
    if (shotErrors.length) throw new Error(`Browser console errors during shot=${state}; fix before handing in`);
    await send('Target.closeTarget', { targetId: target.targetId });
  }
  console.log('All four browser shots rendered with zero page console errors.');
} finally {
  try { socket?.close(); } catch {}
  if (browser && browser.exitCode === null) browser.kill('SIGTERM');
  if (server && server.exitCode === null) server.kill('SIGTERM');
  await delay(250);
  try { unlinkSync(profileAlias); } catch {}
  rmSync(scratch, { recursive: true, force: true });
}
