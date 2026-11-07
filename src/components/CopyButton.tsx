import { useState } from "react";

/** Copies text to the clipboard; says so for a moment. */
export default function CopyButton({ text, label = "Copy link" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const t = document.createElement("textarea");
      t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand("copy"); } finally { t.remove(); }
    }
    setDone(true); setTimeout(() => setDone(false), 1800);
  };
  return <button className="btn primary" type="button" onClick={() => void copy()}>{done ? "Copied" : label}</button>;
}
