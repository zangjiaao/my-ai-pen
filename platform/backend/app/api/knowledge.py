"""知识库搜索 API"""
from fastapi import APIRouter, Depends, Query
from app.middleware.auth import get_current_user

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])

BUILTIN_KNOWLEDGE = [
    {"source": "OWASP", "summary": "SQL 注入: 使用参数化查询防止。检测方法: 单引号测试、UNION SELECT、时间盲注。"},
    {"source": "OWASP", "summary": "XSS: 输出编码防止。检测方法: <script>alert(1)</script>、事件处理器注入。"},
    {"source": "OWASP", "summary": "SSRF: 校验URL白名单。检测方法: 尝试访问 169.254.169.254、127.0.0.1。"},
    {"source": "PortSwigger", "summary": "HTTP请求走私: CL.TE/TE.CL 攻击。使用 HTTP/1.1 和 HTTP/2 降级检测。"},
    {"source": "CVE", "summary": "CVE-2021-44228 (Log4Shell): JNDI注入，影响Log4j 2.0-2.14.1。修复: 升级到2.16+。"},
]


@router.get("/search")
async def search(q: str = Query(...), limit: int = Query(5),
                 current_user: dict = Depends(get_current_user)):
    q_lower = q.lower()
    results = [k for k in BUILTIN_KNOWLEDGE if q_lower in k["summary"].lower()]
    return results[:limit]
