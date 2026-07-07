import { useState, type ReactNode } from "react";
import { Brain, Compass, Globe2, Search, ShieldAlert, Terminal, Users, Wrench, type LucideIcon } from "lucide-react";
import type { Message } from "../lib/types";
import type { SecurityAsset, SecurityEvidence, SecurityVulnerability } from "../lib/securityTypes";
import { normalizeExecutionStatus } from "../lib/status";
import { phaseLabel } from "../lib/phase";
import ConfirmCard from "./cards/ConfirmCard";
import ThinkingCard from "./cards/ThinkingCard";

interface Props {
  message: Message;
  agentNameById?: Record<string, string>;
  previousMessage?: Message;
  fallbackPentestNodeId?: string | null;
  platformAgentNodeId?: string | null;
  onDecision?: (requestId: string, decision: "authorize" | "cancel") => void;
  onOpenVulnerability?: (finding: Partial<SecurityVulnerability>) => void;
  onOpenAsset?: (asset: Partial<SecurityAsset>) => void;
  onOpenEvidence?: (evidence: Partial<SecurityEvidence>) => void;
  highlightedApprovalId?: string | null;
  approvalDecisionByRequestId?: Record<string, "authorize" | "cancel">;
}

type TableAlignment = "left" | "center" | "right";

type MarkdownBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; language: string; text: string }
  | { type: "quote"; text: string }
  | { type: "table"; headers: string[]; alignments: TableAlignment[]; rows: string[][] };

function agentDisplayName(content: Record<string, unknown>, agentNameById: Record<string, string>, fallbackPentestNodeId?: string | null, platformAgentNodeId?: string | null): string {
  const source = String(content.agent_source || "pentest");
  const mode = String(content.agent_mode || "");
  const explicitNodeId = typeof content.agent_node_id === "string" ? content.agent_node_id : "";
  const fallbackNodeId = source === "platform" ? platformAgentNodeId : fallbackPentestNodeId;
  const nodeId = explicitNodeId || fallbackNodeId || "";
  const baseName = nodeId && agentNameById[nodeId] ? agentNameById[nodeId] : source === "platform" ? "\u5e73\u53f0Agent" : "\u6e17\u900fAgent";
  return baseName;
}
function ToolCallCard({ content, onOpenEvidence }: { content: Record<string, unknown>; onOpenEvidence?: (evidence: Partial<SecurityEvidence>) => void }) {
  const [expanded, setExpanded] = useState(false);
  const toolNames = toolNamesFromContent(content);
  const primaryTool = toolNames[0] || "tool";
  const latestTool = String(content.latest_tool_name || content.tool_name || primaryTool);
  const status = normalizeExecutionStatus(content.status);
  const stdout = content.stdout as string || "";
  const items = toolItemsFromContent(content);
  const category = toolPrimaryCategory(toolNames, items.map(item => item.category || ""));
  const fallbackSummary = summarizeToolOutput(stdout, latestTool);
  const resultSummary = summarizeToolActivity(items, latestTool, status);
  return (
    <div data-testid="tool-card" className="my-2 min-w-0 max-w-full rounded-md bg-surface-default/70">
      <button
        data-testid="tool-card-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
        className="flex w-full min-w-0 items-center gap-1.5 py-1.5 text-left transition-colors hover:bg-canvas-inset"
      >
        <div className="flex flex-shrink-0 items-center gap-1">
          <ToolCategoryIcon category={category} />
        </div>
        <span className="min-w-0 max-w-[34%] flex-shrink truncate font-sans text-sm text-ink-secondary">{toolTitle(toolNames)}</span>
        <span className="min-w-0 truncate text-xs text-ink-secondary">{resultSummary}</span>
        <span className="min-w-6 flex-1" aria-hidden="true" />
      </button>
      {expanded && (
        <div className="ml-7 space-y-0.5 pb-1">
          {items.length ? items.map((item, index) => (
            <ToolItemRow key={`${item.runId || item.evidenceId || index}-${index}`} item={item} onOpenEvidence={onOpenEvidence} />
          )) : (
            <div className="rounded-sm bg-canvas-inset px-3 py-1.5 text-xs text-ink-secondary">{fallbackSummary}</div>
          )}
        </div>
      )}
    </div>
  );
}

type ToolItem = {
  toolName: string;
  status: string;
  summary: string;
  category?: string;
  target?: string;
  evidenceId?: string;
  runId?: string;
  command?: string;
  result?: Record<string, unknown>;
};

