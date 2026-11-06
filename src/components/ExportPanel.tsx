import { useEffect, useRef } from "react";

interface Props {
  url: string;
  note: string;
  fileName: string;
  onClose: () => void;
}

export default function ExportPanel({ url, note, fileName, onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { panel.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [url]);
  return (
    <div className="export" ref={panel}>
      <div className="bar">
        <h2>Image to save</h2><span className="spacer" />
        <a className="btn primary" href={url} download={fileName}>Download PNG</a>
        <button className="btn" type="button" onClick={onClose}>Close</button>
      </div>
      <p className="note">{note}</p>
      <img src={url} alt="Chart image to save" />
    </div>
  );
}
