"""Work-burst time ledger (Spec #323 / #325 seam S2).

Busy-interval accounting for Case work-seconds:

- **E1** write-once Case work start on first work-burst enter
- **S** work seconds = busy intervals (not wall-clock now − start)
- **U** parallel Main/Sub → union of intervals, not sum
- **H1** pending user authorize is not busy
- **R1** same-user-message auto-retries share one work_burst_id
- API/fail closes current interval and finalizes burst seconds; Case stays open

Ledger lives on ``conversation.context["work_burst_ledger"]``. Composer timer and
B1 result-anchor duration are views of this seam, not independent clocks.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _as_dict(value: object) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def parse_ts(value: object) -> float | None:
    """Parse ISO timestamp (or epoch seconds/ms) to epoch seconds (float)."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        n = float(value)
        # Heuristic: ms vs s
        if n > 1e12:
            return n / 1000.0
        return n
    text = str(value).strip()
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        return datetime.fromisoformat(text).timestamp()
    except ValueError:
        try:
            return float(text)
        except ValueError:
            return None


def union_length_seconds(intervals: list[tuple[float, float]]) -> float:
    """Return total length of the union of half-open [start, end) intervals."""
    cleaned: list[tuple[float, float]] = []
    for start, end in intervals:
        if end is None or start is None:
            continue
        if end <= start:
            continue
        cleaned.append((float(start), float(end)))
    if not cleaned:
        return 0.0
    cleaned.sort(key=lambda x: x[0])
    total = 0.0
    cur_s, cur_e = cleaned[0]
    for s, e in cleaned[1:]:
        if s <= cur_e:
            if e > cur_e:
                cur_e = e
        else:
            total += cur_e - cur_s
            cur_s, cur_e = s, e
    total += cur_e - cur_s
    return total


def merge_interval(
    intervals: list[list[float]],
    start: float,
    end: float,
) -> list[list[float]]:
    """Append [start, end] then return merged union list as [[s,e], ...]."""
    if end <= start:
        return [list(x) for x in intervals]
    pairs = [(float(a[0]), float(a[1])) for a in intervals if len(a) >= 2]
    pairs.append((start, end))
    pairs.sort(key=lambda x: x[0])
    out: list[list[float]] = []
    cs, ce = pairs[0]
    for s, e in pairs[1:]:
        if s <= ce:
            if e > ce:
                ce = e
        else:
            out.append([cs, ce])
            cs, ce = s, e
    out.append([cs, ce])
    return out


def empty_ledger() -> dict[str, Any]:
    return {
        "case_started_at": None,
        "active_burst_id": None,
        "bursts": {},
    }


def get_ledger(context: dict | None) -> dict[str, Any]:
    ctx = _as_dict(context)
    raw = ctx.get("work_burst_ledger")
    if not isinstance(raw, dict):
        return empty_ledger()
    ledger = empty_ledger()
    ledger["case_started_at"] = raw.get("case_started_at") or None
    ledger["active_burst_id"] = raw.get("active_burst_id") or None
    bursts = raw.get("bursts")
    if isinstance(bursts, dict):
        for key, value in bursts.items():
            if isinstance(value, dict) and str(key).strip():
                ledger["bursts"][str(key)] = dict(value)
    return ledger


def set_ledger(context: dict | None, ledger: dict[str, Any]) -> dict[str, Any]:
    ctx = dict(context or {})
    ctx["work_burst_ledger"] = ledger
    # Mirror write-once Case start onto case_run when present (E1 surface).
    started = str(ledger.get("case_started_at") or "").strip()
    if started:
        case_run = _as_dict(ctx.get("case_run"))
        if not str(case_run.get("started_at") or "").strip():
            case_run["started_at"] = started
            ctx["case_run"] = case_run
    return ctx


def _new_burst_id() -> str:
    return f"wb_{uuid.uuid4().hex[:16]}"


def _burst_row(burst_id: str, **extra: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": burst_id,
        "task_ids": [],
        "status": "open",
        "intervals": [],  # closed [[start_epoch, end_epoch], ...]
        "open_workers": {},  # worker_key → start_epoch
        "authorize_paused": False,
        "work_seconds": None,
        "user_message_key": None,
        "finalized_at": None,
    }
    row.update(extra)
    return row


