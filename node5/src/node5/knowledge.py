"""On-demand tactical knowledge over experts/pentest/refs (L1 cards).

Two-layer vuln workflow (preferred):
  1) Main/Captain gets thin **vuln catalog** summaries (refs/vulns/INDEX.md)
  2) Workers ref_read **detail** cards under refs/vulns/*.md before testing

Also: payloads / components / chains for legacy query.
Not a CVE wiki or target answer key. Prove impact live before booking.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_KINDS = frozenset({"payloads", "components", "chains", "vulns", "all"})
_TOKEN = re.compile(r"[a-z0-9][a-z0-9._-]{1,40}", re.I)

# skill package → preferred vuln catalog ids (dispatch hints, not answer keys)
_SKILL_VULN_IDS: dict[str, tuple[str, ...]] = {
    "pentest-sql-injection": ("sqli-login-auth", "sqli-query-exfil", "nosql-operator-injection"),
    "pentest-xss": ("xss-stored-reflected", "xss-dom-client"),
    "pentest-ssrf": ("ssrf-url-fetch",),
    "pentest-api": (
        "mass-assignment-register",
        "unauth-api-collection",
        "business-logic-payment",
        "deprecated-api-authz",
        "nosql-operator-injection",
        "open-redirect",
    ),
    "pentest-auth-session": (
        "jwt-alg-none",
        "jwt-pubkey-confusion",
        "password-reset-ato",
        "totp-2fa",
        "change-password-no-current",
        "mass-assignment-register",
    ),
    "pentest-authz-logic": (
        "idor-horizontal-read",
        "idor-horizontal-write",
        "unauth-api-collection",
    ),
    "pentest-file-upload": ("file-upload-impact", "sensitive-file-exposure"),
    "pentest-component-rce": (
        "config-admin-exposure",
        "sensitive-file-exposure",
        "jwt-pubkey-confusion",
    ),
    "pentest-xxe": ("xxe-xml",),
    "pentest-ssti": (),
}


@dataclass
class RefCard:
    path: str  # relative to refs/, e.g. components/fastjson.md
    kind: str
    title: str
    summary: str
    body: str = ""


def refs_root(pack_root: Path) -> Path:
    return Path(pack_root) / "refs"


def _safe_rel(path: str) -> str | None:
    """Normalize a user-supplied path under refs/; reject escape."""
    raw = (path or "").strip().replace("\\", "/")
    if not raw:
        return None
    if raw.startswith("refs/"):
        raw = raw[len("refs/") :]
    raw = raw.lstrip("/")
    if ".." in raw.split("/"):
        return None
    if raw.startswith("/"):
        return None
    return raw


def _parse_card(rel: str, text: str) -> RefCard:
    kind = rel.split("/", 1)[0] if "/" in rel else "other"
    title = rel
    for line in text.splitlines():
        s = line.strip()
        if s.startswith("#"):
            title = s.lstrip("#").strip() or title
            break
    # summary: first non-empty non-heading lines
    bits: list[str] = []
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#") or s.startswith("---"):
            continue
        if s.startswith("|") or s.startswith("```"):
            continue
        bits.append(s)
        if sum(len(b) for b in bits) > 220:
            break
    summary = " ".join(bits)[:240]
    return RefCard(path=rel, kind=kind, title=title, summary=summary, body=text)


def index_refs(pack_root: Path) -> list[RefCard]:
    root = refs_root(pack_root)
    if not root.is_dir():
        return []
    out: list[RefCard] = []
    for p in sorted(root.rglob("*.md")):
        if p.name.upper() == "README.MD" or p.name == "README.md":
            # skip tree README as a "card" or include lightly
            rel = str(p.relative_to(root)).replace("\\", "/")
            if rel.lower() == "readme.md":
                continue
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        rel = str(p.relative_to(root)).replace("\\", "/")
        out.append(_parse_card(rel, text))
    return out


def list_refs(pack_root: Path, kind: str = "all") -> list[dict[str, str]]:
    k = (kind or "all").strip().lower()
    if k not in _KINDS:
        k = "all"
    cards = index_refs(pack_root)
    rows = []
    for c in cards:
        if k != "all" and c.kind != k:
            continue
        rows.append(
            {
                "path": c.path,
                "kind": c.kind,
                "title": c.title,
                "summary": c.summary[:180],
            }
        )
    return rows


def read_ref(pack_root: Path, path: str, max_chars: int = 7000) -> str:
    rel = _safe_rel(path)
    if not rel:
        return "error: invalid ref path"
    full = (refs_root(pack_root) / rel).resolve()
    root = refs_root(pack_root).resolve()
    try:
        full.relative_to(root)
    except ValueError:
        return "error: path escapes refs/"
    if not full.is_file():
        return f"error: ref not found: {rel}"
    try:
        text = full.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        return f"error: {e}"
    if len(text) > max_chars:
        text = text[:max_chars] + "\n\n…[truncated]…"
    return f"# ref:{rel}\n\n{text}"


def _tokens(s: str) -> set[str]:
    return {m.group(0).lower() for m in _TOKEN.finditer(s or "")}


def query_refs(
    pack_root: Path,
    query: str,
    kind: str = "all",
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Rank ref cards by token overlap on path/title/summary/body head."""
    q = (query or "").strip()
    if not q:
        return []
    k = (kind or "all").strip().lower()
    if k not in _KINDS:
        k = "all"
    try:
        lim = max(1, min(int(limit), 12))
    except (TypeError, ValueError):
        lim = 5
    qtoks = _tokens(q)
    if not qtoks:
        return []

    scored: list[tuple[float, RefCard]] = []
    for c in index_refs(pack_root):
        if k != "all" and c.kind != k:
            continue
        blob = f"{c.path} {c.title} {c.summary} {c.body[:1500]}".lower()
        ctoks = _tokens(blob)
        if not ctoks:
            continue
        inter = qtoks & ctoks
        if not inter:
            # substring boost for short product names
            sub = sum(1 for t in qtoks if t in blob)
            if sub == 0:
                continue
            score = float(sub) * 0.5
        else:
            score = float(len(inter)) + 0.25 * sum(
                1 for t in inter if t in c.path.lower() or t in c.title.lower()
            )
        # kind preference when query looks like product name and kind components
        if c.kind == "components" and any(
            t in c.path.lower() for t in qtoks if len(t) > 3
        ):
            score += 1.5
        scored.append((score, c))

    scored.sort(key=lambda x: (-x[0], x[1].path))
    out: list[dict[str, Any]] = []
    for score, c in scored[:lim]:
        out.append(
            {
                "path": c.path,
                "kind": c.kind,
                "title": c.title,
                "score": round(score, 2),
                "summary": c.summary[:200],
            }
        )
    return out


