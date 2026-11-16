// Offline frame renderer: headless Chrome (GPU) -> PNG frames on disk. Resumable.
// Usage:
//   node tools/render.mjs --w 1920 --h 1080 --fps 30 --from 0 --to 45 --dir out/frames [--mb 1] [--force]
//   --shot NAME   render a single shot preset instead of the film timeline
//   --every N     render only every Nth frame (previews)
// Frames are named f_000000.png (index = round(t*fps)). Existing files are skipped unless --force.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); const n = process.argv[i + 1]; if (n === undefined || n.startsWith('--')) args[k] = true; else { args[k] = n; i++; } }
}
const W = +(args.w || 1920), H = +(args.h || 1080), FPS = +(args.fps || 30);
const from = +(args.from || 0), to = +(args.to || 45), every = +(args.every || 1);
const MB = +(args.mb || 1);                 // motion-blur sub-samples (1 = off)
const dir = path.resolve(ROOT, args.dir || 'out/frames');
fs.mkdirSync(dir, { recursive: true });
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const RESTART_EVERY = +(args.restart || 400);   // relaunch the browser periodically to keep memory flat

const f0 = Math.round(from * FPS), f1 = Math.round(to * FPS);
const todo = [];
for (let f = f0; f < f1; f += every) {
  const file = path.join(dir, `f_${String(f).padStart(6, '0')}.png`);
  if (args.force || !fs.existsSync(file) || fs.statSync(file).size < 1000) todo.push([f, file]);
}
console.log(`frames ${f0}..${f1 - 1}: ${todo.length} to render at ${W}x${H}, mb=${MB}`);
if (!todo.length) process.exit(0);

const { server, port } = await startServer(0);
async function launch() {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
    args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-vsync', '--hide-scrollbars', '--mute-audio', `--window-size=${W},${H}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
    defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const q = new URLSearchParams({ w: W, h: H, still: 1 });
  if (args.q) for (const kv of String(args.q).split('&')) { const [k, v] = kv.split('='); q.set(k, v ?? '1'); }
  await page.goto(`http://127.0.0.1:${port}/?${q}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction('window.__app !== undefined', { timeout: 120000 });
  const res = await page.evaluate(async (shot) => { const r = await window.__app.ready; if (shot) window.__app.setShot(shot); return r.errors; }, args.shot || '');
  if (res.length) console.log('MODULE ERRORS:\n' + res.join('\n'));
  return { browser, page };
}

let { browser, page } = await launch();
const tStart = Date.now();
let done = 0;
try {
  for (const [f, file] of todo) {
    if (done > 0 && done % RESTART_EVERY === 0) { await browser.close(); ({ browser, page } = await launch()); }
    const b64 = await page.evaluate(async (t, mb, fps) => {
      const app = window.__app;
      if (mb > 1 && app.renderBlur) app.renderBlur(t, mb, 0.3 / fps); else app.renderAt(t);
      const cv = document.getElementById('c');
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = ''; const CH = 0x8000;
      for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
      return btoa(s);
    }, f / FPS, MB, FPS);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    done++;
    if (done % 15 === 0 || done === todo.length) {
      const el = (Date.now() - tStart) / 1000;
      console.log(`${done}/${todo.length}  ${(el / done).toFixed(2)} s/frame  eta ${((todo.length - done) * el / done / 60).toFixed(1)} min`);
    }
  }
} catch (e) {
  console.error('RENDER FAILED at frame', done, e.message);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  server.close();
}
