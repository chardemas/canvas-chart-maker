import { useCallback, useEffect, useRef } from "react";
import { CELL, MARGIN, drawView, type Chart, type Mode } from "../lib/render";

export type Tool = "tick" | "paint" | null;

/** zoom is relative to "fit the width"; these are the limits */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 16;
/** never blow a square up past this many screen pixels (it just gets blurry) */
const MAX_CELL_PX = 56;

interface Props {
  chart: Chart;
  rev: number;
  mode: Mode;
  focus: number;
  tool: Tool;
  zoom: number;
  busy: boolean;
  /** the chart was pinched, ctrl-scrolled or clamped to a new zoom */
  onZoom: (z: number) => void;
  /** squares the brush covers across (Fix stitches); an outline shows where it will land */
  brushSize?: number;
  /** `eraser`: drawn with a pen's eraser end */
  onStrokeStart: (eraser: boolean) => void;
  /** a square the stroke passed over (background squares included only when painting) */
  onCell: (i: number) => void;
  onStrokeEnd: () => void;
  /** a second finger landed mid-stroke: it's a pinch, so take the stroke back */
  onStrokeCancel: () => void;
}

type Pt = { x: number; y: number };
type Gesture =
  | { kind: "none" }
  | { kind: "draw"; id: number }
  | { kind: "pan"; id: number; last: Pt }
  | { kind: "pinch"; startDist: number; startZoom: number; last: Pt };

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y) || 1;

/**
 * The chart canvas. With a tool on, one finger (or the mouse) ticks or repaints squares.
 * Two fingers pinch to zoom and drag to move around; with no tool on, one finger drags too.
 * On a Mac, trackpad pinch (or ctrl + scroll) zooms.
 */
