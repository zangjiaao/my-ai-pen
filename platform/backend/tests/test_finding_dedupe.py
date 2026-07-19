"""Unit tests for finding path-class dedupe."""
from app.services.finding_dedupe import (
    finding_fingerprint,
    is_same_finding,
    location_path_class,
    normalize_finding_title,
)


def test_location_path_class_dvwa_modules():
    assert location_path_class("http://host.docker.internal:8080/vulnerabilities/sqli/?id=1") == "/vulnerabilities/sqli"
    assert location_path_class("/vulnerabilities/exec/") == "/vulnerabilities/exec"
    assert location_path_class("SQL Injection at /vulnerabilities/sqli/") == "/vulnerabilities/sqli"
    assert location_path_class("http://x/level1/index.php") == "/level1"
    assert location_path_class("no path here") == ""


def test_same_finding_title_match():
    existing = {
        "title": "SQL Injection on DVWA sqli module",
        "asset_id": "a1",
        "port": "8080",
        "location": "http://h:8080/vulnerabilities/sqli/",
    }
    assert is_same_finding(
        existing,
        title="SQL Injection on DVWA sqli module",
        asset_id="a1",
        port="8080",
        location="/vulnerabilities/sqli/?x=1",
    )


def test_same_finding_path_class_title_drift():
    existing = {
        "title": "SQL Injection in id parameter at /vulnerabilities/sqli/",
        "asset_id": "a1",
        "port": "8080",
        "poc": "GET http://h:8080/vulnerabilities/sqli/?id=1'",
        "description": "union select",
    }
    assert is_same_finding(
        existing,
        title="SQL注入漏洞 - 数据库信息泄露 (低安全等级)",
        asset_id="a1",
        port="8080",
        location="http://h:8080/vulnerabilities/sqli/",
    )


def test_different_modules_not_merged():
    existing = {
        "title": "SQLi",
        "asset_id": "a1",
        "port": "8080",
        "location": "/vulnerabilities/sqli/",
    }
    assert not is_same_finding(
        existing,
        title="Command Injection",
        asset_id="a1",
        port="8080",
        location="/vulnerabilities/exec/",
    )


def test_fingerprint_prefers_path():
    fp = finding_fingerprint(
        title="Anything",
        asset_id="a1",
        port="8080",
        location="http://h/vulnerabilities/xss_r/",
    )
    assert "path:/vulnerabilities/xss_r" in fp
    assert normalize_finding_title("  Foo  BAR ") == "foo bar"
