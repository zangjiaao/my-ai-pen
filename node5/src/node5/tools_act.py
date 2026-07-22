"""Act tools with shared / multi-actor CookieJar (State Handoff)."""

from __future__ import annotations

import re
import threading
from typing import Any
from urllib.parse import urlparse


class CookieJar:
    """Thread-safe cookie bags: default shared + optional named actors (P0.2)."""

    def __init__(
        self,
        initial: dict[str, str] | None = None,
        actor_cookies: dict[str, dict[str, str]] | None = None,
    ) -> None:
        self._lock = threading.Lock()
        self._cookies: dict[str, str] = dict(initial or {})
        self._actors: dict[str, dict[str, str]] = {
            str(k): dict(v) for k, v in (actor_cookies or {}).items()
        }

    def snapshot(self) -> dict[str, str]:
        with self._lock:
            return dict(self._cookies)

    def snapshot_actors(self) -> dict[str, dict[str, str]]:
        with self._lock:
            return {k: dict(v) for k, v in self._actors.items()}

    def merge(self, updates: dict[str, str], actor: str = "") -> None:
        if not updates:
            return
        with self._lock:
            if actor:
                bag = self._actors.setdefault(str(actor), {})
                bag.update({str(k): str(v) for k, v in updates.items() if k})
            else:
                self._cookies.update({str(k): str(v) for k, v in updates.items() if k})

    def header_value(self, actor: str = "") -> str:
        with self._lock:
            if actor and actor in self._actors and self._actors[actor]:
                bag = self._actors[actor]
            else:
                bag = self._cookies
            return "; ".join(f"{k}={v}" for k, v in bag.items())

    def auth_bearer(self, actor: str = "") -> str | None:
        """Prefer token/cookie named token/jwt/access_token for Authorization."""
        with self._lock:
            bag = (
                self._actors.get(actor) or self._cookies
                if actor
                else self._cookies
            )
            for key in ("token", "jwt", "access_token", "Authorization"):
                if key in bag and bag[key]:
                    val = bag[key]
                    if key.lower() == "authorization":
                        return val if val.lower().startswith("bearer") else f"Bearer {val}"
                    return f"Bearer {val}"
        return None

    def absorb_set_cookie(
        self, set_cookie_headers: list[str] | str | None, actor: str = ""
    ) -> None:
        if not set_cookie_headers:
            return
        if isinstance(set_cookie_headers, str):
            set_cookie_headers = [set_cookie_headers]
        with self._lock:
            bag = self._actors.setdefault(str(actor), {}) if actor else self._cookies
            for raw in set_cookie_headers:
                part = (raw or "").split(";", 1)[0].strip()
                if "=" not in part:
                    continue
                name, val = part.split("=", 1)
                name, val = name.strip(), val.strip()
                if name:
                    bag[name] = val
                    if not actor:
                        self._cookies[name] = val


def _host_allowed(target: str, url_or_host: str) -> bool:
    try:
        t = urlparse(target if "://" in target else f"http://{target}")
        u = urlparse(url_or_host if "://" in url_or_host else f"http://{url_or_host}")
        th = (t.hostname or "").lower()
        uh = (u.hostname or "").lower()
        if not th or not uh:
            return True
        return uh == th or uh.endswith("." + th)
    except Exception:
        return False


