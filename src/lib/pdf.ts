/**
 * Minimal single-page PDF writer (US Letter), enough for the canvas print file and the carrier page.
 * Pages are exact size, so printing at 100% puts every mark where it was drawn.
 */
import { DOT_R_IN, DOTS_IN, ORIENT_IN, ORIENT_R_IN, PANEL_GREY, PANEL_IN, DPI, type Raster } from "./canvasPrint";

const PT = 72; // PDF points per inch
const PAGE_W_PT = 8.5 * PT, PAGE_H_PT = 11 * PT;
const enc = new TextEncoder();

/** zlib-wrapped deflate, which is what PDF's FlateDecode expects. */
export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

type Part = string | Uint8Array;

/** Assembles numbered objects into a PDF file with a correct cross-reference table. */
function assemble(objects: Part[][]): Blob {
  const chunks: Uint8Array[] = [];
  let len = 0;
  const put = (p: Part) => { const b = typeof p === "string" ? enc.encode(p) : p; chunks.push(b); len += b.length; };
  put("%PDF-1.4\n%âãÏÓ\n");
  const offsets: number[] = [];
  objects.forEach((parts, i) => {
    offsets.push(len);
    put(`${i + 1} 0 obj\n`);
    parts.forEach(put);
    put("\nendobj\n");
  });
  const xref = len;
  put(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const o of offsets) put(`${String(o).padStart(10, "0")} 00000 n \n`);
  put(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks as BlobPart[], { type: "application/pdf" });
}

const stream = (dict: string, data: Uint8Array): Part[] => [`<< ${dict} /Length ${data.length} >>\nstream\n`, data, "\nendstream"];
const n = (v: number) => (Math.round(v * 1000) / 1000).toString();

/** A letter page with the design raster placed at its exact spot (raster pixels are 1/600 in). */
export async function printPdf(r: Raster): Promise<Blob> {
  const img = await deflate(r.rgb);
  const w = (r.w / DPI) * PT, h = (r.h / DPI) * PT, x = (r.x / DPI) * PT, y = PAGE_H_PT - ((r.y + r.h) / DPI) * PT;
  const content = enc.encode(`q ${n(w)} 0 0 ${n(h)} ${n(x)} ${n(y)} cm /Im0 Do Q\n`);
  return assemble([
    ["<< /Type /Catalog /Pages 2 0 R >>"],
    ["<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W_PT} ${PAGE_H_PT}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`],
    stream(`/Type /XObject /Subtype /Image /Width ${r.w} /Height ${r.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`, img),
    stream("", content),
  ]);
}

/** Circle as four Bézier curves, filled. Inches from the top-left. */
function disc(cxIn: number, cyIn: number, rIn: number) {
  const cx = cxIn * PT, cy = PAGE_H_PT - cyIn * PT, r = rIn * PT, k = 0.5523 * r;
  return `${n(cx + r)} ${n(cy)} m ${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c `
    + `${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c `
    + `${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c `
    + `${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c f\n`;
}

/** The carrier page: four corner dots (plus an orientation dot) and the dark panel to tape canvas onto. */
export async function carrierPdf(): Promise<Blob> {
  const [x0, y0, x1, y1] = PANEL_IN;
  const grey = n(PANEL_GREY / 255);
  let s = `${grey} g ${n(x0 * PT)} ${n(PAGE_H_PT - y1 * PT)} ${n((x1 - x0) * PT)} ${n((y1 - y0) * PT)} re f\n0 g\n`;
  for (const [x, y] of DOTS_IN) s += disc(x, y, DOT_R_IN);
  s += disc(ORIENT_IN[0], ORIENT_IN[1], ORIENT_R_IN);
  s += `BT /F1 8 Tf ${n(1.0 * PT)} ${n(PAGE_H_PT - 0.53 * PT)} Td (CARRIER - tape canvas over the grey panel, keep the corner dots clear. Top edge feeds first. Print at 100%.) Tj ET\n`;
  const content = enc.encode(s);
  return assemble([
    ["<< /Type /Catalog /Pages 2 0 R >>"],
    ["<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W_PT} ${PAGE_H_PT}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`],
    ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"],
    stream("", content),
  ]);
}

/** A dark grey sheet to lay a loose canvas on for listing-photo scans (prints once, reuse it). */
export async function backingPdf(): Promise<Blob> {
  const m = 0.25 * PT; // most printers can't print the very edge
  const content = enc.encode(`0.22 g ${n(m)} ${n(m)} ${n(PAGE_W_PT - 2 * m)} ${n(PAGE_H_PT - 2 * m)} re f\n`);
  return assemble([
    ["<< /Type /Catalog /Pages 2 0 R >>"],
    ["<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W_PT} ${PAGE_H_PT}] /Contents 4 0 R >>`],
    stream("", content),
  ]);
}
