// Camera shots. Positions are in the PATH FRAME: origin travels with the walker at constant
// speed (x = SPEED * t), y = ground, so [0, 18.5, 0] is the building base centre.
// cam(tl, t) -> { pos:[x,y,z], tgt:[x,y,z], fov, roll?, dof?:{focus,aperture}, shake?:mult }
//   tl = local time inside the shot (s), t = global time.
import { SPEED } from './gait.js';

const lerp = (a, b, k) => a + (b - a) * k;
const mix3 = (a, b, k) => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
const ease = (k) => { k = Math.min(1, Math.max(0, k)); return k * k * (3 - 2 * k); };

// Still look-dev views matching refs/1..6.webp
export const SHOTS = {
  // ref 1: worm's-eye by a foot, block looming overhead and receding into fog
  ref1: { cam: () => ({ pos: [-46.5, 0.55, 26.5], tgt: [-18, 15.5, 6], fov: 58, dof: { focus: 14, aperture: 2.2 } }) },
  // ref 2: classic low 3/4 hero view
  ref2: { cam: () => ({ pos: [-78, 2.0, 58], tgt: [-2, 21, 0], fov: 44 }) },
  // ref 3: far 3/4 from the other end, heavy fog
  ref3: { cam: () => ({ pos: [92, 2.6, 86], tgt: [-4, 22, 0], fov: 36 }) },
  // ref 4: flat side elevation, long lens
  ref4: { cam: () => ({ pos: [0, 5.0, 205], tgt: [0, 21, 0], fov: 27 }) },
  // ref 5: straight up into the mechanical belly
  ref5: { cam: () => ({ pos: [-62, 1.3, 2], tgt: [-18, 19, 0], fov: 62 }) },
  // ref 6: low over a puddle, block marching past
  ref6: { cam: () => ({ pos: [70, 0.8, 44], tgt: [2, 19, 0], fov: 50, dof: { focus: 60, aperture: 1.2 } }) },
  // extra inspection views
  facade: { cam: () => ({ pos: [-8, 26, 34], tgt: [-8, 27, 0], fov: 40 }) },
  facadeClose: { cam: () => ({ pos: [-20, 27, 17], tgt: [-14, 27.5, 7], fov: 40 }) },
  roof: { cam: () => ({ pos: [-60, 52, 40], tgt: [0, 34, 0], fov: 40 }) },
  leg: { cam: () => ({ pos: [-2, 9, 46], tgt: [11, 13, 14], fov: 38 }) },
  foot: { cam: () => ({ pos: [20, 2.2, 31], tgt: [12, 3.5, 18], fov: 42 }) },
  knee: { cam: () => ({ pos: [22, 24, 38], tgt: [12, 22, 20], fov: 36 }) },
  belly: { cam: () => ({ pos: [-8, 3, 4], tgt: [6, 17, 0], fov: 60 }) },
  end: { cam: () => ({ pos: [-95, 14, 12], tgt: [-44, 24, 0], fov: 40 }) },
  back: { cam: () => ({ pos: [60, 4, -70], tgt: [0, 20, 0], fov: 44 }) },
  grass: { cam: () => ({ pos: [-30, 0.35, 60], tgt: [-10, 6, 20], fov: 50, dof: { focus: 40, aperture: 2.0 } }) },
};

