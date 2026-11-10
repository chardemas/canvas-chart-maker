/**
 * Print on canvas: find every hole in a 600 dpi scan of blank canvas taped to the carrier page,
 * then draw each stitch's colour on its own thread crossing (the patch between its four holes).
 *
 * Coordinates: "scan px" are pixel indices in the scan. "Page px" are physical positions on the
 * letter page in 1/600 in, measured from the top-left corner (pixel x covers page px x..x+1).
 * Ported from tools/print-align/print_align.py, which was checked against real prints.
 */

export const DPI = 600;
export const PAGE_W = 8.5 * DPI, PAGE_H = 11 * DPI;
/** carrier corner dots (page inches): top-left, top-right, bottom-left, bottom-right */
export const DOTS_IN: [number, number][] = [[0.5, 0.5], [8.0, 0.5], [0.5, 10.5], [8.0, 10.5]];
export const DOT_R_IN = 0.08;
/** small extra dot beside the top-left one, so the page's orientation is obvious */
export const ORIENT_IN: [number, number] = [0.85, 0.5];
export const ORIENT_R_IN = 0.04;
/** the dark panel the canvas is taped over: x0, y0, x1, y1 in inches */
export const PANEL_IN = [1.0, 1.0, 7.5, 10.0] as const;
export const PANEL_GREY = 70;

export type Pt = [number, number];
/** 3×3 homography, row-major */
export type Homography = number[];

/* ---------- connected components, run-length based so a 34-megapixel scan needs no label image ---------- */

interface Blob { area: number; cx: number; cy: number; w: number; h: number }

