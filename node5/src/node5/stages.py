"""Task Graph stage nodes + integration of Agent Graph and Feedback Graph.

Task Graph (workflow edges): init → surface → … → validate_book → finalize
Agent Graph (inside class_probe): fan-out workers → join
Feedback Graph (after each live stage): structure / tool_use / evidence / coverage
State Handoff: cookies + surfaces + candidates flow through PenState
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from google.adk import Event

from node5.agent_graph import fan_out_class_probe, run_identity_chain_if_needed
from node5.agent_runner import run_agent
from node5.feedback import (
    evaluate_stage,
    filter_bookable,
    process_quality_metrics,
    promote_bookable_candidates,
    surface_ledger_ok,
    surface_needs_salvage,
    unclosed_surface_paths,
)
from node5.identity import (
    dedupe_bookable,
    merge_report_candidates,
    normalize_path,
    report_merge_key,
    upsert_candidate,
)
from node5.pack_loader import load_graph, load_skill, stage_skills, stage_success
from node5.state import Actor, Candidate, Finding, PenState, Resource, Surface, as_state
from node5.surface_model import (
    high_value_path_checklist,
    merge_actor,
    merge_resource,
    parse_actors_from_payload,
    parse_resources_from_payload,
    salvage_model_from_surfaces,
    surface_model_ok,
)
from node5.surface_salvage import salvage_surfaces
from node5.knowledge import (
    format_surface_matched_vulns,
    format_vuln_catalog,
    suggest_refs_for_surfaces,
)
from node5.high_value_probe import probe_high_value_paths
from node5.coverage import coverage_hints, compute_coverage_metrics
from node5.coverage_probes import run_coverage_probes
from node5.tools_act import CookieJar


def _graph(state: PenState) -> dict[str, Any]:
    return load_graph(Path(state.pack_root), state.graph_id)


def _multi_user_signals(state: PenState) -> bool:
    """Generic signals that dual-actor authz is feasible (not a target fingerprint)."""
    blob = " ".join(
        f"{s.path} {s.note} {s.method}" for s in state.surfaces
    ).lower()
    keys = (
        "register",
        "/users",
        "/user",
        "signup",
        "sign-up",
        "login",
        "basket",
        "cart",
        "order",
        "account",
        "whoami",
        "jwt",
        "token",
    )
    if any(k in blob for k in keys):
        return True
    if len(state.cookies) >= 1 and any(
        k in blob for k in ("api", "rest", "auth")
    ):
        return True
    return False


def _skill_bundle(state: PenState, stage: str) -> str:
    g = _graph(state)
    parts: list[str] = []
    for sid in stage_skills(g, stage)[:2]:
        parts.append(f"## skill:{sid}\n{load_skill(Path(state.pack_root), sid)}")
    if not parts:
        parts.append("(no pack skills for this stage — use judgment + tools)")
    return "\n\n".join(parts)


def _merge_payload(
    state: PenState,
    stage: str,
    payload: dict[str, Any] | None,
    raw: str,
    *,
    worker_id: str = "",
) -> int:
    """Merge payload into state; return number of new candidates."""
    if not payload:
        state.note(f"{stage}: no structured JSON; kept raw note")
        if raw:
            state.note(f"{stage}:raw {raw[:2000]}")
        return 0

    # Accept surfaces[] plus common aliases models invent
    raw_surfaces = list(payload.get("surfaces") or [])
    for alt in ("paths", "urls", "endpoints", "modules", "attack_surface"):
        extra = payload.get(alt)
        if isinstance(extra, list):
            raw_surfaces.extend(extra)
        elif isinstance(extra, str) and extra.strip():
            raw_surfaces.append(extra)

    for s in raw_surfaces:
        if isinstance(s, str):
            path = s
            surf = Surface(path=path)
        elif isinstance(s, dict):
            path = s.get("path") or s.get("url") or s.get("uri") or s.get("endpoint") or ""
            if not path:
                continue
            try:
                surf = Surface.model_validate({**s, "path": path})
            except Exception:
                surf = Surface(path=str(path), note=str(s.get("note") or s.get("name") or ""))
        else:
            continue
        # Dedupe surfaces by normalized path
        npath = normalize_path(surf.path, state.target)
        existing_paths = {normalize_path(x.path, state.target) for x in state.surfaces}
        if npath and npath not in existing_paths:
            state.surfaces.append(surf)
        elif npath in existing_paths:
            # upgrade status if more advanced
            for x in state.surfaces:
                if normalize_path(x.path, state.target) == npath:
                    rank = {"open": 0, "probed": 1, "booked": 2, "deadend": 1, "skipped": 0}
                    if rank.get(surf.status, 0) > rank.get(x.status, 0):
                        x.status = surf.status
                    if surf.note and not x.note:
                        x.note = surf.note
                    break

    # P0.1 business surface model
    for a in parse_actors_from_payload(payload):
        merge_actor(state, a)
    for r in parse_resources_from_payload(payload):
        merge_resource(state, r)

    n = 0
    merged = 0
    for c in payload.get("candidates") or []:
        if isinstance(c, dict) and c.get("title"):
            c = {
                **c,
                "stage": c.get("stage") or stage,
                "worker_id": worker_id or c.get("worker_id") or "",
            }
            try:
                cand = Candidate.model_validate(c)
            except Exception as e:
                state.note(f"{stage}: skip bad candidate: {e}")
                continue
            state.candidates, action = upsert_candidate(
                state.candidates,
                cand,
                target=state.target,
                allow_surface_book=False,
            )
            if action == "inserted":
                n += 1
            elif action == "merged":
                merged += 1
    if merged:
        state.note(f"{stage}: identity-merge updated {merged} existing candidate(s)")

    for note in payload.get("notes") or []:
        state.note(f"{stage}: {note}")
    if payload.get("summary"):
        state.note(f"{stage}:summary {payload['summary']}")

    # Optional cookie dict from agent JSON (rare)
    if isinstance(payload.get("cookies"), dict):
        raw_c = payload["cookies"]
        # Nested actor cookies: {"actor_a": {"token": "..."}, "token": "default"}
        flat: dict[str, str] = {}
        for k, v in raw_c.items():
            if isinstance(v, dict):
                aid = str(k)
                state.actor_cookies.setdefault(aid, {})
                state.actor_cookies[aid].update({str(ck): str(cv) for ck, cv in v.items()})
                merge_actor(
                    state,
                    Actor(id=aid, how="token", cookie_keys=list(v.keys())),
                )
            else:
                flat[str(k)] = str(v)
        if flat:
            state.cookies.update(flat)

    return n


async def _run_captain_stage(
    state: PenState,
    stage: str,
    *,
    retry_hint: str = "",
    max_events: int | None = None,
) -> tuple[str, dict[str, Any] | None, int]:
    """Single-agent Task node (captain Loop)."""
    g = _graph(state)
    success = stage_success(g, stage)
    skills = _skill_bundle(state, stage)
    jar = CookieJar(
        state.cookies,
        actor_cookies=state.actor_cookies,
    )

    op_notes = ""
    if state.operator_notes:
        op_notes = f"\nOperator notes:\n{state.operator_notes}\n"

    surface_rules = ""
    if stage == "surface":
        surface_rules = """
