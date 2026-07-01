"""Conversation report export API."""
import html
import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.conversation import Conversation
from app.models.message import Message
from app.services.conversation_snapshot import message_summary
from app.services.conversation_snapshot import build_conversation_snapshot

router = APIRouter(prefix="/api/reports", tags=["reports"])


@router.get("/conversations/{conv_id}")
async def export_conversation_report(
    conv_id: str,
    format: str = Query("markdown", pattern="^(markdown|md|html)$"),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    result = await db.execute(select(Conversation).where(Conversation.id == uuid.UUID(conv_id), Conversation.user_id == user_id))
    conversation = result.scalar_one_or_none()
    if not conversation:
        raise HTTPException(404, "Conversation not found")

    snapshot = await build_conversation_snapshot(db, conversation, user_id)
    messages_result = await db.execute(
        select(Message)
        .where(Message.conversation_id == conversation.id)
        .order_by(Message.created_at, Message.id)
        .limit(500)
    )
    snapshot["messages"] = [message_summary(message) for message in messages_result.scalars().all()]
    markdown = _render_markdown(snapshot)
    basename = _safe_filename(f"{conversation.title or 'conversation'}-{str(conversation.id)[:8]}")
    if format == "html":
        body = _render_html(snapshot, markdown)
        return Response(
            content=body,
            media_type="text/html; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{basename}.html"'},
        )
    return Response(
        content=markdown,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{basename}.md"'},
    )


def _render_markdown(snapshot: dict) -> str:
    conversation = snapshot.get("conversation") or {}
    counts = snapshot.get("counts") or {}
    agent_state = snapshot.get("agent_state") or {}
    progress = snapshot.get("progress") or {}
    checkpoint = snapshot.get("checkpoint") or {}
    target = _target_from_snapshot(snapshot)
    scope = _scope_from_snapshot(snapshot)
    generated_at = datetime.now(timezone.utc).isoformat()

    lines = [
        f"# {conversation.get('title') or 'Penetration Test Report'}",
        "",
        "## Summary",
        f"- Conversation ID: `{conversation.get('id') or '-'}`",
        f"- Status: `{conversation.get('status') or '-'}`",
        f"- Generated At: `{generated_at}`",
        f"- Target: `{target or '-'}`",
        f"- Scope: `{scope or '-'}`",
        f"- Phase: `{agent_state.get('phase') or '-'}`",
        f"- Progress: `{progress.get('current', 0)}/{progress.get('total', 0)}`",
        f"- Assets: `{counts.get('assets', 0)}`",
        f"- Vulnerabilities: `{counts.get('findings', 0)}`",
        f"- Evidence: `{counts.get('evidence', 0)}`",
        "",
        "## Assets",
    ]
    assets = snapshot.get("assets") or []
    if assets:
        for asset in assets:
            props = asset.get("properties") if isinstance(asset.get("properties"), dict) else {}
            ports = asset.get("open_ports") or props.get("open_ports") or []
            services = asset.get("services") or props.get("services") or []
            lines.extend([
                f"### {asset.get('address') or asset.get('name') or 'Asset'}",
                f"- Type: `{asset.get('type') or asset.get('asset_type') or '-'}`",
                f"- Source: `{asset.get('source') or '-'}`",
                f"- Session: `{asset.get('conversation_id') or '-'}`",
                f"- Ports: `{', '.join(map(str, ports)) if isinstance(ports, list) and ports else '-'}`",
                f"- Services: `{_service_summary(services)}`",
                "",
            ])
    else:
        lines.extend(["No assets recorded.", ""])

    lines.append("## Vulnerabilities")
    findings = snapshot.get("findings") or []
    if findings:
        for finding in findings:
            lines.extend([
                f"### {finding.get('title') or 'Untitled vulnerability'}",
                f"- Severity: `{finding.get('severity') or 'info'}`",
                f"- Status: `{finding.get('status') or '-'}`",
                f"- Confidence: `{finding.get('confidence') or '-'}`",
                f"- Location: `{finding.get('location') or finding.get('affected_asset') or '-'}`",
                f"- Evidence IDs: `{', '.join(map(str, finding.get('evidence_ids') or [])) or '-'}`",
                "",
                "**Description / Impact**",
                "",
                str(finding.get("description") or "-").strip(),
                "",
                "**Reproduction / PoC**",
                "",
                "```",
                str(finding.get("poc") or finding.get("location") or "-").strip(),
                "```",
                "",
                "**Remediation**",
                "",
                str(finding.get("remediation") or "-").strip(),
                "",
            ])
    else:
        lines.extend(["No vulnerabilities recorded.", ""])

    lines.append("## Evidence")
    evidence = snapshot.get("evidence") or []
    if evidence:
        for item in evidence:
            lines.extend([
                f"### {item.get('evidence_id') or item.get('id') or 'Evidence'}",
                f"- Type: `{item.get('type') or '-'}`",
                f"- Source Tool: `{item.get('source_tool') or '-'}`",
                f"- Tool Run ID: `{item.get('tool_run_id') or '-'}`",
                f"- Hash: `{item.get('hash') or '-'}`",
                f"- Raw Ref: `{item.get('raw_ref') or '-'}`",
                "",
                str(item.get("summary") or "-").strip(),
                "",
            ])
    else:
        lines.extend(["No evidence recorded.", ""])

    lines.extend([
        "## Timeline",
    ])
    for message in (snapshot.get("messages") or [])[-80:]:
        lines.append(f"- `{message.get('created_at') or '-'}` **{message.get('role')}/{message.get('msg_type')}**: {_message_text(message)}")
    if not snapshot.get("messages"):
        lines.append("Timeline is available in the conversation message log.")

    lines.extend([
        "",
        "## Disclaimer",
        "This MVP report is generated from platform-stored conversation, asset, vulnerability, evidence, and checkpoint data. Findings should be reviewed before customer delivery.",
        "",
        "## Checkpoint Summary",
        f"- Checkpoint Phase: `{checkpoint.get('phase') or '-'}`",
        f"- Completed Phases: `{', '.join(map(str, checkpoint.get('phases_completed') or [])) or '-'}`",
    ])
    return "\n".join(lines).strip() + "\n"


def _render_html(snapshot: dict, markdown: str) -> str:
    title = html.escape((snapshot.get("conversation") or {}).get("title") or "Penetration Test Report")
    paragraphs = []
    for line in markdown.splitlines():
        escaped = html.escape(line)
        if line.startswith("# "):
            paragraphs.append(f"<h1>{html.escape(line[2:])}</h1>")
        elif line.startswith("## "):
            paragraphs.append(f"<h2>{html.escape(line[3:])}</h2>")
        elif line.startswith("### "):
            paragraphs.append(f"<h3>{html.escape(line[4:])}</h3>")
        elif line.startswith("- "):
            paragraphs.append(f"<p class='item'>{escaped}</p>")
        elif line == "```":
            paragraphs.append("<hr />")
        elif line.strip():
            paragraphs.append(f"<p>{escaped}</p>")
        else:
            paragraphs.append("<br />")
    return f"""<!doctype html>
<html>
<head>
  <meta charset=\"utf-8\" />
  <title>{title}</title>
  <style>
    body {{ font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 40px; color: #172033; line-height: 1.55; }}
    h1, h2, h3 {{ line-height: 1.2; }}
    h1 {{ border-bottom: 1px solid #d8dee8; padding-bottom: 12px; }}
    h2 {{ margin-top: 32px; }}
    code {{ background: #f3f5f8; padding: 1px 4px; border-radius: 4px; }}
    .item {{ margin: 4px 0; }}
    hr {{ border: 0; border-top: 1px dashed #ccd3df; margin: 8px 0; }}
  </style>
</head>
<body>
{''.join(paragraphs)}
</body>
</html>"""


def _target_from_snapshot(snapshot: dict) -> str:
    checkpoint = snapshot.get("checkpoint") if isinstance(snapshot.get("checkpoint"), dict) else {}
    checkpoint_target = checkpoint.get("target") if isinstance(checkpoint.get("target"), dict) else {}
    task_context = snapshot.get("task_context") if isinstance(snapshot.get("task_context"), dict) else {}
    task_target = task_context.get("target") if isinstance(task_context.get("target"), dict) else {}
    return str(checkpoint_target.get("value") or checkpoint.get("resolved_target") or task_target.get("value") or "")


def _scope_from_snapshot(snapshot: dict) -> str:
    checkpoint = snapshot.get("checkpoint") if isinstance(snapshot.get("checkpoint"), dict) else {}
    task_context = snapshot.get("task_context") if isinstance(snapshot.get("task_context"), dict) else {}
    scope = checkpoint.get("scope") if isinstance(checkpoint.get("scope"), dict) else {}
    if not scope and isinstance(task_context.get("scope"), dict):
        scope = task_context.get("scope") or {}
    allow = scope.get("allow") if isinstance(scope.get("allow"), list) else []
    deny = scope.get("deny") if isinstance(scope.get("deny"), list) else []
    parts = []
    if allow:
        parts.append("allow=" + ", ".join(map(str, allow)))
    if deny:
        parts.append("deny=" + ", ".join(map(str, deny)))
    return "; ".join(parts)


def _service_summary(services: object) -> str:
    if not isinstance(services, list) or not services:
        return "-"
    out = []
    for service in services[:8]:
        if isinstance(service, dict):
            out.append("/".join(str(service.get(k) or "") for k in ("port", "name", "version") if service.get(k)))
        else:
            out.append(str(service))
    return ", ".join(item for item in out if item) or "-"


def _message_text(message: dict) -> str:
    content = message.get("content") if isinstance(message.get("content"), dict) else {}
    text = content.get("text") or content.get("tool_name") or content.get("summary") or message.get("msg_type") or ""
    return str(text).replace("\n", " ")[:220]


def _safe_filename(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", value).strip("-._")
    return cleaned[:120] or "conversation-report"