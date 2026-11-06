/**
 * Keeps My charts in step with the signed-in account.
 *
 * This browser's copy stays the one the site works from (so it works offline); syncing copies
 * changes up and pulls newer ones down. Each chart's `updated` time decides which copy wins.
 *   - online, a chart is one row in `charts` plus its picture (and subject mask) in storage
 *   - deleting a chart leaves a "deleted" row so other devices remove it too
 *   - signing in adds this device's charts to the account; signing out removes them from this device
 */
import { supabase } from "./supabase";
import { extrasFor, pack, unpack } from "./backup";
import { DEFAULT_SETTINGS, type Settings } from "./chart";
import { dbDelete, dbGet, dbKeys, dbPut } from "./storage";
import { deleteChart, getChart, listCharts, onLibraryChange, quietly, saveChart, type ChartMeta } from "./library";

export type SyncState = "signed-out" | "syncing" | "synced" | "offline" | "error";
export interface SyncHooks {
  onUser: (email: string | null) => void;
  onState: (s: SyncState, note?: string) => void;
  /** charts that changed because of another device (pulled or removed) */
  onRemote: (ids: string[]) => void;
}

export const syncLabel = (s: SyncState) =>
  s === "syncing" ? "Syncing…" : s === "synced" ? "Synced" : s === "offline" ? "Offline: will sync when back online" : s === "error" ? "Sync problem" : "Not signed in";

const BUCKET = "charts";
const TOMBS = "sync:deleted";
let uid: string | null = null;
let hooks: SyncHooks | null = null;
const dirty = new Set<string>();
let fullWanted = false;
let timer = 0;
let running: Promise<boolean> | null = null;
let again = false;
let started = false;

interface Row {
  id: string; name: string; meta: Omit<ChartMeta, "id" | "name">; settings: Settings;
  file_name: string; file_type: string; progress: Record<string, unknown>;
  has_mask: boolean; deleted: boolean; updated_at: number | string;
}

/** settings back in the site's own key order (the database reorders keys; chart identity depends on order) */
function canonical(s: Partial<Settings>): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...s } as Settings;
  const out = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(k => [k, merged[k as keyof Settings]])) as unknown as Settings;
  out.crop = { x: merged.crop.x, y: merged.crop.y, w: merged.crop.w, h: merged.crop.h };
  return out;
}

const dir = (id: string) => `${uid}/${id}`;
const maskKeyFor = (fileName: string, size: number) => `mask512:${fileName}:${size}`;

/* ---------- one chart up or down ---------- */
async function push(id: string) {
  const saved = await getChart(id);
  const meta = (await listCharts()).find(m => m.id === id);
  if (!saved || !meta || !uid) return;
  const store = supabase.storage.from(BUCKET);
  if ((await dbGet(`sync:pic:${id}`)) !== uid) {
    const { error } = await store.upload(`${dir(id)}/picture`, saved.file, { upsert: true, contentType: saved.fileType || "application/octet-stream" });
    if (error) throw error;
    await dbPut(`sync:pic:${id}`, uid);
  }
  const extras = await extrasFor(saved.fileName, saved.file.size);
  const mk = maskKeyFor(saved.fileName, saved.file.size);
  const mask = extras[mk];
  delete extras[mk];
  if (mask && (await dbGet(`sync:mask:${id}`)) !== uid) {
    const blob = new Blob([JSON.stringify(pack(mask))], { type: "application/json" });
    const { error } = await store.upload(`${dir(id)}/mask`, blob, { upsert: true, contentType: "application/json" });
    if (error) throw error;
    await dbPut(`sync:mask:${id}`, uid);
  }
  const { id: _id, name, ...rest } = meta;
  void _id;
  const { error } = await supabase.from("charts").upsert({
    user_id: uid, id, name, meta: rest, settings: saved.settings,
    file_name: saved.fileName, file_type: saved.fileType, progress: pack(extras),
    has_mask: !!mask, deleted: false, updated_at: meta.updated,
  }, { onConflict: "user_id,id" });
  if (error) throw error;
}

async function pull(id: string) {
  const { data, error } = await supabase.from("charts").select("*").eq("id", id).single<Row>();
  if (error) throw error;
  const store = supabase.storage.from(BUCKET);
  const pic = await store.download(`${dir(id)}/picture`);
  if (pic.error) throw pic.error;
  const file = new File([pic.data], data.file_name, { type: data.file_type || pic.data.type });
  let mask: unknown;
  if (data.has_mask) {
    const m = await store.download(`${dir(id)}/mask`);
    if (!m.error) mask = unpack(JSON.parse(await m.data.text()));
  }
  const progress = unpack(data.progress ?? {}) as Record<string, unknown>;
  await quietly(async () => {
    for (const [k, v] of Object.entries(progress)) if (k.startsWith("prog:")) await dbPut(k, v);
    if (mask) { await dbPut(maskKeyFor(data.file_name, file.size), mask); await dbPut(`sync:mask:${id}`, uid); }
    await dbPut(`sync:pic:${id}`, uid);
    await saveChart(
      { id, file, fileName: data.file_name, fileType: data.file_type, settings: canonical(data.settings) },
      { ...data.meta, id, name: data.name, updated: Number(data.updated_at) },
    );
  });
}

