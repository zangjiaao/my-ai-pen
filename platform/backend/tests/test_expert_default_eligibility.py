import pytest

from app.services.expert_instances import validate_default_expert_eligibility


def test_default_expert_requires_enabled_online_binding():
    validate_default_expert_eligibility(enabled=True, node_status="online")


@pytest.mark.parametrize(
    ("enabled", "node_status"),
    [
        (False, "online"),
        (True, "offline"),
        (True, None),
        (True, ""),
    ],
)
def test_default_expert_rejects_unschedulable_binding(enabled, node_status):
    with pytest.raises(ValueError, match="default conversation partner"):
        validate_default_expert_eligibility(
            enabled=enabled,
            node_status=node_status,
        )
