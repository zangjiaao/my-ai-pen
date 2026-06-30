"""Inspect and optionally repair a platform conversation.

Usage:
  python scripts/session_integrity_check.py <conversation_id>
  python scripts/session_integrity_check.py <conversation_id> --repair
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import uuid
from collections import Counter
from pathlib import Path

from sqlalchemy import select, text
from sqlalchemy.exc import SQLAlchemyError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "platform" / "backend"))

from app.db.base import async_session  # noqa: E402
from app.models.conversation import Conversation  # noqa: E402
from app.models.asset import Asset  # noqa: E402
from app.models.message import Message  # noqa: E402
from app.models.vulnerability import Vulnerability  # noqa: E402
from app.ws import router as ws_router  # noqa: E402
from app.services.conversation_snapshot import build_conversation_snapshot  # noqa: E402


REQUIRED_COLUMNS = {
    "assets": {"user_id", "conversation_id", "node_id"},
    "vulnerabilities": {"user_id", "node_id"},
    "evidence": {"id", "evidence_id", "conversation_id", "user_id", "node_id"},
}


async def _table_columns(table: str) -> set[str]:
    async with async_session() as db:
        rows = (await db.execute(text(
            "select column_name from information_schema.columns where table_name=:table"
        ), {"table": table})).scalars().all()
    return {str(row) for row in rows}


async def _schema_report() -> dict:
    report = {}
    for table, required in REQUIRED_COLUMNS.items():
        columns = await _table_columns(table)
        report[table] = {
            "exists": bool(columns),
            "missing": sorted(required - columns),
            "columns": sorted(columns),
        }
    return report


async def _messages(conversation_id: uuid.UUID) -> list[Message]:
    async with async_session() as db:
        return (await db.execute(
            select(Message).where(Message.conversation_id == conversation_id).order_by(Message.created_at, Message.id)
        )).scalars().all()


async def _conversation(conversation_id: uuid.UUID) -> Conversation | None:
    async with async_session() as db:
        return (await db.execute(select(Conversation).where(Conversation.id == conversation_id))).scalar_one_or_none()


async def _conversations() -> list[Conversation]:
    async with async_session() as db:
        return (await db.execute(select(Conversation).order_by(Conversation.created_at))).scalars().all()


def _event_counts(messages: list[Message]) -> dict:
    return dict(Counter(m.msg_type for m in messages))


async def _read_model_counts(conversation_id: uuid.UUID) -> dict:
    counts = {}
    async with async_session() as db:
        for name, sql in {
            "assets": "select count(*) from assets where conversation_id=:conversation_id",
            "vulnerabilities": "select count(*) from vulnerabilities where conversation_id=:conversation_id",
            "evidence": "select count(*) from evidence where conversation_id=:conversation_id",
        }.items():
            try:
                counts[name] = int((await db.execute(text(sql), {"conversation_id": str(conversation_id)})).scalar_one())
            except SQLAlchemyError as exc:
                counts[name] = {"error": str(exc)}
                await db.rollback()
    return counts


async def _snapshot_counts(conversation: Conversation) -> dict:
    async with async_session() as db:
        fresh = await db.get(Conversation, conversation.id)
        if not fresh:
            return {"error": "conversation not found"}
        snapshot = await build_conversation_snapshot(db, fresh, fresh.user_id)
        return snapshot.get("counts", {})


async def _repair(messages: list[Message], node_id: str | None) -> dict:
    repaired = Counter()
    for message in messages:
        if not isinstance(message.content, dict):
            continue
        payload = {**message.content, "conversation_id": str(message.conversation_id)}
        if message.msg_type == "asset_discovered":
            await ws_router._persist_asset(payload, node_id)
            repaired["assets"] += 1
        elif message.msg_type == "vuln_found":
            await ws_router._persist_vulnerability(payload, node_id)
            repaired["vulnerabilities"] += 1
        elif message.msg_type == "evidence_created":
            await ws_router._persist_evidence(payload, node_id)
            repaired["evidence"] += 1
    return dict(repaired)


def _merge_status(current: str | None, incoming: str | None) -> str:
    rank = {
        "false_positive": 0,
        "pending": 1,
        "accepted": 2,
        "confirmed": 3,
        "reported": 4,
        "fixed": 5,
    }
    current_value = current or "pending"
    incoming_value = incoming or "pending"
    return incoming_value if rank.get(incoming_value, 1) >= rank.get(current_value, 1) else current_value


async def _dedupe_assets(conversation_id: uuid.UUID) -> int:
    removed = 0
    async with async_session() as db:
        rows = (await db.execute(
            select(Asset)
            .where(Asset.conversation_id == conversation_id)
            .order_by(Asset.address, Asset.created_at, Asset.id)
        )).scalars().all()
        by_address: dict[str, list[Asset]] = {}
        for asset in rows:
            canonical = ws_router._asset_address(asset.address)
            if canonical != asset.address:
                asset.address = canonical
                asset.name = canonical if asset.name == asset.address else asset.name
            by_address.setdefault(canonical, []).append(asset)

        for address, duplicates in by_address.items():
            if len(duplicates) < 2:
                continue
            keeper = duplicates[0]
            keeper.address = address
            for duplicate in duplicates[1:]:
                await db.execute(text(
                    "update vulnerabilities set asset_id=:keeper_id where asset_id=:duplicate_id"
                ), {"keeper_id": str(keeper.id), "duplicate_id": str(duplicate.id)})
                keeper.properties = {**(duplicate.properties or {}), **(keeper.properties or {})}
                keeper.tags = sorted(set(keeper.tags or []) | set(duplicate.tags or []))
                keeper.node_id = keeper.node_id or duplicate.node_id
                keeper.user_id = keeper.user_id or duplicate.user_id
                await db.delete(duplicate)
                removed += 1
        if removed:
            await db.commit()
    return removed


async def _dedupe_vulnerabilities(conversation_id: uuid.UUID) -> int:
    removed = 0
    async with async_session() as db:
        rows = (await db.execute(
            select(Vulnerability)
            .where(Vulnerability.conversation_id == conversation_id)
            .order_by(Vulnerability.title, Vulnerability.discovered_at, Vulnerability.id)
        )).scalars().all()
        by_title: dict[str, list[Vulnerability]] = {}
        for vuln in rows:
            by_title.setdefault(vuln.title, []).append(vuln)

        for duplicates in by_title.values():
            if len(duplicates) < 2:
                continue
            keeper = duplicates[0]
            for duplicate in duplicates[1:]:
                keeper.evidence_ids = sorted(set(keeper.evidence_ids or []) | set(duplicate.evidence_ids or []))
                keeper.node_id = keeper.node_id or duplicate.node_id
                keeper.asset_id = keeper.asset_id or duplicate.asset_id
                keeper.description = keeper.description or duplicate.description
                keeper.poc = keeper.poc or duplicate.poc
                keeper.remediation = keeper.remediation or duplicate.remediation
                keeper.confidence = keeper.confidence or duplicate.confidence
                keeper.status = _merge_status(keeper.status, duplicate.status)
                await db.delete(duplicate)
                removed += 1
        if removed:
            await db.commit()
    return removed


async def _inspect_conversation(conversation: Conversation, *, repair: bool, schema: dict) -> dict:
    messages = await _messages(conversation.id)
    before_counts = await _read_model_counts(conversation.id)
    repair_result = None
    if repair:
        repair_result = await _repair(messages, str(conversation.node_id) if conversation.node_id else None)
        removed_assets = await _dedupe_assets(conversation.id)
        removed_duplicates = await _dedupe_vulnerabilities(conversation.id)
        repair_result["deduped_assets"] = removed_assets
        repair_result["deduped_vulnerabilities"] = removed_duplicates

    snapshot_counts = await _snapshot_counts(conversation)

    return {
        "conversation": {
            "id": str(conversation.id),
            "status": conversation.status,
            "node_id": str(conversation.node_id) if conversation.node_id else None,
        },
        "message_count": len(messages),
        "message_counts": _event_counts(messages),
        "read_model_counts_before": before_counts,
        "snapshot_counts": snapshot_counts,
        "repair": repair_result,
        "read_model_counts_after": await _read_model_counts(conversation.id) if repair else None,
        "late_summary": [
            {
                "index": index,
                "type": message.msg_type,
                "summary": str((message.content or {}).get("title") or (message.content or {}).get("text") or "")[:160],
            }
            for index, message in enumerate(messages, start=1)
            if index > 200 and message.msg_type in {"vuln_found", "asset_discovered", "evidence_created", "text", "status"}
        ][-30:],
    }


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("conversation_id", nargs="?")
    parser.add_argument("--all", action="store_true", help="inspect or repair all conversations")
    parser.add_argument("--repair", action="store_true")
    args = parser.parse_args()

    if not args.all and not args.conversation_id:
        raise SystemExit("provide a conversation_id or --all")

    schema = await _schema_report()
    missing = {table: data["missing"] for table, data in schema.items() if data["missing"]}
    if args.repair and missing:
        raise SystemExit("schema is missing required columns/tables; run migrations first: " + json.dumps(missing, ensure_ascii=False))

    conversations = await _conversations() if args.all else [await _conversation(uuid.UUID(args.conversation_id))]
    conversations = [conversation for conversation in conversations if conversation]
    if not conversations:
        raise SystemExit("conversation not found")

    results = [await _inspect_conversation(conversation, repair=args.repair, schema=schema) for conversation in conversations]
    aggregate = {
        "conversations": len(results),
        "messages": sum(item["message_count"] for item in results),
        "message_counts": dict(sum((Counter(item["message_counts"]) for item in results), Counter())),
    }
    if args.repair:
        aggregate["repair"] = dict(sum((Counter(item.get("repair") or {}) for item in results), Counter()))

    report = {
        "schema": schema,
        "aggregate": aggregate,
        "results": results,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    asyncio.run(main())
