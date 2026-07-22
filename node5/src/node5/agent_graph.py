"""Agent Graph — fan-out workers for class_probe (path-driven packages)."""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any

from node5.agent_runner import AgentRunResult, run_agent
from node5.identity import normalize_path
from node5.coverage import coverage_hints
from node5.knowledge import format_worker_vuln_assignment
from node5.pack_loader import load_skill
from node5.packages import effective_worker_budget, packages_from_surfaces
from node5.state import PenState
from node5.tools_act import CookieJar


def select_class_probe_packages(
    state: PenState, pack_root: Path, max_workers: int
) -> list[dict[str, Any]]:
    """Path-first package selection with dynamic HV worker budget (discovery P2)."""
    eff = effective_worker_budget(state, base_max=max_workers)
    state.effective_max_workers = eff
    return packages_from_surfaces(state, max_workers=eff, pack_root=pack_root)


async def run_worker_package(
    state: PenState,
    package: dict[str, Any],
    jar: CookieJar,
) -> AgentRunResult:
    skill_id = package["skill_id"]
    skill_text = load_skill(Path(state.pack_root), skill_id)
    focus = package["focus"]
    worker_id = package["worker_id"]
    focus_paths = package.get("paths") or []

    # Prefer path-scoped surfaces for this worker
    if focus_paths:
        surfaces = []
        for s in state.surfaces:
            np = normalize_path(s.path, state.target)
            if any(fp in (s.path or "").lower() or fp == np or (np and fp in np) for fp in focus_paths):
                surfaces.append(s.model_dump())
        if not surfaces:
            surfaces = [s.model_dump() for s in state.surfaces[:30]]
    else:
        surfaces = [s.model_dump() for s in state.surfaces[:30]]

    op = state.operator_notes or ""
    vuln_assign = ""
    if state.pack_root:
        force_ids = package.get("catalog_force") or []
        if force_ids:
            lines = [
                "ASSIGNED VULN CATALOG IDS (forced for this worker):",
                "ref_read each detail, follow checkpoints, book only at chain tail / execution proof.",
            ]
            for fid in force_ids[:2]:
                lines.append(f"- id=`{fid}` detail=`vulns/{fid}.md`")
            vuln_assign = "\n".join(lines) + "\n"
        else:
            vuln_assign = format_worker_vuln_assignment(
                Path(state.pack_root),
                skill_id,
                max_ids=2,
                paths=list(focus_paths or []),
                surfaces=state.surfaces,
            )
            if vuln_assign:
                vuln_assign = vuln_assign + "\n"
    camp = coverage_hints(state)
    camp_block = (camp + "\n") if camp else ""

    instruction = f"""You are an Agent Graph WORKER (not the captain) in Node5.
Worker id: {worker_id}
Skill: {skill_id}
Target: {state.target}
RoE: {json.dumps(state.roe)}
allow_postex={state.roe.get("allow_postex", False)}

Your ONLY job: {focus}
Assigned paths (probe these first): {json.dumps(focus_paths, ensure_ascii=False)}
You share a cookie jar with other workers (already seeded). Prefer http_request.
Do not re-do full recon; use provided surfaces.

WORKER KNOWLEDGE FLOW (required):
1. For each ASSIGNED VULN CATALOG id below, call ref_read path=<detail> (e.g. vulns/ssrf-url-fetch.md).
2. From the detail steps, plan tests for YOUR assigned paths only.
3. Execute with tools; book only live proof. Skip ids that do not match surfaces.
4. Catalog/detail is methodology — not a guarantee the target is vulnerable.
{vuln_assign}{camp_block}Do not re-test paths exclusive to other workers; stay on your exclusive paths / skill focus.
SQL: ladder to data/auth effect (UNION/emails/schema — not error-only).
SSRF: in-scope server-side fetch with state/body proof (not 500-only).
XSS: inject your own payload; sightseeing third-party scripts does not book.
JWT: alg:none and/or key-confusion with server ACCEPTANCE when material present.
Upload: type/path impact within RoE with stored-path proof.
Do not re-title the same vuln another worker already found.
Operator notes:
{op}

Skill methodology:
{skill_text}

Surfaces:
{json.dumps(surfaces, ensure_ascii=False)}

When done, output ONE JSON object (mandatory — unstructured prose fails the stage):
  summary: string
  surfaces: []  (only new paths if any)
  candidates: [{{title, location, severity, proof_excerpt, causality, reproducibility, impact, ready_to_book}}]
  notes: [string]  (include catalog ids you ref_read and tested)

PROOF BAR for ready_to_book=true:
- causality + reproducibility + impact + proof_excerpt from YOUR tools THIS worker
- You caused the condition (do not book third-party/old XSS you only GETted)
- XSS: POST/PUT your own payload then show reflection/storage
- SQLi: data or auth effect (bypass/UNION/boolean), not a single SQL error fingerprint
- Authz/API: unauth vs auth or userA vs userB differential, or unauthorized state change
- Prefer state-changing / auth-bypass over pure enumeration
Use stable location paths (module path only, not "GET /path?...").
Bounded deadends OK. No invented vulns.
"""
    safe_name = "".join(ch if (ch.isalnum() or ch == "_") else "_" for ch in worker_id)
    if not safe_name or safe_name[0].isdigit():
        safe_name = "w_" + safe_name
    import os

    # Budget tiers: DOM/browser and identity chains need more events than shallow API probes
    if "xss-dom" in (worker_id or "") or (package.get("catalog_force") or [None])[0] == "xss-dom-client":
        max_ev = int(os.environ.get("NODE5_DOM_WORKER_MAX_EVENTS") or "160")
    elif "identity_chain" in (worker_id or ""):
        max_ev = int(os.environ.get("NODE5_CHAIN_MAX_EVENTS") or "300")
    elif skill_id in {
        "pentest-auth-session",
        "pentest-api",
        "pentest-ssrf",
        "pentest-authz-logic",
        "pentest-sql-injection",
    }:
        max_ev = int(os.environ.get("NODE5_DEEP_WORKER_MAX_EVENTS") or "180")
    else:
        max_ev = int(os.environ.get("NODE5_WORKER_MAX_EVENTS") or "96")

    # DOM-only workers: force browser composite ops into instruction
    if "xss-dom" in (worker_id or ""):
        instruction += """

DOM WORKER HARD RULES:
1. ref_read vulns/xss-dom-client.md first.
2. ALWAYS use browser op=open_eval or open_text or open_spa WITH url= in ONE call.
   Never browser(open) then browser(eval) as two calls — each call is a fresh Chromium;
   only composites keep open→SPA-wait→eval in one session.
3. For SPA routes use hash URLs (e.g. TARGET/#/search?q=PAYLOAD). Prefer search/UGC sinks.
4. open_eval script: prefer document.body.innerHTML or body.innerText (not documentElement head-only slice);
   look for your marker/payload in rendered results.
5. Book XSS only with execution/DOM proof (payload in rendered HTML / handler evidence);
   if only app-root/ng-version shell: notes chain_stop=S2, not a finding.
6. Budget limited — one sink to S3 or honest fail.
"""
    result = await run_agent(
        state=state,
        agent_name=safe_name[:48],
        instruction=instruction,
        user_message=(
            f"Worker {worker_id}: ref_read assigned vuln details, then probe assigned paths "
            f"on {state.target}. Output ONE JSON object only."
        ),
        jar=jar,
        max_events=max_ev,
    )
    # Surface truncation observability into notes
    if "[truncated_after_" in (result.raw or ""):
        state.note(f"agent_graph: {worker_id} truncated at max_events={max_ev}")
    return result


