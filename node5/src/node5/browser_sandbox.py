"""Browser assist for Node5 — pen-sandbox first (same image as shell).

Default: Docker pen-sandbox agent-browser only.
Host agent-browser only when NODE5_ALLOW_HOST_TOOLS=1.

CRITICAL: agent-browser keeps page state only within one process lifetime.
Each `docker run --rm` is a fresh Chromium. Multi-step flows (open → wait →
text/eval) MUST run as a single shell-chained session, not separate containers.
"""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
from typing import Any
from urllib.parse import urlparse

from node5.sandbox_exec import (
    allow_host_tools,
    docker_bin,
    resolve_sandbox_image,
    rewrite_url_for_sandbox,
    sandbox_health,
    sandbox_network,
)


def browser_mode() -> str:
    """0 | 1 | auto — 0 disables browser tool entirely."""
    return (os.environ.get("NODE5_BROWSER") or "auto").strip().lower()


def pen_sandbox_image() -> str:
    return resolve_sandbox_image()


def agent_browser_bin() -> str:
    return (
        os.environ.get("NODE5_AGENT_BROWSER_BIN")
        or os.environ.get("NODE4_AGENT_BROWSER_BIN")
        or os.environ.get("AGENT_BROWSER_BIN")
        or "agent-browser"
    )


def spa_settle_ms() -> int:
    """Post-load wait for SPA bootstrap (Angular etc.). Avoid networkidle — WS apps hang."""
    try:
        return max(0, int(os.environ.get("NODE5_BROWSER_SPA_WAIT_MS") or "3000"))
    except ValueError:
        return 3000


def browser_available() -> bool:
    mode = browser_mode()
    if mode in ("0", "off", "false", "no"):
        return False
    # Prefer cached health with browser probe when possible
    h = sandbox_health(probe_browser=True)
    if h.browser_ok:
        return True
    if h.docker and h.image_present:
        # image present but agent-browser may still fail — still attempt ops
        return True
    if allow_host_tools() and shutil.which(agent_browser_bin()):
        return True
    return False


def _host_allowed(target: str, url: str) -> bool:
    try:
        t = urlparse(target if "://" in target else "http://" + target)
        u = urlparse(url if "://" in url else "http://" + url)
        return bool(u.hostname) and u.hostname == t.hostname
    except Exception:
        return False


