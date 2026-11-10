import { useEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS, type Settings } from "../lib/chart";

/**
 * Studio only: describe a design and/or add inspiration photos, and Claude draws a clean, flat design
 * on the stitch grid (one SVG unit per stitch). The request goes to the local Studio server, which holds
 * the API key; nothing here runs on the public site.
 */
interface Props {
  mesh: number;
  onUse: (file: File, settings: Settings, note: string) => void;
  onClose: () => void;
}

interface Photo { name: string; url: string; mediaType: "image/jpeg"; data: string }
interface Result { svg: string; notes: string; W: number; H: number; colours: number; mesh: number }

const MESHES = [10, 12, 13, 14, 18];

/** Shrinks a photo to at most 1568 px on its long side (plenty for Claude to see it) as JPEG. */
async function preparePhoto(f: File): Promise<Photo> {
  const bmp = await createImageBitmap(f);
  const s = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const url = c.toDataURL("image/jpeg", 0.85);
  return { name: f.name, url, mediaType: "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
}

/** The distinct paint colours in the SVG (fills and strokes), as the browser reads them. */
function svgPalette(svg: string): [number, number, number][] {
  const g = document.createElement("canvas").getContext("2d")!;
  const seen = new Map<string, [number, number, number]>();
  for (const m of svg.matchAll(/(?:fill|stroke|stop-color)\s*[:=]\s*["']?\s*([^"';)]+\)?|[^"';\s>]+)/gi)) {
    const v = m[1].trim();
    if (!v || /^(none|transparent|currentcolor|inherit)$/i.test(v) || v.startsWith("url(")) continue;
    g.fillStyle = "#000"; g.fillStyle = v;
    const c = String(g.fillStyle);
    const hex = c.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    const rgba = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    const rgb: [number, number, number] | null = hex ? [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)]
      : rgba && (rgba[4] === undefined || +rgba[4] > 0) ? [+rgba[1], +rgba[2], +rgba[3]] : null;
    if (rgb) seen.set(rgb.join(","), rgb);
  }
  return [...seen.values()];
}

/**
 * The design as stitches: drawn large, shrunk to one pixel per stitch, then every stitch snapped to the
 * nearest colour the design actually uses, so soft edges don't turn into extra in-between threads.
 * Mostly see-through stitches stay unstitched.
 */
function stitchImage(svg: string, W: number, H: number): Promise<{ canvas: HTMLCanvasElement; colours: number }> {
  return new Promise((ok, fail) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const big = document.createElement("canvas");
      big.width = W * 8; big.height = H * 8;
      big.getContext("2d")!.drawImage(img, 0, 0, big.width, big.height);
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      const g = c.getContext("2d", { willReadFrequently: true })!;
      g.imageSmoothingQuality = "high";
      g.drawImage(big, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H), px = d.data;
      const pal = svgPalette(svg), used = new Set<number>();
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] < 128) { px[i + 3] = 0; continue; }
        px[i + 3] = 255;
        if (!pal.length) continue;
        let best = 0, bd = Infinity;
        pal.forEach(([r, gg, b], k) => { const e = (px[i] - r) ** 2 + (px[i + 1] - gg) ** 2 + (px[i + 2] - b) ** 2; if (e < bd) { bd = e; best = k; } });
        [px[i], px[i + 1], px[i + 2]] = pal[best];
        used.add(best);
      }
      g.putImageData(d, 0, 0);
      ok({ canvas: c, colours: used.size });
    };
    img.onerror = () => { URL.revokeObjectURL(url); fail(new Error("The drawing couldn't be shown. Try again.")); };
    img.src = url;
  });
}