def ensure_burst(
    ledger: dict[str, Any],
    *,
    task_id: object = None,
    user_message_key: object = None,
    now: float | None = None,
    reuse_active: bool = True,
) -> tuple[dict[str, Any], str]:
    """Return (ledger, burst_id), creating or reusing a work-burst (R1).

    R1: when an open active burst exists and reuse_active, merge new task_id into it
    (same-message auto-retry / re-dispatch without settle).
    Also reuse when user_message_key matches the active open burst.
    """
    ledger = {
        "case_started_at": ledger.get("case_started_at"),
        "active_burst_id": ledger.get("active_burst_id"),
        "bursts": dict(ledger.get("bursts") or {}),
    }
    tid = str(task_id or "").strip()
    umk = str(user_message_key or "").strip() or None
    active_id = str(ledger.get("active_burst_id") or "").strip() or None
    bursts: dict[str, Any] = ledger["bursts"]

    # Prefer matching open burst by task_id already registered.
    if tid:
        for bid, row in bursts.items():
            if not isinstance(row, dict):
                continue
            if str(row.get("status") or "") != "open":
                continue
            tasks = row.get("task_ids") if isinstance(row.get("task_ids"), list) else []
            if tid in {str(t) for t in tasks}:
                ledger["active_burst_id"] = bid
                return ledger, bid

    if reuse_active and active_id and active_id in bursts:
        row = dict(bursts[active_id])
        if str(row.get("status") or "") == "open":
            # R1: same user message key → same burst
            prev_key = str(row.get("user_message_key") or "").strip() or None
            if umk and prev_key and umk == prev_key:
                tasks = list(row.get("task_ids") or [])
                if tid and tid not in tasks:
                    tasks.append(tid)
                    row["task_ids"] = tasks
                bursts[active_id] = row
                ledger["bursts"] = bursts
                return ledger, active_id
            # Default reuse while still open (retry / re-dispatch before settle)
            if umk is None or prev_key is None or umk == prev_key:
                tasks = list(row.get("task_ids") or [])
                if tid and tid not in tasks:
                    tasks.append(tid)
                    row["task_ids"] = tasks
                if umk and not prev_key:
                    row["user_message_key"] = umk
                bursts[active_id] = row
                ledger["bursts"] = bursts
                return ledger, active_id

    # R1: same-user-message auto-retry after a terminal fail that already finalized —
    # reopen that burst so busy intervals merge into one clock.
    if umk:
        for bid, existing in bursts.items():
            if not isinstance(existing, dict):
                continue
            if str(existing.get("user_message_key") or "").strip() != umk:
                continue
            if str(existing.get("status") or "") != "finalized":
                # Open burst with this key but not active — adopt it
                if str(existing.get("status") or "") == "open":
                    row = dict(existing)
                    tasks = list(row.get("task_ids") or [])
                    if tid and tid not in tasks:
                        tasks.append(tid)
                        row["task_ids"] = tasks
                    bursts[bid] = row
                    ledger["bursts"] = bursts
                    ledger["active_burst_id"] = bid
                    return ledger, bid
                continue
            row = dict(existing)
            row["status"] = "open"
            row["work_seconds"] = None
            row["finalized_at"] = None
            row["authorize_paused"] = False
            row["open_workers"] = {}
            row["paused_workers"] = {}
            # B1 will re-attach after final success/abandon
            row["result_anchor_message_id"] = None
            tasks = list(row.get("task_ids") or [])
            if tid and tid not in tasks:
                tasks.append(tid)
            row["task_ids"] = tasks
            bursts[bid] = row
            ledger["bursts"] = bursts
            ledger["active_burst_id"] = bid
            return ledger, bid

    # New burst
    bid = _new_burst_id()
    row = _burst_row(
        bid,
        task_ids=[tid] if tid else [],
        user_message_key=umk,
    )
    bursts[bid] = row
    ledger["bursts"] = bursts
    ledger["active_burst_id"] = bid
    # E1: write-once Case work start
    if not str(ledger.get("case_started_at") or "").strip():
        ts = now if now is not None else datetime.now(timezone.utc).timestamp()
        ledger["case_started_at"] = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace(
            "+00:00", "Z"
        )
    return ledger, bid


