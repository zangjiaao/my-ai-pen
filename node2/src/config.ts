import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NODE2_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type Node2Config = {
  nodeName: string;
  nodeToken: string;
  platformWsUrl: string;
  workspaceDir: string;
  piAgentDir: string;
  pentestSkillsDir: string;
  pentestWorkflowsDir: string;
  pocCatalogPath: string;
  piWorkflowPackageDir: string;
  modelProvider: string;
  modelId: string;
  llmBaseUrl?: string;
  llmApi?: LlmApi;
  trafficProxyUrl?: string;
  externalTrafficSourceUrl?: string;
  externalTrafficSourceToken?: string;
  caidoBridgeAutoStart: boolean;
  caidoBridgeHost: string;
  caidoBridgePort?: number;
  caidoBridgePython?: string;
  caidoBridgeScript: string;
  caidoSidecarAutoStart: boolean;
  caidoSidecarImage: string;
  caidoSidecarHost: string;
  caidoSidecarPort?: number;
  caidoUrl?: string;
  scannerSandboxAutoStart: boolean;
  scannerSandboxImage: string;
};

export type LlmApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "azure-openai-responses";

export function loadConfig(): Node2Config {
  const modelProvider = process.env.PI_MODEL_PROVIDER || "openai";

  return {
    nodeName: process.env.NODE_NAME || "pentest-pi-01",
    nodeToken: process.env.NODE_TOKEN || "",
    platformWsUrl: process.env.PLATFORM_WS_URL || "ws://localhost:8000/ws",
    workspaceDir: resolve(process.env.NODE2_WORKSPACE || "./workspace"),
    piAgentDir: resolve(process.env.PI_AGENT_DIR || "./.pi-agent"),
    pentestSkillsDir: resolve(process.env.NODE2_SKILLS_DIR || resolve(NODE2_ROOT, "skills")),
    pentestWorkflowsDir: resolve(process.env.NODE2_WORKFLOWS_DIR || resolve(NODE2_ROOT, "workflows")),
    pocCatalogPath: resolve(process.env.NODE2_POC_CATALOG || resolve(NODE2_ROOT, "poc-catalog", "web-vulns.json")),
    piWorkflowPackageDir: resolve(
      process.env.PI_WORKFLOW_PACKAGE_DIR || resolve(NODE2_ROOT, "node_modules", "@agwab", "pi-workflow"),
    ),
    modelProvider,
    modelId: process.env.PI_MODEL || "gpt-5",
    llmBaseUrl: baseUrlForProvider(modelProvider),
    llmApi: llmApiForProvider(modelProvider),
    trafficProxyUrl: optionalEnv("NODE2_TRAFFIC_PROXY_URL") || optionalEnv("HTTP_PROXY") || optionalEnv("http_proxy"),
    externalTrafficSourceUrl: optionalEnv("NODE2_EXTERNAL_TRAFFIC_SOURCE_URL"),
    externalTrafficSourceToken: optionalEnv("NODE2_EXTERNAL_TRAFFIC_SOURCE_TOKEN"),
    caidoBridgeAutoStart: boolEnv("NODE2_CAIDO_BRIDGE_AUTO", false),
    caidoBridgeHost: optionalEnv("NODE2_CAIDO_BRIDGE_HOST") || "127.0.0.1",
    caidoBridgePort: optionalNumberEnv("NODE2_CAIDO_BRIDGE_PORT"),
    caidoBridgePython: optionalEnv("NODE2_CAIDO_BRIDGE_PYTHON"),
    caidoBridgeScript: resolve(optionalEnv("NODE2_CAIDO_BRIDGE_SCRIPT") || resolve(NODE2_ROOT, "bridges", "caido_traffic_bridge.py")),
    caidoSidecarAutoStart: boolEnv("NODE2_CAIDO_SIDECAR_AUTO", false),
    caidoSidecarImage: optionalEnv("NODE2_CAIDO_SIDECAR_IMAGE") || optionalEnv("STRIX_IMAGE") || "ghcr.io/usestrix/strix-sandbox:1.0.0",
    caidoSidecarHost: optionalEnv("NODE2_CAIDO_SIDECAR_HOST") || "127.0.0.1",
    caidoSidecarPort: optionalNumberEnv("NODE2_CAIDO_SIDECAR_PORT"),
    caidoUrl: optionalEnv("STRIX_CAIDO_URL"),
    scannerSandboxAutoStart: boolEnv("NODE2_SCANNER_SANDBOX_AUTO", true),
    scannerSandboxImage: optionalEnv("NODE2_SCANNER_SANDBOX_IMAGE") || optionalEnv("STRIX_IMAGE") || "ghcr.io/usestrix/strix-sandbox:1.0.0",
  };
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const value = optionalEnv(name);
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function optionalNumberEnv(name: string): number | undefined {
  const value = optionalEnv(name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function baseUrlForProvider(provider: string): string | undefined {
  const normalized = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return (
    process.env.LLM_BASE_URL ||
    process.env[`${normalized}_BASE_URL`] ||
    process.env.OPENAI_API_BASE ||
    process.env.ANTHROPIC_API_BASE ||
    undefined
  );
}

function llmApiForProvider(provider: string): LlmApi | undefined {
  const raw = process.env.LLM_API || process.env.LLM_API_TYPE;
  if (!raw && provider !== "custom") return undefined;
  return normalizeLlmApi(raw || "openai-completions");
}

function normalizeLlmApi(value: string): LlmApi {
  switch (value.trim().toLowerCase()) {
    case "openai-chat":
    case "openai-chat-completions":
    case "chat-completions":
    case "openai-completions":
      return "openai-completions";
    case "openai-response":
    case "openai-responses":
    case "responses":
      return "openai-responses";
    case "anthropic":
    case "anthropic-messages":
    case "claude":
      return "anthropic-messages";
    case "azure-openai-responses":
    case "azure-responses":
      return "azure-openai-responses";
    default:
      throw new Error(
        `Unsupported LLM_API "${value}". Use openai-completions, openai-responses, anthropic-messages, or azure-openai-responses.`,
      );
  }
}
