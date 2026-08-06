"""Spec #311 — Case Workset projection, mechanical gate, Goal outer terminals."""
from app.services.case_workset import (
    apply_settle_to_context,
    auto_check_safe,
    adopt_item,
    evaluate_goal_terminal,
    get_workset,
    goal_auto_adopt,
    mechanical_gate,
    merge_proposed_items,
    normalize_candidate,
    order_workset_items,
    project_workset_for_api,
    put_workset,
    reorder_items,
    scope_hosts_from_task,
    thin_handoff_brief,
    update_item_status,
)


SCOPE = {"target.local", "app.example.com"}


def _task():
    return {
        "target": {"type": "url", "value": "http://target.local/"},
        "scope": {"allow": ["http://target.local/", "app.example.com"], "deny": []},
    }


def test_scope_hosts_from_task():
    hosts = scope_hosts_from_task(_task())
    assert "target.local" in hosts
    assert "app.example.com" in hosts


def test_normalize_oos_host_is_t_host():
    item = normalize_candidate(
        {"host": "evil.example.com", "port": "443", "in_scope": False, "urls": ["https://evil.example.com/"]},
        source="free_settle",
        scope_hosts=SCOPE,
    )
    assert item is not None
    assert item["family"] == "t_host"
    assert item["status"] == "proposed"
    assert item["payload"]["host"] == "evil.example.com"
    assert item["auto_eligible"] is False


def test_normalize_in_scope_surface_is_t_surface():
    item = normalize_candidate(
        {
            "location": "http://target.local/admin",
            "host": "target.local",
            "in_scope": True,
            "path_key": "/admin",
        },
        source="hard_settle",
        scope_hosts=SCOPE,
    )
    assert item is not None
    assert item["family"] == "t_surface"
    assert item["auto_eligible"] is True


def test_reject_invalid_host_and_empty():
    assert (
        normalize_candidate(
            {"host": "include.php", "in_scope": False},
            source="free_settle",
            scope_hosts=SCOPE,
        )
        is None
    )
    assert normalize_candidate({}, source="x", scope_hosts=SCOPE) is None
    assert (
        normalize_candidate(
            {"family": "t_surface", "title": ""},
            source="x",
            scope_hosts=SCOPE,
        )
        is None
    )


def test_mechanical_gate_rejects_auto_adopt_host_and_oos_surface():
    host_item = normalize_candidate(
        {"host": "other.lab", "in_scope": False},
        source="free_settle",
        scope_hosts=SCOPE,
    )
    assert host_item is not None
    gate = mechanical_gate(host_item, scope_hosts=SCOPE, for_auto_adopt=True)
    assert gate["ok"] is False
    assert "silent_roe_expand_forbidden" in gate["reasons"]
    assert auto_check_safe(host_item, SCOPE) is False

    oos_surface = {
        "family": "t_surface",
        "title": "deepen",
        "status": "proposed",
        "payload": {"location": "http://evil.lab/x", "host": "evil.lab", "in_scope": False},
    }
    gate2 = mechanical_gate(oos_surface, scope_hosts=SCOPE, for_auto_adopt=True)
    assert gate2["ok"] is False
    assert auto_check_safe(oos_surface, SCOPE) is False


def test_agent_cannot_self_adopt():
    ws = merge_proposed_items(
        {"version": 1, "items": [], "goal": None},
        [{"location": "http://target.local/login", "host": "target.local", "in_scope": True}],
        source="free_settle",
        scope_hosts=SCOPE,
    )
    item_id = ws["items"][0]["id"]
    _, _, err = update_item_status(ws, item_id, status="adopted", actor="agent")
    assert err == "agent_cannot_self_adopt"
    _, _, err2 = adopt_item(ws, item_id, actor="agent", scope_hosts=SCOPE)
    assert err2 == "agent_cannot_self_adopt"


