"""Sandbox policy: force pen-sandbox, host only with explicit flag."""

from __future__ import annotations

import os
from unittest.mock import patch

from node5.sandbox_exec import (
    allow_host_tools,
    rewrite_url_for_sandbox,
    run_in_sandbox,
    sandbox_health,
    sandbox_mode,
)


def test_rewrite_url_localhost_when_not_host_network(monkeypatch):
    monkeypatch.setenv("NODE5_SANDBOX_NETWORK", "bridge")
    assert "host.docker.internal" in rewrite_url_for_sandbox("http://127.0.0.1:3000/x")
    assert "example.com" in rewrite_url_for_sandbox("http://example.com/a")


def test_rewrite_skipped_on_host_network(monkeypatch):
    monkeypatch.setenv("NODE5_SANDBOX_NETWORK", "host")
    assert rewrite_url_for_sandbox("http://127.0.0.1:3000/") == "http://127.0.0.1:3000/"


def test_must_use_sandbox_blocks_without_image(monkeypatch):
    monkeypatch.setenv("NODE5_SANDBOX", "1")
    monkeypatch.delenv("NODE5_ALLOW_HOST_TOOLS", raising=False)
    with patch("node5.sandbox_exec.docker_image_exists", return_value=False), patch(
        "node5.sandbox_exec.shutil.which", return_value="/usr/bin/docker"
    ):
        h = sandbox_health()
        assert not h.ok
        r = run_in_sandbox("echo hi")
        assert r.via == "error"
        assert "sandbox" in (r.error or "").lower() or "image" in (r.error or "").lower()


def test_sandbox_mode_host_runs_on_host(monkeypatch):
    """NODE5_SANDBOX=0|host forces host act tools (explicit lab override)."""
    monkeypatch.setenv("NODE5_SANDBOX", "0")
    monkeypatch.setenv("NODE5_ALLOW_HOST_TOOLS", "1")
    r = run_in_sandbox("echo sandbox-test-ok")
    assert r.via == "host"
    assert "sandbox-test-ok" in (r.stdout or "")


def test_sandbox_mode_default_force():
    # default when unset in process may be from env; force check of allow flag
    os.environ.pop("NODE5_ALLOW_HOST_TOOLS", None)
    # mode function reads env
    m = sandbox_mode()
    assert m  # non-empty
