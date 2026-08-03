"""Unit tests for Spec #275 finding identity (vuln_type + file location_key)."""
from app.services.finding_dedupe import (
    VALID_VULN_TYPES,
    finding_fingerprint,
    is_same_finding,
    location_host_key,
    location_resource_key,
    normalize_vuln_type,
)


def test_normalize_vuln_type_closed_enum():
    assert normalize_vuln_type("sqli") == "sqli"
    assert normalize_vuln_type(" SQLI ") == "sqli"
    assert normalize_vuln_type("file_upload") == "file_upload"
    assert normalize_vuln_type("") is None
    assert normalize_vuln_type(None) is None
    assert normalize_vuln_type("sql_injection") is None  # not in closed set
    assert normalize_vuln_type("unknown_thing") is None
    assert "other" in VALID_VULN_TYPES
    assert len(VALID_VULN_TYPES) == 17


def test_location_resource_key_file_level():
    assert (
        location_resource_key("http://host.docker.internal:8080/vulnerabilities/sqli/?id=1")
        == "/vulnerabilities/sqli"
    )
    assert location_resource_key("/vulnerabilities/exec/") == "/vulnerabilities/exec"
    assert (
        location_resource_key("http://h:8080/hackable/uploads/test_upload.php")
        == "/hackable/uploads/test_upload.php"
    )
    assert location_resource_key("http://h/vulnerabilities/upload/") == "/vulnerabilities/upload"
    assert location_resource_key("SQL Injection at /vulnerabilities/sqli/") == "/vulnerabilities/sqli"
    assert location_resource_key("http://x/level1/index.php") == "/level1/index.php"
    assert location_resource_key("no path here") == ""


def test_location_resource_key_no_upload_alias_collapse():
    """Upload family paths stay distinct at file level — no /hackable ↔ /vulnerabilities/upload alias."""
    a = location_resource_key("http://h/hackable/uploads/shell.php")
    b = location_resource_key("http://h/vulnerabilities/upload/")
    assert a == "/hackable/uploads/shell.php"
    assert b == "/vulnerabilities/upload"
    assert a != b


def test_a18_four_distinct_type_plus_file():
    """a18-class: four distinct type+file → four identities (must not collapse)."""
    asset = "a1"
    port = "8080"
    cases = [
        ("rce", "http://h:8080/hackable/uploads/shell.php", "Webshell RCE"),
        (
            "credential_exposure",
            "http://h:8080/hackable/uploads/creds.txt",
            "Leaked credentials in upload dir",
        ),
        ("info_disclosure", "http://h:8080/phpinfo.php", "phpinfo disclosure"),
        ("dir_listing", "http://h:8080/hackable/uploads/", "Directory listing"),
    ]
    rows = []
    for vtype, loc, title in cases:
        rows.append(
            {
                "title": title,
                "asset_id": asset,
                "port": port,
                "vuln_type": vtype,
                "location": loc,
                "location_key": location_resource_key(loc),
            }
        )
    # Pairwise distinct
    for i, a in enumerate(rows):
        for j, b in enumerate(rows):
            if i == j:
                continue
            assert not is_same_finding(
                a,
                title=b["title"],
                asset_id=asset,
                port=port,
                location=b["location"],
                vuln_type=b["vuln_type"],
                location_key=b["location_key"],
            ), f"must not merge {a['vuln_type']} with {b['vuln_type']}"


def test_same_type_same_file_is_same():
    existing = {
        "title": "File Upload (Low) - PHP webshell",
        "asset_id": "a1",
        "port": "8080",
        "vuln_type": "file_upload",
        "location": "http://h:8080/vulnerabilities/upload/",
        "location_key": "/vulnerabilities/upload",
    }
    assert is_same_finding(
        existing,
        title="File Upload Medium — Content-Type bypass",  # title drift ignored
        asset_id="a1",
        port="8080",
        location="http://h:8080/vulnerabilities/upload/?x=1",
        vuln_type="file_upload",
    )


def test_upload_alias_must_not_merge_different_files():
    """Historical path-class alias must NOT merge module page vs evidence file."""
    existing = {
        "title": "文件上传漏洞",
        "asset_id": "a1",
        "port": "8080",
        "vuln_type": "file_upload",
        "location": "http://h:8080/vulnerabilities/upload/",
        "location_key": "/vulnerabilities/upload",
    }
    assert not is_same_finding(
        existing,
        title="Webshell RCE via uploaded PHP",
        asset_id="a1",
        port="8080",
        location="http://h:8080/hackable/uploads/test_upload.php",
        vuln_type="rce",
    )
    # Even same type: different file-level keys stay distinct
    assert not is_same_finding(
        existing,
        title="Upload again",
        asset_id="a1",
        port="8080",
        location="http://h:8080/hackable/uploads/other.php",
        vuln_type="file_upload",
    )


