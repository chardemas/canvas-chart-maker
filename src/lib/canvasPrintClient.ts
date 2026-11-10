/** Talks to the print-on-canvas worker, which keeps the full-size scan so the page doesn't have to. */
import type { Lattice, Pt } from "./canvasPrint";

export interface Analysed {
  scanW: number;
  scanH: number;
  lattice: Lattice;
  /** the scan, shrunk to fit on screen */
  overview: ImageBitmap;
}

export type CanvasPrintRequest =
  | { type: "analyse"; id: number; file: File }
  | { type: "crop"; id: number; x: number; y: number; size: number }
  | { type: "pdf"; id: number; W: number; H: number; idx: Int16Array; colours: Uint8Array; at: Pt; correct: boolean };

export type CanvasPrintReply =
  | { type: "progress"; id: number; text: string }
  | { type: "error"; id: number; message: string }
  | { type: "analysed"; id: number; result: Analysed }
  | { type: "crop"; id: number; image: ImageBitmap }
  | { type: "pdf"; id: number; pdf: Blob };

type Payload<T extends CanvasPrintReply["type"]> = Extract<CanvasPrintReply, { type: T }>;
type Req = CanvasPrintRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { ok: (r: CanvasPrintReply) => void; fail: (e: Error) => void; progress?: (t: string) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../worker/canvasPrint.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<CanvasPrintReply>) => {
      const m = e.data, p = pending.get(m.id);
      if (!p) return;
      if (m.type === "progress") { p.progress?.(m.text); return; }
      pending.delete(m.id);
      if (m.type === "error") p.fail(new Error(m.message)); else p.ok(m);
    };
    worker.onerror = e => {
      const err = new Error(e.message || "The scan reader stopped. The scan may be too big for this device.");
      for (const p of pending.values()) p.fail(err);
      pending.clear();
      worker?.terminate(); worker = null;
    };
  }
  return worker;
}

function ask<T extends CanvasPrintReply["type"]>(req: Req, progress?: (t: string) => void): Promise<Payload<T>> {
  const id = ++nextId;
  return new Promise((ok, fail) => {
    pending.set(id, { ok: r => ok(r as Payload<T>), fail, progress });
    getWorker().postMessage({ ...req, id });
  });
}

/** Reads the scan, finds the carrier dots and every hole. The worker keeps the scan for crops and the print file. */
export const analyseScan = (file: File, progress: (t: string) => void) =>
  ask<"analysed">({ type: "analyse", file }, progress).then(r => r.result);

/** A full-resolution square of the scan, top-left at (x, y) in scan px. */
export const scanCrop = (x: number, y: number, size: number) =>
  ask<"crop">({ type: "crop", x, y, size }).then(r => r.image);

/** The print file for the last scan analysed. */
export const makePrintPdf = (W: number, H: number, idx: Int16Array, colours: Uint8Array, at: Pt, correct: boolean) =>
  ask<"pdf">({ type: "pdf", W, H, idx, colours, at, correct }).then(r => r.pdf);
