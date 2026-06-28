"""离线报告导入"""
import json
import tarfile
import uuid
import tempfile
from fastapi import APIRouter, Depends, UploadFile, File
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.base import get_db
from app.middleware.auth import get_current_user
from app.models.asset import Asset
from app.models.vulnerability import Vulnerability
from app.models.conversation import Conversation

router = APIRouter(prefix="/api/sync", tags=["sync"])


@router.post("/import")
async def import_report(file: UploadFile = File(...),
                        current_user: dict = Depends(get_current_user),
                        db: AsyncSession = Depends(get_db)):
    """接收 Node 导出的 report.tar.gz，导入资产和漏洞"""
    conv = Conversation(id=uuid.uuid4(), user_id=uuid.UUID(current_user["user_id"]), title="离线导入")
    db.add(conv)
    await db.flush()

    assets_imported = 0
    vulns_imported = 0

    with tempfile.NamedTemporaryFile(suffix=".tar.gz", delete=False) as tmp:
        tmp.write(await file.read())
        tmp_path = tmp.name

    try:
        with tarfile.open(tmp_path, "r:gz") as tar:
            for member in tar.getmembers():
                if member.name == "summary.json":
                    continue
                if member.name.startswith("session-") and member.name.endswith(".json"):
                    content = json.loads(tar.extractfile(member).read())
                    if "assets" in content:
                        for a in content["assets"]:
                            asset = Asset(id=uuid.uuid4(), name=a.get("name", "unknown"),
                                          address=a.get("address", ""), type=a.get("type", "host"),
                                          source="agent_discovered")
                            db.add(asset)
                            assets_imported += 1
                    if "vulnerabilities" in content:
                        for v in content["vulnerabilities"]:
                            vuln = Vulnerability(id=uuid.uuid4(), title=v.get("title", ""),
                                                  severity=v.get("severity", "info"),
                                                  conversation_id=conv.id,
                                                  description=v.get("description", ""),
                                                  poc=v.get("poc", ""),
                                                  remediation=v.get("remediation", ""),
                                                  status="confirmed")
                            db.add(vuln)
                            vulns_imported += 1
    finally:
        import os; os.unlink(tmp_path)

    await db.commit()
    return {"conversation_id": str(conv.id), "assets_imported": assets_imported, "vulns_imported": vulns_imported}
