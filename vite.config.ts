import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Relative base so the same bundle works from a sub-path, a file:// shell
  // (Capacitor) or the root of any static host.
  base: "./",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // See src/stubs/three.ts.
      three: fileURLToPath(new URL("./src/stubs/three.ts", import.meta.url)),
    },
  },
  server: { host: true, port: 5180 },
  preview: { host: true, port: 5180 },
});
