"""Browser-level MVP Alpha smoke using Chrome DevTools Protocol directly.

Starts the seeded backend and Vite frontend, launches an isolated Chrome CDP
session, drives the real React UI, and drives a fake node over the real
WebSocket endpoint.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
CDP_PORT = 9223
BACKEND_PORT = int(os.environ.get("ALPHA_BROWSER_PORT", "8010"))
FRONTEND_PORT = int(os.environ.get("ALPHA_FRONTEND_PORT", "5174"))
BROWSER_PATHS = (
    Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
    Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
)


async def fake_node_flow() -> None:
    import websockets

    uri = f"ws://127.0.0.1:{BACKEND_PORT}/ws?token=alpha-node-token"
    async with websockets.connect(uri) as ws:
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("type") == "task_assign":
                conv_id = msg["conversation_id"]
                await ws.send(json.dumps({"type": "status_update", "conversation_id": conv_id, "phase": "recon", "iteration": 1, "active_tool": "curl"}))
                await ws.send(json.dumps({"type": "tool_output", "conversation_id": conv_id, "tool_name": "curl", "tool_run_id": "tool-browser", "line": "HTTP/1.1 200 OK", "status": "done"}))
                await ws.send(json.dumps({"type": "asset_discovered", "conversation_id": conv_id, "address": "https://example.com", "asset_type": "web", "open_ports": [443], "services": [{"port": 443, "name": "https"}]}))
                await ws.send(json.dumps({"type": "vuln_found", "conversation_id": conv_id, "title": "Browser Alpha finding", "severity": "low", "confidence": 0.7, "affected_asset": "https://example.com", "location": "/headers", "evidence_ids": ["ev-browser"]}))
                await ws.send(json.dumps({"type": "request_decision", "conversation_id": conv_id, "request_id": "req-browser", "risk_level": "destructive", "question": "Allow browser smoke dump?", "proposed_action": "sqlmap --dump"}))
            elif msg.get("type") == "user_input" and msg.get("request_id") == "req-browser":
                assert msg.get("response") == "authorize"
                conv_id = msg["conversation_id"]
                await ws.send(json.dumps({"type": "task_complete", "conversation_id": conv_id, "status": "completed", "summary": {"browser": True}}))
                return


def wait_http(url: str, timeout: float = 30.0) -> None:
    deadline = time.time() + timeout
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            with urlopen(url, timeout=2) as res:
                if res.status < 500:
                    return
        except Exception as exc:
            last_error = exc
        time.sleep(0.5)
    raise RuntimeError(f"Timed out waiting for {url}: {last_error}")


def launch_chrome(profile_dir: Path) -> subprocess.Popen:
    browser_path = next((path for path in BROWSER_PATHS if path.exists()), None)
    if not browser_path:
        raise FileNotFoundError("Chrome or Edge executable not found")
    return subprocess.Popen([
        str(browser_path),
        f"--remote-debugging-port={CDP_PORT}",
        "--remote-debugging-address=127.0.0.1",
        f"--user-data-dir={profile_dir}",
        "--headless=old",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-gpu-sandbox",
        "--disable-extensions",
        "--disable-component-extensions-with-background-pages",
        "--disable-background-networking",
        "--disable-sync",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
    ], stdout=(profile_dir / "chrome.stdout.log").open("w"), stderr=(profile_dir / "chrome.stderr.log").open("w"))


def get_initial_cdp_tab() -> str:
    with urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json/list", timeout=5) as res:
        targets = json.loads(res.read().decode())
    pages = [target for target in targets if target.get("type") == "page" and target.get("webSocketDebuggerUrl")]
    if not pages:
        raise RuntimeError(f"No CDP page targets available: {targets!r}")
    return pages[0]["webSocketDebuggerUrl"]


class CDPClient:
    def __init__(self, websocket_url: str):
        self.websocket_url = websocket_url
        self.ws = None
        self.next_id = 1

    async def __aenter__(self):
        import websockets

        self.ws = await websockets.connect(self.websocket_url)
        await self.call("Page.enable")
        await self.call("Runtime.enable")
        return self

    async def __aexit__(self, exc_type, exc, tb):
        if self.ws:
            await self.ws.close()

    async def call(self, method: str, params: dict | None = None) -> dict:
        assert self.ws is not None
        msg_id = self.next_id
        self.next_id += 1
        await self.ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        while True:
            raw = await self.ws.recv()
            msg = json.loads(raw)
            if msg.get("id") == msg_id:
                if "error" in msg:
                    raise RuntimeError(f"CDP {method} failed: {msg['error']}")
                return msg.get("result", {})

    async def eval(self, expression: str):
        result = await self.call("Runtime.evaluate", {
            "expression": expression,
            "awaitPromise": True,
            "returnByValue": True,
        })
        remote = result.get("result", {})
        if "exceptionDetails" in result:
            raise RuntimeError(result["exceptionDetails"])
        return remote.get("value")

    async def wait_for(self, expression: str, timeout: float = 30.0):
        deadline = time.time() + timeout
        last = None
        while time.time() < deadline:
            last = await self.eval(expression)
            if last:
                return last
            await asyncio.sleep(0.25)
        raise TimeoutError(f"Timed out waiting for JS expression: {expression}; last={last!r}")


async def drive_ui(websocket_url: str, url: str) -> None:
    async with CDPClient(websocket_url) as cdp:
        await cdp.call("Page.navigate", {"url": url})
        await cdp.wait_for("document.querySelector('input[type=email]') !== null")
        await cdp.eval(r"""
