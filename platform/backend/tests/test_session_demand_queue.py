"""Spec #313 L9 — Session demand queue FIFO (confirm same class as user text)."""
from app.services import session_demand_queue as q


def setup_function():
    q.clear_all()


def test_fifo_enqueue_pop_order():
    a = q.enqueue("c1", kind="confirm_options", text="first")
    b = q.enqueue("c1", kind="confirm_options", text="second")
    c = q.enqueue("c1", kind="text", text="third")
    assert q.size("c1") == 3
    assert q.peek("c1")["id"] == a["id"]
    assert q.peek("c1")["text"] == "first"
    p1 = q.pop("c1")
    assert p1["text"] == "first"
    p2 = q.pop("c1")
    assert p2["text"] == "second"
    p3 = q.pop("c1")
    assert p3["text"] == "third"
    assert q.pop("c1") is None
    assert q.size("c1") == 0


def test_take_by_id_force_send():
    a = q.enqueue("c3", text="first")
    b = q.enqueue("c3", text="second")
    taken = q.take("c3", b["id"])
    assert taken is not None
    assert taken["text"] == "second"
    assert q.peek("c3")["id"] == a["id"]
    assert q.take("c3", "missing") is None


def test_delete_by_id():
    a = q.enqueue("c2", text="keep")
    b = q.enqueue("c2", text="drop")
    c = q.enqueue("c2", text="tail")
    assert q.delete("c2", b["id"]) is True
    assert q.delete("c2", "missing") is False
    remaining = q.list_demands("c2")
    assert [x["text"] for x in remaining] == ["keep", "tail"]
    assert remaining[0]["id"] == a["id"]
    assert remaining[1]["id"] == c["id"]


def test_queues_isolated_by_conversation():
    q.enqueue("a", text="only-a")
    q.enqueue("b", text="only-b")
    assert q.size("a") == 1
    assert q.size("b") == 1
    assert q.pop("a")["text"] == "only-a"
    assert q.peek("b")["text"] == "only-b"
    q.clear("b")
    assert q.size("b") == 0


def test_resolve_confirm_busy_is_enqueue_not_steer():
    from app.services.choice_card import resolve_confirm_options_delivery

    assert (
        resolve_confirm_options_delivery(
            had_live_pending=False,
            conversation_status="running",
            working=True,
            worker_count=2,
        )
        == "enqueue"
    )
    # legacy alias must not reappear as product path
    assert (
        resolve_confirm_options_delivery(
            had_live_pending=False,
            conversation_status="running",
            working=True,
            worker_count=1,
        )
        != "steer_busy"
    )
