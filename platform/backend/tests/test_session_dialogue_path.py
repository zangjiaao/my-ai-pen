"""Spec #455 — Session-first dialogue path (S1–S3 pure seams).

Continue envelope restores sticky target/scope/goal without engagement-book rewrap.
Task package is accounting; Session owns dialogue.
"""

from app.ws.router import (
    _package_error_status_content,
    _package_settle_status_content,
    _resume_message_from_context,
    _should_session_continue_sticky,
    _task_assign_from_user_message,
)


def test_s1_resume_turn_text_is_utterance_only():
    prior = (
        "Authorized pentest of http://lab.example/\n"
        "Enumerate attack surface, book findings with proof."
    )
    resume_context = {
        "task": {
            "target": {"type": "url", "value": "http://lab.example/"},
            "scope": {"allow": ["http://lab.example/"], "deny": []},
            "instruction": prior,
        },
        "checkpoint": {"phase": "recon"},
    }
    resumed, ok = _resume_message_from_context({"text": "继续"}, resume_context)
    assert ok is True
    assert resumed is not None
    assert resumed["text"] == "继续"
    assert resumed["initial_instruction"] == "继续"
    assert resumed["target"]["value"] == "http://lab.example/"
    assert resumed["scope"]["allow"] == ["http://lab.example/"]
    assert resumed["checkpoint"]["phase"] == "recon"
    assert "User continuation:" not in resumed["text"]
    assert prior not in resumed["text"]


def test_s1_resume_preserves_goal_without_prior_instruction_body():
    resume_context = {
        "task": {
            "target": {"type": "url", "value": "http://target.local"},
            "scope": {"allow": ["http://target.local"]},
            "instruction": "prior multi-paragraph engagement book",
            "goal_objective": "Maximize verified flags in scope",
        }
    }
    resumed, ok = _resume_message_from_context({"text": "continue"}, resume_context)
    assert ok is True
    assert resumed["text"] == "continue"
    assert resumed["initial_instruction"] == "continue"
    assert resumed.get("goal_objective") == "Maximize verified flags in scope"
    assert resumed.get("goal_mode") is True
    assert "prior multi-paragraph" not in resumed["text"]
    assert "User continuation:" not in resumed["text"]


def test_handoff_summary_is_not_initial_instruction():
    msg = {
        "text": "对目标：http://lab.example/ 再测一次",
        "initial_instruction": "对目标：http://lab.example/ 再测一次",
        "handoff_summary": "**任务**: 去对 196 条台账避免撞车",
        "target": {"type": "url", "value": "http://lab.example/"},
        "engagement": "pentest",
    }
    task = _task_assign_from_user_message("conv-h", msg, "task-h")
    assert task["initial_instruction"] == "对目标：http://lab.example/ 再测一次"
    assert task["handoff_summary"] == "**任务**: 去对 196 条台账避免撞车"
    assert "196" not in task["initial_instruction"]


def test_s1_task_assign_maps_utterance_not_composite():
    resume_context = {
        "task": {
            "target": {"type": "url", "value": "http://lab.example/"},
            "scope": {"allow": ["http://lab.example/"]},
            "instruction": "Run full app assessment",
        }
    }
    resumed, ok = _resume_message_from_context({"text": "继续扫"}, resume_context)
    assert ok is True
    task = _task_assign_from_user_message("conv-s1", resumed, "task-s1")
    assert task["initial_instruction"] == "继续扫"
    assert task["target"]["value"] == "http://lab.example/"
    assert "User continuation:" not in task["initial_instruction"]
    assert "Run full app assessment" not in task["initial_instruction"]


def test_s1_resume_requires_durable_target():
    resumed, ok = _resume_message_from_context(
        {"text": "continue"},
        {"task": {}, "checkpoint": {"phase": "analysis"}},
    )
    assert resumed is None
    assert ok is False


