/**
 * The chart-making steps that don't need a browser: trim box, stitch size, and turning
 * one-pixel-per-stitch picture data into a palette plus a stitch grid.
 * Runs inside the Web Worker and in the tests.
 */
import { clamp, lum, type RGB } from "./color";
import { nearestDMC, type Thread } from "./dmc";

export const SYMS = ["●", "▲", "■", "◆", "★", "✚", "♥", "▼", "◐", "✖", "♣", "♠", "○", "△", "□", "◇", "☆", "✕", "♦", "▽", "◑", "✦", "☾", "⬟"];
export const MAX_ST = 300;
export const MIN_ST = 4;

export interface Crop { x: number; y: number; w: number; h: number }
export interface Box { x: number; y: number; w: number; h: number }

export interface Settings {
  cutout: boolean;  // keep only the subject (smart background removal)
  rm: boolean;      // remove white background
  thr: number;      // how light counts as background (min channel above this = background)
  trim: boolean;    // trim empty edges
  mesh: number;
  win: number;      // width, inches
  hin: number;      // height, inches
  lock: boolean;    // keep proportions
  k: number;        // number of colours
  con: number;      // contrast
  sat: number;      // colour boost
  dmc: boolean;     // snap to exact DMC colours
  crop: Crop;
}

export const DEFAULT_SETTINGS: Settings = {
  cutout: false, rm: true, thr: 234, trim: true, mesh: 18, win: 5, hin: 5, lock: true,
  k: 8, con: 1.4, sat: 1.15, dmc: true, crop: { x: 0, y: 0, w: 1, h: 1 },
};

export interface PaletteEntry {
  rgb: RGB;
  thread: Thread;
  count: number;
  done: number;
  sym: string;
}

export interface BuiltChart {
  W: number;
  H: number;
  /** palette index per stitch, -1 = background */
  idx: Int16Array;
  pal: PaletteEntry[];
  /** number of background (unstitched) squares */
  bg: number;
}

const isBackground = (r: number, g: number, b: number, a: number, rm: boolean, thr: number) =>
  a < 128 || (rm && Math.min(r, g, b) > thr);

/** Step 2: the box around everything that isn't background, in pixel coordinates, or null if it's all background.
 *  See-through pixels always count as background; light pixels only when `rm` is on. */
export function findTrimBox(rgba: ArrayLike<number>, w: number, h: number, thr: number, rm = true): Box | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (!isBackground(rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3], rm, thr)) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

const capSt = (v: number) => Math.max(MIN_ST, Math.min(MAX_ST, Math.round(v)));

/** Step 3: stitches = inches × mesh. With proportions kept, height follows from width and the picture's shape. */
export function stitchSize(s: Pick<Settings, "win" | "hin" | "mesh" | "lock">, aspect: number): { W: number; H: number } {
  const W = capSt((s.win || 1) * s.mesh);
  const H = s.lock ? capSt(W / aspect) : capSt((s.hin || 1) * s.mesh);
  return { W, H };
}

/** With proportions kept, the other side shown as the exact size the stitches come to. */
export function syncedHeight(win: number, mesh: number, aspect: number): string {
  const W = Math.round((win || 1) * mesh);
  return (Math.round(W / aspect) / mesh).toFixed(2);
}
export function syncedWidth(hin: number, mesh: number, aspect: number): string {
  const H = Math.round((hin || 1) * mesh);
  return (Math.round(H * aspect) / mesh).toFixed(2);
}

const dist2 = (p: ArrayLike<number>, q: ArrayLike<number>) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;

/**
 * Steps 5–8: background, boost, pick colours (k-means), match threads.
 * `px` is RGBA, one pixel per stitch, W × H.
 */
