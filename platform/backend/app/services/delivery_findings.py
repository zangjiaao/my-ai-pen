"""Product delivery-report finding shape (pure mapping, no DB I/O).

Booked vulnerabilities only — never checkpoint/message *candidate* rows.
Maps Vulnerability columns + optional Asset address/name into the dict shape
expected by ``build_engagement_report_markdown``.
"""
from __future__ import annotations

import re
from typing import Any


# Snapshot / checkpoint rows that must never appear in a client delivery report.
_NON_BOOKED_STATUSES = frozenset(
    {
        "candidate",
        "candidates",
        "draft",
        "rejected",
        "false_positive",
        "false-positive",
        "unconfirmed",
        "hypothesis",
        "potential",
    }
)

_URL_RE = re.compile(r"https?://[^\s\"'<>]+", re.I)
# Trim common trailing junk from extracted URLs
_URL_TRAIL_RE = re.compile(r"[),.;'\"]+$")
_LOCATION_LINE_RE = re.compile(r"(?im)^\s*Location:\s*(.+)$")


def is_booked_finding_status(status: object) -> bool:
    """True for ledger/booked statuses; false for candidate/hypothesis labels."""
    s = str(status or "").strip().lower()
    if not s:
        # Empty status on a Vulnerability row is still a booked ledger finding.
        return True
    if s in _NON_BOOKED_STATUSES:
        return False
    if "candidate" in s:
        return False
    return True


def extract_location_hint(*texts: object) -> str:
    """Best-effort location/URL from stored narrative fields (no invention)."""
    for raw in texts:
        text = str(raw or "").strip()
        if not text:
            continue
        m = _LOCATION_LINE_RE.search(text)
        if m:
            return m.group(1).strip()[:500]
        urls = _URL_RE.findall(text)
        if urls:
            return _URL_TRAIL_RE.sub("", urls[0])[:500]
    return ""


def map_vulnerability_to_delivery_finding(
    *,
    id: object = None,
    title: object = None,
    severity: object = None,
    status: object = None,
    description: object = None,
    poc: object = None,
    remediation: object = None,
    cve_id: object = None,
    cvss: object = None,
    port: object = None,
    asset_id: object = None,
    evidence_ids: object = None,
    asset_address: object = None,
    asset_name: object = None,
    location: object = None,
    url: object = None,
    host: object = None,
    impact: object = None,
    root_cause: object = None,
    cvss_vector: object = None,
) -> dict[str, Any] | None:
    """Map one booked finding + optional asset fields → report dict.

    Returns None when the row is not booked (e.g. snapshot candidate).
    """
    if not is_booked_finding_status(status):
        return None

    title_s = str(title or "").strip() or "Untitled finding"
    host_s = (
        str(host or "").strip()
        or str(asset_address or "").strip()
        or str(asset_name or "").strip()
    )
    loc_s = str(location or "").strip() or str(url or "").strip()
    if not loc_s:
        loc_s = extract_location_hint(poc, description)

    eids: list[str] = []
    if isinstance(evidence_ids, list):
        eids = [str(x) for x in evidence_ids if x]
    elif evidence_ids:
        eids = [str(evidence_ids)]

    out: dict[str, Any] = {
        "id": str(id) if id is not None else "",
        "title": title_s,
        "severity": str(severity or "unknown").strip().lower() or "unknown",
        "status": str(status or "").strip() or None,
        "description": str(description or "").strip() or None,
        "poc": str(poc or "").strip() or None,
        "remediation": str(remediation or "").strip() or None,
        "cve_id": str(cve_id).strip() if cve_id else None,
        "cvss": cvss,
        "port": str(port).strip() if port not in (None, "") else None,
        "asset_id": str(asset_id) if asset_id else None,
        "evidence_ids": eids,
    }
    if host_s:
        out["host"] = host_s
    if loc_s:
        out["location"] = loc_s
        out["url"] = loc_s
    if impact:
        out["impact"] = str(impact).strip()
    if root_cause:
        out["root_cause"] = str(root_cause).strip()
    if cvss_vector:
        out["cvss_vector"] = str(cvss_vector).strip()
    # Drop Nones for cleaner fixtures (builder tolerates both)
    return {k: v for k, v in out.items() if v is not None and v != ""}


def map_vulnerability_orm(v: Any, asset: Any | None = None) -> dict[str, Any] | None:
    """Map SQLAlchemy Vulnerability (+ optional Asset) using real attributes."""
    return map_vulnerability_to_delivery_finding(
        id=getattr(v, "id", None),
        title=getattr(v, "title", None),
        severity=getattr(v, "severity", None),
        status=getattr(v, "status", None),
        description=getattr(v, "description", None),
        poc=getattr(v, "poc", None),
        remediation=getattr(v, "remediation", None),
        cve_id=getattr(v, "cve_id", None),
        cvss=getattr(v, "cvss", None),
        port=getattr(v, "port", None),
        asset_id=getattr(v, "asset_id", None),
        evidence_ids=getattr(v, "evidence_ids", None) or [],
        asset_address=getattr(asset, "address", None) if asset is not None else None,
        asset_name=getattr(asset, "name", None) if asset is not None else None,
    )


def filter_snapshot_findings_for_delivery(items: list[Any] | None) -> list[dict[str, Any]]:
    """Hard filter: only explicitly confirmed snapshot rows (never candidates).

    Prefer not using this path for product export; DB ledger is source of truth.
    Kept for defensive callers that pass snapshot data intentionally.
    """
    out: list[dict[str, Any]] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        status = str(item.get("status") or "").strip().lower()
        # Snapshot merge includes candidate_findings with status=candidate — reject.
        if not is_booked_finding_status(status):
            continue
        # Require confirmed/open booked labels when coming from snapshot (not blank).
        if status in ("", "open") and not item.get("evidence_ids"):
            # Ambiguous snapshot noise without evidence — skip
            continue
        if status not in (
            "confirmed",
            "to_fix",
            "fixing",
            "reported",
            "in_progress",
            "retest",
            "fixed",
            "closed",
        ):
            # Unknown snapshot status: only keep if evidence_ids present (likely booked card)
            if not item.get("evidence_ids"):
                continue
        mapped = map_vulnerability_to_delivery_finding(
            id=item.get("id") or item.get("vulnerability_id"),
            title=item.get("title"),
            severity=item.get("severity"),
            status=status or "confirmed",
            description=item.get("description"),
            poc=item.get("poc"),
            remediation=item.get("remediation"),
            cve_id=item.get("cve_id") or item.get("cve"),
            cvss=item.get("cvss"),
            port=item.get("port"),
            asset_id=item.get("asset_id"),
            evidence_ids=item.get("evidence_ids"),
            asset_address=item.get("address") or item.get("asset"),
            asset_name=item.get("asset_name") or item.get("name"),
            location=item.get("location") or item.get("url") or item.get("affected_asset"),
            url=item.get("url"),
            host=item.get("host") or item.get("hostname"),
            impact=item.get("impact"),
            root_cause=item.get("root_cause"),
            cvss_vector=item.get("cvss_vector"),
        )
        if mapped:
            out.append(mapped)
    return out
