/**
 * Two pretend devices syncing through a pretend Supabase that, like the real database, reorders
 * object keys. Each device gets its own IndexedDB and its own copy of the site's modules.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { DEFAULT_SETTINGS } from "./chart";

/* ---------- a minimal browser window for the sync module ---------- */
const g = globalThis as Record<string, unknown>;
g.window ??= globalThis;
g.addEventListener ??= () => {};
g.document ??= { visibilityState: "hidden", addEventListener() {} };

/* ---------- pretend server ---------- */
type Json = Record<string, unknown>;
const scramble = (v: unknown): unknown => // jsonb doesn't keep key order
  Array.isArray(v) ? v.map(scramble)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).reverse().map(k => [k, scramble((v as Json)[k])]))
  : v;
const server = { rows: new Map<string, Json>(), files: new Map<string, Blob>() };

function fakeClient() {
  let uid: string | null = null;
  let authCb: ((ev: string, s: unknown) => void) | null = null;
  const mine = () => [...server.rows.values()].filter(r => r.user_id === uid);
  const from = () => ({
    select: () => {
      const q = {
        filters: [] as [string, unknown][],
        eq(k: string, v: unknown) { q.filters.push([k, v]); return q; },
        rows() { return mine().filter(r => q.filters.every(([k, v]) => r[k] === v)).map(r => structuredClone(r)); },
        single: async () => { const r = q.rows()[0]; return r ? { data: r, error: null } : { data: null, error: new Error("no row") }; },
        then: (res: (v: unknown) => void) => { res({ data: q.rows(), error: null }); },
      };
      return q;
    },
    upsert: async (row: Json) => {
     
      if (row.user_id !== uid) return { error: new Error("RLS") };
      server.rows.set(`${uid}/${row.id}`, scramble(JSON.parse(JSON.stringify(row))) as Json);
      return { error: null };
    },
    update: (patch: Json) => ({
      eq: async (_k: string, id: string) => {
       
        const r = server.rows.get(`${uid}/${id}`);
        if (r) server.rows.set(`${uid}/${id}`, { ...r, ...JSON.parse(JSON.stringify(patch)) });
        return { error: null };
      },
    }),
  });
  const own = (path: string) => path.split("/")[0] === uid;
  return {
    from,
    storage: {
      from: () => ({
        upload: async (path: string, blob: Blob) => { if (!own(path)) return { error: new Error("RLS") }; server.files.set(path, blob); return { error: null }; },
        download: async (path: string) => { const b = own(path) && server.files.get(path); return b ? { data: b, error: null } : { data: null, error: new Error("not found") }; },
        remove: async (paths: string[]) => { paths.filter(own).forEach(p => server.files.delete(p)); return { error: null }; },
      }),
    },
    auth: {
      onAuthStateChange: (cb: typeof authCb) => { authCb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
      signOut: async () => { uid = null; authCb?.("SIGNED_OUT", null); return { error: null }; },
      _signIn: (id: string) => { uid = id; authCb?.("SIGNED_IN", { user: { id, email: id + "@test" } }); },
    },
  };
}

/* ---------- pretend devices ---------- */
type Mods = {
  sync: typeof import("./sync");
  lib: typeof import("./library");
  storage: typeof import("./storage");
  client: ReturnType<typeof fakeClient>;
};
interface Device { idb: IDBFactory; m: Mods; remote: string[][] }
function switchTo(d: Device) { (globalThis as { indexedDB?: IDBFactory }).indexedDB = d.idb; }

async function device(): Promise<Device> {
  vi.resetModules();
  const client = fakeClient();
  vi.doMock("./supabase", () => ({ supabase: client }));
  const d = { idb: new IDBFactory(), remote: [] as string[][] } as Device;
  switchTo(d);
  d.m = { sync: await import("./sync"), lib: await import("./library"), storage: await import("./storage"), client };
  d.m.sync.startSync({ onUser() {}, onState() {}, onRemote: ids => d.remote.push(ids) });
  return d;
}
/** runs a step on a device and lets its sync finish, so nothing leaks into the next device's turn */
async function on<T>(d: Device, fn: (m: Mods) => Promise<T> | T): Promise<T> {
  switchTo(d);
  const out = await fn(d.m);
  vi.advanceTimersByTime(1); // the hop out of the auth callback
  const ok = await d.m.sync.syncNow();
  vi.clearAllTimers();
  expect(ok).toBe(true);
  return out;
}
const sync = (d: Device) => on(d, () => {});

const settings = { ...DEFAULT_SETTINGS, k: 6, crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 } };
const key = JSON.stringify(["rose.png", 9, 40, 30, false, true, 234, true, true, 6, 1.4, 1.15, true, settings.crop]);
async function saveRose(m: Mods, id = "rose1") {
  await m.storage.dbPut("prog:" + key, { done: new Uint8Array([1, 0, 1]), idx: new Int16Array([0, -1, 2]), edits: [{ rgb: [1, 2, 3], code: "310", sym: "●" }] });
  await m.lib.saveChart(
    { id, file: new File([new Uint8Array(9)], "rose.png", { type: "image/png" }), fileName: "rose.png", fileType: "image/png", settings },
    { id, name: "Rose", updated: Date.now(), thumb: "data:,", W: 40, H: 30, mesh: 18, stitches: 1200, done: 2 },
  );
}
const progOf = async (m: Mods) => {
  const p = await m.storage.dbGet<{ done: Uint8Array; idx: Int16Array }>("prog:" + key);
  return p && { done: Array.from(p.done), idx: Array.from(p.idx) };
};

