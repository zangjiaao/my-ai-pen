import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendUrl = env.VITE_BACKEND_URL || "http://localhost:8000";

  return {
    plugins: [react()],
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
