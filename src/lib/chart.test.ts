import { describe, expect, it } from "vitest";
import { de2000, toLab, type Lab } from "./color";
import { DMC, nearestDMC } from "./dmc";
import { buildChart, findTrimBox, stitchSize, syncedHeight, SYMS, DEFAULT_SETTINGS } from "./chart";

/** RGBA pixels, w × h, filled by a function of (x, y). */
function image(w: number, h: number, f: (x: number, y: number) => [number, number, number, number?]) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a = 255] = f(x, y), i = (y * w + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  }
  return px;
}

/** Small seeded random generator, so "noisy" test pictures are the same every run. */
function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}

const S = { rm: true, thr: 234, k: 8, con: 1, sat: 1, dmc: true };

describe("colour difference (CIEDE2000)", () => {
  // reference pairs from Sharma, Wu & Dalal (2005), the standard CIEDE2000 test data
  const cases: [Lab, Lab, number][] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514], 0.9082],
  ];
  it.each(cases)("matches the published value %#", (p, q, want) => {
    expect(de2000(p, q)).toBeCloseTo(want, 3);
  });
  it("white is L=100 with no colour", () => {
    const [L, a, b] = toLab([255, 255, 255]);
    expect(L).toBeCloseTo(100, 1); expect(Math.abs(a)).toBeLessThan(0.5); expect(Math.abs(b)).toBeLessThan(0.5);
  });
});

describe("DMC threads", () => {
  it("has all 489 colours", () => expect(DMC).toHaveLength(489));
  it("matches exact thread colours to themselves", () => {
    for (const code of ["310", "321", "797", "B5200", "3865", "699"]) {
      const t = DMC.find(d => d.code === code)!;
      expect(nearestDMC(t.rgb)[0].rgb).toEqual(t.rgb);
    }
  });
  it("returns the n nearest, nearest first", () => {
    const near = nearestDMC([200, 30, 60], 8);
    expect(near).toHaveLength(8);
    const lab = toLab([200, 30, 60]);
    const d = near.map(t => de2000(lab, t.lab));
    expect([...d].sort((a, b) => a - b)).toEqual(d);
  });
});

