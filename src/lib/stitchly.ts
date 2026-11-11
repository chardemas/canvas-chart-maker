/**
 * Opens Stitchly pattern files (.stitchly): an XML property list whose PatternData is a binary
 * property list made by Apple's NSKeyedArchiver. The pattern is `width` × `height` with one thread
 * code per square in `layerCodes` (row by row, "empty" = unstitched). Codes look like "D310",
 * "DP892", "DB5200", "DBLANC", or "<id>-1 D817" for Stitchly's own blended colours.
 */
import { threadByCode, type Thread } from "./dmc";
import { DEFAULT_SETTINGS, SYMS, type ExactThread, type Settings } from "./chart";

type PValue = null | boolean | number | string | Uint8Array | PValue[] | { [k: string]: PValue } | { uid: number };

/** Reads an Apple binary property list (bplist00). */
export function parseBplist(b: Uint8Array): PValue {
  const td = new TextDecoder();
  if (td.decode(b.subarray(0, 8)) !== "bplist00") throw new Error("Not a binary property list.");
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const t = b.length - 32;
  const offSize = b[t + 6], refSize = b[t + 7];
  const num = Number(dv.getBigUint64(t + 8)), top = Number(dv.getBigUint64(t + 16)), table = Number(dv.getBigUint64(t + 24));
  const uint = (at: number, n: number) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[at + i]; return v; };
  const offsets = Array.from({ length: num }, (_, i) => uint(table + i * offSize, offSize));
  const seen = new Map<number, PValue>();

  const read = (ref: number): PValue => {
    if (seen.has(ref)) return seen.get(ref)!;
    let at = offsets[ref];
    const m = b[at] >> 4, lo = b[at] & 15;
    at++;
    // length: low nibble, or a following int object when it's 15
    const len = () => {
      if (lo !== 15) return lo;
      const n = 1 << (b[at] & 15); const v = uint(at + 1, n); at += 1 + n; return v;
    };
    let v: PValue;
    switch (m) {
      case 0x0: v = lo === 8 ? false : lo === 9 ? true : null; break;
      case 0x1: { const n = 1 << lo; v = n === 8 ? Number(dv.getBigInt64(at)) : uint(at, n); break; }
      case 0x2: v = lo === 2 ? dv.getFloat32(at) : dv.getFloat64(at); break;
      case 0x3: v = dv.getFloat64(at); break; // date: seconds since 2001
      case 0x4: { const n = len(); v = b.slice(at, at + n); break; }
      case 0x5: { const n = len(); v = String.fromCharCode(...b.subarray(at, at + n)); break; }
      case 0x6: { const n = len(); let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(at + 2 * i)); v = s; break; }
      case 0x8: v = { uid: uint(at, lo + 1) }; break;
      case 0xa: { const n = len(), arr: PValue[] = []; v = arr; seen.set(ref, v); for (let i = 0; i < n; i++) arr.push(read(uint(at + i * refSize, refSize))); break; }
      case 0xd: {
        const n = len(), obj: { [k: string]: PValue } = {}; v = obj; seen.set(ref, v);
        for (let i = 0; i < n; i++) obj[String(read(uint(at + i * refSize, refSize)))] = read(uint(at + (n + i) * refSize, refSize));
        break;
      }
      default: throw new Error(`Unsupported property list item (type ${m}).`);
    }
    seen.set(ref, v);
    return v;
  };
  return read(top);
}

export interface StitchlyPattern {
  name: string;
  W: number;
  H: number;
  mesh: number;
  /** thread code per square, row by row; "" = unstitched */
  codes: string[];
  /** Stitchly's chart symbol for each code, where it has one */
  symbols: Record<string, string>;
}

const isUid = (v: PValue): v is { uid: number } => !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array) && "uid" in v;

/** Reads a .stitchly file's text. */
export function parseStitchly(xml: string): StitchlyPattern {
  const m = xml.match(/<key>PatternData<\/key>\s*<data>([\s\S]*?)<\/data>/);
  if (!m) throw new Error("This doesn't look like a Stitchly pattern file.");
  const bin = Uint8Array.from(atob(m[1].replace(/\s+/g, "")), c => c.charCodeAt(0));
  const arch = parseBplist(bin) as { $objects: PValue[]; $top: { root: PValue } };
  const objs = arch.$objects;
  const get = (v: PValue): PValue => (isUid(v) ? objs[v.uid] : v);
  const root = get(arch.$top.root) as Record<string, PValue>;
  const W = Number(get(root.width)), H = Number(get(root.height));
  const list = get(root.layerCodes) as Record<string, PValue> | undefined;
  const cells = (list?.["NS.objects"] ?? []) as PValue[];
  if (!W || !H || cells.length !== W * H) throw new Error("Couldn't read the stitches in this Stitchly file.");
  const codes = cells.map(c => { const s = String(get(c)); return s.endsWith("empty") ? "" : s; });
  const name = String(get(root.patternName) ?? "Stitchly pattern");
  const symbols: Record<string, string> = {};
  const dict = get(root.symbolsForCodes) as Record<string, PValue> | undefined;
  const keys = (dict?.["NS.keys"] ?? []) as PValue[], vals = (dict?.["NS.objects"] ?? []) as PValue[];
  keys.forEach((k, i) => { const sym = String(get(vals[i])); if (sym && sym !== "$null") symbols[String(get(k))] = sym; });
  return { name: name === "$null" ? "Stitchly pattern" : name, W, H, mesh: Number(get(root.fabricCount)) || 18, codes, symbols };
}

