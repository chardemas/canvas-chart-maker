"""Print a chart so each stitch's colour lands on its own canvas intersection.

Workflow
  1. python print_align.py carrier            -> carrier.pdf. Print it on plain paper (Actual size).
  2. Tape blank canvas over the dark panel. Keep the four corner dots uncovered.
  3. Scan the sheet at 600 dpi, PNG, same way up as printed.
  4. python print_align.py make SCAN CHART.png -> CHART-canvas.pdf + CHART-preview.png
  5. Check the preview, then feed the same sheet in the same way and print the PDF at Actual size.

CHART.png is the chart maker's "Print version" image (18 px per stitch, white = leave unprinted).
`python print_align.py testchart` makes a checkerboard chart that shows misalignment clearly.
"""
from __future__ import annotations
import argparse, sys
from pathlib import Path
import cv2
import numpy as np
from scipy.interpolate import griddata
from scipy.spatial import cKDTree
from PIL import Image

DPI = 600
PAGE_W, PAGE_H = int(8.5 * DPI), int(11 * DPI)
# carrier corner dots (page inches). Top-left has a second, smaller dot beside it to show orientation.
DOTS_IN = np.array([(0.5, 0.5), (8.0, 0.5), (0.5, 10.5), (8.0, 10.5)])
DOT_R_IN = 0.08
ORIENT_IN, ORIENT_R_IN = (0.85, 0.5), 0.04
PANEL_IN = (1.0, 1.0, 7.5, 10.0)  # x0, y0, x1, y1 of the dark backing panel
PANEL_GREY = 70
CELL = 18  # chart maker pixels per stitch


# ---------- carrier sheet ----------
def make_carrier(out: Path, panel: bool):
    page = np.full((PAGE_H, PAGE_W), 255, np.uint8)
    if panel:
        x0, y0, x1, y1 = (np.array(PANEL_IN) * DPI).astype(int)
        page[y0:y1, x0:x1] = PANEL_GREY
    for x, y in DOTS_IN:
        cv2.circle(page, (int(x * DPI), int(y * DPI)), int(DOT_R_IN * DPI), 0, -1, cv2.LINE_AA)
    cv2.circle(page, (int(ORIENT_IN[0] * DPI), int(ORIENT_IN[1] * DPI)), int(ORIENT_R_IN * DPI), 0, -1, cv2.LINE_AA)
    cv2.putText(page, "CARRIER - tape canvas over the grey panel, keep the 4 corner dots clear. Top edge feeds first.",
                (int(1.0 * DPI), int(0.55 * DPI)), cv2.FONT_HERSHEY_SIMPLEX, 1.6, 0, 3, cv2.LINE_AA)
    save_pdf(page, out)


def save_pdf(img: np.ndarray, out: Path):
    Image.fromarray(img).save(out, "PDF", resolution=DPI)


# ---------- test chart ----------
def make_testchart(out: Path, w: int, h: int):
    a, b, line = (220, 40, 60), (40, 110, 220), (20, 20, 20)
    chart = np.zeros((h, w, 3), np.uint8)
    yy, xx = np.mgrid[0:h, 0:w]
    chart[:] = a
    chart[(xx + yy) % 2 == 1] = b
    chart[(xx % 10 == 0) | (yy % 10 == 0) | (xx == w - 1) | (yy == h - 1)] = line
    big = np.repeat(np.repeat(chart, CELL, 0), CELL, 1)
    Image.fromarray(big).save(out)