class Grow {
  a: Int32Array; n = 0;
  constructor(cap = 1 << 16) { this.a = new Int32Array(cap); }
  push(v: number) {
    if (this.n === this.a.length) { const b = new Int32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
}

/** Blobs of pixels where `row(y, mask)` sets mask[x] = 1 (8-connected). */
export function blobs(w: number, h: number, row: (y: number, mask: Uint8Array) => void): Blob[] {
  const mask = new Uint8Array(w);
  const x0 = new Grow(), x1 = new Grow(), ry = new Grow(), lab = new Grow(), parent = new Grow();
  const find = (k: number) => {
    let r = k;
    while (parent.a[r] !== r) r = parent.a[r];
    while (parent.a[k] !== r) { const n = parent.a[k]; parent.a[k] = r; k = n; }
    return r;
  };
  let ps = 0, pe = 0; // previous row's runs
  for (let y = 0; y < h; y++) {
    mask.fill(0);
    row(y, mask);
    const cs = x0.n;
    let p = ps;
    for (let x = 0; x < w; x++) {
      if (!mask[x]) continue;
      const s = x;
      while (x + 1 < w && mask[x + 1]) x++;
      const id = parent.n; parent.push(id);
      x0.push(s); x1.push(x); ry.push(y); lab.push(id);
      // previous-row runs touching this one (diagonals count)
      while (p < pe && x1.a[p] < s - 1) p++;
      for (let q = p; q < pe && x0.a[q] <= x + 1; q++) {
        const a = find(lab.a[q]), b = find(id);
        if (a !== b) parent.a[Math.max(a, b)] = Math.min(a, b);
      }
    }
    ps = cs; pe = x0.n;
  }
  const n = parent.n;
  const area = new Float64Array(n), sx = new Float64Array(n), sy = new Float64Array(n);
  const mnx = new Int32Array(n).fill(1 << 30), mxx = new Int32Array(n).fill(-1), mny = new Int32Array(n).fill(1 << 30), mxy = new Int32Array(n).fill(-1);
  for (let k = 0; k < x0.n; k++) {
    const r = find(lab.a[k]), a = x0.a[k], b = x1.a[k], y = ry.a[k], len = b - a + 1;
    area[r] += len; sx[r] += ((a + b) * len) / 2; sy[r] += y * len;
    if (a < mnx[r]) mnx[r] = a;
    if (b > mxx[r]) mxx[r] = b;
    if (y < mny[r]) mny[r] = y;
    if (y > mxy[r]) mxy[r] = y;
  }
  const out: Blob[] = [];
  for (let r = 0; r < n; r++) if (area[r] > 0) out.push({ area: area[r], cx: sx[r] / area[r], cy: sy[r] / area[r], w: mxx[r] - mnx[r] + 1, h: mxy[r] - mny[r] + 1 });
  return out;
}

/* ---------- carrier dots and scan → page mapping ---------- */

/** The four corner-dot centres in scan px (ordered like DOTS_IN), or null if any is missing. */
export function findDots(gray: Uint8Array, w: number, h: number): Pt[] | null {
  const r = DOT_R_IN * DPI;
  const cand = blobs(w, h, (y, m) => { const o = y * w; for (let x = 0; x < w; x++) if (gray[o + x] < 100) m[x] = 1; })
    .filter(b => Math.abs(b.w - 2 * r) < 0.35 * r && Math.abs(b.h - 2 * r) < 0.35 * r && b.area > 0.7 * Math.PI * r * r);
  const out: Pt[] = [];
  for (const [ix, iy] of DOTS_IN) {
    const ex = ix * DPI, ey = iy * DPI;
    let best: Blob | null = null, bd = Infinity;
    for (const b of cand) { const d = Math.hypot(b.cx - ex, b.cy - ey); if (d < bd) { bd = d; best = b; } }
    if (!best || bd > 0.6 * DPI) return null;
    out.push([best.cx, best.cy]);
  }
  return out;
}

/** Solves an n×n linear system in place (Gaussian elimination with pivoting). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k];
    x[r] = s / A[r][r];
  }
  return x;
}

/** Homography taking 4 points exactly onto 4 others. */
export function homography(src: Pt[], dst: Pt[]): Homography {
  const A: number[][] = [], b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  return [...solve(A, b), 1];
}

export function applyH(H: Homography, x: number, y: number): Pt {
  const d = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d];
}

/** Scan px → page px from the carrier dots found in the scan. */
export function scanToPage(dots: Pt[]): Homography {
  return homography(dots, DOTS_IN.map(([x, y]) => [x * DPI, y * DPI] as Pt));
}

/* ---------- printer correction ---------- */

/** How a printer misplaces ink: printed = planned + A·(p − centre) + t, in page px. */
export interface PrinterProfile { name: string; centre: Pt; A: [[number, number], [number, number]]; t: Pt }

/** Epson ET-2803, measured from two test prints (Nov 2026) with the sheet pushed against the side guide. */
export const ET2803: PrinterProfile = {
  name: "Epson ET-2803",
  centre: [2550, 3300],
  A: [[-8.535956147541103e-05, 0.0021144700255514423], [-0.0030574336917796037, 0.000597079523163863]],
  t: [5.719911097681839, 3.3003299291738935],
};

/** The page position to send to the printer so the ink lands on `q`. */
export function precorrect(q: Pt, p: PrinterProfile): Pt {
  const [[a, b], [c, d]] = p.A;
  // solve (I + A)(x − centre) = q − centre − t
  const m00 = 1 + a, m01 = b, m10 = c, m11 = 1 + d, det = m00 * m11 - m01 * m10;
  const rx = q[0] - p.centre[0] - p.t[0], ry = q[1] - p.centre[1] - p.t[1];
  return [p.centre[0] + (m11 * rx - m01 * ry) / det, p.centre[1] + (-m10 * rx + m00 * ry) / det];
}

/* ---------- holes ---------- */

/**
 * Hole centres in scan px. A pixel is "hole" when it is clearly darker than its neighbourhood
 * (3×3-smoothed value at least 25 below the 51×51 average) — holes show the dark panel, threads are white.
 */
export function findHoles(gray: Uint8Array, w: number, h: number): Pt[] {
  const R = 25, C = 25, N = (2 * R + 1) ** 2;
  const clampY = (y: number) => (y < 0 ? 0 : y >= h ? h - 1 : y);
  const col = new Float64Array(w);
  for (let k = -R; k <= R; k++) { const o = clampY(k) * w; for (let x = 0; x < w; x++) col[x] += gray[o + x]; }
  const ext = new Float64Array(w + 2 * R + 1); // prefix sums over the column sums, edges repeated
  const g = (x: number, y: number) => gray[clampY(y) * w + (x < 0 ? 0 : x >= w ? w - 1 : x)];
  const found = blobs(w, h, (y, m) => {
    if (y > 0) {
      const out = clampY(y - 1 - R) * w, inn = clampY(y + R) * w;
      for (let x = 0; x < w; x++) col[x] += gray[inn + x] - gray[out + x];
    }
    ext[0] = 0;
    for (let i = 0; i < w + 2 * R; i++) ext[i + 1] = ext[i] + col[i - R < 0 ? 0 : i - R >= w ? w - 1 : i - R];
    for (let x = 0; x < w; x++) {
      const mean = (ext[x + 2 * R + 1] - ext[x]) / N;
      const s = (g(x - 1, y - 1) + 2 * g(x, y - 1) + g(x + 1, y - 1) + 2 * g(x - 1, y) + 4 * g(x, y) + 2 * g(x + 1, y)
        + g(x - 1, y + 1) + 2 * g(x, y + 1) + g(x + 1, y + 1)) / 16;
      if (s <= mean - C) m[x] = 1;
    }
  });
  return found.filter(b => b.area > 40 && b.area < 1200 && b.w > 5 && b.h > 5 && b.w < 50 && b.h < 50).map(b => [b.cx, b.cy] as Pt);
}

/** Nearest-point lookups on a bucket grid. */
class PointGrid {
  private cells = new Map<number, number[]>();
  readonly pts: Pt[];
  readonly size: number;
  constructor(pts: Pt[], size: number) {
    this.pts = pts; this.size = size;
    pts.forEach(([x, y], i) => {
      const k = this.key(Math.floor(x / size), Math.floor(y / size));
      const c = this.cells.get(k);
      if (c) c.push(i); else this.cells.set(k, [i]);
    });
  }
  private key(cx: number, cy: number) { return (cx + 4096) * 16384 + (cy + 4096); }
  /** indices within `r` (r ≤ size), nearest first */
  near(x: number, y: number, r: number): number[] {
    const cx = Math.floor(x / this.size), cy = Math.floor(y / this.size), hits: [number, number][] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const i of this.cells.get(this.key(cx + dx, cy + dy)) ?? []) {
        const d = Math.hypot(this.pts[i][0] - x, this.pts[i][1] - y);
        if (d <= r) hits.push([d, i]);
      }
    }
    return hits.sort((a, b) => a[0] - b[0]).map(h => h[1]);
  }
  nearest(x: number, y: number, r: number): [number, number] | null {
    const n = this.near(x, y, r)[0];
    return n === undefined ? null : [n, Math.hypot(this.pts[n][0] - x, this.pts[n][1] - y)];
  }
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN; };

