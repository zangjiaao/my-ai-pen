"""Path → skill package selection for Agent Graph (generic, not target-specific).

Scores observed surfaces against skill packages (multi-skill per path).
Prefer path mass over default skill lottery (which previously over-picked ssrf/ssti/xxe).
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from node5.identity import normalize_path
from node5.pack_loader import load_graph, stage_skills
from node5.state import PenState

# (path/note regex, skill_id, weight, focus). Multiple rules may hit the same surface.
_SCORE_RULES: list[tuple[re.Pattern[str], str, float, str]] = [
    (
        re.compile(r"sqli_blind|sql.?blind|blind.?sql", re.I),
        "pentest-sql-injection",
        3.0,
        "Boolean/time-based blind SQL injection on this module path",
    ),
    (
        re.compile(r"sqli|/sql(?:injection)?(?:/|$)|union.?select", re.I),
        "pentest-sql-injection",
        3.0,
        "SQL ladder: error → boolean/time → data or auth effect (not error-only)",
    ),
    (
        re.compile(r"/search|products/search|[?&]q=|query=|filter=", re.I),
        "pentest-sql-injection",
        2.8,
        "Search/query injection ladder to data dump or auth effect — error fingerprint alone fails book",
    ),
    (
        re.compile(r"xss", re.I),
        "pentest-xss",
        3.0,
        "Reflected/stored/DOM XSS with live self-injected payload proof",
    ),
    (
        re.compile(r"review|comment|feedback|message|guestbook", re.I),
        "pentest-xss",
        1.5,
        "Stored/reflected XSS on user-generated content fields — inject your own payload",
    ),
    (
        re.compile(
            r"upload|file.?upload|multipart|profile/image/file|/image/file",
            re.I,
        ),
        "pentest-file-upload",
        2.8,
        "File upload type/path impact within RoE — prove stored path or processing difference",
    ),
    (
        re.compile(r"/fi(?:/|$)|file.?incl|lfi|rfi|path.?trav", re.I),
        "pentest-file-upload",
        2.5,
        "Local/remote file inclusion or path traversal on include/page params",
    ),
    (
        re.compile(r"exec|cmdi|command.?inj|/ping|shell.?cmd", re.I),
        "pentest-service-exposure",
        2.5,
        "OS command injection on user-controlled parameters (e.g. ip/host)",
    ),
    (
        re.compile(r"csrf", re.I),
        "pentest-authz-logic",
        2.0,
        "CSRF / state-changing request without anti-CSRF token",
    ),
    (
        re.compile(
            r"ssrf|open.?redirect|url.?fetch|webhook|callback|image/url|profile/image|"
            r"import.?url|fetch.?url|avatar.?url|photo.?url",
            re.I,
        ),
        "pentest-ssrf",
        2.8,
        "SSRF/URL-fetch: prove server-side request (in-scope) — param-exists is not a finding",
    ),
    (
        re.compile(
            r"ssti|template.?inj|pug|handlebars|jinja|twig|freemarker|#\{|\$\{",
            re.I,
        ),
        "pentest-ssti",
        2.5,
        "SSTI: self-inject template expression and prove server evaluation",
    ),
    (
        re.compile(
            r"nosql|mongo|\$ne|\$gt|\$where|mongodb",
            re.I,
        ),
        "pentest-api",
        2.2,
        "NoSQL operator injection on JSON APIs — prove auth bypass or data effect",
    ),
    (
        re.compile(r"graphql|graphiql|gql", re.I),
        "pentest-api",
        2.4,
        "GraphQL introspection/authz/batch — prove unauthorized data or mutations",
    ),
    (
        re.compile(
            r"encryptionkeys|encryption-keys|jwt\.pub|\.pem|support/logs|/logs/",
            re.I,
        ),
        "pentest-component-rce",
        2.6,
        "Key/log exposure + JWT key material — prove file read or forged signed token accept",
    ),
    # XXE: require real XML processing signals — NOT bare sitemap.xml
    (
        re.compile(
            r"xxe|soap|application/xml|text/xml|xml.?upload|DOCTYPE|external.?entit",
            re.I,
        ),
        "pentest-xxe",
        2.5,
        "XML external entity injection on XML-accepting endpoints",
    ),
    (
        re.compile(r"/api|/rest|/graphql|swagger|openapi|/v1/|/v2/", re.I),
        "pentest-api",
        2.0,
        "API authz / mass assignment / BOLA / verb tampering on API surfaces",
    ),
    (
        re.compile(
            r"basket|cart|order|address|payment|complaint|quantity|delivery|card",
            re.I,
        ),
        "pentest-api",
        1.5,
        "Object/resource APIs — IDOR and mass assignment on observed objects",
    ),
    (
        re.compile(
            r"basket|cart|order|address|payment|complaint|/user|/users|account|register",
            re.I,
        ),
        "pentest-authz-logic",
        2.0,
        "Horizontal/vertical authz and object IDOR with dual actors when possible",
    ),
    (
        re.compile(r"login|auth|jwt|oauth|session|password|token|register|whoami", re.I),
        "pentest-auth-session",
        2.0,
        "Auth/session/JWT weakness — prove server accepts the bypass",
    ),
    (
        re.compile(r"/ftp|/backup|\.bak|directory.?list", re.I),
        "pentest-file-upload",
        1.0,
        "Sensitive file exposure / path abuse on exposed file trees",
    ),
    # Component / framework signals in path or notes (generic fingerprints, not target keys)
    (
        re.compile(
            r"fastjson|log4j|shiro|struts|actuator|jackson|xstream|weblogic|"
            r"thinkphp|laravel|rails|express|spring|solr|elasticsearch",
            re.I,
        ),
        "pentest-component-rce",
        2.5,
        "Named product/framework fingerprint → ref_query components → narrow verify",
    ),
]

_WORKER_FOCUS_FALLBACK: dict[str, str] = {
    "pentest-sql-injection": (
        "SQL ladder error→boolean/time→data/auth effect; search dumps need rows/emails not SQLITE_ERROR alone"
    ),
    "pentest-xss": "XSS with self-injected live payload proof",
    "pentest-ssrf": "SSRF: server-side fetch proof in-scope only",
    "pentest-ssti": "Template injection",
    "pentest-xxe": "XXE on XML-processing endpoints only",
    "pentest-api": "API authz / IDOR / mass assignment",
    "pentest-file-upload": "File upload path/type impact within RoE",
    "pentest-authz-logic": "Authz / CSRF / dual-actor IDOR",
    "pentest-service-exposure": "Service exposure / command injection class issues",
    "pentest-auth-session": (
        "Auth flows: login→register→reset/otp if present→JWT accept proof→session"
    ),
    "pentest-component-rce": "Component/framework: fingerprint → ref_query → prove impact",
}

# Fallback order when no path scores (prefer realistic web/API classes)
_FALLBACK_ORDER = [
    "pentest-api",
    "pentest-auth-session",
    "pentest-sql-injection",
    "pentest-xss",
    "pentest-authz-logic",
    "pentest-file-upload",
]

# When partitioning paths across workers: lower index wins the path claim
_PATH_CLAIM_PRIORITY: list[str] = [
    "pentest-sql-injection",
    "pentest-ssrf",
    "pentest-ssti",
    "pentest-xss",
    "pentest-file-upload",
    "pentest-auth-session",  # login/register/jwt exclusive
    "pentest-authz-logic",  # object IDOR exclusive
    "pentest-component-rce",
    "pentest-api",  # residual API after specialists claim
    "pentest-xxe",
    "pentest-service-exposure",
]

# Preferred path patterns per skill (used to filter after multi-score)
_SKILL_PATH_HINTS: dict[str, re.Pattern[str]] = {
    "pentest-auth-session": re.compile(
        r"login|register|whoami|password|jwt|token|session|oauth|auth|captcha|"
        r"reset|forgot|otp|2fa|totp|logout|change-password|security-question|"
        r"encryptionkeys|jwt\.pub",
        re.I,
    ),
    "pentest-authz-logic": re.compile(
        r"basket|cart|order|user|users|address|complaint|card|payment|privacy|whoami",
        re.I,
    ),
    "pentest-sql-injection": re.compile(r"search|sqli|sql|query|\bq=|filter", re.I),
    "pentest-xss": re.compile(r"xss|review|comment|feedback|message|guestbook", re.I),
    "pentest-file-upload": re.compile(
        r"upload|ftp|file|\.bak|quarantine|multipart|image/file", re.I
    ),
    "pentest-ssrf": re.compile(
        r"ssrf|webhook|callback|image/url|profile/image|fetch|import|avatar|photo",
        re.I,
    ),
    "pentest-ssti": re.compile(r"ssti|template|profile|username|pug|jinja", re.I),
    "pentest-api": re.compile(
        r"/api|/rest|graphql|swagger|product|quantity|mongo|\$ne", re.I
    ),
    "pentest-component-rce": re.compile(
        r"actuator|fastjson|log4j|shiro|struts|admin|version|encryptionkey|jwt\.pub|\.pem|/logs",
        re.I,
    ),
}


def _surface_blob(state: PenState) -> str:
    parts = [f"{s.path} {s.note}" for s in state.surfaces]
    parts += [f"{r.name} {' '.join(r.paths)} {r.notes}" for r in state.resources]
    return " ".join(parts).lower()


def needed_high_value_skills(state: PenState) -> list[str]:
    """HV skill ids that surface signals require (discovery P2 schedule)."""
    blob = _surface_blob(state)
    needed: list[str] = []
    if any(x in blob for x in ("image/url", "profile/image", "webhook", "callback", "[egress]")):
        needed.append("pentest-ssrf")
    if any(x in blob for x in ("search", "query", "?q=")):
        needed.append("pentest-sql-injection")
    if any(
        x in blob for x in ("review", "comment", "guestbook", "xss", "feedback")
    ):
        needed.append("pentest-xss")
    if any(x in blob for x in ("encryptionkey", "jwt.pub", ".pem", "support/logs", "/logs")):
        needed.append("pentest-component-rce")
    return needed


def effective_worker_budget(state: PenState, *, base_max: int | None = None) -> int:
    """Dynamic max_workers so forced HV skills are not dropped by top-K (P2)."""
    base = base_max if base_max is not None else state.max_workers
    needed = needed_high_value_skills(state)
    # keep room for api/authz plus HV forces
    return min(8, max(1, base, 3 + len(needed)))


def _paths_matching_rx(state: PenState, rx: re.Pattern[str]) -> list[str]:
    out = []
    for s in state.surfaces:
        p = normalize_path(s.path, state.target) or s.path
        if rx.search(f"{p} {s.note or ''}"):
            out.append(p)
    return out[:12]


def _ensure_high_value_packages(
    packages: list[dict[str, Any]],
    state: PenState,
    *,
    max_workers: int,
    scores: dict[str, float],
    paths_for: dict[str, list[str]],
    focus_for: dict[str, str],
) -> list[dict[str, Any]]:
    """Force-include high-value skill packages when signals exist but lost the top-K race.

    Always expands worker budget to fit forced skills (discovery P2).
    Records forced skill ids on state.forced_packages / effective_max_workers.
    """
    blob = _surface_blob(state)
    present = {p["skill_id"] for p in packages}
    forced: list[tuple[str, float]] = []

    # Scores must beat multi-path api/authz mass (often 20–50+) so forced skills stay in top-K
    if any(x in blob for x in ("image/url", "profile/image", "webhook", "callback", "[egress]")):
        if "pentest-ssrf" not in present:
            forced.append(("pentest-ssrf", 100.0))
            paths_for.setdefault(
                "pentest-ssrf",
                _paths_matching_rx(
                    state,
                    re.compile(r"image/url|profile/image|webhook|callback|fetch|avatar", re.I),
                ),
            )
            focus_for.setdefault("pentest-ssrf", _WORKER_FOCUS_FALLBACK["pentest-ssrf"])
    if any(x in blob for x in ("search", "query", "?q=")):
        if "pentest-sql-injection" not in present:
            forced.append(("pentest-sql-injection", 95.0))
            paths_for.setdefault(
                "pentest-sql-injection",
                _paths_matching_rx(state, re.compile(r"search|query|\bq=", re.I)),
            )
            focus_for.setdefault(
                "pentest-sql-injection",
                _WORKER_FOCUS_FALLBACK["pentest-sql-injection"],
            )
    if "pentest-xss" not in present and any(
        x in blob for x in ("review", "comment", "guestbook", "xss", "feedback")
    ):
        forced.append(("pentest-xss", 90.0))
        paths_for.setdefault(
            "pentest-xss",
            _paths_matching_rx(
                state, re.compile(r"review|comment|feedback|guestbook|search", re.I)
            ),
        )
        focus_for.setdefault("pentest-xss", _WORKER_FOCUS_FALLBACK["pentest-xss"])
    if any(x in blob for x in ("encryptionkey", "jwt.pub", ".pem", "support/logs", "/logs")):
        if "pentest-component-rce" not in present:
            forced.append(("pentest-component-rce", 92.0))
            paths_for.setdefault(
                "pentest-component-rce",
                _paths_matching_rx(
                    state,
                    re.compile(r"encryptionkey|jwt\.pub|\.pem|/logs|actuator", re.I),
                ),
            )
            focus_for.setdefault(
                "pentest-component-rce",
                _WORKER_FOCUS_FALLBACK["pentest-component-rce"],
            )
    if any(x in blob for x in ("graphql", "graphiql")):
        gpaths = _paths_matching_rx(state, re.compile(r"graphql|graphiql", re.I))
        if gpaths and "pentest-api" in paths_for:
            for gp in gpaths:
                if gp not in paths_for["pentest-api"]:
                    paths_for["pentest-api"].insert(0, gp)

    by_id = {p["skill_id"]: p for p in packages}
    forced_ids: list[str] = []
    for sid, sc in forced:
        forced_ids.append(sid)
        if sid in by_id:
            # boost existing score so it survives re-rank
            by_id[sid]["score"] = max(float(by_id[sid].get("score") or 0), sc)
            scores[sid] = max(scores.get(sid, 0.0), sc)
            continue
        paths = paths_for.get(sid, [])
        focus = focus_for.get(sid, _WORKER_FOCUS_FALLBACK.get(sid, sid))
        if paths:
            focus = f"{focus} | exclusive paths: {', '.join(paths[:8])}"
        by_id[sid] = {
            "worker_id": f"class_probe/{sid}",
            "skill_id": sid,
            "focus": focus,
            "paths": paths,
            "score": sc,
        }
        scores[sid] = sc

    # Also assert needed skills already present still count as schedule-ok
    needed = needed_high_value_skills(state)
    for sid in needed:
        if sid in by_id and sid not in forced_ids:
            # already scheduled without force
            pass

    # Expand worker budget so forced packages are not truncated (P2)
    eff = max(max_workers, len(by_id), 3 + len(needed))
    eff = min(8, max(1, eff))
    state.effective_max_workers = eff
    state.forced_packages = list(dict.fromkeys(forced_ids + [
        s for s in needed if s in by_id
    ]))

    ranked = sorted(
        by_id.values(), key=lambda p: (-float(p.get("score") or 0), p["skill_id"])
    )
    capped = ranked[:eff]
    # Final assert: every needed skill must remain if it was in by_id
    have = {p["skill_id"] for p in capped}
    for sid in needed:
        if sid in by_id and sid not in have:
            # replace lowest score package
            if capped:
                capped[-1] = by_id[sid]
            else:
                capped.append(by_id[sid])
            have.add(sid)
    return _partition_paths(capped)


def _partition_paths(
    packages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Assign each path to at most one worker (priority order) to cut overlap."""
    if len(packages) <= 1:
        return packages
    # path -> list of skill_ids that wanted it
    want: dict[str, list[str]] = {}
    for p in packages:
        sid = p["skill_id"]
        for path in p.get("paths") or []:
            want.setdefault(path, []).append(sid)

    prio = {s: i for i, s in enumerate(_PATH_CLAIM_PRIORITY)}

    def _best_owner(path: str, claimants: list[str]) -> str:
        # Prefer skill whose path-hint matches, then claim priority
        scored: list[tuple[int, int, str]] = []
        for sid in claimants:
            hint = _SKILL_PATH_HINTS.get(sid)
            match = 0 if (hint and hint.search(path)) else 1
            scored.append((match, prio.get(sid, 99), sid))
        scored.sort()
        return scored[0][2]

    owner: dict[str, str] = {}
    for path, claimants in want.items():
        owner[path] = _best_owner(path, claimants)

    out: list[dict[str, Any]] = []
    for p in packages:
        sid = p["skill_id"]
        claimed = [path for path in (p.get("paths") or []) if owner.get(path) == sid]
        # If emptied, keep 1-2 specialty-matching paths from original even if lost
        # only when no exclusive paths left (avoid totally blind workers)
        if not claimed:
            hint = _SKILL_PATH_HINTS.get(sid)
            for path in p.get("paths") or []:
                if hint and hint.search(path):
                    claimed.append(path)
                if len(claimed) >= 2:
                    break
        # Auth-session must not ship empty: claim login/register/2fa from package paths list
        if sid == "pentest-auth-session" and not claimed:
            hint = _SKILL_PATH_HINTS.get(sid)
            for path in p.get("paths") or []:
                if hint and hint.search(path):
                    claimed.append(path)
                if len(claimed) >= 4:
                    break
        focus = p.get("focus") or _WORKER_FOCUS_FALLBACK.get(sid, sid)
        # Strip old "prioritize paths" suffix then re-add
        focus = re.sub(r"\s*\|\s*prioritize paths:.*$", "", focus).strip()
        if claimed:
            focus = f"{focus} | exclusive paths: {', '.join(claimed[:8])}"
        else:
            focus = (
                f"{focus} | no exclusive paths — do NOT re-test login/register/JWT "
                "already covered by other workers; focus skill methodology on residual surfaces"
            )
        np = dict(p)
        np["paths"] = claimed
        np["focus"] = focus
        out.append(np)
    return out


