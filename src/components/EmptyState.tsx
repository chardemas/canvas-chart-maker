export default function EmptyState() {
  return (
    <div className="empty">
      <h2>Upload a picture to get started</h2>
      <div className="feat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></svg>
        <b>Symbol chart</b>
        <p>Every stitch gets a symbol and colour, with a red X marking the centre to start from.</p>
      </div>
      <div className="feat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 20c4-1 6-4 8-8s4-7 8-8" /><circle cx="18" cy="6" r="2" /></svg>
        <b>DMC threads</b>
        <p>Each colour is matched to the closest DMC floss, and you can swap to another nearby shade.</p>
      </div>
      <div className="feat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="m8 12 3 3 5-6" /></svg>
        <b>Tick off as you paint</b>
        <p>Tap or drag across stitches to mark them done. Your progress stays saved in this browser.</p>
      </div>
      <div className="feat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M6 9V3h12v6M6 18H4v-7h16v7h-2M6 14h12v7H6z" /></svg>
        <b>Print version</b>
        <p>A plain pixel picture sized in inches, so each square lines up with one stitch.</p>
      </div>
    </div>
  );
}
