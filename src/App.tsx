import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { DEFAULT_SETTINGS, stitchSize, syncedHeight, syncedWidth, type Crop, type Settings } from "./lib/chart";
import { threadByCode } from "./lib/dmc";
import type { RGB } from "./lib/color";
import { computeRegion, drawRegion } from "./lib/image";
import { applyMask, findSubject, type Mask } from "./lib/cutout";
import { renderExport, type Chart, type Mode } from "./lib/render";
import { dbGet, dbPut, keepStorage } from "./lib/storage";
import { deleteChart, getChart, listCharts, metaFor, newId, saveChart, updateChart, type ChartMeta } from "./lib/library";
import Library from "./components/Library";
import { buildInWorker } from "./lib/workerClient";
import EmptyState from "./components/EmptyState";
import PicturePanel from "./components/PicturePanel";
import SettingsPanel, { type Form } from "./components/SettingsPanel";
import ChartView, { ZOOM_MAX, ZOOM_MIN, type Tool } from "./components/ChartView";
import BrushBar from "./components/BrushBar";
import ColourBar from "./components/ColourBar";
import { addColour, paintCell, recount, tickCell, undoChanges, type Change } from "./lib/edit";
import Legend from "./components/Legend";
import CropPanel from "./components/CropPanel";
import ExportPanel from "./components/ExportPanel";

const UPLOAD_HINT = "JPG, PNG or WebP. Pictures on a plain white background work best.";
const toForm = (s: Settings): Form => ({ ...s, win: String(s.win), hin: String(s.hin) });
const toSettings = (f: Form): Settings => ({ ...f, win: +f.win || 1, hin: +f.hin || 1 });

interface Picture { img: HTMLImageElement; file: File; url: string; name: string }
interface SavedFile { blob: Blob; name: string; type: string }
interface Cut { pic: Picture; canvas: HTMLCanvasElement; url: string }
/** ticks, plus any hand edits: repainted squares (idx) and changed or added colours */
interface SavedProgress { done: Uint8Array; idx?: Int16Array; edits: { rgb: RGB; code: string; sym?: string }[] }

