import { describe, expect, it, vi } from "vitest";
vi.mock("./supabase", () => ({ supabase: {} }));
import { buildChart } from "./chart";
import { tickCell } from "./edit";
import type { Chart } from "./render";
import { decodeChart, decodeProgress, encodeChart, newLinkId, packDone, snapshot, stitchCount, toChart, unpackDone } from "./shared";
import { pack } from "./backup";

const scramble = (v: unknown): unknown => // the database reorders keys
  Array.isArray(v) ? v.map(scramble)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).reverse().map(k => [k, scramble((v as Record<string, unknown>)[k])]))
  : v;

function sample(): Chart {
  const cols = [[255, 255, 255], [199, 43, 59], [199, 43, 59], [19, 71, 125], [19, 71, 125], [255, 255, 255]];
  const px = new Uint8ClampedArray(cols.flatMap(c => [...c, 255]));
  const c = buildChart(px, 3, 2, { rm: true, thr: 234, k: 4, con: 1, sat: 1, dmc: true });
  return { ...c, done: new Uint8Array(6), key: "x" };
}

describe("customer links", () => {
  it("the customer gets exactly the maker's chart, with no ticks", () => {
    const c = sample();
    tickCell(c, 1, 1);
    c.idx[5] = 0; // a hand fix
    const back = toChart(decodeChart(scramble(JSON.parse(JSON.stringify(encodeChart(snapshot(c, 18)))))), "shared:x");
    expect(Array.from(back.idx)).toEqual(Array.from(c.idx));
    expect(back.pal.map(p => [p.thread.code, p.sym])).toEqual(c.pal.map(p => [p.thread.code, p.sym]));
    expect(back.pal.map(p => p.count)).toEqual([3, 2]);
    expect(Array.from(back.done)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(stitchCount(back)).toBe(5);
  });

  it("ticks pack 8 to a byte and come back exactly", () => {
    const done = new Uint8Array(90001).map((_, i) => (i % 7 === 0 || i % 11 === 3 ? 1 : 0));
    const p = packDone(done);
    expect(p.bits.length).toBe(11251);
    expect(Array.from(unpackDone(p, done.length)!)).toEqual(Array.from(done));
    expect(Array.from(decodeProgress(scramble(JSON.parse(JSON.stringify(pack(p)))), done.length)!)).toEqual(Array.from(done));
    expect(unpackDone(p, done.length - 1)).toBeNull(); // a different chart's ticks are ignored
  });

  it("link ids are long, random and match what the database accepts", () => {
    const ids = new Set(Array.from({ length: 200 }, newLinkId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{20,64}$/);
  });

  it("refuses something that isn't a chart", () => {
    expect(() => decodeChart({ v: 1, W: 3, H: 2, idx: [1, 2], pal: [] })).toThrow();
    expect(() => decodeChart(null)).toThrow();
  });
});
