import { useEffect, useMemo, useRef, useState } from "react";
import type { Chart } from "../lib/render";
import { centredAnchor, checkFit, ET2803, holeAt, stitchQuad, type Pt } from "../lib/canvasPrint";
import { analyseScan, makePrintPdf, scanCrop, type Analysed } from "../lib/canvasPrintClient";
import { carrierPdf } from "../lib/pdf";

interface Props {
  chart: Chart;
  mesh: number;
  baseName: string;
  onClose: () => void;
}

const CLOSE = 240; // close-up size in scan px (0.4 in)

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Print on canvas: the maker prints the carrier page, tapes blank canvas onto it, scans it, and gets a
 * print file with every stitch moved onto its own thread crossing on that exact piece of canvas.
 */
export default function PrintToCanvas({ chart, mesh, baseName, onClose }: Props) {
  const [scan, setScan] = useState<Analysed | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState<Pt | null>(null);
  const [look, setLook] = useState<Pt | null>(null);
  const [crop, setCrop] = useState<{ image: ImageBitmap; x: number; y: number } | null>(null);
  const [correct, setCorrect] = useState(true);
  const [making, setMaking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const overview = useRef<HTMLCanvasElement>(null);
  const closeup = useRef<HTMLCanvasElement>(null);
  const { W, H, idx, pal } = chart;

  const colours = useMemo(() => pal.map(p => `rgb(${p.rgb.join(",")})`), [pal]);
  const fit = scan && at ? checkFit(scan.lattice, W, H, at[0], at[1]) : null;

  const openScan = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setError(""); setScan(null); setCrop(null);
    try {
      const r = await analyseScan(file, setStatus);
      const a = centredAnchor(r.lattice, W, H);
      setScan(r); setAt(a);
      setLook(holeAt(r.lattice, a[0] + (W >> 1), a[1] + (H >> 1)));
      setStatus("");
    } catch (e) { setError((e as Error).message); setStatus(""); }
    finally { setBusy(false); }
  };

  // the whole page with the design laid over it
  useEffect(() => {
    const cv = overview.current;
    if (!cv || !scan || !at) return;
    const s = scan.overview.width / scan.scanW;
    cv.width = scan.overview.width; cv.height = scan.overview.height;
    const g = cv.getContext("2d")!;
    g.drawImage(scan.overview, 0, 0);
    if (!checkFit(scan.lattice, W, H, at[0], at[1]).fits) return;
    g.globalAlpha = 0.9;
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const k = idx[r * W + c];
      if (k < 0) continue;
      const q = stitchQuad(scan.lattice, at[0], at[1], c, r);
      g.fillStyle = colours[k];
      g.beginPath(); q.forEach(([x, y], n) => (n ? g.lineTo(x * s, y * s) : g.moveTo(x * s, y * s))); g.fill();
    }
    if (look) {
      g.globalAlpha = 1; g.strokeStyle = "#e0245e"; g.lineWidth = 2;
      g.strokeRect((look[0] - CLOSE / 2) * s, (look[1] - CLOSE / 2) * s, CLOSE * s, CLOSE * s);
    }
  }, [scan, at, look, W, H, idx, colours]);

  // fetch the full-resolution close-up whenever the spot changes
  useEffect(() => {
    if (!scan || !look) return;
    let live = true;
    const x = Math.max(0, Math.min(scan.scanW - CLOSE, look[0] - CLOSE / 2)), y = Math.max(0, Math.min(scan.scanH - CLOSE, look[1] - CLOSE / 2));
    scanCrop(x, y, CLOSE).then(image => { if (live) setCrop({ image, x, y }); }).catch(() => {});
    return () => { live = false; };
  }, [scan, look]);

  // the close-up: real canvas with the stitch patches drawn see-through, to check they sit on the crossings
  useEffect(() => {
    const cv = closeup.current;
    if (!cv || !scan || !at || !crop) return;
    const z = 2;
    cv.width = cv.height = CLOSE * z;
    const g = cv.getContext("2d")!;
    g.imageSmoothingEnabled = false;
    g.drawImage(crop.image, 0, 0, CLOSE * z, CLOSE * z);
    if (!checkFit(scan.lattice, W, H, at[0], at[1]).fits) return;
    g.globalAlpha = 0.55;
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const k = idx[r * W + c];
      if (k < 0) continue;
      const q = stitchQuad(scan.lattice, at[0], at[1], c, r);
      if (q.every(([x]) => x < crop.x - 40 || x > crop.x + CLOSE + 40) || q.every(([, y]) => y < crop.y - 40 || y > crop.y + CLOSE + 40)) continue;
      g.fillStyle = colours[k];
      g.beginPath(); q.forEach(([x, y], n) => (n ? g.lineTo((x - crop.x) * z, (y - crop.y) * z) : g.moveTo((x - crop.x) * z, (y - crop.y) * z))); g.fill();
    }
  }, [scan, at, crop, W, H, idx, colours]);

  const pickSpot = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!scan) return;
    const box = e.currentTarget.getBoundingClientRect();
    setLook([((e.clientX - box.left) / box.width) * scan.scanW, ((e.clientY - box.top) / box.height) * scan.scanH]);
  };

  const move = (di: number, dj: number) => setAt(a => (a ? [a[0] + di, a[1] + dj] : a));

  const makePdf = async () => {
    if (!scan || !at) return;
    setMaking(true); setError("");
    try {
      const cols = new Uint8Array(pal.length * 3);
      pal.forEach((p, k) => cols.set(p.rgb, k * 3));
      download(await makePrintPdf(W, H, idx.slice(), cols, at, correct), `${baseName}-canvas.pdf`);
    } catch (e) { setError((e as Error).message); }
    finally { setMaking(false); }
  };

  const L = scan?.lattice;
  const meshOff = L && Math.abs((L.meshX + L.meshY) / 2 - mesh) / mesh > 0.08;

  return (
    <section className="library printcanvas" aria-label="Print on canvas">
      <div className="bar"><h2>Print on canvas</h2><span className="spacer" /><button className="btn" type="button" onClick={onClose}>Close</button></div>
      <p className="note">Lines each stitch up with its own thread crossing on your actual piece of canvas, even when the canvas isn't quite square or isn't exactly {mesh} to the inch.</p>

      <ol className="steps">
        <li>
          <b>Print the carrier page</b> on plain paper at <b>Scale 100%</b> (Actual size, not "fit to page", borderless off).
          <div className="btns"><button className="btn" type="button" onClick={() => carrierPdf().then(b => download(b, "carrier-page.pdf"))}>Download carrier page</button></div>
        </li>
        <li><b>Tape blank canvas over the grey panel.</b> Keep the tape off the four corner dots and off the area you'll print on.</li>
        <li>
          <b>Scan the whole page</b> at <b>600 dpi</b> as a PNG, the same way up as it printed.
          <input ref={fileInput} type="file" accept="image/png,image/jpeg" hidden onChange={e => { void openScan(e.target.files?.[0]); e.target.value = ""; }} />
          <div className="btns"><button className="btn primary" type="button" disabled={busy} onClick={() => fileInput.current?.click()}>{busy ? "Reading…" : scan ? "Choose a different scan" : "Choose the scan"}</button></div>
          {status && <p className="note status" role="status">{status}</p>}
        </li>
      </ol>
      {error && <p className="note status" role="alert">{error}</p>}

      {scan && L && at && (
        <>
          <p className="note">
            Found {L.holes.toLocaleString()} holes. This canvas is <b>{L.meshX.toFixed(2)} × {L.meshY.toFixed(2)}</b> holes per inch
            and {Math.abs(L.skewDeg).toFixed(1)}° out of square, so the design prints at {(W / L.meshX).toFixed(2)} × {(H / L.meshY).toFixed(2)} in.
          </p>
          {meshOff && <p className="note status">This canvas looks like about {Math.round((L.meshX + L.meshY) / 2)} mesh, but the chart is set to {mesh} mesh. The print will follow the canvas, so the design will come out a different size.</p>}
          {fit && !fit.fits && <p className="note status" role="alert">The design doesn't fit on the canvas in the scan. Move it, or use a bigger piece of canvas.</p>}
          {fit?.fits && fit.unseen > 0.02 && <p className="note status">{Math.round(fit.unseen * 100)}% of the design sits where no holes were visible (under tape or off the grey panel). Those spots are estimated, so move the design or retape if you can.</p>}

          <div className="pc-views">
            <figure>
              <canvas ref={overview} className="pc-overview" onClick={pickSpot} />
              <figcaption className="note">Tap anywhere to look closer.</figcaption>
            </figure>
            <figure>
              <canvas ref={closeup} className="pc-closeup" />
              <figcaption className="note">Close-up of your scan: each colour patch should sit on a thread crossing, with holes at its corners.</figcaption>
            </figure>
          </div>

          <div className="btns" role="group" aria-label="Move the design">
            <span className="note">Move the design one stitch:</span>
            <button className="mini" type="button" aria-label="Left" onClick={() => move(-1, 0)}>←</button>
            <button className="mini" type="button" aria-label="Up" onClick={() => move(0, -1)}>↑</button>
            <button className="mini" type="button" aria-label="Down" onClick={() => move(0, 1)}>↓</button>
            <button className="mini" type="button" aria-label="Right" onClick={() => move(1, 0)}>→</button>
            <button className="mini" type="button" onClick={() => setAt(centredAnchor(L, W, H))}>Centre</button>
          </div>

          <label className="check">
            <input type="checkbox" checked={correct} onChange={e => setCorrect(e.target.checked)} />
            Correct for my {ET2803.name} (measured from test prints)
          </label>

          <ol className="steps" start={4}>
            <li>
              <b>Print it</b> on the same sheet, loaded the same way up (top edge first), pushed against the side with the guide snug, at <b>Scale 100%</b>.
              <div className="btns"><button className="btn primary" type="button" disabled={making || !fit?.fits} onClick={() => void makePdf()}>{making ? "Making the print file…" : "Download print file"}</button></div>
            </li>
          </ol>
          <p className="note">This print file only fits the canvas in this scan. For another piece of canvas, scan again.</p>
        </>
      )}
    </section>
  );
}
