"""Fit a printer profile from one or more *.shift.npz files (written by measure_print.py).
Model: printed = planned + offset + small rotation/scale about the page centre (affine on page coords).
usage: fit_profile.py scans/test1_after.shift.npz scans/test2_after.shift.npz [--out printer_profile.json]"""
import sys, json, argparse
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import print_align as pa

ap = argparse.ArgumentParser(); ap.add_argument("files", nargs="+"); ap.add_argument("--out", default="printer_profile.json")
a = ap.parse_args()
C, S = [], []
for f in a.files:
    d = np.load(f); C.append(d["centres"]); S.append(d["shifts_mm"] / 25.4 * pa.DPI)
C, S = np.concatenate(C), np.concatenate(S)
c0 = np.array([pa.PAGE_W / 2, pa.PAGE_H / 2])
X = np.c_[C - c0, np.ones(len(C))]
sol, *_ = np.linalg.lstsq(X, S, rcond=None)   # shift = [x y 1] @ sol
res = S - X @ sol
J = sol[:2].T  # d(shift)/d(pos)
MM = 25.4 / pa.DPI
print(f"offset at page centre: {sol[2, 0] * MM:+.3f} mm across, {sol[2, 1] * MM:+.3f} mm down")
print(f"rotation {np.degrees((J[1, 0] - J[0, 1]) / 2):+.3f}°, scale x {J[0, 0] * 100:+.3f}% y {J[1, 1] * 100:+.3f}%")
print(f"left over after correcting: mean {np.hypot(*res.T).mean() * MM:.2f} mm, max {np.hypot(*res.T).max() * MM:.2f} mm "
      f"(from {len(a.files)} print(s))")
json.dump({"about": "printed = planned + A @ (p - centre) + t, page px at 600 dpi", "centre": c0.tolist(),
           "A": J.tolist(), "t": sol[2].tolist(), "from": a.files}, open(a.out, "w"), indent=1)
print(f"wrote {a.out}")