async def fan_out_class_probe(state: PenState) -> tuple[list[AgentRunResult], list[str]]:
    pack_root = Path(state.pack_root)
    packages = select_class_probe_packages(state, pack_root, state.max_workers)
    # P2: assert needed HV skills present; force-append if missing
    from node5.packages import needed_high_value_skills

    have = {p["skill_id"] for p in packages}
    for sid in needed_high_value_skills(state):
        if sid not in have:
            packages.append(
                {
                    "worker_id": f"class_probe/{sid}",
                    "skill_id": sid,
                    "focus": f"Forced HV package {sid} (schedule assert)",
                    "paths": [],
                    "score": 100.0,
                }
            )
            have.add(sid)
            if sid not in (state.forced_packages or []):
                state.forced_packages = list(state.forced_packages or []) + [sid]
            state.note(f"agent_graph: force-appended missing HV skill {sid}")
    # DOM-only xss worker when SPA/UGC signals present (before cap)
    blob = " ".join(f"{s.path} {s.note}" for s in state.surfaces).lower()
    if any(x in blob for x in ("feedback", "review", "#/", "angular", "spa", "search")):
        dom_paths = []
        for s in state.surfaces:
            pl = f"{s.path} {s.note}".lower()
            if any(x in pl for x in ("feedback", "review", "search", "#/")):
                if s.path and s.path not in dom_paths:
                    dom_paths.append(s.path)
        packages.append(
            {
                "worker_id": "class_probe/pentest-xss-dom",
                "skill_id": "pentest-xss",
                "focus": (
                    "DOM/client XSS only: ref_read vulns/xss-dom-client.md; "
                    "use browser open_text/open_eval; book only with execution proof. "
                    f"| exclusive paths: {', '.join((dom_paths or ['/'])[:6])}"
                ),
                "paths": (dom_paths or [])[:8],
                "score": 88.0,
                "catalog_force": ["xss-dom-client"],
            }
        )

    if len(packages) > 8:
        # Always keep xss-dom if present; fill rest by score
        dom = [p for p in packages if "xss-dom" in (p.get("worker_id") or "")]
        rest = sorted(
            [p for p in packages if "xss-dom" not in (p.get("worker_id") or "")],
            key=lambda p: (-float(p.get("score") or 0), p.get("skill_id") or ""),
        )
        packages = (dom[:1] + rest)[:8]
    # Backfill auth-session exclusive paths if partition left them empty
    for p in packages:
        if p.get("skill_id") == "pentest-auth-session" and not (p.get("paths") or []):
            from node5.packages import _SKILL_PATH_HINTS

            hint = _SKILL_PATH_HINTS.get("pentest-auth-session")
            claimed: list[str] = []
            for s in state.surfaces:
                path = s.path or ""
                if hint and hint.search(f"{path} {s.note or ''}"):
                    if path not in claimed:
                        claimed.append(path)
                if len(claimed) >= 6:
                    break
            if claimed:
                p["paths"] = claimed
                foc = p.get("focus") or ""
                foc = re.sub(r"\s*\|\s*(exclusive|no exclusive).*$", "", foc).strip()
                p["focus"] = f"{foc} | exclusive paths: {', '.join(claimed[:8])}"
    state.effective_max_workers = max(
        state.effective_max_workers or 0, len(packages), state.max_workers
    )
    state.agent_packages = [p["worker_id"] for p in packages]
    state.note(
        f"agent_graph: fan-out packages={state.agent_packages} "
        f"eff_workers={state.effective_max_workers} forced={state.forced_packages} "
        f"path_map={[ (p['skill_id'], p.get('paths')) for p in packages ]}"
    )

    jar = CookieJar(state.cookies, actor_cookies=state.actor_cookies)
    sem = asyncio.Semaphore(max(1, state.effective_max_workers or state.max_workers))

    async def _one(pkg: dict[str, Any]) -> AgentRunResult:
        async with sem:
            state.note(f"agent_graph: start {pkg['worker_id']} paths={pkg.get('paths')}")
            try:
                return await run_worker_package(state, pkg, jar)
            except Exception as e:
                state.note(f"agent_graph: worker fail {pkg['worker_id']}: {e}")
                return AgentRunResult(
                    raw=f"error: {e}",
                    payload=None,
                    tool_calls=0,
                    cookies=jar.snapshot(),
                    actor_cookies=jar.snapshot_actors(),
                )

    results = await asyncio.gather(*[_one(p) for p in packages])
    state.cookies = jar.snapshot()
    state.actor_cookies = jar.snapshot_actors()
    return list(results), state.agent_packages


