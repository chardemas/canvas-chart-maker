import { describe, expect, it } from "vitest";
import { buildChart } from "./chart";
import { ERASER, addColour, paintCell, recount, tickCell, undoChanges, type Change, type Editable } from "./edit";

/** 6 × 1 strip: background, red, red, blue, blue, background */
function strip(): Editable {
  const cols = [[255, 255, 255], [199, 43, 59], [199, 43, 59], [19, 71, 125], [19, 71, 125], [255, 255, 255]];
  const px = new Uint8ClampedArray(cols.flatMap(c => [...c, 255]));
  const c = buildChart(px, 6, 1, { rm: true, thr: 234, k: 4, con: 1, sat: 1, dmc: true });
  return { ...c, done: new Uint8Array(6) };
}
const counts = (c: Editable) => ({ bg: c.bg, count: c.pal.map(p => p.count), palDone: c.pal.map(p => p.done) });

describe("editing stitches", () => {
  it("ticking skips background and counts done stitches", () => {
    const c = strip();
    expect(tickCell(c, 0, 1)).toBeNull();
    expect(tickCell(c, 1, 1)).toEqual([1, 0, 0]);
    expect(tickCell(c, 1, 1)).toBeNull();
    expect(counts(c)).toEqual({ bg: 2, count: [2, 2], palDone: [1, 0] });
  });

  it("repainting moves the stitch between colours and unticks it", () => {
    const c = strip();
    tickCell(c, 1, 1);
    expect(paintCell(c, 1, 1)).toEqual([1, 0, 1]);
    expect(c.done[1]).toBe(0);
    expect(counts(c)).toEqual({ bg: 2, count: [1, 3], palDone: [0, 0] });
  });

  it("the eraser turns stitches into background, and background can be painted", () => {
    const c = strip();
    paintCell(c, 3, ERASER);
    paintCell(c, 5, 0);
    expect(Array.from(c.idx)).toEqual([-1, 0, 0, -1, 1, 0]);
    expect(counts(c)).toEqual({ bg: 2, count: [3, 1], palDone: [0, 0] });
  });

  it("incremental counts always match a full recount", () => {
    const c = strip();
    const ops: (Change | null)[] = [tickCell(c, 2, 1), paintCell(c, 2, ERASER), paintCell(c, 0, 1), tickCell(c, 0, 1), paintCell(c, 4, 0)];
    expect(ops.every(Boolean)).toBe(true);
    const before = counts(c);
    recount(c);
    expect(counts(c)).toEqual(before);
  });

  it("undo puts squares and ticks back exactly", () => {
    const c = strip();
    tickCell(c, 1, 1);
    const snapshot = { idx: Array.from(c.idx), done: Array.from(c.done), ...counts(c) };
    const stroke = [paintCell(c, 1, 1), paintCell(c, 0, 1), paintCell(c, 3, ERASER)].filter(Boolean) as Change[];
    undoChanges(c, stroke);
    expect({ idx: Array.from(c.idx), done: Array.from(c.done), ...counts(c) }).toEqual(snapshot);
  });

  it("added colours get the nearest DMC thread and an unused symbol", () => {
    const c = strip();
    const n = addColour(c, [0, 0, 0], true);
    expect(n).toBe(2);
    expect(c.pal[2].thread.code).toBe("310");
    expect(new Set(c.pal.map(p => p.sym)).size).toBe(3);
    expect(c.pal[2].count).toBe(0);
  });
});
