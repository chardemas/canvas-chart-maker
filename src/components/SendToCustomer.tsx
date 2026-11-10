import { useState } from "react";
import type { Chart } from "../lib/render";
import { createLink, linkUrl, snapshot, stitchCount } from "../lib/shared";
import CopyButton from "./CopyButton";

interface Props {
  chart: Chart;
  mesh: number;
  defaultTitle: string;
  signedIn: boolean;
  onSignIn: () => void;
  onClose?: () => void;
  onCreated: () => void;
}

/** Makes a private link to this chart, as it is now, for a customer to tick off. */
export default function SendToCustomer({ chart, mesh, defaultTitle, signedIn, onSignIn, onClose, onCreated }: Props) {
  const [title, setTitle] = useState(defaultTitle);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [link, setLink] = useState<string | null>(null);

  const make = async () => {
    setBusy(true); setMsg("");
    try {
      const id = await createLink(title.trim() || "Your chart", note.trim(), snapshot(chart, mesh), stitchCount(chart));
      setLink(linkUrl(id));
      onCreated();
    } catch (e) { setMsg((e as Error).message || "Couldn't make the link. Try again."); }
    finally { setBusy(false); }
  };

  return (
    <section className="library sendbox" aria-label="Send to a customer">
      <div className="bar"><h2>Send to a customer</h2><span className="spacer" />{onClose && <button className="btn" type="button" onClick={onClose}>Close</button>}</div>
      {!signedIn ? (
        <>
          <p className="note">Sign in first, so the links are yours and you can switch them off later.</p>
          <div className="btns"><button className="btn primary" type="button" onClick={onSignIn}>Sign in</button></div>
        </>
      ) : link ? (
        <>
          <p><b>Link ready.</b> Paste it into your Etsy message or email with the PDF.</p>
          <div className="url">{link}</div>
          <div className="btns">
            <CopyButton text={link} />
            <a className="btn" href={link} target="_blank" rel="noopener">Open it</a>
            <button className="mini" type="button" onClick={() => { setLink(null); setNote(""); }}>Make another</button>
          </div>
          <p className="note">The customer sees this chart exactly as it is now and can only tick stitches off. Changes you make here later won't reach them; make a new link instead. Your links are listed under Account.</p>
        </>
      ) : (
        <form className="sendbox" onSubmit={e => { e.preventDefault(); void make(); }}>
          <p className="note">Makes a private link to this chart as it is now (with your stitch fixes, without ticks). The customer can tick stitches off and their progress saves with the link on any device. No sign-in needed for them.</p>
          <label className="lbl" htmlFor="send-title">Chart name the customer sees</label>
          <input id="send-title" className="txt" value={title} maxLength={200} onChange={e => setTitle(e.target.value)} />
          <label className="lbl" htmlFor="send-note">Note under the name (optional)</label>
          <input id="send-note" className="txt" value={note} maxLength={500} placeholder="Made for Jane · Etsy order #1234" onChange={e => setNote(e.target.value)} />
          <div className="btns"><button className="btn primary" type="submit" disabled={busy}>{busy ? "Making the link…" : "Make the link"}</button></div>
        </form>
      )}
      {msg && <p className="note status" role="status">{msg}</p>}
    </section>
  );
}
