import type { ReactNode } from "react";

type TableAlignment = "left" | "center" | "right";

type MarkdownBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "code"; language: string; text: string }
  | { type: "quote"; text: string }
  | { type: "table"; headers: string[]; alignments: TableAlignment[]; rows: string[][] };

export default function MarkdownText({
  text,
  className = "my-2 min-w-0 max-w-full space-y-2 text-sm leading-relaxed text-ink [overflow-wrap:anywhere]",
}: {
  text: string;
  className?: string;
}) {
  const blocks = parseMarkdown(text);
  return (
    <div className={className}>
      {blocks.map((block, index) => renderMarkdownBlock(block, index))}
    </div>
  );
}

function renderMarkdownBlock(block: MarkdownBlock, index: number): ReactNode {
  if (block.type === "heading") {
    const className =
      block.level === 1 ? "text-lg font-semibold" : block.level === 2 ? "text-base font-semibold" : "text-sm font-semibold";
    const children = renderInlineMarkdown(block.text, `h-${index}`);
    if (block.level === 1) return <h1 key={index} className={className}>{children}</h1>;
    if (block.level === 2) return <h2 key={index} className={className}>{children}</h2>;
    return <h3 key={index} className={className}>{children}</h3>;
  }

  if (block.type === "list") {
    const Tag = block.ordered ? "ol" : "ul";
    const listClass = block.ordered ? "list-decimal space-y-1 pl-5" : "list-disc space-y-1 pl-5";
    return (
      <Tag key={index} className={listClass}>
        {block.items.map((item, itemIndex) => (
          <li key={itemIndex}>{renderInlineMarkdown(item, `li-${index}-${itemIndex}`)}</li>
        ))}
      </Tag>
    );
  }

  if (block.type === "code") {
    return (
      <pre
        key={index}
        className="max-w-full overflow-x-auto rounded-sm border border-hairline bg-canvas-inset p-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
      >
        {block.language && (
          <code className="mb-2 block text-[11px] uppercase tracking-wide text-ink-muted">{block.language}</code>
        )}
        <code>{block.text}</code>
      </pre>
    );
  }

  if (block.type === "quote") {
    return (
      <blockquote key={index} className="border-l-2 border-hairline pl-3 text-ink-secondary">
        {renderInlineMarkdown(block.text, `q-${index}`)}
      </blockquote>
    );
  }

  if (block.type === "table") {
    return (
      <div key={index} className="max-w-full overflow-x-auto rounded-md border border-hairline">
        <table className="min-w-full border-collapse text-left text-sm">
          <thead className="bg-surface-default">
            <tr>
              {block.headers.map((header, cellIndex) => (
                <th
                  key={cellIndex}
                  className={`border-b border-hairline px-3 py-2 font-semibold ${tableAlignClass(block.alignments[cellIndex])}`}
                >
                  {renderInlineMarkdown(header, `th-${index}-${cellIndex}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-t border-hairline-soft">
                {block.headers.map((_, cellIndex) => (
                  <td
                    key={cellIndex}
                    className={`max-w-[320px] px-3 py-2 align-top break-words [overflow-wrap:anywhere] ${tableAlignClass(block.alignments[cellIndex])}`}
                  >
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
        const match = orderedList
          ? lines[index].match(/^\s*\d+[.)]\s+(.+)$/)
          : lines[index].match(/^\s*[-*]\s+(.+)$/);
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
  return (
    /^```/.test(line) ||
    /^(#{1,3})\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^\s*[-*]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    isTableRow(line)
  );
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
      nodes.push(
        <code key={key} className="rounded bg-canvas-inset px-1 py-0.5 font-mono text-[12px]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(
        <strong key={key} className="font-semibold">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        nodes.push(
          <a
            key={key}
            href={link[2]}
            target="_blank"
            rel="noreferrer"
            className="text-status-running underline underline-offset-2"
          >
            {link[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}
