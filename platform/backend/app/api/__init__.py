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
