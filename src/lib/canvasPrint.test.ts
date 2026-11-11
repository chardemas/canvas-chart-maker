/// <reference types="node" />
import { readFileSync } from "node:fs";
import { gunzipSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  DOT_R_IN, DOTS_IN, DPI, ET2803, applyH, blobs, buildLattice, centredAnchor, checkFit, findDots, findHoles,
  holeAt, homography, precorrect, rasterize, rotateGrid, scanToPage, stitchQuad, type Pt,
} from "./canvasPrint";
import { carrierPdf, printPdf } from "./pdf";

const fixture = (name: string) => new URL(`./__fixtures__/${name}`, import.meta.url);

/** A piece of a real 600 dpi scan (test3.png) and what the Python prototype found in it. */
const real = (() => {
  const ref = JSON.parse(readFileSync(fixture("canvas-crop.json"), "utf8")) as {
    w: number; h: number; holes: number; pitch: number; meshX: number; meshY: number; points: Pt[];
  };
  return { ref, gray: new Uint8Array(gunzipSync(readFileSync(fixture("canvas-crop.gray.gz")))) };
})();

/** Synthetic scan: white threads on a dark panel, holes at hole(i, j) with a given pitch, skew and bend. */
function fakeCanvas(w: number, h: number, hole: (i: number, j: number) => Pt, n: number) {
  const g = new Uint8Array(w * h).fill(235);
  const truth: [number, number, Pt][] = [];
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const [cx, cy] = hole(i, j);
    if (cx < 20 || cy < 20 || cx > w - 20 || cy > h - 20) continue;
    truth.push([i, j, [cx, cy]]);
    for (let y = Math.floor(cy - 8); y <= cy + 8; y++) for (let x = Math.floor(cx - 8); x <= cx + 8; x++) {
      if (Math.abs(x + 0.5 - cx - 0.5) <= 7.5 && Math.abs(y + 0.5 - cy - 0.5) <= 7.5) g[y * w + x] = 60;
    }
  }
  return { g, truth };
}

describe("blobs", () => {
  it("joins diagonal neighbours and measures area and centre", () => {
    const w = 6, img = [
      "1.....",
      ".1..11",
      "..1.11",
      "......",
    ];
    const b = blobs(w, img.length, (y, m) => { for (let x = 0; x < w; x++) if (img[y][x] === "1") m[x] = 1; })
      .sort((a, c) => a.cx - c.cx);
    expect(b.map(x => x.area)).toEqual([3, 4]);
    expect(b[0]).toMatchObject({ cx: 1, cy: 1, w: 3, h: 3 });
    expect(b[1]).toMatchObject({ cx: 4.5, cy: 1.5, w: 2, h: 2 });
  });

  it("joins a U shape whose arms only meet lower down", () => {
    const w = 5, img = ["1...1", "1...1", "11111"];
    expect(blobs(w, 3, (y, m) => { for (let x = 0; x < w; x++) if (img[y][x] === "1") m[x] = 1; })).toHaveLength(1);
  });
});

describe("mapping and printer correction", () => {
  it("a homography sends the four carrier dots exactly where they belong", () => {
    const dots: Pt[] = [[291, 280], [4776, 262], [251, 6270], [4745, 6280]];
    const H = scanToPage(dots);
    dots.forEach((d, k) => {
      const [x, y] = applyH(H, d[0], d[1]);
      expect(x).toBeCloseTo(DOTS_IN[k][0] * DPI, 6);
      expect(y).toBeCloseTo(DOTS_IN[k][1] * DPI, 6);
    });
    const I = homography([[0, 0], [1, 0], [0, 1], [1, 1]], [[0, 0], [1, 0], [0, 1], [1, 1]]);
    expect(applyH(I, 0.3, 0.7)[0]).toBeCloseTo(0.3, 9);
  });

  it("pre-correcting then printing lands on the target", () => {
    for (const q of [[1000, 2000], [4000, 6000], [2550, 3300]] as Pt[]) {
      const p = precorrect(q, ET2803);
      const [[a, b], [c, d]] = ET2803.A, dx = p[0] - ET2803.centre[0], dy = p[1] - ET2803.centre[1];
      expect(p[0] + a * dx + b * dy + ET2803.t[0]).toBeCloseTo(q[0], 6);
      expect(p[1] + c * dx + d * dy + ET2803.t[1]).toBeCloseTo(q[1], 6);
    }
  });
});

describe("carrier dots", () => {
  it("finds the four dots on a full-size page scan that sits a little off and turned", () => {
    const w = 5096, h = 6600, g = new Uint8Array(w * h).fill(250);
    const r = DOT_R_IN * DPI, rot = (0.6 * Math.PI) / 180, off: Pt = [21, -14];
    const where = DOTS_IN.map(([x, y]) => {
      const px = x * DPI, py = y * DPI;
      return [Math.cos(rot) * px - Math.sin(rot) * py + off[0], Math.sin(rot) * px + Math.cos(rot) * py + off[1]] as Pt;
    });
    for (const [cx, cy] of where) {
      for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
        if (Math.hypot(x - cx, y - cy) <= r) g[y * w + x] = 20;
      }
    }
    g.fill(30, 1000 * w, 1000 * w + 3000); // a dark line that isn't a dot
    const found = findDots(g, w, h)!;
    expect(found).not.toBeNull();
    found.forEach((p, k) => { expect(Math.hypot(p[0] - where[k][0], p[1] - where[k][1])).toBeLessThan(0.6); });
  });

  it("says so when a dot is covered", () => {
    expect(findDots(new Uint8Array(400 * 400).fill(250), 400, 400)).toBeNull();
  });
});

