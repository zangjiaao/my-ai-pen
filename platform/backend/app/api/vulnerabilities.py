"""Vulnerability API — management lifecycle (待修复 / 修复中 / 已修复)."""
from __future__ import annotations

import json
import re
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.asset import Asset
from app.models.audit import AuditLog
from app.models.conversation import Conversation
from app.models.evidence import Evidence
from app.models.message import Message
from app.models.vulnerability import Vulnerability

router = APIRouter(prefix="/api/vulnerabilities", tags=["vulnerabilities"])

# Management lifecycle (user-facing): only three states.
LIFECYCLE = {
    "to_fix": "待修复",
    "fixing": "修复中",
    "fixed": "已修复",
}
STATUSES = set(LIFECYCLE.keys())

# Map legacy / agent discovery statuses into lifecycle.
LEGACY_STATUS_MAP = {
    "pending": "to_fix",
    "open": "to_fix",
    "confirmed": "to_fix",
    "candidate": "to_fix",
    "in_progress": "fixing",
    "retest": "fixing",
    "reported": "fixing",
    "fixed": "fixed",
    "closed": "fixed",
    # Former "ignored" / false-positive style statuses re-enter the open queue.
    "accepted": "to_fix",
    "false_positive": "to_fix",
    "risk_accepted": "to_fix",
    "rejected": "to_fix",
    "duplicate": "to_fix",
    "ignored": "to_fix",
    "to_fix": "to_fix",
    "fixing": "fixing",
}

TRANSITIONS = {
    "to_fix": {"fixing", "fixed"},
    "fixing": {"to_fix", "fixed"},
    "fixed": {"to_fix", "fixing"},  # reopen / retest found still open
}


class AssetSummaryOut(BaseModel):
    id: str
    name: str
    address: str
    type: str


class EvidenceOut(BaseModel):
    id: str
    evidence_id: str
    type: str
    source_tool: str | None = None
    tool_run_id: str | None = None
    raw_ref: str | None = None
    summary: str | None = None
    hash: str | None = None
    properties: dict = Field(default_factory=dict)
    created_at: str | None = None


class VulnOut(BaseModel):
    id: str
    user_id: str | None = None
    conversation_id: str | None = None
    node_id: str | None = None
    title: str
    severity: str
    cvss: float | None
    cve_id: str | None
    asset_id: str | None
    port: str | None = None
    asset: AssetSummaryOut | None = None
    confidence: str
    status: str
    status_label: str = ""
    kind: str = "vuln"  # vuln | key | flag
    description: str | None
    poc: str | None
    remediation: str | None
    evidence_ids: list[str] = Field(default_factory=list)
    evidence: list[EvidenceOut] = Field(default_factory=list)
    status_timeline: list[dict] = Field(default_factory=list)
    allowed_next_statuses: list[str] = Field(default_factory=list)
    discovered_at: str | None
    updated_at: str | None
    model_config = {"from_attributes": True}


class RetestOut(BaseModel):
    conversation_id: str
    started: bool
    target: dict
    scope: dict
    instruction: str
    message: str


class BatchStatusBody(BaseModel):
    ids: list[str] = Field(default_factory=list)
    status: str


class ReportSessionBody(BaseModel):
    """Start a conversation so Agent can draft a remediation report for selected findings."""
    ids: list[str] = Field(default_factory=list)
    status: str | None = None  # optional filter label for instruction


class VulnListOut(BaseModel):
    items: list[VulnOut]
    total: int
    limit: int
    offset: int


def _split_multi(values: list[str] | None) -> list[str]:
    """Normalize multi query params: accept repeated keys and comma-separated values."""
    out: list[str] = []
    for raw in values or []:
        for part in str(raw).split(","):
            part = part.strip()
            if part:
                out.append(part)
    return out