/** DMC variegated threads that aren't in the colour list: an in-between colour for each. */
const VARIEGATED: Record<string, { name: string; rgb: [number, number, number] }> = {
  "48": { name: "Variegated Baby Pink", rgb: [240, 176, 196] },
  "107": { name: "Variegated Pink", rgb: [228, 120, 150] },
};

/** The DMC thread a Stitchly code stands for, or its colour if it's a thread not in the list. */
export function threadForCode(code: string): { thread?: Thread; rgb?: [number, number, number]; name?: string; dmc: string } {
  const last = code.trim().split(/\s+/).pop() ?? "";
  const dmc = last.replace(/^DP?(?=[0-9]|B5200|BLANC|ECRU)/i, "");
  const thread = threadByCode(dmc) ?? threadByCode(dmc.charAt(0).toUpperCase() + dmc.slice(1).toLowerCase());
  return thread ? { thread, dmc } : { rgb: VARIEGATED[dmc]?.rgb, name: VARIEGATED[dmc]?.name, dmc };
}

export interface StitchlyPicture {
  /** RGBA, one pixel per stitch, see-through where unstitched; each thread has its own exact colour */
  rgba: Uint8ClampedArray;
  W: number;
  H: number;
  colours: number;
  /** variegated threads, shown in an in-between colour */
  approx: string[];
  /** settings that open this picture as exactly this pattern (threads, order and symbols) */
  settings: Settings;
}

/** The pattern as an exact picture plus the settings that open it unchanged: no colour picking, Stitchly's symbols. */
export function stitchlyPicture(p: StitchlyPattern, colours: Record<string, [number, number, number]> = {}): StitchlyPicture {
  const rgba = new Uint8ClampedArray(p.W * p.H * 4);
  const threads: ExactThread[] = [], byCode = new Map<string, ExactThread>(), usedRgb = new Set<string>(), approx = new Set<string>();
  const usedSym = new Set<string>();
  p.codes.forEach((code, i) => {
    if (!code) return;
    const t = threadForCode(code);
    const key = t.thread?.code ?? (t.dmc || code);
    const own = colours[key]; // a colour taken from the pattern's exported image
    let e = byCode.get(key);
    if (!e) {
      const rgb: [number, number, number] = [...(t.thread?.rgb ?? own ?? t.rgb ?? [128, 128, 128])] as [number, number, number];
      if (!t.thread && !own) approx.add(key);
      // every thread needs its own pixel colour; nudge an approximate colour that clashes
      while (usedRgb.has(rgb.join(","))) rgb[2] = rgb[2] < 255 ? rgb[2] + 1 : rgb[2] - 1;
      usedRgb.add(rgb.join(","));
      const want = p.symbols[code];
      const sym = want && !usedSym.has(want) ? want : SYMS.find(x => !usedSym.has(x)) ?? "?";
      usedSym.add(sym);
      e = { code: key, name: t.thread?.name ?? t.name ?? (own ? "Stitchly colour" : `Thread ${key}`), rgb, sym };
      byCode.set(key, e); threads.push(e);
    }
    rgba.set([e.rgb[0], e.rgb[1], e.rgb[2], 255], i * 4);
  });
  return {
    rgba, W: p.W, H: p.H, colours: threads.length, approx: [...approx],
    settings: {
      ...DEFAULT_SETTINGS,
      cutout: false, rm: false, trim: false, lock: true, con: 1, sat: 1, dmc: true,
      mesh: p.mesh, win: +(p.W / p.mesh).toFixed(4), hin: +(p.H / p.mesh).toFixed(4), k: Math.max(2, threads.length),
      crop: { x: 0, y: 0, w: 1, h: 1 },
      exact: threads,
    },
  };
}

/** Codes the app has no colour for: not DMC, and not one of the known variegated threads. */
export function unknownCodes(p: StitchlyPattern): string[] {
  const out = new Set<string>();
  for (const code of p.codes) {
    if (!code) continue;
    const t = threadForCode(code);
    if (!t.thread && !t.rgb) out.add(t.dmc || code);
  }
  return [...out];
}

