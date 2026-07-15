"""Unit tests for case engagement / RoE (structured only)."""
from app.services.case_engagement import (
    case_fields_from_context,
    merge_case_into_context,
    normalize_engagement_template,
    resolve_allow_postex,
    roe_payload_for_task_assign,
)


def test_normalize_templates():
    assert normalize_engagement_template("app_assessment") == "app_assessment"
    assert normalize_engagement_template("redteam_deep") == "redteam_deep"
    assert normalize_engagement_template("assess") == "app_assessment"
    assert normalize_engagement_template("please hack dvwa") is None


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

    # Template upgrade without allow_postex arg must re-derive (not keep stale False).
    ctx2 = merge_case_into_context(ctx, engagement_template="redteam_deep")
    fields2 = case_fields_from_context(ctx2)
    assert fields2["engagement_template"] == "redteam_deep"
    assert fields2["allow_postex"] is True
    assert ctx2["case"]["allow_postex"] is True
    assert ctx2["task"]["allow_postex"] is True

    roe = roe_payload_for_task_assign(ctx2)
    assert roe["engagement_template"] == "redteam_deep"
    assert roe["allow_postex"] is True


def test_template_change_does_not_keep_stale_postex_false():
    """Skeptic regression: prior allow_postex=False must not pin deep template off."""
    ctx = merge_case_into_context({}, engagement_template="app_assessment")
    assert case_fields_from_context(ctx)["allow_postex"] is False
    ctx = merge_case_into_context(ctx, engagement_template="redteam_deep")
    assert case_fields_from_context(ctx)["allow_postex"] is True
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
