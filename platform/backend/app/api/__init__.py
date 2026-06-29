from fastapi import APIRouter
from app.api.auth import router as auth_router
from app.api.conversations import router as conversations_router
from app.api.nodes import router as nodes_router

api_router = APIRouter()
api_router.include_router(auth_router)
api_router.include_router(conversations_router)
api_router.include_router(nodes_router)
from app.api.audit import router as audit_router
api_router.include_router(audit_router)
from app.api.assets import router as assets_router
api_router.include_router(assets_router)
from app.api.vulnerabilities import router as vulns_router
api_router.include_router(vulns_router)
from app.api.sync import router as sync_router
api_router.include_router(sync_router)
from app.api.knowledge import router as knowledge_router
api_router.include_router(knowledge_router)
from app.api.memories import router as memories_router
api_router.include_router(memories_router)
from app.api.skills_api import router as skills_api_router
api_router.include_router(skills_api_router)

from app.api.evidence import router as evidence_router
api_router.include_router(evidence_router)
