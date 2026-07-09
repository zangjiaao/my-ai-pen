/**
 * Multi-actor identity tool: register, switch, and capture auth contexts
 * for horizontal/vertical privilege and business-logic testing.
 */
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRuntime } from "../types.js";
import { jsonResult, textResult } from "./common.js";

export function createActorTool(runtime: ToolRuntime): ToolDefinition<any> {
  return {
    name: "actor",
    label: "Actor",
    description:
      "Manage multiple authenticated identities for privilege and business-logic testing. Actions: list, upsert, activate, clear_active, capture. Use at least two actors (e.g. user_a and user_b, or user and admin) before IDOR/access-control and workflow abuse checks. Pass actor=<id> on http/verifier to pin identity.",
    promptSnippet: "Register and switch multi-privilege test identities",
    promptGuidelines: [
      "After each distinct login/registration, call actor(action='capture' or 'upsert') so that identity is preserved independently of the global snapshot.",
      "Always maintain at least two actors when the app supports accounts; use them for horizontal (same role, different owner) and vertical (lower vs higher privilege) tests.",
      "Use http(actor=...) and verifier(actor=..., alt_actor=...) instead of manually swapping Authorization headers when comparing identities.",
      "Do not overwrite actor A when logging in as B — capture B as a separate actor id.",
    ],
    parameters: Type.Object({
      action: Type.String(),
      id: Type.Optional(Type.String()),
      label: Type.Optional(Type.String()),
      role_hint: Type.Optional(Type.String()),
      authorization: Type.Optional(Type.String()),
      cookie: Type.Optional(Type.String()),
      headers: Type.Optional(Type.Record(Type.String(), Type.String())),
      meta: Type.Optional(Type.Record(Type.String(), Type.String())),
      replace_headers: Type.Optional(Type.Boolean()),
      activate: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId: string, params: any) {
      const actors = runtime.actors;
      if (!actors) return textResult("error: actor store is not available on this runtime");

      const action = String(params.action || "").toLowerCase();
      if (action === "list") {
        return jsonResult(actors.summary());
      }

      if (action === "clear_active") {
        actors.clearActive();
        return jsonResult({ ok: true, active: null, ...actors.summary() });
      }

      if (action === "activate") {
        if (!params.id) return textResult("error: id is required for activate");
        try {
          const record = actors.activate(String(params.id));
          syncTrafficSnapshotFromActor(runtime, record);
          return jsonResult({ ok: true, active: record.id, actor: publicActor(record), ...actors.summary() });
        } catch (error) {
          return textResult(`error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (action === "upsert" || action === "capture") {
        if (!params.id) return textResult("error: id is required");
        // capture: merge traffic/browser snapshot into actor when headers not fully provided
        let authorization = params.authorization;
        let cookie = params.cookie;
        let headers = { ...(params.headers || {}) };
        if (action === "capture") {
          const snap = runtime.traffic.snapshot() || {};
          if (!authorization) {
            authorization =
              (typeof snap.authorization === "string" && snap.authorization) ||
              (snap.headers && typeof (snap.headers as any).authorization === "string"
                ? String((snap.headers as any).authorization)
                : undefined);
          }
          if (!cookie) {
            cookie =
              (typeof snap.cookie === "string" && snap.cookie) ||
              (typeof snap.cookies === "string" && snap.cookies) ||
              undefined;
          }
          // Also pull latest Authorization from recent traffic if still missing.
          if (!authorization) {
            for (const row of runtime.traffic.list({ limit: 30 })) {
              const auth = row.requestHeaders?.authorization || row.requestHeaders?.Authorization;
              if (auth) {
                authorization = auth;
                break;
              }
            }
          }
        }

        try {
          const record = actors.upsert({
            id: String(params.id),
            label: params.label,
            role_hint: params.role_hint,
            authorization,
            cookie,
            headers,
            meta: params.meta,
            replace_headers: Boolean(params.replace_headers),
          });
          if (params.activate !== false) {
            actors.activate(record.id);
            syncTrafficSnapshotFromActor(runtime, record);
          }
          return jsonResult({
            ok: true,
            action,
            actor: publicActor(record),
            ...actors.summary(),
            guidance:
              actors.count() < 2
                ? "Only one actor stored. Create a second actor (different account/role) before dual-actor IDOR/access-control and business-logic tests."
                : "Two or more actors available. Use verifier(vuln_class='idor', actor='A', alt_actor='B', object_id=...) for horizontal access checks.",
          });
        } catch (error) {
          return textResult(`error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      return textResult("error: action must be list, upsert, activate, clear_active, or capture");
    },
  };
}

function publicActor(record: { id: string; label: string; roleHint?: string; headers: Record<string, string>; meta: Record<string, unknown> }) {
  return {
    id: record.id,
    label: record.label,
    role_hint: record.roleHint,
    has_authorization: Boolean(record.headers.authorization),
    has_cookie: Boolean(record.headers.cookie),
    header_keys: Object.keys(record.headers),
    meta: record.meta,
  };
}

/** Keep legacy single-snapshot consumers in sync when an actor becomes active. */
function syncTrafficSnapshotFromActor(
  runtime: ToolRuntime,
  record: { headers: Record<string, string>; id: string; meta: Record<string, unknown> },
): void {
  const snapshot = { ...(runtime.traffic.snapshot() || {}) };
  if (record.headers.cookie) {
    snapshot.cookie = record.headers.cookie;
    snapshot.cookies = record.headers.cookie;
  }
  if (record.headers.authorization) {
    snapshot.authorization = record.headers.authorization;
    snapshot.headers = {
      ...((snapshot.headers as Record<string, unknown>) || {}),
      authorization: record.headers.authorization,
    };
  }
  snapshot.active_actor = record.id;
  snapshot.actor_meta = record.meta;
  runtime.traffic.setSnapshot(snapshot);
}
