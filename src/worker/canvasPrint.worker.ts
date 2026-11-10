/// <reference lib="webworker" />
/**
 * Print on canvas, off the main thread: reads a 600 dpi scan (about 34 million pixels), finds the
 * carrier dots and every hole, and later draws the print file. The scan never leaves the device.
 */
import { applyH, buildLattice, ET2803, findDots, findHoles, precorrect, rasterize, scanToPage, stitchQuad, type Homography, type Lattice } from "../lib/canvasPrint";
import { printPdf } from "../lib/pdf";
import type { CanvasPrintReply, CanvasPrintRequest } from "../lib/canvasPrintClient";

const post = (m: CanvasPrintReply, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

/** grid points beyond the seen canvas, so a design can be nudged past what was visible */
const PAD = 150;

let scan: { bmp: ImageBitmap; w: number; h: number; H: Homography; L: Lattice } | null = null;

/** Grey values (same weights as OpenCV), read in strips so no single canvas gets huge. */
function toGray(bmp: ImageBitmap): Uint8Array {
  const w = bmp.width, h = bmp.height, strip = 512;
  const gray = new Uint8Array(w * h);
  const oc = new OffscreenCanvas(w, strip);
  const g = oc.getContext("2d", { willReadFrequently: true });
  if (!g) throw new Error("This browser can't read images in the background.");
  for (let y0 = 0; y0 < h; y0 += strip) {
    const sh = Math.min(strip, h - y0);
    g.clearRect(0, 0, w, strip);
    g.drawImage(bmp, 0, y0, w, sh, 0, 0, w, sh);
    const px = g.getImageData(0, 0, w, sh).data;
    for (let i = 0, o = y0 * w; i < w * sh; i++, o++) gray[o] = Math.round(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]);
  }
  return gray;
}

async function analyse(id: number, file: File) {
  const say = (text: string) => post({ type: "progress", id, text });
  say("Reading the scan…");
  scan?.bmp.close(); scan = null;
  const bmp = await createImageBitmap(file);
  const w = bmp.width, h = bmp.height;
  if (w < 4800 || w > 5400 || h < 6300) {
    bmp.close();
    throw new Error(`This scan is ${w} × ${h} pixels. Scan the whole page at 600 dpi (about 5100 × 6600 pixels).`);
  }
  const gray = toGray(bmp);
  say("Finding the corner dots…");
  const dots = findDots(gray, w, h);
  if (!dots) { bmp.close(); throw new Error("Couldn't find the four corner dots. Check that tape isn't covering one and that the page was scanned the same way up as it printed."); }
  say("Finding the holes…");
  const L = buildLattice(findHoles(gray, w, h), PAD);
  scan = { bmp, w, h, H: scanToPage(dots), L };
  const ow = 1000, overview = await createImageBitmap(bmp, { resizeWidth: ow, resizeHeight: Math.round((h * ow) / w), resizeQuality: "high" });
  const lattice: Lattice = { ...L, pos: L.pos.slice(), seen: L.seen.slice() };
  post({ type: "analysed", id, result: { scanW: w, scanH: h, lattice, overview } }, [lattice.pos.buffer, lattice.seen.buffer, overview]);
}

self.onmessage = async (e: MessageEvent<CanvasPrintRequest>) => {
  const m = e.data;
  try {
    if (m.type === "analyse") await analyse(m.id, m.file);
    else if (!scan) throw new Error("Choose the scan again.");
    else if (m.type === "crop") {
      const image = await createImageBitmap(scan.bmp, Math.round(m.x), Math.round(m.y), m.size, m.size);
      post({ type: "crop", id: m.id, image }, [image]);
    } else {
      const { H, L } = scan, [ai, aj] = m.at;
      const toPage = (p: [number, number]) => { const q = applyH(H, p[0], p[1]); return m.correct ? precorrect(q, ET2803) : q; };
      const r = rasterize(
        (c, row) => stitchQuad(L, ai, aj, c, row).map(toPage),
        m.W, m.H,
        (c, row) => { const k = m.idx[row * m.W + c]; return k < 0 ? null : m.colours.subarray(k * 3, k * 3 + 3); },
      );
      post({ type: "pdf", id: m.id, pdf: await printPdf(r) });
    }
  } catch (err) {
    post({ type: "error", id: m.id, message: (err as Error).message || String(err) });
  }
};
