"""Finding/candidate identity — path-normalized dedupe to stop multi-stage double-book.

Identity key = (path_norm, vuln_class). Same module re-reported from surface /
class_probe / component upgrades the existing candidate instead of appending.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlparse, unquote

from node5.state import Candidate

# Ordered: longer/more specific keys first for matching
_CLASS_HINTS: list[tuple[str, tuple[str, ...]]] = [
    ("sqli_blind", ("sqli_blind", "blind sql", "boolean-based", "blind injection")),
    ("sqli", ("sqli", "sql injection", "union select", "sql syntax", "sqlite_error")),
    ("xss_s", ("xss_s", "stored xss", "stored cross-site", "guestbook")),
    ("xss_r", ("xss_r", "reflected xss", "reflected cross-site")),
    ("xss_d", ("xss_d", "dom xss", "dom-based")),
    ("xss", ("xss", "cross-site scripting")),
    ("exec", ("command injection", "/exec", "cmdi", "rce via command")),
    ("upload", ("file upload", "/upload", "unrestricted upload", "webshell")),
    ("fi", ("file inclusion", "/fi", "lfi", "rfi", "local file inclusion")),
    ("csrf", ("csrf", "cross-site request forgery")),
    ("ssrf", ("ssrf", "server-side request")),
    ("ssti", ("ssti", "template injection")),
    (
        "authz",
        (
            "idor",
            "authz",
            "access control",
            "broken access",
            "bola",
            "bfla",
            "mass assignment",
            "privilege escalat",
            "unauthorized product",
            "unauthenticated put",
            "unauthenticated post",
        ),
    ),
    (
        "jwt",
        ("jwt", "alg:none", "alg none", "algorithm confusion", "none algorithm", "forged token"),
    ),
    ("config", ("config", "credential", "password exposure", "backup", "application-configuration")),
    ("dirlist", ("directory listing", "index of", "exposed /ftp", "ftp/ directory")),
    ("info", ("excessive data", "information disclosure", "error disclosure", "solve status")),
]


def normalize_path(location: str, target: str = "") -> str:
    """Normalize location to a stable path identity (no query, no host noise)."""
    loc = (location or "").strip()
    if not loc:
        return ""
    # Drop parenthetical notes: ".../sqli/ (GET parameter id)" including unclosed
    loc = re.sub(r"\s*\([^)]*\)\s*$", "", loc).strip()
    loc = re.sub(r"\s*\(.*$", "", loc).strip()
    # Model sometimes stores "GET /path?x=1" or "curl ... http://host/path"
    loc = re.sub(r"^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+", "", loc, flags=re.I).strip()
    m = re.search(r"https?://[^\s'\"]+", loc)
    if m:
        loc = m.group(0)
    elif re.search(r"/vulnerabilities/|/config/|/hackable/|/phpinfo", loc):
        # Keep from first path-looking slash
        idx = loc.find("/")
        if idx >= 0:
            loc = loc[idx:]
    # If full URL, take path
    if "://" in loc or loc.startswith("//"):
        try:
            p = urlparse(loc if "://" in loc else "http:" + loc)
            path = p.path or "/"
        except Exception:
            path = loc
    else:
        # Relative path or path with query
        path = loc.split("?", 1)[0].split("#", 1)[0]
        if not path.startswith("/"):
            # Sometimes "vulnerabilities/sqli/" without leading slash
            if path.startswith("vulnerabilities") or path.startswith("config") or path.startswith("hackable"):
                path = "/" + path
            else:
                # Try as URL path fragment after target
                path = "/" + path.lstrip("./")
    path = unquote(path)
    # Strip junk after path if model appended notes without parens
    path = path.split()[0] if path.split() else path
    # Never treat HTTP verbs as paths
    if path.lower() in {"/get", "/post", "/put", "/delete", "/head", "/options", "/patch"}:
        path = "/"
    # Collapse // and trailing slash (keep root as /)
    path = re.sub(r"/+", "/", path)
    if len(path) > 1:
        path = path.rstrip("/")
    return path.lower()


def infer_vuln_class(title: str = "", location: str = "", note: str = "") -> str:
    blob = f"{title} {location} {note}".lower()
    path = normalize_path(location)
    # Path-first for DVWA-style modules
    for klass, _ in _CLASS_HINTS:
        if klass in path.replace("-", "_") or f"/{klass}" in path or path.endswith(klass):
            # map path tokens
            if "sqli_blind" in path:
                return "sqli_blind"
            if path.endswith("/sqli") or "/sqli/" in path + "/":
                return "sqli"
            if "xss_s" in path:
                return "xss_s"
            if "xss_r" in path:
                return "xss_r"
            if "xss_d" in path:
                return "xss_d"
            if "/exec" in path:
                return "exec"
            if "/upload" in path:
                return "upload"
            if "/fi" in path or path.endswith("/fi"):
                return "fi"
            if "/csrf" in path:
                return "csrf"
    for klass, hints in _CLASS_HINTS:
        if any(h in blob for h in hints):
            return klass
    # Fallback: last two path segments
    parts = [p for p in path.split("/") if p]
    if parts:
        return "path:" + "/".join(parts[-2:])
    return "unknown"


def identity_key(
    *,
    title: str = "",
    location: str = "",
    target: str = "",
    vuln_class: str | None = None,
) -> tuple[str, str]:
    # Multi-location titles: use first path only
    loc0 = (location or "").split(",")[0].strip()
    path = normalize_path(loc0, target)
    klass = vuln_class or infer_vuln_class(title, loc0)
    return (path, klass)


def coarse_resource_path(path: str) -> str:
    """Collapse /api/users/12 and /api/products/{id} to stable resource roots."""
    path = (path or "/").lower().strip() or "/"
    parts = [p for p in path.split("/") if p]
    if not parts:
        return "/"
    while parts:
        last = parts[-1]
        if last.isdigit() or last in ("{id}", "id", "*") or re.match(
            r"^[0-9a-f]{8}-[0-9a-f-]{4,}$", last
        ):
            parts.pop()
            continue
        # percent-encoded null-byte variants still under parent
        if "%00" in last or "%2500" in last:
            parts.pop()
            continue
        break
    return "/" + "/".join(parts[:3]) if parts else "/"


def report_merge_key(
    *,
    title: str = "",
    location: str = "",
    target: str = "",
) -> tuple[str, str]:
    """Coarser identity for final book: same class + resource root → one finding.

    Keeps distinct classes (sqli vs mass_assignment vs jwt) but merges
    repeated BOLA/excessive-data narratives on the same API resource family.
    """
    loc0 = (location or "").split(",")[0].strip()
    path = normalize_path(loc0, target)
    coarse = coarse_resource_path(path)
    title_l = (title or "").lower()
    proof_blob = title_l  # title-driven class for report merge
    klass = infer_vuln_class(title, loc0)

    if "mass assignment" in title_l or (
        "privilege escalat" in title_l and "register" in title_l
    ):
        return (coarse, "mass_assignment")
    if any(x in title_l for x in ("jwt", "alg:none", "alg none", "algorithm confusion", "none algorithm")):
        return ("*", "jwt")
    if "sql injection" in title_l or klass.startswith("sqli"):
        return (coarse, "sqli")
    if any(x in title_l for x in ("null-byte", "path traversal", "extension bypass")):
        return (coarse_resource_path(path.split("%")[0] if "%" in path else path) or coarse, "path_traversal")
    if any(x in title_l for x in ("directory listing", "ftp/", "exposed /ftp")) or klass == "dirlist":
        return (coarse if coarse != "/" else "/ftp", "dirlist")
    # Product write before generic IDOR (titles often say "IDOR" + PUT product)
    if any(
        x in title_l
        for x in (
            "price",
            "product tamper",
            "product modif",
            "unauthenticated product",
            "product manipulation",
            "product modification",
        )
    ) or ("put" in title_l and "product" in title_l):
        return (coarse if "product" in coarse else "/api/products", "unauth_write_product")
    if any(
        x in title_l
        for x in (
            "idor",
            "bola",
            "bfla",
            "excessive data",
            "data exposure",
            "data leak",
            "cross-user",
            "horizontal",
            "broken access",
            "unauthenticated access",
            "without auth",
            "no auth",
            "pii",
            "user database",
        )
    ) or klass == "authz":
        # Coalesce unauth list APIs on same resource family (users/basket/order)
        fam = coarse
        if any(x in coarse for x in ("/user", "/api/user")):
            fam = "/api/users"
        elif "basket" in coarse:
            fam = "/api/basket"
        elif "order" in coarse:
            fam = "/api/orders"
        return (fam, "authz_bola")
    if klass == "info" or "disclosure" in title_l or "leak" in title_l:
        # config/hash disclosures stay path-scoped but coarse
        if "password" in title_l or "hash" in title_l:
            return (coarse, "secret_disclosure")
        if "config" in title_l or klass == "config":
            return (coarse, "config_disclosure")
        return (coarse, "info_disclosure")
    if klass == "jwt":
        return ("*", "jwt")
    return (coarse, klass or "unknown")


def merge_report_candidates(
    candidates: list[Candidate],
    *,
    target: str = "",
) -> tuple[list[Candidate], int]:
    """Collapse candidates for booking: strongest proof per report_merge_key."""
    best: dict[tuple[str, str], Candidate] = {}
    for c in candidates:
        key = report_merge_key(title=c.title, location=c.location, target=target)
        if key not in best:
            best[key] = c
        else:
            best[key] = merge_candidate(best[key], c)
    winners = list(best.values())
    suppressed = max(0, len(candidates) - len(winners))
    return winners, suppressed


def proof_strength(c: Candidate | dict[str, Any]) -> int:
    """Higher = better evidence for keep-on-merge."""
    if isinstance(c, dict):
        proof = str(c.get("proof_excerpt") or c.get("proof") or "")
        ready = bool(c.get("ready_to_book"))
        has_bar = all(
            str(c.get(k) or "").strip()
            for k in ("causality", "reproducibility", "impact", "proof_excerpt")
        )
        stage = str(c.get("stage") or "")
    else:
        proof = c.proof_excerpt or ""
        ready = c.ready_to_book
        has_bar = bool(c.causality and c.reproducibility and c.impact and c.proof_excerpt)
        stage = c.stage or ""
    p = proof.lower()
    score = len(proof)
    for m, w in (
        ("uid=33", 80),
        ("uid=", 40),
        ("user id exists", 50),
        ("user id is missing", 50),
        ("error in your sql", 50),
        ("union select", 40),
        ("app@localhost", 40),
        ("surname: dvwa", 40),
        ("<script>alert", 40),
        ("password changed", 40),
        ("root:x:0:0", 50),
        ("db_password", 40),
        ("succesfully uploaded", 40),
        ("successfully uploaded", 40),
        ("shell_exec", 30),
        ("http ", 10),
        ("get ", 5),
        ("post ", 5),
    ):
        if m in p:
            score += w
    # Penalize archaeology / theory
    for m, w in (
        ("ids log", -60),
        ("phpids", -40),
        ("source code", -20),
        ("0-length", -40),
        ("possible", -15),
        ("appear to", -15),
        ("without sanitization", -10),
    ):
        if m in p:
            score += w
    if has_bar:
        score += 25
    if ready:
        score += 10
    # Prefer findings with delivery metadata (P0.3)
    if isinstance(c, dict):
        if str(c.get("precondition") or "").strip():
            score += 15
        if str(c.get("affected_resource") or "").strip():
            score += 5
    else:
        if (c.precondition or "").strip():
            score += 15
        if (c.affected_resource or "").strip():
            score += 5
    # Prefer deeper stages when proofs comparable
    stage_bonus = {
        "component": 15,
        "class_probe": 10,
        "prior_reverify": 5,
        "authz_logic": 5,
        "surface": 0,
    }
    score += stage_bonus.get(stage, 0)
    return score


def merge_candidate(existing: Candidate, incoming: Candidate) -> Candidate:
    """Keep stronger proof fields; prefer non-empty bars; track latest stage."""
    if proof_strength(incoming) >= proof_strength(existing):
        base = incoming.model_copy()
        # Preserve first-seen stage in note via worker_id trail if useful
        if existing.stage and existing.stage != incoming.stage:
            # keep stronger content but remember prior stage lightly
            if not base.worker_id and existing.worker_id:
                base.worker_id = existing.worker_id
        # If incoming missing bar fields, fill from existing
        if not base.causality and existing.causality:
            base.causality = existing.causality
        if not base.reproducibility and existing.reproducibility:
            base.reproducibility = existing.reproducibility
        if not base.impact and existing.impact:
            base.impact = existing.impact
        if not base.precondition and existing.precondition:
            base.precondition = existing.precondition
        if not base.affected_actor and existing.affected_actor:
            base.affected_actor = existing.affected_actor
        if not base.affected_resource and existing.affected_resource:
            base.affected_resource = existing.affected_resource
        return base
    # Keep existing; optionally upgrade empty fields from incoming
    base = existing.model_copy()
    if not base.proof_excerpt and incoming.proof_excerpt:
        base.proof_excerpt = incoming.proof_excerpt
    if not base.precondition and incoming.precondition:
        base.precondition = incoming.precondition
    if not base.affected_actor and incoming.affected_actor:
        base.affected_actor = incoming.affected_actor
    if not base.affected_resource and incoming.affected_resource:
        base.affected_resource = incoming.affected_resource
    if proof_strength(incoming) > proof_strength(existing) - 30:
        # near-tie: prefer longer proof
        if len(incoming.proof_excerpt or "") > len(existing.proof_excerpt or ""):
            base.proof_excerpt = incoming.proof_excerpt
            base.causality = incoming.causality or base.causality
            base.reproducibility = incoming.reproducibility or base.reproducibility
            base.impact = incoming.impact or base.impact
            base.ready_to_book = incoming.ready_to_book or base.ready_to_book
            base.stage = incoming.stage or base.stage
            base.precondition = incoming.precondition or base.precondition
            base.affected_actor = incoming.affected_actor or base.affected_actor
            base.affected_resource = incoming.affected_resource or base.affected_resource
    return base


def upsert_candidate(
    candidates: list[Candidate],
    incoming: Candidate,
    *,
    target: str = "",
    allow_surface_book: bool = False,
) -> tuple[list[Candidate], str]:
    """Insert or merge by identity. Returns (list, action: inserted|merged|skipped)."""
    # Surface stage: do not mark ready_to_book unless explicitly allowed
    if incoming.stage == "surface" and not allow_surface_book:
        incoming = incoming.model_copy(update={"ready_to_book": False})

    key = identity_key(
        title=incoming.title,
        location=incoming.location,
        target=target,
    )
    for i, existing in enumerate(candidates):
        ek = identity_key(
            title=existing.title,
            location=existing.location,
            target=target,
        )
        if ek == key:
            candidates[i] = merge_candidate(existing, incoming)
            return candidates, "merged"
    candidates.append(incoming)
    return candidates, "inserted"


def dedupe_bookable(
    candidates: list[Candidate],
    *,
    target: str = "",
) -> tuple[list[Candidate], int]:
    """Collapse bookable candidates to one per report identity (strongest wins).

    Uses coarse path + vuln family so multi-stage BOLA/JWT repeats collapse.
    Returns (winners, suppressed_count).
    """
    return merge_report_candidates(candidates, target=target)
