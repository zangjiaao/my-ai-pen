/**
 * Side-effect env loader — import before app graph so process.env is ready
 * when BrowserSandboxRuntime (or other singletons) first construct.
 *
 * Usage:
 *   tsx --import ./src/load-env.ts src/main.ts
 *   node --import ./dist/load-env.js dist/main.js
 *
 * main.ts still calls loadDotEnv() for paths that do not use --import.
 */
import { loadDotEnv } from "./env.js";

loadDotEnv();
loadDotEnv("node2/.env");
loadDotEnv("node4/.env");
