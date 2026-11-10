"""Measure where the ink actually landed vs where it was planned.
usage: measure_print.py BEFORE_SCAN AFTER_SCAN CHART.png [--offset C R]
Re-runs the planning on BEFORE, maps the planned print into AFTER via the carrier dots,
then phase-correlates planned vs observed colour (R-B) in tiles -> printer shift field (mm)."""
import sys, argparse
from pathlib import Path
import cv2, numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import print_align as pa

ap = argparse.ArgumentParser(); ap.add_argument("before"); ap.add_argument("after"); ap.add_argument("chart")
ap.add_argument("--offset", type=int, nargs=2, default=(0, 0)); ap.add_argument("--tiles", type=int, default=4)
a = ap.parse_args()
MM = 25.4 / pa.DPI

g1 = cv2.imread(a.before, 0); H1 = pa.scan_to_page(g1, False)
holes, ex, ey, pitch = pa.detect_holes(g1)
cols, blank = pa.load_chart(Path(a.chart)); H, W = blank.shape
pos, _, detected, _, _ = pa.full_lattice(holes, pad=max(W, H))
di, dj = np.nonzero(detected)
ai = int(round((di.min() + di.max() + 1) / 2 - W / 2)) + a.offset[0]
aj = int(round((dj.min() + dj.max() + 1) / 2 - H / 2)) + a.offset[1]
page = pa.render(pa.to_page(H1, pos, (0, 0)), cols, blank, (ai, aj), 1.0)

after = cv2.imread(a.after); g2 = cv2.cvtColor(after, cv2.COLOR_BGR2GRAY)
H2 = pa.scan_to_page(g2, False)
plan = cv2.warpPerspective(cv2.cvtColor(page, cv2.COLOR_RGB2BGR), np.linalg.inv(H2), (after.shape[1], after.shape[0]),
                           flags=cv2.INTER_LINEAR, borderValue=(255, 255, 255))
sig = lambda im: im[..., 2].astype(np.float32) - im[..., 0].astype(np.float32)  # red minus blue
sp, so = sig(plan), sig(after)
inked = (plan < 250).any(-1)
ys, xs = np.nonzero(inked); y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
print(f"chart area in after-scan: x {x0}-{x1}, y {y0}-{y1}")

M = int(0.7 * pitch)  # search radius: under half the checkerboard period, so no aliasing
def shift(r0, r1, c0, c1):
    A = sp[r0:r1, c0:c1]; B = so[r0 + M:r1 - M, c0 + M:c1 - M]
    R = cv2.matchTemplate(A, B, cv2.TM_CCOEFF_NORMED)
    iy, ix = np.unravel_index(R.argmax(), R.shape)
    def sub(v, k, n):  # parabolic sub-pixel refinement
        if 0 < k < n - 1:
            a, b, c = v; return k + 0.5 * (a - c) / (a - 2 * b + c)
        return k
    fx = sub(R[iy, ix - 1:ix + 2] if 0 < ix < R.shape[1] - 1 else None, ix, R.shape[1])
    fy = sub(R[iy - 1:iy + 2, ix] if 0 < iy < R.shape[0] - 1 else None, iy, R.shape[0])
    return M - fx, M - fy, R.max()

# sanity: known synthetic shift
so_real = so; so = np.roll(np.roll(sp, 7, 1), -4, 0)
print("self-test (expect +7,-4):", np.round(shift(y0, y1, x0, x1)[:2], 2)); so = so_real

dx, dy, r = shift(y0, y1, x0, x1)
print(f"\nWHOLE CHART: ink landed {dx * MM:+.2f} mm across (+ = right), {dy * MM:+.2f} mm down (+ = toward bottom)   [confidence {r:.2f}]")
n = a.tiles; tx = np.linspace(x0, x1, n + 1).astype(int); ty = np.linspace(y0, y1, n + 1).astype(int)
print(f"\nper tile ({n}x{n}), mm  (dx, dy):")
F = np.zeros((n, n, 2)); C = np.zeros((n, n, 2))
for i in range(n):
    row = []
    for j in range(n):
        dx, dy, r = shift(ty[i], ty[i + 1], tx[j], tx[j + 1]); F[i, j] = dx * MM, dy * MM
        C[i, j] = pa.to_page(H2, np.array([[(tx[j] + tx[j + 1]) / 2, (ty[i] + ty[i + 1]) / 2]]), (0, 0))[0]
        row.append(f"({dx * MM:+.2f},{dy * MM:+.2f})")
    print("  " + "  ".join(row))
mag = np.hypot(*F.reshape(-1, 2).T)
print(f"\ntile shift size: mean {mag.mean():.2f} mm, max {mag.max():.2f} mm   (stitch spacing {pitch * MM:.2f} mm; ink stays on the crossing while < ~{pitch * MM / 2:.2f} mm)")
# saved for fit_profile.py: page-px tile centres and measured shifts in mm
np.savez(Path(a.after).with_suffix('.shift.npz'), centres=C.reshape(-1, 2), shifts_mm=F.reshape(-1, 2))
