/** Colour maths: hex conversion, brightness, CIELAB and the CIEDE2000 colour difference. */

export type RGB = [number, number, number];
export type Lab = [number, number, number];

export const hex = (c: readonly number[]): string =>
  "#" + c.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, "0")).join("");

export const fromHex = (h: string): RGB => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) as RGB;

/** Perceived brightness, 0–255. */
export const lum = (c: readonly number[]): number => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

/** Black or white text, whichever reads better on this colour. */
export const inkFor = (c: readonly number[]): string => (lum(c) > 140 ? "#000" : "#fff");

export const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

export function toLab(c: readonly number[]): Lab {
  const f = (v: number) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = f(c[0]), g = f(c[1]), b = f(c[2]);
  let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  let y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const t = (v: number) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  x = t(x); y = t(y); z = t(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIEDE2000 colour difference between two Lab colours (smaller = more alike). */
export function de2000(p: Lab, q: Lab): number {
  const rad = Math.PI / 180, cosd = (d: number) => Math.cos(d * rad);
  const [L1, a1, b1] = p, [L2, a2, b2] = q;
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1 = Math.hypot(a1p, b1), C2 = Math.hypot(a2p, b2);
  const hue = (x: number, y: number) => {
    if (!x && !y) return 0;
    const t = Math.atan2(y, x) / rad;
    return t < 0 ? t + 360 : t;
  };
  const h1 = hue(a1p, b1), h2 = hue(a2p, b2);
  let dh = 0;
  if (C1 * C2) { dh = h2 - h1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
  const dL = L2 - L1, dC = C2 - C1, dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh * rad) / 2);
  const Lb = (L1 + L2) / 2, Cbp = (C1 + C2) / 2;
  let hb = h1 + h2;
  if (C1 * C2) { if (Math.abs(h1 - h2) > 180) hb += hb < 360 ? 360 : -360; hb /= 2; }
  const T = 1 - 0.17 * cosd(hb - 30) + 0.24 * cosd(2 * hb) + 0.32 * cosd(3 * hb + 6) - 0.2 * cosd(4 * hb - 63);
  const dt = 30 * Math.exp(-(((hb - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2), Sc = 1 + 0.045 * Cbp, Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dt * rad) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}
