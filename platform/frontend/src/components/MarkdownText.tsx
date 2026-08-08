import type { Components } from "react-markdown";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const DEFAULT_CLASS_NAME =
  "my-2 min-w-0 max-w-full space-y-2 text-sm leading-relaxed text-ink [overflow-wrap:anywhere]";

/**
 * Shared Case-dialog Markdown renderer for agent-side prose (text, thinking body, Choice).
 * Full GFM via remark-gfm; no raw HTML; optional soft breaks for thinking streams.
 */
export default function MarkdownText({
  text,
  className = DEFAULT_CLASS_NAME,
  breaks = false,
}: {
  text: string;
  className?: string;
  /** When true, single newlines become hard breaks (thinking density). Default GFM paragraphs. */
  breaks?: boolean;
}) {
  const remarkPlugins = breaks ? [remarkGfm, remarkBreaks] : [remarkGfm];

  return (
    <div className={className} data-markdown-root>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

const headingClass: Record<number, string> = {
  1: "text-lg font-semibold text-ink",
  2: "text-base font-semibold text-ink",
  3: "text-sm font-semibold text-ink",
  4: "text-sm font-semibold text-ink",
  5: "text-xs font-semibold text-ink",
  6: "text-xs font-semibold text-ink-secondary",
};

function heading(level: 1 | 2 | 3 | 4 | 5 | 6) {
  const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  return function Heading({ children }: { children?: ReactNode }) {
    return <Tag className={headingClass[level]}>{children}</Tag>;
  };
}

const markdownComponents: Components = {
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  h5: heading(5),
  h6: heading(6),
  p: ({ children }) => <p className="min-w-0 [overflow-wrap:anywhere]">{children}</p>,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
  li: ({ children, className }) => (
    <li className={`min-w-0 [overflow-wrap:anywhere] ${className ?? ""}`.trim()}>{children}</li>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-hairline pl-3 text-ink-secondary">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-0 border-t border-hairline" />,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  del: ({ children }) => <del className="text-ink-muted">{children}</del>,
  a: ({ href, children }) => {
    const safe = sanitizeHref(href);
    if (!safe) {
      return <span className="text-ink-muted">{children}</span>;
    }
    return (
      <a
        href={safe}
        target="_blank"
        rel="noreferrer"
        className="text-status-running underline underline-offset-2"
      >
        {children}
      </a>
    );
  },
  /** Never remote-load images from model output (tracking / layout abuse). */
  img: ({ alt, src }) => {
    const label = (alt && String(alt).trim()) || (src && String(src).trim()) || "image";
    const safe = sanitizeHref(typeof src === "string" ? src : undefined);
    if (safe) {
      return (
        <a
          href={safe}
          target="_blank"
          rel="noreferrer"
          className="inline text-status-running underline underline-offset-2"
          title={typeof src === "string" ? src : undefined}
        >
          [{label}]
        </a>
      );
    }
    return <span className="text-ink-muted">[{label}]</span>;
  },
  // Fenced: <pre><code class="language-…"> (pre owns block chrome). Bare code = inline.
  // Unlabeled fences may omit language-*; pre still provides mono block layout.
  code: ({ className, children }) => {
    if (className) {
      return <code className={`font-mono ${className}`.trim()}>{children}</code>;
    }
    return (
      <code className="rounded bg-canvas-inset px-1 py-0.5 font-mono text-[12px]">{children}</code>
    );
  },
  pre: ({ children }) => (
    <pre className="max-w-full overflow-x-auto rounded-sm border border-hairline bg-canvas-inset p-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="max-w-full overflow-x-auto rounded-md border border-hairline">
      <table className="min-w-full border-collapse text-left text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-surface-default">{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr className="border-t border-hairline-soft first:border-t-0">{children}</tr>,
  th: ({ children, style }) => (
    <th
      className={`border-b border-hairline px-3 py-2 font-semibold ${alignClass(style?.textAlign)}`}
      style={style}
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td
      className={`max-w-[320px] px-3 py-2 align-top break-words [overflow-wrap:anywhere] ${alignClass(style?.textAlign)}`}
      style={style}
    >
      {children}
    </td>
  ),
  // GFM task-list checkboxes are display-only (model output, not interactive form).
  input: ({ checked, type }) => {
    if (type !== "checkbox") return null;
    return (
      <input
        type="checkbox"
        defaultChecked={Boolean(checked)}
        disabled
        className="mr-1 align-middle"
      />
    );
  },
};

function alignClass(align: string | number | undefined): string {
  if (align === "center") return "text-center";
  if (align === "right") return "text-right";
  return "text-left";
}

/** Allow relative / http(s) / mailto; reject javascript: and other executable schemes. */
export function sanitizeHref(href: string | undefined | null): string | undefined {
  if (href == null) return undefined;
  const trimmed = String(href).trim();
  if (!trimmed) return undefined;

  // Protocol-relative or scheme present
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === "http" || scheme === "https" || scheme === "mailto") return trimmed;
    return undefined;
  }

  // Relative paths, anchors, query-only — safe for in-app navigation presentation
  return trimmed;
}
