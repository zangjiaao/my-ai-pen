"""Owner-ledger Intel domain (Spec owner-intel.md / map #459).

Public seam: app.services.owner_intel helpers. No ORM / HTTP.
"""
import uuid

from app.api.intel import _user_id
from app.services.owner_intel import (
    INTEL_KINDS,
    MAX_INTEL_INJECT,
    SECRET_KINDS,
    agent_may_get,
    agent_may_list,
    agent_may_update,
    apply_forget,
    default_sensitivity,
    next_access_count,
    format_intel_inject_line,
    intel_matches_case_scope,
    intel_summary_lines,
    normalize_hang,
    normalize_kind,
    project_new,
    status_from_forget_count,
    strip_agent_audit_fields,
)


def test_auth_dict_user_id_matches_assets_api():
    uid = uuid.uuid4()
    assert _user_id({"user_id": str(uid), "email": "a@b.c", "role": "user"}) == uid


def test_kinds_are_closed_v1():
    assert INTEL_KINDS == (
        "credential_status",
        "secret",
        "token",
        "flag",
        "path_hint",
        "account",
        "config",
    )
    assert "note" not in INTEL_KINDS
    assert SECRET_KINDS == frozenset({"secret", "token", "flag"})


def test_missing_or_unknown_kind_still_records_as_config():
    assert normalize_kind(None) == "config"
    assert normalize_kind("") == "config"
    assert normalize_kind("   ") == "config"
    assert normalize_kind("made_up") == "config"
    assert normalize_kind("SECRET") == "secret"
    assert normalize_kind("path_hint") == "path_hint"


def test_sensitivity_defaults_from_kind():
    assert default_sensitivity("secret") == "secret"
    assert default_sensitivity("token") == "secret"
    assert default_sensitivity("flag") == "secret"
    assert default_sensitivity("account") == "plain"
    assert default_sensitivity("config") == "plain"


def test_lifecycle_two_step_forget():
    assert status_from_forget_count(0) == "active"
    assert status_from_forget_count(1) == "forgotten"
    assert status_from_forget_count(2) == "sealed"
    assert status_from_forget_count(9) == "sealed"

    first = apply_forget(0)
    assert first == {"forget_count": 1, "status": "forgotten"}
    second = apply_forget(1)
    assert second == {"forget_count": 2, "status": "sealed"}


def test_agent_surface_by_lifecycle():
    living = {"forget_count": 0, "status": "active"}
    soft = {"forget_count": 1, "status": "forgotten"}
    sealed = {"forget_count": 2, "status": "sealed"}

    assert agent_may_list(living) is True
    assert agent_may_list(soft) is False
    assert agent_may_list(sealed) is False

    assert agent_may_get(living) is True
    assert agent_may_get(soft) is True
    assert agent_may_get(sealed) is False

    assert agent_may_update(living) is True
    assert agent_may_update(soft) is True
    assert agent_may_update(sealed) is False


def test_intel_matches_case_scope_host_level_and_named_ports():
    named = {"host-1": {"3000"}}
    assert intel_matches_case_scope(asset_id="host-1", port=None, port_scope=named) is True
    assert intel_matches_case_scope(asset_id="host-1", port="3000", port_scope=named) is True
    assert intel_matches_case_scope(asset_id="host-1", port="8080", port_scope=named) is False
    assert intel_matches_case_scope(asset_id="other", port="3000", port_scope=named) is False
    whole = {"host-1": None}
    assert intel_matches_case_scope(asset_id="host-1", port="8080", port_scope=whole) is True


def test_hang_is_host_or_host_port_never_group():
    assert normalize_hang({"asset_id": "a1"}) == {"asset_id": "a1", "port": None}
    assert normalize_hang({"asset_id": "a1", "port": "443"}) == {"asset_id": "a1", "port": "443"}
    assert normalize_hang({"asset_id": "a1", "port": 80}) == {"asset_id": "a1", "port": "80"}
    try:
        normalize_hang({"group_id": "g1", "asset_id": "a1"})
        assert False, "group hang must fail"
    except ValueError as e:
        assert "group" in str(e).lower()
    try:
        normalize_hang({})
        assert False, "missing host must fail"
    except ValueError as e:
        assert "asset" in str(e).lower() or "host" in str(e).lower()


def test_agent_cannot_author_audit_fields():
    cleaned = strip_agent_audit_fields(
        {
            "id": "should-drop-on-create",
            "summary": "admin:admin invalid",
            "body": "tried default creds",
            "kind": "credential_status",
            "asset_id": "a1",
            "created_at": "2020-01-01",
            "updated_at": "2020-01-01",
            "source": "user",
            "new": True,
            "is_new": True,
            "forget_count": 9,
            "access_count": 99,
            "status": "sealed",
            "sensitivity": "secret",
            "created_task_id": "forged",
        }
    )
    assert "created_at" not in cleaned
    assert "updated_at" not in cleaned
    assert "source" not in cleaned
    assert "new" not in cleaned
    assert "is_new" not in cleaned
    assert "forget_count" not in cleaned
    assert "access_count" not in cleaned
    assert "status" not in cleaned
    assert "sensitivity" not in cleaned
    assert "created_task_id" not in cleaned
    assert cleaned["summary"] == "admin:admin invalid"
    assert cleaned["kind"] == "credential_status"


def test_access_count_increments_from_get_not_agent_authored():
    assert next_access_count(0) == 1
    assert next_access_count(3) == 4
    assert next_access_count(None) == 1
    assert next_access_count("2") == 3


def test_new_is_projection_from_created_task_id():
    row = {"id": "i1", "created_task_id": "task-a", "summary": "cookie in JWT"}
    assert project_new(row, current_task_id="task-a")["is_new"] is True
    assert project_new(row, current_task_id="task-b")["is_new"] is False
    assert project_new(row, current_task_id=None)["is_new"] is False


def test_inject_living_only_cap_and_secret_pointer():
    living = {
        "id": "i-live",
        "summary": "WAF in front of :443",
        "kind": "config",
        "asset_id": "host-1",
        "port": "443",
        "forget_count": 0,
        "status": "active",
        "body": "cloudflare headers",
    }
    secret = {
        "id": "i-sec",
        "summary": "session cookie name",
        "kind": "secret",
        "asset_id": "host-1",
        "port": None,
        "forget_count": 0,
        "status": "active",
        "body": "PHPSESSID=abc",
    }
    soft = {**living, "id": "i-soft", "forget_count": 1, "status": "forgotten"}
    sealed = {**living, "id": "i-seal", "forget_count": 2, "status": "sealed"}

    live_line = format_intel_inject_line(living)
    assert "i-live" in live_line
    assert "WAF" in live_line
    assert ":443" in live_line or "443" in live_line

    secret_line = format_intel_inject_line(secret)
    assert "i-sec" in secret_line
    assert "PHPSESSID=abc" not in secret_line
    assert "session cookie" in secret_line

    lines = intel_summary_lines([living, secret, soft, sealed] + [{**living, "id": f"x{n}"} for n in range(30)])
    assert all("i-soft" not in ln and "i-seal" not in ln for ln in lines)
    assert len(lines) <= MAX_INTEL_INJECT
    assert any("i-live" in ln for ln in lines)
    assert any("i-sec" in ln for ln in lines)
