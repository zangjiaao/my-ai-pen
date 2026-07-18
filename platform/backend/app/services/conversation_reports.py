"""CRUD helpers for conversation delivery reports."""
from __future__ import annotations

import re
import uuid
from typing import Any, TYPE_CHECKING

from app.services.engagement_report import build_engagement_report_html

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession
    from app.models.conversation_report import ConversationReport


def report_to_dict(row: Any, *, include_markdown: bool = False) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": str(row.id),
        "conversation_id": str(row.conversation_id),
        "title": row.title,
        "summary": row.summary or "",
        "source": row.source or "agent",
        "created_by": row.created_by or "",
        "finding_ids": list(row.finding_ids or []),
        "finding_count": len(row.finding_ids or []),
        "meta": dict(row.meta or {}),
        "created_at": row.created_at.isoformat() if getattr(row, "created_at", None) else None,
        "markdown_chars": len(row.markdown or ""),
    }
    if include_markdown:
        out["markdown"] = row.markdown or ""
    return out


async def list_reports(
    db: "AsyncSession",
    *,
    conversation_id: uuid.UUID,
    user_id: uuid.UUID,
    limit: int = 50,
) -> list[Any]:
    from sqlalchemy import select
    from app.models.conversation_report import ConversationReport

    result = await db.execute(
        select(ConversationReport)
        .where(
            ConversationReport.conversation_id == conversation_id,
            ConversationReport.user_id == user_id,
        )
        .order_by(ConversationReport.created_at.desc())
        .limit(max(1, min(limit, 100)))
    )
    return list(result.scalars().all())


async def get_report(
    db: "AsyncSession",
    *,
    report_id: uuid.UUID,
    user_id: uuid.UUID,
    conversation_id: uuid.UUID | None = None,
) -> Any | None:
    from sqlalchemy import select
    from app.models.conversation_report import ConversationReport

    q = select(ConversationReport).where(
        ConversationReport.id == report_id,
        ConversationReport.user_id == user_id,
    )
    if conversation_id is not None:
        q = q.where(ConversationReport.conversation_id == conversation_id)
    result = await db.execute(q)
    return result.scalar_one_or_none()


def validate_report_markdown(markdown: str) -> str:
    """Pure validation — used by create_report and unit tests (no DB)."""
    md = (markdown or "").strip()
    if len(md) < 40:
        raise ValueError("markdown body too short — provide a full delivery report body")
    return md


async def create_report(
    db: "AsyncSession",
    *,
    conversation_id: uuid.UUID,
    user_id: uuid.UUID,
    title: str,
    markdown: str,
    summary: str | None = None,
    source: str = "agent",
    created_by: str | None = None,
    finding_ids: list[str] | None = None,
    meta: dict[str, Any] | None = None,
) -> Any:
    from app.models.conversation_report import ConversationReport

    title_s = (title or "").strip() or "Security Assessment Report"
    md = validate_report_markdown(markdown)
    row = ConversationReport(
        id=uuid.uuid4(),
        conversation_id=conversation_id,
        user_id=user_id,
        title=title_s[:500],
        summary=(summary or "").strip()[:4000] or None,
        markdown=md,
        source=(source or "agent").strip()[:32] or "agent",
        created_by=(created_by or "").strip()[:255] or None,
        finding_ids=list(finding_ids or []),
        meta=dict(meta or {}),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def delete_report(
    db: "AsyncSession",
    *,
    report_id: uuid.UUID,
    user_id: uuid.UUID,
    conversation_id: uuid.UUID | None = None,
) -> bool:
    """Delete one owned report revision. Returns True if a row was removed."""
    from sqlalchemy import delete

    from app.models.conversation_report import ConversationReport

    stmt = delete(ConversationReport).where(
        ConversationReport.id == report_id,
        ConversationReport.user_id == user_id,
    )
    if conversation_id is not None:
        stmt = stmt.where(ConversationReport.conversation_id == conversation_id)
    result = await db.execute(stmt)
    await db.commit()
    return bool(getattr(result, "rowcount", 0))


def safe_download_filename(title: str, ext: str) -> str:
    """ASCII-safe basename for Content-Disposition (latin-1 header safe).

    Non-ASCII titles become a short slug; browsers still get a usable name.
    """
    raw = (title or "report").strip() or "report"
    # Keep alnum and a few safe punctuation; drop CJK/space to ASCII hyphen slug.
    ascii_parts: list[str] = []
    for ch in raw:
        if ch.isascii() and (ch.isalnum() or ch in "._-"):
            ascii_parts.append(ch)
        elif ch.isspace() or ch in "—–-/\\|":
            ascii_parts.append("-")
        # skip non-ascii letters
    slug = "".join(ascii_parts)
    slug = re.sub(r"-{2,}", "-", slug).strip("-._")[:80]
    if not slug or slug in {".", ".."}:
        slug = "detection-report"
    ext = (ext or "md").lstrip(".")
    return f"{slug}.{ext}"


def content_disposition_attachment(filename: str) -> str:
    """RFC 5987 Content-Disposition; always latin-1 safe."""
    import urllib.parse

    # filename= must be ASCII; filename*=UTF-8 for original when needed
    ascii_name = filename
    try:
        ascii_name.encode("latin-1")
    except UnicodeEncodeError:
        ascii_name = safe_download_filename(filename.rsplit(".", 1)[0], filename.rsplit(".", 1)[-1] if "." in filename else "bin")
    # Always provide ASCII filename=
    star = urllib.parse.quote(filename, safe="")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{star}"


def render_report_download(row: Any, fmt: str) -> tuple[str, str, str]:
    """Return (body, media_type, ascii_filename)."""
    from app.services.engagement_report import normalize_report_markdown_sections

    fmt_l = (fmt or "markdown").lower().strip()
    # Normalize agent drafts that skip appendix (4 → 6) before any export.
    md = normalize_report_markdown_sections(row.markdown or "")
    if fmt_l in ("html", "htm"):
        body = build_engagement_report_html(
            title=row.title,
            markdown=md,
            conversation_id=str(row.conversation_id),
        )
        return body, "text/html; charset=utf-8", safe_download_filename(str(row.title or "report"), "html")
    return md, "text/markdown; charset=utf-8", safe_download_filename(str(row.title or "report"), "md")
