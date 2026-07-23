"""Browser single-session composites (open+wait+eval must not use multi docker runs)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from node5.browser_sandbox import (
    _build_session_steps,
    _session_shell,
    run_browser_op,
    spa_settle_ms,
)


def test_build_open_eval_includes_settle_and_eval():
    steps = _build_session_steps(
        op="open_eval",
        open_url="http://t/#/search?q=x",
        selector="",
        text="",
        script="document.body.innerHTML.slice(0,100)",
    )
    assert steps is not None
    assert steps[0] == ["open", "http://t/#/search?q=x"]
    waits = [s for s in steps if s[0] == "wait"]
    assert len(waits) >= 3  # load + fixed + --fn + rest
    assert any(len(s) > 1 and s[1] == "--fn" for s in waits)
    assert steps[-1][0] == "eval"
    assert "innerHTML" in steps[-1][1]


def test_build_open_text_get_text():
    steps = _build_session_steps(
        op="open_text",
        open_url="http://t/",
        selector="",
        text="",
        script="",
    )
    assert steps is not None
    assert steps[-1] == ["get", "text"]


def test_eval_with_url_auto_opens():
    steps = _build_session_steps(
        op="eval",
        open_url="http://t/#/x",
        selector="",
        text="",
        script="1+1",
    )
    assert steps is not None
    assert steps[0][0] == "open"
    assert steps[-1] == ["eval", "1+1"]


def test_eval_without_url_rejected():
    steps = _build_session_steps(
        op="eval",
        open_url="",
        selector="",
        text="",
        script="1+1",
    )
    assert steps is None


def test_session_shell_chains_with_and():
    shell = _session_shell(
        [["open", "http://t"], ["wait", "1000"], ["get", "text"]],
        ab_bin="agent-browser",
    )
    assert "agent-browser open http://t" in shell or "agent-browser open 'http://t'" in shell
    assert "&&" in shell
    assert "wait" in shell
    assert "get text" in shell or "get 'text'" in shell


def test_run_browser_op_uses_single_docker_sh_session():
    """open_eval must be one docker run with sh -c, not recursive multi-run."""
    fake_health = MagicMock()
    fake_health.docker = True
    fake_health.image_present = True
    fake_health.image = "pen-sandbox:dev"
    fake_health.browser_error = ""
    fake_health.error = ""

    captured = {}

    def fake_run(args, **kwargs):
        captured["args"] = args
        m = MagicMock()
        m.returncode = 0
        m.stdout = "app-root payload"
        m.stderr = ""
        return m

    with (
        patch("node5.browser_sandbox.sandbox_health", return_value=fake_health),
        patch("node5.browser_sandbox.sandbox_network", return_value="host"),
        patch("node5.browser_sandbox.docker_bin", return_value="docker"),
        patch("node5.browser_sandbox.subprocess.run", side_effect=fake_run),
        patch("node5.browser_sandbox.browser_mode", return_value="1"),
    ):
        r = run_browser_op(
            target="http://127.0.0.1:3000",
            op="open_eval",
            url="http://127.0.0.1:3000/#/search?q=x",
            script="document.body.innerHTML.slice(0,50)",
        )

    assert r["ok"]
    args = captured["args"]
    # single docker invocation
    assert args[0] == "docker"
    assert args.count("run") == 1
    assert "--entrypoint" in args
    assert "sh" in args
    # shell script chains open + wait + eval
    script = args[-1]
    assert "open" in script
    assert "wait" in script
    assert "eval" in script
    assert r.get("session_steps", 0) >= 4


def test_spa_settle_ms_env(monkeypatch):
    monkeypatch.setenv("NODE5_BROWSER_SPA_WAIT_MS", "1500")
    assert spa_settle_ms() == 1500
