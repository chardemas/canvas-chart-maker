import { threadLabel } from "../lib/dmc";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Chart } from "../lib/render";
import type { Look } from "../lib/listingPhoto";
import type { ListingReply, ListingRequest } from "../worker/listingPhoto.worker";
import { backingPdf } from "../lib/pdf";
import { zip } from "../lib/zip";
import ListingText from "./ListingText";

/**
 * Studio only: consistent Etsy listing photos from a scan of the printed canvas lying loose on the dark
 * backing sheet. Main photo (cut out, holes see-through, on your background), a close-up of the mesh,
 * and an info card made from the chart. All 3000 × 2250 (4:3) JPEGs.
 */
interface Props { chart: Chart; mesh: number; baseName: string }

const OUT_W = 3000, OUT_H = 2250;
const BACKGROUNDS = [
  { name: "Warm neutral", hex: "#EFE9E3" },
  { name: "Soft white", hex: "#F7F5F2" },
  { name: "Light grey", hex: "#E6E6E4" },
  { name: "Blush", hex: "#F3E3E5" },
];
const saved = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const keep = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

let worker: Worker | null = null, nextId = 0;
const waiting = new Map<number, { ok: (r: ListingReply) => void; fail: (e: Error) => void; progress?: (t: string) => void }>();
type Req = ListingRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;
function ask(req: Req, progress?: (t: string) => void): Promise<ListingReply> {
  if (!worker) {
    worker = new Worker(new URL("../worker/listingPhoto.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<ListingReply>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      if (e.data.type === "progress") { w.progress?.(e.data.text); return; }
      waiting.delete(e.data.id);
      if (e.data.type === "error") w.fail(new Error(e.data.message)); else w.ok(e.data);
    };
  }
  const id = ++nextId;
  return new Promise((ok, fail) => { waiting.set(id, { ok, fail, progress }); worker!.postMessage({ ...req, id }); });
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const toJpeg = (c: HTMLCanvasElement) => new Promise<Blob>((ok, fail) => c.toBlob(b => (b ? ok(b) : fail(new Error("Couldn't save the photo."))), "image/jpeg", 0.92));

function frame(bg: string) {
  const c = document.createElement("canvas"); c.width = OUT_W; c.height = OUT_H;
  const g = c.getContext("2d")!; g.fillStyle = bg; g.fillRect(0, 0, OUT_W, OUT_H);
  return { c, g };
}

/** Main photo: the canvas centred with even margins and a soft shadow, so it reads as a real object. */
function drawMain(img: ImageBitmap, bg: string) {
  const { c, g } = frame(bg);
  const s = Math.min((OUT_W * 0.8) / img.width, (OUT_H * 0.84) / img.height);
  const w = img.width * s, h = img.height * s;
  g.shadowColor = "rgba(60, 40, 30, 0.22)"; g.shadowBlur = 36; g.shadowOffsetY = 14;
  g.imageSmoothingQuality = "high";
  g.drawImage(img, (OUT_W - w) / 2, (OUT_H - h) / 2, w, h);
  return c;
}

/** Close-up: fills the frame, so the colour sitting on each thread crossing is easy to see. */
function drawCloseup(img: ImageBitmap, bg: string) {
  const { c, g } = frame(bg);
  const s = Math.max(OUT_W / img.width, OUT_H / img.height);
  g.imageSmoothingQuality = "high";
  g.drawImage(img, (OUT_W - img.width * s) / 2, (OUT_H - img.height * s) / 2, img.width * s, img.height * s);
  return c;
}

/** Info card from the chart: size, mesh, stitches and the DMC threads, in the app's fonts. */
function drawInfo(chart: Chart, mesh: number, title: string, bg: string) {
  const { c, g } = frame(bg);
  const ink = "#2b1c22", muted = "#7a6a70";
  g.fillStyle = ink; g.textBaseline = "alphabetic";
  g.font = `400 200px Gloock, Georgia, serif`;
  g.fillText(title, 200, 400, OUT_W - 400);
  g.font = `500 96px Figtree, system-ui, sans-serif`; g.fillStyle = muted;
  const used = chart.pal.filter(p => p.count > 0).sort((a, b) => b.count - a.count);
  const facts = [
    `${(chart.W / mesh).toFixed(1)} × ${(chart.H / mesh).toFixed(1)} in`,
    `${mesh} mesh`,
    `${chart.W} × ${chart.H} stitches`,
    `${used.length} thread colours`,
  ];
  g.fillText(facts.join("  ·  "), 200, 570, OUT_W - 400);
  g.fillStyle = "#e3d6da"; g.fillRect(200, 680, OUT_W - 400, 5);
  const cols = used.length > 16 ? 3 : 2, perCol = Math.ceil(used.length / cols), rowH = Math.min(200, Math.floor(1350 / Math.max(perCol, 1)));
  const colW = (OUT_W - 400) / cols;
  used.forEach((p, i) => {
    const x = 200 + Math.floor(i / perCol) * colW, y = 880 + (i % perCol) * rowH, r = Math.round(rowH * 0.3);
    g.fillStyle = `rgb(${p.rgb.join(",")})`;
    g.beginPath(); g.arc(x + r, y - r * 0.6, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "rgba(43,28,34,.25)"; g.lineWidth = 3; g.stroke();
    g.fillStyle = ink; g.font = `600 ${Math.round(rowH * 0.42)}px Figtree, system-ui, sans-serif`;
    g.fillText(threadLabel(p.thread), x + r * 2 + 36, y, colW * 0.3);
    g.fillStyle = muted; g.font = `400 ${Math.round(rowH * 0.36)}px Figtree, system-ui, sans-serif`;
    g.fillText(p.thread.name, x + r * 2 + 36 + colW * 0.3, y, colW * 0.62 - r * 2 - 60);
  });
  return c;
}

export default function ListingPhotos({ chart, mesh, baseName }: Props) {
  const [bg, setBg] = useState(() => saved("listingBg", BACKGROUNDS[0].hex));
  const [look, setLook] = useState<Look>(() => ({ brightness: +saved("listingBright", "0.03"), vibrance: +saved("listingVib", "0.25") }));
  const [title, setTitle] = useState(baseName);
  const [photo, setPhoto] = useState<ImageBitmap | null>(null);
  const [closeup, setCloseup] = useState<ImageBitmap | null>(null);
  const [box, setBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [spot, setSpot] = useState<{ x: number; y: number } | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const mainCv = useRef<HTMLCanvasElement>(null), closeCv = useRef<HTMLCanvasElement>(null), infoCv = useRef<HTMLCanvasElement>(null);
  const opened = useRef(false);

  const openScan = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setError(""); setPhoto(null); setCloseup(null);
    try {
      const r = await ask({ type: "open", file, mesh, look }, setStatus);
      if (r.type !== "photo") return;
      setPhoto(r.image); setBox(r.box); opened.current = true;
      setSpot({ x: r.box.x + r.box.w / 2, y: r.box.y + r.box.h / 2 });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); setStatus(""); }
  };

  // colour changes redo the photo (debounced), and the close-up follows the chosen spot
  useEffect(() => {
    keep("listingBright", String(look.brightness)); keep("listingVib", String(look.vibrance));
    if (!opened.current) return;
    const t = setTimeout(() => { ask({ type: "look", look }).then(r => { if (r.type === "photo") setPhoto(r.image); }).catch(e => setError((e as Error).message)); }, 250);
    return () => clearTimeout(t);
  }, [look]);
  useEffect(() => {
    if (!spot || !opened.current) return;
    ask({ type: "closeup", x: spot.x, y: spot.y, look }).then(r => { if (r.type === "closeup") setCloseup(r.image); }).catch(e => setError((e as Error).message));
  }, [spot, look]);
  useEffect(() => keep("listingBg", bg), [bg]);

  const show = (cv: HTMLCanvasElement | null, src: HTMLCanvasElement) => {
    if (!cv) return;
    cv.width = 600; cv.height = 450;
    const g = cv.getContext("2d")!; g.imageSmoothingQuality = "high"; g.drawImage(src, 0, 0, 600, 450);
  };
  useEffect(() => { if (photo) show(mainCv.current, drawMain(photo, bg)); }, [photo, bg]);
  useEffect(() => { if (closeup) show(closeCv.current, drawCloseup(closeup, bg)); }, [closeup, bg]);
  const infoKey = useMemo(() => [title, bg, mesh, chart.W, chart.H, chart.pal.map(p => p.thread.code + p.count).join()].join("|"), [title, bg, mesh, chart]);
  useEffect(() => {
    let live = true;
    document.fonts.load("400 40px Gloock").catch(() => {}).finally(() => { if (live) show(infoCv.current, drawInfo(chart, mesh, title, bg)); });
    return () => { live = false; };
  }, [infoKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // tap the main photo to choose where the close-up is taken (small turns ignored; it's only a pointer)
  const pickSpot = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!photo || !box) return;
    const r = e.currentTarget.getBoundingClientRect();
    const s = Math.min((OUT_W * 0.8) / photo.width, (OUT_H * 0.84) / photo.height);
    const px = ((e.clientX - r.left) / r.width) * OUT_W, py = ((e.clientY - r.top) / r.height) * OUT_H;
    const fx = (px - (OUT_W - photo.width * s) / 2) / (photo.width * s), fy = (py - (OUT_H - photo.height * s) / 2) / (photo.height * s);
    if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return;
    setSpot({ x: box.x + fx * box.w, y: box.y + fy * box.h });
  };

  const name = (title.trim() || baseName).replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
  const files = async () => {
    const out: { name: string; c: HTMLCanvasElement }[] = [];
    if (photo) out.push({ name: `${name}-1-main.jpg`, c: drawMain(photo, bg) });
    if (closeup) out.push({ name: `${name}-2-closeup.jpg`, c: drawCloseup(closeup, bg) });
    await document.fonts.load("400 40px Gloock").catch(() => {});
    out.push({ name: `${name}-3-info.jpg`, c: drawInfo(chart, mesh, title.trim() || baseName, bg) });
    return out;
  };
  const downloadAll = async () => {
    const list = await files();
    const blobs = await Promise.all(list.map(async f => ({ name: f.name, data: new Uint8Array(await (await toJpeg(f.c)).arrayBuffer()) })));
    download(zip(blobs), `${name}-listing-photos.zip`);
  };

  return (
    <section className="library listingbox" aria-label="Listing photos">
      <div className="bar"><h2>Listing photos</h2><span className="studio-tag">Studio</span></div>
      <p className="note">Matching Etsy photos for every design: the printed canvas cut out on your background, a close-up of the mesh, and an info card from this chart. All 3000 × 2250 px (4:3).</p>
      <ol className="steps">
        <li><b>Print the backing sheet once</b> (Scale 100%) and let it dry. Reuse it for every scan.
          <div className="btns"><button className="btn" type="button" onClick={() => backingPdf().then(b => download(b, "photo-backing.pdf"))}>Download backing sheet</button></div></li>
        <li><b>Lay the printed canvas loose on it</b>: no tape, flat, away from the edges. Close the lid.</li>
        <li><b>Scan the whole page at 600 dpi</b> as a PNG.
          <input ref={fileInput} type="file" accept="image/png,image/jpeg" hidden onChange={e => { void openScan(e.target.files?.[0]); e.target.value = ""; }} />
          <div className="btns"><button className="btn primary" type="button" disabled={busy} onClick={() => fileInput.current?.click()}>{busy ? "Working…" : photo ? "Choose a different scan" : "Choose the scan"}</button></div>
          {status && <p className="note status" role="status">{status}</p>}
        </li>
      </ol>
      {error && <p className="note status" role="alert">{error}</p>}

      <div className="design-size">
        <span className="note">Background</span>
        {BACKGROUNDS.map(b => (
          <button key={b.hex} type="button" className="swatchbtn" aria-pressed={bg.toLowerCase() === b.hex.toLowerCase()} title={b.name} onClick={() => setBg(b.hex)}>
            <span style={{ background: b.hex }} />{b.name}
          </button>
        ))}
        <label>Other <input type="color" value={bg} onChange={e => setBg(e.target.value)} /></label>
      </div>
      <div className="design-size">
        <label>Brightness <input type="range" min={-0.1} max={0.25} step={0.01} value={look.brightness} onChange={e => setLook(l => ({ ...l, brightness: +e.target.value }))} /></label>
        <label>Vibrance <input type="range" min={0} max={0.7} step={0.05} value={look.vibrance} onChange={e => setLook(l => ({ ...l, vibrance: +e.target.value }))} /></label>
        <label>Name on card <input className="txt" value={title} maxLength={60} onChange={e => setTitle(e.target.value)} /></label>
      </div>

      <div className="pc-views">
        <figure><canvas ref={mainCv} className="pc-overview" onClick={pickSpot} />{photo ? <figcaption className="note">1 · Main photo. Tap to choose where the close-up is.</figcaption> : <figcaption className="note">1 · Main photo appears after the scan.</figcaption>}</figure>
        <figure><canvas ref={closeCv} className="pc-overview" /><figcaption className="note">2 · Close-up of the mesh (about 1.2 × 0.9 in)</figcaption></figure>
        <figure><canvas ref={infoCv} className="pc-overview" /><figcaption className="note">3 · Info card from this chart</figcaption></figure>
      </div>
      <div className="btns">
        <button className="btn primary" type="button" onClick={() => void downloadAll()}>Download all (.zip)</button>
        <span className="note">Keep colours honest: buyers compare the canvas to the photo.</span>
      </div>
      <ListingText name={title.trim() || baseName} W={chart.W} H={chart.H} mesh={mesh} />
    </section>
  );
}