def test_title_drift_must_not_merge():
    """Title / stem alone never defines identity."""
    existing = {
        "title": "SQL Injection in id parameter at /vulnerabilities/sqli/",
        "asset_id": "a1",
        "port": "8080",
        "vuln_type": "sqli",
        "location": "http://h:8080/vulnerabilities/sqli/",
        "location_key": "/vulnerabilities/sqli",
    }
    # Same title family but different location → new finding
    assert not is_same_finding(
        existing,
        title="SQL Injection in id parameter at /vulnerabilities/sqli/",
        asset_id="a1",
        port="8080",
        location="http://h:8080/vulnerabilities/sqli_blind/",
        vuln_type="sqli",
    )
    # Title completely different but same type+file → same finding
    assert is_same_finding(
        existing,
        title="SQL注入漏洞 - 数据库信息泄露 (低安全等级)",
        asset_id="a1",
        port="8080",
        location="http://h:8080/vulnerabilities/sqli/?id=1",
        vuln_type="sqli",
    )


def test_missing_vuln_type_does_not_match():
    existing = {
        "title": "SQLi",
        "asset_id": "a1",
        "port": "8080",
        "location": "/vulnerabilities/sqli/",
        "location_key": "/vulnerabilities/sqli",
        # no vuln_type — legacy / incomplete
    }
    assert not is_same_finding(
        existing,
        title="SQLi",
        asset_id="a1",
        port="8080",
        location="/vulnerabilities/sqli/",
        vuln_type="sqli",
    )


def test_cve_same_asset_matches():
    existing = {
        "title": "OpenSSL bug",
        "asset_id": "a1",
        "port": "443",
        "cve_id": "CVE-2024-1234",
        "vuln_type": "other",
        "location_key": "/tls",
    }
    assert is_same_finding(
        existing,
        title="Different wording",
        asset_id="a1",
        port="443",
        cve_id="CVE-2024-1234",
        location="/elsewhere",
        vuln_type="rce",
    )


def test_host_string_when_no_asset():
    existing = {
        "title": "XSS",
        "asset_id": None,
        "port": "8080",
        "vuln_type": "xss",
        "location": "http://lab.example:8080/vuln/xss",
        "location_key": "/vuln/xss",
        "host": "lab.example",
    }
    assert is_same_finding(
        existing,
        title="Reflected XSS",
        asset_id=None,
        port="8080",
        location="http://lab.example:8080/vuln/xss?q=1",
        vuln_type="xss",
        host="lab.example",
    )
    assert not is_same_finding(
        existing,
        title="Reflected XSS",
        asset_id=None,
        port="8080",
        location="http://other.example:8080/vuln/xss",
        vuln_type="xss",
        host="other.example",
    )


def test_port_mismatch_not_merged():
    existing = {
        "title": "SQLi",
        "asset_id": "a1",
        "port": "8080",
        "vuln_type": "sqli",
        "location_key": "/vulnerabilities/sqli",
        "location": "/vulnerabilities/sqli/",
    }
    assert not is_same_finding(
        existing,
        title="SQLi",
        asset_id="a1",
        port="8443",
        location="/vulnerabilities/sqli/",
        vuln_type="sqli",
    )


def test_fingerprint_uses_type_and_location():
    fp = finding_fingerprint(
        vuln_type="xss",
        asset_id="a1",
        port="8080",
        location="http://h/vulnerabilities/xss_r/",
    )
    assert "type:xss" in fp
    assert "loc:/vulnerabilities/xss_r" in fp
    assert location_host_key("http://h:8080/x") == "h"


def test_rediscovery_count_from_history():
    from app.services.finding_dedupe import discovery_count, rediscovery_count

    hist = [
        {"event": "discovered", "at": "2026-01-01T00:00:00Z"},
        {"event": "rediscovered", "at": "2026-02-01T00:00:00Z"},
        {"event": "rediscovered", "at": "2026-03-01T00:00:00Z"},
    ]
    assert rediscovery_count(hist) == 2
    assert discovery_count(hist) == 3
    assert rediscovery_count([]) == 0
    assert discovery_count([]) == 1


def test_append_discovery_event_related_prior_id():
    from app.services.finding_dedupe import append_discovery_event

    h = append_discovery_event(
        [],
        event="discovered",
        conversation_id="case-b",
        related_prior_id="prior-uuid",
    )
    assert h[0]["related_prior_id"] == "prior-uuid"
    bare = append_discovery_event([], event="rediscovered", conversation_id="case-b")
    assert "related_prior_id" not in bare[0]