function ToolItemRow({ item, onOpenEvidence }: { item: ToolItem; onOpenEvidence?: (evidence: Partial<SecurityEvidence>) => void }) {
  const status = normalizeExecutionStatus(item.status);
  const statusColor = status === "running" ? "bg-status-running" : status === "done" ? "bg-status-success" : "bg-status-error";
  const showCommand = isCommandToolName(item.toolName) && Boolean(item.command);
  const primaryText = showCommand ? item.command || item.summary : item.summary;
  const secondaryText = showCommand && item.summary && item.summary !== item.command ? item.summary : "";
  const evidenceButton = item.evidenceId ? (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpenEvidence?.({ evidence_id: item.evidenceId, id: item.evidenceId, source_tool: item.toolName, tool_run_id: item.runId, summary: item.summary, type: "tool_output" });
      }}
      className="ml-2 shrink-0 whitespace-nowrap text-xs text-ink-muted underline underline-offset-2 hover:text-ink"
    >
      Evidence
    </button>
  ) : null;
  return (
    <div className="flex min-w-0 items-start gap-2 py-1 text-xs">
      <span className={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${statusColor}`} />
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`block min-w-0 max-w-full truncate ${showCommand ? "font-mono text-[11px] text-ink-secondary" : "text-ink-muted"}`}>{primaryText}</span>
          {item.target && <span className="hidden shrink truncate font-mono text-[11px] text-ink-muted md:block">{item.target}</span>}
        </div>
        {secondaryText && <div className="mt-0.5 truncate text-[11px] text-ink-muted">{secondaryText}</div>}
      </div>
      {evidenceButton}
    </div>
  );
}
type ToolCategory = { key: string; label: string; Icon: LucideIcon };

function ToolCategoryIcon({ category }: { category: ToolCategory }) {
  const Icon = category.Icon;
  return (
    <span title={category.label} className="inline-flex h-5 w-5 items-center justify-center text-ink-muted">
      <Icon size={15} />
    </span>
  );
}

function summarizeToolActivity(items: ToolItem[], fallbackTool: string, aggregateStatus: string): string {
  const candidates: ToolItem[] = items.length ? items : [{ toolName: fallbackTool, status: aggregateStatus, summary: "" }];
  const successful = candidates.filter(isSuccessfulToolItem);
  if (!successful.length) {
    if (candidates.some(item => normalizeExecutionStatus(item.status) === "running")) return "\u6267\u884c\u4e2d";
    return "\u5931\u8d25";
  }

  const toolName = successful[successful.length - 1]?.toolName || fallbackTool;
  const lower = toolName.toLowerCase();
  const count = successful.length;
  if (/browser|explore|crawl/.test(lower)) return `\u5df2\u6d4f\u89c8${count}\u4e2a\u7f51\u9875`;
  if (/http|request|replay|fetch|curl/.test(lower)) return `\u5df2\u8bf7\u6c42${count}\u6b21`;
  if (/stdin|command input|\binput\b/.test(lower)) return `\u5df2\u53d1\u9001${count}\u6b21\u8f93\u5165`;
  if (/execute|command|shell|docker|process/.test(lower)) return `\u5df2\u6267\u884c${count}\u6761\u547d\u4ee4`;
  if (/finding|vuln|verify|evidence|confirm/.test(lower)) return `\u5df2\u5904\u7406${count}\u6761\u7ed3\u679c`;
  if (/search|scan|dir|wordlist|enumerate/.test(lower)) return `\u5df2\u679a\u4e3e${count}\u6b21`;
  return `\u5df2\u5b8c\u6210${count}\u6b21`;
}

function isSuccessfulToolItem(item: ToolItem): boolean {
  const primaryStatus = String(item.status || "").trim().toLowerCase();
  if (primaryStatus && normalizeExecutionStatus(primaryStatus) !== "running") return isSuccessfulStatus(primaryStatus);
  return [item.result?.status, item.result?.status_code].some(isSuccessfulStatus);
}

function isSuccessfulStatus(value: unknown): boolean {
  const status = String(value || "").trim().toLowerCase();
  if (["done", "ok", "success", "completed", "complete", "saved", "loaded"].includes(status)) return true;
  if (/^\d{3}$/.test(status)) return Number(status) < 400;
  return normalizeExecutionStatus(status) === "done";
}

function toolItemFromStructuredRecord(item: Record<string, unknown>, content: Record<string, unknown>): ToolItem {
  const rawToolName = readContentString(item.tool_name) || readContentString(content.tool_name) || "tool";
  const toolName = displayToolName(rawToolName, readContentString(item.display_title) || readContentString(content.display_title));
  const stdout = readContentString(item.stdout);
  const output = parseToolOutput(stdout);
  const explicitResult = item.result && typeof item.result === "object" && !Array.isArray(item.result) ? item.result as Record<string, unknown> : null;
  const parsed = explicitResult || output.result;
  const status = readContentString(item.status) || readContentString(parsed?.status) || readContentString(content.status) || "done";
  const command = readContentString(item.command) || readContentString(parsed?.command);
  const evidenceId = readContentString(item.evidence_id) || output.evidenceId || readContentString(parsed?.evidence_id) || readContentString(content.evidence_id);
  const summary = readContentString(item.summary) || readContentString(content.summary);
  return {
    toolName,
    status,
    summary: summary || summarizeToolItem(toolName, status, parsed, stdout, command),
    category: readContentString(item.category) || readContentString(content.category),
    target: readContentString(item.target) || readContentString(parsed?.target) || readContentString(parsed?.url) || readContentString(parsed?.title),
    evidenceId,
    runId: readContentString(item.tool_run_id) || readContentString(content.tool_run_id),
    command,
    result: parsed || undefined,
  };
}

function mergeToolItems(items: ToolItem[]): ToolItem[] {
  const merged: ToolItem[] = [];
  const byRunId = new Map<string, number>();
  for (const item of items) {
    const key = item.runId || "";
    if (!key || !byRunId.has(key)) {
      if (key) byRunId.set(key, merged.length);
      merged.push(item);
      continue;
    }
    const index = byRunId.get(key)!;
    const previous = merged[index];
    merged[index] = {
      ...previous,
      ...item,
      evidenceId: item.evidenceId || previous.evidenceId,
      command: item.command || previous.command,
      result: item.result || previous.result,
      summary: item.summary || previous.summary,
      status: item.status || previous.status,
    };
  }
  return merged;
}

function parseToolOutput(stdout: string): { result: Record<string, unknown> | null; evidenceId: string } {
  const evidenceId = stdout.match(/(?:^|\n)\s*EVIDENCE_ID:\s*([^\s]+)/i)?.[1] || "";
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (/^EVIDENCE_ID:/i.test(line) || line.endsWith("...")) continue;
    const parsed = parseLooseObject(line);
    if (parsed) return { result: parsed, evidenceId };
  }
  return { result: parseLooseObject(stdout), evidenceId };
}
function toolItemsFromContent(content: Record<string, unknown>): ToolItem[] {
  const structured = Array.isArray(content.tool_items)
    ? content.tool_items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
  if (structured.length) {
    return mergeToolItems(structured.map(item => toolItemFromStructuredRecord(item, content)));
  }

  if (readContentString(content.tool_run_id) || readContentString(content.tool_name)) {
    return [toolItemFromStructuredRecord(content, content)];
  }

  const stdout = String(content.stdout || "");
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const toolNames = toolNamesFromContent(content);
  const runIds = Array.isArray(content.tool_run_ids) ? content.tool_run_ids.map(item => String(item || "")) : [String(content.tool_run_id || "")];
  const commands = readContentString(content.command).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const fallbackTool = String(content.latest_tool_name || content.tool_name || toolNames[0] || "tool");
  const fallbackStatus = String(content.status || "done");
  const items = lines
    .filter(line => !line.endsWith("..."))
    .map((line, index) => toolItemFromLine(line, {
      fallbackTool: toolNames[index] || fallbackTool,
      fallbackStatus,
      fallbackCommand: commands[index] || commands[commands.length - 1] || "",
      runId: runIds[index] || runIds[runIds.length - 1] || "",
    }))
    .filter((item): item is ToolItem => Boolean(item));
  if (items.length) return items;
  return [{ toolName: displayToolName(fallbackTool), status: fallbackStatus, summary: summarizeToolItem(fallbackTool, fallbackStatus, null, stdout, commands[0] || ""), evidenceId: readContentString(content.evidence_id), runId: readContentString(content.tool_run_id), command: commands[0] || "" }];
}

function summarizeToolLine(line: string, latestTool: string): string {
  if (!line) return "Started tool call";
  const parsed = parseLooseObject(line);
  if (parsed) return summarizeToolItem(latestTool, readContentString(parsed.status) || readContentString(parsed.status_code), parsed, line, readContentString(parsed.command));
  return stripJsonNoise(line);
}
function toolItemFromLine(line: string, fallback: { fallbackTool: string; fallbackStatus: string; fallbackCommand: string; runId: string }): ToolItem | null {
  const parsed = parseLooseObject(line);
  if (parsed) {
    const toolName = displayToolName(readContentString(parsed.tool_name) || readContentString(parsed.source_tool) || fallback.fallbackTool);
    const status = readContentString(parsed.status) || readContentString(parsed.status_code) || fallback.fallbackStatus;
    const command = readContentString(parsed.command) || fallback.fallbackCommand;
    return {
      toolName,
      status,
      summary: summarizeToolItem(toolName, status, parsed, line, command),
      evidenceId: readContentString(parsed.evidence_id) || readContentString(parsed.EVIDENCE_ID),
      runId: readContentString(parsed.tool_run_id) || fallback.runId,
      command,
      result: parsed,
      target: readContentString(parsed.target) || readContentString(parsed.url) || readContentString(parsed.title),
    };
  }
  return {
    toolName: displayToolName(fallback.fallbackTool),
    status: fallback.fallbackStatus,
    summary: fallback.fallbackCommand || stripJsonNoise(line),
    command: fallback.fallbackCommand,
    runId: fallback.runId,
  };
}

function summarizeToolItem(toolName: string, status: string, result: Record<string, unknown> | null, rawText: string, command = ""): string {
  const lower = toolName.toLowerCase();
  const value = result || {};
  const displayStatus = compactStatus(status || readContentString(value.status) || readContentString(value.status_code));
  const inferred = inferToolText(rawText);
  const method = readContentString(value.method).toUpperCase() || inferred.method;
  const url = readContentString(value.url) || readContentString(value.target) || readContentString(value.location) || inferred.url;
  const commandText = command || readContentString(value.command) || inferred.command;

  if (/browser|explore|crawl/.test(lower)) return joinSummaryParts([url || readContentString(value.action) || toolName, displayStatus]);
  if (/http|request|replay|fetch|curl/.test(lower)) return joinSummaryParts([method || "HTTP", url, compactStatus(value.status_code || status)]);
  if (/execute|command|shell|docker|process/.test(lower)) return joinSummaryParts([commandText || stripJsonNoise(rawText)]);

  const title = readContentString(value.title) || readContentString(value.summary) || readContentString(value.message) || readContentString(value.error);
  const evidence = readContentString(value.evidence_id) || readContentString(value.EVIDENCE_ID);
  return joinSummaryParts([title || readContentString(value.action) || toolName, url || evidence, displayStatus]);
}

function inferToolText(text: string): { method: string; url: string; command: string } {
  const firstLine = text.split(/\r?\n/).map(line => line.trim()).find(line => line && !/^EVIDENCE_ID:/i.test(line) && !line.startsWith("{")) || "";
  const request = firstLine.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(https?:\/\/[^\s'"\])}]+)/i);
  const browser = firstLine.match(/\bbrowser\s+\w+\s+(https?:\/\/[^\s'"\])}]+)/i);
  return {
    method: request?.[1]?.toUpperCase() || "",
    url: (request?.[2] || browser?.[1] || "").replace(/\.\.\.$/, ""),
    command: firstLine,
  };
}
function compactStatus(value: unknown): string {
  const status = String(value || "").trim();
  if (!status) return "";
  if (/^status\s+/i.test(status)) return status.replace(/^status\s+/i, "");
  return status;
}

function joinSummaryParts(parts: Array<string | undefined>): string {
  return parts.map(part => String(part || "").trim()).filter(Boolean).slice(0, 3).join(" - ");
}
function readContentString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function toolNamesFromContent(content: Record<string, unknown>): string[] {
  const names = Array.isArray(content.tool_names) ? content.tool_names : [content.display_title || content.tool_name];
  return names.map(item => displayToolName(String(item || "").trim())).filter(Boolean);
}

function displayToolName(toolName: string, explicitTitle = ""): string {
  const title = explicitTitle.trim();
  if (title) return title;
  const normalized = toolName.trim();
  const lower = normalized.toLowerCase();
  const known: Record<string, string> = {
    exec_command: "Exec Command",
    write_stdin: "Command Input",
  };
  if (known[lower]) return known[lower];
  if (!normalized) return "";
  return normalized.includes("_")
    ? normalized.split("_").filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" ")
    : normalized;
}

function isCommandToolName(toolName: string): boolean {
  return /exec command|command input|execute|command|shell|docker|process|stdin/i.test(toolName);
}

function toolTitle(toolNames: string[]): string {
  const unique = uniqueStrings(toolNames);
  if (!unique.length) return "Tool activity";
  if (unique.length === 1) return unique[0];
  return `${unique.slice(0, 2).join(" + ")}${unique.length > 2 ? ` +${unique.length - 2}` : ""}`;
}

function toolPrimaryCategory(toolNames: string[], explicitCategories: string[] = []): ToolCategory {
  const explicit = uniqueStrings(explicitCategories.map(normalizeToolCategoryKey));
  const inferred = toolNames.map(toolCategoryKey);
  const key = explicit.find(category => category !== "tool") || explicit[0] || inferred.find(category => category !== "tool") || inferred[0] || "tool";
  return categoryForKey(key);
}

function toolCategoryKey(toolName: string): string {
  const name = toolName.toLowerCase();
  if (/browser|explore|crawl|capture|traffic|discover|asset|surface/.test(name)) return "discovery";
  if (/http|request|replay|mutate|fetch|curl/.test(name)) return "request";
  if (/execute|command|shell|docker|process/.test(name)) return "command";
  if (/finding|vuln|verify|evidence|confirm/.test(name)) return "finding";
  if (/search|scan|dir|wordlist|enumerate/.test(name)) return "search";
  if (/agent|message|graph/.test(name)) return "agent";
  if (/todo|note|think|skill/.test(name)) return "planning";
  return "tool";
}

function categoryForKey(key: string): ToolCategory {
  const normalizedKey = normalizeToolCategoryKey(key);
  const categories: Record<string, ToolCategory> = {
    discovery: { key: "discovery", label: "发现", Icon: Compass },
    request: { key: "request", label: "请求", Icon: Globe2 },
    command: { key: "command", label: "命令执行", Icon: Terminal },
    finding: { key: "finding", label: "发现验证", Icon: ShieldAlert },
    search: { key: "search", label: "搜索枚举", Icon: Search },
    agent: { key: "agent", label: "Agent", Icon: Users },
    planning: { key: "planning", label: "规划", Icon: Brain },
    tool: { key: "tool", label: "工具", Icon: Wrench },
  };
  return categories[normalizedKey] || categories.tool;
}

function normalizeToolCategoryKey(value: string): string {
  const key = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!key) return "";
  if (["discovery", "discover", "asset", "assets", "recon"].includes(key)) return "discovery";
  if (["request", "requests", "http", "http_request", "traffic", "sitemap", "scope"].includes(key)) return "request";
  if (["command", "commands", "exec", "execution", "shell", "process"].includes(key)) return "command";
  if (["finding", "findings", "vuln", "vulns", "vulnerability", "vulnerabilities", "evidence", "report"].includes(key)) return "finding";
  if (["search", "scan", "scanner", "enumeration", "enumerate", "skill", "skills"].includes(key)) return "search";
  if (["agent", "agents", "subagent", "sub_agent"].includes(key)) return "agent";
  if (["planning", "plan", "todo", "todos", "note", "notes", "think", "thinking"].includes(key)) return "planning";
  if (key === "tool" || key === "tools") return "tool";
  return key;
}

function summarizeToolOutput(stdout: string, latestTool = "tool"): string {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return "Waiting for tool output";
  const last = lines[lines.length - 1];
  const parsed = parseLooseObject(last);
  if (parsed) {
    const action = summarizeToolObject(parsed, latestTool);
    if (action) return action;
  }
  return stripJsonNoise(last);
}

function summarizeToolObject(value: Record<string, unknown>, latestTool: string): string {
  return summarizeToolItem(latestTool, readContentString(value.status) || readContentString(value.status_code), value, "", readContentString(value.command));
}

function parseLooseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    // Tool output may be Python dict-like; fall through to a conservative extractor.
  }
  const pairs = [...text.matchAll(/["']?([A-Za-z_][\w-]*)["']?\s*:\s*["']([^"']{1,240})["']/g)];
  if (!pairs.length) return null;
  const result: Record<string, unknown> = {};
  for (const match of pairs) {
    if (result[match[1]] === undefined) result[match[1]] = match[2];
  }
  return result;
}

function stripJsonNoise(text: string): string {
  return text
    .replace(/^[-`\s]+/, "")
    .replace(/[{}[\]"]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 220);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
function MarkdownText({ text }: { text: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="my-2 min-w-0 max-w-full space-y-2 text-sm leading-relaxed text-ink [overflow-wrap:anywhere]">
      {blocks.map((block, index) => renderMarkdownBlock(block, index))}
    </div>
  );
}

function renderMarkdownBlock(block: MarkdownBlock, index: number): ReactNode {
  if (block.type === "heading") {
    const className = block.level === 1 ? "text-lg font-semibold" : block.level === 2 ? "text-base font-semibold" : "text-sm font-semibold";
    const children = renderInlineMarkdown(block.text, `h-${index}`);
    if (block.level === 1) return <h1 key={index} className={className}>{children}</h1>;
    if (block.level === 2) return <h2 key={index} className={className}>{children}</h2>;
    return <h3 key={index} className={className}>{children}</h3>;
  }

  if (block.type === "list") {
    const Tag = block.ordered ? "ol" : "ul";
    const className = block.ordered ? "list-decimal space-y-1 pl-5" : "list-disc space-y-1 pl-5";
    return (
      <Tag key={index} className={className}>
        {block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInlineMarkdown(item, `li-${index}-${itemIndex}`)}</li>)}
      </Tag>
    );
  }

  if (block.type === "code") {
    return (
      <pre key={index} className="max-w-full overflow-x-auto rounded-sm border border-hairline bg-canvas-inset p-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
        {block.language && <code className="mb-2 block text-[11px] uppercase tracking-wide text-ink-muted">{block.language}</code>}
        <code>{block.text}</code>
      </pre>
    );
  }

  if (block.type === "quote") {
    return <blockquote key={index} className="border-l-2 border-hairline pl-3 text-ink-secondary">{renderInlineMarkdown(block.text, `q-${index}`)}</blockquote>;
  }

  if (block.type === "table") {
    return (
      <div key={index} className="max-w-full overflow-x-auto rounded-md border border-hairline">
        <table className="min-w-full border-collapse text-left text-sm">
          <thead className="bg-surface-default">
            <tr>
              {block.headers.map((header, cellIndex) => (
                <th key={cellIndex} className={`border-b border-hairline px-3 py-2 font-semibold ${tableAlignClass(block.alignments[cellIndex])}`}>
                  {renderInlineMarkdown(header, `th-${index}-${cellIndex}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-t border-hairline-soft">
                {block.headers.map((_, cellIndex) => (
                  <td key={cellIndex} className={`max-w-[320px] px-3 py-2 align-top break-words [overflow-wrap:anywhere] ${tableAlignClass(block.alignments[cellIndex])}`}>
                    {renderInlineMarkdown(row[cellIndex] || "", `td-${index}-${rowIndex}-${cellIndex}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return <p key={index}>{renderInlineMarkdown(block.text, `p-${index}`)}</p>;
}

function parseMarkdown(text: string): MarkdownBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```\s*([^`]*)\s*$/);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ type: "code", language: fence[1].trim(), text: codeLines.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }

    const table = tryParseTable(lines, index);
    if (table) {
      blocks.push(table.block);
      index = table.nextIndex;
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      const quoteLines = [quote[1]];
      index += 1;
      while (index < lines.length) {
        const nextQuote = lines[index].match(/^>\s?(.*)$/);
        if (!nextQuote) break;
        quoteLines.push(nextQuote[1]);
        index += 1;
      }
      blocks.push({ type: "quote", text: quoteLines.join(" ").trim() });
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const orderedList = Boolean(ordered);
      const items: string[] = [];
      while (index < lines.length) {
        const match = orderedList ? lines[index].match(/^\s*\d+[.)]\s+(.+)$/) : lines[index].match(/^\s*[-*]\s+(.+)$/);
        if (!match) break;
        items.push(match[1].trim());
        index += 1;
      }
      blocks.push({ type: "list", ordered: orderedList, items });
      continue;
    }

    const paragraphLines = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isMarkdownBoundary(lines[index])) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks.length ? blocks : [{ type: "paragraph", text }];
}

