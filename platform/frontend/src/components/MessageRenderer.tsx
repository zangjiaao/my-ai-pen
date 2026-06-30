import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Message } from "../lib/types";
import type { SecurityAsset, SecurityVulnerability } from "../lib/securityTypes";
import { normalizeExecutionStatus } from "../lib/status";
import ConfirmCard from "./cards/ConfirmCard";

interface Props {
  message: Message;
  agentNameById?: Record<string, string>;
  previousMessage?: Message;
  fallbackPentestNodeId?: string | null;
  platformAgentNodeId?: string | null;
  onDecision?: (requestId: string, decision: "authorize" | "cancel") => void;
  onOpenVulnerability?: (finding: Partial<SecurityVulnerability>) => void;
  onOpenAsset?: (asset: Partial<SecurityAsset>) => void;
  highlightedApprovalId?: string | null;
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
  const explicitNodeId = typeof content.agent_node_id === "string" ? content.agent_node_id : "";
  const fallbackNodeId = source === "platform" ? platformAgentNodeId : fallbackPentestNodeId;
  const nodeId = explicitNodeId || fallbackNodeId || "";
  if (nodeId && agentNameById[nodeId]) return agentNameById[nodeId];
  return source === "platform" ? "平台Agent" : "渗透Agent";
}
function ToolCallCard({ content }: { content: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const toolName = content.tool_name as string || "";
  const status = normalizeExecutionStatus(content.status);
  const stdout = content.stdout as string || "";
  const summary = summarizeToolOutput(stdout);
  const statusColor = status === "running" ? "bg-status-running" : status === "done" ? "bg-status-success" : "bg-status-error";
  const ToggleIcon = expanded ? ChevronDown : ChevronRight;
  return (
    <div data-testid="tool-card" className="my-2 min-w-0 max-w-full rounded-md border border-hairline bg-surface-default">
      <button
        data-testid="tool-card-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
        className="flex w-full min-w-0 items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-canvas-inset"
      >
        <ToggleIcon size={16} className="flex-shrink-0 text-ink-muted" />
        <span className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${statusColor}`} />
        <span className="min-w-0 truncate text-sm font-medium">{toolName}</span>
        <span className="flex-shrink-0 text-xs text-ink-muted">{status}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-muted">{summary}</span>
      </button>
      {expanded && (
        <div className="px-4 pb-4">
          <pre data-testid="tool-card-output" className="max-h-64 max-w-full overflow-y-auto overflow-x-hidden rounded-sm border border-hairline bg-canvas-inset p-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{stdout || "Waiting for output..."}</pre>
        </div>
      )}
    </div>
  );
}

function summarizeToolOutput(stdout: string): string {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "Waiting for output...";
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
  const severity = String(content.severity || "info");
  const borderColor: Record<string, string> = { critical: "border-l-severity-critical", high: "border-l-severity-high", medium: "border-l-severity-medium", low: "border-l-severity-low" };
  const confidence = Number(content.confidence);
  const confidenceText = Number.isFinite(confidence) && confidence <= 1 ? `${Math.round(confidence * 100)}%` : String(content.confidence || "-");
  return (
    <button type="button" onClick={() => onOpen?.(content as Partial<SecurityVulnerability>)} className={`my-2 block w-full min-w-0 rounded-md border border-hairline bg-canvas border-l-3 ${borderColor[severity] || "border-l-severity-info"} p-4 text-left transition-colors hover:bg-surface-default`}>
      <div className="mb-1 flex min-w-0 items-center gap-2">
        <span className={`inline-block flex-shrink-0 rounded-md px-2.5 py-0.5 font-mono text-[11px] font-medium uppercase bg-severity-${severity}-subtle text-severity-${severity}`}>{severity}</span>
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

function SystemNotice({ content }: { content: Record<string, unknown> }) {
  return <div className="my-2 text-center text-xs text-ink-muted">{content.text as string}</div>;
}

export default function MessageRenderer({ message, agentNameById = {}, previousMessage, fallbackPentestNodeId, platformAgentNodeId, onDecision, onOpenVulnerability, onOpenAsset, highlightedApprovalId }: Props) {
  const { role, msg_type, content } = message;

  if (role === "system") return <SystemNotice content={content} />;

  if (role === "user") {
    return (
      <div className="my-2 flex min-w-0 justify-end">
        <div className="max-w-[70%] break-words rounded-2xl bg-surface-default px-4 py-2.5 text-sm [overflow-wrap:anywhere]">{content.text as string}</div>
      </div>
    );
  }

  const agentLabel = agentDisplayName(content, agentNameById, fallbackPentestNodeId, platformAgentNodeId);
  const previousAgentLabel = previousMessage?.role === "agent" ? agentDisplayName(previousMessage.content, agentNameById, fallbackPentestNodeId, platformAgentNodeId) : "";
  const showAgentLabel = previousAgentLabel !== agentLabel;
  let body: ReactNode;
  switch (msg_type) {
    case "tool_call":
      body = <ToolCallCard content={content} />;
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
      body = <ConfirmCard content={content} highlighted={Boolean(content.request_id && content.request_id === highlightedApprovalId)} onAuthorize={() => onDecision?.(content.request_id as string, "authorize")} onCancel={() => onDecision?.(content.request_id as string, "cancel")} />;
      break;
    case "status":
      body = <div className="my-2 text-center text-xs text-ink-muted">{content.text as string}</div>;
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