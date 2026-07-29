import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendUrl = env.VITE_BACKEND_URL || "http://localhost:8000";

  return {
    plugins: [
      react(),
      // Cloudflare Access: module scripts with crossorigin=anonymous omit cookies, so
      // CF Access returns 302 HTML for /assets/*.js → white screen after Access login.
      // Same-origin app does not need CORS mode for these tags.
      {
        name: "strip-crossorigin-for-cf-access",
        transformIndexHtml(html) {
          return html.replace(/\s+crossorigin(?:="[^"]*")?/gi, "");
        },
      },
    ],
    server: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
      // WSL/Windows browser often keeps stale modules; never cache in dev.
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
      },
      // Reliable FS events on /mnt/* mounts.
      watch: {
        usePolling: true,
        interval: 800,
      },
      proxy: {
        "/api": backendUrl,
      },
    },
  };
});
