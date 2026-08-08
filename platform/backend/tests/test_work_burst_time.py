"""S2 work-burst time ledger — Spec #325.

External behaviors: union math, authorize gap, retry merge, fail-closes-interval,
B1 finalized persistence / reload.
"""
from app.services.work_burst_time import (
    apply_authorize_pause,
    apply_worker_transition,
    ensure_burst,
    finalize_burst,
    get_ledger,
    live_work_seconds,
    projection,
    set_ledger,
    union_length_seconds,
    worker_busy_end,
    worker_busy_start,
    work_seconds_for_burst,
    work_seconds_for_task,
)


def test_union_length_overlapping_not_sum():
    # Main 0–600s, Sub A 60–480, Sub B 120–540 → union = 600 not 600+420+420
    intervals = [
        (0.0, 600.0),
        (60.0, 480.0),
        (120.0, 540.0),
    ]
    assert union_length_seconds(intervals) == 600.0


def test_union_length_disjoint_adds():
    assert union_length_seconds([(0.0, 10.0), (20.0, 30.0)]) == 20.0


def test_e1_case_started_write_once():
    ctx = {}
    ctx = apply_worker_transition(
        ctx, worker_key="node-a", working=True, task_id="t1", now=1_000.0
    )
    ledger = get_ledger(ctx)
    first = ledger["case_started_at"]
    assert first
    # Later burst must not rewrite Case start
    ctx = apply_worker_transition(
        ctx, worker_key="node-a", working=False, task_id="t1", now=1_100.0
    )
    ctx = apply_worker_transition(
        ctx, worker_key="node-a", working=True, task_id="t2", now=2_000.0
    )
    ledger = get_ledger(ctx)
    assert ledger["case_started_at"] == first
    # Also mirrored onto case_run when empty
    assert ctx.get("case_run", {}).get("started_at") == first


def test_parallel_workers_use_union_not_sum():
    """Main∥Sub busy windows → work_seconds is union length."""
    ctx = {}
    # Main busy [0, 600]
    ctx = apply_worker_transition(
        ctx, worker_key="main", working=True, task_id="t1", now=0.0
    )
    # Sub overlaps [100, 500]
    ctx = apply_worker_transition(
        ctx, worker_key="sub_1", working=True, task_id="t1", now=100.0
    )
    ctx = apply_worker_transition(
        ctx, worker_key="sub_1", working=False, task_id="t1", now=500.0, finalize_if_idle=False
    )
    ctx = apply_worker_transition(
        ctx, worker_key="main", working=False, task_id="t1", now=600.0
    )
    ledger = get_ledger(ctx)
    bid = next(iter(ledger["bursts"]))
    assert work_seconds_for_burst(ledger, bid) == 600
    # Not 600 + 400
    assert work_seconds_for_burst(ledger, bid) != 1000


def test_h1_authorize_gap_excluded():
    """Pending authorize does not advance work seconds."""
    ctx = {}
    ctx = apply_worker_transition(
        ctx, worker_key="node-a", working=True, task_id="t1", now=0.0
    )
    # Busy 0–100 then authorize pause
    ctx = apply_authorize_pause(ctx, paused=True, now=100.0)
    # Gap 100–400 would have been wall time — must not count
    live_mid = live_work_seconds(get_ledger(ctx), now=400.0)
    assert live_mid == 100
    # Resume work at 400, settle at 500 → total 200
    ctx = apply_authorize_pause(ctx, paused=False, now=400.0)
    ctx = apply_worker_transition(
        ctx, worker_key="node-a", working=False, task_id="t1", now=500.0
    )
    ledger = get_ledger(ctx)
    bid = next(b for b, r in ledger["bursts"].items() if r.get("status") == "finalized")
    assert work_seconds_for_burst(ledger, bid) == 200


