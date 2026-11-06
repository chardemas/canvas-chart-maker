import { hex, inkFor } from "../lib/color";
import type { PaletteEntry } from "../lib/chart";

interface Props {
  pal: PaletteEntry[];
  focus: number;
  onFocus: (n: number) => void;
}

/** Full screen's stand-in for the legend: tap a colour to highlight just its stitches. */
export default function ColourBar({ pal, focus, onFocus }: Props) {
  return (
    <div className="brushes" role="group" aria-label="Highlight a colour">
      <span className="label">Highlight</span>
      {pal.map((p, n) => (
        <button
          key={n}
          type="button"
          className="brush"
          aria-pressed={focus === n}
          aria-label={`Highlight colour ${n + 1}, DMC ${p.thread.code}`}
          title={`${n + 1}. DMC ${p.thread.code} ${p.thread.name} · ${p.done} of ${p.count} done`}
          style={{ background: hex(p.rgb), color: inkFor(p.rgb) }}
          onClick={() => onFocus(n)}
        >{p.sym}</button>
      ))}
      {focus >= 0 && pal[focus] && (
        <span className="note">
          DMC {pal[focus].thread.code} {pal[focus].thread.name} · {pal[focus].done.toLocaleString()} of {pal[focus].count.toLocaleString()} done
        </span>
      )}
    </div>
  );
}
