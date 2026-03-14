import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@assets": path.resolve(__dirname, "../assets") },
  },
  clearScreen: false,
  build: {
    minify: "esbuild",
    target: "es2020",
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/login": "http://localhost:8000",
      "/register": "http://localhost:8000",
      "/servers": "http://localhost:8000",
      "/users": "http://localhost:8000",
      "/channels": "http://localhost:8000",
      "/dm": "http://localhost:8000",
      "/invite": "http://localhost:8000",
      "/voice": "http://localhost:8000",
    },
  },
});
