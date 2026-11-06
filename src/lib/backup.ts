/**
 * Backup files: one saved chart (picture, settings, listing, ticks and hand fixes, and the
 * subject-finder mask) in a single .json file that any copy of the site can open again.
 */
import { getChart, listCharts, newId, saveChart, type ChartMeta, type SavedChart } from "./library";
import { dbGet, dbKeys, dbPut } from "./storage";

const KIND = "canvas-chart-maker-backup";
const VERSION = 1;

interface BackupFile {
  kind: typeof KIND;
  version: number;
  savedAt: string;
  meta: ChartMeta;
  chart: Omit<SavedChart, "file"> & { file: string };
  /** stored values keyed exactly as in this browser ("prog:…", "mask512:…") */
  extras: Record<string, unknown>;
}

/* typed arrays and Blobs don't survive JSON, so they're written as tagged base64 */
const TYPES = { u8: Uint8Array, i16: Int16Array, f32: Float32Array } as const;
type Tag = keyof typeof TYPES;

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64: string): Uint8Array {
  const s = atob(b64), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function pack(v: unknown): unknown {
  for (const [tag, T] of Object.entries(TYPES)) {
    if (v instanceof T) return { $t: tag, b64: toB64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  }
  if (Array.isArray(v)) return v.map(pack);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, pack(x)]));
  return v;
}
export function unpack(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(unpack);
  if (v && typeof v === "object") {
    const o = v as { $t?: string; b64?: string };
    if (o.$t && o.$t in TYPES && typeof o.b64 === "string") {
      const bytes = fromB64(o.b64);
      const T = TYPES[o.$t as Tag];
      return new T(bytes.buffer, 0, bytes.byteLength / T.BYTES_PER_ELEMENT);
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unpack(x)]));
  }
  return v;
}

const blobToDataUrl = (b: Blob) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result as string);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(b);
});
const dataUrlToBlob = (url: string) => fetch(url).then(r => r.blob());

/** progress and mask entries belong to a picture by its file name and size */
async function extrasFor(fileName: string, size: number): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const k of await dbKeys("prog:")) {
    try {
      const [n, s] = JSON.parse(k.slice(5)) as [string, number];
      if (n === fileName && s === size) out[k] = await dbGet(k);
    } catch { /* not ours */ }
  }
  const mk = `mask512:${fileName}:${size}`;
  const mask = await dbGet(mk);
  if (mask) out[mk] = mask;
  return out;
}

/** Makes the backup file for a saved chart. */
export async function makeBackup(id: string): Promise<{ blob: Blob; fileName: string }> {
  const saved = await getChart(id);
  const meta = (await listCharts()).find(m => m.id === id);
  if (!saved || !meta) throw new Error("That chart isn't saved any more.");
  const data: BackupFile = {
    kind: KIND, version: VERSION, savedAt: new Date().toISOString(), meta,
    chart: { ...saved, file: await blobToDataUrl(saved.file) },
    extras: pack(await extrasFor(saved.fileName, saved.file.size)) as Record<string, unknown>,
  };
  const safe = meta.name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "chart";
  return { blob: new Blob([JSON.stringify(data)], { type: "application/json" }), fileName: `${safe} backup.json` };
}

/**
 * Adds the chart in a backup file to My charts. If the same chart is already here it is kept and
 * the backup comes in alongside it, so opening a backup never overwrites anything.
 */
export async function openBackup(file: File): Promise<string> {
  let data: BackupFile;
  try { data = JSON.parse(await file.text()); } catch { throw new Error("That file isn't a chart backup."); }
  if (data?.kind !== KIND || !data.chart?.file || !data.meta) throw new Error("That file isn't a chart backup.");
  if (data.version > VERSION) throw new Error("That backup was made by a newer version of the site.");

  const blob = await dataUrlToBlob(data.chart.file);
  const pictureFile = new File([blob], data.chart.fileName, { type: data.chart.fileType || blob.type });
  const existing = await listCharts();
  const id = existing.some(m => m.id === data.meta.id) ? newId() : data.meta.id;
  const name = existing.some(m => m.name === data.meta.name) ? `${data.meta.name} (backup)` : data.meta.name;

  // ticks: don't replace progress this browser already has for the same picture
  const extras = unpack(data.extras ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(extras)) {
    if (!(k.startsWith("prog:") || k.startsWith("mask512:"))) continue;
    if (k.startsWith("prog:") && (await dbGet(k)) !== undefined) continue;
    await dbPut(k, v);
  }
  await saveChart(
    { id, file: pictureFile, fileName: data.chart.fileName, fileType: data.chart.fileType, settings: data.chart.settings },
    { ...data.meta, id, name, updated: Date.now() },
  );
  return id;
}
