/**
 * Changing a chart by hand: ticking stitches off, repainting squares, adding colours, and undo.
 * Every change records what the square was before, so one undo history covers ticks and repaints.
 */
import type { RGB } from "./color";
import { SYMS, type BuiltChart } from "./chart";
import { nearestDMC } from "./dmc";

export interface Editable extends BuiltChart {
  done: Uint8Array;
}

/** [square, colour before (-1 = background), ticked before (0/1)] */
export type Change = [index: number, prevIdx: number, prevDone: number];

/** The eraser: paints a square back to background. */
export const ERASER = -1;

/** Recomputes every count from the grid. */
export function recount(c: Editable) {
  c.pal.forEach(p => { p.count = 0; p.done = 0; });
  let bg = 0;
  for (let i = 0; i < c.idx.length; i++) {
    const k = c.idx[i];
    if (k < 0) { bg++; continue; }
    c.pal[k].count++;
    if (c.done[i]) c.pal[k].done++;
  }
  c.bg = bg;
}

/** Ticks (v = 1) or unticks (v = 0) one stitch. Background squares can't be ticked. */
export function tickCell(c: Editable, i: number, v: 0 | 1): Change | null {
  const k = c.idx[i];
  if (k < 0 || c.done[i] === v) return null;
  const ch: Change = [i, k, c.done[i]];
  c.done[i] = v;
  c.pal[k].done += v ? 1 : -1;
  return ch;
}

/** Repaints one square with colour k (or ERASER). A repainted stitch starts unticked. */
export function paintCell(c: Editable, i: number, k: number): Change | null {
  const old = c.idx[i];
  if (old === k) return null;
  const ch: Change = [i, old, c.done[i]];
  if (old >= 0) { c.pal[old].count--; if (c.done[i]) c.pal[old].done--; } else c.bg--;
  if (k >= 0) c.pal[k].count++; else c.bg++;
  c.idx[i] = k;
  c.done[i] = 0;
  return ch;
}

/** Puts squares back as they were, newest change first. */
export function undoChanges(c: Editable, changes: Change[]) {
  for (let j = changes.length - 1; j >= 0; j--) {
    const [i, k, d] = changes[j];
    c.idx[i] = k; c.done[i] = d;
  }
  recount(c);
}

/** Adds a colour to the palette, matched to its nearest DMC thread, with a symbol not already in use. Returns its number. */
export function addColour(c: BuiltChart, rgb: RGB, exactDMC: boolean): number {
  const thread = nearestDMC(rgb)[0];
  const used = new Set(c.pal.map(p => p.sym));
  const sym = SYMS.find(s => !used.has(s)) ?? SYMS[c.pal.length % SYMS.length];
  c.pal.push({ rgb: exactDMC ? [...thread.rgb] as RGB : rgb, thread, count: 0, done: 0, sym });
  return c.pal.length - 1;
}
