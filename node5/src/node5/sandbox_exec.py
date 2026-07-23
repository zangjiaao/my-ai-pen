"""Unified pen-sandbox execution for Node5 act tools (shell / http / browser).

Policy (default):
  - Act tools run inside Docker pen-sandbox image.
  - Host fallback only when NODE5_ALLOW_HOST_TOOLS=1 (or NODE5_SANDBOX=0/host).
  - Knowledge ref_* stays on host (read-only pack).

Aligns with Node4 pen-tools-shell / pen-sandbox family.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse, urlunparse


def docker_bin() -> str:
    return (
        os.environ.get("NODE5_DOCKER_BIN")
        or os.environ.get("NODE4_DOCKER_BIN")
        or "docker"
    ).strip() or "docker"


def resolve_sandbox_image() -> str:
    return (
        os.environ.get("NODE5_PEN_SANDBOX_IMAGE")
        or os.environ.get("PEN_SANDBOX_IMAGE")
        or os.environ.get("NODE4_BROWSER_SANDBOX_IMAGE")
        or os.environ.get("PEN_TOOLS_IMAGE")
        or "pen-sandbox:dev"
    ).strip()


def sandbox_mode() -> str:
    """1|auto|0|host — default 1 (force sandbox)."""
    return (os.environ.get("NODE5_SANDBOX") or "1").strip().lower()


def allow_host_tools() -> bool:
    if sandbox_mode() in ("0", "false", "off", "no", "host"):
        return True
    raw = (os.environ.get("NODE5_ALLOW_HOST_TOOLS") or "").strip().lower()
    return raw in ("1", "true", "yes", "on")


def sandbox_network() -> str:
    """Default host so lab targets on 127.0.0.1 work from container."""
    return (
        os.environ.get("NODE5_SANDBOX_NETWORK")
        or os.environ.get("PEN_TOOLS_NETWORK")
        or "host"
    ).strip() or "host"


def rewrite_url_for_sandbox(value: str) -> str:
    """Rewrite localhost → host.docker.internal when not using host network."""
    if sandbox_network() == "host":
        return value
    if not re.match(r"^https?://", value or "", re.I):
        return value
    try:
        u = urlparse(value)
        if (u.hostname or "").lower() in ("localhost", "127.0.0.1", "::1"):
            host = "host.docker.internal"
            netloc = host
            if u.port:
                netloc = f"{host}:{u.port}"
            return urlunparse((u.scheme, netloc, u.path, u.params, u.query, u.fragment))
    except Exception:
        pass
    return value


def docker_image_exists(image: str) -> bool:
    if not image or not shutil.which(docker_bin()):
        return False
    try:
        proc = subprocess.run(
            [docker_bin(), "image", "inspect", image],
            capture_output=True,
            text=True,
            timeout=15,
        )
        return proc.returncode == 0
    except Exception:
        return False


@dataclass
class SandboxHealth:
    ok: bool
    docker: bool
    image: str
    image_present: bool
    mode: str
    allow_host: bool
    network: str
    error: str = ""
    browser_ok: bool = False
    browser_error: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "docker": self.docker,
            "image": self.image,
            "image_present": self.image_present,
            "mode": self.mode,
            "allow_host": self.allow_host,
            "network": self.network,
            "error": self.error,
            "browser_ok": self.browser_ok,
            "browser_error": self.browser_error,
        }


def probe_browser_in_sandbox(image: str | None = None, timeout: int = 25) -> tuple[bool, str]:
    """Best-effort: agent-browser --help|version inside pen-sandbox."""
    if not shutil.which(docker_bin()):
        return False, "docker not found"
    img = image or resolve_sandbox_image()
    if not docker_image_exists(img):
        return False, f"image missing: {img}"
    # --help is enough to prove binary exists; full chrome launch is heavier
    args = [
        docker_bin(),
        "run",
        "--rm",
        "--network",
        sandbox_network(),
        "--entrypoint",
        "agent-browser",
        img,
        "--help",
    ]
    try:
        proc = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout
        )
        out = ((proc.stdout or "") + (proc.stderr or "")).strip()
        if proc.returncode == 0 or "usage" in out.lower() or "agent-browser" in out.lower():
            return True, ""
        return False, (out or f"exit {proc.returncode}")[:300]
    except subprocess.TimeoutExpired:
        return False, "agent-browser probe timed out"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


def sandbox_health(*, probe_browser: bool = True) -> SandboxHealth:
    mode = sandbox_mode()
    image = resolve_sandbox_image()
    allow = allow_host_tools()
    docker_ok = bool(shutil.which(docker_bin()))
    present = docker_image_exists(image) if docker_ok else False
    err = ""
    if mode in ("0", "host", "false", "off") or allow:
        # host allowed — health ok for tooling purposes even without image
        ok = True
        if not docker_ok and not allow:
            ok = False
            err = "docker not found"
    else:
        if not docker_ok:
            ok = False
            err = f"docker not found ({docker_bin()}); set NODE5_ALLOW_HOST_TOOLS=1 for lab host tools"
        elif not present:
            ok = False
            err = (
                f"sandbox image missing: {image}. "
                "Build: bash sandbox/pen-sandbox/scripts/build.sh "
                "or set PEN_SANDBOX_IMAGE. Or NODE5_ALLOW_HOST_TOOLS=1 for explicit host."
            )
        else:
            ok = True

    browser_ok = False
    browser_err = ""
    if probe_browser and present and docker_ok:
        # Skip expensive probe when NODE5_BROWSER_PROBE=0
        if (os.environ.get("NODE5_BROWSER_PROBE") or "1").strip().lower() not in (
            "0",
            "false",
            "off",
            "no",
        ):
            browser_ok, browser_err = probe_browser_in_sandbox(image)
        else:
            browser_err = "probe skipped (NODE5_BROWSER_PROBE=0)"
    elif allow and shutil.which(
        os.environ.get("NODE5_AGENT_BROWSER_BIN")
        or os.environ.get("AGENT_BROWSER_BIN")
        or "agent-browser"
    ):
        browser_ok = True
    elif not present:
        browser_err = "no sandbox image for browser"

    return SandboxHealth(
        ok=ok,
        docker=docker_ok,
        image=image,
        image_present=present,
        mode=mode,
        allow_host=allow,
        network=sandbox_network(),
        error=err,
        browser_ok=browser_ok,
        browser_error=browser_err,
    )


def must_use_sandbox() -> bool:
    """True when act tools must not fall back to host."""
    return not allow_host_tools()


@dataclass
class SandboxRunResult:
    exit_code: int | None
    stdout: str
    stderr: str
    via: str  # sandbox | host | error
    error: str = ""
    timed_out: bool = False

    @property
    def ok(self) -> bool:
        return not self.error and self.via in ("sandbox", "host") and (
            self.exit_code == 0 or self.exit_code is not None
        )


def run_in_sandbox(
    command: str,
    *,
    timeout: int = 60,
    work_dir: str | None = None,
    network: str | None = None,
) -> SandboxRunResult:
    """Run bash -lc <command> inside pen-sandbox (or host if allowed)."""
    cmd = (command or "").strip()
    if not cmd:
        return SandboxRunResult(1, "", "", "error", error="empty command")

    health = sandbox_health()
    use_host = allow_host_tools() and (
        not health.docker or not health.image_present or sandbox_mode() in ("0", "host")
    )

    if must_use_sandbox() and (not health.docker or not health.image_present):
        return SandboxRunResult(
            None,
            "",
            "",
            "error",
            error=health.error or "sandbox unavailable",
        )

    if use_host and allow_host_tools():
        return _run_host(cmd, timeout=timeout)

    if not health.docker or not health.image_present:
        return SandboxRunResult(
            None,
            "",
            "",
            "error",
            error=health.error or "sandbox unavailable",
        )

    image = health.image
    net = network or health.network
    args = [
        docker_bin(),
        "run",
        "--rm",
        "--network",
        net,
        "--entrypoint",
        "bash",
    ]
    if work_dir and os.path.isdir(work_dir):
        args += ["-v", f"{os.path.abspath(work_dir)}:/workspace:rw", "-w", "/workspace"]
    # Linux: host.docker.internal for bridge network
    if net != "host":
        args += ["--add-host", "host.docker.internal:host-gateway"]
    args += [image, "-lc", cmd]

    try:
        proc = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=max(5, timeout),
        )
        return SandboxRunResult(
            exit_code=proc.returncode,
            stdout=proc.stdout or "",
            stderr=proc.stderr or "",
            via="sandbox",
        )
    except subprocess.TimeoutExpired:
        return SandboxRunResult(
            None, "", "", "error", error=f"sandbox command timed out ({timeout}s)", timed_out=True
        )
    except FileNotFoundError:
        if allow_host_tools():
            return _run_host(cmd, timeout=timeout)
        return SandboxRunResult(None, "", "", "error", error="docker binary not found")
    except Exception as e:
        return SandboxRunResult(
            None, "", "", "error", error=f"{type(e).__name__}: {e}"
        )


def _run_host(cmd: str, *, timeout: int) -> SandboxRunResult:
    try:
        proc = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=max(5, timeout),
        )
        return SandboxRunResult(
            exit_code=proc.returncode,
            stdout=proc.stdout or "",
            stderr=proc.stderr or "",
            via="host",
        )
    except subprocess.TimeoutExpired:
        return SandboxRunResult(
            None, "", "", "error", error=f"host command timed out ({timeout}s)", timed_out=True
        )
    except Exception as e:
        return SandboxRunResult(None, "", "", "error", error=f"{type(e).__name__}: {e}")


def http_via_sandbox(
    *,
    method: str,
    url: str,
    headers: dict[str, str],
    body: str = "",
    timeout: int = 30,
    max_chars: int = 12000,
) -> str:
    """Perform HTTP inside sandbox using python3 (available in pen-sandbox / most images)."""
    url_s = rewrite_url_for_sandbox(url)
    # Encode request as base64-ish via json for safe shell
    payload = {
        "method": (method or "GET").upper(),
        "url": url_s,
        "headers": headers or {},
        "body": body or "",
        "timeout": timeout,
        "max_chars": max_chars,
    }
    blob = json.dumps(payload, ensure_ascii=False)
    # Escape for single-quoted python -c is painful; use env + stdin via bash
    py = r"""