(() => {
  const setValue = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  setValue(document.querySelector('input[type=email]'), 'alpha@example.local');
  setValue(document.querySelector('input[type=password]'), 'alpha-password');
  document.querySelector('button[type=submit]').click();
  return true;
})()
""")
        await cdp.wait_for("location.pathname === '/' && document.querySelector('main input') !== null")
        await cdp.eval(r"""
(() => {
  const inputs = Array.from(document.querySelectorAll('main input'));
  const input = inputs[inputs.length - 1];
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'test https://example.com');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const buttons = Array.from(document.querySelectorAll('main button'));
  buttons[buttons.length - 1].click();
  return true;
})()
""")
        await cdp.wait_for("document.body.innerText.includes('Browser Alpha finding')")
        await cdp.wait_for("document.querySelector('[data-testid=confirm-authorize]') !== null")
        await cdp.wait_for("document.querySelector('[data-testid=todo-list]') !== null")
        await cdp.wait_for("document.querySelector('[data-testid=phase-progress]')?.innerText === '3/6'")
        await cdp.wait_for("document.querySelector('[data-testid=right-tab-discoveries]')?.innerText.includes('(1)')")
        await cdp.wait_for("document.querySelector('[data-testid=right-tab-pending]')?.innerText.includes('(1)')")
        await cdp.wait_for("document.querySelector('[data-testid=right-tab-evidence]')?.innerText.includes('(1)')")
        await cdp.call("Page.reload", {"ignoreCache": True})
        await cdp.wait_for("document.body.innerText.includes('Browser Alpha finding')")
        await cdp.wait_for("document.querySelector('[data-testid=confirm-authorize]') !== null")
        await cdp.wait_for("document.querySelector('[data-testid=todo-list]') !== null")
        await cdp.wait_for("document.querySelector('[data-testid=phase-progress]')?.innerText === '3/6'")
        await cdp.wait_for("document.querySelector('[data-testid=right-tab-discoveries]')?.innerText.includes('(1)')")
        await cdp.wait_for("document.querySelector('[data-testid=right-tab-pending]')?.innerText.includes('(1)')")
        await cdp.wait_for("document.querySelector('[data-testid=right-tab-evidence]')?.innerText.includes('(1)')")
        invalid_progress = await cdp.eval("/\\b\\d{2,}\\/50\\b/.test(document.body.innerText)")
        if invalid_progress:
            raise AssertionError(await cdp.eval("document.body.innerText"))
        await cdp.eval("document.querySelector('[data-testid=right-tab-evidence]').click(); true")
        await cdp.wait_for("document.querySelector('[data-testid=evidence-item]') !== null")
        await cdp.eval("document.querySelector('[data-testid=confirm-authorize]').click(); true")
        await cdp.wait_for("document.querySelector('[data-testid=right-tab-evidence]') !== null")
        await cdp.wait_for("document.body.innerText.includes('curl') || document.body.innerText.includes('HTTP/1.1 200 OK')")
        text = await cdp.eval("document.body.innerText")
        if "Browser Alpha finding" not in text or "curl" not in text:
            raise AssertionError(text)


def main() -> None:
    backend = subprocess.Popen([sys.executable, "scripts\\alpha_browser_backend.py"], cwd=ROOT)
    frontend_env = os.environ.copy()
    frontend_env["VITE_BACKEND_URL"] = f"http://127.0.0.1:{BACKEND_PORT}"
    frontend_env["VITE_WS_URL"] = f"ws://127.0.0.1:{BACKEND_PORT}"
    frontend = subprocess.Popen(
        ["npm.cmd", "run", "dev", "--", "--host", "127.0.0.1", "--port", str(FRONTEND_PORT), "--strictPort"],
        cwd=ROOT / "platform" / "frontend",
        env=frontend_env,
    )
    profile_dir = ROOT / ".alpha" / "chrome-profile"
    shutil.rmtree(profile_dir, ignore_errors=True)
    profile_dir.mkdir(parents=True, exist_ok=True)
    chrome = launch_chrome(profile_dir)
    node_thread: threading.Thread | None = None
    node_error: list[BaseException] = []

    try:
        print("waiting backend", flush=True)
        wait_http(f"http://127.0.0.1:{BACKEND_PORT}/api/health")
        print("waiting frontend", flush=True)
        wait_http(f"http://127.0.0.1:{FRONTEND_PORT}")
        print("waiting chrome cdp", flush=True)
        try:
            wait_http(f"http://127.0.0.1:{CDP_PORT}/json/version")
        except Exception:
            stderr_path = profile_dir / "chrome.stderr.log"
            if stderr_path.exists():
                log_text = stderr_path.read_text(errors="replace")[-4000:]
                print(log_text.encode("ascii", "backslashreplace").decode("ascii"), flush=True)
            raise

        def run_fake_node() -> None:
            try:
                asyncio.run(fake_node_flow())
            except BaseException as exc:
                node_error.append(exc)

        print("starting fake node", flush=True)
        node_thread = threading.Thread(target=run_fake_node, daemon=True)
        node_thread.start()
        time.sleep(0.5)

        websocket_url = get_initial_cdp_tab()
        asyncio.run(drive_ui(websocket_url, f"http://127.0.0.1:{FRONTEND_PORT}/login"))

        if not node_thread:
            raise RuntimeError("fake node thread did not start")
        node_thread.join(timeout=30)
        if node_thread.is_alive():
            raise TimeoutError("fake node did not receive authorization")
        if node_error:
            raise node_error[0]

        print("alpha browser smoke ok")
    finally:
        for proc in (frontend, backend, chrome):
            proc.terminate()
        for proc in (frontend, backend, chrome):
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
        shutil.rmtree(profile_dir, ignore_errors=True)


if __name__ == "__main__":
    main()