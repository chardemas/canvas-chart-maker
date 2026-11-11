import { useEffect, useState } from "react";
import { listingText, type ListingFields, type Offer } from "../lib/listingText";

/** Studio only: Etsy title, description and tags for this design, ready to copy. */
interface Props { name: string; W: number; H: number; mesh: number }

const saved = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const keep = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="btn" type="button" onClick={() => { void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>
      {done ? "Copied" : "Copy"}
    </button>
  );
}

export default function ListingText({ name, W, H, mesh }: Props) {
  const [f, setF] = useState<ListingFields>(() => ({
    name, kind: "", inspired: "", about: "",
    // shop-wide details are remembered between designs
    canvas: saved("listingCanvas", "Zweigart mono deluxe canvas"),
    margins: saved("listingMargins", "1.5-3 in"),
    offer: saved("listingOffer", "both") as Offer,
  }));
  useEffect(() => setF(v => ({ ...v, name })), [name]);
  useEffect(() => { keep("listingCanvas", f.canvas); keep("listingMargins", f.margins); keep("listingOffer", f.offer); }, [f.canvas, f.margins, f.offer]);
  const set = (k: keyof ListingFields) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF(v => ({ ...v, [k]: e.target.value }));

  const t = listingText(f, W, H, mesh);
  return (
    <div className="listingtext">
      <h3>Listing text</h3>
      <p className="note">Title, description and tags in your usual format. Size and mesh come from this chart.</p>
      <div className="design-size">
        <label>Name <input className="txt" value={f.name} onChange={set("name")} /></label>
        <label>Type <input className="txt" value={f.kind} placeholder="Ornament" onChange={set("kind")} /></label>
        <label>Inspired by <input className="txt" value={f.inspired} placeholder="optional" onChange={set("inspired")} /></label>
      </div>
      <div className="design-size">
        <label>Canvas <input className="txt" value={f.canvas} onChange={set("canvas")} /></label>
        <label>Margins <input className="txt" value={f.margins} onChange={set("margins")} /></label>
        <label>Selling
          <select value={f.offer} onChange={set("offer")}>
            <option value="both">Hand-painted or printed</option>
            <option value="painted">Hand-painted only</option>
            <option value="printed">Printed only</option>
          </select>
        </label>
      </div>
      <label className="note">Opening line (optional)
        <textarea className="txt" rows={2} value={f.about} placeholder="A sweet little angel for your tree…" onChange={set("about")} />
      </label>

      <div className="lt-out"><div className="bar"><b>Title</b> <span className="note">{t.title.length}/140</span><Copy text={t.title} /></div><p>{t.title}</p></div>
      <div className="lt-out"><div className="bar"><b>Description</b><Copy text={t.description} /></div><pre>{t.description}</pre></div>
      <div className="lt-out"><div className="bar"><b>Tags</b> <span className="note">{t.tags.length}/13</span><Copy text={t.tags.join(", ")} /></div><p>{t.tags.join(", ")}</p></div>
    </div>
  );
}
