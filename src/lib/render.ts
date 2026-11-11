/** Drawing the chart onto a canvas: symbol/colour charts, the plain print version, and the image to save. */
import { threadLabel } from "./dmc";
import { hex, inkFor } from "./color";
import type { BuiltChart } from "./chart";

export const CELL = 18;   // chart pixels per stitch
export const MARGIN = 46; // room for the edge numbers and centre arrows

export interface Chart extends BuiltChart {
  /** 1 = ticked off */
  done: Uint8Array;
  /** identifies this exact chart, so ticks belong to it */
  key: string;
}

export type Mode = "symbols" | "colour" | "print";

const C = CELL, M = MARGIN;

export function paintChart(g: CanvasRenderingContext2D, chart: Chart, opts: { mode: Mode; focus: number; showDone: boolean }) {
  const { W, H, idx, pal, done } = chart, sym = opts.mode === "symbols";
  g.fillStyle = "#fff"; g.fillRect(0, 0, g.canvas.width, g.canvas.height);
  g.textAlign = "center"; g.textBaseline = "middle";
  g.font = `bold ${Math.round(C * 0.62)}px system-ui,-apple-system,"Segoe UI",sans-serif`;
  const colours = pal.map(p => hex(p.rgb)), inks = pal.map(p => inkFor(p.rgb));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, k = idx[i];
    if (k < 0) continue;
    const X = M + x * C, Y = M + y * C;
    const dim = opts.focus >= 0 && k !== opts.focus, isDone = opts.showDone && done[i];
    g.globalAlpha = dim ? 0.15 : isDone ? 0.28 : 1; g.fillStyle = colours[k]; g.fillRect(X, Y, C, C); g.globalAlpha = 1;
    if (isDone) {
      g.strokeStyle = dim ? "rgba(40,40,40,.25)" : "#1d5c34"; g.lineWidth = 2.2; g.beginPath();
      g.moveTo(X + 4, Y + C * 0.55); g.lineTo(X + C * 0.42, Y + C - 4); g.lineTo(X + C - 3, Y + 4); g.stroke();
    } else if (sym && !dim) {
      g.fillStyle = inks[k]; g.fillText(pal[k].sym, X + C / 2, Y + C / 2 + 1);
    }
  }
  // fine grid, then a heavy line every 10 stitches
  g.strokeStyle = "rgba(0,0,0,.16)"; g.lineWidth = 1; g.beginPath();
  for (let x = 0; x <= W; x++) { g.moveTo(M + x * C + 0.5, M); g.lineTo(M + x * C + 0.5, M + H * C); }
  for (let y = 0; y <= H; y++) { g.moveTo(M, M + y * C + 0.5); g.lineTo(M + W * C, M + y * C + 0.5); }
  g.stroke();
  g.strokeStyle = "#333"; g.lineWidth = 2; g.beginPath();
  for (let x = 0; x <= W; x += 10) { g.moveTo(M + x * C, M); g.lineTo(M + x * C, M + H * C); }
  for (let y = 0; y <= H; y += 10) { g.moveTo(M, M + y * C); g.lineTo(M + W * C, M + y * C); }
  g.rect(M, M, W * C, H * C); g.stroke();
  g.fillStyle = "#333"; g.font = "600 12px system-ui,sans-serif";
  for (let x = 0; x <= W; x += 10) g.fillText(String(x), M + x * C, M - 14);
  g.textAlign = "right";
  for (let y = 0; y <= H; y += 10) g.fillText(String(y), M - 8, M + y * C);
  g.textAlign = "center";
  // centre: red lines, arrows on each edge, and an X in the centre stitch
  const cx = Math.floor(W / 2), cy = Math.floor(H / 2), red = "#d81e3c";
  const mx = M + cx * C + C / 2, my = M + cy * C + C / 2;
  g.strokeStyle = red; g.lineWidth = 2; g.beginPath();
  g.moveTo(mx, M - 4); g.lineTo(mx, M + H * C + 4); g.moveTo(M - 4, my); g.lineTo(M + W * C + 4, my); g.stroke();
  g.fillStyle = red;
  tri(g, mx, M - 3, 0, -1); tri(g, mx, M + H * C + 3, 0, 1); tri(g, M - 3, my, -1, 0); tri(g, M + W * C + 3, my, 1, 0);
  const X0 = M + cx * C, Y0 = M + cy * C;
  g.lineWidth = 3; g.strokeRect(X0, Y0, C, C);
  g.beginPath(); g.moveTo(X0, Y0); g.lineTo(X0 + C, Y0 + C); g.moveTo(X0 + C, Y0); g.lineTo(X0, Y0 + C); g.stroke();
}