export interface Lattice {
  /** grid index (i, j) of entry 0 */
  i0: number; j0: number;
  ni: number; nj: number;
  /** hole centre in scan px for every grid point, x then y, index (i − i0)·nj + (j − j0) */
  pos: Float64Array;
  /** 1 where a hole was actually seen (the rest are filled in from neighbours) */
  seen: Uint8Array;
  /** count of holes seen */
  holes: number;
  /** holes per inch along the rows and down the columns */
  meshX: number; meshY: number;
  /** how far the threads are from crossing at 90° */
  skewDeg: number;
  /** average distance of the holes from a perfectly straight grid, mm */
  wobbleMm: number;
}

/**
 * Turns hole centres into a numbered grid, grown outward from the middle with local steps
 * so it follows gently curving threads, then fills unseen points (under tape) from neighbours,
 * `pad` holes beyond what was seen on every side.
 */
export function buildLattice(pts: Pt[], pad: number): Lattice {
  if (pts.length < 500) throw new Error(`Only found ${pts.length} hole-like spots. Is the canvas taped over the dark panel?`);
  const grid = new PointGrid(pts, 80);
  const vec: Pt[] = [], dist: number[] = [];
  pts.forEach(([x, y]) => {
    for (const j of grid.near(x, y, 80).slice(1, 5)) { const v: Pt = [pts[j][0] - x, pts[j][1] - y]; vec.push(v); dist.push(Math.hypot(v[0], v[1])); }
  });
  const pitch = median(dist.filter(d => d > 15 && d < 80));
  const near = (k: number) => Math.abs(dist[k] - pitch) < 0.25 * pitch;
  const pick = (f: (v: Pt) => boolean): Pt => {
    const s = vec.filter((v, k) => near(k) && f(v));
    return [median(s.map(v => v[0])), median(s.map(v => v[1]))];
  };
  const ex = pick(v => Math.abs(v[1]) < 0.4 * pitch && v[0] > 0), ey = pick(v => Math.abs(v[0]) < 0.4 * pitch && v[1] > 0);

  // grow the grid from the hole nearest the middle of all detections
  const mx = median(pts.map(p => p[0])), my = median(pts.map(p => p[1]));
  let seed = 0, sd = Infinity;
  pts.forEach(([x, y], k) => { const d = Math.hypot(x - mx, y - my); if (d < sd) { sd = d; seed = k; } });
  const coord = new Map<number, Pt>([[seed, [0, 0]]]);
  const step = new Map<number, [Pt, Pt]>([[seed, [ex, ey]]]);
  const stack = [seed];
  while (stack.length) {
    const k = stack.pop()!;
    const [ci, cj] = coord.get(k)!, [sx, sy] = step.get(k)!;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const gx = pts[k][0] + di * sx[0] + dj * sy[0], gy = pts[k][1] + di * sx[1] + dj * sy[1];
      const hit = grid.nearest(gx, gy, 0.3 * pitch);
      if (!hit || coord.has(hit[0])) continue;
      const j = hit[0], s = di + dj;
      coord.set(j, [ci + di, cj + dj]);
      const v: Pt = [(pts[j][0] - pts[k][0]) * s, (pts[j][1] - pts[k][1]) * s]; // the actual local step
      step.set(j, di ? [v, sy] : [sx, v]);
      stack.push(j);
    }
  }

  // best straight (affine) grid through what was seen; distances from it are the wobble
  let IJ = [...coord.values()], P = [...coord.keys()].map(k => pts[k]);
  const fit = (IJ: Pt[], P: Pt[]) => {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
    IJ.forEach(([i, j], n) => {
      const r = [i, j, 1];
      for (let a = 0; a < 3; a++) { for (let b = 0; b < 3; b++) A[a][b] += r[a] * r[b]; bx[a] += r[a] * P[n][0]; by[a] += r[a] * P[n][1]; }
    });
    return [solve(A.map(r => [...r]), bx), solve(A.map(r => [...r]), by)];
  };
  let [fx, fy] = fit(IJ, P);
  const resid = (IJ: Pt[], P: Pt[]) => IJ.map(([i, j], n) => [P[n][0] - (fx[0] * i + fx[1] * j + fx[2]), P[n][1] - (fy[0] * i + fy[1] * j + fy[2])] as Pt);
  let res = resid(IJ, P);
  const rlen = res.map(r => Math.hypot(r[0], r[1]));
  const cut = 4 * median(rlen) + 2; // drop spots that were numbered wrongly
  const keep = rlen.map(d => d < cut);
  IJ = IJ.filter((_, n) => keep[n]); P = P.filter((_, n) => keep[n]);
  [fx, fy] = fit(IJ, P);
  res = resid(IJ, P);

  let imin = Infinity, imax = -Infinity, jmin = Infinity, jmax = -Infinity;
  for (const [i, j] of IJ) { imin = Math.min(imin, i); imax = Math.max(imax, i); jmin = Math.min(jmin, j); jmax = Math.max(jmax, j); }
  const i0 = imin - pad, j0 = jmin - pad, ni = imax - imin + 1 + 2 * pad, nj = jmax - jmin + 1 + 2 * pad;
  const rx = new Float64Array(ni * nj), ry = new Float64Array(ni * nj), seen = new Uint8Array(ni * nj), have = new Uint8Array(ni * nj);
  let frontier: number[] = [];
  IJ.forEach(([i, j], n) => { const k = (i - i0) * nj + (j - j0); rx[k] = res[n][0]; ry[k] = res[n][1]; seen[k] = have[k] = 1; frontier.push(k); });
  // fill the rest outward, layer by layer, from the average of already-known neighbours
  while (frontier.length) {
    const next: number[] = [], add = new Map<number, [number, number, number]>();
    for (const k of frontier) {
      const i = Math.floor(k / nj), j = k % nj;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= ni || b >= nj) continue;
        const q = a * nj + b;
        if (have[q]) continue;
        const s = add.get(q) ?? [0, 0, 0];
        s[0] += rx[k]; s[1] += ry[k]; s[2]++;
        add.set(q, s);
      }
    }
    for (const [q, [sx, sy, c]] of add) { rx[q] = sx / c; ry[q] = sy / c; have[q] = 1; next.push(q); }
    frontier = next;
  }
  const pos = new Float64Array(ni * nj * 2);
  for (let a = 0; a < ni; a++) for (let b = 0; b < nj; b++) {
    const k = a * nj + b, i = a + i0, j = b + j0;
    pos[2 * k] = fx[0] * i + fx[1] * j + fx[2] + rx[k];
    pos[2 * k + 1] = fy[0] * i + fy[1] * j + fy[2] + ry[k];
  }
  const ux = Math.hypot(fx[0], fy[0]), uy = Math.hypot(fx[1], fy[1]);
  const cos = (fx[0] * fx[1] + fy[0] * fy[1]) / (ux * uy);
  return {
    i0, j0, ni, nj, pos, seen, holes: IJ.length,
    meshX: DPI / ux, meshY: DPI / uy,
    skewDeg: (Math.acos(cos) * 180) / Math.PI - 90,
    wobbleMm: (res.reduce((a, r) => a + Math.hypot(r[0], r[1]), 0) / res.length / DPI) * 25.4,
  };
}

