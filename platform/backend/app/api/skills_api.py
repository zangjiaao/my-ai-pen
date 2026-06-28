"""Skill 管理 API"""
from fastapi import APIRouter, Depends, HTTPException
from app.middleware.auth import get_current_user

router = APIRouter(prefix="/api/skills", tags=["skills"])

SKILLS = [
    {"name":"web_baseline","description":"Web 应用基线测试","phase":"recon","tools":["execute","http_request","browser","create_candidate_finding","confirm_finding","report_asset"]},
    {"name":"network_baseline","description":"主机/内网渗透基线","phase":"recon","tools":["execute","http_request","create_candidate_finding","confirm_finding","report_asset"]},
    {"name":"sql_injection","description":"SQL 注入检测与验证","phase":"scan","tools":["execute","http_request","browser","create_candidate_finding","confirm_finding","reject_finding","request_approval"]},
    {"name":"xss","description":"跨站脚本检测","phase":"scan","tools":["execute","http_request","browser","create_candidate_finding","confirm_finding","reject_finding"]},
    {"name":"auth_test","description":"认证与授权测试","phase":"scan","tools":["execute","http_request","browser","create_candidate_finding","confirm_finding","reject_finding","request_approval"]},
    {"name":"ssrf","description":"SSRF 检测","phase":"scan","tools":["execute","http_request","create_candidate_finding","confirm_finding","reject_finding"]},
    {"name":"idor","description":"越权访问专项测试","phase":"scan","tools":["execute","http_request","browser","create_candidate_finding","confirm_finding","reject_finding"]},
    {"name":"file_upload","description":"文件上传漏洞检测","phase":"scan","tools":["execute","http_request","browser","create_candidate_finding","confirm_finding","reject_finding","request_approval"]},
    {"name":"api_test","description":"API 安全测试","phase":"scan","tools":["execute","http_request","browser","create_candidate_finding","confirm_finding","reject_finding"]},
    {"name":"ssti","description":"服务端模板注入检测","phase":"scan","tools":["execute","http_request","create_candidate_finding","confirm_finding","reject_finding","request_approval"]},
]

_custom_skills: list[dict] = []


@router.get("")
async def list_skills(current_user: dict = Depends(get_current_user)):
    return SKILLS + _custom_skills


@router.get("/{name}")
async def get_skill(name: str, current_user: dict = Depends(get_current_user)):
    for s in SKILLS + _custom_skills:
        if s["name"] == name: return s
    raise HTTPException(404, "Skill not found")


@router.post("")
async def upload_skill(body: dict, current_user: dict = Depends(get_current_user)):
    body["custom"] = True
    _custom_skills.append(body)
    return {"ok": True, "name": body["name"]}


@router.patch("/{name}")
async def toggle_skill(name: str, body: dict, current_user: dict = Depends(get_current_user)):
    for s in _custom_skills:
        if s["name"] == name:
            s["enabled"] = body.get("enabled", True)
            return {"ok": True}
    raise HTTPException(404, "Skill not found")


@router.delete("/{name}")
async def delete_skill(name: str, current_user: dict = Depends(get_current_user)):
    global _custom_skills
    _custom_skills = [s for s in _custom_skills if s["name"] != name]
    return {"ok": True}