def load_chart(path: Path):
    im = np.array(Image.open(path).convert("RGB"))
    H, W = im.shape[0] // CELL, im.shape[1] // CELL
    if im.shape[0] % CELL or im.shape[1] % CELL:
        sys.exit(f"{path}: size {im.shape[1]}x{im.shape[0]} isn't a multiple of {CELL} px per stitch - is it the Print version image?")
    cols = im[CELL // 2::CELL, CELL // 2::CELL][:H, :W]
    blank = (cols == 255).all(-1)
    return cols, blank


# ---------- registration: scan px -> page px ----------
def find_dots(gray: np.ndarray):
    """Returns the 4 corner-dot centres in scan px, ordered like DOTS_IN, or None."""
    r = DOT_R_IN * DPI
    m = (gray < 100).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    n, _, st, cen = cv2.connectedComponentsWithStats(m)
    cand = []
    for k in range(1, n):
        x, y, w, h, a = st[k]
        if abs(w - 2 * r) < 0.35 * r and abs(h - 2 * r) < 0.35 * r and a > 0.7 * np.pi * r * r:
            cand.append(cen[k])
    if len(cand) < 4:
        return None
    cand = np.array(cand)
    # nearest candidate to each expected corner (paper sits within a few mm of the scanner corner)
    out = []
    for p in DOTS_IN * DPI:
        d = np.hypot(*(cand - p).T)
        if d.min() > 0.6 * DPI:
            return None
        out.append(cand[d.argmin()])
    return np.array(out)


def scan_to_page(gray: np.ndarray, no_marks: bool):
    """3x3 homography scan px -> page px through the 4 carrier dots (absorbs slight keystone from the carrier's own feed)."""
    if no_marks:
        print("  no carrier dots: assuming the paper sat exactly in the scanner corner (testing only)")
        return np.eye(3)
    dots = find_dots(gray)
    if dots is None:
        sys.exit("Couldn't find the 4 carrier corner dots. Is the tape covering one, or is the scan rotated?")
    Hm = cv2.getPerspectiveTransform(dots.astype(np.float32), (DOTS_IN * DPI).astype(np.float32))
    d = lambda a, b: np.hypot(*(dots[a] - dots[b])) / DPI * 25.4
    print(f"  carrier dots found; rotation {np.degrees(np.arctan2(*(dots[1] - dots[0])[::-1])):+.2f}°,"
          f" sides top {d(0, 1):.2f} bottom {d(2, 3):.2f} left {d(0, 2):.2f} right {d(1, 3):.2f} mm"
          f" (printed 190.50 / 254.00)")
    return Hm


def to_page(Hm: np.ndarray, pts: np.ndarray, nudge_px) -> np.ndarray:
    sh = pts.shape
    out = cv2.perspectiveTransform(pts.reshape(-1, 1, 2).astype(np.float64), Hm).reshape(sh)
    return out + np.asarray(nudge_px)


# ---------- mesh detection ----------
def detect_holes(gray: np.ndarray):
    """Hole centres (scan px) as an integer lattice: returns dict (i,j)->(x,y), basis vectors, pitch."""
    g = cv2.GaussianBlur(gray, (3, 3), 0)
    # holes are darker than the threads around them
    m = cv2.adaptiveThreshold(g, 1, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 51, 25)
    n, _, st, cen = cv2.connectedComponentsWithStats(m)
    a, w, h = st[:, 4], st[:, 2], st[:, 3]
    ok = (a > 40) & (a < 1200) & (w < 50) & (h < 50) & (w > 5) & (h > 5)
    pts = cen[ok]
    if len(pts) < 500:
        sys.exit(f"Only found {len(pts)} hole-like spots - is the canvas over the dark panel?")
    tree = cKDTree(pts)
    _, nb = tree.query(pts, k=5)
    vec = (pts[nb[:, 1:]] - pts[:, None]).reshape(-1, 2)
    dist = np.hypot(*vec.T)
    pitch = np.median(dist[(dist > 15) & (dist < 80)])
    near = np.abs(dist - pitch) < 0.25 * pitch
    ex = np.median(vec[near & (np.abs(vec[:, 1]) < 0.4 * pitch) & (vec[:, 0] > 0)], 0)
    ey = np.median(vec[near & (np.abs(vec[:, 0]) < 0.4 * pitch) & (vec[:, 1] > 0)], 0)

    # grow the lattice outward from the hole nearest the centre of all detections, using local steps
    seed = tree.query(np.median(pts, 0))[1]
    coord = {seed: (0, 0)}
    step = {seed: (ex, ey)}
    q = [seed]
    while q:
        k = q.pop()
        ci, cj = coord[k]
        sx, sy = step[k]
        for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            d, j = tree.query(pts[k] + di * sx + dj * sy)
            if d < 0.3 * pitch and j not in coord:
                coord[j] = (ci + di, cj + dj)
                v = (pts[j] - pts[k]) * (di + dj)  # actual local step, follows gentle curvature
                step[j] = (v, sy) if di else (sx, v)
                q.append(j)
    holes = {coord[k]: pts[k] for k in coord}
    return holes, ex, ey, pitch


def full_lattice(holes: dict, pad: int):
    """Positions for every lattice point in the detected range (+pad), filling gaps from neighbours."""
    IJ = np.array(list(holes))
    P = np.array(list(holes.values()))
    X = np.c_[IJ, np.ones(len(IJ))]
    sol, *_ = np.linalg.lstsq(X, P, rcond=None)
    res = P - X @ sol
    # drop outliers (mis-assigned spots)
    keep = np.hypot(*res.T) < 4 * np.median(np.hypot(*res.T)) + 2
    IJ, P, res = IJ[keep], P[keep], res[keep]
    i0, j0 = IJ.min(0) - pad
    i1, j1 = IJ.max(0) + pad
    gi, gj = np.mgrid[i0:i1 + 1, j0:j1 + 1]
    G = np.c_[gi.ravel(), gj.ravel()]
    r = np.stack([griddata(IJ, res[:, k], G, method="linear") for k in (0, 1)], 1)
    hole = np.isnan(r[:, 0])
    if hole.any():
        r[hole] = np.stack([griddata(IJ, res[:, k], G[hole], method="nearest") for k in (0, 1)], 1)
    pos = (np.c_[G, np.ones(len(G))] @ sol + r).reshape(gi.shape + (2,))
    detected = np.zeros(gi.shape, bool)
    detected[IJ[:, 0] - i0, IJ[:, 1] - j0] = True
    return pos, (i0, j0), detected, sol, np.hypot(*res.T)


# ---------- render ----------
def render(pos_page: np.ndarray, cols: np.ndarray, blank: np.ndarray, at: tuple[int, int], grow: float):
    """pos_page[i,j] = hole centre in page px. Stitch (c,r) fills the quad of holes (at+c..+1, at+r..+1)."""
    page = np.full((PAGE_H, PAGE_W, 3), 255, np.uint8)
    H, W = blank.shape
    ai, aj = at
    S = 4  # sub-pixel bits for fillConvexPoly
    for r in range(H):
        for c in range(W):
            if blank[r, c]:
                continue
            i, j = ai + c, aj + r
            q = np.array([pos_page[i, j], pos_page[i + 1, j], pos_page[i + 1, j + 1], pos_page[i, j + 1]])
            if grow != 1:
                m = q.mean(0); q = m + (q - m) * grow
            cv2.fillConvexPoly(page, np.round(q * (1 << S)).astype(np.int32), tuple(int(v) for v in cols[r, c]), cv2.LINE_AA, S)
    return page


def load_profile(path: Path | None):
    if path is None or not path.exists():
        return None
    import json
    p = json.loads(path.read_text())
    return np.array(p["centre"]), np.array(p["A"]), np.array(p["t"])


def precorrect(q: np.ndarray, prof) -> np.ndarray:
    """Printer prints p at p + A(p-c) + t; return the p that lands on q."""
    c, A, t = prof
    M = np.linalg.inv(np.eye(2) + A)
    return c + (q.reshape(-1, 2) - c - t) @ M.T


def make(scan_path: Path, chart_path: Path, out_dir: Path, no_marks: bool, offset, grow: float, nudge_mm, profile: Path | None):
    print(f"reading {scan_path.name}")
    bgr = cv2.imread(str(scan_path))
    if bgr is None:
        sys.exit(f"can't read {scan_path}")
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    Hm = scan_to_page(gray, no_marks)
    nudge_px = np.array(nudge_mm) / 25.4 * DPI

    holes, ex, ey, pitch = detect_holes(gray)
    cols, blank = load_chart(chart_path)
    H, W = blank.shape
    pos, (i0, j0), detected, sol, res = full_lattice(holes, pad=max(W, H))
    count = 25.4 / (pitch / DPI * 25.4)
    skew = np.degrees(np.arccos(ex @ ey / np.hypot(*ex) / np.hypot(*ey))) - 90
    print(f"  {len(holes)} holes found · mesh {DPI / np.hypot(*sol[0]):.2f} across x {DPI / np.hypot(*sol[1]):.2f} down per inch"
          f" · out of square {skew:+.2f}° · thread wobble avg {res.mean() / DPI * 25.4:.2f} mm")

    # place the chart: centred on the detected canvas area unless an offset (in stitches) is given
    di, dj = np.nonzero(detected)
    ci, cj = (di.min() + di.max() + 1) / 2, (dj.min() + dj.max() + 1) / 2
    ai, aj = int(round(ci - W / 2)) + offset[0], int(round(cj - H / 2)) + offset[1]
    cover = detected[ai:ai + W + 1, aj:aj + H + 1]
    if cover.shape != (W + 1, H + 1):
        sys.exit("chart doesn't fit inside the lattice")
    unseen = 1 - cover.mean()
    if unseen > 0.02:
        print(f"  warning: {unseen:.0%} of the chart sits where no holes were seen (under tape?) - those spots are estimated")

    pos_page = to_page(Hm, pos, nudge_px)
    target = render(pos_page, cols, blank, (ai, aj), grow)  # where the ink should land (used for the preview)
    prof = load_profile(profile)
    if prof is not None:
        c, A, t = prof
        print(f"  printer profile {profile.name}: correcting {t[0] / DPI * 25.4:+.2f} mm across, {t[1] / DPI * 25.4:+.2f} mm down,"
              f" {np.degrees((A[1, 0] - A[0, 1]) / 2):+.2f}° rotation")
        page = render(precorrect(pos_page, prof).reshape(pos_page.shape), cols, blank, (ai, aj), grow)
    else:
        page = target

    stem = chart_path.stem
    out_dir.mkdir(parents=True, exist_ok=True)
    pdf = out_dir / f"{stem}-canvas.pdf"
    save_pdf(page, pdf)
    preview(bgr, target, Hm, nudge_px, pos, (ai, aj), (W, H), out_dir / f"{stem}-preview.png")
    print(f"  wrote {pdf}\n  wrote {out_dir / (stem + '-preview.png')}")


def preview(bgr, page, Hm, nudge_px, pos, at, size, out: Path):
    """The planned print drawn back onto the scan: full view + a close-up at the chart's top-left corner."""
    T = np.array([[1, 0, nudge_px[0]], [0, 1, nudge_px[1]], [0, 0, 1]]) @ Hm
    back = cv2.warpPerspective(page, np.linalg.inv(T), (bgr.shape[1], bgr.shape[0]), flags=cv2.INTER_LINEAR, borderValue=(255, 255, 255))
    back = cv2.cvtColor(back, cv2.COLOR_RGB2BGR)
    inked = (back < 250).any(-1)
    mix = bgr.copy()
    mix[inked] = (0.45 * bgr[inked] + 0.55 * back[inked]).astype(np.uint8)
    ai, aj = at
    W, H = size
    x0, y0 = pos[ai, aj].astype(int) - 60
    crop = mix[max(y0, 0):y0 + 500, max(x0, 0):x0 + 500]
    crop = cv2.resize(crop, None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST)
    small = cv2.resize(mix, None, fx=0.2, fy=0.2, interpolation=cv2.INTER_AREA)
    h = max(small.shape[0], crop.shape[0])
    pad = lambda im: cv2.copyMakeBorder(im, 0, h - im.shape[0], 0, 20, cv2.BORDER_CONSTANT, value=(255, 255, 255))
    cv2.imwrite(str(out), np.hstack([pad(small), pad(crop)]))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("carrier", help="make the carrier sheet PDF")
    c.add_argument("--out", type=Path, default=Path("carrier.pdf"))
    c.add_argument("--no-panel", action="store_true", help="corner dots only, no dark panel")
    t = sub.add_parser("testchart", help="make a checkerboard test chart PNG")
    t.add_argument("--out", type=Path, default=Path("testchart.png"))
    t.add_argument("--size", type=int, nargs=2, default=(60, 60), metavar=("W", "H"))
    m = sub.add_parser("make", help="scan + chart -> print PDF and preview")
    m.add_argument("scan", type=Path)
    m.add_argument("chart", type=Path)
    m.add_argument("--out-dir", type=Path, default=Path("out"))
    m.add_argument("--no-marks", action="store_true", help="testing only: scan has no carrier dots")
    m.add_argument("--offset", type=int, nargs=2, default=(0, 0), metavar=("COLS", "ROWS"), help="move the chart by whole stitches")
    m.add_argument("--grow", type=float, default=1.0, help="scale each stitch patch, e.g. 1.1 for overlap")
    m.add_argument("--profile", type=Path, default=Path(__file__).with_name("printer_profile.json"),
                   help="printer correction from scripts/fit_profile.py (default: printer_profile.json if present)")
    m.add_argument("--no-profile", action="store_true", help="don't correct for the printer")
    m.add_argument("--nudge", type=float, nargs=2, default=(0, 0), metavar=("X_MM", "Y_MM"), help="shift the print to correct printer bias")
    a = ap.parse_args()
    if a.cmd == "carrier":
        make_carrier(a.out, not a.no_panel); print(f"wrote {a.out}")
    elif a.cmd == "testchart":
        make_testchart(a.out, *a.size); print(f"wrote {a.out}")
    else:
        make(a.scan, a.chart, a.out_dir, a.no_marks, a.offset, a.grow, a.nudge, None if a.no_profile else a.profile)


if __name__ == "__main__":
    main()