def worker_busy_start(
    ledger: dict[str, Any],
    *,
    worker_key: object,
    task_id: object = None,
    user_message_key: object = None,
    now: float | None = None,
) -> dict[str, Any]:
    """Open or keep busy for one worker; accrues only when not authorize-paused."""
    ts = float(now if now is not None else datetime.now(timezone.utc).timestamp())
    wkey = str(worker_key or "").strip()
    if not wkey:
        return ledger
    ledger, bid = ensure_burst(
        ledger,
        task_id=task_id,
        user_message_key=user_message_key,
        now=ts,
        reuse_active=True,
    )
    row = dict(ledger["bursts"][bid])
    open_workers = dict(row.get("open_workers") or {})
    if not row.get("authorize_paused"):
        if wkey not in open_workers:
            open_workers[wkey] = ts
    else:
        # Waiting authorize: track intent to resume later without accruing
        open_workers.setdefault(wkey, None)  # type: ignore[arg-type]
        # Store paused workers separately so resume can reopen
        paused = dict(row.get("paused_workers") or {})
        paused[wkey] = True
        row["paused_workers"] = paused
        # Don't set a real open start while paused
        if open_workers.get(wkey) is None:
            open_workers.pop(wkey, None)
    row["open_workers"] = {k: v for k, v in open_workers.items() if v is not None}
    if task_id:
        tid = str(task_id).strip()
        tasks = list(row.get("task_ids") or [])
        if tid and tid not in tasks:
            tasks.append(tid)
            row["task_ids"] = tasks
    ledger["bursts"][bid] = row
    ledger["active_burst_id"] = bid
    return ledger


def worker_busy_end(
    ledger: dict[str, Any],
    *,
    worker_key: object,
    task_id: object = None,
    now: float | None = None,
    finalize_if_idle: bool = True,
) -> dict[str, Any]:
    """Close busy interval for one worker; optionally finalize when none remain busy."""
    ts = float(now if now is not None else datetime.now(timezone.utc).timestamp())
    wkey = str(worker_key or "").strip()
    active_id = str(ledger.get("active_burst_id") or "").strip()
    if not active_id or active_id not in (ledger.get("bursts") or {}):
        # Try locate by task_id
        tid = str(task_id or "").strip()
        if tid:
            for bid, row in (ledger.get("bursts") or {}).items():
                if not isinstance(row, dict):
                    continue
                tasks = row.get("task_ids") if isinstance(row.get("task_ids"), list) else []
                if tid in {str(t) for t in tasks} and str(row.get("status") or "") == "open":
                    active_id = bid
                    break
        if not active_id:
            return ledger

    row = dict(ledger["bursts"][active_id])
    if str(row.get("status") or "") != "open":
        return ledger

    open_workers = dict(row.get("open_workers") or {})
    if wkey and wkey in open_workers:
        start = open_workers.pop(wkey)
        start_f = parse_ts(start)
        if start_f is not None and ts > start_f:
            intervals = [list(x) for x in (row.get("intervals") or []) if isinstance(x, (list, tuple))]
            row["intervals"] = merge_interval(intervals, start_f, ts)
        row["open_workers"] = open_workers
    # Drop paused marker for this worker
    paused = dict(row.get("paused_workers") or {})
    if wkey:
        paused.pop(wkey, None)
        row["paused_workers"] = paused

    ledger["bursts"][active_id] = row
    ledger["active_burst_id"] = active_id

    if finalize_if_idle and not row.get("open_workers") and not row.get("authorize_paused"):
        # Still may be authorize wait with no open workers — do not finalize mid-authorize
        if not paused:
            ledger = finalize_burst(ledger, burst_id=active_id, now=ts)
    return ledger


def set_authorize_paused(
    ledger: dict[str, Any],
    *,
    paused: bool,
    now: float | None = None,
) -> dict[str, Any]:
    """H1: pending authorize is not busy — close open intervals while paused."""
    ts = float(now if now is not None else datetime.now(timezone.utc).timestamp())
    active_id = str(ledger.get("active_burst_id") or "").strip()
    if not active_id or active_id not in (ledger.get("bursts") or {}):
        return ledger
    row = dict(ledger["bursts"][active_id])
    if str(row.get("status") or "") != "open":
        return ledger

    if paused and not row.get("authorize_paused"):
        # Close all open worker intervals (stop accrual)
        open_workers = dict(row.get("open_workers") or {})
        intervals = [list(x) for x in (row.get("intervals") or []) if isinstance(x, (list, tuple))]
        paused_workers = dict(row.get("paused_workers") or {})
        for wkey, start in open_workers.items():
            start_f = parse_ts(start)
            if start_f is not None and ts > start_f:
                intervals = merge_interval(intervals, start_f, ts)
            paused_workers[wkey] = True
        row["intervals"] = intervals
        row["open_workers"] = {}
        row["paused_workers"] = paused_workers
        row["authorize_paused"] = True
    elif not paused and row.get("authorize_paused"):
        # Resume: reopen workers that were busy before authorize
        paused_workers = dict(row.get("paused_workers") or {})
        open_workers = dict(row.get("open_workers") or {})
        for wkey in list(paused_workers.keys()):
            open_workers[wkey] = ts
        row["open_workers"] = open_workers
        row["paused_workers"] = {}
        row["authorize_paused"] = False
        ledger["bursts"][active_id] = row
        # Workers may have gone idle mid-authorize (paused_workers cleared by busy_end).
        # After authorize resolves with nobody busy, settle the burst (H1 complete).
        if not open_workers:
            return finalize_burst(ledger, burst_id=active_id, now=ts)
        return ledger

    ledger["bursts"][active_id] = row
    return ledger


