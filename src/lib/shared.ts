/**
 * Customer links: a finished chart (grid, symbols, DMC threads; no picture, no settings) stored
 * online under a long random id. The customer opens /c/<id> and ticks stitches off; their ticks
 * are saved with the link, so they're on every device that opens it.
 *
 * Customers never touch the table: they can only call two database functions with the exact id.
 * Only the signed-in maker can create, list and switch off links (row-level security).
 */
import { supabase } from "./supabase";
import { pack, unpack } from "./backup";
import { threadByCode, type Thread } from "./dmc";
import { toLab, type RGB } from "./color";
import { recount } from "./edit";
import type { Chart } from "./render";

export interface SharedChartData {
  v: 1;
  W: number;
  H: number;
  mesh: number;
  idx: Int16Array;
  pal: { rgb: RGB; code: string; name: string; sym: string }[];
}

export interface SharedLink {
  id: string;
  title: string;
  note: string;
  stitches: number;
  done_count: number;
  active: boolean;
  created_at: string;
  progress_updated: number;
}

/* ---------- the chart itself ---------- */
export function snapshot(chart: Chart, mesh: number): SharedChartData {
  return {
    v: 1, W: chart.W, H: chart.H, mesh,
    idx: chart.idx.slice(),
    pal: chart.pal.map(p => ({ rgb: [...p.rgb] as RGB, code: p.thread.code, name: p.thread.name, sym: p.sym })),
  };
}

export const encodeChart = (d: SharedChartData) => pack(d);
export function decodeChart(raw: unknown): SharedChartData {
  const d = unpack(raw) as SharedChartData;
  if (!d || d.v !== 1 || !(d.idx instanceof Int16Array) || d.idx.length !== d.W * d.H || !Array.isArray(d.pal)) {
    throw new Error("This chart couldn't be read.");
  }
  return d;
}

/** A chart the viewer can draw and tick, with no ticks yet. */
export function toChart(d: SharedChartData, key: string): Chart {
  const pal = d.pal.map(p => {
    const thread: Thread = threadByCode(p.code) ?? { code: p.code, name: p.name, rgb: p.rgb, lab: toLab(p.rgb) };
    return { rgb: p.rgb, thread, count: 0, done: 0, sym: p.sym };
  });
  const chart: Chart = { W: d.W, H: d.H, idx: d.idx, pal, bg: 0, done: new Uint8Array(d.W * d.H), key };
  recount(chart);
  return chart;
}

export const stitchCount = (c: Chart) => c.pal.reduce((a, p) => a + p.count, 0);
export const doneCount = (c: Chart) => c.pal.reduce((a, p) => a + p.done, 0);

/* ---------- ticks, packed 8 to a byte ---------- */
export function packDone(done: Uint8Array): { n: number; bits: Uint8Array } {
  const bits = new Uint8Array(Math.ceil(done.length / 8));
  for (let i = 0; i < done.length; i++) if (done[i]) bits[i >> 3] |= 1 << (i & 7);
  return { n: done.length, bits };
}
export function unpackDone(p: { n: number; bits: Uint8Array }, length: number): Uint8Array | null {
  if (!p || p.n !== length || !(p.bits instanceof Uint8Array)) return null;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (p.bits[i >> 3] >> (i & 7)) & 1;
  return out;
}

/* ---------- links ---------- */
export function newLinkId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export const linkUrl = (id: string) => `${location.origin}/c/${id}`;

export async function createLink(title: string, note: string, data: SharedChartData, stitches: number): Promise<string> {
  const id = newLinkId();
  const { error } = await supabase.from("shared_charts").insert({ id, title, note, chart: encodeChart(data), stitches });
  if (error) throw error;
  return id;
}

export async function listLinks(): Promise<SharedLink[]> {
  const { data, error } = await supabase.from("shared_charts")
    .select("id, title, note, stitches, done_count, active, created_at, progress_updated")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as SharedLink[];
}

export async function setLinkActive(id: string, active: boolean) {
  const { error } = await supabase.from("shared_charts").update({ active }).eq("id", id);
  if (error) throw error;
}

/* ---------- what the customer's page calls ---------- */
export interface SharedRemote { title: string; note: string; chart: unknown; progress: unknown; progress_updated: number }

/** null = no such link, or it was switched off */
export async function fetchShared(id: string): Promise<SharedRemote | null> {
  const { data, error } = await supabase.rpc("get_shared_chart", { p_id: id });
  if (error) throw error;
  return (data as SharedRemote | null) ?? null;
}

/** returns the saved version time on the server */
export async function saveSharedProgress(id: string, done: Uint8Array, updated: number, doneN: number): Promise<number> {
  const { data, error } = await supabase.rpc("save_shared_progress", {
    p_id: id, p_progress: pack(packDone(done)), p_updated: updated, p_done: doneN,
  });
  if (error) throw error;
  return Number(data);
}
export const decodeProgress = (raw: unknown, length: number) => (raw ? unpackDone(unpack(raw) as { n: number; bits: Uint8Array }, length) : null);