def identity_chain_should_run(state: PenState) -> tuple[bool, str, str]:
    """Return (run?, catalog_id, reason). Generic signals — not target keys."""
    passes = int(getattr(state, "_identity_chain_passes", 0) or 0)
    if passes >= 2:
        return False, "", "max_passes"
    blob = " ".join(
        [
            " ".join(f"{s.path} {s.note}" for s in state.surfaces),
            " ".join(f"{c.title} {c.proof_excerpt}" for c in state.candidates),
            " ".join(state.notes[-50:]),
        ]
    ).lower()
    has_2fa = any(x in blob for x in ("2fa", "totp", "totpsecret", "mfa", "/otp"))
    has_reset = any(
        x in blob
        for x in ("reset-password", "forgot", "security-question", "securityquestion")
    )
    has_auth_head = any(
        x in blob
        for x in (
            "sql injection",
            "jwt",
            "mass assignment",
            "alg:none",
            "authentication bypass",
        )
    )
    from node5.coverage import coverage_outcome, required_coverage

    req_ids = {r.id for r in required_coverage(state)}
    id2fa_open = "identity_2fa" in req_ids and coverage_outcome(state, "identity_2fa") not in (
        "closed",
    )
    idreset_open = "identity_reset" in req_ids and coverage_outcome(
        state, "identity_reset"
    ) not in ("closed",)

    if has_2fa and (has_auth_head or id2fa_open or "totpsecret" in blob):
        return True, "totp-2fa", "2fa_signal"
    if has_reset and (has_auth_head or idreset_open):
        return True, "password-reset-ato", "reset_signal"
    if has_2fa:
        return True, "totp-2fa", "2fa_surface_only"
    if has_reset:
        return True, "password-reset-ato", "reset_surface_only"
    return False, "", "no_signal"


