/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "#ffffff",
        "canvas-inset": "#f7f7f5",
        ink: "#000000",
        "ink-secondary": "#555555",
        "ink-muted": "#8b8b8b",
        surface: { DEFAULT: "#f8f8f7", elevated: "#f2f2f0", sidebar: "#f7f7f5" },
        hairline: { DEFAULT: "#e6e6e6", soft: "#f1f1f1" },
        accent: "#000000",
        severity: {
          critical: { DEFAULT: "#d73a31", subtle: "#fef2f2" },
          high: { DEFAULT: "#d97706", subtle: "#fffbea" },
          medium: { DEFAULT: "#b45309", subtle: "#fff8f0" },
          low: { DEFAULT: "#2563eb", subtle: "#eff6ff" },
          info: { DEFAULT: "#6b7280", subtle: "#f9fafb" },
        },
        status: { success: "#16a34a", error: "#d73a31", running: "#2563eb" },
      },
      fontFamily: {
        sans: ["Geist", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["JetBrains Mono", "Cascadia Code", "Consolas", "monospace"],
      },
      borderRadius: { pill: "50px", full: "9999px" },
    },
  },
  plugins: [],
};
