/** Saved state in this browser only (IndexedDB). Every call fails quietly, e.g. in private windows. */
const NAME = "chartmaker", STORE = "p";

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    try {
      const r = indexedDB.open(NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  });
}

export async function dbGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await open();
    return await new Promise((res, rej) => {
      const t = db.transaction(STORE).objectStore(STORE).get(key);
      t.onsuccess = () => res(t.result as T);
      t.onerror = () => rej(t.error);
    });
  } catch { return undefined; }
}

export async function dbPut(key: string, value: unknown): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((res, rej) => {
      const t = db.transaction(STORE, "readwrite");
      t.objectStore(STORE).put(value, key);
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
  } catch { /* storage unavailable: carry on without saving */ }
}

export async function dbDelete(key: string): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((res, rej) => {
      const t = db.transaction(STORE, "readwrite");
      t.objectStore(STORE).delete(key);
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
  } catch { /* storage unavailable */ }
}

/** Asks the browser not to clear saved charts when space runs low (Safari otherwise may after a while). */
export async function keepStorage(): Promise<void> {
  try { await navigator.storage?.persist?.(); } catch { /* not supported */ }
}
