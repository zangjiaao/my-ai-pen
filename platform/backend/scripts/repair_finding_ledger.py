#!/usr/bin/env python3
"""One-shot repair: link null-asset vulns + merge path-class soft duplicates.

Usage (from platform/backend with venv + DATABASE_URL or docker network):

  # Dry-run (default)
  python scripts/repair_finding_ledger.py

  # Apply merges/links
  python scripts/repair_finding_ledger.py --apply

Never runs automatically on migrate.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from collections import defaultdict
from pathlib import Path

# Allow `python scripts/...` from backend root
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select

from app.db.base import async_session
from app.models.asset import Asset
from app.models.vulnerability import Vulnerability
from app.services.asset_ledger import is_valid_ledger_address, split_host_port
from app.services.finding_dedupe import (
    append_discovery_event,
    expand_path_classes,
    finding_path_classes,
    is_same_finding,
    pick_canonical_vuln,
    preferred_path_class,
    row_location_blob,
)


def _blob(v: Vulnerability) -> str:
    return " ".join(
        str(x or "")
        for x in (v.poc, v.description, v.title, getattr(v, "location", None))
    )


def _guess_host(v: Vulnerability) -> tuple[str, str | None]:
    for part in (v.poc, v.description, v.title):
        try:
            host, port = split_host_port(part or "")
        except Exception:
            continue
        if host and is_valid_ledger_address(host):
            return host, port or (str(v.port).strip() if v.port else None)
    # DVWA lab heuristic: port 8080 content
    text = _blob(v).lower()
    if "8080" in text or "dvwa" in text or "/vulnerabilities/" in text:
        return "host.docker.internal", str(v.port or "8080")
    if "115.190.179.231" in text or "/level" in text:
        return "115.190.179.231", str(v.port).strip() if v.port else None
    return "", None


async def run(*, apply: bool) -> int:
    async with async_session() as db:
        assets = (await db.execute(select(Asset))).scalars().all()
        by_host: dict[str, Asset] = {}
        for a in assets:
            by_host[str(a.address or "").lower()] = a
        vulns = (await db.execute(select(Vulnerability))).scalars().all()

        link_plan: list[tuple[Vulnerability, Asset, str]] = []
        for v in vulns:
            if v.asset_id:
                continue
            host, port = _guess_host(v)
            if not host:
                continue
            asset = by_host.get(host.lower())
            if not asset:
                continue
            link_plan.append((v, asset, port or ""))

        print(f"assets={len(assets)} vulns={len(vulns)} link_candidates={len(link_plan)}")

        if apply:
            for v, asset, port in link_plan:
                v.asset_id = asset.id
                if port and not v.port:
                    v.port = port
            await db.flush()

        # Reload after links. Cluster by (user, asset, port) then pairwise is_same_finding
        # so path-alias and title-stem matches are found even when one row is path-less.
        vulns = (await db.execute(select(Vulnerability))).scalars().all()
        buckets: dict[tuple, list[Vulnerability]] = defaultdict(list)
        for v in vulns:
            if not v.user_id:
                continue
            key = (str(v.user_id), str(v.asset_id or ""), str(v.port or ""))
            buckets[key].append(v)

        def _same(a: Vulnerability, b: Vulnerability) -> bool:
            return is_same_finding(
                {
                    "title": a.title,
                    "asset_id": a.asset_id,
                    "port": a.port,
                    "cve_id": a.cve_id,
                    "location": row_location_blob(a),
                    "poc": a.poc,
                    "description": a.description,
                },
                title=b.title,
                asset_id=b.asset_id,
                port=b.port,
                cve_id=b.cve_id,
                location=row_location_blob(b),
                description=b.description,
                poc=b.poc,
            )

        # Connected components of pairwise same-finding within each bucket.
        merge_groups: list[list[Vulnerability]] = []
        for rows in buckets.values():
            if len(rows) < 2:
                continue
            remaining = list(rows)
            while remaining:
                seed = remaining.pop(0)
                component = [seed]
                changed = True
                while changed:
                    changed = False
                    still = []
                    for other in remaining:
                        if any(_same(m, other) for m in component):
                            component.append(other)
                            changed = True
                        else:
                            still.append(other)
                    remaining = still
                if len(component) > 1:
                    merge_groups.append(component)

        extras_n = sum(len(r) - 1 for r in merge_groups)
        print(f"merge_groups={len(merge_groups)} extras={extras_n}")

        if apply:
            deleted = 0
            for rows in merge_groups:
                remaining = list(rows)
                while len(remaining) > 1:
                    canon = pick_canonical_vuln(remaining)
                    if not canon:
                        break
                    extras = [o for o in remaining if o.id != canon.id and _same(canon, o)]
                    if not extras:
                        remaining = [r for r in remaining if r.id != canon.id]
                        continue
                    for duplicate in extras:
                        canon.evidence_ids = sorted(
                            set(canon.evidence_ids or []) | set(duplicate.evidence_ids or [])
                        )
                        canon.description = canon.description or duplicate.description
                        # Prefer path-bearing PoC when canonical is payload-only.
                        if not preferred_path_class(
                            expand_path_classes(finding_path_classes(canon.poc, canon.title))
                        ) and preferred_path_class(
                            expand_path_classes(finding_path_classes(duplicate.poc, duplicate.title))
                        ):
                            canon.poc = duplicate.poc or canon.poc
                        else:
                            canon.poc = canon.poc or duplicate.poc
                        canon.remediation = canon.remediation or duplicate.remediation
                        canon.asset_id = canon.asset_id or duplicate.asset_id
                        if not canon.port and duplicate.port:
                            canon.port = duplicate.port
                        # Prefer higher severity when merging level variants.
                        sev_rank = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
                        if sev_rank.get(str(duplicate.severity or "").lower(), 9) < sev_rank.get(
                            str(canon.severity or "").lower(), 9
                        ):
                            canon.severity = duplicate.severity
                        hist = list(canon.history or [])
                        for item in list(duplicate.history or []):
                            if item not in hist:
                                hist.append(item)
                        hist = append_discovery_event(
                            hist,
                            event="merged_repair",
                            conversation_id=str(duplicate.conversation_id or "") or None,
                        )
                        canon.history = hist[-50:]
                        await db.delete(duplicate)
                        deleted += 1
                    remaining = [canon] + [
                        r for r in remaining if r.id != canon.id and r.id not in {e.id for e in extras}
                    ]
            await db.commit()
            print(f"applied links={len(link_plan)} deleted_dupes={deleted}")
        else:
            print("dry-run only — re-run with --apply to write")
            for v, asset, port in link_plan[:15]:
                print(f"  link {str(v.id)[:8]} → {asset.address} port={port or v.port} title={str(v.title)[:60]}")
            if len(link_plan) > 15:
                print(f"  ... +{len(link_plan) - 15} more links")
            for rows in merge_groups[:15]:
                titles = [str(r.title)[:45] for r in rows]
                print(f"  merge n={len(rows)} titles={titles}")
            if len(merge_groups) > 15:
                print(f"  ... +{len(merge_groups) - 15} more groups")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Write links and merges")
    args = parser.parse_args()
    # Prefer env from docker-compose defaults when unset
    os.environ.setdefault(
        "DATABASE_URL",
        "postgresql+asyncpg://postgres:postgres@127.0.0.1:5432/pentest_platform",
    )
    raise SystemExit(asyncio.run(run(apply=args.apply)))


if __name__ == "__main__":
    main()
