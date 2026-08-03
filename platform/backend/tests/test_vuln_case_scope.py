"""Spec #279: Case-scoped #275 match — cross-Case prior re-confirm creates a new row."""
from __future__ import annotations

from app.services.finding_dedupe import (
    append_discovery_event,
    case_scoped_rows,
    pick_canonical_vuln,
    select_same_finding_candidates,
)


CASE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
CASE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
VULN_A_ID = "11111111-1111-1111-1111-111111111111"
VULN_B_ID = "22222222-2222-2222-2222-222222222222"


def _row(
    *,
    vuln_id: str,
    conversation_id: str,
    asset_id: str = "asset-1",
    port: str = "8080",
    vuln_type: str = "sqli",
    location: str = "http://lab.example:8080/vulnerabilities/sqli/",
    location_key: str = "/vulnerabilities/sqli",
    cve_id: str | None = None,
) -> dict:
    return {
        "id": vuln_id,
        "conversation_id": conversation_id,
        "title": "SQLi",
        "asset_id": asset_id,
        "port": port,
        "vuln_type": vuln_type,
        "location": location,
        "location_key": location_key,
        "cve_id": cve_id,
        "poc": location,
        "description": "desc",
        "host": "lab.example",
    }


def test_case_scoped_rows_drops_foreign_case():
    pool = [
        _row(vuln_id=VULN_A_ID, conversation_id=CASE_A),
        _row(vuln_id=VULN_B_ID, conversation_id=CASE_B),
    ]
    scoped = case_scoped_rows(pool, CASE_B)
    assert len(scoped) == 1
    assert scoped[0]["id"] == VULN_B_ID
    assert case_scoped_rows(pool, CASE_A)[0]["id"] == VULN_A_ID
    assert case_scoped_rows(pool, None) == []
    assert case_scoped_rows(pool, "") == []


def test_cross_case_same_identity_creates_new_not_match():
    """Same identity booked in Case A; book in Case B → no candidate (created=True path)."""
    case_a_row = _row(vuln_id=VULN_A_ID, conversation_id=CASE_A)
    # Simulates user-wide pool leak (pre-#279 bug): Case A row is present in pool.
    pool = [case_a_row]
    candidates = select_same_finding_candidates(
        pool,
        conversation_id=CASE_B,
        title="SQLi reconfirm",
        asset_id="asset-1",
        port="8080",
        location="http://lab.example:8080/vulnerabilities/sqli/?id=1",
        vuln_type="sqli",
        location_key="/vulnerabilities/sqli",
        host="lab.example",
    )
    assert candidates == []
    assert pick_canonical_vuln(candidates) is None
    # Case A row is untouched conceptually — still Case A when re-scoped.
    still_a = case_scoped_rows(pool, CASE_A)
    assert len(still_a) == 1
    assert still_a[0]["conversation_id"] == CASE_A
    assert still_a[0]["id"] == VULN_A_ID


def test_same_case_double_book_rediscover():
    """Same Case double-book same identity → rediscover (created=False), same id."""
    existing = _row(vuln_id=VULN_A_ID, conversation_id=CASE_A)
    pool = [existing]
    candidates = select_same_finding_candidates(
        pool,
        conversation_id=CASE_A,
        title="SQLi again with different title",
        asset_id="asset-1",
        port="8080",
        location="http://lab.example:8080/vulnerabilities/sqli/?id=2",
        vuln_type="sqli",
        location_key="/vulnerabilities/sqli",
        host="lab.example",
    )
    assert len(candidates) == 1
    canonical = pick_canonical_vuln(candidates)
    assert canonical is not None
    assert canonical["id"] == VULN_A_ID
    assert canonical["conversation_id"] == CASE_A
    created = canonical is None  # mirror _persist_vulnerability outcome
    assert created is False


def test_cross_case_cve_identity_does_not_match():
    """CVE short-circuit must also be Case-scoped (same CVE on other Case → new row)."""
    prior = _row(
        vuln_id=VULN_A_ID,
        conversation_id=CASE_A,
        cve_id="CVE-2024-1234",
        vuln_type="other",
        location_key="/tls",
        location="https://lab.example:443/tls",
        port="443",
    )
    candidates = select_same_finding_candidates(
        [prior],
        conversation_id=CASE_B,
        title="OpenSSL again",
        asset_id="asset-1",
        port="443",
        cve_id="CVE-2024-1234",
        location="https://lab.example:443/elsewhere",
        vuln_type="rce",
        host="lab.example",
    )
    assert candidates == []


def test_related_prior_id_on_discovery_history():
    h = append_discovery_event(
        [],
        event="discovered",
        conversation_id=CASE_B,
        evidence_ids=["ev-1"],
        related_prior_id=VULN_A_ID,
    )
    assert len(h) == 1
    assert h[0]["event"] == "discovered"
    assert h[0]["conversation_id"] == CASE_B
    assert h[0]["related_prior_id"] == VULN_A_ID
    # Empty / missing related_prior_id must not pollute history.
    h2 = append_discovery_event([], event="discovered", conversation_id=CASE_B)
    assert "related_prior_id" not in h2[0]
