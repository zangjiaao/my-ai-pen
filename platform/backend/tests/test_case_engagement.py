"""Unit tests for case engagement / RoE (structured only)."""
from app.services.case_engagement import (
    case_fields_from_context,
    merge_case_into_context,
    normalize_engagement_template,
    normalize_product_engagement_template,
    is_product_graph_template,
    resolve_allow_postex,
    resolve_graph_execution,
    roe_payload_for_task_assign,
)


def test_normalize_templates():
    assert normalize_engagement_template("app_assessment") == "app_assessment"
    assert normalize_engagement_template("redteam_deep") == "redteam_deep"
    assert normalize_engagement_template("assess") == "app_assessment"
    assert normalize_engagement_template("please hack dvwa") is None
    # Product Graph set (#78 phase 2): app_assessment + redteam_deep
    assert is_product_graph_template("app_assessment") is True
    assert is_product_graph_template("assess") is True
    assert is_product_graph_template("redteam_deep") is True
    assert is_product_graph_template("deep") is True
    assert is_product_graph_template("free") is False
    assert normalize_product_engagement_template("app_assessment") == "app_assessment"
    assert normalize_product_engagement_template("assess") == "app_assessment"
    assert normalize_product_engagement_template("redteam_deep") == "redteam_deep"
    assert normalize_product_engagement_template("free") is None


def test_allow_postex_defaults_conservative():
    assert resolve_allow_postex() is False
    assert resolve_allow_postex(engagement="pentest") is False
    assert resolve_allow_postex(engagement_template="app_assessment") is False
    assert resolve_allow_postex(engagement_template="redteam_deep") is True
    assert resolve_allow_postex(engagement_template="redteam_deep", allow_postex=False) is False
    assert resolve_allow_postex(engagement_template="app_assessment", allow_postex=True) is True


def test_merge_case_round_trip():
    ctx = merge_case_into_context(
        {},
        engagement_template="app_assessment",
        stations=[{"id": "surface", "status": "pending"}],
    )
    fields = case_fields_from_context(ctx)
    assert fields["engagement_template"] == "app_assessment"
    assert fields["allow_postex"] is False
    assert fields["stations"][0]["id"] == "surface"

    # Product deep template accepted (phase 2)
    ctx2 = merge_case_into_context(ctx, engagement_template="redteam_deep")
    fields2 = case_fields_from_context(ctx2)
    assert fields2["engagement_template"] == "redteam_deep"
    assert fields2["allow_postex"] is True

    roe = roe_payload_for_task_assign(ctx2)
    assert roe.get("engagement_template") == "redteam_deep"
    assert roe["allow_postex"] is True


def test_template_change_does_not_keep_stale_postex_false():
    """Explicit allow_postex still wins when product template stays app_assessment."""
    ctx = merge_case_into_context({}, engagement_template="app_assessment")
    assert case_fields_from_context(ctx)["allow_postex"] is False
    ctx = merge_case_into_context(ctx, engagement_template="app_assessment", allow_postex=True)
    assert case_fields_from_context(ctx)["allow_postex"] is True


def test_product_merge_accepts_deep_graph_template():
    ctx = merge_case_into_context({}, engagement_template="redteam_deep")
    fields = case_fields_from_context(ctx)
    assert fields.get("engagement_template") == "redteam_deep"
    assert fields["allow_postex"] is True
    # Explicit override still works when provided
    ctx = merge_case_into_context(ctx, engagement_template="redteam_deep", allow_postex=False)
    assert case_fields_from_context(ctx)["allow_postex"] is False


def test_free_clears_product_graph_template():
    ctx = merge_case_into_context({}, engagement_template="app_assessment")
    assert case_fields_from_context(ctx)["engagement_template"] == "app_assessment"
    # Sticky Graph fields that must not survive free clear
    assert ctx["task"].get("engagement") == "app_assessment"
    assert ctx["task"].get("role") == "pentest"

    ctx = merge_case_into_context(ctx, engagement_template="free")
    fields = case_fields_from_context(ctx)
    assert not fields.get("engagement_template")
    assert fields["allow_postex"] is False
    # No resurrection via task.engagement / role fallbacks
    assert not ctx.get("task", {}).get("engagement_template")
    assert not ctx.get("task", {}).get("engagement")
    assert not is_product_graph_template(ctx.get("task", {}).get("engagement"))
    assert not is_product_graph_template(fields.get("engagement_template"))

    # Same for deep → free
    ctx = merge_case_into_context({}, engagement_template="redteam_deep")
    assert case_fields_from_context(ctx)["engagement_template"] == "redteam_deep"
    ctx = merge_case_into_context(ctx, engagement_template="none")
    fields = case_fields_from_context(ctx)
    assert not fields.get("engagement_template")
    assert fields["allow_postex"] is False


def test_handoff_structured():
    ctx = merge_case_into_context(
        {},
        handoff={
            "suggest_pack_id": "llm-security",
            "reason": "chat API",
            "status": "suggested",
        },
    )
    fields = case_fields_from_context(ctx)
    assert fields["handoff"]["suggest_pack_id"] == "llm-security"
    assert fields["handoff"]["status"] == "suggested"


def test_resolve_graph_execution_c1():
    # Explicit client structured fields win
    assert (
        resolve_graph_execution(
            engagement_template="app_assessment",
            conversation_status="completed",
            explicit_execution="full",
        )
        == "full"
    )
    assert (
        resolve_graph_execution(
            engagement_template="app_assessment",
            conversation_status="working",
            explicit_execution="run",
        )
        == "full"
    )
    assert (
        resolve_graph_execution(
            engagement_template="app_assessment",
            conversation_status="working",
            explicit_execution="continue",
        )
        == "continue"
    )
    assert (
        resolve_graph_execution(
            engagement_template="redteam_deep",
            conversation_status="created",
            explicit_execution="continue_chat",
        )
        == "continue"
    )
    assert (
        resolve_graph_execution(
            engagement_template="app_assessment",
            conversation_status="working",
            explicit_execution="envelope",
        )
        == "continue"
    )

    # After completed product Graph → continue (C1 sticky follow-up)
    assert (
        resolve_graph_execution(
            engagement_template="app_assessment",
            conversation_status="completed",
        )
        == "continue"
    )
    assert (
        resolve_graph_execution(
            engagement_template="redteam_deep",
            conversation_status="complete",
        )
        == "continue"
    )
    assert (
        resolve_graph_execution(
            engagement_template="assess",
            conversation_status="done",
        )
        == "continue"
    )

    # First run / non-complete → omit (Node full when hard resolves)
    assert (
        resolve_graph_execution(
            engagement_template="app_assessment",
            conversation_status="working",
        )
        is None
    )
    assert (
        resolve_graph_execution(
            engagement_template="app_assessment",
            conversation_status=None,
        )
        is None
    )
    # Non-product template → omit even if completed
    assert (
        resolve_graph_execution(
            engagement_template="free",
            conversation_status="completed",
        )
        is None
    )
    assert (
        resolve_graph_execution(
            engagement_template=None,
            conversation_status="completed",
        )
        is None
    )
    # Explicit full still wins over completed sticky
    assert (
        resolve_graph_execution(
            engagement_template="redteam_deep",
            conversation_status="completed",
            explicit_execution="restart",
        )
        == "full"
    )
