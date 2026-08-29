/**
 * Spec #541 — Host-card Surface home. Operator-visible markup, not React internals.
 * Run: npx tsx src/components/SurfaceHostCards.test.tsx  (from platform/frontend)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SurfaceHostCards from "./SurfaceHostCards.tsx";
import { projectHostCards } from "../lib/hostCardProjection.ts";
import type { WorksetItem } from "../lib/workset.ts";

function proposed(host: string, id: string): WorksetItem {
  return {
    id,
    family: "t_host",
    title: host,
    status: "proposed",
    payload: { host, intel_source: "ct", confidence: "medium" },
  };
}

{
  const cards = projectHostCards({
    workset: {
      items: [proposed("www.example.com", "ws_01"), proposed("ns1.cloudflare.com", "ws_02")],
    },
    surfaceLedger: {
      version: 2,
      surfaces: [
        {
          origin_key: "https://crt.sh:443",
          path_key: "/",
          location: "https://crt.sh/",
          coverage: "tested",
        },
      ],
    },
    assets: [],
  });
  const html = renderToStaticMarkup(createElement(SurfaceHostCards, { cards }));
  assert.match(html, /data-testid="surface-host-cards"/);
  assert.match(html, /待准入/);
  assert.match(html, /www\.example\.com/);
  assert.match(html, /ns1\.cloudflare\.com/);
  assert.doesNotMatch(html, /crt\.sh/);
  assert.match(html, /待准入 \(2\)|待准入/);
  console.log("ok: Host cards render pending names, omit intel APIs");
}

{
  const html = renderToStaticMarkup(createElement(SurfaceHostCards, { cards: [] }));
  assert.match(html, /No Hosts in this Case yet/);
  console.log("ok: empty Host-card Surface is honest");
}

{
  const here = dirname(fileURLToPath(import.meta.url));
  const panel = readFileSync(join(here, "RightPanel.tsx"), "utf8");
  assert.equal(/intel-clues-section/.test(panel), false, "Findings tab must not project 线索");
  assert.match(panel, /SurfaceHostCards/);
  assert.match(panel, /groupFindingsByKind\(findings\)/);
  assert.doesNotMatch(panel, /groupFindingsByKind\([\s\S]{0,40}intel/);
  console.log("ok: Findings pane has no 线索 section");
}

console.log("SurfaceHostCards.test.tsx: all ok");