export default function App() {
  const [pic, setPic] = useState<Picture | null>(null);
  const [form, setForm] = useState<Form>(() => toForm(DEFAULT_SETTINGS));
  const [uploadMsg, setUploadMsg] = useState(UPLOAD_HINT);
  const [chart, setChart] = useState<Chart | null>(null);
  // ticks and colour edits change the chart in place; bumping this redraws
  const [rev, bump] = useReducer((n: number) => n + 1, 0);
  const [busy, setBusy] = useState(false);
  const [mode, setModeState] = useState<Mode>("symbols");
  const [focus, setFocus] = useState(-1);
  const [tool, setTool] = useState<Tool>(null);
  const [brush, setBrush] = useState(0);
  const stroke = useRef<{ v: 0 | 1 | null; changes: Change[] }>({ v: null, changes: [] });
  const [zoom, setZoom] = useState(1);
  const [full, setFull] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);
  const [exported, setExported] = useState<{ url: string; note: string } | null>(null);
  const undo = useRef<Change[][]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const buildSeq = useRef(0);

  const s = useMemo(() => toSettings(form), [form]);

  /* ---------- My charts ---------- */
  const [library, setLibrary] = useState<ChartMeta[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [showLib, setShowLib] = useState(false);
  const refreshLibrary = useCallback(() => listCharts().then(setLibrary), []);
  useEffect(() => { refreshLibrary(); }, [refreshLibrary]);

  /* ---------- keep only the subject ---------- */
  const [cut, setCut] = useState<Cut | null>(null);
  const [cutStatus, setCutStatus] = useState("");
  useEffect(() => {
    if (!pic || !s.cutout || cut?.pic === pic) { setCutStatus(""); return; }
    let live = true;
    const maskKey = `mask512:${pic.file.name}:${pic.file.size}`;
    (async () => {
      try {
        let mask = await dbGet<Mask>(maskKey);
        if (!mask) {
          setCutStatus("Finding the subject…");
          mask = await findSubject(pic.img, (stage, pct) => {
            if (live) setCutStatus(stage === "download" ? `Downloading the subject finder… ${pct}%` : "Finding the subject… this can take up to a minute.");
          });
          dbPut(maskKey, mask);
        }
        if (!live) return;
        const canvas = applyMask(pic.img, mask);
        setCut({ pic, canvas, url: canvas.toDataURL("image/png") });
        setCutStatus("");
      } catch (err) {
        console.error(err);
        if (!live) return;
        setCutStatus("Couldn't find the subject in this picture. Check your internet connection for the first download, then try again.");
        setForm(f => ({ ...f, cutout: false }));
      }
    })();
    return () => { live = false; };
  }, [pic, s.cutout, cut]);

  // the picture the chart is made from: the cut-out when that's on (null while it's being made)
  const source = !pic ? null : !s.cutout ? pic.img : cut?.pic === pic ? cut.canvas : null;

  /* ---------- picture loading ---------- */
  const openFile = useCallback((f: File | undefined, saved?: Settings, id: string | null = null) => {
    if (!f || !(f.type || "").startsWith("image/")) { setUploadMsg("That file isn't a picture. Try a JPG, PNG or WebP."); return; }
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      const name = f.name || "Pasted picture";
      setPic(old => { if (old) URL.revokeObjectURL(old.url); return { img, file: f, url, name }; });
      setForm(cur => saved ? toForm({ ...DEFAULT_SETTINGS, ...saved }) : { ...cur, win: "5", crop: { x: 0, y: 0, w: 1, h: 1 } });
      setUploadMsg(UPLOAD_HINT);
      setCropOpen(false); setExported(null);
      dbPut("file", { blob: f, name, type: f.type } satisfies SavedFile);
      setCurrentId(id); dbPut("currentId", id);
    };
    img.onerror = () => { URL.revokeObjectURL(url); setUploadMsg("Couldn't open that picture. Try a JPG, PNG or WebP."); };
    img.src = url;
  }, []);

  // pick up the last picture and its settings, if this browser has them
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    (async () => {
      const saved = await dbGet<SavedFile>("file");
      if (!saved?.blob) return;
      const f = saved.blob instanceof File ? saved.blob : new File([saved.blob], saved.name, { type: saved.type });
      openFile(f, await dbGet<Settings>("settings"), (await dbGet<string | null>("currentId")) ?? null);
    })();
  }, [openFile]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const f = [...(e.clipboardData?.files ?? [])].find(f => f.type.startsWith("image/"));
      if (f) openFile(f);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [openFile]);

  /* ---------- region and size ---------- */
  const region = useMemo(
    () => (source ? computeRegion(source, s.crop, { rm: s.rm, cutout: s.cutout, trim: s.trim, thr: s.thr }) : null),
    [source, s.crop, s.rm, s.cutout, s.trim, s.thr],
  );
  const aspect = region ? region.w / region.h : 1;
  const size = region ? stitchSize(s, aspect) : null;

  // when the picture's shape changes, keep the height in step
  useEffect(() => {
    if (!region) return;
    setForm(f => (f.lock ? { ...f, hin: syncedHeight(+f.win, f.mesh, region.w / region.h) } : f));
  }, [region]);

  const update = (patch: Partial<Form>) => setForm(f => {
    const n = { ...f, ...patch };
    // white parts of a cut-out subject are usually meant to be stitched
    if (patch.cutout) n.rm = false;
    if (n.lock && region) {
      if ("hin" in patch) n.win = syncedWidth(+n.hin, n.mesh, aspect);
      else if ("win" in patch || "mesh" in patch || "lock" in patch) n.hin = syncedHeight(+n.win, n.mesh, aspect);
    }
    return n;
  });

  useEffect(() => { if (pic) dbPut("settings", s); }, [pic, s]);
  // a saved chart keeps its settings up to date while it's open
  useEffect(() => { if (pic && currentId) updateChart(currentId, { settings: s }); }, [pic, currentId, s]);

  /* ---------- build ---------- */
  const W = size?.W ?? 0, H = size?.H ?? 0;
  useEffect(() => {
    if (!pic || !source || !region) return;
    const seq = ++buildSeq.current;
    setBusy(true);
    const t = setTimeout(async () => {
      const px = drawRegion(source, region, W, H, s.lock);
      const built = await buildInWorker(px, W, H, { rm: s.rm, thr: s.thr, k: s.k, con: s.con, sat: s.sat, dmc: s.dmc });
      if (seq !== buildSeq.current) return; // settings changed meanwhile
      const key = JSON.stringify([pic.file.name, pic.file.size, W, H, s.cutout, s.rm, s.thr, s.trim, s.lock, s.k, s.con, s.sat, s.dmc, s.crop]);
      const next: Chart = { ...built, done: new Uint8Array(W * H), key };
      const saved = await dbGet<SavedProgress>("prog:" + key);
      if (seq !== buildSeq.current) return;
      if (saved?.done?.length === next.done.length) next.done.set(saved.done);
      saved?.edits?.forEach((e, i) => {
        const thread = threadByCode(e.code);
        if (i >= next.pal.length) { if (thread) next.pal.push({ rgb: e.rgb, thread, count: 0, done: 0, sym: e.sym ?? "?" }); return; }
        const p = next.pal[i];
        p.rgb = e.rgb; p.thread = thread ?? p.thread;
      });
      if (saved?.idx?.length === next.idx.length && saved.idx.every(k => k < next.pal.length)) next.idx.set(saved.idx);
      recount(next);
      undo.current = []; setCanUndo(false);
      setFocus(-1); setChart(next); setBusy(false);
    }, 200);
    return () => clearTimeout(t);
  }, [pic, source, region, W, H, s.cutout, s.lock, s.rm, s.thr, s.trim, s.k, s.con, s.sat, s.dmc, s.crop]);

  /* ---------- progress ---------- */
  const saveTimer = useRef(0);
  const saveProgress = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      if (!chart) return;
      dbPut("prog:" + chart.key, { done: chart.done, idx: chart.idx, edits: chart.pal.map(p => ({ rgb: p.rgb, code: p.thread.code, sym: p.sym })) } satisfies SavedProgress);
    }, 400);
  }, [chart]);

  // ...and its picture and progress in the list
  useEffect(() => {
    if (!currentId || !chart || busy || !pic) return;
    const [name, size] = JSON.parse(chart.key) as [string, number];
    if (name !== pic.file.name || size !== pic.file.size) return; // still showing the previous picture's chart
    const t = setTimeout(() => { updateChart(currentId, { meta: metaFor(chart, s.mesh) }).then(refreshLibrary); }, 1200);
    return () => clearTimeout(t);
  }, [currentId, chart, rev, busy, pic, s.mesh, refreshLibrary]);

  const saveToLibrary = async (copy: boolean) => {
    if (!pic || !chart) return;
    const id = newId();
    const base = (pic.name).replace(/\.[^.]+$/, "");
    const current = library.find(m => m.id === currentId);
    const name = copy && current ? `${current.name} copy` : base;
    await saveChart(
      { id, file: pic.file, fileName: pic.name, fileType: pic.file.type, settings: s },
      { id, name, updated: Date.now(), ...metaFor(chart, s.mesh) },
    );
    keepStorage();
    setCurrentId(id); dbPut("currentId", id);
    refreshLibrary();
  };

  const openSaved = async (id: string) => {
    const saved = await getChart(id);
    if (!saved) { refreshLibrary(); return; }
    const f = saved.file instanceof File ? saved.file : new File([saved.file], saved.fileName, { type: saved.fileType });
    openFile(f, saved.settings, id);
    setShowLib(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const removeSaved = async (id: string) => {
    await deleteChart(id);
    if (id === currentId) { setCurrentId(null); dbPut("currentId", null); }
    refreshLibrary();
  };

  const pushUndo = (changes: Change[]) => { undo.current.push(changes); setCanUndo(true); bump(); saveProgress(); };

  const doUndo = () => {
    const ch = undo.current.pop();
    if (!ch || !chart) return;
    undoChanges(chart, ch);
    setCanUndo(undo.current.length > 0); bump(); saveProgress();
  };

  const tickWhere = (match: (i: number) => boolean, v: 0 | 1) => {
    if (!chart) return;
    const changes: Change[] = [];
    for (let i = 0; i < chart.idx.length; i++) if (match(i)) { const ch = tickCell(chart, i, v); if (ch) changes.push(ch); }
    if (changes.length) pushUndo(changes);
  };
  const clearAll = () => tickWhere(() => true, 0);
  const markColour = (n: number, v: 0 | 1) => tickWhere(i => chart!.idx[i] === n, v);

  /* ---------- strokes on the chart: tick or repaint ---------- */
  const strokeStart = () => { stroke.current = { v: null, changes: [] }; };
  const strokeCell = (i: number) => {
    if (!chart) return;
    const st = stroke.current;
    let ch: Change | null;
    if (tool === "paint") ch = paintCell(chart, i, brush);
    else {
      // the first stitch a stroke touches decides whether the stroke ticks or unticks
      if (st.v === null) st.v = chart.done[i] ? 0 : 1;
      ch = tickCell(chart, i, st.v);
    }
    if (ch) { st.changes.push(ch); bump(); }
  };
  const strokeCancel = () => {
    if (chart && stroke.current.changes.length) { undoChanges(chart, stroke.current.changes); bump(); }
    stroke.current = { v: null, changes: [] };
  };
  const strokeEnd = () => { if (stroke.current.changes.length) pushUndo(stroke.current.changes); stroke.current = { v: null, changes: [] }; };

  const newColour = (rgb: RGB) => {
    if (!chart) return;
    setBrush(addColour(chart, rgb, s.dmc));
    bump(); saveProgress();
  };
  const pickTool = (t: Tool) => setTool(cur => (cur === t ? null : t));
  const zoomBy = (f: number) => setZoom(z => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * f)));

  // full screen: the chart and its tools cover the page; Esc or "Done" goes back
  useEffect(() => {
    if (!full) return;
    const root = document.documentElement;
    root.classList.add("fullchart");
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
    window.addEventListener("keydown", onKey);
    return () => { root.classList.remove("fullchart"); window.removeEventListener("keydown", onKey); };
  }, [full]);
  useEffect(() => { if (!chart) setFull(false); }, [chart]);

  const total = chart ? chart.pal.reduce((a, p) => a + p.count, 0) : 0;
  const doneCount = chart ? chart.pal.reduce((a, p) => a + p.done, 0) : 0;
  const pct = total ? Math.floor((doneCount / total) * 100) : 0;

  /* ---------- views ---------- */
  const setMode = (m: Mode) => { setModeState(m); if (m === "print") setTool(null); };
  const toggleFocus = (n: number) => { setFocus(f => (f === n ? -1 : n)); if (mode === "print") setMode("symbols"); };

  const makeExport = () => {
    if (!chart) return;
    const url = renderExport(chart, mode, s.mesh);
    const note = mode === "print"
      ? `Print at ${(chart.W / s.mesh).toFixed(2)} × ${(chart.H / s.mesh).toFixed(2)} in, actual size.`
      : "It includes the legend with DMC threads and leaves out your ticks.";
    setExported({ url, note });
  };

  const hint = !chart ? "" : mode === "print"
    ? `Plain pixel version. Use "Make an image to save", then print it at ${(chart.W / s.mesh).toFixed(2)} × ${(chart.H / s.mesh).toFixed(2)} in (actual size, not "fit to page") so each square matches one stitch.`
    : tool === "tick" ? "Tap or drag across stitches to tick them off. Tap a ticked stitch to untick it. Use two fingers to zoom and move around."
    : tool === "paint" ? "Choose a colour below, then tap or drag over squares to repaint them. The eraser leaves squares unstitched. Undo puts them back. Use two fingers to zoom and move around; Full screen gives you more room."
    : "Start at the red X in the centre. Turn on ticking to mark stitches as you paint them. Pinch to zoom, drag to move around.";

  const baseName = (pic?.name ?? "chart").replace(/\.[^.]+$/, "");

  return (
    <div className="wrap">
      <header className="top">
        <div>
          <h1>Canvas <em>Chart</em> Maker</h1>
          <p className="sub">Turn a picture into a needlepoint chart sized in inches, with stitch symbols, DMC thread matches, a marked centre, a print version and a checklist you tick off as you paint.</p>
        </div>
        <button className="btn" type="button" aria-pressed={showLib} onClick={() => setShowLib(v => !v)}>My charts{library.length ? ` (${library.length})` : ""}</button>
      </header>

      {showLib && (
        <Library
          charts={library}
          currentId={currentId}
          onOpen={openSaved}
          onRename={(id, name) => updateChart(id, { meta: { name } }).then(refreshLibrary)}
          onDelete={removeSaved}
          onClose={() => setShowLib(false)}
        />
      )}

      <input ref={fileInput} type="file" accept="image/*" hidden onChange={e => { openFile(e.target.files?.[0]); e.target.value = ""; }} />

      <div className="grid">
        <aside className="rail" aria-label="Chart settings">
          <PicturePanel
            picture={pic && (s.cutout && cut?.pic === pic ? { ...pic, url: cut.url, cutout: true } : pic)}
            message={uploadMsg}
            onPick={() => fileInput.current?.click()}
            onFile={f => openFile(f)}
            onCrop={() => setCropOpen(true)}
            savedName={library.find(m => m.id === currentId)?.name ?? null}
            canSave={!!chart}
            onSave={() => saveToLibrary(false)}
            onSaveCopy={() => saveToLibrary(true)}
          />
          {pic && <SettingsPanel form={form} update={update} size={size} chart={chart} cutStatus={cutStatus} />}
        </aside>

        <section className="stage">
          {!pic ? <EmptyState /> : (
            <>
              <div className="bar" role="group" aria-label="Chart style">
                {(["symbols", "colour", "print"] as Mode[]).map(m => (
                  <button key={m} className="btn" type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
                    {m === "symbols" ? "Symbol chart" : m === "colour" ? "Colour chart" : "Print version"}
                  </button>
                ))}
              </div>

              {cropOpen && (
                <CropPanel
                  img={pic.img}
                  crop={form.crop}
                  onApply={(c: Crop) => { setCropOpen(false); setForm(f => ({ ...f, crop: c })); }}
                  onCancel={() => setCropOpen(false)}
                />
              )}

              <div className={"work" + (full ? " full" : "")}>
              <div className="bar">
                {full && <button className="btn primary" type="button" onClick={() => setFull(false)}>Done</button>}
                <button className="btn" type="button" aria-pressed={tool === "tick"} disabled={mode === "print"} onClick={() => pickTool("tick")}>
                  {tool === "tick" ? "Ticking on" : "Tick off stitches"}
                </button>
                <button className="btn" type="button" aria-pressed={tool === "paint"} disabled={mode === "print" || !chart} onClick={() => pickTool("paint")}>
                  {tool === "paint" ? "Fixing on" : "Fix stitches"}
                </button>
                <button className="btn" type="button" disabled={!canUndo} onClick={doUndo}>Undo</button>
                <div className="progress">
                  <div className="meter"><span style={{ width: pct + "%" }} /></div>
                  <span>{pct}% done<span className="ofn"> · {doneCount.toLocaleString()} of {total.toLocaleString()} stitches</span></span>
                </div>
                <span className="spacer" />
                <div className="zoom" role="group" aria-label="Zoom">
                  <button className="mini" type="button" aria-label="Zoom out" disabled={!chart} onClick={() => zoomBy(1 / 1.5)}>−</button>
                  <input type="range" aria-label="Zoom" min={Math.log2(ZOOM_MIN)} max={Math.log2(ZOOM_MAX)} step={0.05} value={Math.log2(zoom)} onChange={e => setZoom(2 ** +e.target.value)} />
                  <button className="mini" type="button" aria-label="Zoom in" disabled={!chart} onClick={() => zoomBy(1.5)}>+</button>
                  <button className="mini" type="button" disabled={!chart} onClick={() => setZoom(1)}>Fit</button>
                </div>
                {!full && <>
                  <button className="btn" type="button" disabled={!chart} onClick={() => setFull(true)}>Full screen</button>
                  <button className="btn" type="button" disabled={!chart} onClick={makeExport}>Make an image to save</button>
                </>}
              </div>
              {!full && <p className="note">{hint}</p>}
              {tool === "paint" && chart && <BrushBar pal={chart.pal} brush={brush} onBrush={setBrush} onAdd={newColour} />}
              {full && tool !== "paint" && chart && mode !== "print" && <ColourBar pal={chart.pal} focus={focus} onFocus={toggleFocus} />}

              {chart ? (
                <ChartView
                  chart={chart} rev={rev} mode={mode} focus={focus} tool={tool} zoom={zoom} busy={busy || !source}
                  onZoom={setZoom}
                  onStrokeStart={strokeStart}
                  onCell={strokeCell}
                  onStrokeEnd={strokeEnd}
                  onStrokeCancel={strokeCancel}
                />
              ) : <div className="viewer busy"><p className="note">{cutStatus || "Making your chart…"}</p></div>}
              </div>

              {exported && (
                <ExportPanel
                  url={exported.url}
                  note={exported.note}
                  fileName={`${baseName}-${mode === "print" ? "print" : "chart"}.png`}
                  onClose={() => setExported(null)}
                />
              )}

              {chart && (
                <Legend
                  chart={chart}
                  focus={focus}
                  onFocus={toggleFocus}
                  onEdit={() => { bump(); saveProgress(); }}
                  onMark={markColour}
                  onClearAll={clearAll}
                />
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
