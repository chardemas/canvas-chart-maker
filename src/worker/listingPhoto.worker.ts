/// <reference lib="webworker" />
/**
 * Studio only: turns a scan of a printed canvas lying loose on a dark backing into a clean cut-out
 * (holes see-through), straightened by the threads and colour-corrected. Keeps the scan for redoing
 * the colour and for close-ups. Nothing leaves the device.
 */
import { buildLattice, findHoles } from "../lib/canvasPrint";
import { correctColour, cutOutCanvas, type Look } from "../lib/listingPhoto";

export type ListingRequest =
  | { type: "open"; id: number; file: File; mesh: number; look: Look }
  | { type: "look"; id: number; look: Look }
  | { type: "closeup"; id: number; x: number; y: number; look: Look };
export type ListingReply =
  | { type: "progress"; id: number; text: string }
  | { type: "error"; id: number; message: string }
  | { type: "photo"; id: number; image: ImageBitmap; angle: number; dpi: number; box: { x: number; y: number; w: number; h: number } }
  | { type: "closeup"; id: number; image: ImageBitmap };

const post = (m: ListingReply, t: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, t);

/** working resolution for the main photo: plenty for a 3000 px listing image */
const WORK_DPI = 300;
let scan: { bmp: ImageBitmap; dpi: number; mesh: number; cut: { rgba: Uint8ClampedArray; w: number; h: number; box: { x: number; y: number; w: number; h: number } }; angle: number } | null = null;

function pixels(bmp: ImageBitmap, sx: number, sy: number, sw: number, sh: number, dw: number, dh: number) {
  const c = new OffscreenCanvas(dw, dh), g = c.getContext("2d", { willReadFrequently: true })!;
  g.imageSmoothingQuality = "high";
  g.drawImage(bmp, sx, sy, sw, sh, 0, 0, dw, dh);
  return g.getImageData(0, 0, dw, dh).data;
}

/** The thread angle from a full-resolution patch in the middle of the canvas (degrees, + = turned clockwise). */
function threadAngle(bmp: ImageBitmap, cx: number, cy: number, dpi: number): number {
  const S = Math.min(1024, bmp.width, bmp.height);
  const x = Math.max(0, Math.min(bmp.width - S, Math.round(cx - S / 2))), y = Math.max(0, Math.min(bmp.height - S, Math.round(cy - S / 2)));
  const px = pixels(bmp, x, y, S, S, S, S), gray = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) gray[i] = Math.round(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]);
  try {
    if (dpi < 500) return 0; // hole finding is tuned for 600 dpi scans
    const L = buildLattice(findHoles(gray, S, S), 0);
    // average direction along each row of seen holes
    let sx = 0, sy = 0;
    for (let j = 0; j < L.nj; j++) {
      let f = -1, l = -1;
      for (let i = 0; i < L.ni; i++) if (L.seen[i * L.nj + j]) { if (f < 0) f = i; l = i; }
      if (f < 0 || l - f < 5) continue;
      const p = (f * L.nj + j) * 2, q = (l * L.nj + j) * 2;
      sx += L.pos[q] - L.pos[p]; sy += L.pos[q + 1] - L.pos[p + 1];
    }
    return sx ? (Math.atan2(sy, sx) * 180) / Math.PI : 0;
  } catch { return 0; }
}

/** Straighten (turn by −angle), colour-correct, and trim to the canvas. */
async function finish(rgba: Uint8ClampedArray, w: number, h: number, angle: number, look: Look): Promise<ImageBitmap> {
  const px = new Uint8ClampedArray(rgba);
  correctColour(px, look);
  const src = new OffscreenCanvas(w, h);
  src.getContext("2d")!.putImageData(new ImageData(px, w, h), 0, 0);
  const t = (-angle * Math.PI) / 180, cw = Math.ceil(Math.abs(w * Math.cos(t)) + Math.abs(h * Math.sin(t))), ch = Math.ceil(Math.abs(w * Math.sin(t)) + Math.abs(h * Math.cos(t)));
  const out = new OffscreenCanvas(cw, ch), g = out.getContext("2d", { willReadFrequently: true })!;
  g.translate(cw / 2, ch / 2); g.rotate(t); g.drawImage(src, -w / 2, -h / 2);
  // trim to what's visible
  const d = g.getImageData(0, 0, cw, ch).data;
  let x0 = cw, y0 = ch, x1 = -1, y1 = -1;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (d[(y * cw + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return createImageBitmap(out, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
}

self.onmessage = async (e: MessageEvent<ListingRequest>) => {
  const m = e.data;
  try {
    if (m.type === "open") {
      post({ type: "progress", id: m.id, text: "Reading the scan…" });
      scan?.bmp.close(); scan = null;
      const bmp = await createImageBitmap(m.file);
      // a letter page is 8.5 in wide, so the width tells the scan resolution
      const dpi = Math.round(bmp.width / 8.5 / 50) * 50 || 300;
      const s = Math.min(1, WORK_DPI / dpi), w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
      post({ type: "progress", id: m.id, text: "Cutting out the canvas…" });
      const cut = cutOutCanvas(pixels(bmp, 0, 0, bmp.width, bmp.height, w, h), w, h, (dpi * s) / m.mesh);
      post({ type: "progress", id: m.id, text: "Straightening and colour…" });
      const angle = threadAngle(bmp, (cut.box.x + cut.box.w / 2) / s, (cut.box.y + cut.box.h / 2) / s, dpi);
      scan = { bmp, dpi, mesh: m.mesh, cut, angle };
      const image = await finish(cut.rgba, cut.w, cut.h, angle, m.look);
      post({ type: "photo", id: m.id, image, angle, dpi, box: { x: cut.box.x / s, y: cut.box.y / s, w: cut.box.w / s, h: cut.box.h / s } }, [image]);
    } else if (!scan) throw new Error("Choose the scan again.");
    else if (m.type === "look") {
      const image = await finish(scan.cut.rgba, scan.cut.w, scan.cut.h, scan.angle, m.look);
      post({ type: "photo", id: m.id, image, angle: scan.angle, dpi: scan.dpi, box: { x: 0, y: 0, w: 0, h: 0 } }, [image]);
    } else {
      // full-resolution close-up, about 1.2 × 0.9 in of canvas, holes see-through
      const cw = Math.round(scan.dpi * 1.2), ch = Math.round(scan.dpi * 0.9);
      const x = Math.max(0, Math.min(scan.bmp.width - cw, Math.round(m.x - cw / 2))), y = Math.max(0, Math.min(scan.bmp.height - ch, Math.round(m.y - ch / 2)));
      const cut = cutOutCanvas(pixels(scan.bmp, x, y, cw, ch, cw, ch), cw, ch, scan.dpi / scan.mesh, true);
      const image = await finish(cut.rgba, cw, ch, scan.angle, m.look);
      post({ type: "closeup", id: m.id, image }, [image]);
    }
  } catch (err) {
    post({ type: "error", id: m.id, message: (err as Error).message || String(err) });
  }
};