/** Hole centre (scan px) at grid index (i, j). */
export function holeAt(L: Lattice, i: number, j: number): Pt {
  const k = ((i - L.i0) * L.nj + (j - L.j0)) * 2;
  return [L.pos[k], L.pos[k + 1]];
}

/* ---------- placing the chart ---------- */

/** Grid index of the hole at the chart's top-left corner, centring the chart on the canvas that was seen. */
export function centredAnchor(L: Lattice, W: number, H: number): Pt {
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (let a = 0; a < L.ni; a++) for (let b = 0; b < L.nj; b++) if (L.seen[a * L.nj + b]) {
    a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
  }
  // W stitches span W + 1 holes: put equal numbers of seen holes on each side
  return [Math.round((a0 + a1 - W) / 2) + L.i0, Math.round((b0 + b1 - H) / 2) + L.j0];
}

export interface Fit { fits: boolean; unseen: number }

/** Whether a W×H chart anchored at (ai, aj) sits inside the grid, and the share of its holes that were never seen. */
export function checkFit(L: Lattice, W: number, H: number, ai: number, aj: number): Fit {
  const a = ai - L.i0, b = aj - L.j0;
  if (a < 0 || b < 0 || a + W + 1 > L.ni || b + H + 1 > L.nj) return { fits: false, unseen: 1 };
  let miss = 0;
  for (let i = 0; i <= W; i++) for (let j = 0; j <= H; j++) if (!L.seen[(a + i) * L.nj + b + j]) miss++;
  return { fits: true, unseen: miss / ((W + 1) * (H + 1)) };
}