export default function ChartView({ chart, rev, mode, focus, tool, zoom, busy, onZoom, brushSize = 1, onStrokeStart, onCell, onStrokeEnd, onStrokeCancel }: Props) {
  const viewer = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const z = useRef(zoom);
  const pts = useRef(new Map<number, Pt>());
  const g = useRef<Gesture>({ kind: "none" });
  const last = useRef<{ x: number; y: number } | null>(null);
  const mark = useRef<HTMLDivElement>(null);
  const active = tool !== null && mode !== "print";

  const fitScale = () => {
    const c = cv.current!, v = viewer.current!;
    return Math.max(0.02, Math.min(1, (v.clientWidth - 26) / c.width));
  };
  const clampZoom = (n: number) => {
    const maxZ = Math.max(2, Math.min(ZOOM_MAX, MAX_CELL_PX / (CELL * fitScale())));
    return Math.min(maxZ, Math.max(ZOOM_MIN, n));
  };
  const size = () => {
    const c = cv.current, v = viewer.current;
    if (!c || !v) return;
    const sc = z.current * fitScale();
    c.style.width = Math.round(c.width * sc) + "px";
    c.style.height = Math.round(c.height * sc) + "px";
  };

  /** zoom so the chart point under `from` ends up under `to` (screen coordinates) */
  const zoomTo = (n: number, from: Pt, to: Pt = from) => {
    const c = cv.current, v = viewer.current;
    if (!c || !v) return;
    const r = c.getBoundingClientRect();
    const fx = (from.x - r.left) / r.width, fy = (from.y - r.top) / r.height;
    const nz = clampZoom(n);
    if (nz !== z.current) { z.current = nz; size(); }
    const r2 = c.getBoundingClientRect();
    v.scrollLeft += r2.left + fx * r2.width - to.x;
    v.scrollTop += r2.top + fy * r2.height - to.y;
    if (nz !== zoom) onZoom(nz);
  };
  const zoomRef = useRef(zoomTo);
  zoomRef.current = zoomTo;

  const centre = (): Pt => {
    const r = viewer.current!.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  // the zoom buttons / slider changed it: zoom about the middle of the view
  useEffect(() => {
    if (!cv.current || !viewer.current || Math.abs(zoom - z.current) < 1e-6) return;
    zoomRef.current(zoom, centre());
  }, [zoom]);

  const fit = useCallback(() => {
    if (!cv.current || !viewer.current) return;
    const nz = clampZoom(z.current);
    if (nz !== z.current) { z.current = nz; onZoom(nz); }
    size();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onZoom]);

  // redraw at most once per frame
  useEffect(() => {
    const id = requestAnimationFrame(() => { if (cv.current) { drawView(cv.current, chart, mode, focus); fit(); } });
    return () => cancelAnimationFrame(id);
  }, [chart, rev, mode, focus, fit]);

  // the viewer changes width when going full screen or turning the iPad
  useEffect(() => {
    const v = viewer.current;
    if (!v) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(v);
    return () => ro.disconnect();
  }, [fit]);

  // trackpad pinch (Chrome/Firefox send ctrl + wheel) and Safari's gesture events
  useEffect(() => {
    const v = viewer.current!;
    let gStart = 1;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomRef.current(z.current * Math.exp(-e.deltaY * 0.01), { x: e.clientX, y: e.clientY });
    };
    type GE = Event & { scale: number; clientX: number; clientY: number };
    const gs = (e: Event) => { e.preventDefault(); gStart = z.current; };
    const gc = (e: Event) => {
      e.preventDefault();
      if (pts.current.size) return; // touch screens: the pointer handlers below do it
      const ge = e as GE;
      zoomRef.current(gStart * ge.scale, { x: ge.clientX, y: ge.clientY });
    };
    v.addEventListener("wheel", wheel, { passive: false });
    v.addEventListener("gesturestart", gs);
    v.addEventListener("gesturechange", gc);
    return () => {
      v.removeEventListener("wheel", wheel);
      v.removeEventListener("gesturestart", gs);
      v.removeEventListener("gesturechange", gc);
    };
  }, []);

  const squareAt = (p: Pt) => {
    const c = cv.current!, r = c.getBoundingClientRect(), sc = c.width / r.width;
    const x = Math.floor(((p.x - r.left) * sc - MARGIN) / CELL), y = Math.floor(((p.y - r.top) * sc - MARGIN) / CELL);
    return x < 0 || y < 0 || x >= chart.W || y >= chart.H ? null : { x, y };
  };
  const take = (x: number, y: number) => {
    const i = y * chart.W + x;
    if (tool === "paint" || chart.idx[i] >= 0) onCell(i);
  };
  /** visits the square under the pointer and every square on the way from the last one, so fast strokes leave no gaps */
  const visit = (p: Pt) => {
    const q = squareAt(p);
    if (!q) { last.current = null; return; }
    const from = last.current;
    if (from && from.x === q.x && from.y === q.y) return;
    if (from) {
      const steps = Math.max(Math.abs(q.x - from.x), Math.abs(q.y - from.y));
      for (let s = 1; s < steps; s++) take(Math.round(from.x + ((q.x - from.x) * s) / steps), Math.round(from.y + ((q.y - from.y) * s) / steps));
    }
    take(q.x, q.y);
    last.current = q;
  };

  /** outline of the squares the brush will cover */
  const showMark = (p: Pt | null) => {
    const m = mark.current, c = cv.current, v = viewer.current;
    if (!m || !c || !v) return;
    const q = p && tool === "paint" && mode !== "print" ? squareAt(p) : null;
    if (!q) { m.style.display = "none"; return; }
    const r = c.getBoundingClientRect(), vr = v.getBoundingClientRect(), px = r.width / c.width;
    const half = Math.floor((brushSize - 1) / 2);
    const x0 = Math.max(0, q.x - half), y0 = Math.max(0, q.y - half);
    const x1 = Math.min(chart.W, q.x - half + brushSize), y1 = Math.min(chart.H, q.y - half + brushSize);
    m.style.display = "block";
    m.style.left = r.left - vr.left + v.scrollLeft + (MARGIN + x0 * CELL) * px + "px";
    m.style.top = r.top - vr.top + v.scrollTop + (MARGIN + y0 * CELL) * px + "px";
    m.style.width = (x1 - x0) * CELL * px + "px";
    m.style.height = (y1 - y0) * CELL * px + "px";
  };

  /** drag the view; whatever the box can't scroll moves the page instead */
  const pan = (dx: number, dy: number, page: boolean) => {
    const v = viewer.current!;
    const before = v.scrollTop;
    v.scrollLeft -= dx; v.scrollTop -= dy;
    const leftover = -dy - (v.scrollTop - before);
    if (page && Math.abs(leftover) > 0.5) window.scrollBy(0, leftover);
  };

  const startPinch = () => {
    const [a, b] = [...pts.current.values()];
    g.current = { kind: "pinch", startDist: dist(a, b), startZoom: z.current, last: mid(a, b) };
  };

  const down = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const p = { x: e.clientX, y: e.clientY };
    pts.current.set(e.pointerId, p);
    try { viewer.current!.setPointerCapture(e.pointerId); } catch { /* some pens/emulators can't be captured; strokes still work */ }
    e.preventDefault();
    if (pts.current.size === 1) {
      if (active) {
        g.current = { kind: "draw", id: e.pointerId };
        last.current = null;
        // pens with an eraser end (or eraser button) report button 5 (bit 32)
        onStrokeStart(e.pointerType === "pen" && (e.buttons & 32) !== 0);
        visit(p);
        showMark(p);
      } else g.current = { kind: "pan", id: e.pointerId, last: p };
    } else if (pts.current.size === 2) {
      if (g.current.kind === "draw") onStrokeCancel();
      showMark(null);
      startPinch();
    }
  };

  const move = (e: React.PointerEvent) => {
    if (e.pointerType !== "touch" && g.current.kind !== "pinch") showMark({ x: e.clientX, y: e.clientY }); // mouse or Pencil hovering
    if (!pts.current.has(e.pointerId)) return;
    const p = { x: e.clientX, y: e.clientY };
    pts.current.set(e.pointerId, p);
    const cur = g.current;
    if (cur.kind === "draw" && cur.id === e.pointerId) { visit(p); showMark(p); }
    else if (cur.kind === "pan" && cur.id === e.pointerId) {
      pan(p.x - cur.last.x, p.y - cur.last.y, !document.documentElement.classList.contains("fullchart"));
      cur.last = p;
    } else if (cur.kind === "pinch" && pts.current.size >= 2) {
      const [a, b] = [...pts.current.values()];
      const m = mid(a, b);
      zoomTo(cur.startZoom * (dist(a, b) / cur.startDist), cur.last, m);
      cur.last = m;
    }
  };

  const up = (e: React.PointerEvent) => {
    if (!pts.current.delete(e.pointerId)) return;
    const cur = g.current;
    if (cur.kind === "draw" && cur.id === e.pointerId) { g.current = { kind: "none" }; onStrokeEnd(); if (e.pointerType === "touch") showMark(null); }
    else if (cur.kind === "pan" && cur.id === e.pointerId) g.current = { kind: "none" };
    else if (cur.kind === "pinch") {
      // the finger left behind after a pinch shouldn't start drawing
      if (pts.current.size >= 2) startPinch(); else g.current = { kind: "none" };
    }
  };

  return (
    <div
      className={"viewer" + (active ? " ticking" : "") + (busy ? " busy" : "")}
      ref={viewer}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={() => showMark(null)}
    >
      <canvas ref={cv} aria-label="Needlepoint chart" />
      <div className="brushmark" ref={mark} aria-hidden="true" />
    </div>
  );
}
