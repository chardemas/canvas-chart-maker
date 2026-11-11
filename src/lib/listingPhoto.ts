/**
 * Listing photos: cut a scanned canvas out of its dark backing, holes included, so the listing
 * background shows through the mesh as if the canvas were lying on it; then white-balance from the
 * bare canvas threads and add gentle vibrance. Works on RGBA pixels; no browser needed (tested in node).
 */
export interface Cutout {
  /** RGBA, see-through outside the canvas and in its holes */
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
  /** the canvas's box in the input */
  box: { x: number; y: number; w: number; h: number };
}

const lumOf = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
const satOf = (r: number, g: number, b: number) => { const mx = Math.max(r, g, b); return mx ? (mx - Math.min(r, g, b)) / mx : 0; };

/** Backing: very dark (any colour; noise makes near-black look "colourful"), or dark grey (the printed backing sheet). */
export function isBacking(r: number, g: number, b: number): boolean {
  const l = lumOf(r, g, b);
  return l < 60 || (l < 135 && satOf(r, g, b) < 0.3);
}

/** Square binary dilation (grow) or erosion (shrink) by `r` pixels, using running counts. */
function morph(m: Uint8Array, w: number, h: number, r: number, grow: boolean): Uint8Array {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h), win = 2 * r + 1;
  const pass = (src: Uint8Array, dst: Uint8Array, len: number, lines: number, at: (line: number, i: number) => number) => {
    for (let l = 0; l < lines; l++) {
      let count = 0;
      for (let i = -r; i < len + r; i++) {
        if (i + r < len && i + r >= 0) count += src[at(l, i + r)]; // outside the image counts as empty
        if (i - r - 1 >= 0) count -= src[at(l, i - r - 1)];
        if (i >= 0 && i < len) dst[at(l, i)] = grow ? (count > 0 ? 1 : 0) : (count === win ? 1 : 0);
      }
    }
  };
  pass(m, tmp, w, h, (y, x) => y * w + x);
  pass(tmp, out, h, w, (x, y) => y * w + x);
  return out;
}

/**
 * Cuts the canvas out of a scan where it lies on a dark backing.
 * `pitch` is the hole spacing in pixels at this resolution (about 17 at 300 dpi for 18 mesh).
 */
export function cutOutCanvas(rgba: Uint8ClampedArray, w: number, h: number, pitch: number, whole = false): Cutout {
  if (whole) return holesOnly(rgba, w, h, pitch);
  const N = w * h, back = new Uint8Array(N);
  for (let i = 0; i < N; i++) back[i] = isBacking(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) ? 1 : 0;

  // the canvas as a solid shape: everything that isn't backing, with its holes closed up
  let solid = new Uint8Array(N);
  for (let i = 0; i < N; i++) solid[i] = back[i] ? 0 : 1;
  const r = Math.max(2, Math.round(pitch * 0.6));
  // first drop thin specks and scanner streaks (threads are far thicker), then close up the holes
  solid = morph(morph(solid, w, h, 2, false), w, h, 2, true);
  solid = morph(morph(solid, w, h, r, true), w, h, r, false);

  // the biggest piece that doesn't touch the edge of the scan (the edge is paper margin or lid),
  // found by flood fill so each piece knows whether it reaches the border
  let best = -1, bestArea = 0, label = 0;
  const marks = new Int32Array(N).fill(-1);
  const stack: number[] = [];
  const boxes: [number, number, number, number][] = [];
  for (let s = 0; s < N; s++) {
    if (!solid[s] || marks[s] >= 0) continue;
    let edge = false, area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
    marks[s] = label; stack.push(s);
    while (stack.length) {
      const p = stack.pop()!, x = p % w, y = (p - x) / w;
      area++;
      // the closing step pulls shapes in from the image edge by up to r, so "near the edge" counts
      if (x <= r + 1 || y <= r + 1 || x >= w - 2 - r || y >= h - 2 - r) edge = true;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && solid[p - 1] && marks[p - 1] < 0) { marks[p - 1] = label; stack.push(p - 1); }
      if (x < w - 1 && solid[p + 1] && marks[p + 1] < 0) { marks[p + 1] = label; stack.push(p + 1); }
      if (y > 0 && solid[p - w] && marks[p - w] < 0) { marks[p - w] = label; stack.push(p - w); }
      if (y < h - 1 && solid[p + w] && marks[p + w] < 0) { marks[p + w] = label; stack.push(p + w); }
    }
    boxes.push([x0, y0, x1, y1]);
    if (!edge && area > bestArea) { bestArea = area; best = label; }
    label++;
  }
  if (best < 0) throw new Error("Couldn't find the canvas on its own. Take it off the carrier (no tape) and lay it loose on the dark backing sheet, away from the edges.");

  // fill in anything enclosed by the canvas (dark painted areas), by flooding the outside
  const [bx0, by0, bx1, by1] = boxes[best];
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
  const inside = new Uint8Array(bw * bh).fill(1);
  const q: number[] = [];
  const outside = (x: number, y: number) => marks[(y + by0) * w + x + bx0] !== best;
  for (let x = 0; x < bw; x++) for (const y of [0, bh - 1]) if (outside(x, y) && inside[y * bw + x]) { inside[y * bw + x] = 0; q.push(y * bw + x); }
  for (let y = 0; y < bh; y++) for (const x of [0, bw - 1]) if (outside(x, y) && inside[y * bw + x]) { inside[y * bw + x] = 0; q.push(y * bw + x); }
  while (q.length) {
    const p = q.pop()!, x = p % bw, y = (p - x) / bw;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
      const k = ny * bw + nx;
      if (inside[k] && outside(nx, ny)) { inside[k] = 0; q.push(k); }
    }
  }

  // holes: small patches of backing inside the canvas; big dark patches are painted areas and stay
  const holeMax = pitch * pitch * 0.8;
  const out = new Uint8ClampedArray(bw * bh * 4);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const s = ((y + by0) * w + x + bx0) * 4, d = (y * bw + x) * 4;
    out[d] = rgba[s]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s + 2];
    out[d + 3] = inside[y * bw + x] ? 255 : 0;
  }
  const holeBlobs = new Uint8Array(bw * bh);
  // label backing patches inside the canvas and clear the small ones
  const seen = new Uint8Array(bw * bh);
  for (let s = 0; s < bw * bh; s++) {
    if (seen[s] || !inside[s] || !back[(Math.floor(s / bw) + by0) * w + (s % bw) + bx0]) continue;
    const members: number[] = [s];
    seen[s] = 1;
    for (let i = 0; i < members.length && members.length <= holeMax + 1; i++) {
      const p = members[i], x = p % bw, y = (p - x) / bw;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const k = ny * bw + nx;
        if (!seen[k] && inside[k] && back[(ny + by0) * w + nx + bx0]) { seen[k] = 1; members.push(k); }
      }
    }
    if (members.length <= holeMax) for (const k of members) holeBlobs[k] = 1;
  }
  for (let k = 0; k < bw * bh; k++) if (holeBlobs[k]) out[k * 4 + 3] = 0;
  softenEdges(out, bw, bh);
  return { rgba: out, w: bw, h: bh, box: { x: bx0, y: by0, w: bw, h: bh } };
}

