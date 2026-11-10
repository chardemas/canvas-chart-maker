import { describe, expect, it } from "vitest";
import { parseBplist, parseStitchly, stitchlyPicture, threadForCode } from "./stitchly";
import { exactChart } from "./chart";

/* A tiny binary property list writer, just enough to make Stitchly-shaped test files. */
type V = string | number | boolean | V[] | { [k: string]: V } | { uid: number };
function bplist(top: V): Uint8Array {
  const objs: Uint8Array[] = [];
  const enc = (v: V): number => {
    const id = objs.length; objs.push(new Uint8Array());
    const head = (m: number, n: number) => (n < 15 ? [(m << 4) | n] : [(m << 4) | 15, 0x11, n >> 8, n & 255]);
    if (typeof v === "boolean") objs[id] = new Uint8Array([v ? 9 : 8]);
    else if (typeof v === "number") objs[id] = new Uint8Array([0x12, (v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]);
    else if (typeof v === "string") {
      if ([...v].every(c => c.charCodeAt(0) < 128)) objs[id] = new Uint8Array([...head(5, v.length), ...[...v].map(c => c.charCodeAt(0))]);
      else objs[id] = new Uint8Array([...head(6, v.length), ...[...v].flatMap(c => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 255])]);
    } else if (Array.isArray(v)) { const refs = v.map(enc); objs[id] = new Uint8Array([...head(0xa, refs.length), ...refs.flatMap(r => [r >> 8, r & 255])]); }
    else if ("uid" in v && Object.keys(v).length === 1) objs[id] = new Uint8Array([0x81, (v.uid as number) >> 8, (v.uid as number) & 255]);
    else {
      const ks = Object.keys(v), kr = ks.map(enc), vr = ks.map(k => enc((v as Record<string, V>)[k]));
      objs[id] = new Uint8Array([...head(0xd, ks.length), ...[...kr, ...vr].flatMap(r => [r >> 8, r & 255])]);
    }
    return id;
  };
  enc(top);
  const body: number[] = [..."bplist00"].map(c => c.charCodeAt(0)), offs: number[] = [];
  for (const o of objs) { offs.push(body.length); body.push(...o); }
  const table = body.length;
  for (const o of offs) body.push((o >> 24) & 255, (o >> 16) & 255, (o >> 8) & 255, o & 255);
  const u64 = (n: number) => [0, 0, 0, 0, (n >> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  body.push(0, 0, 0, 0, 0, 0, 4, 2, ...u64(objs.length), ...u64(0), ...u64(table));
  return new Uint8Array(body);
}

/** A Stitchly-shaped file: NSKeyedArchiver objects with the pattern root at $objects[1]. */
function stitchlyFile(W: number, H: number, cells: string[], name = "Test", symbols: Record<string, string> = {}) {
  const objects: V[] = ["$null"];
  const uniq = [...new Set(cells)];
  const root: Record<string, V> = { width: W, height: H, fabricCount: 18 };
  objects.push(root);
  root.patternName = { uid: objects.push(name) - 1 };
  const codeIds = uniq.map(c => objects.push(c) - 1);
  root.layerCodes = { uid: objects.push({ "NS.objects": cells.map(c => ({ uid: codeIds[uniq.indexOf(c)] })) }) - 1 };
  const sk = Object.keys(symbols);
  root.symbolsForCodes = { uid: objects.push({ "NS.keys": sk.map(k => ({ uid: objects.push(k) - 1 })), "NS.objects": sk.map(k => ({ uid: objects.push(symbols[k]) - 1 })) }) - 1 };
  const bin = bplist({ $version: 100000, $archiver: "NSKeyedArchiver", $top: { root: { uid: 1 } }, $objects: objects });
  const b64 = btoa(String.fromCharCode(...bin));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>PatternData</key>\n\t<data>\n\t${b64.replace(/(.{68})/g, "$1\n\t")}\n\t</data>\n</dict>\n</plist>\n`;
}

describe("Stitchly files", () => {
  it("reads binary property lists, including shared and unicode items", () => {
    const v = parseBplist(bplist({ a: [1, "x", "λ★"], b: true, u: { uid: 7 } })) as Record<string, unknown>;
    expect(v).toEqual({ a: [1, "x", "λ★"], b: true, u: { uid: 7 } });
  });

  it("reads the pattern size, mesh, name and each square's thread, row by row", () => {
    const cells = ["empty", "D310", "DP892", "DB5200", "DBLANC", "92CCBC38-8ABE-4131-BB1F-92C567F0C1BB-1 D817"];
    const p = parseStitchly(stitchlyFile(3, 2, cells, "Pattern"));
    expect(p).toMatchObject({ name: "Pattern", W: 3, H: 2, mesh: 18 });
    expect(p.codes[0]).toBe("");
    expect(p.codes.slice(1).map(c => threadForCode(c).thread?.code)).toEqual(["310", "892", "B5200", "Blanc", "817"]);
  });

  it("turns the pattern into an exact picture with its threads, order and symbols", () => {
    const pic = stitchlyPicture(parseStitchly(stitchlyFile(2, 2, ["D310", "empty", "D48", "D310"], "T", { D310: "@", D48: "★" })));
    expect([pic.W, pic.H, pic.colours]).toEqual([2, 2, 2]);
    expect(Array.from(pic.rgba.slice(0, 8))).toEqual([0, 0, 0, 255, 0, 0, 0, 0]); // DMC 310 is black; empty is see-through
    expect(pic.approx).toEqual(["48"]); // variegated: shown in an in-between colour, but keeps its own code
    expect(pic.settings.exact?.map(t => [t.code, t.sym])).toEqual([["310", "@"], ["48", "★"]]);
    expect(Math.round(pic.settings.win * pic.settings.mesh)).toBe(2);
  });

  it("opens exactly: every square keeps its thread and symbol, with no colour picking", () => {
    const cells = ["D310", "DP892", "empty", "D48", "DP892", "D310"];
    const pic = stitchlyPicture(parseStitchly(stitchlyFile(3, 2, cells, "T", { DP892: "Σ" })));
    const c = exactChart(pic.rgba, 3, 2, pic.settings.exact!);
    expect(Array.from(c.idx)).toEqual([0, 1, -1, 2, 1, 0]);
    expect(c.pal.map(p => [p.thread.code, p.thread.name.length > 0, p.count])).toEqual([["310", true, 2], ["892", true, 2], ["48", true, 1]]);
    expect(c.pal[1].sym).toBe("Σ");
    expect(new Set(c.pal.map(p => p.sym)).size).toBe(3); // symbols never repeat
    expect(c.pal[2].thread.name).toBe("Variegated Baby Pink");
    expect(c.bg).toBe(1);
  });

  it("says so for files that aren't Stitchly patterns", () => {
    expect(() => parseStitchly("<plist></plist>")).toThrow(/Stitchly/);
  });
});
