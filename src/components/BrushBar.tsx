import { threadLabel } from "../lib/dmc";
import { useEffect, useRef } from "react";
import { fromHex, hex, inkFor } from "../lib/color";
import { ERASER } from "../lib/edit";
import type { PaletteEntry } from "../lib/chart";

interface Props {
  pal: PaletteEntry[];
  brush: number;
  onBrush: (n: number) => void;
  onAdd: (rgb: [number, number, number]) => void;
  size: number;
  onSize: (n: number) => void;
}

/** What "Fix stitches" paints with: a chart colour, the eraser, or a new colour. */
export default function BrushBar({ pal, brush, onBrush, onAdd, size, onSize }: Props) {
  // the colour picker fires "input" while dragging; only add the colour once it's chosen
  const picker = useRef<HTMLInputElement>(null);
  const add = useRef(onAdd);
  add.current = onAdd;
  useEffect(() => {
    const el = picker.current!;
    const onChange = () => add.current(fromHex(el.value));
    el.addEventListener("change", onChange);
    return () => el.removeEventListener("change", onChange);
  }, []);
  return (
    <div className="brushes" role="group" aria-label="Paint with">
      <span className="label">Paint with</span>
      {pal.map((p, n) => (
        <button
          key={n}
          type="button"
          className="brush"
          aria-pressed={brush === n}
          aria-label={`Colour ${n + 1}, ${threadLabel(p.thread)}`}
          title={`${n + 1}. ${threadLabel(p.thread)} ${p.thread.name}`}
          style={{ background: hex(p.rgb), color: inkFor(p.rgb) }}
          onClick={() => onBrush(n)}
        >{p.sym}</button>
      ))}
      <button type="button" className="brush eraser" aria-pressed={brush === ERASER} aria-label="Eraser: leave unstitched" title="Eraser: leave unstitched" onClick={() => onBrush(ERASER)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m7 21-4-4 10-10 6 6-8 8H7zM14 21h7" /></svg>
      </button>
      <label className="bsize">
        <span className="label">Brush size</span>
        <input type="range" min={1} max={15} step={1} value={size} aria-valuetext={`${size} by ${size} stitches`} onChange={e => onSize(+e.target.value)} />
        <span className="mono">{size}×{size}</span>
      </label>
      <label className="mini add">
        + New colour
        <input type="color" aria-label="Add a new colour" defaultValue="#b02a5c" ref={picker} />
      </label>
    </div>
  );
}