import json,sys,urllib.request,ssl
req=json.load(sys.stdin)
ctx=ssl._create_unverified_context()
r=urllib.request.Request(req["url"], data=(req.get("body") or None).encode() if req.get("body") else None, method=req.get("method") or "GET")
for k,v in (req.get("headers") or {}).items():
    r.add_header(k,v)
try:
    with urllib.request.urlopen(r, context=ctx, timeout=float(req.get("timeout") or 30)) as resp:
        body=resp.read()
        text=body.decode("utf-8","replace")
        mc=int(req.get("max_chars") or 12000)
        if len(text)>mc:
            text=text[:mc]+"\n…[truncated]…"
        hdrs="\n".join(f"{k}: {v}" for k,v in list(resp.headers.items())[:40])
        sc=getattr(resp, "status", None) or resp.getcode()
        print(f"HTTP {sc}\n{hdrs}\n\n{text}")
except Exception as e:
    print(f"error: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)
"""
    # Pass JSON on stdin
    health = sandbox_health()
    if must_use_sandbox() and (not health.docker or not health.image_present):
        return f"error: sandbox unavailable: {health.error}"

    if allow_host_tools() and (
        sandbox_mode() in ("0", "host") or not health.image_present
    ):
        return _http_host(method=method, url=url_s, headers=headers, body=body, timeout=timeout, max_chars=max_chars)

    net = health.network
    args = [
        docker_bin(),
        "run",
        "--rm",
        "-i",
        "--network",
        net,
        "--entrypoint",
        "python3",
    ]
    if net != "host":
        args += ["--add-host", "host.docker.internal:host-gateway"]
    args += [health.image, "-c", py]

    try:
        proc = subprocess.run(
            args,
            input=blob,
            capture_output=True,
            text=True,
            timeout=max(10, timeout + 15),
        )
        out = (proc.stdout or "").strip()
        err = (proc.stderr or "").strip()
        if proc.returncode != 0 and not out:
            return f"error: sandbox http exit {proc.returncode}: {err[:500]}"
        if err and not out.startswith("HTTP"):
            return f"error: {err[:800]}"
        # tag via for debugging (agent may ignore)
        if out and "via=sandbox" not in out:
            out = out + "\n[via=sandbox]"
        return out or f"(exit {proc.returncode}, empty)"
    except subprocess.TimeoutExpired:
        return "error: sandbox http timed out"
    except Exception as e:
        if allow_host_tools():
            return _http_host(
                method=method, url=url_s, headers=headers, body=body, timeout=timeout, max_chars=max_chars
            )
        return f"error: {type(e).__name__}: {e}"


def _http_host(
    *,
    method: str,
    url: str,
    headers: dict[str, str],
    body: str,
    timeout: int,
    max_chars: int,
) -> str:
    import httpx

    try:
        with httpx.Client(timeout=float(timeout), follow_redirects=True, verify=False) as client:
            resp = client.request(
                (method or "GET").upper(),
                url,
                content=body or None,
                headers=headers,
            )
        text = resp.text
        if len(text) > max_chars:
            text = text[:max_chars] + "\n…[truncated]…"
        hdrs = "\n".join(f"{k}: {v}" for k, v in list(resp.headers.items())[:40])
        return f"HTTP {resp.status_code}\n{hdrs}\n\n{text}\n[via=host]"
    except Exception as e:
        return f"error: {type(e).__name__}: {e}"
