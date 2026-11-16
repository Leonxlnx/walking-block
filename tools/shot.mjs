// Capture stills of the scene with headless Chrome (GPU).
// Usage:
//   node tools/shot.mjs --shots ref1,ref2 --t 3.2 --w 1280 --h 720 --prefix a   -> shots/a_ref1.png ...
//   node tools/shot.mjs --shots ref2 --mods env,legs            (load only some modules)
//   node tools/shot.mjs --cam "-60,3,40,0,20,0,45" --name mycam (free camera: pos xyz, target xyz, fov; path-frame coords)
//   node tools/shot.mjs --shots ref1,ref2,ref3,ref4,ref5,ref6 --sheet   (also writes shots/<prefix>_sheet.jpg contact sheet)
//   --ts 0,1.5,3   capture several times for each shot (suffix _t<time>)
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
const W = +(args.w || 1280), H = +(args.h || 720);
const shots = args.cam ? [args.name || 'cam'] : String(args.shots || args.shot || 'ref2').split(',');
const times = String(args.ts || args.t || '2.0').split(',').map(Number);
const prefix = args.prefix || 's';
const outDir = path.resolve(ROOT, args.dir || 'shots');
fs.mkdirSync(outDir, { recursive: true });
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const { server, port } = await startServer(0);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-vsync', '--hide-scrollbars', '--mute-audio', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
let code = 0;
try {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || m.type() === 'warn') logs.push(`[${m.type()}] ${t}`); });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  const q = new URLSearchParams({ w: W, h: H, still: 1 });
  if (args.mods) q.set('mods', args.mods);
  if (args.q) for (const kv of String(args.q).split('&')) { const [k, v] = kv.split('='); q.set(k, v ?? '1'); }
  await page.goto(`http://127.0.0.1:${port}/?${q}`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction('window.__app !== undefined', { timeout: 240000 });
  const t0 = Date.now();
  const res = await page.evaluate(async () => { const r = await window.__app.ready; return { errors: r.errors, info: window.__app.info() }; });
  console.log(`ready in ${Date.now() - t0}ms  gl=${res.info.gl}  calls=${res.info.calls} tris=${res.info.tris}`);
  console.log('build ms per module: ' + JSON.stringify(res.info.buildMs));
  if (res.errors.length) { console.log('MODULE ERRORS:\n' + res.errors.join('\n')); code = 2; }
  const files = [];
  if (args.board) {
    // storyboard of the film timeline: N frames per segment
    const n = +(args.n || 3);
    const tl = await page.evaluate(async () => (await import('/src/shots.js')).TIMELINE);
    for (const seg of tl) for (let i = 0; i < n; i++) {
      const t = seg.start + (seg.end - seg.start) * (n === 1 ? 0.5 : (0.04 + 0.92 * i / (n - 1)));
      await page.evaluate((t) => { const app = window.__app; app.setShot(''); app.renderAt(t); app.renderAt(t); app.renderer.getContext().finish(); }, t);
      const file = path.join(outDir, `${prefix}_${seg.shot}_${i}.png`);
      await (await page.$('#c')).screenshot({ path: file, type: 'png' });
      files.push(file);
    }
    console.log(`storyboard: ${files.length} frames`);
    shots.length = 0; args.sheet = true; args.cols = args.cols || n;
  }
  for (const shot of shots) {
    for (const t of times) {
      const ms = await page.evaluate(async (shot, t, cam, mb) => {
        const app = window.__app;
        if (cam) { const v = cam.split(',').map(Number); app.setCam(v.slice(0, 3), v.slice(3, 6), v[6] || 45); } else app.setShot(shot);
        const a = performance.now();
        app.renderAt(t);
        if (mb > 1) app.renderBlur(t, mb, 0.01); else app.renderAt(t);
        app.renderer.getContext().finish();
        return performance.now() - a;
      }, shot, t, args.cam || null, +(args.mb || 1));
      const name = `${prefix}_${shot}${times.length > 1 ? '_t' + t : ''}.png`;
      const file = path.join(outDir, name);
      const el = await page.$('#c');
      await el.screenshot({ path: file, type: 'png' });
      files.push(file);
      console.log(`wrote shots/${name}  (2 frames ${ms.toFixed(0)}ms)`);
    }
  }
  if (logs.length) console.log('CONSOLE:\n' + [...new Set(logs)].slice(0, 30).join('\n'));
  if (args.sheet && files.length > 1) {
    const cols = +(args.cols || (files.length <= 4 ? 2 : 3));
    const cw = +(args.cw || 640), ch = Math.round(cw * H / W);
    const rows = Math.ceil(files.length / cols);
    const sp = await browser.newPage();
    await sp.setViewport({ width: cols * cw, height: rows * ch, deviceScaleFactor: 1 });
    const imgs = files.map((f) => `<img src="data:image/png;base64,${fs.readFileSync(f).toString('base64')}" style="width:${cw}px;height:${ch}px;display:block">`).join('');
    await sp.setContent(`<body style="margin:0;background:#000;display:grid;grid-template-columns:repeat(${cols},${cw}px)">${imgs}</body>`);
    const sheet = path.join(outDir, `${prefix}_sheet.jpg`);
    await sp.screenshot({ path: sheet, type: 'jpeg', quality: 88 });
    console.log(`wrote shots/${prefix}_sheet.jpg`);
  }
} catch (e) {
  console.error('SHOT FAILED:', e.message); code = 1;
} finally {
  await browser.close();
  server.close();
}
process.exit(code);