def _identity_blob(state: PenState) -> str:
    return (
        " ".join(state.notes[-40:]).lower()
        + " "
        + " ".join(
            f"{c.title} {c.proof_excerpt} {c.impact}" for c in state.candidates[-16:]
        ).lower()
        + " "
        + " ".join(
            f"{f.title} {f.proof}" for f in (state.findings or [])[-12:]
        ).lower()
    )


def _identity_s3_done(blob: str, cat_id: str) -> bool:
    if "chain_stop=s3" in blob or "checkpoint s3" in blob or "s3 complete" in blob:
        return True
    if cat_id == "totp-2fa":
        return any(
            x in blob
            for x in (
                "2fa bypass",
                "login after 2fa",
                "verify success",
                "authenticated after 2fa",
                "whoami after verify",
            )
        )
    if cat_id == "password-reset-ato":
        return any(
            x in blob
            for x in (
                "login with new",
                "logged in with new",
                "re-login success",
                "ato complete",
            )
        )
    return False


def _identity_half_step(blob: str, cat_id: str) -> bool:
    """Half-step signals — do not require exact chain_stop=S1 wording."""
    common = (
        "chain_stop=s1",
        "chain_stop=s2",
        "chain_stop=s0",
        "s0→s1",
        "s0→s2",
        "s0->s1",
        "s0->s2",
        "s1→s2",
        "s1->s2",
        "half-step",
        "half step",
        "stopped at s1",
        "stopped at s2",
    )
    if any(x in blob for x in common):
        return True
    if cat_id == "totp-2fa":
        return any(
            x in blob
            for x in (
                "secret exposure",
                "totp secret",
                "totpsecret",
                "setup returns 401",
                "setup return 401",
                "setup 401",
                "2fa/setup",
                "/rest/2fa/setup",
                "totp code generated",
                "totp code",
                "otpauth",
                "setup token",
                "setuptoken",
                "enable 2fa",
                "2fa setup",
                "two-factor",
                "two factor",
            )
        )
    if cat_id == "password-reset-ato":
        return any(
            x in blob
            for x in (
                "reset accepted",
                "security question",
                "security-question",
                "forgot password",
                "reset-password",
                "answer accepted",
                "password reset",
            )
        )
    return False