SURFACE LEDGER RULES (mandatory):
- Put EVERY observed path/module into surfaces[] as objects {{"path":"/...", "method":"GET|POST|...", "note":"..."}}.
- Prefer path-only locations (e.g. /vulnerabilities/upload/, /api/Users, /rest/user/login) not full sentences.
- ready_to_book must be false on surface; recon only.
- If the app has a vulnerability menu or sitemap, list each module path as its own surface.
- For SPA/API apps also capture: /api/*, /rest/*, /graphql, OpenAPI/Swagger if linked, register/login,
  object resources (cart/order/user/id patterns), file trees (/ftp, uploads), search endpoints,
  URL-fetch/upload/callback endpoints if seen (profile image URL, webhook, import URL, multipart upload).
- BUSINESS MODEL (mandatory for State Handoff):
  - actors[]: at least anon; if register/login exists add actor_a/actor_b with how=register|login
    example: {{"id":"anon","role_hint":"anon","how":"none"}}
  - resources[]: aggregate business objects from APIs (user, product, basket/order, file, …)
    example: {{"name":"user","paths":["/api/Users"],"actions_seen":["GET","POST"],"sensitivity":"user","id_locations":["path"]}}
  sensitivity: public|user|admin|secret. Group paths by object, not one resource per static asset.
- Incomplete surfaces[] fails the stage even if summary text is rich.
- Example surface: {{"path":"/api/Users","method":"POST","note":"registration","status":"open"}}
- """ + high_value_path_checklist() + """
"""
    stage_extra = ""
    if stage == "prior_reverify":
        stage_extra = """
PRIOR_REVERIFY RULES:
- Re-test actionable priors only. Prefer upgrading proof; leave list-API IDOR/BOLA for authz/class_probe.
- ready_to_book=true ONLY for hard exploit classes you re-prove this stage:
  auth bypass (SQLi/JWT acceptance), mass assignment privilege grant, unauthorized write (PUT/POST),
  path traversal with sensitive file, or secret-grade disclosure (password hash / private key file).
- Default ready_to_book=false for "public GET list JSON" / excessive data exposure / scoreboard.
- Do not emit more than ~3 ready_to_book candidates from this stage.
"""
    if stage == "auth_session":
        stage_extra = """
AUTH_SESSION RULES (observation-driven identity suite — bounded depth):
1. Login differential (valid vs invalid) if login surface exists.
2. Register / mass-assignment on create-user if register surface exists.
3. JWT: try alg:none accept proof when JWT present; if keys/pub available also try signed confusion with server acceptance.
4. Light probe only for reset/2fa surfaces (map endpoints). Deep 2FA/reset ATO is handled later by identity_chain specialist — do NOT thrash 2FA setup for many turns here.
5. Store tokens with actor_set_token. Output JSON promptly when login+register+JWT are covered.
- ready_to_book only with acceptance proof; set precondition.
"""
    if stage == "component":
        stage_extra = """
COMPONENT / HIGH-VALUE TECH RULES (fingerprint → knowledge → prove) — P2:
1. Probe technical surfaces if not done: /encryptionkeys, /support/logs, /api-docs, /graphql, /metrics.
2. JWT: keep probing alg:none accept proof; if jwt.pub or PEM under encryptionkeys, ALSO try
   algorithm-confusion / key misuse with server ACCEPTANCE (ref_read jwt-advanced). Both classes.
3. Stack fingerprint from headers/errors/JS → ref_query components → narrow nuclei if available.
4. SSTI: only on observed template sinks (profile username, email templates) — self-inject #{{7*7}} etc.
5. NoSQL: JSON login/search with operator injection only if Mongo-style APIs observed.
6. Version string alone is NOT a finding. Prove impact.
"""
    gaps = ""
    if stage in ("component", "class_probe", "authz_logic"):
        open_paths = unclosed_surface_paths(state)
        if open_paths:
            gaps = f"\nUnclosed / still-open surfaces to address: {json.dumps(open_paths)}\n"

    retry_block = f"\nRETRY HINT: {retry_hint}\n" if retry_hint else ""

    knowledge_hint = ""
    vuln_catalog_block = ""
    if state.pack_root:
        # Main/Captain: thin vuln directory for recall (details are worker-side ref_read)
        if stage in (
            "surface",
            "prior_reverify",
            "auth_session",
            "class_probe",
            "authz_logic",
            "component",
            "coverage_probe",
        ):
            cat = format_vuln_catalog(Path(state.pack_root), max_entries=40, for_main=True)
            if cat:
                vuln_catalog_block = f"\n{cat}\n"
            if state.surfaces:
                matched = format_surface_matched_vulns(
                    Path(state.pack_root), state.surfaces, limit=8
                )
                if matched:
                    vuln_catalog_block += f"\n{matched}\n"
        if stage in (
            "prior_reverify",
            "auth_session",
            "class_probe",
            "authz_logic",
            "component",
        ) and state.surfaces:
            # Keep short payload/component hints; do not embed full cards for Main
            knowledge_hint = suggest_refs_for_surfaces(
                Path(state.pack_root),
                state.surfaces,
                limit=4,
                embed_top=0,
            )
            if knowledge_hint:
                knowledge_hint = f"\n{knowledge_hint}\n"
    coverage_hint = ""
    if stage in (
        "class_probe",
        "coverage_probe",
        "authz_logic",
        "component",
        "auth_session",
    ):
        camp = coverage_hints(state)
        if camp:
            coverage_hint = f"\n{camp}\n"
            state.note(f"coverage: injected {camp.count(chr(10))+1} lines for stage {stage}")

    multi_user = _multi_user_signals(state)
    authz_rules = ""
    if stage == "authz_logic":
        if multi_user:
            authz_rules = """
AUTHZ RULES (multi-user signals present — dual-actor REQUIRED; THIS is the BOLA main path):
1. Create Actor A and Actor B (register two users if open). Store tokens via http_request actor=
   actor_a / actor_b (or cookies JSON nested {{"actor_a":{{"token":"..."}}}}).
2. From resources[] pick user/admin-sensitive objects (not static assets). Cap ~4 resources.
3. MATRIX per resource: A creates/owns → B GET/PUT/DELETE same id → anon GET. Record status+body diffs.
4. ready_to_book ONLY with dual-actor or unauth vs auth differential in proof_excerpt.
   Set precondition (e.g. "authenticated as actor_b"), affected_actor, affected_resource.
5. Do NOT only report "GET /api/X returns array" without naming actors.
JSON mandatory. Prefer quality matrix cells over more tools thrash.
"""
            if max_events is None:
                max_events = 56
        else:
            authz_rules = """
AUTHZ RULES: No strong multi-user/register signals in surfaces.
Do a short dual-cookie smoke if possible; otherwise return JSON with
notes=["skip: no dual-actor entry points observed"] and empty candidates.
Do not thrash tools. JSON is mandatory.
"""
            if max_events is None:
                max_events = 24

    # Cap long captain stages so class_probe + identity_chain keep wall-clock budget
    import os

    if max_events is None and stage == "auth_session":
        max_events = int(os.environ.get("NODE5_AUTH_SESSION_MAX_EVENTS") or "72")
    if max_events is None and stage == "prior_reverify":
        max_events = int(os.environ.get("NODE5_PRIOR_MAX_EVENTS") or "64")

    instruction = f"""You are a pentest STAGE CAPTAIN (Main) in Node5 (Task Graph node).
Authorized lab only. Follow RoE.

Target: {state.target}
Stage: {stage}
Success: {success}
RoE: {json.dumps(state.roe)}
allow_postex={state.roe.get("allow_postex", False)}
Shared cookies already set in tools (State Handoff) — do not forget sessions.

MAIN ROLE (catalog → dispatch mindset):
1. Use the VULN CATALOG below as a **directory** to expand recall (not a checklist of must-finds).
2. From observed surfaces/resources, select **1–3 catalog ids** that may apply to each area.
3. Prefer deep class tests via Agent Graph workers / focused probing on assigned paths;
   when you test yourself, ref_read the matching vulns/*.md detail first.
4. Catalog entry present ≠ target is vulnerable. Only live proof books.
{op_notes}{surface_rules}{stage_extra}{authz_rules}{vuln_catalog_block}{knowledge_hint}{coverage_hint}{gaps}{retry_block}
Methodology:
{skills}

Surfaces: {json.dumps([s.model_dump() for s in state.surfaces[:40]], ensure_ascii=False)}
Actors: {json.dumps([a.model_dump() for a in state.actors[:12]], ensure_ascii=False)}
Resources: {json.dumps([r.model_dump() for r in state.resources[:20]], ensure_ascii=False)}
Candidates: {json.dumps([c.model_dump() for c in state.candidates[:20]], ensure_ascii=False)}

Use shell / http_request against the target only.
When finished, output ONE JSON object (mandatory — prose-only fails Feedback structure):
  summary, surfaces[], actors[], resources[], candidates[], notes[]
  (actors/resources especially on surface; later stages may update them)
  candidates items: title, location, severity, proof_excerpt, causality, reproducibility, impact,
    ready_to_book, precondition, affected_actor, affected_resource
  notes may list catalog ids you considered (e.g. catalog_considered=["ssrf-url-fetch"]).

KNOWLEDGE TOOLS:
- VULN CATALOG summaries are already above. Full steps: ref_read path=vulns/<id>.md
- ref_list kind=vulns | ref_query | ref_read for details/payloads/components.
- Cards orient methodology; only live tool proof can be booked.
- Do not re-report the same vulnerability with a new title; upgrade proof_excerpt instead.

PROOF BAR for ready_to_book=true (all required):
- causality + reproducibility + impact + proof_excerpt from YOUR tools THIS stage
- You caused the condition (not sightseeing someone else's old payload in the DB)
- Prefer auth-bypass, unauthorized write, dual-actor differential, or secret-grade disclosure over pure enumeration
- SQL injection: prove data/auth effect (login bypass, UNION rows, boolean), not a single SQL error string alone
- XSS: inject your own payload via POST/PUT; GET-only observation of third-party script is NOT bookable
No invented vulns. Focus on THIS stage only.
IMPORTANT identity rules:
- Prefer stable location paths (module path without long titles); do not re-open the same vuln with a new title.
- If stage is surface: set ready_to_book=false for almost all candidates; record surfaces and weak candidates only.
- Do not re-emit candidates already listed above unless you are upgrading proof_excerpt with stronger live evidence.
- location must be a path or URL path, NEVER "GET /path" prefixes.
"""
    user_msg = f"Execute stage `{stage}` on {state.target}. Use tools, then output ONE JSON object only."
    if retry_hint:
        user_msg += f" {retry_hint}"
    result = await run_agent(
        state=state,
        agent_name=f"stage_{stage}",
        instruction=instruction,
        user_message=user_msg,
        jar=jar,
        max_events=max_events,
    )
    state.cookies = result.cookies
    if result.actor_cookies:
        for aid, bag in result.actor_cookies.items():
            state.actor_cookies.setdefault(aid, {}).update(bag)
    return result.raw, result.payload, result.tool_calls


async def _run_class_probe_agent_graph(state: PenState) -> tuple[int, int, int]:
    """Agent Graph fan-out for class_probe. Returns (tool_calls, new_cands, structured_workers)."""
    results, packages = await fan_out_class_probe(state)
    total_tools = 0
    new_cands = 0
    structured = 0
    for pkg_id, res in zip(packages, results):
        total_tools += res.tool_calls
        if res.payload:
            structured += 1
            new_cands += _merge_payload(
                state, "class_probe", res.payload, res.raw, worker_id=pkg_id
            )
        else:
            state.note(f"class_probe:{pkg_id}: unstructured raw_chars={len(res.raw)}")
            if res.raw:
                state.note(f"class_probe:{pkg_id}:raw {res.raw[:800]}")
    # Mark open vuln surfaces as probed if we got candidates on them
    for c in state.candidates:
        if c.stage != "class_probe":
            continue
        for s in state.surfaces:
            if c.location and (c.location in s.path or s.path in c.location):
                if s.status == "open":
                    s.status = "probed"
    state.note(
        f"class_probe: agent_graph join workers={len(packages)} "
        f"structured={structured} tools={total_tools} new_candidates={new_cands}"
    )
    return total_tools, new_cands, structured


def _post_surface_salvage(state: PenState, raw: str, payload: dict[str, Any] | None) -> None:
    """After surface (or any stage), fill surfaces from prose/candidates if ledger thin."""
    ok, det = surface_ledger_ok(state)
    need, need_det = surface_needs_salvage(state)
    if not ok or need or not state.surfaces:
        n = salvage_surfaces(
            state,
            raw=raw,
            payload=payload,
            source="post_stage_salvage" if not need else f"thin_salvage:{need_det[:40]}",
        )
        if need and n == 0:
            state.feedback_log(
                "surface_salvage",
                state.stage or "surface",
                False,
                f"thin_ledger {need_det}; salvage_added=0",
            )
        elif not ok:
            state.note(f"surface_salvage: ledger was weak ({det})")
    # Deterministic high-value path probe (closes prompt-only recon gap)
    # Always when ledger thin/API-shaped gap; else still try once for HV tech paths
    if not state.dry_run:
        try:
            added = probe_high_value_paths(state)
            if added:
                state.note(f"high_value_probe: +{len(added)} surface(s)")
        except Exception as e:
            state.note(f"high_value_probe: error {type(e).__name__}: {e}")
    # Always ensure actors/resources model exists for authz handoff (P0.1)
    na, nr = salvage_model_from_surfaces(state)
    if na or nr:
        state.note(f"surface_model: salvage actors+={na} resources={len(state.resources)}")


async def _execute_live_stage(state: PenState, stage: str) -> None:
    before_cands = len(state.candidates)

    # Soft-skip authz when not useful (no multi-user surfaces / single cookie world)
    if stage == "authz_logic" and not state.dry_run:
        cookie_n = len(state.cookies)
        # Only skip if we clearly lack material for dual-actor; still allow short run otherwise
        if cookie_n <= 2 and not any(
            "user" in (s.path or "").lower() or "admin" in (s.path or "").lower()
            for s in state.surfaces
        ):
            # Still do a short bounded attempt rather than full skip — capped events
            pass

    if stage == "class_probe" and state.agent_graph:
        # Ensure surfaces exist before path fan-out
        if len(state.surfaces) < 6:
            salvage_surfaces(
                state,
                raw="\n".join(state.notes[-30:]),
                payload=None,
                source="pre_class_probe_salvage",
            )
        # Re-probe high-value paths if still missing (e.g. model skipped them)
        if not state.dry_run and not any(
            "encryptionkey" in (s.path or "").lower()
            or "image/url" in (s.path or "").lower()
            or "support/logs" in (s.path or "").lower()
            for s in state.surfaces
        ):
            try:
                probe_high_value_paths(state)
                salvage_model_from_surfaces(state)
            except Exception as e:
                state.note(f"high_value_probe: pre_class_probe error {e}")
        tools, _new, structured = await _run_class_probe_agent_graph(state)
        # Multi-step identity specialist (once): 2FA/reset chain after wide fan-out
        try:
            tools += await run_identity_chain_if_needed(state)
        except Exception as e:
            state.note(f"identity_chain: error {type(e).__name__}: {e}")
        promoted = promote_bookable_candidates(state)
        if promoted:
            state.note(f"class_probe: promoted {promoted} quality-ok candidate(s) to ready_to_book")
        new_cands = len(state.candidates) - before_cands
        payload = {"_fan_out": True} if structured else None
        fb = evaluate_stage(
            state,
            stage,
            payload=payload,
            tool_calls=tools,
            new_candidates=new_cands,
            fan_out=True,
            structured_workers=structured,
        )
        state.last_stage_tool_calls = tools
        state.last_stage_structured = structured > 0
        if fb.should_retry:
            gaps = unclosed_surface_paths(state)
            inj = ""
            if any(
                x in " ".join(f"{s.path} {s.note}" for s in state.surfaces).lower()
                for x in ("search", "query", "?q=")
            ):
                inj = (
                    " INJECTION DEPTH: complete SQL ladder on search/query to data/auth effect "
                    "(UNION rows, emails, boolean result-set change) — SQLITE_ERROR alone will not book."
                )
            eg = ""
            if any(
                x in " ".join(f"{s.path} {s.note}" for s in state.surfaces).lower()
                for x in ("image/url", "webhook", "upload", "callback")
            ):
                eg = " Also probe URL-fetch/upload with server-side proof if present."
            low_yield = any("discovery_low_yield" in d for d in (fb.details or []))
            if low_yield:
                hint = (
                    "Discovery yield too low after fan-out (process quality). "
                    "As captain, re-test open surfaces and output ONE JSON with candidates[] "
                    f"(each needs proof_excerpt with HTTP evidence). Unclosed: {gaps}.{inj}{eg} "
                    "Do not invent vulns — only book live differentials."
                )
                state.feedback_log(
                    "retry", stage, True, "captain retry after discovery_low_yield"
                )
            else:
                hint = (
                    "Fan-out was weak or needs depth. As captain, output ONE JSON with candidates. "
                    f"Unclosed: {gaps}. Prefer injection depth, authz dual-actor, SSRF/upload, "
                    f"API mass-assignment with attacker-controlled proof.{inj}{eg}"
                )
                state.feedback_log("retry", stage, True, "captain JSON retry after weak fan-out")
            raw, pl, t2 = await _run_captain_stage(state, stage, retry_hint=hint)
            new_cands += _merge_payload(state, stage, pl, raw)
            state.last_stage_tool_calls += t2
            state.last_stage_structured = pl is not None or state.last_stage_structured
            evaluate_stage(
                state,
                stage,
                payload=pl,
                tool_calls=t2,
                new_candidates=new_cands,
                fan_out=False,
            )
        state.note(
            f"{stage}: live complete tools={state.last_stage_tool_calls} "
            f"structured={state.last_stage_structured}"
        )
        return

    # Task stage: deterministic coverage probes (Feedback owns attempt/close)
    if stage == "coverage_probe":
        before = len(state.candidates)
        probe_summary: dict[str, Any] = {}
        try:
            probe_summary = run_coverage_probes(state)
        except Exception as e:
            state.note(f"coverage_probe: probes error {type(e).__name__}: {e}")
            state.errors.append(f"coverage_probe: {type(e).__name__}: {e}")
        tools = int(probe_summary.get("http_total") or 0)
        from node5.coverage import untested_required

        gaps = untested_required(state)
        if gaps and not state.dry_run:
            camp_block = coverage_hints(state)
            hint = (
                "Deterministic probes ran. Finish UNTESTED coverage gaps with live tools: "
                f"{gaps}. Output ONE JSON with candidates. {camp_block}"
            )
            try:
                raw, pl, t2 = await _run_captain_stage(
                    state, "coverage_probe", retry_hint=hint, max_events=20
                )
                tools += t2
                _merge_payload(state, "coverage_probe", pl, raw)
            except Exception as e:
                state.note(f"coverage_probe: LLM fill error {e}")
        promoted = promote_bookable_candidates(state)
        if promoted:
            state.note(f"coverage_probe: promoted {promoted} quality-ok candidate(s)")
        new_cands = len(state.candidates) - before
        state.last_stage_tool_calls = tools
        state.last_stage_structured = new_cands > 0 or bool(probe_summary.get("attempted"))
        fb = evaluate_stage(
            state,
            stage,
            payload={"_coverage_probes": probe_summary} if probe_summary else None,
            tool_calls=tools,
            new_candidates=new_cands,
            fan_out=False,
        )
        if fb.should_retry and not state.dry_run:
            try:
                probe_summary2 = run_coverage_probes(state)
                tools += int(probe_summary2.get("http_total") or 0)
                state.note(f"coverage_probe: coverage retry probes={probe_summary2}")
            except Exception as e:
                state.note(f"coverage_probe: retry error {e}")
            evaluate_stage(
                state,
                stage,
                payload={"_coverage_probes": probe_summary},
                tool_calls=tools,
                new_candidates=len(state.candidates) - before,
                fan_out=False,
            )
        state.note(
            f"coverage_probe: complete http={tools} new_cands={new_cands} "
            f"ledger_n={len(state.coverage_ledger)}"
        )
        return

    # Authz budget: larger when multi-user signals; still capped
    if stage == "authz_logic":
        max_ev = 56 if _multi_user_signals(state) else 28
        # Track 1c: deterministic dual-actor matrix before LLM
        if not state.dry_run and _multi_user_signals(state):
            try:
                from node5.authz_matrix import run_authz_matrix

                mx = run_authz_matrix(state)
                state.note(
                    f"authz_matrix: pre-llm cells={mx.get('cells')} "
                    f"booked={mx.get('booked')} http={mx.get('http')}"
                )
            except Exception as e:
                state.note(f"authz_matrix: error {type(e).__name__}: {e}")
    else:
        max_ev = None
    raw, payload, tools = await _run_captain_stage(state, stage, max_events=max_ev)
    new_cands = _merge_payload(state, stage, payload, raw)
    if stage in ("surface", "prior_reverify"):
        _post_surface_salvage(state, raw, payload)
    elif stage == "authz_logic":
        salvage_model_from_surfaces(state)
        promote_bookable_candidates(state)
    state.last_stage_tool_calls = tools
    state.last_stage_structured = payload is not None
    fb = evaluate_stage(
        state,
        stage,
        payload=payload,
        tool_calls=tools,
        new_candidates=new_cands,
        fan_out=False,
    )
    if fb.should_retry:
        empty_ready = any("discovery_empty_ready" in d for d in (fb.details or []))
        if stage == "surface":
            hint = (
                "Surface ledger incomplete. Re-enumerate surfaces[] (>=6 app paths; API apps need denser "
                "appish + at least one auth/user path) AND actors[] (anon + actor_a/b if register) AND "
                "resources[] (aggregate API objects). ready_to_book=false. JSON only. Example keys: "
                "summary, surfaces, actors, resources, candidates, notes."
            )
        elif empty_ready and stage in ("prior_reverify", "auth_session"):
            hint = (
                "Process quality: tools ran but ready_to_book=0. If live HTTP showed auth bypass, "
                "data exposure, JWT accept, or object access differentials, emit candidates[] with "
                "proof_excerpt (method + path + status + effect). If truly no effect, candidates=[] "
                "and notes=['no exploitable effect observed']. ONE JSON only — no prose-only exit."
            )
        elif stage == "auth_session" and not state.last_stage_structured:
            hint = (
                "auth_session requires ONE JSON object (structure contract). Include login differential, "
                "session/JWT notes, and any candidates with proof_excerpt. Prose-only fails Feedback."
            )
        elif stage == "component":
            gaps = unclosed_surface_paths(state)
            hint = (
                "Previous output was not valid JSON. Output ONE JSON object only. "
                f"Probe unclosed surfaces for RCE/LFI/upload/secrets: {gaps}"
            )
        elif stage == "authz_logic":
            if _multi_user_signals(state):
                hint = (
                    "Output ONE JSON only. Dual-actor attempt required: register/login two users if possible, "
                    "cross-access object IDs, book only differentials. "
                    "If truly impossible, notes=['skip: dual-actor failed'] and empty candidates."
                )
            else:
                hint = (
                    "Output ONE short JSON only. If dual-actor not available, "
                    "notes=['skip: no dual actor'] and empty candidates. Do not thrash tools."
                )
        else:
            hint = (
                "Previous output was not valid JSON or incomplete. "
                "Output ONE JSON object only with surfaces/candidates/notes."
            )
        state.feedback_log("retry", stage, True, f"JSON/ledger/discovery retry: {fb.details}")
        retry_max = 20 if stage == "authz_logic" else (40 if stage == "surface" else None)
        raw2, pl2, t2 = await _run_captain_stage(
            state, stage, retry_hint=hint, max_events=retry_max
        )
        new_cands += _merge_payload(state, stage, pl2, raw2)
        if stage in ("surface", "prior_reverify"):
            _post_surface_salvage(state, raw2, pl2)
            # Final salvage from combined raw if still thin
            ok, det = surface_ledger_ok(state)
            need, _ = surface_needs_salvage(state)
            if (not ok or need) and stage == "surface":
                salvage_surfaces(
                    state,
                    raw=(raw or "") + "\n" + (raw2 or ""),
                    payload=pl2 or payload,
                    source="surface_final_salvage",
                )
                if not state.dry_run:
                    try:
                        probe_high_value_paths(state)
                    except Exception as e:
                        state.note(f"high_value_probe: final {type(e).__name__}: {e}")
        state.last_stage_tool_calls += t2
        state.last_stage_structured = pl2 is not None or state.last_stage_structured
        evaluate_stage(
            state,
            stage,
            payload=pl2,
            tool_calls=t2,
            new_candidates=new_cands,
            fan_out=False,
        )
    elif stage == "surface":
        # structure ok but ledger may still be thin — salvage + HV probes
        _post_surface_salvage(state, raw, payload)
        ok, det = surface_ledger_ok(state)
        need, need_det = surface_needs_salvage(state)
        if not ok:
            state.feedback_log("surface_ledger", stage, False, f"after_salvage {det}")
        elif need:
            state.feedback_log(
                "surface_ledger", stage, True, f"pass_with_thin_salvage {need_det}"
            )

    # Authz second structure fail: log soft skip, do not thrash further
    if stage == "authz_logic" and not state.last_stage_structured:
        state.note("authz_logic: soft-complete without structured JSON (bounded); continuing Task Graph")
        state.feedback_log("authz_soft_skip", stage, True, "no dual-actor structured result")

    state.note(
        f"{stage}: live complete tools={state.last_stage_tool_calls} "
        f"structured={state.last_stage_structured} surfaces={len(state.surfaces)}"
    )


def make_stage_node(stage: str):
    async def stage_fn(node_input: Any) -> Event:
        state = as_state(node_input)
        only = set(state.only_stages or [])
        if only and stage not in only:
            state.note(f"{stage}: skipped (not in only_stages={sorted(only)})")
            if stage not in state.stages_done:
                state.stages_done.append(stage)
            state.stage = stage
            return Event(output=state.model_dump())

        state.mark_stage(stage)
        state.note(f"{stage}: begin")

        if state.dry_run:
            if stage == "surface":
                # Seed enough appish paths for ledger gate + path package selection
                seeds = [
                    "/",
                    "/login.php",
                    "/vulnerabilities/sqli/",
                    "/vulnerabilities/xss_r/",
                    "/vulnerabilities/upload/",
                    "/vulnerabilities/exec/",
                    "/vulnerabilities/fi/",
                    "/vulnerabilities/csrf/",
                    "/config/",
                ]
                for p in seeds:
                    if not any(normalize_path(s.path) == normalize_path(p) for s in state.surfaces):
                        state.surfaces.append(
                            Surface(path=p, method="GET", note="dry-run seed", status="open")
                        )
            if stage == "class_probe" and state.agent_graph:
                from node5.packages import packages_from_surfaces

                pkgs = packages_from_surfaces(state, max_workers=state.max_workers)
                state.agent_packages = [p["worker_id"] for p in pkgs]
                state.note(
                    f"class_probe: dry-run agent_graph packages={state.agent_packages} "
                    f"path_map={[(p['skill_id'], p.get('paths')) for p in pkgs]}"
                )
            if stage == "coverage_probe":
                run_coverage_probes(state)
            state.feedback_log("structure", stage, True, "dry-run")
            state.feedback_log("tool_use", stage, True, "dry-run")
            if stage == "surface":
                state.feedback_log("surface_ledger", stage, True, "dry-run")
            state.note(f"{stage}: dry-run complete ({stage_success(_graph(state), stage)})")
            return Event(output=state.model_dump())

        try:
            await _execute_live_stage(state, stage)
        except Exception as e:
            state.errors.append(f"{stage}: {type(e).__name__}: {e}")
            state.note(f"{stage}: error {e}")
            state.feedback_log("structure", stage, False, str(e))

        return Event(output=state.model_dump())

    stage_fn.__name__ = f"stage_{stage}"
    stage_fn.__qualname__ = f"stage_{stage}"
    return stage_fn


def init_node(node_input: Any) -> Event:
    state = as_state(node_input)
    if not state.pack_root:
        from node5.pack_loader import default_pack_root

        state.pack_root = str(default_pack_root())
    g = _graph(state)
    state.roe = {**g.get("roe", {}), **state.roe}
    state.note(
        f"init: target={state.target} graph={state.graph_id} dry_run={state.dry_run} "
        f"model={state.model} agent_graph={state.agent_graph} max_workers={state.max_workers}"
    )
    state.note(
        "init: layers TaskGraph=hard-stages | AgentGraph=class_probe fan-out | "
        "Feedback=structure/tool/evidence/coverage | StateHandoff=cookies"
    )
    state.mark_stage("init")
    return Event(output=state.model_dump())


def validate_book_node(node_input: Any) -> Event:
    """Deterministic book + evidence Feedback loop + identity dedupe."""
    state = as_state(node_input)
    state.mark_stage("validate_book")

    promoted = promote_bookable_candidates(state)
    if promoted:
        state.note(f"validate_book: promoted {promoted} quality-ok candidate(s) before filter")

    # Collapse multi-stage duplicates first (path_norm + vuln_class)
    collapsed, suppressed = dedupe_bookable(state.candidates, target=state.target)
    if suppressed:
        state.feedback_log(
            "dedupe",
            "validate_book",
            True,
            f"suppressed_duplicate_candidates={suppressed} unique={len(collapsed)}",
        )
        state.note(
            f"validate_book: identity dedupe {len(state.candidates)} → {len(collapsed)} "
            f"(suppressed {suppressed})"
        )
        state.candidates = collapsed

    from node5.feedback import evidence_quality_gate, prior_reverify_bookable

    quality_fail = 0
    prior_defer = 0
    for c in state.candidates:
        if c.stage == "surface":
            continue
        if not (c.causality and c.reproducibility and c.impact and c.proof_excerpt):
            continue
        ok, reason = evidence_quality_gate(c)
        if not ok:
            quality_fail += 1
            state.note(f"validate_book: quality skip [{reason}] {c.title[:80]}")
            continue
        ok_p, pr = prior_reverify_bookable(c)
        if not ok_p:
            prior_defer += 1
            state.note(f"validate_book: prior_defer [{pr}] {c.title[:80]}")

    bookable = filter_bookable(state.candidates)
    # Surface-stage candidates: never book (recon only) even if model set ready
    bookable = [c for c in bookable if c.stage != "surface"]
    bookable, merge_n = merge_report_candidates(bookable, target=state.target)
    if merge_n:
        state.note(f"validate_book: report-merge suppressed {merge_n} near-duplicate candidate(s)")
        state.feedback_log("dedupe", "validate_book", True, f"report_merge_suppressed={merge_n}")

    booked = 0
    seen_ids: set[tuple[str, str]] = set()
    for c in bookable:
        key = report_merge_key(title=c.title, location=c.location, target=state.target)
        if key in seen_ids:
            continue
        if any(
            report_merge_key(title=f.title, location=f.location, target=state.target) == key
            for f in state.findings
        ):
            continue
        seen_ids.add(key)
        loc = normalize_path(c.location.split(",")[0].strip(), state.target) or c.location
        title = re.sub(
            r"^(critical|high|medium|low|info|informational)\s*:\s*",
            "",
            (c.title or "").strip(),
            flags=re.IGNORECASE,
        )
        state.findings.append(
            Finding(
                title=title or c.title,
                location=loc,
                severity=c.severity,
                proof=c.proof_excerpt,
                stage=c.stage or "validate_book",
                precondition=c.precondition or "",
                affected_actor=c.affected_actor or "",
                affected_resource=c.affected_resource or "",
            )
        )
        booked += 1
        npath = normalize_path(c.location.split(",")[0].strip(), state.target)
        for s in state.surfaces:
            sp = normalize_path(s.path, state.target)
            if npath and (npath == sp or npath in sp or sp in npath):
                s.status = "booked"
    skipped = len(state.candidates) - len(bookable)
    state.feedback_log(
        "evidence",
        "validate_book",
        True,
        f"booked={booked} skipped_weak_or_incomplete_or_surface={skipped}",
    )
    state.feedback_log(
        "evidence_quality",
        "validate_book",
        quality_fail == 0 or booked > 0,
        f"quality_fail={quality_fail} prior_defer={prior_defer} booked={booked}",
    )
    state.note(
        f"validate_book: booked {booked} unique finding(s) "
        f"from {len(state.candidates)} candidates (surface rows not bookable)"
    )
    return Event(output=state.model_dump())


def finalize_node(node_input: Any) -> Event:
    state = as_state(node_input)
    state.mark_stage("finalize")
    from node5.coverage import untested_required

    cov = compute_coverage_metrics(state)
    unt = untested_required(state)
    pq = process_quality_metrics(state)
    state.feedback_log(
        "coverage",
        "finalize",
        len(unt) == 0,
        f"untested={unt} attempt_rate={cov.get('coverage_attempt_rate')}",
    )
    # Process quality is soft at finalize (already retried mid-stage) but must be visible
    pq_ok = (
        pq.get("discovery_yield_soft_fail_n", 0) == 0
        and pq.get("structure_fail_n", 0) == 0
    )
    state.feedback_log(
        "discovery_yield",
        "finalize",
        pq_ok,
        (
            f"structure_fail_n={pq.get('structure_fail_n')} "
            f"discovery_soft_fail_n={pq.get('discovery_yield_soft_fail_n')} "
            f"stages={pq.get('discovery_yield_soft_fail_stages')} "
            f"ready_by_stage={pq.get('ready_by_stage')}"
        ),
    )
    fb_ok = sum(1 for f in state.feedback if f.ok)
    fb_fail = sum(1 for f in state.feedback if not f.ok)
    pre_n = sum(1 for f in state.findings if f.precondition)
    state.note(
        f"finalize: stages_done={state.stages_done} findings={len(state.findings)} "
        f"surfaces={len(state.surfaces)} resources={len(state.resources)} actors={len(state.actors)} "
        f"candidates={len(state.candidates)} coverage_ledger={len(state.coverage_ledger)} "
        f"cov_attempt_rate={cov.get('coverage_attempt_rate')} "
        f"cov_close_rate={cov.get('coverage_close_rate')} untested={unt} "
        f"process_structure_fail={pq.get('structure_fail_n')} "
        f"process_discovery_soft_fail={pq.get('discovery_yield_soft_fail_n')} "
        f"errors={len(state.errors)} feedback_ok={fb_ok} feedback_fail={fb_fail} "
        f"cookies={list(state.cookies.keys())} actor_jars={list(state.actor_cookies.keys())} "
        f"agent_packages={state.agent_packages} forced={state.forced_packages} "
        f"eff_workers={state.effective_max_workers} findings_with_precondition={pre_n}"
    )
    if state.work_dir:
        out = Path(state.work_dir)
        out.mkdir(parents=True, exist_ok=True)
        (out / "state.json").write_text(
            json.dumps(state.to_public_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        (out / "findings.json").write_text(
            json.dumps([f.model_dump() for f in state.findings], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        from node5.identity import identity_key

        unique_ids = {
            identity_key(title=f.title, location=f.location, target=state.target)
            for f in state.findings
        }
        by_sev: dict[str, int] = {
            "critical": 0,
            "high": 0,
            "medium": 0,
            "low": 0,
            "info": 0,
        }
        for f in state.findings:
            sk = (f.severity or "medium").strip().lower()
            if sk not in by_sev:
                sk = "info" if sk in ("informational", "none") else "medium"
            by_sev[sk] = by_sev.get(sk, 0) + 1
        summary = {
            "target": state.target,
            "graph_id": state.graph_id,
            "dry_run": state.dry_run,
            "model": state.model,
            "findings_by_severity": by_sev,
            "authz_matrix_cells": len(state.authz_matrix or []),
            "layers": {
                "task_graph": "hard sequential app_assessment",
                "agent_graph": state.agent_graph,
                "agent_packages": state.agent_packages,
                "forced_packages": state.forced_packages,
                "effective_max_workers": state.effective_max_workers or state.max_workers,
                "feedback_ok": fb_ok,
                "feedback_fail": fb_fail,
                "cookie_keys": list(state.cookies.keys()),
                "actor_jars": list(state.actor_cookies.keys()),
                "actors_n": len(state.actors),
                "resources_n": len(state.resources),
                "findings_with_precondition": pre_n,
                "coverage_ledger_n": len(state.coverage_ledger),
            },
            "coverage_metrics": state.coverage_metrics or cov,
            "hv_metrics": state.hv_metrics or cov,
            "process_metrics": pq,
            "coverage_ledger_tail": state.coverage_ledger[-30:],
            "stages_done": state.stages_done,
            "surface_count": len(state.surfaces),
            "candidate_count": len(state.candidates),
            "finding_count": len(state.findings),
            "finding_unique_identities": len(unique_ids),
            "errors": state.errors,
            "feedback": [f.model_dump() for f in state.feedback[-40:]],
            "notes_tail": state.notes[-30:],
        }
        (out / "summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        state.note(f"finalize: wrote {out}/state.json findings.json summary.json")
    return Event(output=state.model_dump())
