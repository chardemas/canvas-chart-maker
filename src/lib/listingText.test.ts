import { describe, expect, it } from "vitest";
import { listingText, PAINTED, PRINTED, type ListingFields } from "./listingText";

const f: ListingFields = {
  name: "I'm an Angel!", kind: "Ornament", inspired: "Sonny Angel", about: "",
  canvas: "Zweigart mono deluxe canvas", margins: "1.5-3 in", offer: "both",
};

describe("Etsy listing text", () => {
  it("builds the title and design details from the chart", () => {
    const t = listingText(f, 79, 79, 18);
    expect(t.title).toBe("I'm an Angel! Ornament | Needlepoint Canvas | Sonny Angel Inspired");
    expect(t.description).toContain('Design size: 4.4" x 4.4" (79 x 79 stitches)');
    expect(t.description).toContain("Mesh: 18 count");
    expect(t.description).toContain("Margins may vary (1.5-3 in)");
    expect(t.description).toContain(PAINTED);
    expect(t.description).toContain(PRINTED);
  });
  it("shows only the option sold", () => {
    const t = listingText({ ...f, offer: "printed" }, 79, 79, 18);
    expect(t.description).toContain(PRINTED);
    expect(t.description).not.toContain(PAINTED);
    expect(t.tags).not.toContain("hand painted canvas");
  });
  it("keeps to Etsy's tag limits", () => {
    const t = listingText({ ...f, inspired: "A Very Long Inspiration Name" }, 79, 79, 18);
    expect(t.tags.length).toBeLessThanOrEqual(13);
    expect(t.tags.every(x => x.length <= 20)).toBe(true);
    expect(new Set(t.tags).size).toBe(t.tags.length);
  });
});
