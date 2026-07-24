"""Unit tests for case engagement / RoE (structured only)."""
from app.services.case_engagement import (
    case_fields_from_context,
    merge_case_into_context,
    normalize_engagement_template,
    normalize_product_engagement_template,
    is_product_graph_template,
    resolve_allow_postex,
    roe_payload_for_task_assign,
)


def test_normalize_templates():
    assert normalize_engagement_template("app_assessment") == "app_assessment"
    assert normalize_engagement_template("redteam_deep") == "redteam_deep"
    assert normalize_engagement_template("assess") == "app_assessment"
    assert normalize_engagement_template("please hack dvwa") is None
    # Product Graph set (#76 Soft retire): only app_assessment until hard redteam_deep
    assert is_product_graph_template("app_assessment") is True
    assert is_product_graph_template("assess") is True
    assert is_product_graph_template("redteam_deep") is False
    assert is_product_graph_template("free") is False
    assert normalize_product_engagement_template("app_assessment") == "app_assessment"
    assert normalize_product_engagement_template("assess") == "app_assessment"
    assert normalize_product_engagement_template("redteam_deep") is None
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

    # Non-product deep template cleared (Soft/phase-2); not silent product Graph.
    ctx2 = merge_case_into_context(ctx, engagement_template="redteam_deep")
    fields2 = case_fields_from_context(ctx2)
    assert fields2["engagement_template"] is None or fields2["engagement_template"] == ""
    assert fields2["allow_postex"] is False
    assert "engagement_template" not in ctx2.get("case", {}) or not ctx2["case"].get(
        "engagement_template"
    )

    roe = roe_payload_for_task_assign(ctx2)
    assert "engagement_template" not in roe or not roe.get("engagement_template")
    assert roe["allow_postex"] is False


def test_template_change_does_not_keep_stale_postex_false():
    """Explicit allow_postex still wins when product template stays app_assessment."""
    ctx = merge_case_into_context({}, engagement_template="app_assessment")
    assert case_fields_from_context(ctx)["allow_postex"] is False
    ctx = merge_case_into_context(ctx, engagement_template="app_assessment", allow_postex=True)
    assert case_fields_from_context(ctx)["allow_postex"] is True


def test_product_merge_rejects_non_product_graph_template():
    ctx = merge_case_into_context({}, engagement_template="redteam_deep")
    fields = case_fields_from_context(ctx)
    assert not fields.get("engagement_template")
    assert fields["allow_postex"] is False
    # Explicit override still works when provided
    ctx = merge_case_into_context(ctx, engagement_template="redteam_deep", allow_postex=False)
    assert case_fields_from_context(ctx)["allow_postex"] is False


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
