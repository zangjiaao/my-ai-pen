/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: "var(--color-canvas)",
        "canvas-inset": "var(--color-canvas-inset)",
        ink: "var(--color-ink)",
        "ink-secondary": "var(--color-ink-secondary)",
        "ink-muted": "var(--color-ink-muted)",
        surface: {
          DEFAULT: "var(--color-surface)",
          elevated: "var(--color-surface-elevated)",
          sidebar: "var(--color-surface-sidebar)",
        },
        hairline: {
          DEFAULT: "var(--color-hairline)",
          soft: "var(--color-hairline-soft)",
        },
        accent: {
          DEFAULT: "var(--color-accent)",
          subtle: "var(--color-accent-subtle)",
        },
        "on-ink": "var(--color-on-ink)",
        overlay: "var(--color-overlay)",
        severity: {
          critical: { DEFAULT: "var(--color-severity-critical)", subtle: "var(--color-severity-critical-subtle)" },
          high: { DEFAULT: "var(--color-severity-high)", subtle: "var(--color-severity-high-subtle)" },
          medium: { DEFAULT: "var(--color-severity-medium)", subtle: "var(--color-severity-medium-subtle)" },
          low: { DEFAULT: "var(--color-severity-low)", subtle: "var(--color-severity-low-subtle)" },
          info: { DEFAULT: "var(--color-severity-info)", subtle: "var(--color-severity-info-subtle)" },
        },
        status: {
          success: "var(--color-status-success)",
          error: "var(--color-status-error)",
          running: "var(--color-status-running)",
        },
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