function tri(g: CanvasRenderingContext2D, x: number, y: number, dx: number, dy: number) {
  g.beginPath(); g.moveTo(x, y);
  g.lineTo(x + dx * 12 - dy * 7, y + dy * 12 - dx * 7);
  g.lineTo(x + dx * 12 + dy * 7, y + dy * 12 + dx * 7);
  g.closePath(); g.fill();
}

/** Plain coloured squares, P pixels per stitch, no grid or symbols. */
export function paintPrint(g: CanvasRenderingContext2D, chart: BuiltChart, P: number) {
  const { W, H, idx, pal } = chart;
  g.fillStyle = "#fff"; g.fillRect(0, 0, W * P, H * P);
  const colours = pal.map(p => hex(p.rgb));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = idx[y * W + x];
    if (k < 0) continue;
    g.fillStyle = colours[k]; g.fillRect(x * P, y * P, P, P);
  }
}

/** Sizes the canvas and draws the current view onto it. */
export function drawView(cv: HTMLCanvasElement, chart: Chart, mode: Mode, focus: number) {
  const g = cv.getContext("2d")!;
  if (mode === "print") {
    cv.width = chart.W * C; cv.height = chart.H * C; paintPrint(g, chart, C);
  } else {
    cv.width = chart.W * C + M * 2; cv.height = chart.H * C + M * 2;
    paintChart(g, chart, { mode, focus, showDone: true });
  }
}

/** The image to save: the chart plus a legend with DMC threads, without ticks. Returns a PNG data URL. */
export function renderExport(chart: Chart, mode: Mode, mesh: number): string {
  const { W, H, pal } = chart;
  const c = document.createElement("canvas"), g = c.getContext("2d")!;
  if (mode === "print") {
    c.width = W * C; c.height = H * C; paintPrint(g, chart, C);
    return c.toDataURL("image/png");
  }
  const cols = 2, rowH = 36, lRows = Math.ceil((pal.length + 1) / cols), width = W * C + M * 2;
  c.width = width; c.height = H * C + M * 2 + 60 + lRows * rowH;
  paintChart(g, chart, { mode, focus: -1, showDone: false });
  let ly = M + H * C + 40;
  g.textAlign = "left"; g.textBaseline = "middle"; g.fillStyle = "#222"; g.font = "600 16px system-ui,sans-serif";
  g.fillText(`${W} × ${H} stitches · ${(W / mesh).toFixed(2)} × ${(H / mesh).toFixed(2)} in on ${mesh} mesh · red X = centre (col ${Math.floor(W / 2) + 1}, row ${Math.floor(H / 2) + 1})`, M, ly);
  ly += 26;
  const colW = (width - M * 2) / cols;
  const items = [
    { rgb: [255, 255, 255], sym: "", text: `Background   ${chart.bg} st` },
    ...pal.map((p, n) => ({ rgb: p.rgb as number[], sym: mode === "symbols" ? p.sym : "", text: `${n + 1}.  ${threadLabel(p.thread)} ${p.thread.name}   ${p.count} st` })),
  ];
  items.forEach((it, n) => {
    const x = M + (n % cols) * colW, y = ly + Math.floor(n / cols) * rowH;
    g.fillStyle = hex(it.rgb); g.fillRect(x, y, 26, 26);
    g.strokeStyle = "#000"; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, 25, 25);
    if (it.sym) { g.fillStyle = inkFor(it.rgb); g.textAlign = "center"; g.font = "bold 14px system-ui,sans-serif"; g.fillText(it.sym, x + 13, y + 14); }
    g.textAlign = "left"; g.fillStyle = "#222"; g.font = "500 15px system-ui,sans-serif"; g.fillText(it.text, x + 36, y + 13);
  });
  return c.toDataURL("image/png");
}
