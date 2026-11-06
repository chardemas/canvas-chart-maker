/// <reference lib="webworker" />
/**
 * Finds the subject of a picture and returns a mask (255 = subject, 0 = background).
 * Model: BiRefNet Lite, 512 × 512 ONNX export (MIT licence; original: github.com/ZhengPeng7/BiRefNet),
 * run with ONNX Runtime Web (MIT). It downloads once (~98 MB) and is kept in the browser's cache.
 * Pictures never leave the device.
 */
import * as ort from "onnxruntime-web/webgpu";
import { MODEL_SIDE, type CutoutMsg } from "../lib/cutoutShared";

// pinned to one exact upload, and checked against its fingerprint, so the file can't change under us
const MODEL_URL = "https://huggingface.co/shozebDev/birefnet-lite-512-onnx/resolve/a1ef059c89d8982b4b5f801915024d8e2d55ea87/onnx/model_fp16.onnx";
const MODEL_SHA256 = "cdcc278ab17011c8507c83f368935527a7cde826dec4dff7f3dc6e18474f4a81";
const CACHE = "chart-maker-models";
ort.env.logLevel = "error"; // the optimiser's notes aren't useful to anyone using the site

const post = (m: CutoutMsg, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

async function sha256(buf: ArrayBuffer) {
  if (!crypto.subtle) throw new Error("The subject finder needs a secure (https) connection.");
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...d].map(b => b.toString(16).padStart(2, "0")).join("");
}

let modelBytes: Promise<ArrayBuffer> | null = null;
function getModel(): Promise<ArrayBuffer> {
  modelBytes ??= (async () => {
    const cache = typeof caches === "undefined" ? null : await caches.open(CACHE).catch(() => null);
    const hit = await cache?.match(MODEL_URL);
    if (hit) {
      const buf = await hit.arrayBuffer();
      if ((await sha256(buf)) === MODEL_SHA256) return buf;
      await cache?.delete(MODEL_URL);
    }
    const res = await fetch(MODEL_URL);
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
    const total = +(res.headers.get("content-length") ?? 0);
    const reader = res.body.getReader(), parts: Uint8Array[] = [];
    let got = 0, last = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value); got += value.length;
      const pct = total ? Math.floor((got / total) * 100) : 0;
      if (pct !== last) { last = pct; post({ type: "progress", stage: "download", pct }); }
    }
    const bytes = new Uint8Array(got);
    let o = 0;
    for (const p of parts) { bytes.set(p, o); o += p.length; }
    if ((await sha256(bytes.buffer)) !== MODEL_SHA256) throw new Error("The downloaded subject finder didn't match its fingerprint.");
    await cache?.put(MODEL_URL, new Response(bytes.slice().buffer)).catch(() => {});
    return bytes.buffer;
  })();
  modelBytes.catch(() => (modelBytes = null)); // allow a retry
  return modelBytes;
}

let session: Promise<ort.InferenceSession> | null = null;
function getSession(device: "webgpu" | "wasm") {
  session ??= getModel().then(buf => ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: [device], graphOptimizationLevel: "all", logSeverityLevel: 3 }));
  session.catch(() => (session = null));
  return session;
}

async function hasGPU() {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  return !!gpu && !!(await gpu.requestAdapter().catch(() => null));
}

/** `rgba` is the picture squeezed to MODEL_SIDE × MODEL_SIDE. */
self.onmessage = async (e: MessageEvent<{ id: number; rgba: Uint8ClampedArray; cpu: boolean }>) => {
  const { id, rgba, cpu } = e.data;
  const device = !cpu && (await hasGPU()) ? "webgpu" : "wasm";
  try {
    const s = await getSession(device);
    console.info(`Subject finder running on the ${device === "webgpu" ? "graphics card" : "processor"}`);
    post({ type: "progress", stage: "working", pct: 0 });
    const N = MODEL_SIDE * MODEL_SIDE, mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    const x = new Float32Array(3 * N);
    for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) x[c * N + i] = (rgba[i * 4 + c] / 255 - mean[c]) / std[c];
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", x, [1, 3, MODEL_SIDE, MODEL_SIDE]) });
    const logits = out[s.outputNames[0]].data as Float32Array;
    const mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) mask[i] = Math.round(255 / (1 + Math.exp(-logits[i])));
    post({ type: "done", id, mask, w: MODEL_SIDE, h: MODEL_SIDE }, [mask.buffer]);
  } catch (err) {
    post({ type: "error", id, gpuFailed: device === "webgpu", message: err instanceof Error ? err.message : String(err) });
  }
};
