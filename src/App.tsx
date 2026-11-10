import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { DEFAULT_SETTINGS, exactChart, stitchSize, syncedHeight, syncedWidth, type Crop, type Settings } from "./lib/chart";
import { threadByCode } from "./lib/dmc";
import type { RGB } from "./lib/color";
import { computeRegion, drawRegion } from "./lib/image";
import { applyMask, findSubject, type Mask } from "./lib/cutout";
import { renderExport, type Chart, type Mode } from "./lib/render";
import { dbGet, dbPut, keepStorage } from "./lib/storage";
import { deleteChart, getChart, listCharts, metaFor, newId, saveChart, touchChart, updateChart, type ChartMeta } from "./lib/library";
import { startSync, syncLabel, type SyncState } from "./lib/sync";
import Account from "./components/Account";
import SendToCustomer from "./components/SendToCustomer";
import Library from "./components/Library";
import { makeBackup, openBackup } from "./lib/backup";
import { parseStitchly, stitchlyPicture } from "./lib/stitchly";
import { buildInWorker } from "./lib/workerClient";
import EmptyState from "./components/EmptyState";
import PicturePanel from "./components/PicturePanel";
import SettingsPanel, { type Form } from "./components/SettingsPanel";
import ChartView, { ZOOM_MAX, ZOOM_MIN, type Tool } from "./components/ChartView";
import BrushBar from "./components/BrushBar";
import ColourBar from "./components/ColourBar";
import { ERASER, addColour, paintCell, recount, tickCell, undoChanges, type Change } from "./lib/edit";
import Legend from "./components/Legend";
import CropPanel from "./components/CropPanel";
import ExportPanel from "./components/ExportPanel";

// Studio-only extras: in the public build __STUDIO__ is false, so these imports are dropped entirely
const PrintToCanvas = __STUDIO__ ? lazy(() => import("./components/PrintToCanvas")) : null;
const DesignWithClaude = __STUDIO__ ? lazy(() => import("./components/DesignWithClaude")) : null;

type Step = "design" | "stitch" | "share";
const savedStep = (): Step => { try { const v = localStorage.getItem("step"); return v === "stitch" || v === "share" ? v : "design"; } catch { return "design"; } };

