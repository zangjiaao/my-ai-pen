import fs from "node:fs";
import path from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** Strip Vite-injected crossorigin on module/CSS so CF Access cookies ride along. */
function stripCrossoriginForCfAccess(): Plugin {
  const strip = (html: string) =>
    html
      .replace(/(<script\b[^>]*?)\s+crossorigin(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, "$1")
      .replace(
        /(<link\b[^>]*\brel=["']stylesheet["'][^>]*?)\s+crossorigin(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi,
        "$1",
      )
      .replace(
        /(<link\b[^>]*\bcrossorigin(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*\brel=["']stylesheet["'])/gi,
        (m) => m.replace(/\s+crossorigin(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, ""),
      );

  return {
    name: "strip-crossorigin-for-cf-access",
    // HTML pipeline (may run before Vite injects module tags in some versions).
    transformIndexHtml: {
      order: "post",
      handler(html) {
        return strip(html);
      },
    },
    // Guaranteed: rewrite written dist/index.html after emit.
    closeBundle() {
      const outDir = path.resolve(process.cwd(), "dist");
      const indexPath = path.join(outDir, "index.html");
      if (!fs.existsSync(indexPath)) return;
      const before = fs.readFileSync(indexPath, "utf8");
      const after = strip(before);
      if (after !== before) fs.writeFileSync(indexPath, after);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendUrl = env.VITE_BACKEND_URL || "http://localhost:8000";

  return {
    plugins: [
      react(),
      // Cloudflare Access: Vite injects crossorigin on module/css (credentials omit),
      // so Access JWT cookies are not sent for /assets/* → 302 HTML → white screen.
      // Keep fonts preconnect crossorigin. closeBundle rewrites dist as a safety net.
      stripCrossoriginForCfAccess(),
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
