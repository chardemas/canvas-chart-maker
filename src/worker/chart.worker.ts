/// <reference lib="webworker" />
/** Builds the chart off the main thread so the page stays responsive on big charts. */
import { buildChart, type Settings } from "../lib/chart";

export interface BuildRequest {
  id: number;
  px: Uint8ClampedArray;
  W: number;
  H: number;
  s: Pick<Settings, "rm" | "thr" | "k" | "con" | "sat" | "dmc">;
}

self.onmessage = (e: MessageEvent<BuildRequest>) => {
  const { id, px, W, H, s } = e.data;
  const chart = buildChart(px, W, H, s);
  (self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, chart }, [chart.idx.buffer]);
};