const UPLOAD_HINT = "JPG, PNG or WebP, or a Stitchly pattern (.stitchly). Pictures on a plain white background work best.";
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
  /** shown under the picture's name, e.g. after opening a Stitchly pattern */
  const [picNote, setPicNote] = useState("");
  const [chart, setChart] = useState<Chart | null>(null);
  // ticks and colour edits change the chart in place; bumping this redraws
  const [rev, bump] = useReducer((n: number) => n + 1, 0);
  const [busy, setBusy] = useState(false);
  const [mode, setModeState] = useState<Mode>("symbols");
  const [focus, setFocus] = useState(-1);
  const [tool, setTool] = useState<Tool>(null);
  const [brush, setBrush] = useState(0);
  const stroke = useRef<{ v: 0 | 1 | null; changes: Change[]; erase?: boolean }>({ v: null, changes: [] });
  const [brushSize, setBrushSize] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [full, setFull] = useState(false);
  const [cropOpen, setCropOpen] = useState(false);
  const [exported, setExported] = useState<{ url: string; note: string; kind: Mode } | null>(null);
  const [step, setStep] = useState<Step>(savedStep);
  const [designOpen, setDesignOpen] = useState(false);
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
  const currentRef = useRef<string | null>(null);
  currentRef.current = currentId;

  /* ---------- account and syncing ---------- */
  const [email, setEmail] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<SyncState>("signed-out");
  const [syncNote, setSyncNote] = useState("");
  const [showAcct, setShowAcct] = useState(false);
  const [linksReload, bumpLinks] = useReducer((n: number) => n + 1, 0);
  const remoteRef = useRef<(ids: string[]) => void>(() => {});
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
  /** A Stitchly pattern becomes an exact one-pixel-per-stitch picture, with settings that rebuild it stitch for stitch. */
  const stitchlyRef = useRef<(f: File) => Promise<void>>(async () => {});
  stitchlyRef.current = async (f: File) => {
    try {
      const pic = stitchlyPicture(parseStitchly(await f.text()));
      const c = document.createElement("canvas"); c.width = pic.W; c.height = pic.H;
      c.getContext("2d")!.putImageData(new ImageData(pic.rgba, pic.W, pic.H), 0, 0);
      const blob = await new Promise<Blob | null>(r => c.toBlob(r, "image/png"));
      if (!blob) throw new Error("Couldn't turn the pattern into a picture.");
      const note = pic.approx.length
        ? `Opened from Stitchly exactly: same stitches, threads and symbols. DMC ${pic.approx.join(" and ")} ${pic.approx.length > 1 ? "are variegated threads, shown" : "is a variegated thread, shown"} in an in-between colour.`
        : "Opened from Stitchly exactly: same stitches, DMC threads and symbols.";
      openFile(new File([blob], f.name.replace(/\.stitchly$/i, ".png"), { type: "image/png" }), pic.settings, null, note);
    } catch (e) { setUploadMsg((e as Error).message || "Couldn't open that Stitchly file."); }
  };

  const openFile = useCallback((f: File | undefined, saved?: Settings, id: string | null = null, note = "") => {
    if (f && /\.stitchly$/i.test(f.name)) { void stitchlyRef.current(f); return; }
    if (!f || !(f.type || "").startsWith("image/")) { setUploadMsg("That file isn't a picture. Try a JPG, PNG or WebP, or a Stitchly pattern."); return; }
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      const name = f.name || "Pasted picture";
      setPic(old => { if (old) URL.revokeObjectURL(old.url); return { img, file: f, url, name }; });
      setForm(cur => saved ? toForm({ ...DEFAULT_SETTINGS, ...saved }) : { ...cur, win: "5", crop: { x: 0, y: 0, w: 1, h: 1 }, exact: undefined });
      setUploadMsg(UPLOAD_HINT);
      setPicNote(note);
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
      const built = s.exact
        ? exactChart(px, W, H, s.exact) // exactly as designed: no colour picking or matching
        : await buildInWorker(px, W, H, { rm: s.rm, thr: s.thr, k: s.k, con: s.con, sat: s.sat, dmc: s.dmc });
      if (seq !== buildSeq.current) return; // settings changed meanwhile
      const key = JSON.stringify(s.exact
        ? [pic.file.name, pic.file.size, W, H, "exact"]
        : [pic.file.name, pic.file.size, W, H, s.cutout, s.rm, s.thr, s.trim, s.lock, s.k, s.con, s.sat, s.dmc, s.crop]);
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
  }, [pic, source, region, W, H, s.cutout, s.lock, s.rm, s.thr, s.trim, s.k, s.con, s.sat, s.dmc, s.crop, s.exact]);

  /* ---------- progress ---------- */
  const saveTimer = useRef(0);
  const saveProgress = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      if (!chart) return;
      const id = currentRef.current;
      dbPut("prog:" + chart.key, { done: chart.done, idx: chart.idx, edits: chart.pal.map(p => ({ rgb: p.rgb, code: p.thread.code, sym: p.sym })) } satisfies SavedProgress)
        .then(() => { if (id) touchChart(id); });
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

  /* ---------- backup files ---------- */
  const [backupMsg, setBackupMsg] = useState("");
  const backupChart = async (id: string) => {
    try {
      // write the open chart's latest ticks straight away rather than waiting for the autosave
      if (id === currentId && chart) {
        clearTimeout(saveTimer.current);
        await dbPut("prog:" + chart.key, { done: chart.done, idx: chart.idx, edits: chart.pal.map(p => ({ rgb: p.rgb, code: p.thread.code, sym: p.sym })) } satisfies SavedProgress);
      }
      const { blob, fileName } = await makeBackup(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = fileName;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setBackupMsg(`Backup made: “${fileName}”. On iPad it goes to Files → Downloads.`);
    } catch (e) { setBackupMsg((e as Error).message || "Couldn't make the backup."); }
  };
  const openBackupFile = async (f: File) => {
    try {
      const id = await openBackup(f);
      await refreshLibrary();
      setBackupMsg("Backup opened and added to My charts.");
      await openSaved(id);
    } catch (e) { setBackupMsg((e as Error).message || "Couldn't open that backup."); }
  };

  const openSaved = async (id: string) => {
    const saved = await getChart(id);
    if (!saved) { refreshLibrary(); return; }
    const f = saved.file instanceof File ? saved.file : new File([saved.file], saved.fileName, { type: saved.fileType });
    openFile(f, saved.settings, id);
    setShowLib(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // another device changed charts: refresh the list, and reload the open chart if it was one of them
  remoteRef.current = async (ids: string[]) => {
    await refreshLibrary();
    const id = currentRef.current;
    if (!id || !ids.includes(id)) return;
    const saved = await getChart(id);
    if (!saved) { setCurrentId(null); dbPut("currentId", null); return; }
    const f = saved.file instanceof File ? saved.file : new File([saved.file], saved.fileName, { type: saved.fileType });
    openFile(f, saved.settings, id);
  };
  useEffect(() => {
    startSync({
      onUser: setEmail,
      onState: (st, note) => { setSyncState(st); if (note !== undefined || st === "signed-out") setSyncNote(note ?? ""); },
      onRemote: ids => remoteRef.current(ids),
    });
  }, []);

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
  /** `eraser`: the stroke is from a pen's eraser end (repaints to background, or unticks) */
  const strokeStart = (eraser = false) => { stroke.current = { v: eraser ? 0 : null, changes: [], erase: eraser }; };
  const strokeCell = (i: number) => {
    if (!chart) return;
    const st = stroke.current;
    let any = false;
    if (tool === "paint") {
      // the brush covers a square of brushSize × brushSize stitches centred on the touch
      const k = st.erase ? ERASER : brush;
      const x0 = (i % chart.W) - Math.floor((brushSize - 1) / 2), y0 = Math.floor(i / chart.W) - Math.floor((brushSize - 1) / 2);
      for (let y = Math.max(0, y0); y < Math.min(chart.H, y0 + brushSize); y++) {
        for (let x = Math.max(0, x0); x < Math.min(chart.W, x0 + brushSize); x++) {
          const ch = paintCell(chart, y * chart.W + x, k);
          if (ch) { st.changes.push(ch); any = true; }
        }
      }
    } else {
      // the first stitch a stroke touches decides whether the stroke ticks or unticks
      if (st.v === null) st.v = chart.done[i] ? 0 : 1;
      const ch = tickCell(chart, i, st.v);
      if (ch) { st.changes.push(ch); any = true; }
    }
    if (any) bump();
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

  const makeExport = (m: Mode) => {
    if (!chart) return;
    const url = renderExport(chart, m, s.mesh);
    const note = m === "print"
      ? `Print at ${(chart.W / s.mesh).toFixed(2)} × ${(chart.H / s.mesh).toFixed(2)} in, actual size.`
      : "It includes the legend with DMC threads and leaves out your ticks.";
    setExported({ url, note, kind: m });
  };

  const goStep = (st: Step) => {
    setStep(st); setFull(false); setTool(null);
    try { localStorage.setItem("step", st); } catch { /* private mode */ }
  };
  const onStitch = step === "stitch";

  const hint = !chart ? "" : mode === "print"
    ? `Plain pixel version, ${(chart.W / s.mesh).toFixed(2)} × ${(chart.H / s.mesh).toFixed(2)} in. Save or print it from Share & print.`
    : tool === "paint" ? "Choose a colour below, then tap or drag over squares to repaint them. The eraser leaves squares unstitched. Undo puts them back. Use two fingers to zoom and move around; Full screen gives you more room."
    : !onStitch && s.exact ? "This pattern is exactly as designed. Fix stitches repaints single squares. When it looks right, go to Stitch."
    : !onStitch ? "Adjust the picture and settings on the left; the chart updates as you go. Fix stitches repaints single squares. When it looks right, go to Stitch."
    : tool === "tick" ? "Tap or drag across stitches to tick them off. Tap a ticked stitch to untick it. Use two fingers to zoom and move around."
    : "Start at the red X in the centre. Turn on ticking to mark stitches as you paint them. Pinch to zoom, drag to move around.";

  const baseName = (pic?.name ?? "chart").replace(/\.[^.]+$/, "");

  const openDesigned = (f: File, settings: Settings, note: string) => {
    setDesignOpen(false);
    openFile(f, settings, null, note);
    goStep("design");
  };

  const chartArea = (
    <div className={"work" + (full ? " full" : "")}>
      <div className="bar">
        {full && <button className="btn primary" type="button" onClick={() => setFull(false)}>Done</button>}
        <div className="seg" role="group" aria-label="Chart style">
          {(["symbols", "colour", "print"] as Mode[]).map(m => (
            <button key={m} className="btn" type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m === "symbols" ? "Symbols" : m === "colour" ? "Colour" : "Print version"}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <div className="zoom" role="group" aria-label="Zoom">
          <button className="mini" type="button" aria-label="Zoom out" disabled={!chart} onClick={() => zoomBy(1 / 1.5)}>−</button>
          <input type="range" aria-label="Zoom" min={Math.log2(ZOOM_MIN)} max={Math.log2(ZOOM_MAX)} step={0.05} value={Math.log2(zoom)} onChange={e => setZoom(2 ** +e.target.value)} />
          <button className="mini" type="button" aria-label="Zoom in" disabled={!chart} onClick={() => zoomBy(1.5)}>+</button>
          <button className="mini" type="button" disabled={!chart} onClick={() => setZoom(1)}>Fit</button>
        </div>
        {!full && <button className="btn" type="button" disabled={!chart} onClick={() => setFull(true)}>Full screen</button>}
      </div>
      {!onStitch && (
        <div className="bar">
          <button className="btn" type="button" aria-pressed={tool === "paint"} disabled={mode === "print" || !chart} onClick={() => pickTool("paint")}>
            {tool === "paint" ? "Fixing on" : "Fix stitches"}
          </button>
          <button className="btn" type="button" disabled={!canUndo} onClick={doUndo}>Undo</button>
        </div>
      )}
      {onStitch && (
        <div className="bar">
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
        </div>
      )}
      {!full && <p className="note">{hint}</p>}
      {tool === "paint" && chart && <BrushBar pal={chart.pal} brush={brush} onBrush={setBrush} onAdd={newColour} size={brushSize} onSize={setBrushSize} />}
      {full && tool !== "paint" && chart && mode !== "print" && <ColourBar pal={chart.pal} focus={focus} onFocus={toggleFocus} />}
      {chart ? (
        <ChartView
          chart={chart} rev={rev} mode={mode} focus={focus} tool={onStitch || tool === "paint" ? tool : null} zoom={zoom} busy={busy || !source}
          onZoom={setZoom}
          brushSize={tool === "paint" ? brushSize : 1}
          onStrokeStart={strokeStart}
          onCell={strokeCell}
          onStrokeEnd={strokeEnd}
          onStrokeCancel={strokeCancel}
        />
      ) : <div className="viewer busy"><p className="note">{cutStatus || "Making your chart…"}</p></div>}
    </div>
  );

  const legend = chart && (
    <Legend
      chart={chart}
      focus={focus}
      onFocus={toggleFocus}
      onEdit={() => { bump(); saveProgress(); }}
      onMark={markColour}
      onClearAll={clearAll}
    />
  );

  return (
    <div className={"wrap" + (__STUDIO__ ? " studio" : "")}>
      <header className="top">
        <div>
          <h1>Canvas <em>Chart</em> Maker{__STUDIO__ && <span className="studio-badge" title="Runs only on this computer (npm run studio). The public site doesn't have these extras.">Studio · this computer only</span>}</h1>
          <p className="sub">Turn a picture into a needlepoint chart sized in inches, with stitch symbols, DMC thread matches, a marked centre, a print version and a checklist you tick off as you paint.</p>
        </div>
        <div className="btns topbtns">
          <button className="btn" type="button" aria-pressed={showLib} onClick={() => { setShowLib(v => !v); setShowAcct(false); }}>My charts{library.length ? ` (${library.length})` : ""}</button>
          <button className={"btn acct " + syncState} type="button" aria-pressed={showAcct} onClick={() => { setShowAcct(v => !v); setShowLib(false); }} title={email ? `${email} · ${syncLabel(syncState)}` : undefined}>
            {email ? <><span className="dot" aria-hidden="true" />{syncState === "syncing" ? "Syncing…" : syncState === "synced" ? "Synced" : syncState === "offline" ? "Offline" : "Account"}</> : "Sign in"}
          </button>
        </div>
      </header>

      {showAcct && (
        <Account
          email={email}
          state={syncState}
          note={syncNote}
          onClose={() => setShowAcct(false)}
          onSignedOut={() => location.reload()}
          linksReload={linksReload}
        />
      )}

      {showLib && (
        <Library
          charts={library}
          currentId={currentId}
          onOpen={openSaved}
          onRename={(id, name) => updateChart(id, { meta: { name } }).then(refreshLibrary)}
          onDelete={removeSaved}
          onBackup={backupChart}
          onOpenBackup={openBackupFile}
          backupMsg={backupMsg}
          onClose={() => setShowLib(false)}
        />
      )}

      <input ref={fileInput} type="file" accept="image/*,.stitchly" hidden onChange={e => { openFile(e.target.files?.[0]); e.target.value = ""; }} />

      {pic && (
        <nav className="steps-nav" aria-label="Steps">
          {([["design", "1", "Design"], ["stitch", "2", "Stitch"], ["share", "3", "Share & print"]] as [Step, string, string][]).map(([id, n, label]) => (
            <button key={id} type="button" className="step" aria-current={step === id ? "page" : undefined} disabled={id !== "design" && !chart} onClick={() => goStep(id)}>
              <span className="n">{n}</span>{label}
            </button>
          ))}
        </nav>
      )}

      {DesignWithClaude && designOpen && (
        <Suspense fallback={<p className="note">Loading…</p>}>
          <DesignWithClaude mesh={s.mesh} onUse={openDesigned} onClose={() => setDesignOpen(false)} />
        </Suspense>
      )}

      {(!pic || step === "design") && (
        <div className="grid">
          <aside className="rail" aria-label="Chart settings">
            <PicturePanel
              picture={pic && (s.cutout && cut?.pic === pic ? { ...pic, url: cut.url, cutout: true } : pic)}
              message={uploadMsg}
              note={picNote}
              onPick={() => fileInput.current?.click()}
              onFile={f => openFile(f)}
              onCrop={s.exact ? undefined : () => setCropOpen(true)}
              savedName={library.find(m => m.id === currentId)?.name ?? null}
              canSave={!!chart}
              onSave={() => saveToLibrary(false)}
              onSaveCopy={() => saveToLibrary(true)}
            />
            {__STUDIO__ && !designOpen && (
              <button className="btn studio-btn" type="button" onClick={() => setDesignOpen(true)}>Design with Claude <span className="studio-tag">Studio</span></button>
            )}
            {pic && (s.exact ? (
              <div className="group">
                <span className="label">Exact pattern</span>
                <p className="note">Opened exactly as designed: {W} × {H} stitches, {s.exact.length} threads, with its own symbols. The picture settings are off so nothing gets reconverted. Use Fix stitches to change squares.</p>
                <div className="row">
                  <label htmlFor="exact-mesh">Canvas mesh</label>
                  <select id="exact-mesh" value={s.mesh} onChange={e => {
                    const m = +e.target.value;
                    setForm(f => ({ ...f, mesh: m, win: String(+(W / m).toFixed(4)), hin: String(+(H / m).toFixed(4)) }));
                  }}>
                    {[10, 12, 13, 14, 18].map(m => <option key={m} value={m}>{m} mesh</option>)}
                  </select>
                </div>
                <p className="note">Finished size {(W / s.mesh).toFixed(2)} × {(H / s.mesh).toFixed(2)} in.</p>
              </div>
            ) : <SettingsPanel form={form} update={update} size={size} chart={chart} cutStatus={cutStatus} />)}
          </aside>

          <section className="stage">
            {!pic ? <EmptyState /> : (
              <>
                {cropOpen && (
                  <CropPanel
                    img={pic.img}
                    crop={form.crop}
                    onApply={(c: Crop) => { setCropOpen(false); setForm(f => ({ ...f, crop: c })); }}
                    onCancel={() => setCropOpen(false)}
                  />
                )}
                {chartArea}
                {legend}
              </>
            )}
          </section>
        </div>
      )}

      {pic && step === "stitch" && (
        <section className="stage wide">
          {chartArea}
          {legend}
        </section>
      )}

      {pic && step === "share" && chart && (
        <section className="stage wide share">
          <div className="library">
            <div className="bar"><h2>Image to save</h2></div>
            <p className="note">A picture of the chart to print, keep or send. Chart images include the DMC thread list; the print version is the plain pixel picture to print at {(chart.W / s.mesh).toFixed(2)} × {(chart.H / s.mesh).toFixed(2)} in, actual size.</p>
            <div className="btns">
              <button className="btn" type="button" onClick={() => makeExport("symbols")}>Symbol chart</button>
              <button className="btn" type="button" onClick={() => makeExport("colour")}>Colour chart</button>
              <button className="btn" type="button" onClick={() => makeExport("print")}>Print version</button>
            </div>
          </div>
          {exported && (
            <ExportPanel
              url={exported.url}
              note={exported.note}
              fileName={`${baseName}-${exported.kind === "print" ? "print" : exported.kind === "colour" ? "colour-chart" : "chart"}.png`}
              onClose={() => setExported(null)}
            />
          )}
          <SendToCustomer
            chart={chart}
            mesh={s.mesh}
            defaultTitle={library.find(m => m.id === currentId)?.name ?? baseName}
            signedIn={!!email}
            onSignIn={() => { setShowAcct(true); setShowLib(false); window.scrollTo({ top: 0, behavior: "smooth" }); }}
            onCreated={bumpLinks}
          />
          {PrintToCanvas && (
            <Suspense fallback={<p className="note">Loading…</p>}>
              <PrintToCanvas chart={chart} mesh={s.mesh} baseName={baseName} />
            </Suspense>
          )}
        </section>
      )}
    </div>
  );
}