// ---------------------------------------------------------------- film shots
const P = (t) => SPEED * t;               // walker x at time t
Object.assign(SHOTS, {
  // 1. something huge approaches through the fog; rack focus from wet grass to the lights
  f_open: { cam: (tl, t) => {
    const k = ease(tl / 5.5), r = ease((tl - 2.3) / 2.4);
    return { world: true, pos: [150 - 2.0 * k, 0.40 + 0.35 * k, 50], tgt: [P(t) + 22, 13 + 5 * k, 2], fov: 31 - 2.5 * k,
      dof: { focus: lerp(2.2, 95, r), aperture: 3.2, maxBlur: 22 }, shake: 1.7, post: { fade: ease(tl / 1.3) } };
  } },
  // 2. long-lens side elevation, slow truck + push
  f_side: { cam: (tl) => {
    const k = tl / 5.5;
    return { pos: [lerp(-14, 6, k), 4.2, lerp(158, 146, k)], tgt: [lerp(-5, 2, k), 18.2, 0], fov: 29, shake: 0.6 };
  } },
  // 3. low 3/4 hero, the block marches past and over us
  f_hero: { cam: (tl) => {
    const k = tl / 5.5;
    return { pos: [lerp(-84, -70, k), lerp(1.7, 2.4, k), lerp(60, 50, k)], tgt: [lerp(-8, 2, k), lerp(18.5, 20.5, k), 0], fov: lerp(42, 46, k), shake: 1.2,
      dof: { focus: 78, aperture: 0.9 } };
  } },
  // 4. worm's-eye: a foot slams down right in front of the lens (leg 2 plants at t=18.752, x=75.6, z=18)
  f_foot: { cam: (tl) => {
    const k = ease(tl / 4.0);
    return { world: true, pos: [86.7 - 1.2 * k, 0.5 + 0.1 * k, 34.0], tgt: [lerp(72.2, 68.2, k), lerp(8.5, 12, k), lerp(20, 13, k)], fov: 56, shake: 2.4,
      dof: { focus: 15, aperture: 1.6 } };
  } },
  // 5. the belly passes overhead
  f_belly: { cam: (tl, t) => {
    const k = tl / 5.5;
    return { world: true, pos: [P(23.2) + 14, 1.25, 1.5], tgt: [P(t) - 14 + 8 * k, 17.0, lerp(-1.5, 1.0, k)], fov: 60, shake: 1.5 };
  } },
  // 6. life goes on: drifting up past balconies and laundry
  f_life: { cam: (tl) => {
    const k = tl / 5.5, e = ease(k);
    return { pos: [lerp(-27, -15, k), lerp(21.0, 30.0, e), lerp(21.5, 19.5, k)], tgt: [lerp(-22, -11, k), lerp(22.0, 29.5, e), 7.5], fov: 33, shake: 0.35,
      dof: { focus: 13.5, aperture: 2.4 } };
  } },
  // 7. the machine: knee and pistons of leg 1 (lifts 33.06, slams 34.98)
  f_knee: { cam: (tl) => {
    const k = tl / 4.0;
    return { pos: [lerp(-36, -32, k), lerp(9.5, 12, k), lerp(46, 42, k)], tgt: [-15, lerp(11.5, 13.5, k), 21], fov: 40, shake: 1.2,
      dof: { focus: 29, aperture: 1.6 } };
  } },
  // 8. puddle mirror (hero puddle at world x=130, z=35); leg 2 plants at t=37.95 at x=129, z=18
  f_puddle: { cam: (tl) => {
    const k = tl / 5.0;
    return { world: true, pos: [136.6 - 1.2 * k, 1.25 + 0.25 * k, 43.8], tgt: [lerp(104, 112, k), lerp(8.5, 10.5, k), 0], fov: 56, shake: 1.4,
      dof: { focus: 46, aperture: 0.9 } };
  } },
  // 9. it walks on into the fog; slow crane up, fade out
  f_away: { cam: (tl, t) => {
    const k = tl / 4.5, e = ease(k);
    return { world: true, pos: [P(40.5) - 84 - 8 * k, 5.0 + 24.0 * e, -36 + 4 * k], tgt: [P(t) - 6, 18.5 + 3 * e, 0], fov: 36, shake: 0.8,
      post: { fade: 1 - ease((tl - 2.9) / 1.55) } };
  } },
});

export const TIMELINE = [
  { shot: 'f_open', start: 0, end: 5.5 },
  { shot: 'f_side', start: 5.5, end: 11 },
  { shot: 'f_hero', start: 11, end: 16.5 },
  { shot: 'f_foot', start: 16.5, end: 20.5 },
  { shot: 'f_belly', start: 20.5, end: 26 },
  { shot: 'f_life', start: 26, end: 31.5 },
  { shot: 'f_knee', start: 31.5, end: 35.5 },
  { shot: 'f_puddle', start: 35.5, end: 40.5 },
  { shot: 'f_away', start: 40.5, end: 45 },
];
export const DURATION = 45;

export function evalShot(name, t) {
  let s = SHOTS[name], tl = t;
  if (s) { const seg = TIMELINE.find((g) => g.shot === name); if (seg) tl = t - seg.start; }
  if (!s) {
    // timeline lookup
    for (const seg of TIMELINE) if (t >= seg.start && t < seg.end) { s = SHOTS[seg.shot]; tl = t - seg.start; name = seg.shot; break; }
    if (!s && t >= DURATION) { const seg = TIMELINE[TIMELINE.length - 1]; s = SHOTS[seg.shot]; tl = t - seg.start; name = seg.shot; }
    if (!s) { s = SHOTS.ref2; }
  }
  const c = s.cam(tl, t);
  const px = SPEED * (s.fixed ? (s.fixedT ?? 0) : t);
  return {
    name,
    pos: [c.pos[0] + (c.world ? 0 : px), c.pos[1], c.pos[2]],
    tgt: [c.tgt[0] + (c.world ? 0 : px), c.tgt[1], c.tgt[2]],
    fov: c.fov ?? 45, roll: c.roll ?? 0, dof: c.dof ?? null, shake: c.shake ?? 1, handheld: c.handheld ?? (TIMELINE.some((g) => g.shot === name) ? 1 : 0),
    post: { ...(s.post || {}), ...(c.post || {}) },
    near: c.near ?? 0.3,
  };
}
export { lerp, mix3, ease };
