"""Deterministic high-value probe + coverage hints."""

from __future__ import annotations

from unittest.mock import patch

from node5.coverage import coverage_hints, required_coverage
from node5.high_value_probe import probe_high_value_paths
from node5.state import Candidate, PenState, Surface


def test_coverage_ssrf_when_image_url_surface():
    state = PenState(
        target="http://127.0.0.1:3000",
        surfaces=[Surface(path="/profile/image/url", note="url fetch")],
    )
    assert any(r.id == "ssrf_url_sink" for r in required_coverage(state))
    text = coverage_hints(state)
    assert "ssrf" in text.lower() or "COVERAGE" in text


def test_coverage_injection_when_search():
    state = PenState(
        target="http://t",
        surfaces=[Surface(path="/rest/products/search")],
        candidates=[
            Candidate(
                title="SQL Injection in Product Search",
                location="/rest/products/search",
                proof_excerpt="HTTP 500 SQLITE_ERROR",
                causality="c",
                reproducibility="r",
                impact="i",
                stage="class_probe",
            )
        ],
    )
    assert any(r.id == "injection_search" for r in required_coverage(state))
    text = coverage_hints(state)
    assert "injection" in text.lower() or "COVERAGE" in text


def test_coverage_jwt_keys_when_encryptionkeys():
    state = PenState(
        target="http://t",
        surfaces=[
            Surface(
                path="/encryptionkeys",
                note="high_value_probe HTTP 200 GET — key listing [key_material]",
            )
        ],
    )
    assert any(r.id == "jwt_key_material" for r in required_coverage(state))
    text = coverage_hints(state)
    assert "jwt" in text.lower() or "key" in text.lower()


def test_probe_adds_surface_on_200(monkeypatch):
    state = PenState(target="http://127.0.0.1:3000", dry_run=False)

    class FakeResp:
        def __init__(self, code=200, text="Index of /encryptionkeys", ctype="text/html"):
            self.status_code = code
            self.text = text
            self.headers = {"content-type": ctype}

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def close(self):
            pass

        def get(self, url):
            if "encryptionkeys" in url:
                return FakeResp(200, "Index of /encryptionkeys jwt.pub", "text/html")
            return FakeResp(404, "not found", "text/plain")

        def request(self, method, url, content=None, headers=None):
            return FakeResp(404, "no", "text/plain")

    with patch("node5.high_value_probe.httpx.Client", FakeClient):
        added = probe_high_value_paths(state)
    assert any("encryption" in (s.path or "") for s in added)
    assert any("encryption" in (s.path or "") for s in state.surfaces)


def test_probe_skips_dry_run():
    state = PenState(target="http://t", dry_run=True)
    assert probe_high_value_paths(state) == []
