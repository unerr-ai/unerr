import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: "src/ui",
  publicDir: path.resolve(__dirname, "public"),
  build: {
    outDir: path.resolve(__dirname, "dist/ui"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes("vis-network") || id.includes("vis-data")) {
            return "vis-network";
          }
        },
      },
    },
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
