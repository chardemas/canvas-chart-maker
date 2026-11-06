import { useState } from "react";
import type { ChartMeta } from "../lib/library";

interface Props {
  charts: ChartMeta[];
  currentId: string | null;
  onOpen: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const when = (t: number) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** The list of saved charts. */
export default function Library({ charts, currentId, onOpen, onRename, onDelete, onClose }: Props) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <section className="library" aria-label="My charts">
      <div className="bar"><h2>My charts</h2><span className="spacer" /><button className="btn" type="button" onClick={onClose}>Close</button></div>
      {!charts.length ? (
        <p className="note">No saved charts yet. Make a chart, then tap <b>Save to My charts</b> under the picture.</p>
      ) : (
        <div className="cards">
          {charts.map(m => {
            const pct = m.stitches ? Math.floor((m.done / m.stitches) * 100) : 0;
            return (
              <article key={m.id} className={"card" + (m.id === currentId ? " on" : "")}>
                <button type="button" className="thumb" onClick={() => onOpen(m.id)} aria-label={`Open ${m.name}`}>
                  <img src={m.thumb} alt="" />
                </button>
                <input
                  className="cname"
                  aria-label="Chart name"
                  defaultValue={m.name}
                  key={m.name}
                  onBlur={e => { const v = e.target.value.trim(); if (v && v !== m.name) onRename(m.id, v); else e.target.value = m.name; }}
                  onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
                />
                <p className="note">{(m.W / m.mesh).toFixed(2)} × {(m.H / m.mesh).toFixed(2)} in · {m.mesh} mesh · {when(m.updated)}</p>
                <div className="lbar"><span style={{ width: pct + "%" }} /></div>
                <p className="note">{pct}% done · {m.done.toLocaleString()} of {m.stitches.toLocaleString()} stitches</p>
                <div className="btns">
                  {m.id === currentId
                    ? <span className="mono">Open now</span>
                    : <button className="btn primary" type="button" onClick={() => onOpen(m.id)}>Open</button>}
                  <span className="spacer" />
                  {confirming === m.id ? (
                    <>
                      <span className="note">Delete for good?</span>
                      <button className="mini danger" type="button" onClick={() => { setConfirming(null); onDelete(m.id); }}>Delete</button>
                      <button className="mini" type="button" onClick={() => setConfirming(null)}>Keep</button>
                    </>
                  ) : (
                    <button className="mini" type="button" onClick={() => setConfirming(m.id)}>Delete</button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <p className="note">Charts are saved in this browser on this device. Your ticks and fixes save with them automatically.</p>
    </section>
  );
}