@router.get("", response_model=VulnListOut)
async def list_vulns(
    severity: list[str] | None = Query(None, description="Multi severity: critical|high|…"),
    status: list[str] | None = Query(None, description="Multi lifecycle: to_fix|fixing|fixed"),
    search: str | None = Query(None),
    asset_id: list[str] | None = Query(None, description="Multi asset ids"),
    kind: list[str] | None = Query(None, description="Multi kind: vuln|key|flag"),
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    q = select(Vulnerability).where(Vulnerability.user_id == user_id)

    severities = [s.lower() for s in _split_multi(severity)]
    if severities:
        q = q.where(Vulnerability.severity.in_(severities))

    if search and search.strip():
        needle = f"%{search.strip()}%"
        q = q.where(
            or_(
                Vulnerability.title.ilike(needle),
                Vulnerability.description.ilike(needle),
                Vulnerability.poc.ilike(needle),
            )
        )
    asset_uuids: list[uuid.UUID] = []
    for part in _split_multi(asset_id):
        try:
            asset_uuids.append(uuid.UUID(part))
        except ValueError:
            continue
    if asset_uuids:
        q = q.where(Vulnerability.asset_id.in_(asset_uuids))

    # Load full SQL-filtered set so status/kind (Python) pagination totals are correct.
    q = q.order_by(Vulnerability.discovered_at.desc()).limit(5000)
    result = await db.execute(q)
    vulns = list(result.scalars().all())

    status_wants = {normalize_status(s) for s in _split_multi(status)}
    if status_wants:
        vulns = [v for v in vulns if normalize_status(v.status) in status_wants]

    assets = await _assets_by_id(db, user_id, [v.asset_id for v in vulns if v.asset_id])
    outs = [_out(v, asset=assets.get(v.asset_id) if v.asset_id else None) for v in vulns]

    kind_wants: set[str] = set()
    for k in _split_multi(kind):
        kk = k.strip().lower()
        if kk == "auth":
            kk = "key"
        if kk in {"vuln", "key", "flag"}:
            kind_wants.add(kk)
    if kind_wants:
        outs = [o for o in outs if o.kind in kind_wants]

    total = len(outs)
    page = outs[offset : offset + limit]
    return VulnListOut(items=page, total=total, limit=limit, offset=offset)


@router.post("/batch-status")
async def batch_update_status(
    body: BatchStatusBody,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Bulk set lifecycle status for selected findings."""
    user_id = uuid.UUID(current_user["user_id"])
    next_status = normalize_status(body.status)
    if next_status not in STATUSES:
        raise HTTPException(400, f"不支持的状态：{body.status}")
    ids: list[uuid.UUID] = []
    for raw in body.ids or []:
        try:
            ids.append(uuid.UUID(str(raw)))
        except ValueError:
            continue
    if not ids:
        raise HTTPException(400, "请选择至少一条漏洞")
    result = await db.execute(
        select(Vulnerability).where(Vulnerability.user_id == user_id, Vulnerability.id.in_(ids))
    )
    rows = list(result.scalars().all())
    updated = 0
    skipped = 0
    for v in rows:
        current = normalize_status(v.status)
        if next_status == current:
            skipped += 1
            continue
        if next_status not in TRANSITIONS.get(current, set()):
            skipped += 1
            continue
        before = v.status
        v.status = next_status
        await _audit(
            db,
            user_id,
            "vulnerability.update",
            "vulnerability",
            v.id,
            v.conversation_id,
            {"fields": ["status"], "before_status": before, "after_status": next_status, "batch": True},
        )
        updated += 1
    await db.commit()
    return {"updated": updated, "skipped": skipped, "status": next_status, "status_label": LIFECYCLE[next_status]}


@router.post("/report-session", response_model=RetestOut)
async def start_report_session(
    body: ReportSessionBody,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Create a session that asks the Agent to draft a remediation report
    for selected findings (optionally filtered by lifecycle status).
    """
    user_id = uuid.UUID(current_user["user_id"])
    ids: list[uuid.UUID] = []
    for raw in body.ids or []:
        try:
            ids.append(uuid.UUID(str(raw)))
        except ValueError:
            continue
    if not ids:
        raise HTTPException(400, "请选择至少一条漏洞以生成报告")
    result = await db.execute(
        select(Vulnerability).where(Vulnerability.user_id == user_id, Vulnerability.id.in_(ids))
    )
    vulns = list(result.scalars().all())
    if not vulns:
        raise HTTPException(404, "未找到所选漏洞")
    assets = await _assets_by_id(db, user_id, [v.asset_id for v in vulns if v.asset_id])
    lines = []
    allow: list[str] = []
    for v in vulns:
        st = normalize_status(v.status)
        asset = assets.get(v.asset_id) if v.asset_id else None
        addr = asset.address if asset else "—"
        if asset and asset.address and asset.address not in allow:
            allow.append(asset.address)
        lines.append(
            f"- [{LIFECYCLE.get(st, st)}] [{v.severity}] {v.title} · 资产 {addr}"
            + (f" · 端口 {v.port}" if getattr(v, "port", None) else "")
        )
    status_hint = ""
    if body.status:
        status_hint = f"（筛选状态：{LIFECYCLE.get(normalize_status(body.status), body.status)}）"
    instruction = (
        f"请根据以下漏洞清单生成修复报告{status_hint}。\n"
        "报告需包含：摘要、按资产分组的问题列表、严重级别、当前处理状态、修复建议与复测建议。\n"
        "不要扩大测试范围；以交付业务方整改为主。\n\n"
        "漏洞清单：\n" + "\n".join(lines)
    )
    target_value = allow[0] if allow else "report"
    target = {"type": "host", "value": target_value}
    scope = {"allow": allow or [target_value], "deny": []}
    context = {
        "task": {"target": target, "scope": scope, "instruction": instruction},
        "report": {
            "vulnerability_ids": [str(v.id) for v in vulns],
            "status_filter": body.status,
        },
    }
    conv = Conversation(
        id=uuid.uuid4(),
        user_id=user_id,
        title=f"漏洞报告 ({len(vulns)} 项)"[:255],
        status="created",
        context=context,
    )
    db.add(conv)
    await db.flush()
    db.add(
        Message(
            id=uuid.uuid4(),
            conversation_id=conv.id,
            role="user",
            msg_type="text",
            content={"text": instruction, "report": context["report"]},
        )
    )
    await _audit(
        db,
        user_id,
        "vuln.report",
        "vulnerability",
        vulns[0].id,
        conv.id,
        {"count": len(vulns), "ids": [str(v.id) for v in vulns]},
    )
    await db.commit()
    await db.refresh(conv)
    started = await _dispatch_retest_if_possible(str(conv.id), str(user_id), target, scope, instruction)
    return RetestOut(
        conversation_id=str(conv.id),
        started=started,
        target=target,
        scope=scope,
        instruction=instruction,
        message="报告会话已创建" + ("并已派发节点" if started else "；当前无在线节点，可稍后在会话中启动"),
    )


@router.get("/{vuln_id}", response_model=VulnOut)
async def get_vuln(
    vuln_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    v = await _get(vuln_id, current_user, db)
    asset = None
    if v.asset_id:
        assets = await _assets_by_id(db, user_id, [v.asset_id])
        asset = assets.get(v.asset_id)
    evidence = await _evidence_for(db, user_id, v.evidence_ids or [])
    return _out(v, asset=asset, evidence=evidence)


@router.post("/{vuln_id}/retest", response_model=RetestOut)
async def retest_vuln(
    vuln_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    v = await _get(vuln_id, current_user, db)
    asset = None
    if v.asset_id:
        assets = await _assets_by_id(db, user_id, [v.asset_id])
        asset = assets.get(v.asset_id)

    target_value = _retest_target(v, asset)
    if not target_value:
        raise HTTPException(400, "无法复测：缺少关联资产或可访问目标")

    # Auto-move 待修复 → 修复中 when starting retest (plan verification).
    current = normalize_status(v.status)
    if current == "to_fix" and "fixing" in TRANSITIONS.get(current, set()):
        v.status = "fixing"

    target = {
        "type": "url" if str(target_value).startswith(("http://", "https://")) else "host",
        "value": target_value,
    }
    scope = {"allow": [target_value], "deny": []}
    instruction = _retest_instruction(v, asset, target_value)
    context = {
        "task": {"target": target, "scope": scope, "instruction": instruction},
        "retest": {
            "source_vulnerability_id": str(v.id),
            "source_conversation_id": str(v.conversation_id),
            "asset_id": str(v.asset_id) if v.asset_id else None,
            "title": v.title,
            "severity": v.severity,
            "status_before_retest": current,
            "evidence_ids": v.evidence_ids or [],
            "goal": "若已不可复现，将状态推进为已修复；若仍可利用，保持/回退为待修复并补充证据。",
        },
    }
    conv = Conversation(
        id=uuid.uuid4(),
        user_id=user_id,
        title=f"复测: {v.title}"[:255],
        status="created",
        context=context,
    )
    db.add(conv)
    await db.flush()
    db.add(
        Message(
            id=uuid.uuid4(),
            conversation_id=conv.id,
            role="user",
            msg_type="text",
            content={"text": instruction, "retest": context["retest"]},
        )
    )
    await _audit(
        db,
        user_id,
        "vuln.retest",
        "vulnerability",
        v.id,
        conv.id,
        {"source_conversation_id": str(v.conversation_id), "target": target},
    )
    await db.commit()
    await db.refresh(conv)

    started = await _dispatch_retest_if_possible(str(conv.id), str(user_id), target, scope, instruction)
    return RetestOut(
        conversation_id=str(conv.id),
        started=started,
        target=target,
        scope=scope,
        instruction=instruction,
        message="复测已启动" if started else "复测会话已创建；当前无在线节点",
    )


@router.patch("/{vuln_id}", response_model=VulnOut)
async def update_vuln(
    vuln_id: str,
    body: dict,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user_id = uuid.UUID(current_user["user_id"])
    v = await _get(vuln_id, current_user, db)
    before_status = v.status
    if "status" in body:
        next_status = normalize_status(str(body["status"]))
        if next_status not in STATUSES:
            raise HTTPException(400, f"不支持的状态：{body['status']}")
        current = normalize_status(v.status)
        if next_status != current and next_status not in TRANSITIONS.get(current, set()):
            raise HTTPException(
                400,
                f"非法状态流转：{LIFECYCLE.get(current, current)} → {LIFECYCLE.get(next_status, next_status)}",
            )
        v.status = next_status
    for k in ("severity", "remediation", "description", "confidence"):
        if k in body:
            setattr(v, k, body[k])
    await _audit(
        db,
        user_id,
        "vulnerability.update",
        "vulnerability",
        v.id,
        v.conversation_id,
        {
            "fields": sorted(body.keys()),
            "before_status": before_status,
            "after_status": v.status,
        },
    )
    await db.commit()
    await db.refresh(v)
    asset = None
    if v.asset_id:
        assets = await _assets_by_id(db, user_id, [v.asset_id])
        asset = assets.get(v.asset_id)
    evidence = await _evidence_for(db, user_id, v.evidence_ids or [])
    return _out(v, asset=asset, evidence=evidence)


def normalize_status(value: object) -> str:
    raw = str(value or "").strip().lower()
    return LEGACY_STATUS_MAP.get(raw, raw if raw in STATUSES else "to_fix")


_VULN_RE = re.compile(
    r"(sql\s*injection|sqli|xss|cross[- ]site|rce|remote\s*code|command\s*injection|ssrf|lfi|rfi|xxe|ssti|idor|"
    r"path\s*traversal|file\s*upload|deserializ|unserializ|pop\s*chain|csrf|open\s*redirect|login\s*bypass|"
    r"privilege\s*escalat|vertical\s*privileg|injection|webshell|htaccess|eval\s*\(|cmd\.php|code\.php|"
    r"漏洞|注入|越权|反序列化|命令执行|代码执行|文件上传|目录穿越|未授权|绕过|权限提升|任意文件|XSS|SSRF|RCE)",
    re.I,
)
_AUTH_RE = re.compile(
    r"\b(api[_-]?key|access[_-]?key|secret[_-]?key|password|passwd|pwd|credential|jwt|bearer|session[_-]?id)\b"
    r"|密钥|口令|凭证|凭据",
    re.I,
)
_KEY_TITLE_RE = re.compile(
    r"(api\s*密钥|api[_ -]?key|access[_ -]?key|密钥泄露|密码泄露|凭证泄露|公开.*密钥|"
    r"hardcoded\s*(password|secret|key)|leaked\s*(password|secret|key|credential)|"
    r"exposed\s*(password|secret|key)|swagger.*密钥|密钥.*swagger)",
    re.I,
)
_PURE_FLAG_TITLE_RE = re.compile(
    r"^(?:(?:captured\s+)?flag\b|flag\{[^{}\n]{2,120}\}|FLAG\{[^{}\n]{2,120}\})\s*$",
    re.I,
)


def classify_finding_kind(v: Vulnerability) -> str:
    """Exclusive independent kinds: vuln | key | flag.

    - Vuln: attack-class finding (SQLi/XSS/…); may still contain flag{…} as proof.
    - Key: credential/secret object (PASSWORD / APIKEY / … family).
    - Flag: the flag artifact itself, not an exploit write-up that merely embeds flag{…}.
    """
    title = str(v.title or "").strip()
    blob = "\n".join(str(x or "") for x in (v.title, v.description, v.poc, v.remediation))
    vulnish = bool(_VULN_RE.search(blob))
    # Pure flag object
    if _PURE_FLAG_TITLE_RE.match(title):
        return "flag"
    if re.search(r"\bflag\b", title, re.I) and not vulnish and not _KEY_TITLE_RE.search(title):
        if re.search(r"flag\{", blob, re.I) or re.search(r"FLAG\{", blob):
            return "flag"
    # Pure key / secret object
    if _KEY_TITLE_RE.search(title) or (_AUTH_RE.search(blob) and not vulnish):
        return "key"
    if vulnish:
        return "vuln"
    return "vuln"


def _retest_target(v: Vulnerability, asset: Asset | None) -> str:
    if asset and asset.address:
        port = getattr(v, "port", None)
        addr = asset.address
        # Prefer URL when web port known.
        if port and str(port) not in {"80", "443"}:
            return f"http://{addr}:{port}"
        if port == "443":
            return f"https://{addr}"
        if port == "80":
            return f"http://{addr}"
        return addr
    poc = v.poc or ""
    for token in poc.split():
        if token.startswith(("http://", "https://")):
            return token.strip("'\"` ,")
    return ""


def _retest_instruction(v: Vulnerability, asset: Asset | None, target_value: str) -> str:
    asset_line = f"资产：{asset.address}" if asset else f"目标：{target_value}"
    if asset and getattr(v, "port", None):
        asset_line += f" · 端口 {v.port}"
    st = normalize_status(v.status)
    evidence = ", ".join(v.evidence_ids or []) or "无"
    return (
        "【复测任务】请验证下列问题是否仍可复现，并据此更新处理结论。\n"
        f"{asset_line}\n"
        f"标题：{v.title}\n"
        f"严重级别：{v.severity}\n"
        f"当前状态：{LIFECYCLE.get(st, st)}\n"
        f"原始复现/位置：{v.poc or '—'}\n"
        f"原始证据 ID：{evidence}\n"
        f"修复建议：{v.remediation or '—'}\n\n"
        "要求：\n"
        "1. 针对本问题做最小范围复测，不要扩大成全量评估。\n"
        "2. 若仍可利用：补充新证据，结论保持「待修复」。\n"
        "3. 若已不可复现/已修复：给出证据说明，建议将状态推进为「已修复」。\n"
        "4. 输出简明复测结论（仍存在 / 已修复 / 无法判定）。"
    )


async def _dispatch_retest_if_possible(
    conv_id: str, user_id: str, target: dict, scope: dict, instruction: str
) -> bool:
    try:
        from app.ws import router as ws_router

        node_ids = sorted(ws_router.node_connections.keys())
        if not node_ids:
            return False
        node_id = node_ids[0]
        snapshot = await ws_router._conversation_snapshot(conv_id, user_id)
        snapshot["checkpoint"] = {}
        task_msg = {
            "type": "task_assign",
            "conversation_id": conv_id,
            "task_id": str(uuid.uuid4()),
            "target": target,
            "scope": scope,
            "initial_instruction": instruction,
            "snapshot": snapshot,
        }
        await ws_router._bind_conversation_to_node(conv_id, node_id)
        await ws_router._incr_sessions(node_id, 1)
        await ws_router.node_connections[node_id].send_text(json.dumps(task_msg, ensure_ascii=False))
        return True
    except Exception as exc:
        print(f"[API] retest dispatch error: {exc}")
        return False


async def _get(vuln_id: str, current_user: dict, db: AsyncSession) -> Vulnerability:
    result = await db.execute(
        select(Vulnerability).where(
            Vulnerability.id == uuid.UUID(vuln_id),
            Vulnerability.user_id == uuid.UUID(current_user["user_id"]),
        )
    )
    v = result.scalar_one_or_none()
    if not v:
        raise HTTPException(404, "Vulnerability not found")
    return v


async def _assets_by_id(
    db: AsyncSession, user_id: uuid.UUID, asset_ids: list[uuid.UUID]
) -> dict[uuid.UUID, Asset]:
    if not asset_ids:
        return {}
    result = await db.execute(select(Asset).where(Asset.user_id == user_id, Asset.id.in_(asset_ids)))
    return {a.id: a for a in result.scalars().all()}


async def _evidence_for(db: AsyncSession, user_id: uuid.UUID, evidence_ids: list[str]) -> list[Evidence]:
    if not evidence_ids:
        return []
    result = await db.execute(
        select(Evidence)
        .where(
            Evidence.user_id == user_id,
            Evidence.evidence_id.in_(evidence_ids),
        )
        .order_by(Evidence.created_at.desc())
    )
    return list(result.scalars().all())


async def _audit(
    db: AsyncSession,
    user_id: uuid.UUID,
    action: str,
    resource_type: str,
    resource_id: uuid.UUID,
    conversation_id: uuid.UUID | None,
    detail: dict,
) -> None:
    db.add(
        AuditLog(
            actor_type="user",
            actor_id=user_id,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            conversation_id=conversation_id,
            detail=detail,
            status="success",
        )
    )


def _asset_out(a: Asset | None) -> AssetSummaryOut | None:
    if not a:
        return None
    return AssetSummaryOut(id=str(a.id), name=a.name, address=a.address, type=a.type)


def _evidence_out(e: Evidence) -> EvidenceOut:
    return EvidenceOut(
        id=str(e.id),
        evidence_id=e.evidence_id,
        type=e.type,
        source_tool=e.source_tool,
        tool_run_id=e.tool_run_id,
        raw_ref=e.raw_ref,
        summary=e.summary,
        hash=e.hash,
        properties=e.properties or {},
        created_at=e.created_at.isoformat() if e.created_at else None,
    )


def _status_timeline(v: Vulnerability) -> list[dict]:
    """Build discovery + lifecycle timeline for detail UI."""
    events: list[dict] = []
    history = getattr(v, "history", None)
    if isinstance(history, list) and history:
        for item in history:
            if not isinstance(item, dict):
                continue
            kind = str(item.get("event") or "discovered")
            label = {
                "discovered": "首次发现",
                "rediscovered": "再次发现",
            }.get(kind, kind)
            events.append(
                {
                    "status": kind,
                    "at": item.get("at"),
                    "label": label,
                    "conversation_id": item.get("conversation_id"),
                    "evidence_ids": item.get("evidence_ids") or [],
                }
            )
    else:
        first = getattr(v, "first_seen_at", None) or v.discovered_at
        if first:
            events.append(
                {
                    "status": "discovered",
                    "at": first.isoformat() if hasattr(first, "isoformat") else str(first),
                    "label": "首次发现",
                }
            )
        if (
            v.discovered_at
            and getattr(v, "first_seen_at", None)
            and v.discovered_at != v.first_seen_at
        ):
            events.append(
                {
                    "status": "rediscovered",
                    "at": v.discovered_at.isoformat(),
                    "label": "最近发现",
                }
            )
    st = normalize_status(v.status)
    events.append(
        {
            "status": st,
            "at": v.updated_at.isoformat() if v.updated_at else None,
            "label": f"当前状态：{LIFECYCLE.get(st, st)}",
        }
    )
    return events


def _out(
    v: Vulnerability,
    *,
    asset: Asset | None = None,
    evidence: list[Evidence] | None = None,
) -> VulnOut:
    st = normalize_status(v.status)
    kind = classify_finding_kind(v)
    return VulnOut(
        id=str(v.id),
        user_id=str(v.user_id) if v.user_id else None,
        conversation_id=str(v.conversation_id) if v.conversation_id else None,
        node_id=str(v.node_id) if v.node_id else None,
        title=v.title,
        severity=v.severity,
        cvss=v.cvss,
        cve_id=v.cve_id,
        asset_id=str(v.asset_id) if v.asset_id else None,
        port=str(v.port) if getattr(v, "port", None) else None,
        asset=_asset_out(asset),
        confidence=v.confidence,
        status=st,
        status_label=LIFECYCLE.get(st, st),
        kind=kind,
        description=v.description,
        poc=v.poc,
        remediation=v.remediation,
        evidence_ids=v.evidence_ids or [],
        evidence=[_evidence_out(e) for e in (evidence or [])],
        status_timeline=_status_timeline(v),
        allowed_next_statuses=sorted(TRANSITIONS.get(st, set())),
        discovered_at=v.discovered_at.isoformat() if v.discovered_at else None,
        updated_at=v.updated_at.isoformat() if v.updated_at else None,
    )