def identity_chain_needs_continue(
    state: PenState,
    cat_id: str,
    *,
    pass0_tools: int = 0,
) -> bool:
    """True if first pass stopped before S3 and a second push may reach it.

    Triggers when:
    - half-step wording / secret exposure / setup 401 / etc., OR
    - pass0 spent meaningful budget (tools>=20) without S3 proof (force pass1).
    """
    blob = _identity_blob(state)
    if _identity_s3_done(blob, cat_id):
        return False
    half = _identity_half_step(blob, cat_id)
    if half:
        return True
    # Force continue: substantial first pass without S3 (agent often omits chain_stop=)
    min_tools = 20
    try:
        import os

        min_tools = int(os.environ.get("NODE5_CHAIN_FORCE_CONTINUE_TOOLS") or "20")
    except ValueError:
        min_tools = 20
    if pass0_tools >= min_tools:
        return True
    return False


def annotate_identity_half_step(state: PenState, cat_id: str, pass_i: int, tools: int) -> None:
    """Persist half-step signal into notes so continue detection is not LLM-wording dependent."""
    blob = _identity_blob(state)
    if _identity_s3_done(blob, cat_id):
        state.note(f"identity_chain: pass={pass_i} observed S3 signals tools={tools}")
        return
    if _identity_half_step(blob, cat_id):
        # Normalize keyword for next-pass detector even if agent used free text
        state.note(
            f"identity_chain: pass={pass_i} half-step detected for {cat_id} "
            f"tools={tools} chain_stop=S1|S2 (auto-annotate)"
        )
        return
    if tools >= 8:
        state.note(
            f"identity_chain: pass={pass_i} no S3 after tools={tools} "
            f"catalog={cat_id} chain_stop=S2 (budget spent, incomplete)"
        )


_TOTP_CHAIN_FOCUS = """
IDENTITY CHAIN — TOTP/2FA (catalog totp-2fa). ONE goal: reach checkpoint S3.

MANDATORY SEQUENCE (do not stop at secret exposure):
S0) Map 2fa/status, setup, verify (or app-equivalent) with session.
S1) Prefer **self-service path** (works without pre-enabled admin 2FA):
   a. Register a FRESH user with unique email/password (timestamp suffix); login; actor_set_token.
   b. Enable 2FA for THAT user: POST setup with Authorization + body password (or setupToken if required).
      Many apps return 401 on setup without `password` field or with wrong session — fix and retry.
   c. Capture secret / totpSecret / otpauth from setup or status response.
   d. If another principal's secret is exposed via IDOR: book exposure (chain_stop=S1) AND still do (a)(b).
S2) Generate TOTP in sandbox shell (stdlib snippet in vulns/totp-2fa.md).
S3) Complete verify then prove authenticated session (whoami / protected route).
   ONLY S3: ready_to_book high "2FA bypass". Half-step: exposure title + notes chain_stop=S1|S2.

If setup 401 checklist: new register → login → setup WITH password JSON → try setupToken → different Content-Type.
Do NOT conclude "2FA non-functional" until self-user enable path is attempted.
Always leave notes containing chain_stop=S0|S1|S2|S3.
"""

_RESET_CHAIN_FOCUS = """
IDENTITY CHAIN — password reset ATO (catalog password-reset-ato). Goal: S3.

S0) Map forgot/reset/security-question endpoints.
S1) Oracle or leaked answer material (only from live evidence / prior SQLi you hold).
S2) Reset accepted for a victim or self-test account.
S3) Login with NEW password succeeds — only then book high ATO.
Half-steps: chain_stop=S1|S2 with honest lower-severity titles. Always note chain_stop=.
"""


