"""Vuln catalog: Main directory + Worker detail assignment."""

from __future__ import annotations

from pathlib import Path

from node5.knowledge import (
    format_vuln_catalog,
    format_worker_vuln_assignment,
    load_vuln_index,
    match_vuln_ids_for_surfaces,
    read_ref,
)
from node5.state import Surface


def _pack() -> Path:
    pack = Path(__file__).resolve().parents[1].parent / "experts" / "pentest"
    assert pack.is_dir(), pack
    return pack


def test_load_vuln_index_has_writeup_spectrum():
    entries = load_vuln_index(_pack())
    assert len(entries) >= 15
    ids = {e.id for e in entries}
    for need in (
        "sqli-login-auth",
        "ssrf-url-fetch",
        "mass-assignment-register",
        "business-logic-payment",
        "jwt-pubkey-confusion",
        "password-reset-ato",
    ):
        assert need in ids, need
    for e in entries:
        assert e.detail.startswith("vulns/")
        body = read_ref(_pack(), e.detail, max_chars=500)
        assert not body.startswith("error:"), e.detail


def test_format_vuln_catalog_is_directory_not_full_bodies():
    text = format_vuln_catalog(_pack(), max_entries=40, for_main=True)
    assert "VULN CATALOG" in text
    assert "sqli-login-auth" in text
    assert "detail=`vulns/" in text
    # should not dump entire discovery steps for every card
    assert text.count("## Discovery steps") == 0


def test_worker_assignment_for_ssrf_skill():
    block = format_worker_vuln_assignment(
        _pack(),
        "pentest-ssrf",
        max_ids=2,
        paths=["/profile/image/url"],
    )
    assert "ssrf-url-fetch" in block
    assert "ref_read" in block.lower() or "detail=" in block
    assert "done_when" in block


def test_api_worker_without_checkout_does_not_prefer_business_logic():
    from node5.knowledge import vuln_entries_for_skill

    rows = vuln_entries_for_skill(
        _pack(),
        "pentest-api",
        paths=["/api/products", "/api/challenges"],
        max_ids=2,
    )
    ids = [r.id for r in rows]
    # products-only should not force business-logic-payment first
    assert "business-logic-payment" not in ids or len(ids) == 1


def test_api_worker_with_basket_checkout_can_bind_business():
    from node5.knowledge import vuln_entries_for_skill

    rows = vuln_entries_for_skill(
        _pack(),
        "pentest-api",
        paths=["/api/BasketItems", "/rest/basket/1/checkout", "/api/products"],
        max_ids=2,
    )
    ids = [r.id for r in rows]
    assert "business-logic-payment" in ids


def test_surface_match_highlights_ssrf_and_search():
    surfaces = [
        Surface(path="/profile/image/url", note="url fetch"),
        Surface(path="/rest/products/search", note="q param"),
        Surface(path="/rest/user/login"),
    ]
    hits = match_vuln_ids_for_surfaces(_pack(), surfaces, limit=10)
    ids = {h.id for h in hits}
    assert "ssrf-url-fetch" in ids or "sqli-query-exfil" in ids or "sqli-login-auth" in ids

def test_index_has_need_paths_and_done_when():
    entries = load_vuln_index(_pack())
    ssrf = next(e for e in entries if e.id == "ssrf-url-fetch")
    assert ssrf.need_paths
    assert ssrf.done_when