def _spa_settle_steps() -> list[list[str]]:
    """Load + fixed settle + app mount. Avoid networkidle (socket.io SPAs hang)."""
    steps: list[list[str]] = [["wait", "--load", "domcontentloaded"]]
    ms = spa_settle_ms()
    # Half wait, then wait for SPA root/body content, then remaining settle
    half = max(500, ms // 2) if ms else 1500
    if half:
        steps.append(["wait", str(half)])
    # Angular/Vue/React roots or meaningful body text
    steps.append(
        [
            "wait",
            "--fn",
            (
                "!!(document.querySelector('app-root')||document.querySelector('#root')"
                "||document.querySelector('#app'))"
                "||((document.body&&document.body.innerText||'').length>80)"
            ),
        ]
    )
    rest = max(500, ms - half) if ms else 1500
    steps.append(["wait", str(rest)])
    return steps


def _build_session_steps(
    *,
    op: str,
    open_url: str,
    selector: str,
    text: str,
    script: str,
) -> list[list[str]] | None:
    """Return agent-browser arg lists for one in-process session, or None if invalid."""
    op = (op or "").strip().lower()

    # Composites: always open + SPA settle + extract (one Chromium lifetime)
    if op in ("open_text", "open_spa", "open_eval"):
        steps: list[list[str]] = [["open", open_url], *_spa_settle_steps()]
        if op == "open_eval" or (op == "open_spa" and script):
            steps.append(
                [
                    "eval",
                    (script or "document.documentElement.innerHTML.slice(0,2000)")[:500],
                ]
            )
        else:
            steps.append(["get", "text"])
        return steps

    if op == "open":
        return [["open", open_url], *_spa_settle_steps()]

    # text/eval/snapshot with URL: auto open+settle so agent multi-call works
    if op in ("text", "snapshot", "eval", "storage") and open_url:
        steps = [["open", open_url], *_spa_settle_steps()]
        if op in ("text", "snapshot"):
            steps.append(["snapshot" if op == "snapshot" else "get", "text"])
        elif op == "storage":
            steps.append(["eval", "JSON.stringify(localStorage)"])
        else:
            steps.append(
                [
                    "eval",
                    (script or "document.documentElement.innerHTML.slice(0,2000)")[:500],
                ]
            )
        return steps

    if op == "wait":
        # selector OR milliseconds in text
        if selector:
            return [["wait", selector]]
        if text and text.isdigit():
            return [["wait", text]]
        return [["wait", str(spa_settle_ms() or 2000)]]

    if op == "click" and selector:
        # Need page — require URL for single-session open+click
        if not open_url:
            return None
        return [["open", open_url], *_spa_settle_steps(), ["click", selector]]

    if op == "fill" and selector:
        if not open_url:
            return None
        return [
            ["open", open_url],
            *_spa_settle_steps(),
            ["fill", selector, text],
        ]

    # Bare text/eval without URL cannot work across docker runs
    if op in ("text", "snapshot", "eval", "storage"):
        return None

    return None


def _session_shell(steps: list[list[str]], ab_bin: str = "agent-browser") -> str:
    parts = []
    for args in steps:
        parts.append(shlex.join([ab_bin, *args]))
    # close best-effort so daemon does not leak inside container
    parts.append(shlex.join([ab_bin, "close", "--all"]) + " 2>/dev/null || true")
    return " && ".join(parts[:-1]) + "; " + parts[-1]


def _run_session(
    steps: list[list[str]],
    *,
    timeout_ms: int,
) -> dict[str, Any]:
    """Execute multi-step agent-browser in ONE process/container."""
    health = sandbox_health(probe_browser=False)
    # settle + open can need longer wall clock
    settle = spa_settle_ms()
    wall = max(15, (timeout_ms + settle) // 1000 + 15)

    if health.docker and health.image_present:
        image = health.image
        net = sandbox_network()
        script = _session_shell(steps, ab_bin="agent-browser")
        dargs = [
            docker_bin(),
            "run",
            "--rm",
            "--network",
            net,
            "--entrypoint",
            "sh",
        ]
        if net != "host":
            dargs += ["--add-host", "host.docker.internal:host-gateway"]
        dargs += [image, "-c", script]
        try:
            proc = subprocess.run(
                dargs,
                capture_output=True,
                text=True,
                timeout=wall,
            )
            out = ((proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")).strip()
            return {
                "ok": proc.returncode == 0,
                "exit": proc.returncode,
                "output": out[:12000],
                "via": f"sandbox:{image}",
                "session_steps": len(steps),
                "error": "" if proc.returncode == 0 else out[:400],
            }
        except Exception as e:
            if not allow_host_tools():
                return {
                    "ok": False,
                    "error": f"sandbox browser failed: {type(e).__name__}: {e}",
                    "via": "sandbox",
                }
            # fall through to host

    if allow_host_tools() and shutil.which(agent_browser_bin()):
        ab = agent_browser_bin()
        script = _session_shell(steps, ab_bin=ab)
        try:
            proc = subprocess.run(
                ["sh", "-c", script],
                capture_output=True,
                text=True,
                timeout=wall,
            )
            out = ((proc.stdout or "") + ("\n" + proc.stderr if proc.stderr else "")).strip()
            return {
                "ok": proc.returncode == 0,
                "exit": proc.returncode,
                "output": out[:12000],
                "via": "host",
                "session_steps": len(steps),
                "error": "" if proc.returncode == 0 else out[:400],
            }
        except Exception as e:
            return {"ok": False, "error": f"{type(e).__name__}: {e}", "via": "host"}

    return {
        "ok": False,
        "error": (
            health.browser_error
            or health.error
            or "browser sandbox unavailable: build pen-sandbox and set PEN_SANDBOX_IMAGE, "
            "or NODE5_ALLOW_HOST_TOOLS=1 with agent-browser on PATH"
        ),
        "via": "none",
    }


def run_browser_op(
    *,
    target: str,
    op: str,
    url: str = "",
    selector: str = "",
    text: str = "",
    script: str = "",
    timeout_ms: int = 45000,
) -> dict[str, Any]:
    """Run agent-browser operations inside pen-sandbox (default).

    Prefer open_text / open_eval / open_spa — single Chromium session with SPA settle.
    For text|eval|snapshot, pass url so open+settle happens in the same session.
    """
    if browser_mode() in ("0", "off", "false", "no"):
        return {"ok": False, "error": "NODE5_BROWSER disabled"}

    op_l = (op or "").strip().lower()
    open_url = url or target
    # Scope check when navigating
    if open_url and op_l in (
        "open",
        "open_text",
        "open_eval",
        "open_spa",
        "text",
        "eval",
        "snapshot",
        "storage",
        "click",
        "fill",
    ):
        if not _host_allowed(target, open_url):
            return {"ok": False, "error": f"url host not in target scope ({target})"}

    open_url = rewrite_url_for_sandbox(open_url) if open_url else open_url

    steps = _build_session_steps(
        op=op_l,
        open_url=open_url,
        selector=selector,
        text=text,
        script=script,
    )
    if steps is None:
        return {
            "ok": False,
            "error": (
                f"unsupported op or missing args: {op_l}. "
                "Use open_text/open_eval/open_spa, or pass url= with text|eval|snapshot "
                "(each docker run is a fresh browser — multi-call open then eval will not work)."
            ),
        }

    result = _run_session(steps, timeout_ms=timeout_ms)
    result["composite"] = op_l if op_l.startswith("open_") else ""
    result["op"] = op_l
    return result
