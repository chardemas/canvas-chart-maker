/** Browser-only picture steps: crop + trim (steps 1–2) and the sharp step-by-step shrink (step 4). */
import { findTrimBox, type Box, type Crop } from "./chart";

export type Source = HTMLImageElement | HTMLCanvasElement | ImageBitmap;

/** The crop, then optionally trimmed to the non-background box, in source pixels. */
export function computeRegion(src: Source, crop: Crop, opts: { rm: boolean; cutout: boolean; trim: boolean; thr: number }): Box {
  const iw = src.width, ih = src.height;
  let r: Box = { x: crop.x * iw, y: crop.y * ih, w: crop.w * iw, h: crop.h * ih };
  if (opts.trim && (opts.rm || opts.cutout)) {
    // look at a small copy; plenty for finding the edges
    const sc = Math.min(1, 500 / Math.max(r.w, r.h));
    const tw = Math.max(1, Math.round(r.w * sc)), th = Math.max(1, Math.round(r.h * sc));
    const c = document.createElement("canvas"); c.width = tw; c.height = th;
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, tw, th);
    const box = findTrimBox(g.getImageData(0, 0, tw, th).data, tw, th, opts.thr, opts.rm);
    if (box) r = { x: r.x + box.x / sc, y: r.y + box.y / sc, w: box.w / sc, h: box.h / sc };
  }
  return r;
}

/** One pixel per stitch. With proportions unlocked, the picture is fitted inside W × H and centred. */
export function drawRegion(src: Source, region: Box, W: number, H: number, lock: boolean): Uint8ClampedArray {
  let bw = W, bh = H, ox = 0, oy = 0;
  if (!lock) {
    const sc = Math.min(W / region.w, H / region.h);
    bw = Math.max(1, Math.round(region.w * sc)); bh = Math.max(1, Math.round(region.h * sc));
    ox = Math.floor((W - bw) / 2); oy = Math.floor((H - bh) / 2);
  }
  let cw = Math.max(1, Math.round(region.w)), ch = Math.max(1, Math.round(region.h));
  let cur = document.createElement("canvas"); cur.width = cw; cur.height = ch;
  cur.getContext("2d")!.drawImage(src, region.x, region.y, region.w, region.h, 0, 0, cw, ch);
  // halve repeatedly so fine detail averages out instead of being skipped
  while (cw / 2 > bw * 1.5) {
    cw = Math.round(cw / 2); ch = Math.round(ch / 2);
    const t = document.createElement("canvas"); t.width = cw; t.height = ch;
    const tg = t.getContext("2d")!; tg.imageSmoothingQuality = "high"; tg.drawImage(cur, 0, 0, cw, ch);
    cur = t;
  }
  const out = document.createElement("canvas"); out.width = W; out.height = H;
  const g = out.getContext("2d", { willReadFrequently: true })!;
  g.imageSmoothingQuality = "high"; g.drawImage(cur, ox, oy, bw, bh);
  return g.getImageData(0, 0, W, H).data;
}
