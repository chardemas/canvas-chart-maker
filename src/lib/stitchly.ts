/**
 * Opens Stitchly pattern files (.stitchly): an XML property list whose PatternData is a binary
 * property list made by Apple's NSKeyedArchiver. The pattern is `width` × `height` with one thread
 * code per square in `layerCodes` (row by row, "empty" = unstitched). Codes look like "D310",
 * "DP892", "DB5200", "DBLANC", or "<id>-1 D817" for Stitchly's own blended colours.
 */
import { threadByCode, type Thread } from "./dmc";
import { DEFAULT_SETTINGS, type Settings } from "./chart";

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
  return { name: name === "$null" ? "Stitchly pattern" : name, W, H, mesh: Number(get(root.fabricCount)) || 18, codes };
}

/** DMC variegated threads that aren't in the colour list: an in-between colour for each. */
const VARIEGATED: Record<string, [number, number, number]> = { "48": [240, 176, 196], "107": [228, 120, 150] };

/** The DMC thread a Stitchly code stands for, or its colour if it's a thread not in the list. */
export function threadForCode(code: string): { thread?: Thread; rgb?: [number, number, number]; dmc: string } {
  const last = code.trim().split(/\s+/).pop() ?? "";
  const dmc = last.replace(/^DP?(?=[0-9]|B5200|BLANC|ECRU)/i, "");
  const thread = threadByCode(dmc) ?? threadByCode(dmc.charAt(0).toUpperCase() + dmc.slice(1).toLowerCase());
  return thread ? { thread, dmc } : { rgb: VARIEGATED[dmc], dmc };
}

export interface StitchlyPicture {
  /** RGBA, one pixel per stitch, see-through where unstitched */
  rgba: Uint8ClampedArray;
  W: number;
  H: number;
  colours: number;
  /** codes shown as something close rather than exactly */
  approx: string[];
  /** chart settings that turn this picture back into exactly this pattern */
  settings: Settings;
}

/** The pattern as an exact picture plus the settings that rebuild it stitch for stitch. */
export function stitchlyPicture(p: StitchlyPattern): StitchlyPicture {
  const rgba = new Uint8ClampedArray(p.W * p.H * 4);
  const colours = new Set<string>(), approx = new Set<string>();
  p.codes.forEach((code, i) => {
    if (!code) return;
    const t = threadForCode(code);
    const rgb = t.thread?.rgb ?? t.rgb ?? [128, 128, 128];
    if (!t.thread) approx.add(t.dmc || code);
    colours.add(rgb.join(","));
    rgba.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  });
  const win = +(p.W / p.mesh).toFixed(4);
  return {
    rgba, W: p.W, H: p.H, colours: colours.size, approx: [...approx],
    settings: {
      ...DEFAULT_SETTINGS,
      cutout: false, rm: false, trim: false, lock: true, con: 1, sat: 1, dmc: true,
      mesh: p.mesh, win, hin: +(p.H / p.mesh).toFixed(4), k: Math.max(2, colours.size),
      crop: { x: 0, y: 0, w: 1, h: 1 },
    },
  };
}