describe("holes and the grid", () => {
  it("numbers every hole of a skewed, slightly bent synthetic canvas and places it exactly", () => {
    const p = 34.1, sk = Math.tan((1.5 * Math.PI) / 180);
    const hole = (i: number, j: number): Pt => [600 + i * p + j * p * sk + 4 * Math.sin(j / 9), 600 + j * p * 0.995 + 3 * Math.sin(i / 11)];
    const { g, truth } = fakeCanvas(1200, 1200, hole, 20);
    const L = buildLattice(findHoles(g, 1200, 1200), 0);
    expect(L.holes).toBe(truth.length);
    // grid numbering may start anywhere; line it up on the hole nearest the middle
    const [ti, tj] = truth.reduce((best, t) => (Math.hypot(t[2][0] - 600, t[2][1] - 600) < Math.hypot(best[2][0] - 600, best[2][1] - 600) ? t : best));
    let worst = 0, sum = 0;
    for (const [i, j, [x, y]] of truth) {
      const [fx, fy] = holeAt(L, i - ti, j - tj);
      const e = Math.hypot(fx - x, fy - y);
      worst = Math.max(worst, e); sum += e;
    }
    // the fake holes are drawn on whole pixels, so each centre is only known to about half a pixel
    expect(sum / truth.length).toBeLessThan(0.4);
    expect(worst).toBeLessThan(1.2);
  });

  it("measures mesh count and how far out of square the canvas is", () => {
    const p = 34.1, sk = Math.tan((1.5 * Math.PI) / 180);
    const { g } = fakeCanvas(1200, 1200, (i, j) => [600 + i * p + j * p * sk, 600 + j * p * 1.01], 20);
    const L = buildLattice(findHoles(g, 1200, 1200), 0);
    expect(L.skewDeg).toBeCloseTo(-1.5 / 1.01, 1);
    expect(L.meshX).toBeCloseTo(DPI / p, 1);
    expect(L.meshY).toBeCloseTo(DPI / Math.hypot(p * sk, p * 1.01), 1);
    expect(L.wobbleMm).toBeLessThan(0.02);
  });

  it("matches the Python prototype on a piece of a real scan", () => {
    const { ref, gray } = real;
    const pts = findHoles(gray, ref.w, ref.h);
    const L = buildLattice(pts, 0);
    expect(Math.abs(L.holes - ref.holes) / ref.holes).toBeLessThan(0.02);
    expect(L.meshX).toBeCloseTo(ref.meshX, 1);
    expect(L.meshY).toBeCloseTo(ref.meshY, 1);
    // each hole Python found has one here within a fraction of a pixel
    const d = ref.points.map(([x, y]) => Math.min(...pts.map(q => Math.hypot(q[0] - x, q[1] - y)))).sort((a, b) => a - b);
    expect(d[d.length >> 1]).toBeLessThan(0.3);
    expect(d[Math.floor(d.length * 0.98)]).toBeLessThan(1.5);
  });

  it("fills in holes it couldn't see from their neighbours", () => {
    const p = 34;
    const { g } = fakeCanvas(1200, 1200, (i, j) => [600 + i * p, 600 + j * p], 20);
    // tape over a patch
    for (let y = 500; y < 700; y++) g.fill(240, y * 1200 + 500, y * 1200 + 700);
    const L = buildLattice(findHoles(g, 1200, 1200), 3);
    const [ci, cj] = [Math.round(L.i0 + L.ni / 2), Math.round(L.j0 + L.nj / 2)];
    const [x, y] = holeAt(L, ci, cj);
    expect(Math.abs(((x - 600) / p) - Math.round((x - 600) / p))).toBeLessThan(0.05);
    expect(Math.abs(((y - 600) / p) - Math.round((y - 600) / p))).toBeLessThan(0.05);
    const fit = checkFit(L, 10, 10, ci - 5, cj - 5);
    expect(fit.fits).toBe(true);
    expect(fit.unseen).toBeGreaterThan(0.1);
    expect(checkFit(L, 1000, 10, ci, cj).fits).toBe(false);
  });

  it("centres a chart on the canvas it saw", () => {
    const p = 34;
    const { g } = fakeCanvas(1200, 1200, (i, j) => [600 + i * p, 600 + j * p], 20);
    const L = buildLattice(findHoles(g, 1200, 1200), 40);
    const [ai, aj] = centredAnchor(L, 10, 6);
    const [x0, y0] = holeAt(L, ai, aj), [x1, y1] = holeAt(L, ai + 10, aj + 6);
    // the seen holes run symmetrically around 600, so the chart should sit dead centre
    expect(Math.abs((x0 + x1) / 2 - 600)).toBeLessThan(1);
    expect(Math.abs((y0 + y1) / 2 - 600)).toBeLessThan(1);
    expect(stitchQuad(L, ai, aj, 0, 0)[2]).toEqual(holeAt(L, ai + 1, aj + 1));
  });
});

