import { useCallback, useEffect, useState } from "react";
import { linkUrl, listLinks, setLinkActive, type SharedLink } from "../lib/shared";
import CopyButton from "./CopyButton";

const when = (t: string) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** The links you've sent to customers, with their progress and a switch to turn each off. */
export default function CustomerLinks({ reload }: { reload: number }) {
  const [links, setLinks] = useState<SharedLink[] | null>(null);
  const [msg, setMsg] = useState("");
  const load = useCallback(() => { listLinks().then(setLinks, e => setMsg((e as Error).message)); }, []);
  useEffect(() => { load(); }, [load, reload]);

  const toggle = async (l: SharedLink) => {
    try { await setLinkActive(l.id, !l.active); load(); } catch (e) { setMsg((e as Error).message); }
  };

  return (
    <div className="links">
      <h2>Customer links</h2>
      {links === null ? <p className="note">Loading…</p> : !links.length ? (
        <p className="note">None yet. Open a chart and use <b>Send to customer</b> to make one.</p>
      ) : links.map(l => {
        const pct = l.stitches ? Math.floor((l.done_count / l.stitches) * 100) : 0;
        return (
          <div key={l.id} className={"linkrow" + (l.active ? "" : " off")}>
            <div className="bar"><b>{l.title}</b><span className="spacer" /><span className="note">{when(l.created_at)}</span></div>
            {l.note && <span className="note">{l.note}</span>}
            <span className="note">{pct}% done · {l.done_count.toLocaleString()} of {l.stitches.toLocaleString()} stitches{l.active ? "" : " · switched off"}</span>
            <span className="url">{linkUrl(l.id)}</span>
            <div className="btns">
              {l.active && <CopyButton text={linkUrl(l.id)} />}
              <span className="spacer" />
              <button className="mini" type="button" onClick={() => void toggle(l)}>{l.active ? "Switch off" : "Switch back on"}</button>
            </div>
          </div>
        );
      })}
      {msg && <p className="note status" role="status">{msg}</p>}
    </div>
  );
}