/** The four hole centres (scan px) around stitch (c, r): top-left, top-right, bottom-right, bottom-left. */
export function stitchQuad(L: Lattice, ai: number, aj: number, c: number, r: number): Pt[] {
  const i = ai + c, j = aj + r;
  return [holeAt(L, i, j), holeAt(L, i + 1, j), holeAt(L, i + 1, j + 1), holeAt(L, i, j + 1)];
}

/* ---------- drawing the print ---------- */

export interface Raster { x: number; y: number; w: number; h: number; rgb: Uint8Array }

/**
 * Draws every stitch as a filled patch at its place on the page (page px), white elsewhere.
 * Only the box around the design is drawn; `x, y` is its top-left on the page.
 * `colour(c, r)` gives [r, g, b] or null for unstitched squares.
 */
export function rasterize(quads: (c: number, r: number) => Pt[], W: number, H: number, colour: (c: number, r: number) => ArrayLike<number> | null): Raster {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const all: (Pt[] | null)[] = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    if (!colour(c, r)) { all.push(null); continue; }
    const q = quads(c, r);
    all.push(q);
    for (const [x, y] of q) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  if (!isFinite(x0)) return { x: 0, y: 0, w: 1, h: 1, rgb: new Uint8Array([255, 255, 255]) };
  const X = Math.max(0, Math.floor(x0)), Y = Math.max(0, Math.floor(y0));
  const w = Math.min(Math.ceil(PAGE_W), Math.ceil(x1) + 1) - X, h = Math.min(Math.ceil(PAGE_H), Math.ceil(y1) + 1) - Y;
  const rgb = new Uint8Array(w * h * 3).fill(255);
  let n = 0;
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    const q = all[n++];
    if (!q) continue;
    const col = colour(c, r)!;
    fillQuad(q, X, Y, w, h, (o) => { rgb[o] = col[0]; rgb[o + 1] = col[1]; rgb[o + 2] = col[2]; });
  }
  return { x: X, y: Y, w, h, rgb };
}

