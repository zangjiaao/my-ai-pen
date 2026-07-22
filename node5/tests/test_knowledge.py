"""On-demand refs knowledge index (no network)."""

from __future__ import annotations

from pathlib import Path

from node5.knowledge import list_refs, query_refs, read_ref


def _pack() -> Path:
    pack = Path(__file__).resolve().parents[1].parent / "experts" / "pentest"
    assert pack.is_dir(), pack
    return pack


def test_list_includes_components_and_new_payloads():
    rows = list_refs(_pack(), kind="all")
    paths = {r["path"] for r in rows}
    assert any(p.startswith("components/") for p in paths)
    assert "payloads/business-logic-abuse.md" in paths
    assert "payloads/auth-bypass-patterns.md" in paths


def test_query_fastjson_hits_component():
    hits = query_refs(_pack(), "fastjson", kind="components", limit=5)
    assert hits, "expected fastjson card"
    assert any("fastjson" in h["path"].lower() for h in hits)


def test_query_idor_or_auth_hits_payloads():
    hits = query_refs(_pack(), "idor jwt mass assignment", kind="payloads", limit=8)
    assert hits
    paths = " ".join(h["path"] for h in hits)
    assert "auth" in paths or "api" in paths or "access" in paths or "bypass" in paths


def test_query_rate_otp_hits_business_logic():
    hits = query_refs(_pack(), "rate limit otp sms", kind="payloads", limit=5)
    assert hits
    assert any("business-logic" in h["path"] or "abuse" in h["path"] for h in hits)


def test_read_blocks_path_escape():
    out = read_ref(_pack(), "../../../etc/passwd")
    assert out.startswith("error:")


def test_read_fastjson_body():
    body = read_ref(_pack(), "components/fastjson.md")
    assert "error:" not in body[:20]
    assert "fastjson" in body.lower() or "Fastjson" in body


def test_suggest_refs_from_api_surfaces():
    from node5.knowledge import suggest_refs_for_surfaces
    from node5.state import Surface

    text = suggest_refs_for_surfaces(
        _pack(),
        [
            Surface(path="/rest/user/login"),
            Surface(path="/api/Users"),
            Surface(path="/api/BasketItems"),
            Surface(path="/ftp/"),
        ],
        limit=6,
    )
    assert "Suggested tactical refs" in text
    assert "payloads/" in text or "components/" in text