def packages_from_surfaces(
    state: PenState,
    *,
    max_workers: int,
    pack_root: Path | None = None,
) -> list[dict[str, Any]]:
    """Build fan-out packages from surface path mass (multi-skill scoring)."""
    pack_root = pack_root or Path(state.pack_root)
    try:
        graph = load_graph(pack_root, state.graph_id)
    except FileNotFoundError:
        graph = {"nodes": {}}
    allowed = set(stage_skills(graph, "class_probe")) | set(_WORKER_FOCUS_FALLBACK.keys())

    # Expand budget early so top-K does not drop HV skills before force (P2)
    eff = effective_worker_budget(state, base_max=max_workers)
    state.effective_max_workers = eff

    # skill_id -> score, focus, paths
    scores: dict[str, float] = {}
    paths_for: dict[str, list[str]] = {}
    focus_for: dict[str, str] = {}

    def _allow(skill_id: str) -> bool:
        if skill_id in allowed:
            return True
        return (pack_root / "skills" / skill_id / "SKILL.md").is_file() or (
            pack_root / "skills" / skill_id
        ).exists()

    for surf in state.surfaces:
        path = normalize_path(surf.path, state.target) or (surf.path or "")
        blob = f"{path} {surf.note or ''}"
        # Skip pure static asset noise
        if re.search(r"\.(css|js|png|jpg|jpeg|gif|ico|woff2?|map)(\?|$)", path, re.I):
            if not re.search(r"upload", path, re.I):
                continue
        for rx, skill_id, weight, focus in _SCORE_RULES:
            if not rx.search(blob):
                continue
            if not _allow(skill_id):
                continue
            scores[skill_id] = scores.get(skill_id, 0.0) + weight
            focus_for.setdefault(skill_id, focus)
            if path and path not in paths_for.setdefault(skill_id, []):
                paths_for[skill_id].append(path)

    if scores:
        ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
        packages: list[dict[str, Any]] = []
        # Take more than base max_workers before force — ensure then re-caps
        take = max(eff, max_workers)
        for skill_id, sc in ranked[:take]:
            if sc < 1.0:
                continue
            paths = paths_for.get(skill_id, [])[:12]
            focus = focus_for.get(skill_id, _WORKER_FOCUS_FALLBACK.get(skill_id, skill_id))
            if paths:
                focus = f"{focus} | prioritize paths: {', '.join(paths[:8])}"
            packages.append(
                {
                    "worker_id": f"class_probe/{skill_id}",
                    "skill_id": skill_id,
                    "focus": focus,
                    "paths": paths,
                    "score": sc,
                }
            )
        if packages:
            packages = _partition_paths(packages)
            packages = _ensure_high_value_packages(
                packages,
                state,
                max_workers=eff,
                scores=scores,
                paths_for=paths_for,
                focus_for=focus_for,
            )
            return packages

    # Fallback: prefer realistic order, then graph skill list
    skills = [s for s in _FALLBACK_ORDER if _allow(s)]
    for s in stage_skills(graph, "class_probe") or list(_WORKER_FOCUS_FALLBACK.keys()):
        if s not in skills and _allow(s):
            skills.append(s)
    out = []
    for sid in skills[:eff]:
        out.append(
            {
                "worker_id": f"class_probe/{sid}",
                "skill_id": sid,
                "focus": _WORKER_FOCUS_FALLBACK.get(sid, sid),
                "paths": [],
                "score": 0.0,
            }
        )
    return out
