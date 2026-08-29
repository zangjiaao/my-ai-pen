# UI render audit (agent)

When verifying **any page with a text field + a list or heavy chrome**, check that a keystroke does not re-render chrome that does not depend on that field.

## What exists

- **DEV only.** `vite build` turns the React entry points into plain `setState`. No badge, no `window.__RENDER_AUDIT__`, no `flushSync`, no console. `npm run dev` is the only place the audit runs.
- DEV `useRenderAudit(name)` on every route page, plus `ChatComposer`, `MessageRenderer`, `MarkdownText`, `RightPanel`, `TrafficAuditList`, `SurfaceTreeView`, `SurfaceHostCards`, `Sidebar`, `TopBar`. Surface search uses owner `SurfaceHostCards` so RightPanel must not increment.
- Keystrokes go through `commitTypedInput` / `handleTypedInput` — measure in the **same React turn** (`flushSync`). Live WS / timers after paint are not leaks.
- `owner` (and optional `allow`) may increment. Filter boxes allow their page (`AssetPage.search` allows `AssetPage`) because the list must update.
- Composer allows only `ChatComposer`. `ConversationPage` / `MessageRenderer` / `RightPanel` incrementing is a fail.
- `window.__RENDER_AUDIT__.report()` → `{ counts, flags }`. Flags reset on route change.
- DEV badge `data-testid="render-audit-flag"` only after a leak.
- Static gate: `src/lib/renderAudit.test.ts`.

## When you test UI

1. Run `npx tsx src/lib/renderAudit.test.ts` from `platform/frontend`.
2. Refresh, open the page you changed (populated list / long Case).
3. Type 3–5 characters, then `window.__RENDER_AUDIT__.report()`.
4. **Fail** only if `flags[]` still has chrome that should not depend on the field (`ConversationPage`, `MessageRenderer`, `MarkdownText`, `RightPanel`, `Sidebar`, `TopBar` for composer; `Sidebar`/`TopBar` for an isolated widget).
5. Do **not** fail a management-page search solely because the page itself re-rendered (filter). Sidebar/TopBar are memoized and should stay still.

## Do not

- Treat a late `useEffect` window as the audit — that mixed in WS frames and looked like dozens of leaks.
- Put draft state on the page that maps a stream which does not depend on the draft.
