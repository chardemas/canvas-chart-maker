import { useState } from "react";
import { sendCode, signOut, syncLabel, syncNow, verifyCode, type SyncState } from "../lib/sync";

interface Props {
  email: string | null;
  state: SyncState;
  note: string;
  onClose: () => void;
  onSignedOut: () => void;
}

/** Sign in with an emailed code; once signed in, sync status and sign out. */
export default function Account({ email, state, note, onClose, onSignedOut }: Props) {
  const [addr, setAddr] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [confirmOut, setConfirmOut] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setMsg("");
    try { await fn(); } catch (e) { setMsg((e as Error).message || "Something went wrong. Try again."); } finally { setBusy(false); }
  };

  return (
    <section className="library account" aria-label="Account">
      <div className="bar"><h2>{email ? "Your account" : "Sign in"}</h2><span className="spacer" /><button className="btn" type="button" onClick={onClose}>Close</button></div>

      {email ? (
        <>
          <p>Signed in as <b>{email}</b>.</p>
          <p className={"note sync " + state}>{syncLabel(state)}{note ? ` · ${note}` : ""}</p>
          <p className="note">Your charts, ticks and fixes are kept in your account, so they're the same on every device where you sign in. The site keeps working without internet and catches up when you're back online.</p>
          <div className="btns">
            <button className="btn" type="button" disabled={busy || state === "syncing"} onClick={() => run(async () => { if (!(await syncNow())) throw new Error("Couldn't sync just now. It will keep trying."); })}>Sync now</button>
            <span className="spacer" />
            {confirmOut ? (
              <>
                <span className="note">Sign out? Your charts stay in your account but are removed from this device.</span>
                <button className="mini danger" type="button" disabled={busy} onClick={() => run(async () => { await signOut(); onSignedOut(); })}>Sign out</button>
                <button className="mini" type="button" onClick={() => setConfirmOut(false)}>Stay signed in</button>
              </>
            ) : <button className="mini" type="button" onClick={() => setConfirmOut(true)}>Sign out</button>}
          </div>
        </>
      ) : !sent ? (
        <form className="signin" onSubmit={e => { e.preventDefault(); run(async () => { await sendCode(addr.trim()); setSent(true); }); }}>
          <p className="note">Sign in to keep your charts on all your devices. We'll email you a sign-in link; there's no password.</p>
          <label className="lbl" htmlFor="acct-email">Email</label>
          <div className="btns">
            <input id="acct-email" className="txt" type="email" autoComplete="email" required value={addr} onChange={e => setAddr(e.target.value)} placeholder="you@example.com" />
            <button className="btn primary" type="submit" disabled={busy || !addr.includes("@")}>{busy ? "Sending…" : "Email me a sign-in link"}</button>
          </div>
        </form>
      ) : (
        <form className="signin" onSubmit={e => { e.preventDefault(); run(async () => { await verifyCode(addr.trim(), code.replace(/\s/g, "")); setCode(""); setSent(false); }); }}>
          <p><b>Check your email.</b> We sent a sign-in link to <b>{addr}</b>. It can take a minute; check spam too.</p>
          <p className="note">Open the link on this device, in this browser, and you'll be signed in here. On iPad, if you added the site to your Home Screen, open the link in Safari, then sign in on the Home Screen app separately.</p>
          <details className="codebox">
            <summary className="note">Got a 6-digit code instead?</summary>
          <div className="btns">
            <input id="acct-code" aria-label="Sign-in code" className="txt code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} placeholder="123456" />
            <button className="btn primary" type="submit" disabled={busy || code.replace(/\s/g, "").length < 6}>{busy ? "Checking…" : "Sign in"}</button>
          </div>
          </details>
          <div className="btns">
            <button className="mini" type="button" disabled={busy} onClick={() => run(async () => { await sendCode(addr.trim()); setMsg("Sent it again."); })}>Send it again</button>
            <button className="mini" type="button" onClick={() => { setSent(false); setCode(""); setMsg(""); }}>Use a different email</button>
          </div>
        </form>
      )}
      {msg && <p className="note status" role="status">{msg}</p>}
    </section>
  );
}