def finalize_burst(
    ledger: dict[str, Any],
    *,
    burst_id: object = None,
    now: float | None = None,
) -> dict[str, Any]:
    """Close open intervals and set work_seconds from busy union (S+U)."""
    ts = float(now if now is not None else datetime.now(timezone.utc).timestamp())
    bid = str(burst_id or ledger.get("active_burst_id") or "").strip()
    if not bid or bid not in (ledger.get("bursts") or {}):
        return ledger
    row = dict(ledger["bursts"][bid])
    if str(row.get("status") or "") == "finalized":
        return ledger

    open_workers = dict(row.get("open_workers") or {})
    intervals = [list(x) for x in (row.get("intervals") or []) if isinstance(x, (list, tuple))]
    for _wkey, start in open_workers.items():
        start_f = parse_ts(start)
        if start_f is not None and ts > start_f:
            intervals = merge_interval(intervals, start_f, ts)
    pairs = [(float(a[0]), float(a[1])) for a in intervals if len(a) >= 2]
    seconds = int(round(union_length_seconds(pairs)))
    row["intervals"] = intervals
    row["open_workers"] = {}
    row["paused_workers"] = {}
    row["authorize_paused"] = False
    row["work_seconds"] = max(0, seconds)
    row["status"] = "finalized"
    row["finalized_at"] = datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    ledger["bursts"][bid] = row
    if str(ledger.get("active_burst_id") or "") == bid:
        ledger["active_burst_id"] = None
    return ledger


def live_work_seconds(ledger: dict[str, Any], *, now: float | None = None) -> int | None:
    """Accrued busy-union seconds for the active open burst (composer C1 view)."""
    ts = float(now if now is not None else datetime.now(timezone.utc).timestamp())
    active_id = str(ledger.get("active_burst_id") or "").strip()
    if not active_id:
        return None
    row = (ledger.get("bursts") or {}).get(active_id)
    if not isinstance(row, dict) or str(row.get("status") or "") != "open":
        return None
    intervals = [list(x) for x in (row.get("intervals") or []) if isinstance(x, (list, tuple))]
    pairs = [(float(a[0]), float(a[1])) for a in intervals if len(a) >= 2]
    if not row.get("authorize_paused"):
        for start in (row.get("open_workers") or {}).values():
            start_f = parse_ts(start)
            if start_f is not None and ts > start_f:
                pairs.append((start_f, ts))
    return max(0, int(round(union_length_seconds(pairs))))


def projection(ledger: dict[str, Any], *, now: float | None = None) -> dict[str, Any]:
    """UI/snapshot projection of the time ledger."""
    ts = float(now if now is not None else datetime.now(timezone.utc).timestamp())
    active_id = str(ledger.get("active_burst_id") or "").strip() or None
    active_row = None
    if active_id and isinstance((ledger.get("bursts") or {}).get(active_id), dict):
        active_row = ledger["bursts"][active_id]
    live = live_work_seconds(ledger, now=ts)
    finalized: dict[str, int] = {}
    for bid, row in (ledger.get("bursts") or {}).items():
        if not isinstance(row, dict):
            continue
        if str(row.get("status") or "") != "finalized":
            continue
        ws = row.get("work_seconds")
        if ws is None:
            continue
        try:
            finalized[str(bid)] = int(ws)
        except (TypeError, ValueError):
            continue
        # Also index by task_id for B1 message matching
        for tid in row.get("task_ids") or []:
            t = str(tid or "").strip()
            if t:
                finalized[f"task:{t}"] = int(ws)

    out: dict[str, Any] = {
        "case_started_at": ledger.get("case_started_at"),
        "active_burst_id": active_id,
        "live_work_seconds": live,
        "accruing": bool(
            active_row
            and str(active_row.get("status") or "") == "open"
            and not active_row.get("authorize_paused")
            and bool(active_row.get("open_workers"))
        ),
        "authorize_paused": bool(active_row and active_row.get("authorize_paused")),
        "finalized_work_seconds": finalized,
        "bursts": {
            bid: {
                "id": bid,
                "status": row.get("status"),
                "work_seconds": row.get("work_seconds"),
                "task_ids": list(row.get("task_ids") or []),
                "authorize_paused": bool(row.get("authorize_paused")),
            }
            for bid, row in (ledger.get("bursts") or {}).items()
            if isinstance(row, dict)
        },
    }
    return out


