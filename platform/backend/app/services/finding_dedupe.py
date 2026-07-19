"""Vulnerability fingerprint + dedupe helpers (pure, unit-testable).

Agent rediscover of the same finding should update the existing row's
timeline / last-seen time instead of inserting a duplicate.

Identity (strongest → weakest):
  1. same CVE on same asset
  2. same asset + port + path-class intersection (aliases expanded; title may drift)
  3. same asset + port + title stem (level/technique stripped; light bilingual heads)
  4. same asset + port + exact normalized title
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse
from uuid import UUID


def normalize_finding_title(title: object) -> str:
    """Stable title key for dedupe (case/whitespace insensitive)."""
    text = str(title or "").strip().lower()
    if not text:
        return ""
    text = re.sub(r"\s+", " ", text)
    # Drop trailing punctuation noise agents sometimes append.
    text = text.rstrip(" .;:|-/")
    return text[:500]


# Closed bilingual / synonym heads → short stem tokens (match only, not storage).
# Order matters: more specific patterns first (blind SQLi before generic SQLi).
_STEM_HEAD_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    # More specific heads first (avoid "Brute Force SQL 注入" → sql_injection).
    (re.compile(r"brute\s*force|暴力破解|暴力\s*猜", re.I), "brute_force"),
    (re.compile(r"sql\s*injection\s*\(?\s*blind|blind\s*sql|sqli[_\s-]*blind|盲\s*注|sql\s*盲", re.I), "sql_injection_blind"),
    (re.compile(r"command\s*injection|命令注入|cmd\s*injection", re.I), "command_injection"),
    (re.compile(r"file\s*upload|文件上传|upload\s*bypass", re.I), "file_upload"),
    (re.compile(r"reflected\s*xss|反射\s*xss|xss_r\b", re.I), "xss_reflected"),
    (re.compile(r"stored\s*xss|存储\s*xss|xss_s\b", re.I), "xss_stored"),
    (re.compile(r"dom\s*(based\s*)?xss|xss_d\b", re.I), "xss_dom"),
    (re.compile(r"\bxss\b|跨站脚本", re.I), "xss"),
    (re.compile(r"\bcsrf\b|跨站请求伪造", re.I), "csrf"),
    (re.compile(r"local\s*file\s*inclusion|\blfi\b|本地文件包含", re.I), "lfi"),
    (re.compile(r"sql\s*injection|sql\s*注入|sqli\b", re.I), "sql_injection"),
    (re.compile(r"weak\s*session|session\s*id", re.I), "weak_session"),
    (re.compile(r"\bcsp\b|content.security.policy", re.I), "csp"),
)


def normalize_finding_title_stem(title: object) -> str:
    """
    Soft title identity: drop security-level labels and technique suffixes,
    then map known heads to bilingual stem tokens.
    """
    text = normalize_finding_title(title)
    if not text:
        return ""
    # (Low Security) / (Medium Security) / 低安全等级
    text = re.sub(
        r"\((?:low|medium|high|impossible)\s*security[^)]*\)",
        " ",
        text,
        flags=re.I,
    )
    text = re.sub(r"[（(][^）)]*安全[^）)]*[）)]", " ", text)
    # Trailing technique after dash (keep head only)
    text = re.sub(r"\s*[-–—·:：]\s+.+$", "", text)
    text = re.sub(r"\s+", " ", text).strip(" .;:|-/")
    for pat, token in _STEM_HEAD_PATTERNS:
        if pat.search(text):
            return token
    return text[:200]


# Evidence landing paths often differ from the vuln module page (same finding).
_PATH_ALIAS_GROUPS: tuple[frozenset[str], ...] = (
    frozenset({"/vulnerabilities/upload", "/hackable/uploads", "/uploads"}),
)


def canonical_path_aliases(path: object) -> set[str]:
    """Expand a path-class to its alias set (identity closed under known pairs)."""
    p = str(path or "").strip().lower().rstrip("/") or ""
    if not p:
        return set()
    # Normalize single-segment uploads evidence
    if p.endswith("/uploads") or p == "/uploads" or "/uploads/" in (p + "/"):
        # collapse /hackable/uploads/foo.php → /hackable/uploads
        parts = [x for x in p.split("/") if x]
        if "uploads" in parts:
            idx = parts.index("uploads")
            p = "/" + "/".join(parts[: idx + 1])
    out = {p}
    for group in _PATH_ALIAS_GROUPS:
        # Match if path equals a group member or is under /hackable/uploads
        if p in group or any(p == g or p.startswith(g + "/") for g in group):
            out |= set(group)
            # Prefer module page form in set
            out.add("/vulnerabilities/upload")
            out.add("/hackable/uploads")
    return out


def expand_path_classes(paths: set[str] | object) -> set[str]:
    """Union of alias expansions for every path class."""
    if not isinstance(paths, set):
        paths = set(paths or [])
    out: set[str] = set()
    for p in paths:
        out |= canonical_path_aliases(p)
    return out


def preferred_path_class(paths: set[str] | object) -> str:
    """Stable representative path for clustering (prefer /vulnerabilities/*)."""
    expanded = expand_path_classes(paths if isinstance(paths, set) else set(paths or []))
    if not expanded:
        return ""
    vulns = sorted(p for p in expanded if p.startswith("/vulnerabilities/"))
    if vulns:
        return vulns[0]
    return sorted(expanded)[0]


def ports_equal(a: object, b: object) -> bool:
    pa = str(a or "").strip()
    pb = str(b or "").strip()
    if not pa and not pb:
        return True
    return pa == pb


def location_path_class(location: object) -> str:
    """
    Stable path class for soft dedupe (host ignored — pair with asset_id).

    Examples:
      http://h:8080/vulnerabilities/sqli/?id=1  → /vulnerabilities/sqli
      /vulnerabilities/exec/                    → /vulnerabilities/exec
      /level1/index.php                         → /level1
      bare module name without path             → "" (fall back to title)
    """
    raw = str(location or "").strip()
    if not raw:
        return ""
    # Prefer first URL-looking token.
    m = re.search(r"https?://[^\s,;)\]}>'\"]+", raw, flags=re.IGNORECASE)
    if m:
        raw = m.group(0)
    path = ""
    if "://" in raw or raw.startswith("//"):
        try:
            path = urlparse(raw if "://" in raw else f"http:{raw}").path or ""
        except Exception:
            path = ""
    elif raw.startswith("/"):
        path = raw.split("?", 1)[0].split("#", 1)[0]
    else:
        # "… at /vulnerabilities/sqli/" or "GET /vulnerabilities/sqli/"
        pm = re.search(r"(/(?:vulnerabilities|vuln|level\d+)[^\s,;)\]}>'\"]*)", raw, flags=re.I)
        if pm:
            path = pm.group(1).split("?", 1)[0].split("#", 1)[0]
        else:
            # DVWA shorthand only in path-ish context — never bare "SQLi"/"File" prose.
            # e.g. "GET xss_r/?name=…", "/sqli/", "vulnerabilities/exec"
            mod = re.search(
                r"(?:/(?:vulnerabilities/)?|(?:^|[\s\"'(])(?:vulnerabilities/)|(?:GET|POST|PUT|PATCH|DELETE)\s+)((?:sqli_blind|sqli|xss_r|xss_s|xss_d|fi|exec|upload|csrf|brute|captcha|weak_id|javascript)\b(?:/[^\s,;)\]}>'\"]*)?)",
                raw,
                flags=re.I,
            )
            if mod:
                path = "/vulnerabilities/" + mod.group(1).split("?", 1)[0].split("#", 1)[0].lstrip("/")
            else:
                return ""

    path = path.strip().lower()
    if not path or path == "/":
        return ""
    # Collapse // and trailing slash
    while "//" in path:
        path = path.replace("//", "/")
    path = path.rstrip("/") or "/"
    parts = [p for p in path.split("/") if p]
    if not parts:
        return ""

    # DVWA-style modules: /vulnerabilities/<module> (module required — bare /vulnerabilities is too broad)
    if parts[0] in {"vulnerabilities", "vuln"}:
        if len(parts) >= 2:
            return f"/{parts[0]}/{parts[1]}"
        return ""
    # Upload evidence landing: /hackable/uploads/foo.php → /hackable/uploads
    if "uploads" in parts:
        idx = parts.index("uploads")
        return "/" + "/".join(parts[: idx + 1])
    # CTF-style: /levelN[/page]
    if re.fullmatch(r"level\d+", parts[0]):
        if len(parts) >= 2 and not parts[1].endswith((".php", ".html", ".jsp", ".asp")):
            return f"/{parts[0]}/{parts[1]}"
        return f"/{parts[0]}"
    # Generic: first two path segments (avoid merging entire site as "/")
    if len(parts) >= 2:
        return f"/{parts[0]}/{parts[1]}"
    # Single segment only if it looks module-like (not index.php alone)
    if "." in parts[0]:
        return ""
    return f"/{parts[0]}"


def path_classes_match(a: object, b: object) -> bool:
    ka, kb = location_path_class(a), location_path_class(b)
    return bool(ka) and ka == kb


def finding_fingerprint(
    *,
    title: object,
    asset_id: object = None,
    port: object = None,
    cve_id: object = None,
    location: object = None,
) -> str:
    """
    Composite key for one logical finding under a user ledger.

    Prefers path class when available so title drift does not fork rows.
    """
    title_key = normalize_finding_title_stem(title) or normalize_finding_title(title)
    asset_key = str(asset_id or "").strip().lower()
    port_key = str(port or "").strip()
    cve_key = str(cve_id or "").strip().upper()
    paths = expand_path_classes(finding_path_classes(title, location))
    path_key = preferred_path_class(paths)
    if path_key:
        return f"{asset_key}|{port_key}|path:{path_key}|{cve_key}"
    return f"{asset_key}|{port_key}|stem:{title_key}|{cve_key}"


def titles_match(a: object, b: object) -> bool:
    ka, kb = normalize_finding_title(a), normalize_finding_title(b)
    return bool(ka) and ka == kb


def title_stems_match(a: object, b: object) -> bool:
    ka, kb = normalize_finding_title_stem(a), normalize_finding_title_stem(b)
    return bool(ka) and ka == kb


def is_same_finding(
    existing: dict[str, Any],
    *,
    title: object,
    asset_id: object = None,
    port: object = None,
    cve_id: object = None,
    location: object = None,
    description: object = None,
    poc: object = None,
) -> bool:
    """True when existing row matches the incoming agent finding identity."""
    ea = existing.get("asset_id")
    # Prefer asset identity when both sides have it.
    if ea is not None and asset_id is not None and str(ea) != str(asset_id):
        return False

    same_port = ports_equal(existing.get("port"), port)
    linked = ea is not None and asset_id is not None
    unlinked = ea is None and asset_id is None

    # CVE short-circuit: same CVE on same asset (or either missing asset) is same finding.
    ecve = str(existing.get("cve_id") or "").strip().upper()
    icve = str(cve_id or "").strip().upper()
    if ecve and icve and ecve == icve:
        if ea is None or asset_id is None or str(ea) == str(asset_id):
            if same_port or not (existing.get("port") or port):
                return True

    # Bidirectional path-class intersection (aliases expanded).
    # Incoming: title + location + poc + description.
    # Existing strong: title / location / poc only — description is used only when
    # those have no path, so a verbose write-up that mentions other modules cannot
    # false-merge (e.g. upload PoC that also names /fi/).
    i_paths = expand_path_classes(
        finding_path_classes(title, location, description, poc)
    )
    e_strong = finding_path_classes(
        existing.get("title"),
        existing.get("location"),
        existing.get("poc"),
    )
    if not e_strong:
        e_strong = finding_path_classes(existing.get("description"))
    e_paths = expand_path_classes(e_strong)
    if i_paths and e_paths and (i_paths & e_paths):
        if linked:
            return same_port
        if unlinked:
            return same_port

    # Soft stem: level/technique variants (Low vs Medium) on same asset+port.
    if title_stems_match(existing.get("title"), title):
        if linked:
            return same_port
        if unlinked:
            return same_port
        # One side unlinked: still allow stem match when ports equal.
        if same_port or not (existing.get("port") or port):
            return True

    if not titles_match(existing.get("title"), title):
        return False
    if linked:
        if not same_port:
            return False
    return True


def append_discovery_event(
    history: object,
    *,
    event: str,
    conversation_id: object = None,
    evidence_ids: list[str] | None = None,
    at: datetime | None = None,
) -> list[dict[str, Any]]:
    """Append a discovery / rediscovery event to the finding timeline."""
    now = at or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    base: list[dict[str, Any]] = []
    if isinstance(history, list):
        for item in history:
            if isinstance(item, dict):
                base.append(dict(item))
    entry: dict[str, Any] = {
        "event": str(event or "discovered"),
        "at": now.isoformat(),
    }
    if conversation_id:
        entry["conversation_id"] = str(conversation_id)
    if evidence_ids:
        entry["evidence_ids"] = [str(x) for x in evidence_ids if str(x).strip()]
    base.append(entry)
    # Cap history length for storage hygiene.
    return base[-50:]


def rediscovery_count(history: object) -> int:
    """How many times this finding was re-confirmed after first discovery."""
    if not isinstance(history, list):
        return 0
    n = 0
    for item in history:
        if not isinstance(item, dict):
            continue
        if str(item.get("event") or "").strip().lower() in {"rediscovered", "rediscover"}:
            n += 1
    return n


def discovery_count(history: object) -> int:
    """Total discovery events (first + rediscoveries). At least 1 when history empty."""
    if not isinstance(history, list) or not history:
        return 1
    n = 0
    for item in history:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("event") or "").strip().lower()
        if kind in {"discovered", "rediscovered", "rediscover"}:
            n += 1
    return max(1, n)


def pick_canonical_vuln(rows: list[Any]) -> Any | None:
    """Prefer earliest-created row as the survivor when merging duplicates."""
    if not rows:
        return None
    return sorted(
        rows,
        key=lambda r: (
            getattr(r, "discovered_at", None) is None,
            getattr(r, "discovered_at", None) or datetime.min.replace(tzinfo=timezone.utc),
            str(getattr(r, "id", "")),
        ),
    )[0]


def as_uuid(value: object) -> UUID | None:
    if value is None:
        return None
    if isinstance(value, UUID):
        return value
    try:
        return UUID(str(value))
    except (ValueError, TypeError):
        return None


def finding_path_class(*fields: object) -> str:
    """Most specific non-empty path class across narrative fields."""
    best = ""
    for field in fields:
        for key in _path_classes_in_text(field):
            if len(key) > len(best):
                best = key
    return best


def finding_path_classes(*fields: object) -> set[str]:
    """All path classes found across narrative fields."""
    out: set[str] = set()
    for field in fields:
        out |= _path_classes_in_text(field)
    return out


def _path_classes_in_text(value: object) -> set[str]:
    """Extract every path-class candidate from a free-text field."""
    raw = str(value or "").strip()
    if not raw:
        return set()
    found: set[str] = set()
    # Primary: whole-field parse (URL / leading path / module shorthand).
    primary = location_path_class(raw)
    if primary:
        found.add(primary)
    # Secondary: every absolute path token (long descriptions may mention several modules).
    for m in re.finditer(r"/(?:vulnerabilities|vuln|level\d+|hackable)[^\s,;)\]}>'\"]*", raw, flags=re.I):
        key = location_path_class(m.group(0))
        if key:
            found.add(key)
    for m in re.finditer(r"/[^\s,;)\]}>'\"]*uploads[^\s,;)\]}>'\"]*", raw, flags=re.I):
        key = location_path_class(m.group(0))
        if key:
            found.add(key)
    for m in re.finditer(
        r"(?:/(?:vulnerabilities/)?|(?:^|[\s\"'(])(?:vulnerabilities/)|(?:GET|POST|PUT|PATCH|DELETE)\s+)((?:sqli_blind|sqli|xss_r|xss_s|xss_d|fi|exec|upload|csrf|brute|captcha|weak_id|javascript)\b(?:/[^\s,;)\]}>'\"]*)?)",
        raw,
        flags=re.I,
    ):
        key = location_path_class(m.group(1))
        if key:
            found.add(key)
    return found


def row_location_blob(row: Any) -> str:
    """
    Best-effort location text from an ORM row or dict for path-class match.

    Concatenate title + description + poc — do NOT prefer a path-less payload PoC
    alone, or rediscovery will miss older rows whose title carries the module path.
    """
    if isinstance(row, dict):
        parts = [
            row.get("title"),
            row.get("location"),
            row.get("description"),
            row.get("poc"),
        ]
    else:
        parts = [
            getattr(row, "title", None),
            getattr(row, "description", None),
            getattr(row, "poc", None),
        ]
    chunks: list[str] = []
    for part in parts:
        text = str(part or "").strip()
        if text:
            chunks.append(text)
    return "\n".join(chunks)
