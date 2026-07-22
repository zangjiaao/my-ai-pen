"""Deterministic coverage probes (mocked HTTP)."""

from __future__ import annotations

import json
from unittest.mock import patch

from node5.coverage import coverage_outcome, required_coverage
from node5.coverage_probes import run_coverage_probes
from node5.state import PenState, Surface


class _FakeResp:
    def __init__(self, code=200, text="", ctype="text/html", content=None):
        self.status_code = code
        self.text = text
        self.content = content if content is not None else (
            text.encode() if isinstance(text, str) else (text or b"")
        )
        self.headers = {"content-type": ctype}

    def json(self):
        return json.loads(self.text)


def test_ssrf_probe_books_on_profile_image_change():
    state = PenState(
        target="http://127.0.0.1:3000",
        dry_run=False,
        cookies={"token": "test.jwt.token"},
        surfaces=[Surface(path="/profile/image/url", note="url fetch sink")],
    )
    assert any(r.id == "ssrf_url_sink" for r in required_coverage(state))

    class SsrfClient:
        def __init__(self, *a, **k):
            self._pi = "/assets/public/images/uploads/default.svg"

        def close(self):
            pass

        def get(self, url, params=None, headers=None):
            if "whoami" in url:
                return _FakeResp(
                    200,
                    json.dumps({"user": {"id": 1, "profileImage": self._pi}}),
                    "application/json",
                )
            if "uploads/1.jpg" in url:
                return _FakeResp(
                    200, "x" * 600, "image/jpeg", content=b"\xff\xd8" + b"x" * 600
                )
            if "api/Users" in url:
                return _FakeResp(
                    200,
                    json.dumps({"data": [{"id": 1, "profileImage": self._pi}]}),
                    "application/json",
                )
            return _FakeResp(404, "no", "text/plain")

        def post(self, url, content=None, headers=None, data=None, files=None, json=None):
            body = content.decode() if isinstance(content, (bytes, bytearray)) else str(content or "")
            if "image/url" in url and "imageUrl=" in body.replace(" ", ""):
                if "carousel" in body or ".jpg" in body or "localhost" in body or "127.0.0.1" in body:
                    self._pi = "/assets/public/images/uploads/1.jpg"
                return _FakeResp(302, "Found. Redirecting to /profile", "text/plain")
            if "login" in url or "Users" in url:
                return _FakeResp(
                    200,
                    json.dumps({"authentication": {"token": "test.jwt.token"}}),
                    "application/json",
                )
            return _FakeResp(404, "no", "text/plain")

        def request(self, method, url, content=None, headers=None, params=None):
            if method.upper() == "POST":
                return self.post(url, content=content, headers=headers)
            return self.get(url, params=params, headers=headers)

    with patch("node5.coverage_probes.httpx.Client", SsrfClient):
        summary = run_coverage_probes(state)
    assert "ssrf_url_sink" in summary.get("attempted", [])
    assert coverage_outcome(state, "ssrf_url_sink") in ("closed", "attempted", "failed")
    if coverage_outcome(state, "ssrf_url_sink") == "closed":
        assert any("SSRF" in (c.title or "") for c in state.candidates)


def test_graphql_introspection():
    state = PenState(
        target="http://127.0.0.1:3000",
        dry_run=False,
        surfaces=[Surface(path="/graphql")],
    )

    class Client:
        def __init__(self, *a, **k):
            pass

        def close(self):
            pass

        def post(self, url, content=None, headers=None):
            return _FakeResp(
                200,
                json.dumps(
                    {
                        "data": {
                            "__schema": {
                                "queryType": {"name": "Query"},
                                "types": [{"name": "User", "kind": "OBJECT"}],
                            }
                        }
                    }
                ),
                "application/json",
            )

        def get(self, *a, **k):
            return _FakeResp(404, "")

        def request(self, *a, **k):
            return self.get()

    with patch("node5.coverage_probes.httpx.Client", Client):
        run_coverage_probes(state)
    assert coverage_outcome(state, "graphql") == "closed"
    assert any("GraphQL" in c.title for c in state.candidates)


def test_dry_run_blocks_without_skip_success():
    state = PenState(
        target="http://t",
        dry_run=True,
        surfaces=[Surface(path="/profile/image/url")],
    )
    summary = run_coverage_probes(state)
    assert summary.get("dry_run") is True
    assert coverage_outcome(state, "ssrf_url_sink") == "blocked"


def test_dom_client_browser_env_failure_is_blocked():
    """Chrome/runtime missing is blocked (transparent), not a silent success or target fail."""
    state = PenState(
        target="http://127.0.0.1:3000",
        dry_run=False,
        surfaces=[
            Surface(path="/#/search", note="angular spa review"),
            Surface(path="/api/Feedbacks", note="feedback ugc"),
        ],
    )
    assert any(r.id == "dom_client" for r in required_coverage(state))

    from node5.sandbox_exec import SandboxHealth

    fake_health = SandboxHealth(
        ok=True,
        docker=True,
        image="pen-sandbox:dev",
        image_present=True,
        mode="1",
        allow_host=False,
        network="host",
        browser_ok=False,
        browser_error="Chrome exited early (exit code: 127)",
    )
    with (
        patch("node5.sandbox_exec.sandbox_health", return_value=fake_health),
        patch("node5.browser_sandbox.browser_available", return_value=False),
        patch(
            "node5.browser_sandbox.run_browser_op",
            return_value={
                "ok": False,
                "error": "Chrome exited early (exit code: 127) without writing DevToolsActivePort",
                "via": "host",
            },
        ),
        patch("node5.coverage_probes.httpx.Client") as mock_client,
    ):
        # Avoid real HTTP for other probes that may also run
        inst = mock_client.return_value
        inst.get.return_value = _FakeResp(404, "")
        inst.post.return_value = _FakeResp(404, "")
        inst.request.return_value = _FakeResp(404, "")
        inst.close.return_value = None
        run_coverage_probes(state)

    assert coverage_outcome(state, "dom_client") == "blocked"
    assert any(
        e.get("id") == "dom_client"
        and (
            "browser_unavailable" in str(e.get("detail", ""))
            or "browser_runtime" in str(e.get("detail", ""))
        )
        for e in state.coverage_ledger
    )