def test_user_adopt_and_survive_new_merge():
    ws = merge_proposed_items(
        {"version": 1, "items": [], "goal": None},
        [
            {"host": "side.example.com", "in_scope": False},
            {"location": "http://target.local/api", "host": "target.local", "in_scope": True},
        ],
        source="free_settle",
        scope_hosts=SCOPE,
    )
    assert len(ws["items"]) == 2
    surface = next(i for i in ws["items"] if i["family"] == "t_surface")
    ws, adopted, err = adopt_item(ws, surface["id"], actor="user", scope_hosts=SCOPE)
    assert err is None
    assert adopted["status"] == "adopted"

    # New Graph settle must not wipe open items (dedupe keeps them).
    ws2 = merge_proposed_items(
        ws,
        [
            {"host": "side.example.com", "in_scope": False},  # dup
            {"host": "new-oos.lab", "in_scope": False},
        ],
        source="hard_settle",
        scope_hosts=SCOPE,
    )
    open_ids = {i["id"] for i in ws2["items"] if i["status"] in {"proposed", "adopted"}}
    assert surface["id"] in open_ids
    assert any(i.get("payload", {}).get("host") == "new-oos.lab" for i in ws2["items"])
    # no dual-write into plan_tree
    assert "plan_tree" not in ws2


def test_goal_off_no_auto_adopt():
    ws = merge_proposed_items(
        {"version": 1, "items": [], "goal": None},
        [{"location": "http://target.local/a", "host": "target.local", "in_scope": True}],
        source="free_settle",
        scope_hosts=SCOPE,
    )
    ws2, adopted = goal_auto_adopt(ws, scope_hosts=SCOPE, goal_on=False)
    assert adopted == []
    assert all(i["status"] == "proposed" for i in ws2["items"])


def test_goal_on_auto_adopt_only_safe_t_surface():
    ws = merge_proposed_items(
        {"version": 1, "items": [], "goal": None},
        [
            {"location": "http://target.local/a", "host": "target.local", "in_scope": True},
            {"host": "other.lab", "in_scope": False},
            {
                "location": "http://evil.lab/x",
                "host": "evil.lab",
                "in_scope": False,
                "family": "t_surface",
            },
        ],
        source="hard_settle",
        scope_hosts=SCOPE,
    )
    # Force the evil surface if normalize flipped family
    for i in ws["items"]:
        if i.get("payload", {}).get("host") == "evil.lab" and i["family"] == "t_host":
            pass  # expected as t_host
    ws2, adopted = goal_auto_adopt(ws, scope_hosts=SCOPE, goal_on=True)
    assert len(adopted) >= 1
    for i in ws2["items"]:
        if i["id"] in adopted:
            assert i["family"] == "t_surface"
            assert i["status"] == "adopted"
            assert i.get("status_actor") == "goal_mechanical"
        if i["family"] == "t_host":
            assert i["status"] == "proposed"


def test_goal_terminals_complete_with_awaiting_scope_confirm():
    ws = merge_proposed_items(
        {"version": 1, "items": [], "goal": {"status": "running", "outer_budget": 8, "outer_rounds": 1}},
        [
            {"host": "pending.lab", "in_scope": False},
        ],
        source="free_settle",
        scope_hosts=SCOPE,
    )
    # No auto-eligible surfaces left → complete with residual hosts
    result = evaluate_goal_terminal(ws, goal_on=True)
    assert result["terminal"] == "goal_complete"
    assert result["return_to"] == "free"
    assert result["residual"]["class"] == "awaiting_scope_confirm"
    assert result["full_coverage"] is False


def test_goal_terminals_blocked_budget_stopped():
    base = {
        "version": 1,
        "items": [],
        "goal": {"status": "running", "outer_budget": 2, "outer_rounds": 2},
    }
    assert evaluate_goal_terminal(base, goal_on=True, user_stopped=True)["terminal"] == "goal_stopped"
    assert evaluate_goal_terminal(base, goal_on=True, blocked=True)["terminal"] == "goal_blocked"
    assert evaluate_goal_terminal(base, goal_on=True)["terminal"] == "goal_budget_exhausted"


