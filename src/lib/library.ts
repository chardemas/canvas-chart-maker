/**
 * "My charts": charts saved in this browser. Each one keeps its picture and settings; its ticks and
 * hand fixes are stored per exact chart (see "prog:" in App), so reopening it brings them back.
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
}

/** Updates a saved chart's settings and/or its listing (picture, progress, name). */
export async function updateChart(id: string, patch: { settings?: Settings; meta?: Partial<ChartMeta> }) {
  if (patch.settings) {
    const saved = await getChart(id);
    if (saved) await dbPut("chart:" + id, { ...saved, settings: patch.settings });
  }
  if (patch.meta) {
    const list = await listCharts();
    await writeIndex(list.map(m => (m.id === id ? { ...m, ...patch.meta, updated: Date.now() } : m)));
  }
}

export async function deleteChart(id: string) {
  await dbDelete("chart:" + id);
  await writeIndex((await listCharts()).filter(m => m.id !== id));
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
