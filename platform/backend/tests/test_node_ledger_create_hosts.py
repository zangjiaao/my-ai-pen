"""Agent host create when user asked — expand CIDR pure helper."""
from app.services.asset_ledger import MAX_AGENT_HOST_CREATE, expand_host_specs


def test_expand_single_and_host_port():
    assert expand_host_specs(["10.0.0.1"]) == ["10.0.0.1"]
    assert expand_host_specs(["pay.example.com:443"]) == ["pay.example.com"]


def test_expand_slash24():
    hosts = expand_host_specs(["10.0.0.0/24"])
    assert len(hosts) == 254  # .0 and .255 excluded
    assert "10.0.0.1" in hosts
    assert "10.0.0.254" in hosts
    assert "10.0.0.0" not in hosts
    assert "10.0.0.255" not in hosts


def test_expand_cap():
    try:
        expand_host_specs(["10.0.0.0/16"])
        assert False, "expected cap error"
    except ValueError as e:
        assert str(MAX_AGENT_HOST_CREATE) in str(e)


def test_expand_mixed_list():
    hosts = expand_host_specs(["10.0.0.1", "10.0.0.1", "lab.local"])
    assert hosts == ["10.0.0.1", "lab.local"]
