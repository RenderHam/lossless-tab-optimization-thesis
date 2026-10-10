import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json";

// Vite + CRXJS build for Manifest V3 extension.
// Service worker (background), content script, worker, and popup
// are all bundled deterministically — no remote code, no eval.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
  },
  worker: {
    format: "es",
  },
  plugins: [crx({ manifest })],
});
