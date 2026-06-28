"""记忆管理 API"""
import uuid
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from app.middleware.auth import get_current_user

router = APIRouter(prefix="/api/memories", tags=["memories"])

# MVP: in-memory storage (V2 migrates to PG)
_memories: list[dict] = []


class MemoryCreate(BaseModel):
    type: str = "general"
    content: str
    scope: str = "personal"


@router.get("")
async def list_memories(current_user: dict = Depends(get_current_user)):
    user_id = current_user["user_id"]
    return [m for m in _memories if m["scope"] == "global" or m["user_id"] == user_id]


@router.post("")
async def create_memory(body: MemoryCreate, current_user: dict = Depends(get_current_user)):
    m = {"id": str(uuid.uuid4()), "user_id": current_user["user_id"], "type": body.type, "content": body.content, "scope": body.scope}
    _memories.append(m)
    return m


@router.delete("/{memory_id}")
async def delete_memory(memory_id: str, current_user: dict = Depends(get_current_user)):
    global _memories
    _memories = [m for m in _memories if m["id"] != memory_id]
    return {"ok": True}