def test_s1_choice_confirm_text_not_rewrapped_with_prior_instruction():
    """Orphaned/next_steps confirm path uses same helper — confirm text stays clean."""
    resume_context = {
        "task": {
            "target": {"type": "url", "value": "http://lab.example/"},
            "scope": {"allow": ["http://lab.example/"]},
            "instruction": "Original long engagement instruction with target details",
        }
    }
    confirm = {
        "text": "已选择：继续深入探测\n补充：优先 login",
        "selected_option_ids": ["continue_deep"],
    }
    resumed, ok = _resume_message_from_context(confirm, resume_context)
    assert ok is True
    assert resumed["text"] == "已选择：继续深入探测\n补充：优先 login"
    assert "User continuation:" not in resumed["text"]
    assert "Original long engagement" not in resumed["text"]
    assert resumed["target"]["value"] == "http://lab.example/"
    assert resumed.get("session_continue") is True


def test_s1_resume_marks_session_continue_on_envelope():
    resume_context = {
        "task": {
            "target": {"type": "url", "value": "http://lab.example/"},
            "scope": {"allow": ["http://lab.example/"]},
            "instruction": "prior",
        }
    }
    resumed, ok = _resume_message_from_context({"text": "继续"}, resume_context)
    assert ok is True
    assert resumed.get("session_continue") is True
    task = _task_assign_from_user_message("c", resumed, "t1")
    assert task.get("session_continue") is True
    assert task["initial_instruction"] == "继续"


def test_s1_should_session_continue_sticky_gate():
    msg = {"text": "继续"}
    assert (
        _should_session_continue_sticky(
            is_default=False,
            conversation_status="failed",
            has_resume_task=True,
            msg=msg,
        )
        is True
    )
    assert (
        _should_session_continue_sticky(
            is_default=True,
            conversation_status="failed",
            has_resume_task=True,
            msg=msg,
        )
        is False
    )
    assert (
        _should_session_continue_sticky(
            is_default=False,
            conversation_status="running",
            has_resume_task=True,
            msg=msg,
        )
        is False
    )
    assert (
        _should_session_continue_sticky(
            is_default=False,
            conversation_status="completed",
            has_resume_task=True,
            msg={"text": "优先测 login"},
        )
        is True
    )
    assert (
        _should_session_continue_sticky(
            is_default=False,
            conversation_status="failed",
            has_resume_task=False,
            msg=msg,
        )
        is False
    )


def test_s1_freeform_after_fail_keeps_utterance_and_sticky_target():
    """Long free-form after fail is still Session dialogue, not engagement book."""
    prior = "Run a multi-stage assessment of http://lab.example/ with RoE limits."
    resume_context = {
        "task": {
            "target": {"type": "url", "value": "http://lab.example/"},
            "scope": {"allow": ["http://lab.example/"]},
            "instruction": prior,
        }
    }
    utterance = "优先从 login 入口验证鉴权绕过"
    resumed, ok = _resume_message_from_context({"text": utterance}, resume_context)
    assert ok is True
    assert resumed["text"] == utterance
    assert resumed["initial_instruction"] == utterance
    assert prior not in resumed["text"]
    assert resumed["target"]["value"] == "http://lab.example/"


def test_p2_package_settle_copy_plain_package():
    content = _package_settle_status_content({"status": "completed", "summary": {"ok": True}})
    assert content["text"] == "Package complete"
    assert content["status"] == "completed"
    assert "Task complete" not in content["text"]
    assert content.get("session_continue") is not True


def test_p2_package_settle_copy_session_continue():
    content = _package_settle_status_content(
        {
            "status": "completed",
            "summary": "done",
            "parked_continue": True,
        }
    )
    assert content["text"] == "Session continue settled"
    assert content.get("session_continue") is True
    assert content.get("parked_continue") is True


def test_p2_package_incomplete_and_error_copy():
    paused = _package_settle_status_content(
        {"status": "incomplete", "session_continue": True, "summary": {}}
    )
    assert paused["text"] == "Session continue paused"
    blocked = _package_settle_status_content({"status": "blocked", "summary": {}})
    assert blocked["text"] == "Package blocked"
    err = _package_error_status_content(
        {"message": "stream failed", "parked_continue": True}
    )
    assert err["text"] == "Session segment failed: stream failed"
    plain = _package_error_status_content({"error": "boom"})
    assert plain["text"] == "Package failed: boom"