def test_r1_same_message_retry_shares_burst():
    """Same-user-message auto-retry keeps one work_burst_id (including after fail finalize)."""
    ctx = {}
    ctx = apply_worker_transition(
        ctx,
        worker_key="node-a",
        working=True,
        task_id="t1",
        user_message_key="umsg-1",
        now=0.0,
    )
    ledger = get_ledger(ctx)
    bid1 = ledger["active_burst_id"]
    # Fail settles (closes interval + finalizes) — Case stays open
    ctx = apply_worker_transition(
        ctx, worker_key="node-a", working=False, task_id="t1", now=50.0
    )
    assert get_ledger(ctx)["bursts"][bid1]["status"] == "finalized"
    # Auto-retry re-dispatch: new task_id, same user message → same burst clock
    ctx = apply_worker_transition(
        ctx,
        worker_key="node-a",
        working=True,
        task_id="t1-retry",
        user_message_key="umsg-1",
        now=60.0,
    )
    ledger = get_ledger(ctx)
    assert ledger["active_burst_id"] == bid1
    tasks = ledger["bursts"][bid1]["task_ids"]
    assert "t1" in tasks and "t1-retry" in tasks
    ctx = apply_worker_transition(
        ctx, worker_key="node-a", working=False, task_id="t1-retry", now=100.0
    )
    ledger = get_ledger(ctx)
    # Union: [0,50] U [60,100] = 90
    assert work_seconds_for_burst(ledger, bid1) == 90
    assert work_seconds_for_task(ledger, "t1-retry") == 90


def test_fail_closes_interval_without_closing_case():
    """API/fail finalizes burst seconds; case_started_at retained (Case not closed)."""
    ctx = {}
    ctx = apply_worker_transition(
        ctx, worker_key="node-a", working=True, task_id="t1", now=10.0
    )
    started = get_ledger(ctx)["case_started_at"]
    # Fail/error path: worker idle + finalize
    ctx = apply_worker_transition(
        ctx, worker_key="node-a", working=False, task_id="t1", now=70.0
    )
    ledger = get_ledger(ctx)
    assert ledger["case_started_at"] == started
    assert ledger["active_burst_id"] is None
    bid = next(iter(ledger["bursts"]))
    assert ledger["bursts"][bid]["status"] == "finalized"
    assert work_seconds_for_burst(ledger, bid) == 60
    # Case remains open: ledger still present, new burst can start
    ctx = apply_worker_transition(
        ctx, worker_key="node-a", working=True, task_id="t2", now=200.0
    )
    assert get_ledger(ctx)["case_started_at"] == started
    assert get_ledger(ctx)["active_burst_id"] is not None


def test_b1_finalized_persistence_reload():
    """Reload projection returns same finalized work_seconds per burst id."""
    ctx = {}
    ctx = apply_worker_transition(
        ctx, worker_key="main", working=True, task_id="t9", now=0.0
    )
    ctx = apply_worker_transition(
        ctx, worker_key="main", working=False, task_id="t9", now=42.0
    )
    # Simulate persist → reload: only context JSON survives
    persisted = dict(ctx)
    ledger = get_ledger(persisted)
    proj = projection(ledger, now=999.0)
    bid = next(b for b, r in ledger["bursts"].items() if r.get("status") == "finalized")
    assert proj["finalized_work_seconds"][bid] == 42
    assert proj["finalized_work_seconds"]["task:t9"] == 42
    assert proj["live_work_seconds"] is None
    assert proj["active_burst_id"] is None
    # Second load identical
    proj2 = projection(get_ledger(persisted), now=5000.0)
    assert proj2["finalized_work_seconds"][bid] == 42


def test_composer_live_accrues_and_pauses():
    ctx = {}
    ctx = apply_worker_transition(
        ctx, worker_key="n1", working=True, task_id="t1", now=0.0
    )
    assert live_work_seconds(get_ledger(ctx), now=30.0) == 30
    proj = projection(get_ledger(ctx), now=30.0)
    assert proj["accruing"] is True
    assert proj["authorize_paused"] is False
    ctx = apply_authorize_pause(ctx, paused=True, now=30.0)
    assert live_work_seconds(get_ledger(ctx), now=90.0) == 30
    proj = projection(get_ledger(ctx), now=90.0)
    assert proj["accruing"] is False
    assert proj["authorize_paused"] is True


def test_ensure_burst_new_user_message_after_finalize():
    ledger = {}
    ledger, b1 = ensure_burst(ledger, task_id="t1", user_message_key="m1", now=0.0)
    ledger = worker_busy_start(ledger, worker_key="n", task_id="t1", now=0.0)
    ledger = finalize_burst(ledger, burst_id=b1, now=10.0)
    ledger, b2 = ensure_burst(ledger, task_id="t2", user_message_key="m2", now=20.0)
    assert b1 != b2


def test_set_ledger_does_not_overwrite_existing_case_run_start():
    ctx = {"case_run": {"started_at": "2020-01-01T00:00:00Z", "llm_usage": {}}}
    ledger = get_ledger({})
    ledger, _ = ensure_burst(ledger, task_id="t1", now=1_700_000_000.0)
    ctx = set_ledger(ctx, ledger)
    assert ctx["case_run"]["started_at"] == "2020-01-01T00:00:00Z"