describe("turning the design", () => {
  // 3 wide × 2 tall:  0 1 2
  //                   3 4 5
  const g = new Int16Array([0, 1, 2, 3, 4, 5]);
  it("turns a quarter right, half and a quarter left", () => {
    expect(rotateGrid(g, 3, 2, 1)).toEqual({ W: 2, H: 3, idx: new Int16Array([3, 0, 4, 1, 5, 2]) });
    expect(rotateGrid(g, 3, 2, 2)).toEqual({ W: 3, H: 2, idx: new Int16Array([5, 4, 3, 2, 1, 0]) });
    expect(rotateGrid(g, 3, 2, 3)).toEqual({ W: 2, H: 3, idx: new Int16Array([2, 5, 1, 4, 0, 3]) });
  });
  it("four quarter turns bring it back, and no turn leaves it alone", () => {
    let r = { idx: g, W: 3, H: 2 };
    for (let i = 0; i < 4; i++) r = rotateGrid(r.idx, r.W, r.H, 1);
    expect(r).toEqual({ idx: g, W: 3, H: 2 });
    expect(rotateGrid(g, 3, 2, -1)).toEqual(rotateGrid(g, 3, 2, 3));
  });
});

describe("drawing and PDFs", () => {
  it("fills each stitch's patch and leaves unstitched squares white", () => {
    const quads = (c: number, r: number): Pt[] => [[100 + c * 10, 200 + r * 10], [110 + c * 10, 200 + r * 10], [110 + c * 10, 210 + r * 10], [100 + c * 10, 210 + r * 10]];
    const R = rasterize(quads, 2, 1, c => (c === 0 ? [255, 0, 0] : null));
    expect([R.x, R.y]).toEqual([100, 200]);
    const px = (x: number, y: number) => Array.from(R.rgb.slice(((y - R.y) * R.w + (x - R.x)) * 3, ((y - R.y) * R.w + (x - R.x)) * 3 + 3));
    expect(px(105, 205)).toEqual([255, 0, 0]);
    expect(px(100, 200)).toEqual([255, 0, 0]);
    expect(px(109, 209)).toEqual([255, 0, 0]);
    expect(R.w).toBe(11); // the empty second stitch isn't drawn
  });

  it("writes a letter-size print PDF whose picture sits at the right spot", async () => {
    const rgb = new Uint8Array(30 * 20 * 3).fill(128);
    const bytes = new Uint8Array(await (await printPdf({ x: 600, y: 1200, w: 30, h: 20, rgb })).arrayBuffer());
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text).toContain("/MediaBox [0 0 612 792]");
    expect(text).toContain("q 3.6 0 0 2.4 72 645.6 cm /Im0 Do Q"); // 1 in from the left, top edge 2 in down (PDF y counts up from the bottom)
    // cross-reference offsets point at their objects
    const xref = +text.slice(text.lastIndexOf("startxref") + 10).trim().split("\n")[0];
    const rows = text.slice(xref).split("\n").slice(3, 8);
    rows.forEach((row, k) => expect(text.slice(+row.slice(0, 10)).startsWith(`${k + 1} 0 obj`)).toBe(true));
    // the picture decompresses to the right size
    const s = text.indexOf("stream\n", text.indexOf("/Subtype /Image")) + 7, len = +text.match(/\/Length (\d+)/)![1];
    expect(inflateSync(bytes.slice(s, s + len)).length).toBe(30 * 20 * 3);
  });

  it("writes the carrier page with its four dots", async () => {
    const text = await (await carrierPdf()).text();
    expect(text).toContain("/MediaBox [0 0 612 792]");
    expect((text.match(/ c f\n/g) ?? []).length).toBe(5);
    expect(text).toContain("41.76 756 m"); // top-left dot: centre 36 pt in, radius 5.76 pt
  });
});

describe("zip and backing sheet", async () => {
  const { zip, crc32 } = await import("./zip");
  const { backingPdf } = await import("./pdf");
  it("crc32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
  it("zips files that unzip back to the same bytes", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(tmpdir() + "/ziptest-");
    const a = new Uint8Array([1, 2, 3, 250]), b = new TextEncoder().encode("hello");
    writeFileSync(dir + "/t.zip", new Uint8Array(await zip([{ name: "a.bin", data: a }, { name: "b.txt", data: b }]).arrayBuffer()));
    execFileSync("unzip", ["-q", "t.zip"], { cwd: dir });
    expect(Array.from(readFileSync(dir + "/a.bin"))).toEqual([1, 2, 3, 250]);
    expect(readFileSync(dir + "/b.txt", "utf8")).toBe("hello");
  });
  it("makes a letter-size dark backing page", async () => {
    const t = await (await backingPdf()).text();
    expect(t).toContain("/MediaBox [0 0 612 792]");
    expect(t).toContain("0.22 g 18 18 576 756 re f");
  });
});
