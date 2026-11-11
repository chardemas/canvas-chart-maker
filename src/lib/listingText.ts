/**
 * Etsy listing text (title, description, tags) for a design, in the shop's usual format.
 * Sizes come from the chart, so they always match the canvas being sold.
 */
export type Offer = "both" | "painted" | "printed";

export interface ListingFields {
  name: string;      // "I'm an Angel!"
  kind: string;      // "Ornament"
  inspired: string;  // "Sonny Angel" (adds "Sonny Angel Inspired" to the title)
  about: string;     // optional opening line about the design
  canvas: string;    // "Zweigart mono deluxe canvas"
  margins: string;   // "1.5-3 in"
  offer: Offer;
}

export interface ListingText { title: string; description: string; tags: string[] }

export const PAINTED = "Hand-painted: Carefully stitch painted for an easy stitching experience!";
export const PRINTED = "Printed: The exact same design as the stitch-painted version, printed with my own alignment process. "
  + "Before printing, I scan each blank canvas and fit the design to that canvas's mesh, so the colours land on the "
  + "intersections and every colour edge is clear and easy to follow.";

const inches = (stitches: number, mesh: number) => `${Math.round((stitches / mesh) * 10) / 10}"`;

export function listingText(f: ListingFields, W: number, H: number, mesh: number): ListingText {
  const name = f.name.trim(), kind = f.kind.trim(), inspired = f.inspired.trim().replace(/\s+inspired$/i, "");

  let title = [name, kind].filter(Boolean).join(" ") || "Needlepoint Design";
  title += " | Needlepoint Canvas";
  if (inspired) title += ` | ${inspired} Inspired`;
  title = title.slice(0, 140); // Etsy's limit

  const details = [
    `Mesh: ${mesh} count`,
    `Design size: ${inches(W, mesh)} x ${inches(H, mesh)} (${W} x ${H} stitches)`,
    f.canvas.trim(),
    f.margins.trim() && `Margins may vary (${f.margins.trim()})`,
  ].filter(Boolean).map(l => `     ${l}`);

  const parts: string[] = [];
  if (f.about.trim()) parts.push(f.about.trim());
  parts.push(["🎨 Design Details", ...details].join("\n"));
  if (f.offer === "both") parts.push(["🎨 Option to choose hand-painted or printed design", PAINTED, PRINTED].join("\n"));
  else parts.push(`🎨 ${f.offer === "painted" ? PAINTED : PRINTED}`);
  parts.push("Every canvas is reviewed to ensure the best stitch and color quality 🩵🪡");

  const painted = f.offer !== "printed", printed = f.offer !== "painted", k = kind.toLowerCase();
  const candidates = [
    "needlepoint canvas", `${mesh} mesh canvas`,
    painted && "hand painted canvas", printed && "printed needlepoint",
    k && `needlepoint ${k}`, k && `${k} canvas`,
    painted && "stitch painted", inspired.toLowerCase(),
    /zweigart/i.test(f.canvas) && "zweigart canvas",
    "modern needlepoint", "needlepoint gift", "needlework", "cute needlepoint", "needlepoint design",
  ];
  // Etsy: up to 13 tags, 20 characters each
  const tags = [...new Set(candidates.filter((t): t is string => !!t && t.length <= 20))].slice(0, 13);

  return { title, description: parts.join("\n\n"), tags };
}
