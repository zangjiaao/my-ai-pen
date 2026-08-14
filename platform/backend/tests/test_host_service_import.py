"""Bulk Host×Service CSV parse for Asset create."""
from app.services.asset_ledger import parse_host_service_import_lines


def test_header_and_merge_same_host():
    text = """
address,port,protocol,name,tags
10.0.0.1,80,tcp,http,prod
10.0.0.1,443,tcp,https,prod
pay.example.com,8080,http
"""
    rows = parse_host_service_import_lines(text)
    assert len(rows) == 2
    assert rows[0]["address"] == "10.0.0.1"
    assert {s["port"] for s in rows[0]["services"]} == {"80", "443"}
    assert rows[0]["services"][0]["name"] == "http"
    assert "prod" in rows[0]["tags"]
    assert rows[1]["services"][0]["port"] == "8080"
    assert rows[1]["services"][0]["protocol"] == "http"


def test_host_port_and_slash_proto_name():
    text = """
10.0.0.8:3000
10.0.0.8,22/tcp,ssh
"""
    rows = parse_host_service_import_lines(text)
    assert len(rows) == 1
    ports = {s["port"] for s in rows[0]["services"]}
    assert ports == {"3000", "22"}
    s22 = next(s for s in rows[0]["services"] if s["port"] == "22")
    assert s22["protocol"] == "tcp"
    assert s22["name"] == "ssh"


def test_host_only_line():
    rows = parse_host_service_import_lines("lab.internal\n")
    assert len(rows) == 1
    assert rows[0]["address"] == "lab.internal"
    assert rows[0]["services"] == []
