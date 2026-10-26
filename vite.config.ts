import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig(({ command, mode }) => {
  // Dashboard the dev proxy talks to. The login needs a cookie between two
  // requests, which a cross-origin fetch can't keep, so in the browser the
  // app reaches the dashboard same-origin under /hermes-dashboard.
  //   HERMES_DASHBOARD=http://192.168.0.107:9119 pnpm dev
  const env = { ...process.env, ...loadEnv(mode, process.cwd(), "HERMES_") };
  const dashboard = (env.HERMES_DASHBOARD || "http://127.0.0.1:9119").replace(/\/+$/, "");
  const dashboardProxy = {
    "/hermes-dashboard": {
      target: dashboard,
      // The dashboard rejects a Host that isn't the address it is bound to.
      changeOrigin: true,
      ws: true,
      rewrite: (p: string) => p.replace(/^\/hermes-dashboard/, "") || "/",
      configure: (proxy: {
        on: (ev: "proxyReq" | "proxyReqWs", cb: (req: { removeHeader: (h: string) => void }) => void) => void;
      }) => {
        // Server-to-server, like the desktop and the native socket: a LAN Origin
        // (the tablet hitting this dev server by IP) fails the dashboard's
        // localhost-only CORS, and /api/ws refuses any Origin that isn't the
        // address the dashboard is bound to.
        const strip = (req: { removeHeader: (h: string) => void }) => {
          req.removeHeader("origin");
          req.removeHeader("referer");
        };
        proxy.on("proxyReq", strip);
        proxy.on("proxyReqWs", strip);
      },
    },
  };

  return {
    plugins: [react(), tailwindcss()],
    // Relative base so the same bundle works from a sub-path, a file:// shell
    // (Capacitor) or the root of any static host.
    base: "./",
    define: {
      __HERMES_DASHBOARD_PROXY__: JSON.stringify(command === "serve" ? dashboard : null),
    },
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
        // See src/stubs/three.ts.
        three: fileURLToPath(new URL("./src/stubs/three.ts", import.meta.url)),
      },
    },
    server: { host: true, port: 5180, proxy: dashboardProxy },
    preview: { host: true, port: 5180 },
  };
});
