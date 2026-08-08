# Dialog Markdown: shared GFM renderer

**Spec:** [#327](https://github.com/zangjiaao/my-ai-pen/issues/327) (slices [#328](https://github.com/zangjiaao/my-ai-pen/issues/328), [#329](https://github.com/zangjiaao/my-ai-pen/issues/329))  
**Scope:** platform frontend Case-dialog agent prose only (not user bubbles, not report drawer).

## What ships

One shared presentation component (`MarkdownText`) for Agent-side dialog prose:

| Surface | Renderer | Soft breaks | Density |
|---------|----------|-------------|---------|
| Main agent text (`MessageRenderer`) | shared | off (GFM default) | primary (`text-sm` ink) |
| Thinking body (`ThinkingCard`) | shared | **on** | muted / `text-xs` |
| Choice preamble / option bodies | shared | off | secondary |
| Worker process audit | shared via `MessageRenderer` | same as above | same |

Stack: `react-markdown` + `remark-gfm` (+ `remark-breaks` when `breaks`).

## Public API

```ts
MarkdownText({
  text: string;
  className?: string;
  breaks?: boolean; // default false
})
```

## Security / media

- **No raw HTML** in the pipeline (do not enable `rehype-raw`).
- **Links:** allow `http(s)`, `mailto`, and relative/anchor targets; reject executable schemes (`javascript:`, `data:`, …). External links open in a new tab with `rel="noreferrer"`.
- **Images:** GFM image syntax is **not** rendered as remote-loading `<img>`; presented as non-fetching text/link/alt.
- **Code fences:** monospaced blocks only — no syntax highlighter in this slice.

## Out of scope

User chat bubbles (mention rendering), report drawer / non-dialog previews, highlighter themes, backend message schema.