/** For a crop from inside the canvas (the close-up): no outline to find, just clear the holes. */
function holesOnly(rgba: Uint8ClampedArray, w: number, h: number, pitch: number): Cutout {
  const N = w * h, out = new Uint8ClampedArray(rgba), seen = new Uint8Array(N), holeMax = pitch * pitch * 0.8;
  const back = (k: number) => isBacking(rgba[k * 4], rgba[k * 4 + 1], rgba[k * 4 + 2]);
  for (let k = 0; k < N; k++) out[k * 4 + 3] = 255;
  for (let s = 0; s < N; s++) {
    if (seen[s] || !back(s)) continue;
    const members = [s]; seen[s] = 1;
    for (let i = 0; i < members.length && members.length <= holeMax + 1; i++) {
      const p = members[i], x = p % w, y = (p - x) / w;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const k = ny * w + nx;
        if (!seen[k] && back(k)) { seen[k] = 1; members.push(k); }
      }
    }
    if (members.length <= holeMax) for (const k of members) out[k * 4 + 3] = 0;
  }
  softenEdges(out, w, h);
  return { rgba: out, w, h, box: { x: 0, y: 0, w, h } };
}

/**
 * Edge matting: pixels on the rim of a hole or the canvas edge are a blend of light thread and dark
 * backing. Where a rim pixel is much darker than the brightest thread next to it, fade it out in
 * proportion, so holes have clean edges instead of a dark fringe. Rims in dark painted areas
 * (no bright neighbour) are left alone. Two passes handle a two-pixel blend.
 */
function softenEdges(px: Uint8ClampedArray, w: number, h: number) {
  for (let pass = 0; pass < 2; pass++) {
    const a = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) a[i] = px[i * 4 + 3];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (a[i] < 255 || (a[i - 1] && a[i + 1] && a[i - w] && a[i + w])) continue; // only opaque pixels beside a gap
      let maxN = 0;
      for (const j of [i - 1, i + 1, i - w, i + w, i - w - 1, i - w + 1, i + w - 1, i + w + 1]) {
        if (a[j] === 255) maxN = Math.max(maxN, lumOf(px[j * 4], px[j * 4 + 1], px[j * 4 + 2]));
      }
      if (maxN < 150) continue;
      const d = (maxN - lumOf(px[i * 4], px[i * 4 + 1], px[i * 4 + 2])) / maxN;
      px[i * 4 + 3] = Math.round(255 * Math.min(1, Math.max(0, 1 - 2 * d)));
    }
  }
}

export interface Look {
  /** extra brightness, 0 = none */
  brightness: number;
  /** colour boost for muted colours, 0 = none */
  vibrance: number;
}

/**
 * White balance from the bare canvas threads (bright, nearly colourless pixels): they become a clean
 * near-white, and every colour shifts with them. Then gentle vibrance. Only opaque pixels change.
 */
export function correctColour(px: Uint8ClampedArray, look: Look): { gains: [number, number, number] } {
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 255) continue;
    const r = px[i], g = px[i + 1], b = px[i + 2];
    if (lumOf(r, g, b) > 170 && satOf(r, g, b) < 0.12) { sr += r; sg += g; sb += b; n++; }
  }
  const target = 246;
  const clampGain = (v: number) => Math.min(1.5, Math.max(0.8, v));
  const gains: [number, number, number] = n > 50 ? [clampGain(target / (sr / n)), clampGain(target / (sg / n)), clampGain(target / (sb / n))] : [1, 1, 1];
  const bright = 1 + look.brightness;
  for (let i = 0; i < px.length; i += 4) {
    if (!px[i + 3]) continue;
    let r = px[i] * gains[0] * bright, g = px[i + 1] * gains[1] * bright, b = px[i + 2] * gains[2] * bright;
    const l = lumOf(r, g, b), s = satOf(Math.max(0, r), Math.max(0, g), Math.max(0, b));
    const k = 1 + look.vibrance * (1 - s); // muted colours get more boost than strong ones
    r = l + (r - l) * k; g = l + (g - l) * k; b = l + (b - l) * k;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; // Uint8ClampedArray clamps to 0..255
  }
  return { gains };
}
