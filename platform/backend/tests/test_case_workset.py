"""Spec #311 — Case Workset projection, mechanical gate, Goal outer terminals."""
from app.services.case_workset import (
    apply_intake_enroll_to_context,
    apply_settle_to_context,
    auto_check_safe,
    adopt_item,
    annotation_fields_from_context,
    clear_in_progress,
    detect_goal_mode_explicit_off,
    detect_goal_mode_on,
    detect_turn_cancelled_settle,
    detect_user_stopped_settle,
    evaluate_goal_terminal,
    expand_task_scope_for_host,
    get_asset_intake,
    get_workset,
    goal_auto_adopt,
    goal_wants_session_free,
    intake_enroll_eligible,
    mechanical_gate,
    merge_proposed_into_context,
    merge_proposed_items,
    materialize_intake_hosts,
    normalize_asset_intake,
    normalize_candidate,
    order_workset_items,
    project_workset_for_api,
    put_asset_intake,
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


def test_passive_exposure_keeps_source_fields_and_never_auto_adopts():
    from app.services.case_workset import is_passive_exposure_item, merge_proposed_into_context

    item = normalize_candidate(
        {
            "host": "cdn.example.com",
            "in_scope": False,
            "intel_source": "ct",
            "attribution": "crt.sh SAN cdn.example.com 2026-01-01",
            "confidence": "medium",
            "scope_decision": "pending",
            "passive": True,
        },
        source="workset_propose",
        scope_hosts=SCOPE,
    )
    assert item is not None
    assert item["family"] == "t_host"
    assert item["status"] == "proposed"
    assert item["auto_eligible"] is False
    assert is_passive_exposure_item(item) is True
    payload = item["payload"]
    assert payload["intel_source"] == "ct"
    assert "crt.sh" in payload["attribution"]
    assert payload["confidence"] == "medium"
    assert payload["scope_decision"] == "pending"
    assert payload["passive"] is True

    # Even an in-scope-looking t_surface from CT must not Goal-adopt.
    surface = normalize_candidate(
        {
            "location": "https://target.local/",
            "host": "target.local",
            "in_scope": True,
            "intel_source": "dns",
            "attribution": "passive DNS A record",
            "confidence": "high",
        },
        source="workset_propose",
        scope_hosts=SCOPE,
    )
    assert surface is not None
    assert surface["family"] == "t_surface"
    assert surface["auto_eligible"] is False
    ws = merge_proposed_items(
        {"version": 1, "items": [], "goal": None},
        [surface, item],
        source="workset_propose",
        scope_hosts=SCOPE,
    )
    ws2, adopted = goal_auto_adopt(ws, scope_hosts=SCOPE, goal_on=True)
    assert adopted == []
    assert all(i["status"] == "proposed" for i in ws2["items"])

    ctx = merge_proposed_into_context(
        {"task": _task()},
        [{"host": "mail.example.com", "intel_source": "shodan", "attribution": "shodan:443", "passive": True}],
        source="workset_propose",
    )
    parked = get_workset(ctx)["items"]
    assert len(parked) == 1
    assert parked[0]["auto_eligible"] is False
    assert parked[0]["payload"]["intel_source"] == "shodan"
    assert get_workset(ctx).get("goal") is None


def test_settle_legacy_arrays_collapse_into_workset_and_are_dropped():
    from app.services.case_workset import list_workset_for_agent

    ctx = {
        "task": _task(),
        "next_scope_candidates": [{"host": "side.lab", "in_scope": False}],
        "attack_surface_candidates": [{"host": "side.lab", "in_scope": False}],
        "next_scope_suggested": True,
    }
    ctx2 = apply_settle_to_context(
        ctx,
        candidates=[
            {
                "host": "side.lab",
                "in_scope": False,
                "intel_source": "ct",
                "attribution": "crt.sh SAN",
                "passive": True,
            }
        ],
        next_scope_candidates=[{"host": "side.lab", "in_scope": False}],
        attack_surface_candidates=[{"host": "side.lab", "in_scope": False}],
        source="free_settle",
        goal_on=False,
    )
    items = [i for i in get_workset(ctx2)["items"] if i["family"] == "t_host"]
    assert len(items) == 1
    assert items[0]["payload"]["host"] == "side.lab"
    assert items[0]["payload"]["intel_source"] == "ct"
    assert "next_scope_candidates" not in ctx2
    assert "attack_surface_candidates" not in ctx2
    listed = list_workset_for_agent(get_workset(ctx2), needle="side")
    assert listed["total"] == 1
    assert listed["items"][0]["intel_source"] == "ct"
    rejected = {
        "version": 1,
        "items": items
        + [
            {
                "id": "old",
                "family": "t_host",
                "status": "rejected",
                "title": "gone.lab",
                "payload": {"host": "gone.lab"},
            }
        ],
        "goal": None,
    }
    open_only = list_workset_for_agent(rejected)
    assert all(i["id"] != "old" for i in open_only["items"])
    by_id = list_workset_for_agent(rejected, item_id="old")
    assert by_id["items"][0]["id"] == "old"


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
    # Grok: turn cancel keeps Goal running even on empty workset (no premature complete).
    cancelled = evaluate_goal_terminal(base, goal_on=True, turn_cancelled=True)
    assert cancelled["terminal"] is None
    assert cancelled["status"] == "running"
    assert cancelled["goal"]["status"] == "running"


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
    # Grok-aligned: abort/interrupt/cancel = turn cancel, not Goal-off.
    assert detect_user_stopped_settle({"status": "completed", "stop_reason": "aborted"}) is False
    assert detect_user_stopped_settle({"stop_reason": "user_interrupt"}) is False
    assert detect_user_stopped_settle({"stop_reason": "cancelled"}) is False
    assert detect_turn_cancelled_settle({"stop_reason": "aborted"}) is True
    assert detect_turn_cancelled_settle({"stop_reason": "user_interrupt"}) is True
    assert detect_turn_cancelled_settle({"stop_reason": "cancelled"}) is True
    assert detect_user_stopped_settle({"user_stopped": True}) is True
    assert detect_user_stopped_settle({"stop_reason": "goal_clear"}) is True
    assert detect_turn_cancelled_settle({"user_stopped": True, "stop_reason": "aborted"}) is False
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


def test_turn_cancel_keeps_goal_running_and_reopens_sticky_stopped():
    """Esc/abort settle keeps Case Goal outer open (Grok: turn cancel ≠ goal stop)."""
    msg = {"stop_reason": "aborted", "status": "incomplete"}
    assert detect_user_stopped_settle(msg) is False
    assert detect_turn_cancelled_settle(msg) is True
    ctx = apply_settle_to_context(
        {
            "task": {**_task(), "goal_mode": True, "goal_objective": "maximize findings"},
            "workset": {
                "version": 1,
                "items": [],
                "goal": {
                    "status": "goal_stopped",
                    "terminal": "goal_stopped",
                    "outer_budget": 8,
                    "outer_rounds": 1,
                    "objective": "maximize findings",
                },
            },
        },
        candidates=[],
        source="free_settle",
        goal_on=True,
        user_stopped=detect_user_stopped_settle(msg),
        turn_cancelled=detect_turn_cancelled_settle(msg),
        bump_outer_round=True,
    )
    assert ctx.get("goal_outer", {}).get("terminal") is None
    g = get_workset(ctx)["goal"]
    assert g["status"] == "running"
    assert g.get("terminal") is None
    # turn-cancel must not burn outer_rounds
    assert int(g.get("outer_rounds") or 0) == 1


def test_parked_continue_reopens_sticky_goal_stopped():
    """Legacy sticky goal_stopped + parked_continue settle with goal_on reopens running."""
    ctx = apply_settle_to_context(
        {
            "task": {**_task(), "goal_mode": True, "goal_objective": "maximize findings"},
            "workset": {
                "version": 1,
                "items": [],
                "goal": {
                    "status": "goal_stopped",
                    "terminal": "goal_stopped",
                    "outer_budget": 8,
                    "outer_rounds": 2,
                    "objective": "maximize findings",
                },
            },
        },
        candidates=[
            {"location": "http://target.local/a", "host": "target.local", "in_scope": True},
        ],
        source="free_settle",
        goal_on=True,
        user_stopped=False,
        turn_cancelled=False,
        bump_outer_round=True,
    )
    g = get_workset(ctx)["goal"]
    assert g["status"] != "goal_stopped"
    assert int(g.get("outer_rounds") or 0) == 3  # natural settle may bump


def test_goal_explicit_off_stops_goal():
    assert detect_goal_mode_explicit_off({"goal_mode": False}) is True
    assert detect_goal_mode_explicit_off({"goal_mode": True}) is False
    assert detect_goal_mode_explicit_off({}) is False
    ctx = apply_settle_to_context(
        {
            "task": {**_task(), "goal_mode": False},
            "workset": {
                "version": 1,
                "items": [],
                "goal": {
                    "status": "running",
                    "outer_budget": 8,
                    "outer_rounds": 1,
                    "objective": "maximize findings",
                },
            },
        },
        candidates=[],
        source="free_settle",
        goal_on=False,
        user_stopped=True,
        goal_explicit_off=True,
        bump_outer_round=False,
    )
    assert get_workset(ctx)["goal"]["status"] == "goal_stopped"
    assert ctx.get("goal_outer", {}).get("terminal") == "goal_stopped"


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
    assert brief["workset_open"][0].get("host") == "target.local"
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


def _passive_host(host: str, **extra):
    payload = {
        "host": host,
        "in_scope": False,
        "passive": True,
        "intel_source": extra.get("intel_source", "ct"),
        "attribution": extra.get("attribution", "crt.sh SAN"),
        "confidence": extra.get("confidence", "high"),
        "scope_decision": extra.get("scope_decision", "pending"),
    }
    return {
        "family": "t_host",
        "title": host,
        "host": host,
        "in_scope": False,
        "passive": True,
        **payload,
    }


def test_intake_default_is_ask():
    assert normalize_asset_intake(None)["mode"] == "ask"
    assert get_asset_intake({})["mode"] == "ask"
    ctx = put_asset_intake({}, {"mode": "enroll_group", "group_id": "g1", "group_name": "example公司"})
    got = get_asset_intake(ctx)
    assert got["mode"] == "enroll_group"
    assert got["group_id"] == "g1"
    assert got["group_name"] == "example公司"


def test_intake_enroll_group_requires_group():
    bad = normalize_asset_intake({"mode": "enroll_group"})
    assert bad["mode"] == "ask"
    ok = normalize_asset_intake({"mode": "enroll_group", "group_name": "example公司"})
    assert ok["mode"] == "enroll_group"
    assert ok["group_name"] == "example公司"


def test_intake_eligible_skips_low_oos_surface():
    policy = normalize_asset_intake({"mode": "enroll_group", "group_id": "g1"})
    ws = merge_proposed_items(
        {"version": 1, "items": [], "goal": None},
        [_passive_host("mail.example.com", confidence="high")],
        source="workset_propose",
        scope_hosts=SCOPE,
    )
    item = ws["items"][0]
    assert intake_enroll_eligible(item, policy) is True
    item["payload"]["confidence"] = "low"
    assert intake_enroll_eligible(item, policy) is False
    item["payload"]["confidence"] = "high"
    item["payload"]["scope_decision"] = "out_of_scope"
    assert intake_enroll_eligible(item, policy) is False
    surface = {
        "family": "t_surface",
        "status": "proposed",
        "title": "/admin",
        "payload": {"location": "http://target.local/admin", "host": "target.local", "in_scope": True},
    }
    assert intake_enroll_eligible(surface, policy) is False
    assert intake_enroll_eligible(item, {"mode": "ask"}) is False


def test_intake_enroll_adopts_t_host_and_expands_scope():
    ctx = put_asset_intake(
        {"task": _task()},
        {"mode": "enroll_group", "group_id": "g1", "group_name": "example公司"},
    )
    ctx = merge_proposed_into_context(
        ctx,
        [_passive_host("mail.example.com", confidence="high", scope_decision="in_scope")],
        source="workset_propose",
    )
    ws = get_workset(ctx)
    assert len(ws["items"]) == 1
    assert ws["items"][0]["status"] == "proposed"
    assert "mail.example.com" not in scope_hosts_from_task(ctx["task"])
    aid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

    async def fake_create(*_a, **_k):
        return {"ok": True, "assets": [{"id": aid}]}

    import app.services.node_ledger as nl

    orig = nl.create_hosts_for_user
    nl.create_hosts_for_user = fake_create
    try:
        import asyncio

        ctx = asyncio.run(
            materialize_intake_hosts(object(), user_id="u", conversation_id="c", context=ctx)
        )
    finally:
        nl.create_hosts_for_user = orig
    item = get_workset(ctx)["items"][0]
    assert item["status"] == "adopted"
    assert item["status_actor"] == "intake_policy"
    assert item["payload"]["intake_asset_id"] == aid
    assert "mail.example.com" in scope_hosts_from_task(ctx["task"])
    assert aid in (ctx["task"]["scope"].get("asset_ids") or [])


def test_expand_task_scope_records_host_asset_id():
    aid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    task, err = expand_task_scope_for_host(_task(), host="mail.example.com", asset_id=aid)
    assert err is None
    assert "mail.example.com" in scope_hosts_from_task(task)
    assert aid in task["scope"]["asset_ids"]


def test_intake_ask_leaves_passive_proposed():
    ctx = merge_proposed_into_context(
        {"task": _task()},
        [_passive_host("mail.example.com")],
        source="workset_propose",
    )
    ws = get_workset(ctx)
    assert ws["items"][0]["status"] == "proposed"


def test_intake_skips_low_confidence_and_oos():
    ctx = put_asset_intake(
        {"task": _task()},
        {"mode": "enroll_group", "group_id": "g1"},
    )
    ctx = merge_proposed_into_context(
        ctx,
        [
            _passive_host("low.example.com", confidence="low"),
            _passive_host("cdn.cloudflare.com", scope_decision="out_of_scope", confidence="high"),
            _passive_host("vpn.example.com", confidence="medium", scope_decision="pending"),
        ],
        source="workset_propose",
    )
    by_host = {i["payload"]["host"]: i for i in get_workset(ctx)["items"]}
    assert by_host["low.example.com"]["status"] == "proposed"
    assert by_host["cdn.cloudflare.com"]["status"] == "proposed"
    assert by_host["vpn.example.com"]["status"] == "proposed"
    assert "vpn.example.com" not in scope_hosts_from_task(ctx["task"])
    assert "low.example.com" not in scope_hosts_from_task(ctx["task"])


def test_goal_still_never_auto_adopts_t_host_when_intake_is_ask():
    ws = merge_proposed_items(
        {"version": 1, "items": [], "goal": None},
        [_passive_host("mail.example.com", confidence="high")],
        source="workset_propose",
        scope_hosts=SCOPE,
    )
    ws2, adopted = goal_auto_adopt(ws, scope_hosts=SCOPE, goal_on=True)
    assert adopted == []
    assert ws2["items"][0]["status"] == "proposed"


def test_agent_still_cannot_self_adopt_intake_items():
    ctx = put_asset_intake({"task": _task()}, {"mode": "ask"})
    ctx = merge_proposed_into_context(ctx, [_passive_host("mail.example.com")], source="workset_propose")
    iid = get_workset(ctx)["items"][0]["id"]
    _, _, err = adopt_item(get_workset(ctx), iid, actor="agent")
    assert err == "agent_cannot_self_adopt"


def test_apply_intake_enroll_is_idempotent():
    ctx = put_asset_intake(
        {"task": _task()},
        {"mode": "enroll_group", "group_id": "g1"},
    )
    ctx = merge_proposed_into_context(ctx, [_passive_host("mail.example.com")], source="workset_propose")
    ctx2, enrolled = apply_intake_enroll_to_context(ctx)
    assert enrolled == []
    assert get_workset(ctx2)["items"][0]["status"] == "proposed"


def test_settle_respects_intake_policy():
    ctx = put_asset_intake({"task": _task()}, {"mode": "enroll_group", "group_id": "g1"})
    ctx = apply_settle_to_context(
        ctx,
        candidates=[_passive_host("api.example.com", confidence="high")],
        source="free_settle",
        goal_on=False,
    )
    item = get_workset(ctx)["items"][0]
    assert item["status"] == "proposed"
    assert "api.example.com" not in scope_hosts_from_task(ctx["task"])


def test_materialize_create_failure_leaves_proposed():
    ctx = put_asset_intake(
        {"task": _task()},
        {"mode": "enroll_group", "group_id": "g1"},
    )
    ctx = merge_proposed_into_context(
        ctx,
        [_passive_host("ghost.example.com", confidence="high")],
        source="workset_propose",
    )
    from app.services.node_ledger import NodeLedgerError
    import app.services.node_ledger as nl
    import asyncio

    async def fake_fail(*_a, **_k):
        raise NodeLedgerError("group missing", status_code=400)

    orig = nl.create_hosts_for_user
    nl.create_hosts_for_user = fake_fail
    try:
        ctx = asyncio.run(
            materialize_intake_hosts(object(), user_id="u", conversation_id="c", context=ctx)
        )
    finally:
        nl.create_hosts_for_user = orig
    item = get_workset(ctx)["items"][0]
    assert item["status"] == "proposed"
    assert "ghost.example.com" not in scope_hosts_from_task(ctx["task"])
    assert not (ctx.get("task") or {}).get("scope", {}).get("asset_ids")


def test_materialize_reopens_legacy_adopted_when_create_fails():
    ctx = put_asset_intake(
        {"task": _task()},
        {"mode": "enroll_group", "group_id": "g1"},
    )
    ctx = merge_proposed_into_context(
        ctx,
        [_passive_host("stale.example.com", confidence="high")],
        source="workset_propose",
    )
    iid = get_workset(ctx)["items"][0]["id"]
    ws, found, err = adopt_item(get_workset(ctx), iid, actor="intake_policy")
    assert err is None and found
    ctx = put_workset(ctx, ws)
    from app.services.node_ledger import NodeLedgerError
    import app.services.node_ledger as nl
    import asyncio

    async def fake_fail(*_a, **_k):
        raise NodeLedgerError("create failed", status_code=400)

    orig = nl.create_hosts_for_user
    nl.create_hosts_for_user = fake_fail
    try:
        ctx = asyncio.run(
            materialize_intake_hosts(object(), user_id="u", conversation_id="c", context=ctx)
        )
    finally:
        nl.create_hosts_for_user = orig
    assert get_workset(ctx)["items"][0]["status"] == "proposed"


def test_workset_routes_require_bound_node():
    from types import SimpleNamespace
    from uuid import uuid4

    from fastapi import HTTPException

    from app.api.node_ledger import require_conversation_bound_to_node

    nid = uuid4()
    require_conversation_bound_to_node(SimpleNamespace(node_id=nid), SimpleNamespace(id=nid))
    try:
        require_conversation_bound_to_node(SimpleNamespace(node_id=None), SimpleNamespace(id=nid))
        raise AssertionError("unbound conversation must 403")
    except HTTPException as e:
        assert e.status_code == 403
    try:
        require_conversation_bound_to_node(SimpleNamespace(node_id=uuid4()), SimpleNamespace(id=nid))
        raise AssertionError("foreign node must 403")
    except HTTPException as e:
        assert e.status_code == 403