def format_query_result(hits: list[dict[str, Any]]) -> str:
    if not hits:
        return "no matching refs (try broader terms or ref_list kind=payloads|components|chains)"
    lines = ["ref_query hits (use ref_read path=... for full card):"]
    for h in hits:
        lines.append(
            f"- [{h.get('score')}] {h.get('path')} | {h.get('title')} — {h.get('summary')}"
        )
    return "\n".join(lines)


def suggest_refs_for_surfaces(
    pack_root: Path,
    surfaces: list[Any],
    *,
    limit: int = 6,
    embed_top: int = 1,
    embed_chars: int = 2800,
) -> str:
    """Deterministic harness hint: rank refs from observed paths/notes.

    Embeds top card bodies so methodology lands even if the model skips tools.
    Still instructs ref_read once when multiple cards are listed.
    """
    if not pack_root or not Path(pack_root).is_dir():
        return ""
    parts: list[str] = []
    for s in surfaces or []:
        if hasattr(s, "path"):
            parts.append(f"{getattr(s, 'path', '')} {getattr(s, 'note', '')}")
        elif isinstance(s, dict):
            parts.append(f"{s.get('path', '')} {s.get('note', '')}")
        else:
            parts.append(str(s))
    blob = " ".join(parts).lower()
    # Generic query seeds from observed tokens (not target answer keys)
    seeds: list[str] = []
    for token, q in (
        ("jwt", "jwt auth bypass"),
        ("login", "auth bypass login"),
        ("register", "mass assignment register"),
        ("basket", "idor basket"),
        ("cart", "idor cart"),
        ("user", "idor users api"),
        ("api", "api bola mass assignment"),
        ("rest", "api authz"),
        ("ftp", "directory listing sensitive files"),
        ("upload", "file upload"),
        ("search", "sql injection search"),
        ("review", "xss stored"),
        ("feedback", "api exposure"),
        ("password", "auth session reset"),
        ("fastjson", "fastjson"),
        ("log4j", "log4j"),
        ("shiro", "shiro"),
        ("actuator", "spring actuator"),
        ("graphql", "graphql"),
        ("otp", "rate limit otp identity"),
        ("captcha", "captcha bypass"),
        ("sms", "rate limit sms"),
        ("reset", "password reset identity flows"),
        ("forgot", "forgot password reset"),
        ("2fa", "totp 2fa identity"),
        ("totp", "totp identity flows"),
        ("webhook", "ssrf webhook"),
        ("callback", "ssrf callback"),
        ("image/url", "ssrf image url fetch"),
        ("encryption", "jwt encryptionkeys pub"),
        ("jwt.pub", "jwt advanced signed"),
        ("graphql", "graphql api authz"),
        ("mongo", "nosql injection"),
        ("ssti", "template injection ssti"),
        ("metrics", "metrics exposure"),
    ):
        if token in blob and q not in seeds:
            seeds.append(q)
    if not seeds:
        seeds = ["api authz idor", "auth session jwt"]
    seen: set[str] = set()
    hits_all: list[dict[str, Any]] = []
    for q in seeds[:8]:
        for h in query_refs(Path(pack_root), q, kind="all", limit=3):
            p = h.get("path") or ""
            if p and p not in seen:
                seen.add(p)
                hits_all.append(h)
            if len(hits_all) >= limit:
                break
        if len(hits_all) >= limit:
            break
    if not hits_all:
        return ""
    lines = [
        "Suggested tactical refs (from observed surfaces):",
        "REQUIRED: call ref_read on at least ONE path below before finishing this stage "
        "(unless you already ref_read it). Cards orient methodology only — prove live.",
    ]
    for h in hits_all[:limit]:
        lines.append(f"- {h.get('path')}: {h.get('title')} — {(h.get('summary') or '')[:100]}")
    # Embed top card(s) so knowledge is present even without tool call
    for h in hits_all[: max(0, embed_top)]:
        body = read_ref(Path(pack_root), str(h.get("path") or ""), max_chars=embed_chars)
        if body.startswith("error:"):
            continue
        lines.append("")
        lines.append(f"--- embedded ref (also available via ref_read {h.get('path')}) ---")
        lines.append(body[:embed_chars])
        lines.append("--- end embedded ref ---")
    return "\n".join(lines)


