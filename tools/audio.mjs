// Builds the film soundtrack: music bed + SFX placed from the (closed-form) gait and the shot timeline.
// All source audio is downloaded material (see audio/CREDITS.md) — nothing is synthesized here.
// Usage: node tools/audio.mjs [--out out/audio.wav] [--music the_long_dark] [--mstart s] [--sfxrel -1] [--lufs -15]
//        [--nomusic] [--nosfx] [--stems] (writes out/stem_music.wav + out/stem_sfx.wav)  [--quiet] (no verification table)
// Every time comes from src/gait.js (touchdowns / lift-offs) and src/shots.js (camera, shot boundaries) at run time.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) { const k = a.slice(2); const n = process.argv[i + 1]; if (n === undefined || n.startsWith('--')) args[k] = true; else { args[k] = n; i++; } }
}
const gait = await import(pathToFileURL(path.join(ROOT, 'src/gait.js')));
const shots = await import(pathToFileURL(path.join(ROOT, 'src/shots.js')));
const { GAIT, LEGS, NLEGS, SPEED } = gait;
const SR = 48000, DUR = shots.DURATION, N = Math.round(DUR * SR);
const L = new Float32Array(N), R = new Float32Array(N);

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = mulberry32(4242);
const heroHits = [];   // [time, strength] of touchdowns close to the camera (music ducks for them)

