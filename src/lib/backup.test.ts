import { describe, expect, it } from "vitest";
import { pack, unpack } from "./backup";

describe("backup files", () => {
  it("ticks and repainted squares survive the round trip exactly", () => {
    const done = new Uint8Array(70001).map((_, i) => (i * 7) % 3 === 0 ? 1 : 0);
    const idx = new Int16Array([-1, 0, 5, 32000, -32000, 3]);
    const prog = { done, idx, edits: [{ rgb: [1, 2, 3], code: "310", sym: "●" }] };
    const back = unpack(JSON.parse(JSON.stringify(pack({ "prog:x": prog })))) as { "prog:x": typeof prog };
    expect(back["prog:x"].done).toBeInstanceOf(Uint8Array);
    expect(back["prog:x"].idx).toBeInstanceOf(Int16Array);
    expect(Array.from(back["prog:x"].done)).toEqual(Array.from(done));
    expect(Array.from(back["prog:x"].idx)).toEqual(Array.from(idx));
    expect(back["prog:x"].edits).toEqual(prog.edits);
  });
});
