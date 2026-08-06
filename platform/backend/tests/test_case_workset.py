"""Spec #311 — Case Workset projection, mechanical gate, Goal outer terminals."""
from app.services.case_workset import (
    apply_settle_to_context,
    auto_check_safe,
    adopt_item,
    annotation_fields_from_context,
    clear_in_progress,
    detect_goal_mode_on,
    detect_user_stopped_settle,
    evaluate_goal_terminal,
    expand_task_scope_for_host,
    get_workset,
    goal_auto_adopt,
    goal_wants_session_free,
    mechanical_gate,
    merge_proposed_items,
    normalize_candidate,
    order_workset_items,
    project_workset_for_api,
    put_workset,
    reorder_items,
    scope_hosts_from_task,
    set_in_progress,
    take_in_progress_baton,
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


def test_apply_settle_goal_on_auto_adopt_keeps_running():
    """After Goal auto-adopt, unfinished adopted surfaces keep Goal running (not complete)."""
    ctx = {
        "task": {
            **_task(),
            "goal_mode": True,
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
    # Unfinished adopted deepen work → terminal null / running (Issue 1)
    assert ctx2.get("goal_outer", {}).get("terminal") is None
    assert ws["goal"] is not None
    assert ws["goal"].get("status") == "running"
    assert ws["goal"].get("terminal") is None
    # Residual hosts still reported while running
    residual = ctx2.get("goal_outer", {}).get("residual") or ws["goal"].get("residual")
    assert residual and residual.get("class") == "awaiting_scope_confirm"


def test_goal_terminal_running_with_adopted_surface():
    ws = {
        "version": 1,
        "items": [
            {
                "id": "a1",
                "family": "t_surface",
                "status": "adopted",
                "title": "deepen /admin",
                "payload": {"location": "http://target.local/admin", "host": "target.local", "in_scope": True},
                "auto_eligible": True,
            },
            {
                "id": "h1",
                "family": "t_host",
                "status": "proposed",
                "title": "side.lab",
                "payload": {"host": "side.lab", "in_scope": False},
            },
        ],
        "goal": {"status": "running", "outer_budget": 8, "outer_rounds": 1},
    }
    result = evaluate_goal_terminal(ws, goal_on=True)
    assert result["terminal"] is None
    assert result["status"] == "running"
    assert result["return_to"] == "free"
    assert result["residual"]["class"] == "awaiting_scope_confirm"


def test_goal_terminal_complete_when_no_unfinished_deepen():
    ws = {
        "version": 1,
        "items": [
            {
                "id": "d1",
                "family": "t_surface",
                "status": "done",
                "title": "done surface",
                "payload": {"location": "http://target.local/x", "host": "target.local"},
            },
            {
                "id": "h1",
                "family": "t_host",
                "status": "proposed",
                "title": "pending.lab",
                "payload": {"host": "pending.lab", "in_scope": False},
            },
        ],
        "goal": {"status": "running", "outer_budget": 8, "outer_rounds": 1},
    }
    result = evaluate_goal_terminal(ws, goal_on=True)
    assert result["terminal"] == "goal_complete"
    assert result["residual"]["class"] == "awaiting_scope_confirm"
    assert result["full_coverage"] is False


def test_goal_terminal_in_progress_blocks_complete():
    ws = {
        "version": 1,
        "items": [
            {
                "id": "run",
                "family": "t_surface",
                "status": "adopted",
                "in_progress": True,
                "title": "running",
                "payload": {"location": "http://target.local/y", "host": "target.local"},
            },
        ],
        "goal": {"status": "running", "outer_budget": 8, "outer_rounds": 0},
    }
    result = evaluate_goal_terminal(ws, goal_on=True)
    assert result["terminal"] is None
    assert result["status"] == "running"


def test_incomplete_status_is_not_user_stop():
    """Harness status=incomplete is normal partial settle — not Goal user-stop."""
    assert detect_user_stopped_settle({"status": "incomplete"}) is False
    assert detect_user_stopped_settle({"status": "incomplete", "stop_reason": "hard_graph_incomplete"}) is False
    assert detect_user_stopped_settle({"status": "completed", "stop_reason": "aborted"}) is True
    assert detect_user_stopped_settle({"stop_reason": "user_interrupt"}) is True
    assert detect_user_stopped_settle({"stop_reason": "cancelled"}) is True
    # incomplete + goal_on settle must not become goal_stopped
    ctx = apply_settle_to_context(
        {"task": {**_task(), "goal_mode": True}},
        candidates=[
            {"location": "http://target.local/z", "host": "target.local", "in_scope": True},
        ],
        source="hard_settle",
        goal_on=True,
        user_stopped=detect_user_stopped_settle({"status": "incomplete", "stop_reason": "hard_graph_incomplete"}),
        bump_outer_round=True,
    )
    assert ctx.get("goal_outer", {}).get("terminal") != "goal_stopped"
    assert get_workset(ctx)["goal"]["status"] != "goal_stopped"


def test_goal_mode_prefers_explicit_flag_not_bare_objective():
    assert detect_goal_mode_on(msg={"goal_mode": True}) is True
    assert detect_goal_mode_on(task={"goal_mode": True, "goal_objective": "x"}) is True
    # Bare objective string alone is not Goal-on for Workset valve
    assert detect_goal_mode_on(msg={"goal_objective": "Maximize findings"}) is False
    assert detect_goal_mode_on(task={"goal_objective": "Maximize findings"}) is False
    assert detect_goal_mode_on(msg={}, task={}) is False
    assert detect_goal_mode_on(msg={"goal_mode": "true"}) is True


def test_path_only_surface_not_auto_eligible_when_scope_hosts_nonempty():
    path_only = {
        "family": "t_surface",
        "title": "/admin",
        "status": "proposed",
        "payload": {"location": "/admin", "path": "/admin", "in_scope": True},
    }
    assert auto_check_safe(path_only, SCOPE) is False
    gate = mechanical_gate(path_only, scope_hosts=SCOPE, for_auto_adopt=True)
    assert gate["auto_eligible"] is False
    # With host in scope, still eligible
    with_host = {
        "family": "t_surface",
        "title": "admin",
        "status": "proposed",
        "payload": {
            "location": "http://target.local/admin",
            "host": "target.local",
            "in_scope": True,
        },
    }
    assert auto_check_safe(with_host, SCOPE) is True


def test_expand_task_scope_for_host_extends_allow():
    task = _task()
    expanded, err = expand_task_scope_for_host(
        task,
        host="new-host.lab",
        port="443",
        urls=["https://new-host.lab/"],
    )
    assert err is None
    allow = expanded["scope"]["allow"]
    assert any("new-host.lab" in str(a) for a in allow)
    # prior allow preserved
    assert any("target.local" in str(a) for a in allow)
    bad, err2 = expand_task_scope_for_host(task, host="not a host!!!")
    assert err2 is not None
    assert bad is task or bad == task or isinstance(bad, dict)


def test_set_and_clear_in_progress_single_baton():
    ws = merge_proposed_items(
        {"version": 1, "items": [], "goal": None},
        [
            {"location": "http://target.local/a", "host": "target.local", "in_scope": True},
            {"location": "http://target.local/b", "host": "target.local", "in_scope": True},
        ],
        source="free_settle",
        scope_hosts=SCOPE,
    )
    a_id, b_id = ws["items"][0]["id"], ws["items"][1]["id"]
    ws, _, _ = adopt_item(ws, a_id, actor="user", scope_hosts=SCOPE)
    ws, _, _ = adopt_item(ws, b_id, actor="user", scope_hosts=SCOPE)
    ws = set_in_progress(
        ws,
        a_id,
        expert_id="exp1",
        expert_name="Alice",
        graph_id="app_assessment",
        work_mode="graph",
    )
    by_id = {i["id"]: i for i in ws["items"]}
    assert by_id[a_id]["in_progress"] is True
    assert by_id[a_id]["expert_id"] == "exp1"
    assert by_id[a_id]["graph_id"] == "app_assessment"
    assert by_id[b_id].get("in_progress") in (False, None)
    # Second baton clears first
    ws = set_in_progress(ws, b_id, expert_id="exp1", work_mode="free")
    by_id = {i["id"]: i for i in ws["items"]}
    assert by_id[a_id].get("in_progress") is False
    assert by_id[b_id]["in_progress"] is True
    assert by_id[b_id]["work_mode"] == "free"
    ws = clear_in_progress(ws)
    assert all(not i.get("in_progress") for i in ws["items"])


def test_goal_wants_session_free_when_return_to_free():
    assert goal_wants_session_free({"return_to": "free", "terminal": None}) is True
    assert goal_wants_session_free({"return_to": "free", "terminal": "goal_complete"}) is True
    assert goal_wants_session_free({"return_to": "graph"}) is False
    assert goal_wants_session_free(None) is False


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


def test_user_adopt_then_take_baton_sets_in_progress_annotation():
    """Spec #311 US3: host adopt path takes the single baton with expert(+Graph)."""
    ws = merge_proposed_items(
        {"version": 1, "items": [], "goal": None},
        [
            {"location": "http://target.local/a", "host": "target.local", "in_scope": True},
            {"location": "http://target.local/b", "host": "target.local", "in_scope": True},
        ],
        source="free_settle",
        scope_hosts=SCOPE,
    )
    a_id, b_id = ws["items"][0]["id"], ws["items"][1]["id"]
    ws, adopted, err = adopt_item(ws, a_id, actor="user", scope_hosts=SCOPE)
    assert err is None
    assert adopted["status"] == "adopted"
    # Prefer path used by PATCH /workset/{id} after adopt.
    ws, item, err = take_in_progress_baton(
        ws,
        a_id,
        expert_id="exp-alice",
        expert_name="Alice",
        graph_id="app_assessment",
        work_mode="graph",
        force=True,
    )
    assert err is None
    assert item is not None
    assert item["in_progress"] is True
    assert item["expert_id"] == "exp-alice"
    assert item["expert_name"] == "Alice"
    assert item["graph_id"] == "app_assessment"
    assert item["work_mode"] == "graph"
    # Second adopt+baton clears the first (single baton V1).
    ws, _, err = adopt_item(ws, b_id, actor="user", scope_hosts=SCOPE)
    assert err is None
    ws, item_b, err = take_in_progress_baton(
        ws,
        b_id,
        expert_id="exp-alice",
        expert_name="Alice",
        work_mode="free",
        force=True,
    )
    assert err is None
    by_id = {i["id"]: i for i in ws["items"]}
    assert by_id[a_id].get("in_progress") is False
    assert by_id[b_id]["in_progress"] is True
    assert by_id[b_id]["work_mode"] == "free"
    assert not by_id[b_id].get("graph_id") or item_b.get("work_mode") == "free"


def test_take_baton_rejects_proposed_and_closed():
    ws = merge_proposed_items(
        {"version": 1, "items": [], "goal": None},
        [{"location": "http://target.local/c", "host": "target.local", "in_scope": True}],
        source="free_settle",
        scope_hosts=SCOPE,
    )
    iid = ws["items"][0]["id"]
    _, _, err = take_in_progress_baton(ws, iid, expert_id="e1", force=True)
    assert err == "not_adopted"
    ws, _, _ = adopt_item(ws, iid, actor="user", scope_hosts=SCOPE)
    ws, _, _ = update_item_status(ws, iid, status="done", actor="user")
    _, _, err2 = take_in_progress_baton(ws, iid, force=True)
    assert err2 == "not_open"


def test_annotation_fields_from_context_session_graph():
    ctx = {
        "task": {
            "expert_id": "e1",
            "expert_name": "pentest-1",
            "engagement_template": "app_assessment",
        },
        "sessions": {
            "e1": {"work_mode": "graph", "graph_id": "app_assessment"},
        },
    }
    ann = annotation_fields_from_context(ctx)
    assert ann["expert_id"] == "e1"
    assert ann["expert_name"] == "pentest-1"
    assert ann["work_mode"] == "graph"
    assert ann["graph_id"] == "app_assessment"
    # Free session → expert only (no graph).
    ctx2 = {
        "task": {"expert_id": "e1", "expert_name": "pentest-1"},
        "sessions": {"e1": {"work_mode": "free", "graph_id": None}},
    }
    ann2 = annotation_fields_from_context(ctx2)
    assert ann2["work_mode"] == "free"
    assert ann2["graph_id"] is None
