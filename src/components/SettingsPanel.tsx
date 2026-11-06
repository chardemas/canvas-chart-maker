import type { Settings } from "../lib/chart";
import type { Chart } from "../lib/render";

/** Settings as the form holds them: inches stay as typed text. */
export type Form = Omit<Settings, "win" | "hin"> & { win: string; hin: string };

interface Props {
  form: Form;
  update: (patch: Partial<Form>) => void;
  size: { W: number; H: number } | null;
  chart: Chart | null;
  /** what the subject finder is doing, if anything */
  cutStatus: string;
}

const MESHES = [10, 12, 13, 14, 18];

export default function SettingsPanel({ form, update, size, chart, cutStatus }: Props) {
  const mesh = form.mesh;
  return (
    <>
      <div className="group">
        <span className="label">Background and fit</span>
        <label className="check"><input type="checkbox" checked={form.cutout} onChange={e => update({ cutout: e.target.checked })} /> Keep only the subject</label>
        {form.cutout && (
          <p className="note">Finds the main subject and drops everything around it, for photos with busy backgrounds. The first time, it downloads a 98 MB helper that your browser keeps. Your picture stays on your device.</p>
        )}
        {cutStatus && <p className="note status" role="status">{cutStatus}</p>}
        <label className="check"><input type="checkbox" checked={form.rm} onChange={e => update({ rm: e.target.checked })} /> Remove white background</label>
        {form.rm && (
          <div className="row">
            <div className="top"><label htmlFor="thr">How light counts as background</label><output>{form.thr}</output></div>
            <input type="range" id="thr" min={180} max={254} step={1} value={form.thr} onChange={e => update({ thr: +e.target.value })} />
          </div>
        )}
        <label className="check"><input type="checkbox" checked={form.trim} disabled={!form.rm && !form.cutout} onChange={e => update({ trim: e.target.checked })} /> Trim empty edges to fit the design</label>
      </div>

      <div className="group">
        <span className="label">Size</span>
        <div className="row">
          <div className="top">
            <label htmlFor="mesh">Canvas mesh</label>
            <select id="mesh" value={mesh} onChange={e => update({ mesh: +e.target.value })}>
              {MESHES.map(m => <option key={m} value={m}>{m} mesh</option>)}
            </select>
          </div>
        </div>
        <div className="dims">
          <label htmlFor="win">Width</label>
          <span><input type="number" id="win" min={1} max={24} step={0.25} value={form.win} onChange={e => update({ win: e.target.value })} /> in</span>
          <output>{size ? `${size.W} st` : ""}</output>
          <label htmlFor="hin">Height</label>
          <span><input type="number" id="hin" min={1} max={24} step={0.25} value={form.hin} onChange={e => update({ hin: e.target.value })} /> in</span>
          <output>{size ? `${size.H} st` : ""}</output>
        </div>
        <label className="check"><input type="checkbox" checked={form.lock} onChange={e => update({ lock: e.target.checked })} /> Keep proportions</label>
        {!form.lock && <p className="note">The design is fitted inside this size and centred, with background around it.</p>}
        {size && (size.W === 300 || size.H === 300) && <p className="note">Charts are capped at 300 stitches a side.</p>}
      </div>

      <div className="group">
        <span className="label">Colour</span>
        <div className="row">
          <div className="top"><label htmlFor="k">Number of colours</label><output>{form.k}</output></div>
          <input type="range" id="k" min={2} max={24} step={1} value={form.k} onChange={e => update({ k: +e.target.value })} />
        </div>
        <div className="row">
          <div className="top"><label htmlFor="con">Contrast</label><output>{form.con.toFixed(2)}×</output></div>
          <input type="range" id="con" min={0.6} max={2} step={0.05} value={form.con} onChange={e => update({ con: +e.target.value })} />
        </div>
        <div className="row">
          <div className="top"><label htmlFor="sat">Colour boost</label><output>{form.sat.toFixed(2)}×</output></div>
          <input type="range" id="sat" min={0} max={2} step={0.05} value={form.sat} onChange={e => update({ sat: +e.target.value })} />
        </div>
        <label className="check"><input type="checkbox" checked={form.dmc} onChange={e => update({ dmc: e.target.checked })} /> Use exact DMC thread colours</label>
      </div>

      <div className="group">
        <dl className="facts" aria-live="polite">
          <dt>Stitches</dt><dd>{chart ? `${chart.W} × ${chart.H}` : "–"}</dd>
          <dt>Finished size</dt><dd>{chart ? `${(chart.W / mesh).toFixed(2)} × ${(chart.H / mesh).toFixed(2)} in` : "–"}</dd>
          <dt>Stitched area</dt><dd>{chart ? `${(chart.W * chart.H - chart.bg).toLocaleString()} st · ${chart.pal.length} colours` : "–"}</dd>
          <dt>Centre stitch</dt><dd>{chart ? `col ${Math.floor(chart.W / 2) + 1}, row ${Math.floor(chart.H / 2) + 1}` : "–"}</dd>
        </dl>
      </div>
    </>
  );
}