export function buildChart(px: ArrayLike<number>, W: number, H: number, s: Pick<Settings, "rm" | "thr" | "k" | "con" | "sat" | "dmc">): BuiltChart {
  const N = W * H;

  // 5 + 6: background, then colour boost, then contrast
  const fg: number[][] = []; // [r, g, b, stitchIndex]
  for (let i = 0; i < N; i++) {
    let r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    const a = px[i * 4 + 3];
    if (isBackground(r, g, b, a, s.rm, s.thr)) continue;
    if (a < 255) { const t = a / 255; r = r * t + 255 * (1 - t); g = g * t + 255 * (1 - t); b = b * t + 255 * (1 - t); }
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    r = l + (r - l) * s.sat; g = l + (g - l) * s.sat; b = l + (b - l) * s.sat;
    fg.push([clamp((r - 128) * s.con + 128), clamp((g - 128) * s.con + 128), clamp((b - 128) * s.con + 128), i]);
  }

  const idx = new Int16Array(N).fill(-1);
  if (!fg.length) return { W, H, idx, pal: [], bg: N };

  // 7: k-means, seeded with the darkest pixel, then repeatedly the pixel furthest from every seed so far
  const k = Math.min(s.k, fg.length);
  let dark = fg[0];
  for (const p of fg) if (p[0] + p[1] + p[2] < dark[0] + dark[1] + dark[2]) dark = p;
  const cent: number[][] = [[dark[0], dark[1], dark[2]]];
  const dmin = new Float64Array(fg.length).fill(Infinity);
  while (cent.length < k) {
    const c = cent[cent.length - 1];
    let best = 0, bi = 0;
    for (let j = 0; j < fg.length; j++) {
      const d = dist2(fg[j], c);
      if (d < dmin[j]) dmin[j] = d;
      if (dmin[j] > best) { best = dmin[j]; bi = j; }
    }
    if (!best) break;
    cent.push([fg[bi][0], fg[bi][1], fg[bi][2]]);
  }
  const lab = new Int16Array(fg.length);
  for (let it = 0; it < 25; it++) {
    const sum = cent.map(() => [0, 0, 0, 0]);
    let moved = 0;
    for (let j = 0; j < fg.length; j++) {
      const p = fg[j];
      let bd = Infinity, bk = 0;
      for (let c = 0; c < cent.length; c++) { const d = dist2(p, cent[c]); if (d < bd) { bd = d; bk = c; } }
      if (lab[j] !== bk) { lab[j] = bk; moved++; }
      const t = sum[bk]; t[0] += p[0]; t[1] += p[1]; t[2] += p[2]; t[3]++;
    }
    sum.forEach((t, c) => { if (t[3]) cent[c] = [t[0] / t[3], t[1] / t[3], t[2] / t[3]]; });
    if (!moved && it) break;
  }

  // 8: closest DMC thread per colour; exact-DMC mode merges colours that land on the same thread
  type Group = { ids: number[]; rgb: RGB; thread: Thread };
  let groups: Group[] = cent.map((c, i) => ({ ids: [i], rgb: c.map(Math.round) as RGB, thread: nearestDMC(c)[0] }));
  if (s.dmc) {
    const merged = new Map<string, Group>();
    for (const gp of groups) {
      const e = merged.get(gp.thread.code);
      if (e) e.ids.push(...gp.ids);
      else merged.set(gp.thread.code, { ...gp, ids: [...gp.ids], rgb: [...gp.thread.rgb] as RGB });
    }
    groups = [...merged.values()];
  }
  const counts = groups.map(() => 0), map = new Int16Array(cent.length);
  groups.forEach((gp, gi) => gp.ids.forEach(i => (map[i] = gi)));
  for (let j = 0; j < fg.length; j++) counts[map[lab[j]]]++;

  // number colours lightest to darkest
  const order = groups.map((_, i) => i).filter(i => counts[i]).sort((a, b) => lum(groups[b].rgb) - lum(groups[a].rgb));
  const re = new Int16Array(groups.length).fill(-1);
  order.forEach((o, n) => (re[o] = n));
  const pal: PaletteEntry[] = order.map((o, n) => ({
    rgb: groups[o].rgb, thread: groups[o].thread, count: counts[o], done: 0, sym: SYMS[n % SYMS.length],
  }));
  for (let j = 0; j < fg.length; j++) idx[fg[j][3]] = re[map[lab[j]]];

  return { W, H, idx, pal, bg: N - fg.length };
}