def format_list_result(rows: list[dict[str, str]]) -> str:
    if not rows:
        return "no refs found under pack refs/"
    lines = [f"refs ({len(rows)}):"]
    for r in rows[:80]:
        lines.append(f"- {r['path']} | {r['title']} — {r.get('summary', '')[:100]}")
    if len(rows) > 80:
        lines.append(f"…and {len(rows) - 80} more")
    return "\n".join(lines)


# --- Vuln catalog (Main directory + Worker details) ---------------------------------

# Supports both legacy 5-col and new 7-col INDEX tables
_INDEX_ROW_NEW = re.compile(
    r"^\|\s*`(?P<id>[a-z0-9][a-z0-9_-]+)`\s*\|\s*(?P<title>[^|]+)\|\s*"
    r"(?P<signals>[^|]+)\|\s*(?P<need_paths>[^|]+)\|\s*(?P<done_when>[^|]+)\|\s*"
    r"`?(?P<skill>[a-z0-9_-]+)`?\s*\|\s*`?(?P<detail>[^|`]+)`?\s*\|",
    re.I,
)
_INDEX_ROW_LEGACY = re.compile(
    r"^\|\s*`(?P<id>[a-z0-9][a-z0-9_-]+)`\s*\|\s*(?P<title>[^|]+)\|\s*"
    r"(?P<signals>[^|]+)\|\s*`?(?P<skill>[a-z0-9_-]+)`?\s*\|\s*`?(?P<detail>[^|`]+)`?\s*\|",
    re.I,
)


