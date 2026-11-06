import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

// `npm run ipad` serves over https on the home network, because the subject finder
// needs a secure connection (a plain http address on Wi-Fi doesn't count as one).
const ipad = process.env.IPAD === "1";

export default defineConfig({
  plugins: [react(), ...(ipad ? [basicSsl({ name: "canvas-chart-maker" })] : [])],
  server: ipad ? { host: true, port: 5180, strictPort: true } : undefined,
  // ONNX Runtime finds its .wasm file next to itself; pre-bundling would break that
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  worker: { format: "es" },
});
