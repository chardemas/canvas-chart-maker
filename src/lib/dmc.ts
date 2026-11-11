/**
 * DMC six-strand floss colours.
 * Data: craft-color-codes by MakeBead (https://makebead.com/), CC BY 4.0. Credit must stay visible in the app.
 */
import floss from "craft-color-codes/data/json/dmc-floss.json";
import { de2000, toLab, type Lab, type RGB } from "./color";

export interface Thread {
  code: string;
  name: string;
  rgb: RGB;
  lab: Lab;
}

export const DMC: Thread[] = (floss.colors as { code: string; name: string; rgb: number[] }[]).map(c => ({
  code: c.code,
  name: c.name,
  rgb: [c.rgb[0], c.rgb[1], c.rgb[2]],
  lab: toLab(c.rgb),
}));

const byCode = new Map(DMC.map(d => [d.code, d]));
export const threadByCode = (code: string): Thread | undefined => byCode.get(code);

/** The n DMC threads closest to a colour, nearest first. */
export function nearestDMC(rgb: readonly number[], n = 1): Thread[] {
  const lab = toLab(rgb);
  if (n === 1) {
    let best = DMC[0], bd = Infinity;
    for (const d of DMC) { const e = de2000(lab, d.lab); if (e < bd) { bd = e; best = d; } }
    return [best];
  }
  return DMC.map(d => [de2000(lab, d.lab), d] as const)
    .sort((a, b) => a[0] - b[0])
    .slice(0, n)
    .map(x => x[1]);
}

/** Other thread brands (e.g. Stitchly's "CC168") keep their own codes; DMC codes are numbers, B5200, Blanc, Ecru. */
export const isDmcCode = (code: string) => !/^[A-Za-z]{2,}\d+$/.test(code);
/** "DMC 892" for DMC threads, just the code ("CC168") for other brands. */
export const threadLabel = (t: { code: string }) => (isDmcCode(t.code) ? `DMC ${t.code}` : t.code);
