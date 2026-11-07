/**
 * The customer's page (/c/<id>): their finished chart, to tick off as they stitch. No editing.
 * Ticks save on this device straight away and with the link online, so any device that opens the
 * link shows the same progress. Without internet it keeps working and uploads later.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import ChartView, { ZOOM_MAX, ZOOM_MIN, type Tool } from "./components/ChartView";
import ColourBar from "./components/ColourBar";
import { hex, inkFor } from "./lib/color";
import { tickCell, undoChanges, type Change } from "./lib/edit";
import type { Chart, Mode } from "./lib/render";
import { dbGet, dbPut, keepStorage } from "./lib/storage";
import { decodeChart, decodeProgress, doneCount, fetchShared, packDone, saveSharedProgress, stitchCount, toChart, unpackDone, type SharedChartData } from "./lib/shared";
import { pack, unpack } from "./lib/backup";

interface Local { title: string; note: string; mesh: number; chart: unknown; done: unknown; updated: number; synced: number }
type Save = "saved" | "saving" | "offline" | "gone";

export default function Tracker({ id }: { id: string }) {
  const [chart, setChart] = useState<Chart | null>(null);
  const [info, setInfo] = useState<{ title: string; note: string; mesh: number } | null>(null);
  const [problem, setProblem] = useState("");
  const [save, setSave] = useState<Save>("saved");
  const [rev, bump] = useReducer((n: number) => n + 1, 0);
  const [mode, setMode] = useState<Mode>("symbols");
  const [focus, setFocus] = useState(-1);
  const [tool, setTool] = useState<Tool>(null);
  const [zoom, setZoom] = useState(1);
  const [full, setFull] = useState(false);
  const undo = useRef<Change[][]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const stroke = useRef<{ v: 0 | 1 | null; changes: Change[] }>({ v: null, changes: [] });
  const local = useRef<Local | null>(null);
  const data = useRef<SharedChartData | null>(null);
  const timer = useRef(0);
  const KEY = "track:" + id;

  /* ---------- saving: here first, then online ---------- */
  const upload = useCallback(async () => {
    const l = local.current, c = chartRef.current;
    if (!l || !c || l.synced >= l.updated) { setSave(s => (s === "gone" ? s : "saved")); return; }
    setSave("saving");
    try {
      const sent = l.updated;
      const server = await saveSharedProgress(id, c.done, sent, doneCount(c));
      l.synced = Math.max(l.synced, sent);
      await dbPut(KEY, l);
      setSave("saved");
      // another device saved something newer in the meantime: show that
      if (server > sent && l.updated === sent) void refreshRef.current(false);
    } catch (e) {
      const msg = (e as Error).message || "";
      if (/not found/i.test(msg)) setSave("gone");
      else { setSave("offline"); timer.current = window.setTimeout(() => void upload(), 20_000); }
    }
  }, [id, KEY]);

  const chartRef = useRef<Chart | null>(null);
  chartRef.current = chart;
  const refreshRef = useRef<(first: boolean) => Promise<void>>(async () => {});

  const changed = () => {
    const l = local.current, c = chartRef.current;
    if (!l || !c) return;
    l.done = pack(packDone(c.done));
    l.updated = Math.max(Date.now(), l.updated + 1);
    void dbPut(KEY, l);
    setSave("saving");
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void upload(), 1500);
  };

  /* ---------- loading: what's on this device, then the newest from online ---------- */
  const apply = (d: SharedChartData, done: Uint8Array | null, meta: { title: string; note: string }) => {
    data.current = d;
    const c = toChart(d, "shared:" + id);
    if (done) { c.done.set(done); }
    // recount with ticks
    c.pal.forEach(p => { p.done = 0; });
    for (let i = 0; i < c.idx.length; i++) if (c.done[i] && c.idx[i] >= 0) c.pal[c.idx[i]].done++;
    setInfo({ title: meta.title, note: meta.note, mesh: d.mesh });
    setChart(c);
    undo.current = []; setCanUndo(false);
  };

  const refresh = useCallback(async (first: boolean) => {
    let remote;
    try { remote = await fetchShared(id); }
    catch {
      if (first && !local.current) setProblem("Couldn't load your chart. Check your internet connection and reload the page.");
      else setSave("offline");
      return;
    }
    if (!remote) { setSave("gone"); if (!local.current) setProblem("This chart link isn't active. Please contact the shop that sent it."); return; }
    let d: SharedChartData;
    try { d = decodeChart(remote.chart); } catch (e) { setProblem((e as Error).message); return; }
    const l = local.current;
    const remoteUpdated = Number(remote.progress_updated) || 0;
    if (!l || remoteUpdated > l.updated) {
      // online is newer (or this device is new): take it
      const done = decodeProgress(remote.progress, d.W * d.H);
      local.current = { title: remote.title, note: remote.note, mesh: d.mesh, chart: pack(d), done: done ? pack(packDone(done)) : null, updated: remoteUpdated, synced: remoteUpdated };
      await dbPut(KEY, local.current);
      apply(d, done, remote);
    } else {
      // this device has newer ticks: keep them and upload
      l.title = remote.title; l.note = remote.note;
      if (first) apply(d, l.done ? unpackDone(unpack(l.done) as { n: number; bits: Uint8Array }, d.W * d.H) : null, remote);
      else setInfo({ title: remote.title, note: remote.note, mesh: d.mesh });
      if (l.updated > l.synced) void upload(); else setSave("saved");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, KEY, upload]);
  refreshRef.current = refresh;

  useEffect(() => {
    let alive = true;
    (async () => {
      const l = await dbGet<Local>(KEY);
      if (!alive) return;
      if (l?.chart) {
        local.current = l;
        try {
          const d = decodeChart(unpack(l.chart));
          apply(d, l.done ? unpackDone(unpack(l.done) as { n: number; bits: Uint8Array }, d.W * d.H) : null, l);
        } catch { local.current = null; }
      }
      keepStorage();
      await refresh(!local.current);
    })();
    const onVis = () => { if (document.visibilityState === "visible" && !(local.current && local.current.updated > local.current.synced)) void refresh(false); };
    const onOnline = () => { void upload(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", onOnline);
    return () => { alive = false; document.removeEventListener("visibilitychange", onVis); window.removeEventListener("online", onOnline); clearTimeout(timer.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /* ---------- ticking ---------- */
  // a pen's eraser end always unticks
  const strokeStart = (eraser = false) => { stroke.current = { v: eraser ? 0 : null, changes: [] }; };
  const strokeCell = (i: number) => {
    const c = chartRef.current;
    if (!c) return;
    const st = stroke.current;
    if (st.v === null) st.v = c.done[i] ? 0 : 1;
    const ch = tickCell(c, i, st.v);
    if (ch) { st.changes.push(ch); bump(); }
  };
  const strokeEnd = () => {
    if (stroke.current.changes.length) { undo.current.push(stroke.current.changes); setCanUndo(true); changed(); }
    stroke.current = { v: null, changes: [] };
  };
  const strokeCancel = () => {
    const c = chartRef.current;
    if (c && stroke.current.changes.length) { undoChanges(c, stroke.current.changes); bump(); }
    stroke.current = { v: null, changes: [] };
  };
  const doUndo = () => {
    const ch = undo.current.pop(), c = chartRef.current;
    if (!ch || !c) return;
    undoChanges(c, ch);
    setCanUndo(undo.current.length > 0); bump(); changed();
  };
  const markColour = (n: number, v: 0 | 1) => {
    const c = chartRef.current;
    if (!c) return;
    const changes: Change[] = [];
    for (let i = 0; i < c.idx.length; i++) if (c.idx[i] === n) { const ch = tickCell(c, i, v); if (ch) changes.push(ch); }
    if (changes.length) { undo.current.push(changes); setCanUndo(true); bump(); changed(); }
  };
  const zoomBy = (f: number) => setZoom(z => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * f)));
  const toggleFocus = (n: number) => setFocus(f => (f === n ? -1 : n));

  useEffect(() => {
    if (!full) return;
    const root = document.documentElement;
    root.classList.add("fullchart");
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
    window.addEventListener("keydown", onKey);
    return () => { root.classList.remove("fullchart"); window.removeEventListener("keydown", onKey); };
  }, [full]);

  useEffect(() => { if (info?.title) document.title = `${info.title} · CLD Needlepoint`; }, [info?.title]);

  if (problem && !chart) {
    return <div className="wrap tracker"><header className="top"><div><p className="brand">CLD Needlepoint</p><h1>Your chart</h1></div></header><p className="note status">{problem}</p></div>;
  }
  if (!chart || !info) return <div className="wrap tracker"><p className="note" style={{ padding: 40, textAlign: "center" }}>Loading your chart…</p></div>;

  const total = stitchCount(chart), doneN = doneCount(chart);
  const pct = total ? Math.floor((doneN / total) * 100) : 0;
  const saveText = save === "saving" ? "Saving…" : save === "offline" ? "Offline: saved on this device, will upload when you're back online" : save === "gone" ? "This link has been switched off; ticks are only saved on this device" : "Progress saved";

  return (
    <div className="wrap tracker">
      <header className="top">
        <div>
          <p className="brand">CLD Needlepoint</p>
          <h1>{info.title || "Your chart"}</h1>
          {info.note && <p className="sub">{info.note}</p>}
        </div>
      </header>

      <dl className="facts tfacts">
        <dt>Size</dt><dd>{(chart.W / info.mesh).toFixed(2)} × {(chart.H / info.mesh).toFixed(2)} in · {info.mesh} mesh</dd>
        <dt>Stitches</dt><dd>{chart.W} × {chart.H} · {total.toLocaleString()} to stitch</dd>
        <dt>Colours</dt><dd>{chart.pal.length} DMC threads</dd>
      </dl>

      <section className="stage">
        <div className="bar" role="group" aria-label="Chart style">
          {(["symbols", "colour"] as Mode[]).map(m => (
            <button key={m} className="btn" type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>{m === "symbols" ? "Symbol chart" : "Colour chart"}</button>
          ))}
          <span className="spacer" />
          <span className={"note savestate " + save} role="status">{saveText}</span>
        </div>

        <div className={"work" + (full ? " full" : "")}>
          <div className="bar">
            {full && <button className="btn primary" type="button" onClick={() => setFull(false)}>Done</button>}
            <button className="btn" type="button" aria-pressed={tool === "tick"} onClick={() => setTool(t => (t === "tick" ? null : "tick"))}>
              {tool === "tick" ? "Ticking on" : "Tick off stitches"}
            </button>
            <button className="btn" type="button" disabled={!canUndo} onClick={doUndo}>Undo</button>
            <div className="progress">
              <div className="meter"><span style={{ width: pct + "%" }} /></div>
              <span>{pct}% done<span className="ofn"> · {doneN.toLocaleString()} of {total.toLocaleString()} stitches</span></span>
            </div>
            <span className="spacer" />
            <div className="zoom" role="group" aria-label="Zoom">
              <button className="mini" type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.5)}>−</button>
              <input type="range" aria-label="Zoom" min={Math.log2(ZOOM_MIN)} max={Math.log2(ZOOM_MAX)} step={0.05} value={Math.log2(zoom)} onChange={e => setZoom(2 ** +e.target.value)} />
              <button className="mini" type="button" aria-label="Zoom in" onClick={() => zoomBy(1.5)}>+</button>
              <button className="mini" type="button" onClick={() => setZoom(1)}>Fit</button>
            </div>
            {!full && <button className="btn" type="button" onClick={() => setFull(true)}>Full screen</button>}
          </div>
          {!full && <p className="note">{tool === "tick" ? "Tap or drag across stitches to tick them off. Tap a ticked stitch to untick it. Use two fingers to zoom and move around." : "Start at the red X in the centre. Turn on ticking to mark stitches as you go. Pinch to zoom, drag to move around."}</p>}
          {full && <ColourBar pal={chart.pal} focus={focus} onFocus={toggleFocus} />}
          <ChartView
            chart={chart} rev={rev} mode={mode} focus={focus} tool={tool} zoom={zoom} busy={false}
            onZoom={setZoom} onStrokeStart={strokeStart} onCell={strokeCell} onStrokeEnd={strokeEnd} onStrokeCancel={strokeCancel}
          />
        </div>

        <div className="legend">
          <h2>Colours and threads</h2>
          <p className="note">Tap a colour to highlight its stitches. Screen colours are approximate; go by the DMC numbers.</p>
          <div className="lgrid">
            {chart.pal.map((p, n) => {
              const ppct = p.count ? (p.done / p.count) * 100 : 0;
              return (
                <div key={n} className={"lrow" + (focus === n ? " on" : "")} tabIndex={0} role="button" aria-pressed={focus === n}
                  aria-label={`Highlight DMC ${p.thread.code}`} onClick={() => toggleFocus(n)}
                  onKeyDown={e => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggleFocus(n); } }}>
                  <span className="sw" style={{ background: hex(p.rgb), color: inkFor(p.rgb) }}>{p.sym}</span>
                  <div className="linfo">
                    <div className="lhead"><b>DMC {p.thread.code}</b><span className="mono">{p.count.toLocaleString()} st</span></div>
                    <div className="note">{p.thread.name}</div>
                    <div className="lbar"><span style={{ width: ppct + "%" }} /></div>
                    <div className="lfoot">
                      <span className="note">{p.done.toLocaleString()} of {p.count.toLocaleString()} done</span>
                      <span className="btns">
                        <button className="mini" type="button" onClick={e => { e.stopPropagation(); markColour(n, 1); }}>Tick all</button>
                        <button className="mini" type="button" onClick={e => { e.stopPropagation(); markColour(n, 0); }}>Clear</button>
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="credit">Thread colour data: craft-color-codes by <a href="https://makebead.com/" target="_blank" rel="noopener">MakeBead</a>, CC BY 4.0. DMC is a trademark of its owner.</p>
        </div>
      </section>
    </div>
  );
}