def test_order_workset_in_progress_first():
    items = [
        {
            "id": "p1",
            "family": "t_host",
            "title": "host",
            "status": "proposed",
            "auto_eligible": False,
            "sort_order": 10,
            "created_at": "2026-01-01T00:00:00Z",
        },
        {
            "id": "s1",
            "family": "t_surface",
            "title": "surf",
            "status": "proposed",
            "auto_eligible": True,
            "sort_order": 20,
            "created_at": "2026-01-01T00:00:01Z",
        },
        {
            "id": "a1",
            "family": "t_surface",
            "title": "adopted",
            "status": "adopted",
            "sort_order": 30,
            "created_at": "2026-01-01T00:00:02Z",
        },
        {
            "id": "run",
            "family": "t_surface",
            "title": "running",
            "status": "adopted",
            "in_progress": True,
            "sort_order": 40,
            "created_at": "2026-01-01T00:00:03Z",
        },
    ]
    ordered = order_workset_items(items)
    assert [i["id"] for i in ordered] == ["run", "a1", "s1", "p1"]


def test_reorder_and_projection():
    ws = merge_proposed_items(
        {"version": 1, "items": [], "goal": None},
        [
            {"host": "a.lab", "in_scope": False},
            {"host": "b.lab", "in_scope": False},
        ],
        source="free_settle",
        scope_hosts=SCOPE,
    )
    ids = [i["id"] for i in ws["items"]]
    ws2, err = reorder_items(ws, list(reversed(ids)))
    assert err is None
    proj = project_workset_for_api(ws2)
    assert proj["open_count"] == 2
    assert proj["items"][0]["id"] == ids[1]


def test_apply_settle_free_path_and_goal_off():
    ctx = {"task": _task()}
    ctx2 = apply_settle_to_context(
        ctx,
        next_scope_candidates=[{"host": "side.lab", "in_scope": False}],
        attack_surface_candidates=[
            {"host": "target.local", "location": "http://target.local/x", "in_scope": True},
        ],
        source="free_settle",
        goal_on=False,
    )
    ws = get_workset(ctx2)
    families = {i["family"] for i in ws["items"]}
    assert "t_host" in families
    assert all(i["status"] == "proposed" for i in ws["items"])


def test_apply_settle_goal_on_auto_adopt_returns_free():
    ctx = {
        "task": {
            **_task(),
            "goal_objective": "Maximize verified findings",
        }
    }
    ctx2 = apply_settle_to_context(
        ctx,
        candidates=[
            {"location": "http://target.local/admin", "host": "target.local", "in_scope": True},
            {"host": "new-host.lab", "in_scope": False},
        ],
        source="hard_settle",
        goal_on=True,
        goal_objective="Maximize verified findings",
        bump_outer_round=True,
    )
    ws = get_workset(ctx2)
    surfaces = [i for i in ws["items"] if i["family"] == "t_surface"]
    hosts = [i for i in ws["items"] if i["family"] == "t_host"]
    assert any(i["status"] == "adopted" for i in surfaces)
    assert all(i["status"] == "proposed" for i in hosts)
    assert ctx2.get("goal_outer", {}).get("return_to") == "free"
    # With adopted open, may continue (not necessarily complete)
    assert ws["goal"] is not None


def test_thin_brief_not_fat_dump():
    ws = merge_proposed_items(
        {"version": 1, "items": [], "goal": {"status": "running", "outer_budget": 8, "outer_rounds": 0}},
        [{"location": "http://target.local/z", "host": "target.local", "in_scope": True}],
        source="free_settle",
        scope_hosts=SCOPE,
    )
    brief = thin_handoff_brief(ws, boundary="graph_to_free")
    assert brief["boundary"] == "graph_to_free"
    assert brief["workset_open_count"] == 1
    assert "thread" not in brief
    assert "findings_summary" not in brief


def test_put_get_roundtrip_context():
    ctx = put_workset({}, {"version": 1, "items": [{"id": "x", "family": "t_host", "status": "proposed", "title": "h", "payload": {"host": "a.com"}}], "goal": None})
    ws = get_workset(ctx)
    assert len(ws["items"]) == 1
    assert ws["items"][0]["id"] == "x"
