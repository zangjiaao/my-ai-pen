"""Unit tests for finding path-class dedupe."""
from app.services.finding_dedupe import (
    canonical_path_aliases,
    finding_fingerprint,
    finding_path_class,
    is_same_finding,
    location_path_class,
    normalize_finding_title,
    normalize_finding_title_stem,
    preferred_path_class,
    row_location_blob,
)


def test_location_path_class_dvwa_modules():
    assert location_path_class("http://host.docker.internal:8080/vulnerabilities/sqli/?id=1") == "/vulnerabilities/sqli"
    assert location_path_class("/vulnerabilities/exec/") == "/vulnerabilities/exec"
    assert location_path_class("SQL Injection at /vulnerabilities/sqli/") == "/vulnerabilities/sqli"
    assert location_path_class("http://x/level1/index.php") == "/level1"
    assert location_path_class("no path here") == ""
    assert location_path_class("payload: GET xss_r/?name=<script>") == "/vulnerabilities/xss_r"


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


def test_same_finding_when_poc_is_payload_only():
    """Real ledger rows often store payload-only PoC; path lives in title."""
    existing = {
        "title": "SQL Injection in id parameter at /vulnerabilities/sqli/",
        "asset_id": "a1",
        "port": "8080",
        "poc": "id=1' UNION SELECT 1,group_concat(user,':',password) FROM users --",
        "description": "classic union",
    }
    assert finding_path_class(existing["poc"], existing["title"]) == "/vulnerabilities/sqli"
    assert is_same_finding(
        existing,
        title="SQL 注入漏洞 (Low Security) - UNION 查询数据泄露",
        asset_id="a1",
        port="8080",
        location="1. 访问 /vulnerabilities/sqli/?id=-1' UNION SELECT user(),version()--",
    )
    blob = row_location_blob(existing)
    assert "/vulnerabilities/sqli" in blob


def test_verbose_description_does_not_false_merge_modules():
    """A file-upload writeup that mentions LFI elsewhere must not merge with LFI."""
    existing = {
        "title": "Medium Security File Upload Bypass - MIME Type Spoofing",
        "asset_id": "a1",
        "port": "8080",
        "poc": "POST /vulnerabilities/upload/",
        "description": "Also compared with /vulnerabilities/fi/ earlier in the report.",
    }
    assert not is_same_finding(
        existing,
        title="本地文件包含 (LFI) (Low Security)",
        asset_id="a1",
        port="8080",
        location="GET /vulnerabilities/fi/?page=../../../../etc/passwd",
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


def test_upload_path_alias_hackable_to_module():
    assert location_path_class("http://h/hackable/uploads/test.php") == "/hackable/uploads"
    aliases = canonical_path_aliases("/hackable/uploads")
    assert "/vulnerabilities/upload" in aliases
    assert preferred_path_class({"/hackable/uploads"}) == "/vulnerabilities/upload"


def test_same_finding_command_injection_level_variant_stem():
    """Low path-less PoC + Medium /exec — bilingual stem match."""
    existing = {
        "title": "命令注入 (Low Security) - 参数拼接绕过",
        "asset_id": "a1",
        "port": "8080",
        "poc": "payload: POST ip=127.0.0.1; id&Submit=Submit. observed: uid=33",
        "description": "blacklist misses semicolon",
    }
    assert is_same_finding(
        existing,
        title="Command Injection (Medium Security) - Pipe Bypass via IP Parameter",
        asset_id="a1",
        port="8080",
        location="POST to /vulnerabilities/exec/ with body ip=127.0.0.1 | id",
    )


def test_same_finding_upload_evidence_path_vs_module():
    existing = {
        "title": "文件上传漏洞 (Low Security) - PHP Webshell 上传",
        "asset_id": "a1",
        "port": "8080",
        "poc": "payload: POST 上传 PHP。observed: 访问 http://h:8080/hackable/uploads/test_upload.php",
        "description": "webshell",
    }
    assert is_same_finding(
        existing,
        title="File Upload (Medium Security) - Content-Type Bypass PHP Upload",
        asset_id="a1",
        port="8080",
        location="POST to /vulnerabilities/upload/ with PHP file and type=image/jpeg",
    )


def test_same_finding_sqli_level_variant_stem():
    existing = {
        "title": "SQL 注入漏洞 (Low Security) - UNION 查询数据泄露",
        "asset_id": "a1",
        "port": "8080",
        "poc": "1. 访问 /vulnerabilities/sqli/?id=-1' UNION SELECT user(),version()--",
        "description": "union",
    }
    assert is_same_finding(
        existing,
        title="SQL 注入漏洞 (Medium Security) - 数字型注入绕过转义",
        asset_id="a1",
        port="8080",
        location="1. POST id=1 OR 1=1 返回全部5个用户",
    )


def test_sqli_and_blind_sqli_not_merged():
    existing = {
        "title": "SQL 注入漏洞 (Low Security) - UNION",
        "asset_id": "a1",
        "port": "8080",
        "poc": "/vulnerabilities/sqli/?id=1",
    }
    assert not is_same_finding(
        existing,
        title="SQL Injection (Blind) (Low Security) - Boolean-Based Blind Injection",
        asset_id="a1",
        port="8080",
        location="http://h:8080/vulnerabilities/sqli_blind/",
    )
    assert normalize_finding_title_stem("SQL Injection (Blind) (Low Security)") == "sql_injection_blind"
    assert normalize_finding_title_stem("SQL 注入漏洞 (Low Security)") == "sql_injection"


def test_stem_strips_security_level():
    assert normalize_finding_title_stem("Command Injection (Medium Security) - Pipe") == "command_injection"
    assert normalize_finding_title_stem("命令注入 (Low Security) - 参数拼接") == "command_injection"


def test_brute_force_sql_not_merged_with_sqli():
    existing = {
        "title": "SQL 注入漏洞 (Low Security) - UNION 查询数据泄露",
        "asset_id": "a1",
        "port": "8080",
        "poc": "/vulnerabilities/sqli/?id=1",
    }
    assert not is_same_finding(
        existing,
        title="Brute Force SQL 注入绕过 (Low Security)",
        asset_id="a1",
        port="8080",
        location="/vulnerabilities/brute/?username=x",
    )
    assert normalize_finding_title_stem("Brute Force SQL 注入绕过 (Low Security)") == "brute_force"
