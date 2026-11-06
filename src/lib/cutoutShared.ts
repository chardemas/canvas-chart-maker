/** Shared between the page and the subject-finder worker. */
export const MODEL_SIDE = 512;

export type CutoutMsg =
  | { type: "progress"; pct: number; stage: "download" | "working" }
  | { type: "done"; id: number; mask: Uint8Array; w: number; h: number }
  | { type: "error"; id: number; message: string; gpuFailed: boolean };