@dataclass
class VulnIndexEntry:
    id: str
    title: str
    signals: str
    skill_hint: str
    detail: str  # relative to refs/, e.g. vulns/sqli-login-auth.md
    need_paths: str = ""
    done_when: str = ""


def load_vuln_index(pack_root: Path) -> list[VulnIndexEntry]:
    """Parse refs/vulns/INDEX.md table into structured entries."""
    path = refs_root(pack_root) / "vulns" / "INDEX.md"
    if not path.is_file():
        vdir = refs_root(pack_root) / "vulns"
        if not vdir.is_dir():
            return []
        out: list[VulnIndexEntry] = []
        for p in sorted(vdir.glob("*.md")):
            if p.name.upper() == "INDEX.MD" or p.name == "INDEX.md":
                continue
            eid = p.stem
            out.append(
                VulnIndexEntry(
                    id=eid,
                    title=eid.replace("-", " "),
                    signals="",
                    skill_hint="",
                    detail=f"vulns/{p.name}",
                )
            )
        return out
    text = path.read_text(encoding="utf-8", errors="replace")
    out = []
    for line in text.splitlines():
        s = line.strip()
        m = _INDEX_ROW_NEW.match(s) or _INDEX_ROW_LEGACY.match(s)
        if not m:
            continue
        detail = m.group("detail").strip().strip("`")
        if not detail.startswith("vulns/"):
            detail = f"vulns/{detail}" if not detail.startswith("vulns") else detail
        gd = m.groupdict()
        out.append(
            VulnIndexEntry(
                id=gd["id"].strip(),
                title=gd["title"].strip(),
                signals=gd["signals"].strip(),
                skill_hint=gd["skill"].strip().strip("`"),
                detail=detail,
                need_paths=(gd.get("need_paths") or "").strip(),
                done_when=(gd.get("done_when") or "").strip(),
            )
        )
    return out


def format_vuln_catalog(
    pack_root: Path,
    *,
    max_entries: int = 40,
    for_main: bool = True,
) -> str:
    """Thin directory text for Main/Captain prompts (summaries only)."""
    entries = load_vuln_index(pack_root)
    if not entries:
        return ""
    lines = [
        "VULN CATALOG (directory — expand recall; not a must-find list):",
        "Only pick ids whose need_paths match observed surfaces (else recon that path first).",
        "Workers ref_read detail and stop when done_when is met. Catalog ≠ vulnerability.",
    ]
    for e in entries[:max_entries]:
        lines.append(
            f"- id=`{e.id}` | {e.title} | need_paths: {e.need_paths or e.signals[:60]} | "
            f"done_when: {(e.done_when or 'live proof')[:80]} | detail=`{e.detail}`"
        )
    if len(entries) > max_entries:
        lines.append(f"…and {len(entries) - max_entries} more (ref_list kind=vulns)")
    if for_main:
        lines.append(
            "Main role: map attack surface → candidate vuln ids (path-matched) → workers. "
            "Do not deep-test every catalog row yourself."
        )
    return "\n".join(lines)


def _path_blob(paths: list[str] | None, surfaces: list[Any] | None) -> str:
    parts: list[str] = list(paths or [])
    for s in surfaces or []:
        if hasattr(s, "path"):
            parts.append(f"{getattr(s, 'path', '')} {getattr(s, 'note', '')}")
        elif isinstance(s, dict):
            parts.append(f"{s.get('path', '')} {s.get('note', '')}")
    return " ".join(parts).lower()


def entry_matches_paths(entry: VulnIndexEntry, path_blob: str) -> bool:
    """True if need_paths/signals intersect path_blob, or need_paths empty."""
    needles = [
        x.strip().lower()
        for x in re.split(r"[,/]", entry.need_paths or entry.signals or "")
        if x.strip() and len(x.strip()) > 1
    ]
    if not needles:
        return True
    if not path_blob.strip():
        return True  # no path context yet — allow skill default
    return any(n in path_blob for n in needles)