def apply_worker_transition(
    context: dict | None,
    *,
    worker_key: object,
    working: bool,
    task_id: object = None,
    user_message_key: object = None,
    now: float | None = None,
    finalize_if_idle: bool = True,
) -> dict[str, Any]:
    """Apply work_status transition onto conversation context; returns new context."""
    ledger = get_ledger(context)
    if working:
        ledger = worker_busy_start(
            ledger,
            worker_key=worker_key,
            task_id=task_id,
            user_message_key=user_message_key,
            now=now,
        )
    else:
        ledger = worker_busy_end(
            ledger,
            worker_key=worker_key,
            task_id=task_id,
            now=now,
            finalize_if_idle=finalize_if_idle,
        )
    return set_ledger(context, ledger)


def apply_authorize_pause(
    context: dict | None,
    *,
    paused: bool,
    now: float | None = None,
) -> dict[str, Any]:
    ledger = get_ledger(context)
    ledger = set_authorize_paused(ledger, paused=paused, now=now)
    return set_ledger(context, ledger)


def work_seconds_for_burst(ledger: dict[str, Any], burst_id: object) -> int | None:
    bid = str(burst_id or "").strip()
    row = (ledger.get("bursts") or {}).get(bid)
    if not isinstance(row, dict):
        return None
    ws = row.get("work_seconds")
    if ws is None:
        return None
    try:
        return int(ws)
    except (TypeError, ValueError):
        return None


def work_seconds_for_task(ledger: dict[str, Any], task_id: object) -> int | None:
    tid = str(task_id or "").strip()
    if not tid:
        return None
    for row in (ledger.get("bursts") or {}).values():
        if not isinstance(row, dict):
            continue
        tasks = row.get("task_ids") if isinstance(row.get("task_ids"), list) else []
        if tid in {str(t) for t in tasks}:
            if str(row.get("status") or "") == "finalized":
                try:
                    return int(row.get("work_seconds") or 0)
                except (TypeError, ValueError):
                    return 0
    return None


# Message types eligible as B1 result anchors (not tool/thinking spam).
# status / engagement_closeout render via SystemNotice and do not show B1 chrome —
# stamp only real agent result rows so the duration is visible on the result card.
RESULT_ANCHOR_MSG_TYPES = frozenset(
    {
        "text",
        "task_complete",
        "task_error",
        "task_incomplete",
    }
)


def pick_result_anchor_message_id(
    messages: list[Any],
    *,
    task_ids: list[str] | None = None,
) -> str | None:
    """Prefer last user-visible agent result for the burst (B1).

    Only RESULT_ANCHOR_MSG_TYPES are stamp targets so the FE result-card path
    (not SystemNotice) can render the duration. If none exist, return None —
    finalized seconds remain on the ledger for reload.
    """
    task_set = {str(t).strip() for t in (task_ids or []) if str(t).strip()}
    preferred: str | None = None
    for msg in messages:
        role = str(getattr(msg, "role", None) or (msg.get("role") if isinstance(msg, dict) else "") or "").lower()
        if role != "agent":
            continue
        msg_type = str(
            getattr(msg, "msg_type", None) or (msg.get("msg_type") if isinstance(msg, dict) else "") or ""
        ).lower()
        content = getattr(msg, "content", None) if not isinstance(msg, dict) else msg.get("content")
        content = content if isinstance(content, dict) else {}
        mid = str(getattr(msg, "id", None) or (msg.get("id") if isinstance(msg, dict) else "") or "").strip()
        if not mid:
            continue
        tid = str(content.get("task_id") or "").strip()
        if task_set and tid and tid not in task_set:
            continue
        if msg_type in RESULT_ANCHOR_MSG_TYPES:
            preferred = mid
    return preferred


def stamp_result_anchor_fields(
    content: dict | None,
    *,
    work_burst_id: object,
    work_seconds: int,
) -> dict[str, Any]:
    """Attach B1 duration meta to a message content dict (exactly one anchor per burst)."""
    out = dict(content or {})
    out["work_burst_id"] = str(work_burst_id)
    out["work_seconds"] = int(work_seconds)
    out["is_result_anchor"] = True
    return out
