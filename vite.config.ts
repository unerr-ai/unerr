import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  // viteSingleFile inlines all JS + CSS into a single dist/ui/index.html so the
  // published npm tarball ships no loose minified .js chunks (those trip AV/EDR
  // base64/packaged-binary scanner heuristics). Public assets referenced by
  // absolute URL (/fonts/*, /icon*.png) stay external and are served statically.
  plugins: [react(), tailwindcss(), viteSingleFile()],
  root: "src/ui",
  publicDir: path.resolve(__dirname, "public"),
  build: {
    outDir: path.resolve(__dirname, "dist/ui"),
    emptyOutDir: true,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src/ui") },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:7655",
    },
  },
});