describe("trim", () => {
  it("finds the box around the design", () => {
    const px = image(20, 10, (x, y) => (x >= 4 && x <= 9 && y >= 2 && y <= 6 ? [0, 0, 0] : [255, 255, 255]));
    expect(findTrimBox(px, 20, 10, 234)).toEqual({ x: 4, y: 2, w: 6, h: 5 });
  });
  it("treats see-through pixels as background", () => {
    const px = image(5, 5, (x, y) => (x === 2 && y === 3 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
    expect(findTrimBox(px, 5, 5, 234)).toEqual({ x: 2, y: 3, w: 1, h: 1 });
  });
  it("returns null for an all-background picture", () => {
    expect(findTrimBox(image(4, 4, () => [250, 250, 250]), 4, 4, 234)).toBeNull();
  });
});

describe("size", () => {
  it("is inches × mesh", () => {
    expect(stitchSize({ win: 5, hin: 4, mesh: 18, lock: false }, 1)).toEqual({ W: 90, H: 72 });
  });
  it("takes height from width and shape when proportions are kept", () => {
    expect(stitchSize({ win: 5, hin: 99, mesh: 18, lock: true }, 2)).toEqual({ W: 90, H: 45 });
    expect(syncedHeight(5, 18, 2)).toBe("2.50");
  });
  it("caps each side at 300 stitches and at least 4", () => {
    expect(stitchSize({ win: 24, hin: 24, mesh: 18, lock: false }, 1)).toEqual({ W: 300, H: 300 });
    expect(stitchSize({ win: 1, hin: 1, mesh: 10, lock: true }, 100)).toEqual({ W: 10, H: 4 });
  });
});

describe("building the chart", () => {
  // three flat colour blocks on a white background
  const W = 30, H = 10;
  const blocks = image(W, H, x => (x < 5 ? [255, 255, 255] : x < 13 ? [199, 43, 59] : x < 21 ? [19, 71, 125] : x < 25 ? [0, 0, 0] : [255, 255, 255]));

  it("leaves the background unstitched and counts stitches", () => {
    const c = buildChart(blocks, W, H, S);
    expect(c.bg).toBe(10 * H);
    expect(c.pal.reduce((a, p) => a + p.count, 0)).toBe(20 * H);
    for (let y = 0; y < H; y++) { expect(c.idx[y * W]).toBe(-1); expect(c.idx[y * W + 29]).toBe(-1); }
  });

  it("finds the colours, matches them to DMC and numbers them lightest first", () => {
    const c = buildChart(blocks, W, H, S);
    expect(c.pal.map(p => p.thread.code)).toEqual(["321", "797", "310"]);
    expect(c.pal.map(p => p.count)).toEqual([80, 80, 40]);
    expect(c.pal.map(p => p.sym)).toEqual(SYMS.slice(0, 3));
    expect(c.idx[6]).toBe(0); expect(c.idx[15]).toBe(1); expect(c.idx[22]).toBe(2);
  });

  it("with exact DMC colours, uses the thread's colour; without, keeps the picture's", () => {
    const off = image(4, 1, () => [200, 40, 60]);
    expect(buildChart(off, 4, 1, { ...S, dmc: true }).pal[0].rgb).toEqual(DMC.find(d => d.code === buildChart(off, 4, 1, S).pal[0].thread.code)!.rgb);
    expect(buildChart(off, 4, 1, { ...S, dmc: false }).pal[0].rgb).toEqual([200, 40, 60]);
  });

  it("merges colours that land on the same thread", () => {
    const close = image(10, 1, x => (x < 5 ? [0, 0, 0] : [3, 3, 3]));
    expect(buildChart(close, 10, 1, { ...S, k: 2, dmc: false }).pal).toHaveLength(2);
    expect(buildChart(close, 10, 1, { ...S, k: 2, dmc: true }).pal).toHaveLength(1);
  });

  it("keeps white stitches when background removal is off", () => {
    const c = buildChart(blocks, W, H, { ...S, rm: false });
    expect(c.bg).toBe(0);
    expect(c.pal[0].thread.code).toBe("B5200");
  });

  it("returns an empty palette for an all-background picture", () => {
    const c = buildChart(image(5, 5, () => [255, 255, 255]), 5, 5, S);
    expect(c.pal).toEqual([]); expect(c.bg).toBe(25);
  });

  it("gives the same chart every time for a sample picture", () => {
    const r = rng(42);
    const sw = 60, sh = 40;
    // a soft gradient "design" with noise, on white
    const sample = image(sw, sh, (x, y) => {
      const d = Math.hypot(x - 30, y - 20);
      if (d > 18) return [255, 255, 255];
      const n = (r() - 0.5) * 30;
      return [180 - d * 6 + n, 60 + x * 2 + n, 90 + y * 3 + n];
    });
    const settings = { rm: true, thr: DEFAULT_SETTINGS.thr, k: 8, con: DEFAULT_SETTINGS.con, sat: DEFAULT_SETTINGS.sat, dmc: true };
    const a = buildChart(sample, sw, sh, settings), b = buildChart(sample, sw, sh, settings);
    expect(Array.from(a.idx)).toEqual(Array.from(b.idx));
    expect(a.pal).toEqual(b.pal);
    // pinned result: if this changes, the chart recipe changed
    expect({
      bg: a.bg,
      palette: a.pal.map(p => `${p.thread.code} ${p.count}`),
      grid: hash(a.idx),
    }).toMatchSnapshot();
  });
});

function hash(a: Int16Array) {
  let h = 2166136261;
  for (const v of a) { h ^= v & 0xffff; h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16);
}
