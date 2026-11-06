/**
 * "My charts": charts saved in this browser. Each one keeps its picture and settings; its ticks and
 * hand fixes are stored per exact chart (see "prog:" in App), so reopening it brings them back.
 *
 * `updated` is the chart's version: it moves forward whenever the person changes the chart
 * (ticks, fixes, settings, name), and syncing uses it to decide which copy is newest.
 */
import type { Settings } from "./chart";
import { paintPrint, type Chart } from "./render";
import { dbGet, dbPut, dbDelete } from "./storage";

export interface ChartMeta {
  id: string;
  name: string;
  updated: number;
  /** small picture of the chart */
  thumb: string;
  W: number;
  H: number;
  mesh: number;
  stitches: number;
  done: number;
}

export interface SavedChart {
  id: string;
  file: Blob;
  fileName: string;
  fileType: string;
  settings: Settings;
}

/* ---------- change notices (for syncing) ---------- */
export type LibraryEvent = { type: "changed" | "deleted"; id: string };
let listener: ((e: LibraryEvent) => void) | null = null;
let quiet = 0;
export const onLibraryChange = (fn: ((e: LibraryEvent) => void) | null) => { listener = fn; };
const notify = (e: LibraryEvent) => { if (!quiet) listener?.(e); };
/** runs `fn` without reporting its writes (used when writing what came from the account) */
export async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  quiet++;
  try { return await fn(); } finally { quiet--; }
}

const INDEX = "library";

export async function listCharts(): Promise<ChartMeta[]> {
  const list = (await dbGet<ChartMeta[]>(INDEX)) ?? [];
  return list.sort((a, b) => b.updated - a.updated);
}

async function writeIndex(list: ChartMeta[]) { await dbPut(INDEX, list); }

export const getChart = (id: string) => dbGet<SavedChart>("chart:" + id);

export async function saveChart(saved: SavedChart, meta: ChartMeta) {
  await dbPut("chart:" + saved.id, saved);
  const list = (await listCharts()).filter(m => m.id !== meta.id);
  await writeIndex([meta, ...list]);
  notify({ type: "changed", id: saved.id });
}

/** compares values regardless of key order */
const stable = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(stable)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable((v as Record<string, unknown>)[k])]))
  : v;
const same = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
/** listing fields whose change counts as the person changing the chart (not just a redrawn picture) */
const REAL: (keyof ChartMeta)[] = ["name", "W", "H", "mesh", "stitches", "done"];

/** Updates a saved chart's settings and/or its listing. Only real changes move it forward. */
export async function updateChart(id: string, patch: { settings?: Settings; meta?: Partial<ChartMeta> }) {
  let changed = false;
  if (patch.settings) {
    const saved = await getChart(id);
    if (saved && !same(saved.settings, patch.settings)) {
      await dbPut("chart:" + id, { ...saved, settings: patch.settings });
      changed = true;
    }
  }
  const list = await listCharts();
  const cur = list.find(m => m.id === id);
  if (!cur) return;
  const meta = patch.meta ?? {};
  if (REAL.some(k => k in meta && meta[k] !== cur[k])) changed = true;
  if (!changed && !(meta.thumb && meta.thumb !== cur.thumb)) return;
  await writeIndex(list.map(m => (m.id === id ? { ...m, ...meta, updated: changed ? Date.now() : m.updated } : m)));
  if (changed) notify({ type: "changed", id });
}

/** The chart's ticks or fixes changed. */
export async function touchChart(id: string) {
  const list = await listCharts();
  if (!list.some(m => m.id === id)) return;
  await writeIndex(list.map(m => (m.id === id ? { ...m, updated: Date.now() } : m)));
  notify({ type: "changed", id });
}

export async function deleteChart(id: string) {
  await dbDelete("chart:" + id);
  await writeIndex((await listCharts()).filter(m => m.id !== id));
  notify({ type: "deleted", id });
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** A small print-style picture of the chart for the list. */
export function thumbnail(chart: Chart): string {
  const P = Math.max(1, Math.floor(160 / Math.max(chart.W, chart.H)));
  const c = document.createElement("canvas");
  c.width = chart.W * P; c.height = chart.H * P;
  paintPrint(c.getContext("2d")!, chart, P);
  return c.toDataURL("image/png");
}

export function metaFor(chart: Chart, mesh: number): Pick<ChartMeta, "thumb" | "W" | "H" | "mesh" | "stitches" | "done"> {
  return {
    thumb: thumbnail(chart), W: chart.W, H: chart.H, mesh,
    stitches: chart.pal.reduce((a, p) => a + p.count, 0),
    done: chart.pal.reduce((a, p) => a + p.done, 0),
  };
}