/** Calls `set(offset)` for each pixel whose centre is inside the convex quad (page px, raster at X, Y). */
function fillQuad(q: Pt[], X: number, Y: number, w: number, h: number, set: (o: number) => void) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of q) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  // signed area tells the winding; inside = same side of every edge
  let area = 0;
  for (let k = 0; k < 4; k++) { const [ax, ay] = q[k], [bx, by] = q[(k + 1) % 4]; area += ax * by - bx * ay; }
  const sgn = area >= 0 ? 1 : -1;
  for (let py = Math.max(Math.floor(y0), Y); py <= Math.min(Math.ceil(y1), Y + h - 1); py++) {
    const cy = py + 0.5;
    for (let px = Math.max(Math.floor(x0), X); px <= Math.min(Math.ceil(x1), X + w - 1); px++) {
      const cx = px + 0.5;
      let inside = true;
      for (let k = 0; k < 4 && inside; k++) {
        const [ax, ay] = q[k], [bx, by] = q[(k + 1) % 4];
        if (sgn * ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) < 0) inside = false;
      }
      if (inside) set(((py - Y) * w + (px - X)) * 3);
    }
  }
}

/* ---------- turning the design ---------- */

/** The stitch grid turned clockwise by `turns` quarter turns (0–3). Unstitched squares stay -1. */
export function rotateGrid(idx: Int16Array, W: number, H: number, turns: number): { idx: Int16Array; W: number; H: number } {
  const t = ((turns % 4) + 4) % 4;
  if (t === 0) return { idx, W, H };
  const nW = t % 2 ? H : W, nH = t % 2 ? W : H, out = new Int16Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
    // where square (c, r) ends up after the turn
    const [nc, nr] = t === 1 ? [H - 1 - r, c] : t === 2 ? [W - 1 - c, H - 1 - r] : [r, W - 1 - c];
    out[nr * nW + nc] = idx[r * W + c];
  }
  return { idx: out, W: nW, H: nH };
}
