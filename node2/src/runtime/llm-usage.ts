/**
 * Aggregate LLM token usage and cost from Pi assistant messages.
 *
 * Pi populates `message.usage` (input/output/cache/reasoning + optional cost)
 * on each assistant `message_end`. This ledger sums those into the Node3-shaped
 * `llm_usage` object used by platform checkpoints / right panel.
 */

export type LlmCostRates = {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
  /** USD per 1M cache-read tokens */
  cacheRead: number;
  /** USD per 1M cache-write tokens */
  cacheWrite: number;
};

export type LlmUsageSnapshot = {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  cost: number;
  agent_count: number;
  model?: string;
  tool_calls?: number;
};

export type AssistantUsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

const ZERO_RATES: LlmCostRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function loadLlmCostRatesFromEnv(env: NodeJS.ProcessEnv = process.env): LlmCostRates {
  return {
    input: envNumber(env, "LLM_COST_INPUT_PER_MTOK", 0),
    output: envNumber(env, "LLM_COST_OUTPUT_PER_MTOK", 0),
    cacheRead: envNumber(env, "LLM_COST_CACHE_READ_PER_MTOK", envNumber(env, "LLM_COST_INPUT_PER_MTOK", 0)),
    cacheWrite: envNumber(env, "LLM_COST_CACHE_WRITE_PER_MTOK", envNumber(env, "LLM_COST_INPUT_PER_MTOK", 0)),
  };
}

export function hasPositiveCostRates(rates: LlmCostRates | undefined): boolean {
  if (!rates) return false;
  return rates.input > 0 || rates.output > 0 || rates.cacheRead > 0 || rates.cacheWrite > 0;
}

export function estimateUsageCost(usage: AssistantUsageLike, rates: LlmCostRates = ZERO_RATES): number {
  const input = nonNeg(usage.input);
  const output = nonNeg(usage.output);
  const cacheRead = nonNeg(usage.cacheRead);
  const cacheWrite = nonNeg(usage.cacheWrite);
  const dollars =
    (rates.input / 1_000_000) * input +
    (rates.output / 1_000_000) * output +
    (rates.cacheRead / 1_000_000) * cacheRead +
    (rates.cacheWrite / 1_000_000) * cacheWrite;
  return roundCost(dollars);
}

export class LlmUsageLedger {
  private requests = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedTokens = 0;
  private cacheWriteTokens = 0;
  private reasoningTokens = 0;
  private totalTokens = 0;
  private cost = 0;
  private model = "";

  constructor(private readonly rates: LlmCostRates = ZERO_RATES) {}

  /** Record usage from a Pi assistant message (message_end). */
  recordAssistantMessage(message: unknown): boolean {
    if (!message || typeof message !== "object") return false;
    const record = message as Record<string, unknown>;
    if (String(record.role || "") !== "assistant") return false;
    const usage = asUsage(record.usage);
    if (!usage) return false;

    const input = nonNeg(usage.input);
    const output = nonNeg(usage.output);
    const cacheRead = nonNeg(usage.cacheRead);
    const cacheWrite = nonNeg(usage.cacheWrite);
    const reasoning = nonNeg(usage.reasoning);
    const reportedTotal = nonNeg(usage.totalTokens);
    const summed = input + output + cacheRead + cacheWrite;
    const total = reportedTotal > 0 ? reportedTotal : summed;
    if (total <= 0 && this.messageCost(usage) <= 0) return false;

    this.requests += 1;
    this.inputTokens += input;
    this.outputTokens += output;
    this.cachedTokens += cacheRead;
    this.cacheWriteTokens += cacheWrite;
    this.reasoningTokens += reasoning;
    this.totalTokens += total;
    this.cost += this.messageCost(usage);

    const model = typeof record.model === "string" ? record.model : typeof record.responseModel === "string" ? record.responseModel : "";
    if (model) this.model = model;
    return true;
  }

  snapshot(extra: { agent_count?: number; tool_calls?: number } = {}): LlmUsageSnapshot {
    return {
      requests: this.requests,
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      cached_tokens: this.cachedTokens,
      cache_write_tokens: this.cacheWriteTokens,
      reasoning_tokens: this.reasoningTokens,
      total_tokens: this.totalTokens,
      cost: roundCost(this.cost),
      agent_count: extra.agent_count ?? 1,
      model: this.model || undefined,
      tool_calls: extra.tool_calls,
    };
  }

  /** Merge another snapshot into this ledger (e.g. worker session usage). */
  mergeSnapshot(snapshot: LlmUsageSnapshot | undefined | null): void {
    if (!snapshot) return;
    this.requests += nonNeg(snapshot.requests);
    this.inputTokens += nonNeg(snapshot.input_tokens);
    this.outputTokens += nonNeg(snapshot.output_tokens);
    this.cachedTokens += nonNeg(snapshot.cached_tokens);
    this.cacheWriteTokens += nonNeg(snapshot.cache_write_tokens);
    this.reasoningTokens += nonNeg(snapshot.reasoning_tokens);
    this.totalTokens += nonNeg(snapshot.total_tokens);
    this.cost += typeof snapshot.cost === "number" && Number.isFinite(snapshot.cost) ? snapshot.cost : 0;
    if (snapshot.model && !this.model) this.model = snapshot.model;
  }

  private messageCost(usage: AssistantUsageLike): number {
    const reported = usage.cost?.total;
    if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
      return roundCost(reported);
    }
    if (hasPositiveCostRates(this.rates)) {
      return estimateUsageCost(usage, this.rates);
    }
    return 0;
  }
}

/** Pure merge of Node3-shaped usage snapshots (main + workers). */
export function mergeLlmUsageSnapshots(
  parts: Array<LlmUsageSnapshot | undefined | null>,
  extra: { agent_count?: number; tool_calls?: number; model?: string } = {},
): LlmUsageSnapshot {
  let requests = 0;
  let input = 0;
  let output = 0;
  let cached = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  let total = 0;
  let cost = 0;
  let toolCalls = 0;
  let model = extra.model || "";
  let agentCount = 0;
  for (const part of parts) {
    if (!part) continue;
    requests += nonNeg(part.requests);
    input += nonNeg(part.input_tokens);
    output += nonNeg(part.output_tokens);
    cached += nonNeg(part.cached_tokens);
    cacheWrite += nonNeg(part.cache_write_tokens);
    reasoning += nonNeg(part.reasoning_tokens);
    total += nonNeg(part.total_tokens);
    cost += typeof part.cost === "number" && Number.isFinite(part.cost) ? part.cost : 0;
    toolCalls += nonNeg(part.tool_calls);
    agentCount += nonNeg(part.agent_count) || 0;
    if (!model && part.model) model = part.model;
  }
  return {
    requests,
    input_tokens: input,
    output_tokens: output,
    cached_tokens: cached,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: reasoning,
    total_tokens: total,
    cost: roundCost(cost),
    agent_count: extra.agent_count ?? Math.max(1, agentCount || 1),
    model: model || undefined,
    tool_calls: extra.tool_calls ?? (toolCalls > 0 ? toolCalls : undefined),
  };
}

function asUsage(value: unknown): AssistantUsageLike | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as AssistantUsageLike;
}

function nonNeg(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function roundCost(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 1_000_000) / 1_000_000;
}

function envNumber(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
