import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" makes the bundle path-relative: it works from GitHub Pages
// subpaths, an enclave nginx root, or `python3 -m http.server` alike.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    target: "es2022",
    sourcemap: false,
  },
});