def make_tools(
    target: str,
    jar: CookieJar | None = None,
    max_chars: int = 12000,
    tool_counter: list[int] | None = None,
    pack_root: str | None = None,
) -> list[Any]:
    """Return callables ADK wraps as FunctionTools."""
    from pathlib import Path

    from node5.knowledge import (
        format_list_result,
        format_query_result,
        list_refs,
        query_refs,
        read_ref,
    )

    jar = jar or CookieJar()
    counter = tool_counter if tool_counter is not None else [0]
    pack = Path(pack_root) if pack_root else None

    def _count() -> None:
        counter[0] += 1

    def _pack() -> Path | None:
        return pack if pack and pack.is_dir() else None

    def shell(command: str) -> str:
        """Run a short shell command in pen-sandbox (default). Prefer http_request for HTTP.

        Host execution only when NODE5_ALLOW_HOST_TOOLS=1 or NODE5_SANDBOX=0.
        """
        from node5.sandbox_exec import run_in_sandbox

        _count()
        cmd = (command or "").strip()
        if not cmd:
            return "error: empty command"
        lowered = cmd.lower()
        for ban in ("rm -rf /", "mkfs", ":(){", "dd if=/dev/zero"):
            if ban in lowered:
                return f"error: blocked dangerous pattern ({ban})"
        cookie_hdr = jar.header_value()
        if cookie_hdr and "curl" in lowered and "-b " not in cmd and "--cookie" not in cmd:
            if not re.search(r"-H\s+['\"]Cookie:", cmd, re.I):
                cmd = cmd.replace("curl ", f"curl -b '{cookie_hdr}' ", 1)
        result = run_in_sandbox(cmd, timeout=60)
        if result.error and result.via == "error":
            return f"error: {result.error}"
        out = (result.stdout or "") + (
            ("\n" + result.stderr) if result.stderr else ""
        )
        out = out.strip() or f"(exit {result.exit_code}, empty output)"
        if len(out) > max_chars:
            out = out[:max_chars] + "\n…[truncated]…"
        return out + f"\n[via={result.via}]"

    def http_request(
        method: str = "GET",
        url: str = "",
        body: str = "",
        headers_json: str = "",
        actor: str = "",
    ) -> str:
        """HTTP request against authorized target (default: inside pen-sandbox).

        actor: optional identity id (actor_a, actor_b, anon) for multi-jar cookies/token.
        headers_json: JSON object string, or a dict if the model passes an object.
        """
        import json

        from node5.sandbox_exec import http_via_sandbox

        _count()
        u = (url or target).strip() if isinstance(url, str) else str(url or target)
        if not u:
            return "error: empty url"
        if not _host_allowed(target, u):
            return f"error: url host not in target scope ({target})"
        headers: dict[str, str] = {}
        hj = headers_json
        if isinstance(hj, dict):
            headers = {str(k): str(v) for k, v in hj.items()}
        elif isinstance(hj, str) and hj.strip():
            try:
                parsed = json.loads(hj)
                if isinstance(parsed, dict):
                    headers = {str(k): str(v) for k, v in parsed.items()}
            except json.JSONDecodeError as e:
                return f"error: headers_json: {e}"
        act = (actor or "").strip()
        cookie_hdr = jar.header_value(act)
        if cookie_hdr and "Cookie" not in headers and "cookie" not in {k.lower() for k in headers}:
            headers["Cookie"] = cookie_hdr
        if "Authorization" not in headers and "authorization" not in {
            k.lower() for k in headers
        }:
            bearer = jar.auth_bearer(act)
            if bearer:
                headers["Authorization"] = bearer
        raw = http_via_sandbox(
            method=method.upper() or "GET",
            url=u,
            headers=headers,
            body=body or "",
            timeout=30,
            max_chars=max_chars,
        )
        # Absorb Set-Cookie from response text when present (best-effort)
        if raw.startswith("HTTP ") and "set-cookie:" in raw.lower():
            for line in raw.splitlines()[:50]:
                if line.lower().startswith("set-cookie:"):
                    jar.absorb_set_cookie(line.split(":", 1)[1].strip(), actor=act)
        who = f" actor={act}" if act else ""
        if who and raw.startswith("HTTP "):
            # insert actor after status line
            lines = raw.split("\n", 1)
            if lines:
                lines[0] = lines[0] + who
                raw = "\n".join(lines)
        return raw

    def actor_set_token(actor: str, token: str, cookie_name: str = "token") -> str:
        """Store a session/JWT for a named actor (State Handoff multi-jar)."""
        _count()
        aid = (actor or "").strip()
        if not aid:
            return "error: empty actor"
        tok = (token or "").strip()
        if not tok:
            return "error: empty token"
        name = (cookie_name or "token").strip() or "token"
        jar.merge({name: tok}, actor=aid)
        # Also mirror into default jar if first token
        if not jar.snapshot():
            jar.merge({name: tok})
        return f"ok: actor={aid} stored {name} (len={len(tok)})"

    def ref_list(kind: str = "all") -> str:
        """List tactical knowledge cards under pack refs/ (payloads|components|chains|all)."""
        _count()
        p = _pack()
        if not p:
            return "error: pack_root not configured for refs"
        try:
            return format_list_result(list_refs(p, kind=kind or "all"))
        except Exception as e:
            return f"error: {type(e).__name__}: {e}"

    def ref_query(query: str, kind: str = "all", limit: int = 5) -> str:
        """Search tactical refs by fingerprint or attack-class keywords."""
        _count()
        p = _pack()
        if not p:
            return "error: pack_root not configured for refs"
        try:
            hits = query_refs(p, query=query or "", kind=kind or "all", limit=limit)
            return format_query_result(hits)
        except Exception as e:
            return f"error: {type(e).__name__}: {e}"

    def ref_read(path: str) -> str:
        """Read one ref card body (path under refs/, e.g. components/fastjson.md)."""
        _count()
        p = _pack()
        if not p:
            return "error: pack_root not configured for refs"
        try:
            return read_ref(p, path or "", max_chars=max(2000, max_chars // 2))
        except Exception as e:
            return f"error: {type(e).__name__}: {e}"

    def browser(
        op: str = "open",
        url: str = "",
        selector: str = "",
        text: str = "",
        script: str = "",
    ) -> str:
        """Browser assist via pen-sandbox agent-browser (DOM/SPA).

        op: open | text | snapshot | click | fill | eval | storage | wait
            | open_text | open_eval | open_spa  (preferred — one Chromium session)
        Each call is a fresh browser in Docker. open then eval as TWO calls loses state.
        Prefer open_eval/open_text/open_spa with url= (includes SPA settle wait).
        For text|eval|snapshot always pass url= so open+wait runs in the same session.
        Only target host is in scope. Soft-fails if browser unavailable.
        """
        import json

        _count()
        from node5.browser_sandbox import run_browser_op

        result = run_browser_op(
            target=target,
            op=op,
            url=url or target,
            selector=selector,
            text=text,
            script=script,
        )
        return json.dumps(result, ensure_ascii=False)[:max_chars]

    return [shell, http_request, actor_set_token, ref_list, ref_query, ref_read, browser]
