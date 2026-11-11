/**
 * Studio only (never on the public site): POST /api/design on the local dev server asks Claude to draw
 * a clean, flat needlepoint design as SVG, one SVG unit per stitch. The API key stays in this Node
 * process (read from .env.local or the environment) and is never sent to the browser.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface DesignRequest {
  description: string;
  /** inspiration photos, base64 without the data: prefix */
  images: { mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; data: string }[];
  /** design size in stitches */
  W: number;
  H: number;
  colours: number;
  /** for "change it": the last design and what to change */
  previous?: { svg: string; feedback: string };
}

export interface DesignReply { svg: string; notes: string }

/** What the server streams back, one JSON object per line. */
export type DesignEvent =
  | { type: "progress"; stage: "thinking" | "drawing"; chars: number }
  | { type: "done"; svg: string; notes: string }
  | { type: "error"; error: string };

const SYSTEM = `You design needlepoint canvases for a small business that sells hand-painted needlepoint designs.

You draw each design as a single SVG on a stitch grid: one SVG unit is one stitch on the canvas. The SVG is later turned into a stitch chart by sampling one colour per unit square and matching each colour to a DMC thread, so draw in a way that survives that:
- Flat fills only: no gradients, patterns, filters, blur, shadows, opacity, or strokes thinner than 1 unit. Prefer filled shapes to strokes.
- Keep details at least 1 unit wide and gaps at least 1 unit wide; anything smaller disappears or turns muddy when stitched.
- Use at most the requested number of distinct colours, chosen to read well as thread (clear contrast between neighbouring areas, no near-duplicate shades).
- Leave the background unpainted (transparent) unless the brief asks for a background; unpainted squares stay as bare canvas.
- Lettering should be bold and at least 7 units tall per capital letter, drawn as filled shapes or with a common bold sans-serif font.
- Fill the grid well, with a small margin, and keep the design centred.

The look should be clean and charming, in the style of contemporary hand-painted needlepoint canvases: confident shapes, a cohesive palette, and nothing fussy.

Reply with the SVG (an <svg> element whose viewBox is "0 0 W H" for the requested size), then one or two short sentences about the design and its palette.`;

function brief(r: DesignRequest): string {
  const lines = [
    `Size: ${r.W} × ${r.H} stitches, so use viewBox="0 0 ${r.W} ${r.H}".`,
    `Colours: at most ${r.colours}.`,
    r.description.trim() ? `Brief: ${r.description.trim()}` : "Brief: make a design inspired by the attached photos.",
  ];
  if (r.images.length) lines.push(`The ${r.images.length === 1 ? "photo is" : `${r.images.length} photos are`} inspiration for subject, palette and mood; simplify rather than copy.`);
  if (r.previous) lines.push(`Here is the previous version:\n${r.previous.svg}\n\nChange it like this, keeping everything else: ${r.previous.feedback.trim()}`);
  return lines.join("\n\n");
}

export async function design(client: Anthropic, r: DesignRequest, progress: (e: DesignEvent) => void = () => {}): Promise<DesignReply> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...r.images.map(im => ({ type: "image" as const, source: { type: "base64" as const, media_type: im.mediaType, data: im.data } })),
    { type: "text", text: brief(r) },
  ];
  const stream = client.beta.messages.stream({
    model: "claude-opus-5-5",
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    // medium (this model's default) keeps a design to roughly a minute; high thinks longer for little visible gain here
    output_config: { effort: "medium" },
    // if a safety check declines, the API re-runs the request on a fallback model instead of failing
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [{ role: "user", content }],
  });
  let last = 0;
  stream.on("streamEvent", ev => {
    if (ev.type === "content_block_start" && ev.content_block.type === "thinking") progress({ type: "progress", stage: "thinking", chars: 0 });
  });
  stream.on("text", (_d, snap) => {
    const now = Date.now();
    if (now - last > 400) { last = now; progress({ type: "progress", stage: "drawing", chars: snap.length }); }
  });
  const t0 = Date.now();
  const msg = await stream.finalMessage();
  console.log(`[design] ${r.W}×${r.H}, ${r.images.length} photo(s): ${((Date.now() - t0) / 1000).toFixed(0)} s, ${msg.usage.output_tokens} output tokens, stop ${msg.stop_reason}`);
  if (msg.stop_reason === "refusal") throw new Error("Claude declined to draw this one. Try describing it differently.");
  const text = msg.content.map(b => (b.type === "text" ? b.text : "")).join("\n");
  const svg = text.match(/<svg[\s\S]*<\/svg>/i)?.[0];
  if (!svg) throw new Error(msg.stop_reason === "max_tokens" ? "The design came out too long. Try a simpler brief." : "Claude didn't return a drawing. Try again.");
  const notes = text.replace(svg, "").replace(/```(?:svg|xml)?/g, "").trim().slice(0, 600);
  return { svg, notes };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    const parts: Buffer[] = [];
    req.on("data", c => parts.push(c as Buffer));
    req.on("end", () => ok(Buffer.concat(parts).toString("utf8")));
    req.on("error", fail);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/** Vite plugin adding POST /api/design to the Studio dev server. */
export function designServer(apiKey: string | undefined): Plugin {
  return {
    name: "studio-design-server",
    configureServer(server) {
      server.middlewares.use("/api/design", async (req, res) => {
        if (req.method !== "POST") return send(res, 405, { error: "POST only" });
        if (!apiKey) return send(res, 500, { error: "No Claude API key yet. Add ANTHROPIC_API_KEY to .env.local in the project folder, then restart npm run studio." });
        let r: DesignRequest;
        try { r = JSON.parse(await readBody(req)) as DesignRequest; } catch { return send(res, 400, { error: "Bad request." }); }
        const W = Math.round(r.W), H = Math.round(r.H);
        if (!(W >= 4 && W <= 300 && H >= 4 && H <= 300)) return send(res, 400, { error: "Size must be 4 to 300 stitches each way." });
        // stream progress lines so the page can show what's happening
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/x-ndjson");
        const line = (e: DesignEvent) => res.write(JSON.stringify(e) + "\n");
        try {
          const reply = await design(new Anthropic({ apiKey }), { ...r, W, H, colours: Math.min(30, Math.max(2, Math.round(r.colours))), images: (r.images ?? []).slice(0, 4) }, line);
          line({ type: "done", ...reply });
        } catch (e) {
          const msg = e instanceof Anthropic.AuthenticationError ? "The Claude API key in .env.local was rejected."
            : e instanceof Anthropic.RateLimitError ? "Claude is busy right now (rate limit). Wait a minute and try again."
            : e instanceof Anthropic.APIError ? `Claude API error ${e.status}: ${e.message}`
            : (e as Error).message;
          line({ type: "error", error: msg });
        }
        res.end();
      });
    },
  };
}
