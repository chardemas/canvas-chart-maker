/** Subject cut-out: runs the model in a worker, then turns its mask into a transparent-background picture. */
import { MODEL_SIDE, type CutoutMsg } from "./cutoutShared";

export interface Mask { data: Uint8Array; w: number; h: number }
type OnProgress = (stage: "download" | "working", pct: number) => void;

/** If the worker goes silent this long after starting work (e.g. it ran out of memory), give up. */
const WORK_TIMEOUT_MS = 120_000;

let worker: Worker | null = null;
let cpuOnly = false;
let nextId = 0;

function runInWorker(rgba: Uint8ClampedArray, onProgress: OnProgress): Promise<Mask> {
  worker ??= new Worker(new URL("../worker/cutout.worker.ts", import.meta.url), { type: "module" });
  const id = ++nextId, wk = worker;
  return new Promise((resolve, reject) => {
    let timer = 0;
    const finish = () => { clearTimeout(timer); wk.removeEventListener("message", onMsg); wk.removeEventListener("error", onCrash); };
    const retryOnProcessor = (why: string) => {
      console.warn("Subject finder: graphics card failed, switching to processor:", why);
      cpuOnly = true; wk.terminate(); worker = null;
      runInWorker(rgba, onProgress).then(resolve, reject);
    };
    const fail = (why: string, gpuFailed: boolean) => {
      finish();
      if (gpuFailed && !cpuOnly) retryOnProcessor(why);
      else { wk.terminate(); worker = null; reject(new Error(why)); }
    };
    const onCrash = (e: ErrorEvent) => fail(e.message || "The subject finder stopped unexpectedly.", true);
    const onMsg = (e: MessageEvent<CutoutMsg>) => {
      const m = e.data;
      if (m.type === "progress") {
        onProgress(m.stage, m.pct);
        if (m.stage === "working") { clearTimeout(timer); timer = window.setTimeout(() => fail("The subject finder took too long.", true), WORK_TIMEOUT_MS); }
        return;
      }
      if (m.id !== id) return;
      if (m.type === "done") { finish(); resolve({ data: m.mask, w: m.w, h: m.h }); }
      else fail(m.message, m.gpuFailed);
    };
    wk.addEventListener("message", onMsg);
    wk.addEventListener("error", onCrash);
    // copy, so the picture data is still here for a retry
    wk.postMessage({ id, rgba: rgba.slice(), cpu: cpuOnly });
  });
}

/** Finds the subject. `onProgress` gets the download percentage, then "working". */
export function findSubject(img: HTMLImageElement, onProgress: OnProgress): Promise<Mask> {
  // the model sees a square version; the mask is stretched back to the picture's shape afterwards
  const c = document.createElement("canvas"); c.width = MODEL_SIDE; c.height = MODEL_SIDE;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.imageSmoothingQuality = "high"; g.drawImage(img, 0, 0, MODEL_SIDE, MODEL_SIDE);
  return runInWorker(g.getImageData(0, 0, MODEL_SIDE, MODEL_SIDE).data, onProgress);
}

/** The full-size picture with everything outside the subject made transparent. */
export function applyMask(img: HTMLImageElement, mask: Mask): HTMLCanvasElement {
  const m = document.createElement("canvas"); m.width = mask.w; m.height = mask.h;
  const md = new ImageData(mask.w, mask.h);
  for (let i = 0; i < mask.data.length; i++) md.data[i * 4 + 3] = mask.data[i];
  m.getContext("2d")!.putImageData(md, 0, 0);

  const out = document.createElement("canvas"); out.width = img.width; out.height = img.height;
  const g = out.getContext("2d")!;
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = "destination-in";
  g.imageSmoothingQuality = "high";
  g.drawImage(m, 0, 0, img.width, img.height);
  return out;
}