async def _run_one_identity_pass(
    state: PenState,
    *,
    cat_id: str,
    reason: str,
    pass_i: int,
) -> int:
    paths = []
    for s in state.surfaces:
        pl = f"{s.path} {s.note}".lower()
        if any(
            x in pl
            for x in (
                "2fa",
                "totp",
                "reset",
                "forgot",
                "security",
                "login",
                "password",
                "whoami",
                "register",
                "users",
            )
        ):
            if s.path and s.path not in paths:
                paths.append(s.path)

    if cat_id == "totp-2fa":
        focus = _TOTP_CHAIN_FOCUS
        if pass_i > 0:
            prior = []
            for c in state.candidates[-8:]:
                t = (c.title or "").lower()
                if any(x in t for x in ("2fa", "totp", "secret", "otp", "mfa")):
                    prior.append(f"- {c.title}: {(c.proof_excerpt or '')[:160]}")
            focus += (
                "\nCONTINUE PASS (forced if prior half-step or budget without S3):\n"
                "Do NOT re-map only. Execute self-register → login → setup(with password) → "
                "TOTP shell → verify → whoami.\n"
                "If setup 401: new email, include password in setup body, re-login first.\n"
            )
            if prior:
                focus += "Prior identity candidates:\n" + "\n".join(prior[:5]) + "\n"
    else:
        focus = _RESET_CHAIN_FOCUS
        if pass_i > 0:
            focus += (
                "\nCONTINUE PASS: complete reset+login (S3). Do not re-enumerate only.\n"
            )

    pkg = {
        "worker_id": f"identity_chain/pass{pass_i}/pentest-auth-session",
        "skill_id": "pentest-auth-session",
        "focus": focus + f"\nCatalog id=`{cat_id}` reason={reason}.",
        "paths": paths[:12],
        "score": 100.0,
        "catalog_force": [cat_id],
    }
    jar = CookieJar(state.cookies, actor_cookies=state.actor_cookies)
    # run_worker_package uses identity_chain in worker_id for budget
    res = await run_worker_package(state, pkg, jar)
    state.cookies = jar.snapshot()
    state.actor_cookies = jar.snapshot_actors()
    from node5.stages import _merge_payload

    n = 0
    if res.payload:
        n = _merge_payload(
            state, "class_probe", res.payload, res.raw, worker_id=pkg["worker_id"]
        )
    elif res.raw:
        state.note(f"identity_chain: unstructured raw_chars={len(res.raw)}")
        state.note(f"identity_chain:raw {res.raw[:800]}")
    state.note(
        f"identity_chain: pass={pass_i} tools={res.tool_calls} new_cands={n} catalog={cat_id}"
    )
    annotate_identity_half_step(state, cat_id, pass_i, res.tool_calls)
    state.feedback_log(
        "identity_chain",
        "class_probe",
        True,
        f"pass={pass_i} tools={res.tool_calls} new_cands={n} id={cat_id}",
    )
    return res.tool_calls


async def run_identity_chain_if_needed(state: PenState) -> int:
    """Serial specialist after class_probe — up to 2 passes (initial + S1/S2 continue)."""
    run, cat_id, reason = identity_chain_should_run(state)
    if not run:
        state.note(f"identity_chain: skip ({reason})")
        return 0

    total = 0
    state.note(f"identity_chain: begin catalog={cat_id} reason={reason}")
    state.feedback_log(
        "identity_chain", "class_probe", True, f"start id={cat_id} reason={reason}"
    )

    pass0_tools = 0
    for pass_i in range(2):
        if pass_i == 0:
            pass0_tools = await _run_one_identity_pass(
                state, cat_id=cat_id, reason=reason, pass_i=0
            )
            total += pass0_tools
            state._identity_chain_passes = 1  # type: ignore[attr-defined]
            state._identity_chain_pass0_tools = pass0_tools  # type: ignore[attr-defined]
        else:
            if not identity_chain_needs_continue(
                state, cat_id, pass0_tools=pass0_tools
            ):
                state.note(
                    "identity_chain: no continue (S3 done or no half-step/force)"
                )
                break
            why = "half_step"
            if not _identity_half_step(_identity_blob(state), cat_id):
                why = f"force_tools>={pass0_tools}"
            state.note(f"identity_chain: continue pass for {cat_id} ({why})")
            total += await _run_one_identity_pass(
                state, cat_id=cat_id, reason=f"continue_{why}", pass_i=1
            )
            state._identity_chain_passes = 2  # type: ignore[attr-defined]

    state.note(f"identity_chain: finished catalog={cat_id} total_tools={total}")
    return total