async function removeRemote(id: string) {
  const { error } = await supabase.from("charts")
    .update({ deleted: true, progress: {}, updated_at: Date.now() })
    .eq("id", id);
  if (error) throw error;
  await supabase.storage.from(BUCKET).remove([`${dir(id)}/picture`, `${dir(id)}/mask`]);
}

/* ---------- whole-library passes ---------- */
/** compares every chart with the account; returns how many of this device's charts were new to it */
async function reconcile(): Promise<number> {
  const { data, error } = await supabase.from("charts").select("id, updated_at, deleted");
  if (error) throw error;
  const local = new Map((await listCharts()).map(m => [m.id, m]));
  const tombs = new Set((await dbGet<string[]>(TOMBS)) ?? []);
  const changed: string[] = [];
  for (const r of data as Pick<Row, "id" | "updated_at" | "deleted">[]) {
    const l = local.get(r.id), ru = Number(r.updated_at);
    local.delete(r.id);
    if (tombs.has(r.id)) { if (!r.deleted) await removeRemote(r.id); continue; }
    if (r.deleted) {
      if (l) { await quietly(() => deleteChart(r.id)); changed.push(r.id); }
      continue;
    }
    if (!l || ru > l.updated) { await pull(r.id); changed.push(r.id); }
    else if (l.updated > ru) await push(r.id);
  }
  let added = 0;
  for (const m of local.values()) { await push(m.id); added++; }
  await dbPut(TOMBS, []);
  dirty.clear();
  if (changed.length) hooks?.onRemote(changed);
  return added;
}

/** just what changed here since the last pass */
async function pushDirty() {
  const tombs = (await dbGet<string[]>(TOMBS)) ?? [];
  const ids = [...dirty];
  dirty.clear();
  try {
    for (const id of tombs) await removeRemote(id);
    await dbPut(TOMBS, []);
    const have = new Set((await listCharts()).map(m => m.id));
    for (const id of ids) if (have.has(id)) await push(id);
  } catch (e) { ids.forEach(id => dirty.add(id)); throw e; }
}

/* ---------- scheduling ---------- */
let firstPass = true;
async function runOnce(full: boolean): Promise<boolean> {
  if (!uid) return true;
  hooks?.onState("syncing");
  try {
    let note: string | undefined;
    if (full) {
      const added = await reconcile();
      if (firstPass && added) note = `${added} chart${added === 1 ? "" : "s"} from this device ${added === 1 ? "was" : "were"} added to your account.`;
      firstPass = false;
    } else await pushDirty();
    hooks?.onState("synced", note);
    return true;
  } catch (e) {
    const offline = !navigator.onLine || e instanceof TypeError;
    hooks?.onState(offline ? "offline" : "error", offline ? undefined : (e as Error).message);
    schedule(30_000, full);
    return false;
  }
}

function kick(): Promise<boolean> {
  if (running) { again = true; return running; }
  running = (async () => {
    let ok = true;
    do {
      again = false;
      const full = fullWanted;
      fullWanted = false;
      ok = await runOnce(full);
    } while (again && ok);
    return ok;
  })().finally(() => { running = null; });
  return running;
}

function schedule(ms: number, full = false) {
  if (full) fullWanted = true;
  clearTimeout(timer);
  timer = window.setTimeout(() => { void kick(); }, ms);
}

/** Sync everything now; resolves false if it couldn't. */
export async function syncNow(): Promise<boolean> {
  clearTimeout(timer);
  fullWanted = true;
  if (running) await running;
  return kick();
}

function setUser(id: string | null, email: string | null) {
  hooks?.onUser(email);
  if (id === uid) return;
  uid = id;
  firstPass = true;
  if (uid) schedule(0, true);
  else hooks?.onState("signed-out");
}

export function startSync(h: SyncHooks) {
  hooks = h;
  if (started) return;
  started = true;
  onLibraryChange(async e => {
    if (!uid) return;
    if (e.type === "deleted") {
      const t = (await dbGet<string[]>(TOMBS)) ?? [];
      if (!t.includes(e.id)) await dbPut(TOMBS, [...t, e.id]);
    } else dirty.add(e.id);
    schedule(2000, fullWanted);
  });
  // don't call Supabase inside the auth callback itself; hop out of it first
  supabase.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => setUser(session?.user.id ?? null, session?.user.email ?? null), 0);
  });
  window.addEventListener("online", () => schedule(0, true));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") schedule(500, true); });
  window.setInterval(() => { if (uid && document.visibilityState === "visible") schedule(0, true); }, 60_000);
}

/* ---------- signing in and out ---------- */
export async function sendCode(email: string) {
  const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin } });
  if (error) throw error;
}

export async function verifyCode(email: string, code: string) {
  const { error } = await supabase.auth.verifyOtp({ email, token: code, type: "email" });
  if (error) throw error;
}

/**
 * Makes sure everything is in the account, then signs out and clears this device's copies,
 * so the next person on this device doesn't see them. Refuses if the account isn't up to date.
 */
export async function signOut() {
  if (uid && !(await syncNow())) throw new Error("Couldn't finish syncing, so you're still signed in. Check the internet connection and try again.");
  uid = null;
  await supabase.auth.signOut();
  await quietly(async () => {
    for (const m of await listCharts()) await deleteChart(m.id);
    for (const p of ["prog:", "mask512:", "sync:", "chart:"]) for (const k of await dbKeys(p)) await dbDelete(k);
    await dbDelete("library"); await dbDelete("file"); await dbDelete("currentId"); await dbDelete("settings");
  });
}
