import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NODE4_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type Node4Config = {
  nodeName: string;
  nodeToken: string;
  platformWsUrl: string;
  workspaceDir: string;
  piAgentDir: string;
  modelProvider: string;
  modelId: string;
  llmBaseUrl?: string;
  mainMaxTurns: number;
};

export function loadConfig(): Node4Config {
  const modelProvider = process.env.PI_MODEL_PROVIDER || "openai";
  return {
    nodeName: process.env.NODE_NAME || "pentest-node4-01",
    nodeToken: process.env.NODE_TOKEN || "",
    platformWsUrl: process.env.PLATFORM_WS_URL || "ws://localhost:8000/ws",
    workspaceDir: resolve(process.env.NODE4_WORKSPACE || process.env.NODE2_WORKSPACE || "./workspace"),
    piAgentDir: resolve(process.env.PI_AGENT_DIR || "./.pi-agent"),
    modelProvider,
    modelId: process.env.PI_MODEL || "gpt-5",
    llmBaseUrl: process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || undefined,
    mainMaxTurns: Math.max(5, Math.min(Number(process.env.NODE4_MAIN_MAX_TURNS || 200) || 200, 500)),
  };
}

export function node4Root(): string {
  return NODE4_ROOT;
}