const WHO = args.who ? new Map() : null;   // --who: energy each source file contributes per shot (pre-mix, for balancing)
const who = (s, d, v) => { let a = WHO.get(s.name); if (!a) WHO.set(s.name, a = new Float64Array(64)); a[shotIdx[d >> 10]] += v * v; };
let shotIdx = null;
const cache = new Map();
function stats(s) {
  let pk = 0, pkI = 0, env = 0, epk = 0, sq = 0;
  for (let i = 0; i < s.n; i++) {
    const m = Math.max(Math.abs(s.l[i]), Math.abs(s.r[i]));
    sq += m * m;
    if (m > pk) pk = m;
    env += (m - env) * 0.0015;                       // ~14 ms envelope
    if (env > epk) { epk = env; pkI = i; }
  }
  s.peak = pk || 1; s.peakT = pkI / SR; s.rms = Math.sqrt(sq / Math.max(1, s.n)) || 1;
  let on = 0; while (on < s.n && Math.max(Math.abs(s.l[on]), Math.abs(s.r[on])) < 0.3 * s.peak) on++;
  s.onT = on / SR;                                   // first sample above 30 % of the peak = the transient
  return s;
}
function load(rel, { ss = 0, t = 0 } = {}) {
  const key = rel + '|' + ss + '|' + t;
  if (cache.has(key)) return cache.get(key);
  const a = ['-v', 'error'];
  if (ss) a.push('-ss', String(ss));
  if (t) a.push('-t', String(t));
  a.push('-i', path.join(ROOT, 'audio', rel), '-f', 'f32le', '-ac', '2', '-ar', String(SR), '-');
  const r = spawnSync('ffmpeg', a, { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error('decode failed ' + rel + ': ' + r.stderr);
  const f = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, Math.floor(r.stdout.length / 4));
  const n = f.length / 2, l = new Float32Array(n), rr = new Float32Array(n);
  for (let i = 0; i < n; i++) { l[i] = f[2 * i]; rr[i] = f[2 * i + 1]; }
  const s = stats({ l, r: rr, n });
  s.name = path.basename(rel).replace(/\.\w+$/, '');
  cache.set(key, s);
  return s;
}
const sfx = (name, o) => load('sfx/' + name + '.mp3', o);

// Place a sample. o: { at (s, where 'anchor' seconds into the sample lands), anchor, gain, pan(-1..1), lp (Hz, 0=off),
//   hp (Hz), rate (playback speed), dur (s, truncate), fadeIn, fadeOut (s),
//   norm: default = peak-normalize first; 'rms' = level by RMS (dense, sustained sources such as groans); false = as recorded }
// Every placed sample is faded in and out, so nothing starts or stops abruptly.
function place(s, o) {
  const rate = o.rate ?? 1, g = (o.gain ?? 1) / (o.norm === false ? 1 : o.norm === 'rms' ? 8 * s.rms : s.peak);
  if (!(g > 0)) return;
  const pan = Math.max(-1, Math.min(1, o.pan ?? 0));
  const gl = g * Math.cos((pan + 1) * Math.PI / 4) * 1.414, gr = g * Math.sin((pan + 1) * Math.PI / 4) * 1.414;
  let len = Math.floor(s.n / rate);
  if (o.dur) len = Math.min(len, Math.round(o.dur * SR));
  const start = Math.round(((o.at ?? 0) - (o.anchor ?? 0) / rate) * SR);
  const fi = Math.max(1, Math.round((o.fadeIn ?? 0.004) * SR)), fo = Math.max(1, Math.min(len, Math.round((o.fadeOut ?? 0.03) * SR)));
  const aL = o.lp ? 1 - Math.exp(-2 * Math.PI * o.lp / SR) : 1;
  const aH = o.hp ? 1 - Math.exp(-2 * Math.PI * o.hp / SR) : 0;
  let yl = 0, yr = 0, yl2 = 0, yr2 = 0, hl = 0, hr = 0, hl2 = 0, hr2 = 0;
  for (let i = 0; i < len; i++) {
    const d = start + i;
    if (d >= N) break;
    const p = i * rate, i0 = Math.floor(p), fr = p - i0, i1 = Math.min(s.n - 1, i0 + 1);
    let xl = s.l[i0] + (s.l[i1] - s.l[i0]) * fr, xr = s.r[i0] + (s.r[i1] - s.r[i0]) * fr;
    if (o.lp) { yl += (xl - yl) * aL; yr += (xr - yr) * aL; yl2 += (yl - yl2) * aL; yr2 += (yr - yr2) * aL; xl = yl2; xr = yr2; }
    if (o.hp) { hl += (xl - hl) * aH; hr += (xr - hr) * aH; xl -= hl; xr -= hr; hl2 += (xl - hl2) * aH; hr2 += (xr - hr2) * aH; xl -= hl2; xr -= hr2; }
    if (d < 0) continue;
    let e = 1;
    if (i < fi) e = i / fi;
    if (len - i < fo) e *= (len - i) / fo;
    const m = (xl + xr) * 0.5;                       // mono-ish source panning, keep some width
    const al = (m * 0.7 + xl * 0.3) * gl * e, ar = (m * 0.7 + xr * 0.3) * gr * e;
    L[d] += al; R[d] += ar;
    if (WHO) who(s, d, al + ar);
  }
}
// Long bed with a gain envelope function g(t) (skipped where g is 0); loops with a crossfade
function bed(s, gainFn, { offset = 0, lp = 0, hp = 0, pan = 0, loopXf = 2.0 } = {}) {
  const aL = lp ? 1 - Math.exp(-2 * Math.PI * lp / SR) : 1, aH = hp ? 1 - Math.exp(-2 * Math.PI * hp / SR) : 0;
  let yl = 0, yr = 0, yl2 = 0, yr2 = 0, hl = 0, hr = 0, g = 0;
  const xf = Math.min(Math.round(loopXf * SR), Math.floor(s.n / 4)), usable = s.n - xf;
  for (let d = 0; d < N; d++) {
    if ((d & 255) === 0) g = gainFn(d / SR) / s.peak;
    const p = (d + Math.round(offset * SR)) % usable;
    let xl = s.l[p], xr = s.r[p];
    if (p < xf) { const k = p / xf; xl = xl * k + s.l[usable + p] * (1 - k); xr = xr * k + s.r[usable + p] * (1 - k); }  // loop crossfade
    if (lp) { yl += (xl - yl) * aL; yr += (xr - yr) * aL; yl2 += (yl - yl2) * aL; yr2 += (yr - yr2) * aL; xl = yl2; xr = yr2; }
    if (hp) { hl += (xl - hl) * aH; hr += (xr - hr) * aH; xl -= hl; xr -= hr; }
    L[d] += xl * g * (1 - Math.max(0, pan)); R[d] += xr * g * (1 + Math.min(0, pan));
    if (WHO && g) who(s, d, (xl + xr) * g);
  }
}

// ---------------------------------------------------------------- camera helpers
function cam(t) {
  const c = shots.evalShot('', Math.min(DUR - 0.01, Math.max(0, t)));
  const fx = c.tgt[0] - c.pos[0], fz = c.tgt[2] - c.pos[2], fl = Math.hypot(fx, fz) || 1;
  return { name: c.name, pos: c.pos, right: [-fz / fl, fx / fl] };   // right vector in xz (x right-handed: forward x up)
}
function spatial(t, x, z, y = 0) {
  const c = cam(t);
  const dx = x - c.pos[0], dz = z - c.pos[2], dy = y - c.pos[1];
  const d = Math.hypot(dx, dy, dz);
  const pan = Math.max(-0.85, Math.min(0.85, (dx * c.right[0] + dz * c.right[1]) / (d + 8)));
  return { d, pan: -pan, shot: c.name };
}
const smooth = (a, b, x) => { const k = Math.max(0, Math.min(1, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
const segOf = (name) => shots.TIMELINE.find((s) => s.shot === name) || { start: -1, end: -1 };
const inShot = (name, t, fade = 0.35) => { const s = segOf(name); return smooth(s.start - fade, s.start + fade, t) * (1 - smooth(s.end - fade, s.end + fade, t)); };

// ---------------------------------------------------------------- SFX
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
shotIdx = Uint8Array.from({ length: (N >> 10) + 2 }, (_, i) => Math.max(0, shots.TIMELINE.findIndex((g) => (i << 10) / SR >= g.start && (i << 10) / SR < g.end)));
const db = (x) => Math.pow(10, x / 20);
const marks = [];      // every touchdown in the film: { td (gait), at (td + distance delay), near, k, shot }
// Per-shot perspective: g = how much of the machine reaches the camera, lp = ceiling (Hz, 0 = open), k = extra close-up detail,
// groan = weight of the structure's stress sounds.
const PERSP = {
  f_open:   { g: 1.00, lp: 800,  k: 0,   groan: 0.5 },   // far, through fog: soft, low, late
  f_side:   { g: 0.90, lp: 1100, k: 0,   groan: 0.6 },   // 150 m long lens
  f_hero:   { g: 1.25, lp: 0,    k: 0,   groan: 1.0 },
  f_foot:   { g: 1.00, lp: 0,    k: 0,   groan: 1.0 },   // a foot lands at the lens: everything
  f_belly:  { g: 0.90, lp: 0,    k: 0,   groan: 1.5 },   // inside the machine
  f_life:   { g: 0.42, lp: 1500, k: 0,   groan: 0.55 },   // up at the balconies: the walk is felt from below
  f_knee:   { g: 1.15, lp: 0,    k: 0.4, groan: 1.2 },   // mechanism close-up
  f_puddle: { g: 1.00, lp: 0,    k: 0.3, groan: 1.0 },
  f_away:   { g: 0.90, lp: 2200, k: 0,   groan: 0.7 },
};
const persp = (name) => PERSP[name] || { g: 1, lp: 0, k: 0, groan: 1 };

if (!args.nosfx) {
  // ---- sources (offsets below are positions inside the downloaded recordings, not picture times)
  const steps = ['step1', 'step2', 'step3', 'step4', 'step5'].map((n) => sfx(n));
  const bass = sfx('bassimpact'), sub = sfx('subdrop'), dboom = sfx('distantboom');
  const stomps = [2.44, 5.22, 8.88, 11.66, 15.31, 18.10, 21.75].map((ss) => sfx('giantstomp', { ss, t: 1.5 }));
  const doors = ['metaldoor1', 'metaldoor2', 'metaldoor3'].map((n) => sfx(n));
  const gravel = sfx('gravelfall'), debris = sfx('debris', { ss: 2, t: 8 }), bigdebris = sfx('bigdebris');
  const air = sfx('airrelease'), phiss = sfx('pressurehiss'), steam = sfx('steamrelease', { t: 6 });
  const mdoors = [sfx('mechdoor', { ss: 0.4, t: 2.6 }), sfx('mechdoor', { ss: 3.8, t: 2.7 })];
  const squelch = sfx('mudsquelch'), squelch2 = sfx('squelch'), splat = sfx('mudsplat'), slimy = sfx('slimy', { ss: 1.3, t: 1.0 });
  const mudsteps = [12.0, 14.05, 29.85, 40.75].map((ss) => sfx('muddysteps', { ss, t: 0.9 }));
  const splashBig = sfx('splashstomps', { ss: 14.0, t: 3.0 }), splashSmall = sfx('splashstomps', { ss: 5.5, t: 3.0 });
  const ripples = sfx('watersplashes', { ss: 19.5, t: 3.5 });
  const chains = [sfx('chain1', { ss: 2.7, t: 1.8 }), sfx('chain1', { ss: 7.5, t: 1.9 }), sfx('chain1', { ss: 13.6, t: 1.6 }), sfx('chainrattle', { ss: 16.9, t: 2.2 })];
  const servo = sfx('trunkmotor', { ss: 2.0, t: 3.2 }), clampS = sfx('mechclamp', { ss: 2.2, t: 1.3 });
  const hydLong = 'sfx/hydraulics_long.mp3';
  const groans = [sfx('metalgroan'), sfx('longcreak'), sfx('creakslow', { ss: 3, t: 9 }), sfx('gangplank', { ss: 12, t: 9 }), sfx('bendmetal'),
    sfx('windmillgroan', { ss: 40, t: 7 }), sfx('windmillgroan', { ss: 120, t: 7 })];
  const creaks = [sfx('bendmetal'), sfx('gaterattle', { ss: 4, t: 2.5 }), sfx('longcreak'), sfx('metalrattle', { ss: 6, t: 2.2 })];

  // ---- one foot touching down
  function touchdown(td, x, z, ev) {
    const sp = spatial(td, x, z), near = 1 / (1 + sp.d / 22), P = persp(sp.shot), pan = sp.pan;   // near: 1 close .. ~0.1 far
    // picture sync wins inside 30 m; farther away the sound arrives late like it would (capped so it still reads as the same step)
    const at = td + Math.min(0.3, Math.max(0, sp.d - 30) / 343);
    const g = clamp(near * 1.5, 0.15, 1) * P.g;
    let lp = 600 + 13000 * Math.pow(near, 1.4);
    if (P.lp) lp = Math.min(lp, P.lp);
    const kd = clamp((near - 0.2) / 0.3 + P.k);                 // detail layers
    const kh = near > 0.32 ? clamp((near - 0.32) / 0.22 + P.k) : 0;   // hero layers
    if (td > 0.3) marks.push({ td, at, near, k: kh, shot: sp.shot, open: !P.lp });
    // 1) sharp transient: pitched-down mechanical step, no lows of its own
    const st = steps[ev % steps.length];
    place(st, { at, anchor: st.onT, gain: 0.62 * g, pan, lp, hp: 70, rate: 0.62 + 0.08 * rnd() });
    // 2) deep body, kept short so the low end stays tight
    place(bass, { at: at - 0.010, anchor: bass.onT, gain: 0.60 * g, pan: pan * 0.5, lp: clamp(lp, 500, 2500), hp: 38, rate: 0.6 + 0.1 * rnd(), dur: 1.1, fadeOut: 0.6 });
    // 3) distance: a soft low boom that takes over as the foot gets farther away
    place(dboom, { at: at - 0.006, anchor: dboom.onT, gain: 0.36 * g * (1 - near), pan: pan * 0.4, lp: 450 + 900 * near, hp: 42, rate: 0.75, dur: 2.2, fadeOut: 1.2 });
    if (kd > 0) {
      const dr = doors[ev % doors.length];                       // steel plate clank
      place(dr, { at: at + 0.015, anchor: dr.onT, gain: 0.34 * g * (0.4 + 0.6 * kd), pan, lp: Math.min(lp, 1800 + 8000 * near), hp: 150, rate: 0.55, dur: 1.4, fadeOut: 0.7 });
      place(gravel, { at: at + 0.10, gain: 0.42 * g * kd, pan, lp: Math.min(lp, 2500 + 7000 * near), hp: 200, rate: 0.8 });
      const hs = ev % 2 ? air : phiss;                           // pneumatic exhaust once the weight is on the foot
      place(hs, { at: at + 0.42 + 0.15 * rnd(), gain: 0.24 * g * (0.3 + 0.7 * kd), pan, lp: Math.min(lp * 2, 8000), hp: 500, fadeIn: 0.03, fadeOut: 0.9, dur: 2.2 });
      if (sp.shot === 'f_puddle') place(splashSmall, { at, anchor: splashSmall.onT, gain: 0.2 * g * kd, pan, lp: 6000, hp: 200, fadeOut: 0.8 });
    }
    if (kh > 0) {
      heroHits.push([at, kh * P.g]);
      const sm = stomps[ev % stomps.length];                     // monstrous stomp: weight
      place(sm, { at: at - 0.010, anchor: sm.onT, gain: 0.42 * g * kh, pan: pan * 0.6, lp: 3000 + 6000 * near, hp: 45, rate: 0.8, dur: 1.3, fadeOut: 0.5 });
      place(sub, { at: at + 0.01, anchor: sub.onT, gain: 0.16 * g * kh, rate: 0.7, lp: 140, hp: 36, dur: 0.9, fadeOut: 0.5 });
      place(debris, { at: at + 0.22, gain: 0.36 * g * kh, pan, lp: 7500, hp: 250, dur: 4, fadeOut: 2.0 });   // clods raining back down
      const ms = mudsteps[ev % mudsteps.length];                 // wet ground giving way
      place(ms, { at, anchor: ms.onT, gain: 0.36 * g * kh, pan, rate: 0.6, lp: 6000, hp: 120, fadeOut: 0.2 });
      place(squelch, { at, anchor: squelch.onT, gain: 0.34 * g * kh, pan, rate: 0.6, lp: 5000, hp: 150, dur: 1.6, fadeOut: 0.6 });
      if (kh > 0.6) {
        place(splat, { at, anchor: splat.onT, gain: 0.34 * g * kh, pan, rate: 0.7, lp: 9000, hp: 200, fadeOut: 0.1 });
        place(bigdebris, { at: at + 0.08, gain: 0.26 * g * kh, pan, lp: 8000, hp: 180, rate: 0.85, fadeOut: 1.5 });
        const md = mdoors[ev % 2];                               // piston settling
        place(md, { at: at + 0.6, gain: 0.16 * g * kh, pan, rate: 0.8, lp: 7000, hp: 250, fadeIn: 0.03, fadeOut: 0.8 });
      }
      if (sp.shot === 'f_puddle') {                              // the foot that lands by the puddle
        place(splashBig, { at, anchor: splashBig.onT, gain: 0.62 * g * kh, pan, lp: 10000, hp: 150, fadeOut: 1.0 });
        place(ripples, { at: at + 0.3, anchor: ripples.onT, gain: 0.22 * g * kh, pan, hp: 300, fadeIn: 0.02, fadeOut: 1.5 });
      }
    }
  }
  // ---- one leg swinging forward (lift-off .. touchdown)
  let ci = 0;
  function swing(lift, td, x, z) {
    const sp = spatial(lift, x, z, 6), near = 1 / (1 + sp.d / 22), P = persp(sp.shot), pan = sp.pan;
    if (near < 0.11) return;
    const g = clamp(near * 1.6) * P.g, cap = P.lp || 1e5;
    const h = load(hydLong, { ss: 4 + Math.floor(rnd() * 70), t: 2.6 });     // hydraulic effort (random slice of a long recording)
    place(h, { at: lift - 0.15, gain: 0.42 * g, pan, lp: Math.min(cap, 2500 + 8000 * near), hp: 150, rate: 0.75, fadeIn: 0.25, fadeOut: 0.7 });
    const k = clamp((near - 0.26) / 0.25 + P.k);
    if (near > 0.26) {
      place(servo, { at: lift + 0.1, gain: 0.17 * g * k, pan, rate: 0.55 + 0.1 * rnd(), lp: Math.min(cap, 5000), hp: 250, fadeIn: 0.3, fadeOut: 0.6, dur: Math.max(0.8, td - lift - 0.2) });
      const ch = chains[ci++ % chains.length];                   // cables and chains swinging with the leg
      place(ch, { at: lift + 0.5 + 0.6 * rnd(), gain: 0.13 * g * k, pan, rate: 0.8, lp: Math.min(cap * 2, 8000), hp: 500, fadeIn: 0.05, fadeOut: 0.5 });
    }
    const k2 = near > 0.36 ? clamp((near - 0.36) / 0.2 + P.k) : 0;
    if (k2 > 0) {
      place(clampS, { at: lift - 0.05, anchor: clampS.onT, gain: 0.2 * g * k2, pan, rate: 0.6, lp: 6000, hp: 120, fadeOut: 0.4 });   // joint unlocking
      place(squelch2, { at: lift + 0.05, gain: 0.34 * g * k2, pan, rate: 0.55, lp: 4500, hp: 120, dur: 2, fadeOut: 0.6 });         // foot peeling out of the mud
      place(slimy, { at: lift + 0.2, gain: 0.16 * g * k2, pan, rate: 0.7, lp: 5000, hp: 200, fadeOut: 0.3 });
      place(steam, { at: lift + 0.1, gain: 0.11 * g * k2, pan, hp: 600, fadeIn: 0.1, fadeOut: 2.5 });
    }
  }
  const T = GAIT.T;
  let ev = 0;
  for (const leg of LEGS) {
    for (let n = -1; n < Math.ceil(DUR / T) + 2; n++) {
      const td = (n - leg.phase) * T;                         // touchdown time
      const lift = td + GAIT.duty * T - T;                    // the lift-off that precedes this touchdown
      if (td > -0.5 && td < DUR) touchdown(td, SPEED * td + leg.homeX + GAIT.stride * 0.5, leg.homeZ, ev++);
      if (lift > -1 && lift < DUR) swing(lift, td, SPEED * lift + leg.homeX - GAIT.stride * 0.5, leg.homeZ);
    }
  }
  // ---- the structure taking the load after each group touchdown (two per cycle)
  let gi = 0;
  for (let n = -1; n < Math.ceil(DUR / (T / 2)) + 1; n++) {
    const tg = n * T / 2 - 0.05 * T;
    if (tg < -1 || tg > DUR) continue;
    const c = cam(tg), P = persp(c.name);
    const near = 1 / (1 + Math.hypot(SPEED * tg - c.pos[0], c.pos[2]) / 60);
    const cap = P.lp ? P.lp * 2 : 1e5;
    if (near > 0.5) place(sub, { at: tg + 0.1, anchor: sub.peakT * 0.5, gain: 0.09 * near * P.g, rate: 0.7, lp: 150, hp: 36, dur: 1.4, fadeOut: 0.8 });
    const gr = groans[gi % groans.length];                     // long low groan
    place(gr, { at: tg + 0.55 + 0.5 * rnd(), gain: 0.30 * P.groan * Math.max(0.3, near * 1.3), pan: (rnd() - 0.5) * 0.8, rate: 0.55 + 0.12 * rnd(),
      lp: Math.min(cap, 2500 + 5000 * near), hp: 90, fadeIn: 0.15, fadeOut: 1.5, dur: 5.5, norm: 'rms' });
    const cr = creaks[gi % creaks.length];                     // shorter, higher stress creak mid-stance
    place(cr, { at: tg + 1.8 + 0.7 * rnd(), gain: 0.13 * P.groan * Math.max(0.25, near * 1.3), pan: (rnd() - 0.5) * 1.2, rate: 0.75 + 0.2 * rnd(),
      lp: Math.min(cap, 3000 + 6000 * near), hp: 300, fadeIn: 0.05, fadeOut: 0.8, dur: 3, norm: 'rms' });
    gi++;
  }
  // ---- beds
  const S = (name, t, f) => inShot(name, t, f);
  const wind = sfx('windnight', { ss: 20, t: 60 });           // wind over the open field, pulled down under the machine / at the facade
  bed(wind, (t) => 0.19 * (1 + 0.6 * S('f_open', t, 1.0) - 0.5 * S('f_belly', t) - 0.35 * S('f_knee', t) - 0.25 * S('f_life', t)) * smooth(0, 1.5, t), { hp: 90 });
  const wind2 = sfx('windsoft', { ss: 5, t: 60 });
  bed(wind2, (t) => 0.10 * (S('f_open', t) + S('f_side', t) + S('f_away', t, 0.8) + 0.5 * S('f_hero', t) + 0.5 * S('f_puddle', t)), { hp: 150, offset: 7 });
  const field = sfx('fieldamb', { ss: 10, t: 70 });           // grass moving right at the lens in the ground-level shots
  bed(field, (t) => 0.16 * (S('f_open', t, 0.8) + S('f_foot', t) + 0.7 * S('f_puddle', t)), { hp: 250 });
  const gust = sfx('windgust');
  for (const [name, off] of [['f_side', -0.6], ['f_away', 0.2]]) {
    const sg = segOf(name);
    if (sg.start >= 0) place(gust, { at: sg.start + off, gain: 0.2, hp: 120, pan: name === 'f_side' ? -0.3 : 0.3, fadeIn: 0.6, fadeOut: 2.5 });
  }
  const rumble = sfx('lowrumble');                            // low rumble only where it adds weight
  bed(rumble, (t) => 0.07 * S('f_belly', t) + 0.035 * S('f_knee', t) + 0.03 * S('f_foot', t), { lp: 220, hp: 40 });
  const machine = load(hydLong, { ss: 10, t: 60 });
  bed(machine, (t) => 0.015 + 0.12 * S('f_belly', t) + 0.08 * S('f_knee', t) + 0.03 * S('f_foot', t) + 0.02 * S('f_hero', t) + 0.02 * S('f_puddle', t), { lp: 3500, hp: 150 });
  const drip = sfx('dripcave', { ss: 20, t: 60 });            // water dripping under the belly, a little around the puddle
  bed(drip, (t) => 0.30 * S('f_belly', t) + 0.08 * S('f_puddle', t) + 0.05 * S('f_foot', t), { hp: 400, pan: -0.25 });
  const drip2 = sfx('dripmetal', { t: 45 });
  bed(drip2, (t) => 0.20 * S('f_belly', t), { hp: 300, pan: 0.35, offset: 20 });
  const chainBed = sfx('chainrattle', { t: 34 });
  bed(chainBed, (t) => 0.07 * S('f_belly', t) + 0.03 * S('f_knee', t), { hp: 400, lp: 7000, pan: -0.3, offset: 12 });
  const ship = sfx('shipcreak', { ss: 30, t: 60 });
  bed(ship, (t) => 0.04 + 0.05 * S('f_life', t) + 0.06 * S('f_belly', t), { lp: 3000, hp: 180 });
  const dogs = sfx('dogsfar', { ss: 8, t: 50 });
  bed(dogs, (t) => 0.09 * (S('f_open', t, 1.0) + 0.7 * S('f_away', t, 1.0) + 0.5 * S('f_side', t, 0.8)), { hp: 300, lp: 3500, pan: 0.3 });
  // ---- life on the facade: laundry, a radio behind a window, dishes, voices, a dog somewhere (all very low)
  const cloth = sfx('clothflap');
  bed(cloth, (t) => 0.09 * S('f_life', t, 0.6), { hp: 300, lp: 6000, pan: -0.2 });
  // (radio tuning bed removed: the recording could contain off-air broadcast fragments)

  const chatter = sfx('aptchatter');
  bed(chatter, (t) => 0.05 * S('f_life', t, 0.7), { lp: 1600, hp: 200, pan: 0.25, loopXf: 1.0 });
  const lf = segOf('f_life'), ll = lf.end - lf.start;
  if (lf.start >= 0) {
    const clinks = [[0.14, 'cutleryclinks', 2.0, 0.9], [0.33, 'plates', 0.5, 0.8], [0.52, 'cutleryclinks', 3.2, 1.2], [0.78, 'plates', 7.9, 0.8]];
    for (const [f, file, ss, t] of clinks) place(sfx(file, { ss, t }), { at: lf.start + f * ll, gain: 0.04, lp: 5000, hp: 600, pan: 0.4, fadeIn: 0.01, fadeOut: 0.2 });
    place(sfx('dogbark', { ss: 0.5, t: 2.6 }), { at: lf.start + 0.6 * ll, gain: 0.04, lp: 1800, hp: 250, pan: 0.6, fadeIn: 0.02, fadeOut: 0.3 });
  }
  // ---- birds startled far away as it comes out of the fog; crows over the field
  const op = segOf('f_open'), sd = segOf('f_side'), aw = segOf('f_away');
  if (op.start >= 0) {
    place(sfx('pigeonflock'), { at: op.start + 0.3 * (op.end - op.start), gain: 0.085, lp: 3500, hp: 400, pan: 0.45, fadeIn: 0.4, fadeOut: 2.0 });
    place(sfx('crowsingle'), { at: op.start + 0.72 * (op.end - op.start), gain: 0.03, lp: 2500, hp: 400, pan: -0.3, fadeOut: 0.2 });
  }
  if (sd.start >= 0) place(sfx('crowcalls', { ss: 8.9, t: 5.2 }), { at: sd.start + 0.8, gain: 0.035, lp: 2600, hp: 400, pan: -0.5, fadeIn: 0.3, fadeOut: 1.5 });
  if (aw.start >= 0) place(sfx('crowcalls', { ss: 2.8, t: 3.9 }), { at: aw.start + 0.9, gain: 0.035, lp: 2600, hp: 400, pan: 0.4, fadeIn: 0.2, fadeOut: 1.2 });
}

if (WHO) {
  console.log('\nsource energy per shot (dB, pre-mix; blank = silent)');
  console.log('file'.padEnd(16) + shots.TIMELINE.map((g) => g.shot.slice(2, 8).padStart(7)).join(''));
  const len = shots.TIMELINE.map((g) => (g.end - g.start) * SR);
  for (const [k, a] of [...WHO].sort((x, y) => Math.max(...y[1]) - Math.max(...x[1])))
    console.log(k.padEnd(16) + shots.TIMELINE.map((_, i) => a[i] ? (10 * Math.log10(a[i] / len[i])).toFixed(0).padStart(7) : '       ').join(''));
}
// SFX bus: 2-pole high-pass at 35 Hz to keep the low end tight
{
  const a = 1 - Math.exp(-2 * Math.PI * 35 / SR);
  let l1 = 0, r1 = 0, l2 = 0, r2 = 0;
  for (let i = 0; i < N; i++) {
    l1 += (L[i] - l1) * a; r1 += (R[i] - r1) * a; const xl = L[i] - l1, xr = R[i] - r1;
    l2 += (xl - l2) * a; r2 += (xr - r2) * a; L[i] = xl - l2; R[i] = xr - r2;
  }
}
// ---------------------------------------------------------------- loudness helpers
function toPcm(l, r) { const b = Buffer.alloc(N * 8); for (let i = 0; i < N; i++) { b.writeFloatLE(l[i], i * 8); b.writeFloatLE(r[i], i * 8 + 4); } return b; }
function measure(l, r, full = false) {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', '-', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { input: toPcm(l, r), maxBuffer: 1 << 30 });
  const sum = String(res.stderr).split('Summary:')[1] || '';
  const num = (re) => { const m = re.exec(sum); return m ? +m[1] : -70; };
  const I = num(/I:\s+(-?[\d.]+) LUFS/);
  return full ? { I, LRA: num(/LRA:\s+(-?[\d.]+) LU/), TP: num(/Peak:\s+(-?[\d.]+) dBFS/) } : I;
}

// ---------------------------------------------------------------- music
// One continuous excerpt, fades only. `at` (s in the track) lands on the first frame of `shot`:
// The Long Dark: sparse, quiet strings until the full ensemble enters at 313.40 s -> entry on the cut to the hero shot,
// plateau through the facade shot, faded out as the block walks away.
const MUSIC = {
  the_long_dark: { at: 313.40, shot: 'f_hero' },
  penumbra: { at: 343, shot: 'f_open' },
};
const ML = new Float32Array(N), MR = new Float32Array(N);
let musicI = -70;
if (!args.nomusic) {
  const name = args.music || 'the_long_dark', M = MUSIC[name] || { at: 0, shot: 'f_open' };
  const mstart = Math.max(0, args.mstart !== undefined ? +args.mstart : M.at - Math.max(0, segOf(M.shot).start));
  const m = load(`music/${name}.mp3`, { ss: mstart, t: DUR + 0.5 });
  const open = segOf('f_open'), life = segOf('f_life'), away = segOf('f_away');
  const o1 = open.end > 0 ? open.end : 5.5, l0 = life.start > 0 ? life.start : 0.58 * DUR, l1 = life.end > 0 ? life.end : 0.7 * DUR, a0 = away.start > 0 ? away.start : DUR - 4.5;
  for (let i = 0; i < Math.min(N, m.n); i++) {
    const t = i / SR;
    // fader ride: held back 5 dB in the opening, full level by the facade shot, easing 2.5 dB through the knee and puddle shots,
    // then a long fade as the block leaves
    const g = smooth(0, 2.0, t) * db(-5 * (1 - smooth(o1, l0, t)) - 2.5 * smooth(l1, a0, t)) * Math.pow(1 - smooth(a0 + 0.2, DUR - 0.1, t), 1.5) / m.peak;
    ML[i] = m.l[i] * g; MR[i] = m.r[i] * g;
  }
  musicI = measure(ML, MR);
  console.log(`music ${name} from ${mstart.toFixed(2)} s`);
  // duck the music a little just before each close footfall so the impact punches through
  for (const [td, k] of heroHits) {
    const i0 = Math.max(0, Math.round((td - 0.45) * SR)), i1 = Math.min(N, Math.round((td + 1.3) * SR));
    for (let i = i0; i < i1; i++) {
      const t = i / SR - td;
      const d = t < 0 ? smooth(-0.45, -0.05, t) : 1 - smooth(0.15, 1.3, t);
      const g = 1 - 0.38 * Math.min(1, k) * d;
      ML[i] *= g; MR[i] *= g;
    }
  }
}
// balance: SFX bus sits `sfxrel` LU relative to the music (integrated)
if (!args.nosfx) {
  const sfxI = measure(L, R);
  const rel = +(args.sfxrel ?? -1);
  const g = args.nomusic ? db(-20 - sfxI) : db(musicI + rel - sfxI);
  console.log(`sfx I=${sfxI.toFixed(1)} LUFS  music I=${musicI.toFixed(1)} LUFS  -> sfx gain ${(20 * Math.log10(g)).toFixed(1)} dB`);
  for (let i = 0; i < N; i++) { L[i] *= g; R[i] *= g; }
}
const SL = Float32Array.from(L), SR_ = Float32Array.from(R);      // SFX stem
for (let i = 0; i < N; i++) { L[i] += ML[i]; R[i] += MR[i]; }
// master fades: clean head, tail out with the picture (which fades over the last 1.5 s)
const mfade = (t) => smooth(0, 0.5, t) * (1 - smooth(DUR - 1.6, DUR - 0.04, t));
// static master gain to the target loudness, then a peak limiter that should have very little to do
for (let i = 0; i < N; i++) { const g = mfade(i / SR); L[i] *= g; R[i] *= g; }
const mixI = measure(L, R);
const target = +(args.lufs ?? -15), LIMIT = 0.82;
const mg = db(target - mixI);
let pk = 0, over = 0;
for (let i = 0; i < N; i++) {
  L[i] *= mg; R[i] *= mg;
  const g = mfade(i / SR) * mg; SL[i] *= g; SR_[i] *= g; ML[i] *= g; MR[i] *= g;
  const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
  if (a > pk) pk = a;
  if (a > LIMIT) over++;
}
const out = path.resolve(ROOT, args.out || 'out/audio.wav');
fs.mkdirSync(path.dirname(out), { recursive: true });
function writeWav(file, l, r, limit) {
  const af = limit ? ['-af', `alimiter=limit=${LIMIT}:attack=3:release=120:level=disabled`] : [];
  const r2 = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '2', '-i', '-', ...af, '-ar', String(SR), '-c:a', 'pcm_s24le', file], { input: toPcm(l, r), maxBuffer: 1 << 30 });
  if (r2.status !== 0) throw new Error(String(r2.stderr));
}
writeWav(out, L, R, true);
if (args.stems) { writeWav(path.join(path.dirname(out), 'stem_music.wav'), ML, MR, false); writeWav(path.join(path.dirname(out), 'stem_sfx.wav'), SL, SR_, false); }
console.log(`wrote ${path.relative(ROOT, out)}  mix I=${mixI.toFixed(1)} -> ${target} LUFS (master ${(20 * Math.log10(mg)).toFixed(1)} dB), pre-limiter peak ${pk.toFixed(2)}`
  + ` = max gain reduction ${Math.max(0, 20 * Math.log10(pk / LIMIT)).toFixed(1)} dB, ${(over / SR * 1000).toFixed(0)} ms of samples over the ceiling`);

// ---------------------------------------------------------------- verification (measured on the written file)
if (!args.quiet) {
  const rd = spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'f32le', '-ac', '2', '-ar', String(SR), '-'], { maxBuffer: 1 << 30 });
  const f = new Float32Array(rd.stdout.buffer, rd.stdout.byteOffset, Math.floor(rd.stdout.length / 4));
  const n = Math.min(N, f.length / 2), FL = new Float32Array(N), FR = new Float32Array(N);
  for (let i = 0; i < n; i++) { FL[i] = f[2 * i]; FR[i] = f[2 * i + 1]; }
  const fin = measure(FL, FR, true);
  console.log(`\nfinal file: I ${fin.I.toFixed(1)} LUFS   LRA ${fin.LRA.toFixed(1)} LU   true peak ${fin.TP.toFixed(1)} dBTP`);
  // transient time = steepest rise of a 1.5 ms envelope within +-45 ms of the expected time.
  //   click = the same on the signal above 1 kHz (the sharp transient layer; only meaningful where the shot's perspective is open)
  //   body  = full band (the low body swells a little later than the click)
  const mono = (l, r) => { const o = new Float32Array(N); for (let i = 0; i < N; i++) o[i] = (l[i] + r[i]) * 0.5; return o; };
  const hp1k = (x) => { const a = 1 - Math.exp(-2 * Math.PI * 1000 / SR), o = new Float32Array(N); let l1 = 0, l2 = 0; for (let i = 0; i < N; i++) { l1 += (x[i] - l1) * a; const y = x[i] - l1; l2 += (y - l2) * a; o[i] = y - l2; } return o; };
  const onset = (x, t) => {
    const w = Math.round(0.045 * SR), h = Math.round(0.002 * SR), c = Math.round(t * SR), a = 1 - Math.exp(-1 / (0.0015 * SR));
    const i0 = Math.max(0, c - w - h - Math.round(0.02 * SR)), i1 = Math.min(N, c + w + h + 1), e = new Float32Array(i1 - i0);
    let env = 0, best = 0, bi = c;
    for (let i = i0; i < i1; i++) { env += (Math.abs(x[i]) - env) * a; e[i - i0] = env; }
    for (let i = Math.max(i0 + h, c - w); i < Math.min(i1 - h, c + w); i++) { const d = e[i + h - i0] - e[i - h - i0]; if (d > best) { best = d; bi = i; } }
    return (bi / SR - t) * 1000;
  };
  const sM = mono(SL, SR_), fM = mono(FL, FR), sH = hp1k(sM), fH = hp1k(fM);
  const all = marks.filter((m) => m.at < DUR - 1.7).sort((a, b) => a.at - b.at);
  // a foot landing within 130 ms after another one is masked by that one's debris: listed separately
  const rows = all.map((m, i) => ({ ...m, lone: i === 0 || m.at - all[i - 1].at > 0.13, delay: (m.at - m.td) * 1000,
    cs: onset(sH, m.at), cf: onset(fH, m.at), bs: onset(sM, m.at), bf: onset(fM, m.at) }));
  const st = (a) => a.length ? `n=${String(a.length).padStart(2)}  mean ${(a.reduce((s, v) => s + v, 0) / a.length).toFixed(1).padStart(5)} ms  worst ${a.reduce((s, v) => Math.abs(v) > Math.abs(s) ? v : s, 0).toFixed(1).padStart(6)} ms  within +-20 ms: ${a.filter((v) => Math.abs(v) <= 20).length}/${a.length}` : 'n= 0';
  const sgn = (v) => (v >= 0 ? '+' : '') + v.toFixed(1);
  const hero = rows.filter((m) => m.k > 0 && m.open), heroL = hero.filter((m) => m.lone);
  console.log('\nfootfall timing, measured minus expected (expected = gait touchdown + distance delay; delay is 0 within 30 m of the camera)');
  console.log(`  close hits, click >1 kHz, SFX stem   ${st(heroL.map((m) => m.cs))}`);
  console.log(`  close hits, click >1 kHz, final mix  ${st(heroL.map((m) => m.cf))}`);
  console.log(`  close hits, body full band, final    ${st(heroL.map((m) => m.bf))}`);
  console.log(`  all other hits, body, SFX stem       ${st(rows.filter((m) => !(m.k > 0 && m.open) && m.lone).map((m) => m.bs))}`);
  console.log(`  masked (<130 ms after another foot)  n=${rows.filter((m) => !m.lone).length}, not scored`);
  console.log('  gait t    shot    near delay | click stem  click mix  body mix (ms)');
  for (const m of hero) console.log(`  ${m.td.toFixed(3).padStart(6)}  ${m.shot.slice(2).padEnd(7)} ${m.near.toFixed(2)} ${m.delay.toFixed(0).padStart(4)}  | ${sgn(m.cs).padStart(9)} ${sgn(m.cf).padStart(10)} ${sgn(m.bf).padStart(9)}${m.lone ? '' : '   (masked)'}`);
  // per-shot levels (dB RMS): stems, mix, quietest 0.4 s window, band balance
  const bands = [60, 200, 2000];
  const rms = (l, r, i0, i1) => { let s = 0; for (let i = i0; i < i1; i++) s += l[i] * l[i] + r[i] * r[i]; return 10 * Math.log10(s / (2 * (i1 - i0)) + 1e-12); };
  const lowp = (fc) => { const a = 1 - Math.exp(-2 * Math.PI * fc / SR), o = new Float32Array(N); let y1 = 0, y2 = 0, y3 = 0, y4 = 0; for (let i = 0; i < N; i++) { const x = (FL[i] + FR[i]) * 0.5; y1 += (x - y1) * a; y2 += (y1 - y2) * a; y3 += (y2 - y3) * a; y4 += (y3 - y4) * a; o[i] = y4; } return o; };
  const lps = bands.map(lowp);
  const sig = [lps[0], ...bands.slice(1).map((_, k) => lps[k + 1].map((v, i) => v - lps[k][i])), fM.map((v, i) => v - lps[bands.length - 1][i])];
  const r1 = (x, i0, i1) => { let s = 0; for (let i = i0; i < i1; i++) s += x[i] * x[i]; return 10 * Math.log10(s / (i1 - i0) + 1e-12); };
  const p = (v) => v.toFixed(1).padStart(7);
  console.log('\nshot        time        music    sfx    mix  quietest0.4s |  <60Hz 60-200 200-2k   >2kHz   (dB RMS, final file)');
  for (const sg of shots.TIMELINE) {
    const i0 = Math.round(sg.start * SR), i1 = Math.min(N, Math.round(sg.end * SR)), w = Math.round(0.4 * SR);
    let q = 0; for (let i = i0; i + w <= i1; i += w >> 1) q = Math.min(q, rms(FL, FR, i, i + w));
    console.log(`${sg.shot.padEnd(9)} ${sg.start.toFixed(1).padStart(5)}-${sg.end.toFixed(1).padEnd(5)} ${p(rms(ML, MR, i0, i1))}${p(rms(SL, SR_, i0, i1))}${p(rms(FL, FR, i0, i1))} ${p(q)}      |${sig.map((x) => p(r1(x, i0, i1))).join('')}`);
  }
}
