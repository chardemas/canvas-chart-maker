import { useEffect, useRef, useState } from "react";
import type { Crop } from "../lib/chart";

interface Props {
  img: HTMLImageElement;
  crop: Crop;
  onApply: (c: Crop) => void;
  onCancel: () => void;
  /** an exact pattern: one pixel per stitch, so the box snaps to whole stitches and the view shows squares */
  stitches?: boolean;
}

const FULL: Crop = { x: 0, y: 0, w: 1, h: 1 };

/** Drag a box over the picture to choose the part to chart. */
export default function CropPanel({ img, crop, onApply, onCancel, stitches = false }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const [draft, setDraft] = useState<Crop>(crop);
  const drag = useRef<[number, number] | null>(null);

  useEffect(() => {
    const c = cv.current!, maxW = Math.min(900, (panel.current?.clientWidth ?? 900) - 30);
    // stitch patterns are tiny pictures: blow them up by a whole number so each stitch stays a crisp square
    const sc = stitches ? Math.max(1, Math.floor(Math.min(maxW / img.width, 600 / img.height))) : Math.min(1, maxW / img.width, 600 / img.height);
    c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
    panel.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [img, stitches]);

  useEffect(() => {
    const c = cv.current!, g = c.getContext("2d")!, w = c.width, h = c.height, r = draft;
    g.imageSmoothingEnabled = !stitches;
    g.clearRect(0, 0, w, h);
    g.drawImage(img, 0, 0, w, h);
    g.fillStyle = "rgba(20,10,15,.55)";
    g.fillRect(0, 0, w, r.y * h); g.fillRect(0, (r.y + r.h) * h, w, h);
    g.fillRect(0, r.y * h, r.x * w, r.h * h); g.fillRect((r.x + r.w) * w, r.y * h, w, r.h * h);
    g.strokeStyle = "#fff"; g.lineWidth = 2; g.setLineDash([6, 4]); g.strokeRect(r.x * w, r.y * h, r.w * w, r.h * h); g.setLineDash([]);
  }, [draft, img, stitches]);

  /** whole stitches only, at least 4 each way */
  const snap = (c: Crop): Crop => {
    if (!stitches) return c;
    const iw = img.width, ih = img.height;
    let x0 = Math.round(c.x * iw), y0 = Math.round(c.y * ih), x1 = Math.round((c.x + c.w) * iw), y1 = Math.round((c.y + c.h) * ih);
    if (x1 - x0 < 4) { x1 = Math.min(iw, x0 + 4); x0 = x1 - 4; }
    if (y1 - y0 < 4) { y1 = Math.min(ih, y0 + 4); y0 = y1 - 4; }
    return { x: x0 / iw, y: y0 / ih, w: (x1 - x0) / iw, h: (y1 - y0) / ih };
  };
  const size = `${Math.round(draft.w * img.width)} × ${Math.round(draft.h * img.height)} stitches`;

  const pt = (e: React.PointerEvent): [number, number] => {
    const r = cv.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };

  return (
    <div className="crop" ref={panel}>
      <div className="bar"><h2>Crop</h2><span className="spacer" /><span className="note">{stitches ? `Drag across the pattern to keep part of it. Whole stitches only: ${size}.` : "Drag across the picture to choose the part you want."}</span></div>
      <canvas
        ref={cv}
        onPointerDown={e => { e.preventDefault(); cv.current!.setPointerCapture(e.pointerId); drag.current = pt(e); }}
        onPointerMove={e => {
          if (!drag.current) return;
          const [x, y] = pt(e), [x0, y0] = drag.current;
          setDraft(snap({ x: Math.min(x, x0), y: Math.min(y, y0), w: Math.max(0.02, Math.abs(x - x0)), h: Math.max(0.02, Math.abs(y - y0)) }));
        }}
        onPointerUp={() => (drag.current = null)}
      />
      <div className="btns">
        <button className="btn primary" type="button" onClick={() => onApply(draft)}>Use this crop</button>
        <button className="btn" type="button" onClick={() => setDraft(FULL)}>Whole picture</button>
        <button className="btn" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
