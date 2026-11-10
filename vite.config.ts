import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { designServer } from "./studio/designServer";

// `npm run ipad` serves over https on the home network, because the subject finder
// needs a secure connection (a plain http address on Wi-Fi doesn't count as one).
const ipad = process.env.IPAD === "1";
// `npm run studio` is the local-only version with Print on canvas and Design with Claude.
// The public site is built without STUDIO, so those features aren't even in its code.
const studio = process.env.STUDIO === "1";

export default defineConfig(({ mode }) => {
  // ANTHROPIC_API_KEY from .env.local stays in this Node process; only VITE_* values reach the browser
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [
      react(),
      ...(ipad ? [basicSsl({ name: "canvas-chart-maker" })] : []),
      ...(studio ? [designServer(env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY)] : []),
    ],
    define: { __STUDIO__: JSON.stringify(studio) },
    server: ipad ? { host: true, port: 5180, strictPort: true } : undefined,
    // ONNX Runtime finds its .wasm file next to itself; pre-bundling would break that
    optimizeDeps: { exclude: ["onnxruntime-web"] },
    worker: { format: "es" },
  };
});