/**
 * Each code's colour, read from an image of the pattern exported from Stitchly. The image is lined up
 * with the stitch grid by the pattern's outline: either the stitched squares fill the picture, or the
 * whole grid does (when the export shows the empty background too); whichever fits the colours better.
 */
export function coloursFromImage(px: ArrayLike<number>, iw: number, ih: number, p: StitchlyPattern): { colours: Record<string, [number, number, number]>; fit: number } {
  const keyOf = (code: string) => { const t = threadForCode(code); return t.thread?.code ?? (t.dmc || code); };
  // background: the most common corner colour
  const at = (x: number, y: number) => { const i = (y * iw + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
  const corners = [at(2, 2), at(iw - 3, 2), at(2, ih - 3), at(iw - 3, ih - 3)];
  const bg = corners.map(c => c.join(",")).sort().reduce((best, c, _i, all) => (all.filter(x => x === c).length > all.filter(x => x === best).length ? c : best)).split(",").map(Number);
  const differs = (x: number, y: number) => { const [r, g, b] = at(x, y); return Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 40; };
  // the drawn area: rows and columns with more than a sliver of non-background
  const colHits = new Int32Array(iw), rowHits = new Int32Array(ih);
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) if (differs(x, y)) { colHits[x]++; rowHits[y]++; }
  const span = (hits: Int32Array, len: number, other: number) => {
    const min = Math.max(1, other * 0.003);
    let a = 0, b = len - 1;
    while (a < len && hits[a] < min) a++;
    while (b > a && hits[b] < min) b--;
    return [a, b + 1];
  };
  const [ix0, ix1] = span(colHits, iw, ih), [iy0, iy1] = span(rowHits, ih, iw);
  if (ix1 - ix0 < 4 || iy1 - iy0 < 4) throw new Error("That image looks empty. Export the pattern from Stitchly as an image and try again.");

  // the stitched squares' outline in grid squares
  let c0 = p.W, c1 = -1, r0 = p.H, r1 = -1;
  p.codes.forEach((code, i) => { if (!code) return; const c = i % p.W, r = Math.floor(i / p.W); c0 = Math.min(c0, c); c1 = Math.max(c1, c); r0 = Math.min(r0, r); r1 = Math.max(r1, r); });

  const tryFit = (g0: number, g1: number, h0: number, h1: number) => {
    const sx = (ix1 - ix0) / (g1 - g0 + 1), sy = (iy1 - iy0) / (h1 - h0 + 1);
    const samples = new Map<string, number[][]>();
    p.codes.forEach((code, i) => {
      if (!code) return;
      const c = i % p.W, r = Math.floor(i / p.W);
      const cx = ix0 + (c - g0 + 0.5) * sx, cy = iy0 + (r - h0 + 0.5) * sy, hw = Math.max(0, Math.floor(sx * 0.2)), hh = Math.max(0, Math.floor(sy * 0.2));
      const rs: number[] = [], gs: number[] = [], bs: number[] = [];
      for (let y = Math.round(cy) - hh; y <= Math.round(cy) + hh; y++) for (let x = Math.round(cx) - hw; x <= Math.round(cx) + hw; x++) {
        if (x < 0 || y < 0 || x >= iw || y >= ih) continue;
        const [rr, gg, bb] = at(x, y); rs.push(rr); gs.push(gg); bs.push(bb);
      }
      if (!rs.length) return;
      const med = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1];
      const k = keyOf(code), list = samples.get(k) ?? [];
      list.push([med(rs), med(gs), med(bs)]); samples.set(k, list);
    });
    const colours: Record<string, [number, number, number]> = {};
    let agree = 0, total = 0;
    for (const [k, list] of samples) {
      const med = (j: number) => list.map(v => v[j]).sort((a, b) => a - b)[list.length >> 1];
      const c: [number, number, number] = [med(0), med(1), med(2)];
      colours[k] = c;
      for (const v of list) { total++; if (Math.abs(v[0] - c[0]) + Math.abs(v[1] - c[1]) + Math.abs(v[2] - c[2]) < 45) agree++; }
    }
    return { colours, fit: total ? agree / total : 0, square: Math.abs(sx / sy - 1) };
  };
  const a = tryFit(c0, c1, r0, r1), b = tryFit(0, p.W - 1, 0, p.H - 1);
  const best = (a.square < 0.2 ? a.fit : 0) >= (b.square < 0.2 ? b.fit : 0) ? a : b;
  if (best.fit < 0.85) throw new Error("That image doesn't line up with this pattern. Export just the pattern from Stitchly as an image (no page, title or colour list around it).");
  return { colours: best.colours, fit: best.fit };
}