function tryParseTable(lines: string[], index: number): { block: MarkdownBlock; nextIndex: number } | null {
  if (index + 1 >= lines.length) return null;
  const headerLine = lines[index].trim();
  const separatorLine = lines[index + 1].trim();
  if (!isTableRow(headerLine) || !isTableSeparator(separatorLine)) return null;

  const headers = splitTableRow(headerLine);
  const separatorCells = splitTableRow(separatorLine);
  if (headers.length < 2 || separatorCells.length !== headers.length) return null;

  const rows: string[][] = [];
  let nextIndex = index + 2;
  while (nextIndex < lines.length && isTableRow(lines[nextIndex].trim())) {
    const row = splitTableRow(lines[nextIndex].trim());
    rows.push(headers.map((_, cellIndex) => row[cellIndex] || ""));
    nextIndex += 1;
  }

  return {
    block: {
      type: "table",
      headers,
      alignments: separatorCells.map(tableAlignment),
      rows,
    },
    nextIndex,
  };
}

function isTableRow(line: string): boolean {
  return line.includes("|") && splitTableRow(line).length >= 2;
}

function isTableSeparator(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = splitTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
}

function splitTableRow(line: string): string[] {
  const trimmed = line.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;

  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function tableAlignment(separator: string): TableAlignment {
  const value = separator.replace(/\s/g, "");
  if (value.startsWith(":") && value.endsWith(":")) return "center";
  if (value.endsWith(":")) return "right";
  return "left";
}

function tableAlignClass(alignment: TableAlignment | undefined): string {
  if (alignment === "center") return "text-center";
  if (alignment === "right") return "text-right";
  return "text-left";
}

function isMarkdownBoundary(line: string): boolean {
  return /^```/.test(line) || /^(#{1,3})\s+/.test(line) || /^>\s?/.test(line) || /^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line) || isTableRow(line);
}

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;

    if (token.startsWith("`")) {
      nodes.push(<code key={key} className="rounded bg-canvas-inset px-1 py-0.5 font-mono text-[12px]">{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key} className="font-semibold">{token.slice(2, -2)}</strong>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        nodes.push(<a key={key} href={link[2]} target="_blank" rel="noreferrer" className="text-status-running underline underline-offset-2">{link[1]}</a>);
      } else {
        nodes.push(token);
      }
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function VulnCard({ content, onOpen }: { content: Record<string, unknown>; onOpen?: (finding: Partial<SecurityVulnerability>) => void }) {
  const severity = normalizeSeverity(content.severity);
  const borderColor: Record<string, string> = { critical: "border-l-severity-critical", high: "border-l-severity-high", medium: "border-l-severity-medium", low: "border-l-severity-low" };
  const severityClass: Record<string, string> = {
    critical: "bg-severity-critical-subtle text-severity-critical",
    high: "bg-severity-high-subtle text-severity-high",
    medium: "bg-severity-medium-subtle text-severity-medium",
    low: "bg-severity-low-subtle text-severity-low",
    info: "bg-canvas-inset text-ink-secondary",
  };
  const confidence = Number(content.confidence);
  const confidenceText = Number.isFinite(confidence) && confidence <= 1 ? `${Math.round(confidence * 100)}%` : String(content.confidence || "-");
  return (
    <button type="button" onClick={() => onOpen?.(content as Partial<SecurityVulnerability>)} className={`my-2 block w-full min-w-0 rounded-md border border-hairline bg-canvas border-l-3 ${borderColor[severity] || "border-l-severity-info"} p-4 text-left transition-colors hover:bg-surface-default`}>
      <div className="mb-1 flex min-w-0 items-center gap-2">
        <span className={`inline-block flex-shrink-0 rounded-md px-2.5 py-0.5 font-mono text-[11px] font-medium uppercase ${severityClass[severity]}`}>{severity}</span>
        <span className="min-w-0 truncate font-semibold">{String(content.title || "Untitled vulnerability")}</span>
      </div>
      <p className="break-words text-sm text-ink-secondary [overflow-wrap:anywhere]">{String(content.location || content.affected_asset || "-")} - confidence {confidenceText}</p>
    </button>
  );
}

function AssetCard({ content, onOpen }: { content: Record<string, unknown>; onOpen?: (asset: Partial<SecurityAsset>) => void }) {
  const properties = content.properties as Record<string, unknown> | undefined;
  const ports = Array.isArray(content.open_ports) ? content.open_ports : Array.isArray(properties?.open_ports) ? properties.open_ports as unknown[] : [];
  const services = Array.isArray(content.services) ? content.services : Array.isArray(properties?.services) ? properties.services as unknown[] : [];
  return (
    <button type="button" onClick={() => onOpen?.(content as Partial<SecurityAsset>)} className="my-2 block w-full min-w-0 rounded-md border border-hairline bg-canvas p-4 text-left transition-colors hover:bg-surface-default">
      <div className="mb-1 flex min-w-0 items-center gap-2">
        <span className="rounded-md bg-canvas-inset px-2 py-0.5 text-xs text-ink-secondary">{String(content.asset_type || content.type || "asset")}</span>
        <span className="min-w-0 truncate font-semibold">{String(content.address || content.name || "Unknown asset")}</span>
      </div>
      <p className="break-words text-sm text-ink-secondary [overflow-wrap:anywhere]">ports: {ports.length ? ports.join(", ") : "-"} ? services: {services.length}</p>
    </button>
  );
}

function renderMentionText(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(@[^\s@]+)/g;
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push(text.slice(lastIndex, index));
    parts.push(<span key={`${index}-${match[0]}`} className="font-semibold text-status-running">{match[0]}</span>);
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length ? parts : [text];
}

function normalizeSeverity(value: unknown): string {
  const severity = String(value || "info").toLowerCase();
  return ["critical", "high", "medium", "low", "info"].includes(severity) ? severity : "info";
}
function AgentPendingCard({ content }: { content: Record<string, unknown> }) {
  return (
    <div className="my-2 min-w-0 max-w-full text-sm leading-relaxed text-ink-secondary">
      {String(content.text || "Working...")}
    </div>
  );
}
function statusNoticeText(content: Record<string, unknown>): string {
  const phase = typeof content.phase === "string" ? content.phase : parsePhaseFromText(String(content.text || ""));
  return phase ? phaseLabel(phase) : String(content.text || "");
}

function isLegacyPhaseOnlyStatus(content: Record<string, unknown>): boolean {
  const phase = typeof content.phase === "string" ? content.phase : parsePhaseFromText(String(content.text || ""));
  if (!["intake", "recon", "analysis", "verify", "report", "complete"].includes(phase)) return false;
  const text = String(content.text || "").trim();
  return Boolean(content.synthetic) || !text || text === phaseLabel(phase) || text.startsWith(`Phase: ${phase}`);
}

function parsePhaseFromText(text: string): string {
  return text.match(/Phase:\s*([^\s(]+)/)?.[1] || "";
}

function StatusNotice({ content }: { content: Record<string, unknown> }) {
  if (isLegacyPhaseOnlyStatus(content)) return null;
  return <div className="my-2 text-center text-xs text-ink-muted">{statusNoticeText(content)}</div>;
}

function SystemNotice({ content }: { content: Record<string, unknown> }) {
  return <StatusNotice content={content} />;
}

export default function MessageRenderer({ message, agentNameById = {}, previousMessage, fallbackPentestNodeId, platformAgentNodeId, onDecision, onOpenVulnerability, onOpenAsset, onOpenEvidence, highlightedApprovalId, approvalDecisionByRequestId = {} }: Props) {
  const { role, msg_type, content } = message;

  if (role === "system" || msg_type === "status") return <SystemNotice content={content} />;

  if (role === "user" && msg_type === "decision") return null;

  if (role === "user") {
    return (
      <div className="my-2 flex min-w-0 justify-end">
        <div className="max-w-[70%] break-words rounded-2xl bg-surface-default px-4 py-2.5 text-sm [overflow-wrap:anywhere]">{renderMentionText(String(content.text || ""))}</div>
      </div>
    );
  }

  const agentLabel = agentDisplayName(content, agentNameById, fallbackPentestNodeId, platformAgentNodeId);
  const previousAgentLabel = previousMessage?.role === "agent" ? agentDisplayName(previousMessage.content, agentNameById, fallbackPentestNodeId, platformAgentNodeId) : "";
  const showAgentLabel = previousAgentLabel !== agentLabel;
  let body: ReactNode;
  switch (msg_type) {
    case "tool_call":
      body = <ToolCallCard content={content} onOpenEvidence={onOpenEvidence} />;
      break;
    case "vuln_card":
    case "vuln_found":
      body = <VulnCard content={content} onOpen={onOpenVulnerability} />;
      break;
    case "asset_card":
    case "asset_discovered":
      body = <AssetCard content={content} onOpen={onOpenAsset} />;
      break;
    case "confirm_card":
      body = <ConfirmCard content={content} decision={approvalDecisionByRequestId[String(content.request_id || "")]} highlighted={Boolean(content.request_id && content.request_id === highlightedApprovalId)} onAuthorize={() => onDecision?.(content.request_id as string, "authorize")} onCancel={() => onDecision?.(content.request_id as string, "cancel")} />;
      break;
    case "agent_pending":
      body = <AgentPendingCard content={content} />;
      break;
    case "thinking":
    case "reasoning":
    case "agent_thinking":
      body = <ThinkingCard content={content} />;
      break;
    case "status":
      body = <StatusNotice content={content} />;
      break;
    case "text":
    default:
      body = <MarkdownText text={String(content.text || "")} />;
  }

  return (
    <div className="my-2 min-w-0">
      {showAgentLabel && (
        <div className="mb-1 flex items-center gap-2 text-xs text-ink-muted">
          <span className="font-medium text-ink-secondary">{agentLabel}</span>
        </div>
      )}
      {body}
    </div>
  );
}