def vuln_entries_for_skill(
    pack_root: Path,
    skill_id: str,
    *,
    paths: list[str] | None = None,
    surfaces: list[Any] | None = None,
    max_ids: int = 2,
) -> list[VulnIndexEntry]:
    """Catalog rows for a worker: skill affinity + path intersection."""
    want = set(_SKILL_VULN_IDS.get(skill_id or "", ()))
    entries = load_vuln_index(pack_root)
    by_id = {e.id: e for e in entries}
    candidates: list[VulnIndexEntry] = []
    for i in want:
        if i in by_id:
            candidates.append(by_id[i])
    for e in entries:
        if e.skill_hint == skill_id and e.id not in {x.id for x in candidates}:
            candidates.append(e)
    blob = _path_blob(paths, surfaces)
    matched = [e for e in candidates if entry_matches_paths(e, blob)]
    # If path filter wiped everything but we have paths, keep skill-only top 1 as soft fallback
    if not matched and candidates and blob.strip():
        matched = candidates[:1]
    elif not matched:
        matched = candidates

    # Prefer entries whose need_paths actually hit the blob (more specific first)
    def _spec_score(e: VulnIndexEntry) -> tuple[int, int]:
        needles = [
            x.strip().lower()
            for x in re.split(r"[,/]", e.need_paths or "")
            if x.strip() and len(x.strip()) > 1
        ]
        hits = sum(1 for n in needles if n in blob) if blob else 0
        # higher hits first; longer need_paths tokens preferred over generic "api"
        return (-hits, -max((len(n) for n in needles if n in blob), default=0))

    matched.sort(key=_spec_score)
    return matched[: max(1, max_ids)]


def format_worker_vuln_assignment(
    pack_root: Path,
    skill_id: str,
    *,
    max_ids: int = 2,
    paths: list[str] | None = None,
    surfaces: list[Any] | None = None,
) -> str:
    """Instruction block: which catalog details this worker should ref_read."""
    rows = vuln_entries_for_skill(
        pack_root,
        skill_id,
        paths=paths,
        surfaces=surfaces,
        max_ids=max_ids,
    )
    if not rows:
        return (
            "VULN DETAILS: no path-matched catalog ids for this skill — "
            "ref_query if needed, then prove live on assigned paths only."
        )
    lines = [
        "ASSIGNED VULN CATALOG IDS (path-matched; read details BEFORE testing):",
        "For each id: ref_read path=<detail>, plan from steps, test until done_when or honest dead-end.",
        f"Max {max_ids} ids — do not thrash every catalog row.",
    ]
    for e in rows:
        dw = e.done_when or "live proof per detail"
        lines.append(
            f"- id=`{e.id}` detail=`{e.detail}` — {e.title} | done_when: {dw[:100]}"
        )
    return "\n".join(lines)


def match_vuln_ids_for_surfaces(
    pack_root: Path,
    surfaces: list[Any],
    *,
    limit: int = 8,
) -> list[VulnIndexEntry]:
    """Highlight catalog rows whose signal tokens appear on surfaces (Main assist)."""
    parts: list[str] = []
    for s in surfaces or []:
        if hasattr(s, "path"):
            parts.append(f"{getattr(s, 'path', '')} {getattr(s, 'note', '')}")
        elif isinstance(s, dict):
            parts.append(f"{s.get('path', '')} {s.get('note', '')}")
    blob = " ".join(parts).lower()
    if not blob.strip():
        return []
    scored: list[tuple[int, VulnIndexEntry]] = []
    for e in load_vuln_index(pack_root):
        sigs = [x.strip().lower() for x in re.split(r"[,/]", e.signals) if x.strip()]
        hits = sum(1 for s in sigs if s and s in blob)
        if hits:
            scored.append((hits, e))
    scored.sort(key=lambda x: (-x[0], x[1].id))
    return [e for _, e in scored[:limit]]


def format_surface_matched_vulns(
    pack_root: Path,
    surfaces: list[Any],
    *,
    limit: int = 8,
) -> str:
    rows = match_vuln_ids_for_surfaces(pack_root, surfaces, limit=limit)
    if not rows:
        return ""
    lines = [
        "CATALOG HITS from observed surfaces (still not answer keys):",
        "Prefer dispatching workers for these ids when paths match.",
    ]
    for e in rows:
        lines.append(f"- `{e.id}` → `{e.detail}` ({e.title})")
    return "\n".join(lines)
