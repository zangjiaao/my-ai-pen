import { useState } from "react";
import {
  BookOpen,
  ChevronDown,
  CircleHelp,
  ClipboardCheck,
  Compass,
  FileText,
  Globe2,
  Library,
  Lightbulb,
  ListTodo,
  MapPin,
  ScanEye,
  ScanSearch,
  ShieldAlert,
  StickyNote,
  Target,
  Terminal,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { SecurityEvidence } from "../../lib/securityTypes";
import {
  normalizeExecutionStatus,
  projectToolLifecycleStatus,
  resolveToolChromeStatusForSession,
  resolveToolItemStatus,
  mergeToolLifecycleStatus,
} from "../../lib/status";
import { friendlyToolLabel } from "../../lib/toolLabels";
import { toolFamilyFromName, toolFamilyKey, toolUserFacingDetail } from "../../lib/toolDetail";
import { formatToolResultDrawerBody } from "../../lib/toolResultDrawer";
import { ProcessStatusLight } from "../ProcessStatusLight";
import {
  PROCESS_LEADING_ICON_SIZE,
  PROCESS_LEADING_ICON_STROKE,
  PROCESS_LEADING_SLOT_CLASS,
} from "../../lib/processChromeIcon";

const TOOL_CARD_CLASS = "my-1.5 w-full min-w-0 max-w-full overflow-hidden";
const TOOL_CARD_HEADER_CLASS =
  "group/tool -mx-1 flex h-7 w-fit max-w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-left";
const TOOL_CARD_BODY_CLASS =
  "relative ml-2.5 min-w-0 max-w-full space-y-0.5 border-l border-hairline py-0.5 pl-3";

export function ToolCallCardSkeleton() {
  return (
    <div aria-hidden="true" className={TOOL_CARD_CLASS} data-testid="tool-card-skeleton">
      <div className={TOOL_CARD_HEADER_CLASS}>
        <div className={`${PROCESS_LEADING_SLOT_CLASS} rounded bg-canvas-inset`} />
        <div className="h-3 w-20 rounded-full bg-canvas-inset" />
        <div className="h-3.5 w-3.5 rounded bg-canvas-inset" />
      </div>
      <div className={TOOL_CARD_BODY_CLASS}>
        {[72, 54].map((width) => (
          <div key={width} className="flex min-h-7 w-full min-w-0 max-w-full items-start gap-2 rounded px-0.5 py-0.5">
            <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-canvas-inset" />
            <div className="flex min-h-6 flex-1 items-center">
              <div
                className="h-3 rounded-full bg-canvas-inset"
                style={{ width: `${width}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Tool process chrome — group by **tool type**:
 *
 *   【Terminal】执行命令 2次 ⌄
 *   -- 【状态灯】bun xxx
 *   -- 【状态灯】curl -x …
 *
 * Header = type icon + type label + count.
 * Rows = status light + invocation detail only (name already on the header).
 */
export function ToolCallCard({
  content,
  onOpenEvidence,
  sessionActive,
}: {
  content: Record<string, unknown>;
  onOpenEvidence?: (evidence: Partial<SecurityEvidence>) => void;
  sessionActive?: boolean;
}) {
  // Default open so operators see the invocation list immediately (like Thinking).
  // Graph Feedback hop chrome is title-only — keep the body collapsed (no process dump).
  const [expanded, setExpanded] = useState(
    () => String(content.tool_name || "").trim() !== "graph_feedback",
  );
  const toolNames = toolNamesFromContent(content);
  const primaryTool = toolNames[0] || "tool";
  const latestTool = String(content.latest_tool_name || content.tool_name || primaryTool);
  const chromeStatus = resolveToolChromeStatusForSession(content.status, { sessionActive });
  const stdout = content.stdout as string || "";
  const rawToolId = String(content.tool_name || content.latest_tool_name || "").trim();
  // content.summary / result_text often hold full tool JSON when args/command were never stored.
  const contentSummaryRaw = readContentString(content.summary);
  const contentResultText = readContentString(content.result_text) || contentSummaryRaw;
  const items = toolItemsFromContent(content).map((item) => {
    const status = projectToolLifecycleStatus(item.status, { sessionActive });
    const toolId = item.toolId || rawToolId || item.toolName;
    // Prefer raw content blobs for request projection (item.summary may already be scrubbed).
    const detail = toolUserFacingDetail({
      toolName: item.toolName,
      toolId,
      command: item.command || readContentString(content.command),
      target: item.target || readContentString(content.target),
      summary: item.summary || contentSummaryRaw,
      args: item.args ?? content.args,
      result: item.result ?? content.result,
      result_text: contentResultText,
    });
    const typeLabel = displayToolName(toolId || item.toolName);
    // Keep structured-record detail if re-projection is empty (legacy scrub path).
    const detailText =
      (detail.text
        && detail.text !== item.toolName
        && detail.text !== toolId
        && detail.text !== typeLabel
        ? detail.text
        : "")
      || (item.detail
        && item.detail !== item.toolName
        && item.detail !== typeLabel
        ? item.detail
        : "");
    const resultBody = formatToolResultDrawerBody({
      toolId,
      toolName: item.toolName,
      args: item.args ?? content.args,
      command: item.command || readContentString(content.command),
      summary: contentSummaryRaw || item.summary,
      result: item.result ?? content.result,
      result_text: contentResultText,
      stdout: content.stdout,
    });
    return {
      ...item,
      toolId,
      status,
      command: item.command || readContentString(content.command) || (detail.mono ? detail.text : item.command),
      target: item.target || readContentString(content.target),
      detail: detailText,
      detailMono: detail.mono || item.detailMono,
      resultBody,
    };
  });
  // Ensure at least one row when progressive payload has no structured items yet.
  const rows: ToolItem[] = items.length
    ? items
    : (() => {
        const toolId = rawToolId || latestTool;
        const label = displayToolName(latestTool);
        const detail = toolUserFacingDetail({
          toolName: label,
          toolId,
          command: readContentString(content.command),
          target: readContentString(content.target),
          summary: readContentString(content.summary),
          args: content.args,
          result: content.result,
          result_text: content.result_text,
        });
        // Request only — never use tool stdout/result as the row label.
        const detailText =
          detail.text && detail.text !== label && detail.text !== toolId
            ? detail.text
            : "";
        return [{
          toolName: label,
          toolId,
          status: projectToolLifecycleStatus(content.status, { sessionActive }),
          summary: "",
          detail: detailText,
          detailMono: detail.mono || Boolean(readContentString(content.command)),
          command: readContentString(content.command),
          target: readContentString(content.target),
          runId: readContentString(content.tool_run_id),
          resultBody: formatToolResultDrawerBody({
            toolId,
            toolName: label,
            args: content.args,
            command: readContentString(content.command),
            summary: content.summary,
            result: content.result,
            result_text: content.result_text,
            stdout,
          }),
        }];
      })();
  const category = toolChromeCategory(
    rawToolId || latestTool || toolNames[0] || "",
    content,
  );
  const titleLabel = toolTypeTitle(toolNames, rawToolId || latestTool);
  const count = Math.max(rows.length, 1);
  // Same header typography as Thinking: 「思考 4 秒」↔「执行命令 2 次」
  const headerTitle = `${titleLabel} ${count} 次`;
  const working =
    chromeStatus === "running"
    || rows.some((r) => normalizeExecutionStatus(r.status) === "running");
  // Header: this tool type's category icon.
  const leading = <ToolCategoryIcon category={category} />;
  return (
    <div data-testid="tool-card" className={TOOL_CARD_CLASS}>
      <button
        data-testid="tool-card-toggle"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
        className={`${TOOL_CARD_HEADER_CLASS} transition-colors hover:bg-canvas-inset`}
      >
        <div className="flex flex-shrink-0 items-center gap-1">{leading}</div>
        <span
          data-testid="tool-card-summary"
          className={
            working
              ? "shimmer-label shrink-0 font-sans text-[13px] font-medium"
              : "shrink-0 font-sans text-[13px] font-medium text-ink-secondary"
          }
        >
          {headerTitle}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={2.2}
          aria-hidden
          className={`shrink-0 text-ink-muted transition-transform duration-200 ${
            expanded ? "rotate-180" : "rotate-0"
          }`}
        />
      </button>
      <div
        className="grid min-w-0 transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]"
        style={{
          gridTemplateRows: expanded ? "1fr" : "0fr",
          opacity: expanded ? 1 : 0,
        }}
      >
        {/* min-w-0: allow shrink inside chat column; no w-full + ml-* (that overflows). */}
        <div className="min-h-0 min-w-0 overflow-hidden">
          <div
            className={TOOL_CARD_BODY_CLASS}
            data-testid="tool-card-body"
          >
            {rows.map((item, index) => (
              <ToolItemRow
                key={`${item.runId || item.evidenceId || index}-${index}`}
                item={item}
                onOpenEvidence={onOpenEvidence}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

type ToolItem = {
  toolName: string;
  /** Raw tool id for detail projection. */
  toolId?: string;
  status: string;
  summary: string;
  category?: string;
  target?: string;
  evidenceId?: string;
  runId?: string;
  command?: string;
  /** Projected **request** line (command / query params) — never tool output. */
  detail?: string;
  detailMono?: boolean;
  result?: Record<string, unknown>;
  args?: Record<string, unknown>;
  /** Tool output for the expandable drawer under the row. */
  resultBody?: string;
};

/**
 * Flat invocation row under a typed tool header:
 *   【状态灯】curl … / status=open · limit=50
 * Click expands result drawer below (stdout / JSON). Type name is on the card header only.
 */
function ToolItemRow({ item, onOpenEvidence }: { item: ToolItem; onOpenEvidence?: (evidence: Partial<SecurityEvidence>) => void }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const status = normalizeExecutionStatus(item.status);
  const projected = toolUserFacingDetail({
    toolName: item.toolName,
    toolId: item.toolId || item.toolName,
    command: item.command,
    target: item.target,
    summary: item.summary,
    args: item.args,
    result: item.result,
  });
  const typeLabel = item.toolName || displayToolName(item.toolId || "tool");
  // Request line only — never summary/result JSON or tool-name echo.
  const detailText =
    item.detail
    || (projected.text && projected.text !== typeLabel ? projected.text : "");
  const showMono = Boolean(item.detailMono ?? projected.mono);
  const lineText = detailText || (status === "running" ? "…" : "");
  const resultBody =
    item.resultBody
    || formatToolResultDrawerBody({
      toolId: item.toolId || item.toolName,
      toolName: item.toolName,
      args: item.args,
      command: item.command,
      summary: item.summary,
      result: item.result,
    });
  const canOpenDrawer = Boolean(resultBody.trim());

  return (
    <div className="min-w-0 max-w-full" data-testid="tool-item-row">
      <button
        type="button"
        aria-expanded={canOpenDrawer ? drawerOpen : undefined}
        disabled={!canOpenDrawer}
        onClick={() => {
          if (canOpenDrawer) setDrawerOpen((v) => !v);
        }}
        className={`flex min-h-7 w-full min-w-0 max-w-full items-start gap-2 rounded px-0.5 py-0.5 text-left ${
          canOpenDrawer ? "cursor-pointer transition-colors hover:bg-canvas-inset" : "cursor-default"
        }`}
      >
        <ProcessStatusLight
          status={status}
          pulse={status === "running"}
          testId="tool-item-status-light"
        />
        {lineText ? (
          <span
            className={`min-w-0 flex-1 text-[12.5px] text-ink-muted ${
              showMono ? "font-mono" : "font-sans"
            } ${
              // Collapsed: 2-line peek. Expanded: full multi-line command (no hover-only).
              drawerOpen
                ? "whitespace-pre-wrap break-all [overflow-wrap:anywhere]"
                : "line-clamp-2 break-all [overflow-wrap:anywhere]"
            }`}
            title={drawerOpen ? undefined : lineText}
            data-testid="tool-item-detail"
          >
            {lineText}
          </span>
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-[12.5px] text-ink-muted"
            data-testid="tool-item-detail"
          >
            {canOpenDrawer ? "查看结果" : ""}
          </span>
        )}
        {canOpenDrawer ? (
          <ChevronDown
            size={12}
            strokeWidth={2.2}
            aria-hidden
            className={`mt-0.5 shrink-0 self-start text-ink-muted transition-transform duration-150 ${
              drawerOpen ? "rotate-0" : "-rotate-90"
            }`}
          />
        ) : null}
        {item.evidenceId ? (
          <span
            role="link"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation();
              onOpenEvidence?.({
                evidence_id: item.evidenceId,
                id: item.evidenceId,
                source_tool: item.toolId || item.toolName,
                tool_run_id: item.runId,
                summary: item.summary || detailText || typeLabel,
                type: "tool_output",
              });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                onOpenEvidence?.({
                  evidence_id: item.evidenceId,
                  id: item.evidenceId,
                  source_tool: item.toolId || item.toolName,
                  tool_run_id: item.runId,
                  summary: item.summary || detailText || typeLabel,
                  type: "tool_output",
                });
              }
            }}
            className="mt-0.5 shrink-0 self-start text-[11px] text-ink-muted underline underline-offset-2 hover:text-ink-secondary"
          >
            Evidence
          </span>
        ) : null}
      </button>
      <div
        className="grid min-w-0 transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)]"
        style={{
          gridTemplateRows: drawerOpen && canOpenDrawer ? "1fr" : "0fr",
          opacity: drawerOpen && canOpenDrawer ? 1 : 0,
        }}
      >
        <div className="min-h-0 min-w-0 overflow-hidden">
          {canOpenDrawer ? (
            <pre
              data-testid="tool-item-result-drawer"
              className="mb-1 ml-1 max-h-96 min-w-0 max-w-full overflow-x-auto overflow-y-auto rounded-md border border-hairline bg-canvas-inset px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink-secondary whitespace-pre-wrap break-all [overflow-wrap:anywhere]"
            >
              {resultBody}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Card header label for a tool-type group (e.g. 执行命令). */
function toolTypeTitle(toolNames: string[], fallbackId: string): string {
  const unique = uniqueStrings(toolNames.map((n) => displayToolName(n)).filter(Boolean));
  if (unique.length === 1) return unique[0]!;
  if (unique.length > 1) return unique[0]!;
  return displayToolName(fallbackId) || "工具";
}
type ToolCategory = { key: string; label: string; Icon: LucideIcon };

function ToolCategoryIcon({ category }: { category: ToolCategory }) {
  const Icon = category.Icon;
  return (
    <span title={category.label} className={PROCESS_LEADING_SLOT_CLASS}>
      <Icon size={PROCESS_LEADING_ICON_SIZE} strokeWidth={PROCESS_LEADING_ICON_STROKE} />
    </span>
  );
}

function toolItemFromStructuredRecord(item: Record<string, unknown>, content: Record<string, unknown>): ToolItem {
  const rawToolName = readContentString(item.tool_name) || readContentString(content.tool_name) || "tool";
  const toolName = displayToolName(rawToolName, readContentString(item.display_title) || readContentString(content.display_title));
  const stdout = readContentString(item.stdout);
  const output = parseToolOutput(stdout);
  const summaryRaw = readContentString(item.summary) || readContentString(content.summary);
  const resultTextRaw =
    readContentString(String(content.result_text ?? ""))
    || readContentString(String(item.result_text ?? ""))
    || summaryRaw;
  const explicitResult = item.result && typeof item.result === "object" && !Array.isArray(item.result) ? item.result as Record<string, unknown> : null;
  // Many historical frames only stash jsonResult in summary / result_text.
  const parsedFromBlob =
    (typeof content.result === "object" && content.result && !Array.isArray(content.result)
      ? (content.result as Record<string, unknown>)
      : null)
    || parseLooseObject(summaryRaw)
    || parseLooseObject(resultTextRaw);
  const parsed = explicitResult || output.result || parsedFromBlob;
  // Issue 3: keep raw lifecycle empty when missing so result hints can mark success;
  // do not invent "done" or force "running" over status_code success.
  const explicitLifecycle = readContentString(item.status) || readContentString(content.status);
  const resultHints = {
    status: parsed?.status,
    status_code: parsed?.status_code,
  };
  const status = resolveToolItemStatus(explicitLifecycle, resultHints);
  const args =
    (item.args && typeof item.args === "object" && !Array.isArray(item.args)
      ? (item.args as Record<string, unknown>)
      : null)
    || (content.args && typeof content.args === "object" && !Array.isArray(content.args)
      ? (content.args as Record<string, unknown>)
      : undefined);
  const projected = toolUserFacingDetail({
    toolName,
    toolId: rawToolName,
    command: readContentString(item.command) || readContentString(content.command) || readContentString(parsed?.command),
    target:
      readContentString(item.target)
      || readContentString(content.target)
      || readContentString(parsed?.target)
      || readContentString(parsed?.url)
      || readContentString(parsed?.path),
    summary: summaryRaw,
    args,
    result: parsed,
    result_text: resultTextRaw,
  });
  const command =
    readContentString(item.command)
    || readContentString(content.command)
    || readContentString(parsed?.command)
    || (projected.mono ? projected.text : "");
  const evidenceId = readContentString(item.evidence_id) || output.evidenceId || readContentString(parsed?.evidence_id) || readContentString(content.evidence_id);
  // Keep JSON summary available for the result drawer; request line uses projected.detail.
  const detailText =
    projected.text
    && projected.text !== toolName
    && projected.text !== rawToolName
      ? projected.text
      : "";
  return {
    toolName,
    toolId: rawToolName,
    status,
    summary: summaryRaw,
    category: readContentString(item.category) || readContentString(content.category),
    target:
      readContentString(item.target)
      || readContentString(content.target)
      || readContentString(parsed?.target)
      || readContentString(parsed?.url)
      || readContentString(parsed?.title)
      || "",
    evidenceId,
    runId: readContentString(item.tool_run_id) || readContentString(content.tool_run_id),
    command,
    detail: detailText,
    detailMono: projected.mono,
    result: parsed || undefined,
    args: args || undefined,
    resultBody: formatToolResultDrawerBody({
      toolId: rawToolName,
      toolName,
      args: args || undefined,
      command,
      summary: summaryRaw,
      result: parsed,
      result_text: resultTextRaw,
      stdout,
    }),
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
      status: mergeToolLifecycleStatus(previous.status, item.status) || item.status || previous.status,
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
  // Issue 3: missing content.status stays empty (not invented done/running).
  const fallbackStatus = resolveToolItemStatus(content.status);
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
    // Lifecycle from explicit status only; HTTP codes stay on result for hints (Issue 3).
    const lifecycle = readContentString(parsed.status);
    const status = resolveToolItemStatus(
      lifecycle && !/^\d{3}$/.test(lifecycle) ? lifecycle : fallback.fallbackStatus,
      { status: parsed.status, status_code: parsed.status_code },
    );
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
  const displayStatus = compactStatus(status || readContentString(value.status) || readContentString(value.status_code) || readContentString(value.statusCode));
  const inferred = inferToolText(rawText);
  // Prefer structured result; Node2 often puts human summary in content.summary already.
  const method = readContentString(value.method).toUpperCase() || inferred.method;
  const url =
    readContentString(value.url) ||
    readContentString(value.requested_url) ||
    readContentString(value.target) ||
    readContentString(value.location) ||
    inferred.url;
  const commandText = command || readContentString(value.command) || inferred.command;

  // If upstream already sent a clean non-JSON summary line, keep it.
  const cleanRaw = String(rawText || "").trim();
  if (cleanRaw && !cleanRaw.startsWith("{") && !cleanRaw.startsWith("[") && cleanRaw.length < 280 && !/^EVIDENCE_ID:/i.test(cleanRaw)) {
    // Prefer structured HTTP/browser formatting when fields exist.
    if (!((/http|request/.test(lower) || /browser/.test(lower)) && (method || url))) {
      return stripJsonNoise(cleanRaw);
    }
  }

  if (/browser|explore|crawl/.test(lower)) {
    if (url) return joinSummaryParts([method || "GET", url, displayStatus || "done"]);
    return joinSummaryParts([readContentString(value.action) || toolName, displayStatus]);
  }
  if (/http|request|replay|fetch|curl/.test(lower)) {
    return joinSummaryParts([method || "HTTP", url, compactStatus(value.status_code || value.status || status)]);
  }
  if (/execute|command|shell|docker|process|scan/.test(lower)) {
    return joinSummaryParts([commandText || stripJsonNoise(rawText), displayStatus]);
  }
  if (/verifier/.test(lower)) {
    const klass = readContentString(value.vuln_class) || toolName;
    const outcome = value.confirmed === true ? "confirmed" : value.confirmed === false ? "not confirmed" : displayStatus;
    return joinSummaryParts([klass, url, outcome]);
  }
  if (/actor/.test(lower)) {
    return joinSummaryParts([readContentString(value.action) || "actor", readContentString(value.id) || readContentString(value.active), displayStatus]);
  }

  const title = readContentString(value.title) || readContentString(value.summary) || readContentString(value.message) || readContentString(value.error) || readContentString(value.reason);
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
  if (!normalized) return "";
  return friendlyToolLabel(normalized);
}

function toolChromeCategory(
  rawId: string,
  content: Record<string, unknown>,
): ToolCategory {
  const family = toolFamilyKey(content) || toolFamilyFromName(rawId);
  const categories: Record<string, ToolCategory> = {
    shell: { key: "shell", label: "命令执行", Icon: Terminal },
    http: { key: "http", label: "请求", Icon: Globe2 },
    browser: { key: "browser", label: "浏览器", Icon: Compass },
    file: { key: "file", label: "文件", Icon: FileText },
    finding: { key: "finding", label: "发现", Icon: ShieldAlert },
    todo: { key: "todo", label: "任务", Icon: ListTodo },
    skill: { key: "skill", label: "技能", Icon: BookOpen },
    subagent: { key: "subagent", label: "子代理", Icon: Users },
    surface: { key: "surface", label: "攻击面", Icon: ScanSearch },
    fact: { key: "fact", label: "过程", Icon: StickyNote },
    goal: { key: "goal", label: "目标", Icon: Target },
    captcha: { key: "captcha", label: "验证码", Icon: ScanEye },
    decision: { key: "decision", label: "决策", Icon: CircleHelp },
    hypothesis: { key: "hypothesis", label: "假设", Icon: Lightbulb },
    platform: { key: "platform", label: "台账", Icon: Library },
    feedback: { key: "feedback", label: "阶段评审", Icon: ClipboardCheck },
    workset: { key: "workset", label: "暴露面候选", Icon: MapPin },
    tool: { key: "tool", label: "工具", Icon: Wrench },
  };
  return categories[family] || categories.tool;
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

