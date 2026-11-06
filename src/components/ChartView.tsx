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
  onStrokeStart: () => void;
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
export default function ChartView({ chart, rev, mode, focus, tool, zoom, busy, onZoom, onStrokeStart, onCell, onStrokeEnd, onStrokeCancel }: Props) {
  const viewer = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const z = useRef(zoom);
  const pts = useRef(new Map<number, Pt>());
  const g = useRef<Gesture>({ kind: "none" });
  const last = useRef(-1);
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

  const cellAt = (p: Pt) => {
    const c = cv.current!, r = c.getBoundingClientRect(), sc = c.width / r.width;
    const x = Math.floor(((p.x - r.left) * sc - MARGIN) / CELL), y = Math.floor(((p.y - r.top) * sc - MARGIN) / CELL);
    if (x < 0 || y < 0 || x >= chart.W || y >= chart.H) return -1;
    const i = y * chart.W + x;
    return tool === "paint" || chart.idx[i] >= 0 ? i : -1;
  };
  const visit = (p: Pt) => {
    const i = cellAt(p);
    if (i < 0 || i === last.current) return;
    last.current = i;
    onCell(i);
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
    viewer.current!.setPointerCapture(e.pointerId);
    e.preventDefault();
    if (pts.current.size === 1) {
      if (active) {
        g.current = { kind: "draw", id: e.pointerId };
        last.current = -1;
        onStrokeStart();
        visit(p);
      } else g.current = { kind: "pan", id: e.pointerId, last: p };
    } else if (pts.current.size === 2) {
      if (g.current.kind === "draw") onStrokeCancel();
      startPinch();
    }
  };

  const move = (e: React.PointerEvent) => {
    if (!pts.current.has(e.pointerId)) return;
    const p = { x: e.clientX, y: e.clientY };
    pts.current.set(e.pointerId, p);
    const cur = g.current;
    if (cur.kind === "draw" && cur.id === e.pointerId) visit(p);
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
    if (cur.kind === "draw" && cur.id === e.pointerId) { g.current = { kind: "none" }; onStrokeEnd(); }
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
    >
      <canvas ref={cv} aria-label="Needlepoint chart" />
    </div>
  );
}
