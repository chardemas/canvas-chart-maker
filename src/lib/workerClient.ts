import type { BuiltChart, Settings } from "./chart";

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, (c: BuiltChart) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../worker/chart.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; chart: BuiltChart }>) => {
      const done = pending.get(e.data.id);
      pending.delete(e.data.id);
      done?.(e.data.chart);
    };
  }
  return worker;
}

/** Build a chart in the worker. Resolves with the chart. */
export function buildInWorker(px: Uint8ClampedArray, W: number, H: number, s: Pick<Settings, "rm" | "thr" | "k" | "con" | "sat" | "dmc">): Promise<BuiltChart> {
  const id = ++nextId;
  return new Promise(resolve => {
    pending.set(id, resolve);
    getWorker().postMessage({ id, px, W, H, s }, [px.buffer]);
  });
}
