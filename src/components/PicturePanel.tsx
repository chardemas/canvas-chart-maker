import { useState } from "react";

interface Props {
  picture: { url: string; name: string; cutout?: boolean } | null;
  message: string;
  /** a line under the picture's name */
  note?: string;
  onPick: () => void;
  onFile: (f: File | undefined) => void;
  /** left out when cropping doesn't apply (an exact pattern) */
  onCrop?: () => void;
  /** name in My charts, if this chart is saved there */
  savedName: string | null;
  canSave: boolean;
  onSave: () => void;
  onSaveCopy: () => void;
}

/** Upload box before a picture is chosen; thumbnail with Change and Crop after. */
export default function PicturePanel({ picture, message, note, onPick, onFile, onCrop, savedName, canSave, onSave, onSaveCopy }: Props) {
  const [over, setOver] = useState(false);
  return (
    <div className="group">
      <span className="label">Picture</span>
      {picture ? (
        <div className="pic">
          <img src={picture.url} alt="" className={picture.cutout ? "cut" : undefined} />
          <div>
            <div className="name">{picture.name}</div>
            {note && <div className="note">{note}</div>}
            <div className="btns" style={{ marginTop: 6 }}>
              <button className="btn" type="button" onClick={onPick}>New picture</button>
              {onCrop && <button className="btn" type="button" onClick={onCrop}>Crop</button>}
            </div>
          </div>
          <div className="saverow">
            {savedName ? (
              <>
                <span className="saved">Saved as “{savedName}”. Changes save automatically. Starting a new picture keeps this one in My charts.</span>
                <button className="mini" type="button" onClick={onSaveCopy}>Save a copy</button>
              </>
            ) : (
              <>
                <button className="btn primary" type="button" disabled={!canSave} onClick={onSave}>Save to My charts</button>
                <span className="note">Not saved yet. Starting a new picture replaces this chart unless you save it.</span>
              </>
            )}
          </div>
        </div>
      ) : (
        <div
          className={"drop" + (over ? " over" : "")}
          tabIndex={0}
          role="button"
          onClick={onPick}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(); } }}
          onDragEnter={e => { e.preventDefault(); setOver(true); }}
          onDragOver={e => { e.preventDefault(); setOver(true); }}
          onDragLeave={e => { e.preventDefault(); setOver(false); }}
          onDrop={e => { e.preventDefault(); setOver(false); onFile(e.dataTransfer.files[0]); }}
        >
          <strong>Upload a picture</strong>
          <span>or drop or paste one here</span>
          <small>{message}</small>
        </div>
      )}
    </div>
  );
}
