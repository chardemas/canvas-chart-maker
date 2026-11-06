import { useMemo } from "react";
import { fromHex, hex, inkFor } from "../lib/color";
import { nearestDMC, threadByCode } from "../lib/dmc";
import type { PaletteEntry } from "../lib/chart";
import type { Chart } from "../lib/render";

interface Props {
  chart: Chart;
  focus: number;
  onFocus: (n: number) => void;
  /** a colour or thread was changed; `final` = save it */
  onEdit: () => void;
  onMark: (n: number, v: 0 | 1) => void;
  onClearAll: () => void;
}

export default function Legend({ chart, focus, onFocus, onEdit, onMark, onClearAll }: Props) {
  return (
    <div className="legend">
      <div className="bar"><h2>Colours and threads</h2><span className="spacer" /><button className="btn" type="button" onClick={onClearAll}>Clear all ticks</button></div>
      <p className="note">Tap a colour to highlight its stitches. Tap the swatch to pick any colour, or choose a nearby DMC shade from the list. Screen colours are approximate, so check against a real DMC colour card before buying.</p>
      <div className="lgrid">
        {chart.pal.map((p, n) => (
          <LegendRow key={n} p={p} n={n} on={focus === n} onFocus={onFocus} onEdit={onEdit} onMark={onMark} />
        ))}
      </div>
      <p className="credit">Thread colour data: craft-color-codes by <a href="https://makebead.com/" target="_blank" rel="noopener">MakeBead</a>, CC BY 4.0. Subject finder: <a href="https://github.com/ZhengPeng7/BiRefNet" target="_blank" rel="noopener">BiRefNet</a> (MIT), run with ONNX Runtime. DMC is a trademark of its owner.</p>
    </div>
  );
}

function LegendRow({ p, n, on, onFocus, onEdit, onMark }: { p: PaletteEntry; n: number; on: boolean } & Pick<Props, "onFocus" | "onEdit" | "onMark">) {
  const colour = hex(p.rgb);
  const near = useMemo(() => {
    const list = nearestDMC(p.rgb, 8);
    if (!list.find(d => d.code === p.thread.code)) list.unshift(p.thread);
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colour, p.thread.code]);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const pct = p.count ? (p.done / p.count) * 100 : 0;

  return (
    <div
      className={"lrow" + (on ? " on" : "")}
      tabIndex={0}
      role="button"
      aria-pressed={on}
      aria-label={`Highlight colour ${n + 1}`}
      onClick={() => onFocus(n)}
      onKeyDown={e => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onFocus(n); } }}
    >
      <span className="sw" style={{ background: colour, color: inkFor(p.rgb) }}>
        {p.sym}
        <input
          type="color"
          aria-label={`Pick any colour for colour ${n + 1}`}
          value={colour}
          onClick={stop}
          onKeyDown={stop}
          onChange={e => { p.rgb = fromHex(e.target.value); p.thread = nearestDMC(p.rgb)[0]; onEdit(); }}
        />
      </span>
      <div className="linfo">
        <div className="lhead"><b>{n + 1}. {colour}</b><span className="mono">{p.count} st</span></div>
        <label className="thread" onClick={stop}>
          <i style={{ background: hex(p.thread.rgb) }} />
          <span className="mono">DMC</span>
          <select
            aria-label={`DMC thread for colour ${n + 1}`}
            value={p.thread.code}
            onKeyDown={stop}
            onChange={e => { const d = threadByCode(e.target.value); if (d) { p.thread = d; p.rgb = [...d.rgb]; onEdit(); } }}
          >
            {near.map(d => <option key={d.code} value={d.code}>{d.code} {d.name}</option>)}
          </select>
        </label>
        <div className="lbar"><span style={{ width: pct + "%" }} /></div>
        <div className="lfoot">
          <span className="note">{p.done} of {p.count} done</span>
          <span className="btns">
            <button className="mini" type="button" onClick={e => { stop(e); onMark(n, 1); }}>Tick all</button>
            <button className="mini" type="button" onClick={e => { stop(e); onMark(n, 0); }}>Clear</button>
          </span>
        </div>
      </div>
    </div>
  );
}