export default function DesignWithClaude({ mesh: chartMesh, onUse, onClose }: Props) {
  const [description, setDescription] = useState("");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [win, setWin] = useState("5");
  const [hin, setHin] = useState("5");
  const [mesh, setMesh] = useState(chartMesh);
  const [colours, setColours] = useState(8);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [feedback, setFeedback] = useState("");
  const photoInput = useRef<HTMLInputElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);

  const W = Math.round((+win || 1) * mesh), H = Math.round((+hin || 1) * mesh);
  const sizeOk = W >= 4 && W <= 300 && H >= 4 && H <= 300;

  const addPhotos = async (files: FileList | null) => {
    if (!files) return;
    const added = await Promise.all([...files].filter(f => f.type.startsWith("image/")).map(preparePhoto));
    setPhotos(p => [...p, ...added].slice(0, 4));
  };

  const draw = async (previous?: { svg: string; feedback: string }) => {
    if (!description.trim() && !photos.length) { setError("Describe the design or add a photo first."); return; }
    setBusy(true); setError("");
    try {
      const size = previous && result ? { W: result.W, H: result.H, colours: result.colours, mesh: result.mesh } : { W, H, colours, mesh };
      const res = await fetch("/api/design", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description, images: photos.map(p => ({ mediaType: p.mediaType, data: p.data })), W: size.W, H: size.H, colours: size.colours, previous }),
      });
      const body = await res.json().catch(() => ({ error: `The Studio server answered ${res.status}. Is npm run studio running?` }));
      if (!res.ok) throw new Error(body.error || "Something went wrong.");
      setResult({ svg: body.svg, notes: body.notes, ...size });
      setFeedback("");
    } catch (e) { setError((e as Error).message === "Failed to fetch" ? "Couldn't reach the Studio server. Is npm run studio running?" : (e as Error).message); }
    finally { setBusy(false); }
  };

  // show the result as it will stitch: one square per stitch
  useEffect(() => {
    if (!result || !preview.current) return;
    const cv = preview.current;
    stitchImage(result.svg, result.W, result.H).then(({ canvas: small }) => {
      const z = Math.max(1, Math.floor(480 / Math.max(result.W, result.H)));
      cv.width = result.W * z; cv.height = result.H * z;
      const g = cv.getContext("2d")!;
      g.imageSmoothingEnabled = false;
      g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height);
      g.drawImage(small, 0, 0, cv.width, cv.height);
    }).catch(e => setError((e as Error).message));
  }, [result]);

  const use = async () => {
    if (!result) return;
    const { canvas, colours: used } = await stitchImage(result.svg, result.W, result.H);
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, "image/png"));
    if (!blob) { setError("Couldn't make the picture."); return; }
    const name = (description.trim().split(/\s+/).slice(0, 4).join(" ") || "Claude design").replace(/[^\w\s-]/g, "");
    const settings: Settings = {
      ...DEFAULT_SETTINGS, cutout: false, rm: false, trim: false, lock: true, con: 1, sat: 1, dmc: true,
      mesh: result.mesh, win: +(result.W / result.mesh).toFixed(4), hin: +(result.H / result.mesh).toFixed(4), k: Math.max(2, used || result.colours),
      crop: { x: 0, y: 0, w: 1, h: 1 },
    };
    onUse(new File([blob], `${name}.png`, { type: "image/png" }), settings, "Designed with Claude. Change colours or fix stitches as you like.");
  };

  return (
    <section className="library designbox" aria-label="Design with Claude">
      <div className="bar"><h2>Design with Claude</h2><span className="studio-tag">Studio</span><span className="spacer" /><button className="btn" type="button" onClick={onClose}>Close</button></div>
      <p className="note">Describe a design, add inspiration photos, or both. Claude draws a clean, flat design sized to your canvas, ready to become a chart. Each design takes about a minute.</p>

      <label className="lbl" htmlFor="design-desc">What should it be?</label>
      <textarea id="design-desc" className="txt" rows={3} value={description} maxLength={2000}
        placeholder="A strawberry wearing sunglasses, pink and red palette, with ‘SWEET’ underneath" onChange={e => setDescription(e.target.value)} />

      <div className="btns">
        <input ref={photoInput} type="file" accept="image/*" multiple hidden onChange={e => { void addPhotos(e.target.files); e.target.value = ""; }} />
        <button className="btn" type="button" disabled={photos.length >= 4} onClick={() => photoInput.current?.click()}>Add inspiration photos</button>
        <span className="note">{photos.length ? `${photos.length} of 4` : "Optional, up to 4"}</span>
      </div>
      {photos.length > 0 && (
        <div className="photos">
          {photos.map((p, i) => (
            <figure key={i}><img src={p.url} alt={p.name} /><button className="mini" type="button" aria-label={`Remove ${p.name}`} onClick={() => setPhotos(ps => ps.filter((_, j) => j !== i))}>×</button></figure>
          ))}
        </div>
      )}

      <div className="design-size">
        <label>Width <input className="txt" type="number" min={1} max={24} step={0.25} value={win} onChange={e => setWin(e.target.value)} /> in</label>
        <label>Height <input className="txt" type="number" min={1} max={24} step={0.25} value={hin} onChange={e => setHin(e.target.value)} /> in</label>
        <label>Mesh <select value={mesh} onChange={e => setMesh(+e.target.value)}>{MESHES.map(m => <option key={m} value={m}>{m}</option>)}</select></label>
        <label>Colours <input type="range" min={2} max={16} value={colours} onChange={e => setColours(+e.target.value)} /> {colours}</label>
      </div>
      <p className="note">{sizeOk ? `${W} × ${H} stitches.` : "Each side must come to 4–300 stitches."}</p>

      <div className="btns">
        <button className="btn primary" type="button" disabled={busy || !sizeOk} onClick={() => void draw()}>{busy ? "Claude is drawing…" : result ? "Draw a new one" : "Draw it"}</button>
      </div>
      {error && <p className="note status" role="alert">{error}</p>}

      {result && (
        <div className="design-result">
          <canvas ref={preview} className="design-preview" aria-label="The design as stitches" />
          <div className="design-side">
            {result.notes && <p className="note">{result.notes}</p>}
            <p className="note">{result.W} × {result.H} stitches · up to {result.colours} colours · {result.mesh} mesh</p>
            <div className="btns"><button className="btn primary" type="button" disabled={busy} onClick={() => void use()}>Use this design</button></div>
            <label className="lbl" htmlFor="design-fb">Or change something</label>
            <textarea id="design-fb" className="txt" rows={2} value={feedback} maxLength={1000} placeholder="Make the sunglasses bigger and the lettering darker" onChange={e => setFeedback(e.target.value)} />
            <div className="btns"><button className="btn" type="button" disabled={busy || !feedback.trim()} onClick={() => void draw({ svg: result.svg, feedback })}>{busy ? "Redrawing…" : "Redraw with changes"}</button></div>
          </div>
        </div>
      )}
    </section>
  );
}