afterEach(() => { vi.useRealTimers(); server.rows.clear(); server.files.clear(); });

describe("syncing My charts between devices", () => {
  it("a chart, its ticks and fixes made on the iPad show up on the Mac", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval"] });
    const ipad = await device();
    await on(ipad, async m => { await saveRose(m); m.client.auth._signIn("u1"); });
    expect(server.rows.size).toBe(1);

    const mac = await device();
    await on(mac, m => m.client.auth._signIn("u1"));
    const list = await mac.m.lib.listCharts();
    expect(list.map(c => [c.name, c.done])).toEqual([["Rose", 2]]);
    const saved = await mac.m.lib.getChart("rose1");
    // settings come back in the site's own key order, so the chart (and its ticks) is recognised
    expect(JSON.stringify(saved!.settings)).toBe(JSON.stringify(settings));
    expect(saved!.file.size).toBe(9);
    expect(await progOf(mac.m)).toEqual({ done: [1, 0, 1], idx: [0, -1, 2] });
    expect(mac.remote.flat()).toContain("rose1");
  });

  it("the newest change wins, in both directions", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval"] });
    const ipad = await device();
    await on(ipad, async m => { await saveRose(m); m.client.auth._signIn("u1"); });
    const mac = await device();
    await on(mac, m => m.client.auth._signIn("u1"));

    // tick more on the Mac
    await on(mac, async m => {
      await m.storage.dbPut("prog:" + key, { done: new Uint8Array([1, 1, 1]), idx: new Int16Array([0, -1, 2]), edits: [] });
      await new Promise(r => setImmediate(r));
      vi.setSystemTime(Date.now() + 5000);
      await m.lib.touchChart("rose1");
    });
    await sync(ipad);
    expect((await progOf(ipad.m))!.done).toEqual([1, 1, 1]);

    // rename on the iPad
    vi.setSystemTime(Date.now() + 5000);
    await on(ipad, m => m.lib.updateChart("rose1", { meta: { name: "Rose (v2)" } }));
    await sync(mac);
    expect((await mac.m.lib.listCharts())[0].name).toBe("Rose (v2)");
  });

  it("opening a synced chart without changing it doesn't count as a change", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval"] });
    const ipad = await device();
    await on(ipad, async m => { await saveRose(m); m.client.auth._signIn("u1"); });
    const mac = await device();
    await on(mac, m => m.client.auth._signIn("u1"));
    const before = server.rows.get("u1/rose1")!.updated_at;
    // what the page does when it opens a chart: re-saves settings and the listing
    const saved = await mac.m.lib.getChart("rose1");
    await on(mac, m => m.lib.updateChart("rose1", { settings: { ...saved!.settings }, meta: { W: 40, H: 30, mesh: 18, stitches: 1200, done: 2, thumb: "data:,x" } }));
    expect(server.rows.get("u1/rose1")!.updated_at).toBe(before);
  });

  it("deleting on one device removes it everywhere", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval"] });
    const ipad = await device();
    await on(ipad, async m => { await saveRose(m); m.client.auth._signIn("u1"); });
    const mac = await device();
    await on(mac, m => m.client.auth._signIn("u1"));
    await on(mac, m => m.lib.deleteChart("rose1"));
    expect(server.rows.get("u1/rose1")!.deleted).toBe(true);
    expect(server.files.size).toBe(0);
    await sync(ipad);
    expect(await ipad.m.lib.listCharts()).toEqual([]);
  });

  it("people only ever get their own charts, and signing out clears the device", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval"] });
    const a = await device();
    await on(a, async m => { await saveRose(m); m.client.auth._signIn("alice"); });
    await on(a, m => m.sync.signOut());
    expect(await a.m.lib.listCharts()).toEqual([]);
    expect(await progOf(a.m)).toBeUndefined();
    expect(server.rows.size).toBe(1); // still safe in Alice's account

    await on(a, m => m.client.auth._signIn("bob"));
    expect(await a.m.lib.listCharts()).toEqual([]);
    await on(a, m => m.client.auth._signIn("alice"));
    expect((await a.m.lib.listCharts()).map(c => c.name)).toEqual(["Rose"]);
  });
});
