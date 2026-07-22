"""Track1 coverage requirements + authz matrix (post Campaign removal)."""

from __future__ import annotations

import json
from unittest.mock import patch

from node5.authz_matrix import run_authz_matrix
from node5.coverage import required_coverage
from node5.coverage_probes import run_coverage_probes
from node5.feedback import evidence_quality_gate
from node5.state import PenState, Surface


def test_required_opens_graphql_identity_authz():
    state = PenState(
        target="http://127.0.0.1:3000",
        surfaces=[
            Surface(path="/graphql"),
            Surface(path="/rest/user/security-question"),
            Surface(path="/rest/user/change-password"),
            Surface(path="/rest/user/reset-password"),
            Surface(path="/api/Users"),
            Surface(path="/api/BasketItems"),
            Surface(path="/rest/user/login"),
            Surface(path="/profile/image/file"),
        ],
    )
    ids = {r.id for r in required_coverage(state)}
    assert "graphql" in ids
    assert "identity_reset" in ids
    assert "identity_change_password" in ids
    assert "authz_matrix" in ids
    assert "upload" in ids


def test_graphql_introspection_closes(monkeypatch):
    state = PenState(
        target="http://127.0.0.1:3000",
        dry_run=False,
        surfaces=[Surface(path="/graphql")],
    )

    class Client:
        def __init__(self, *a, **k):
            pass

        def close(self):
            pass

        def post(self, url, content=None, headers=None):
            class R:
                status_code = 200
                text = json.dumps(
                    {
                        "data": {
                            "__schema": {
                                "queryType": {"name": "Query"},
                                "types": [{"name": "User", "kind": "OBJECT"}],
                            }
                        }
                    }
                )
                content = text.encode()
                headers = {"content-type": "application/json"}

                def json(self):
                    return json.loads(self.text)

            return R()

        def get(self, *a, **k):
            class R:
                status_code = 404
                text = ""
                content = b""
                headers = {}

            return R()

        def request(self, *a, **k):
            return self.get()

    with patch("node5.coverage_probes.httpx.Client", Client):
        run_coverage_probes(state)
    assert any("GraphQL" in c.title for c in state.candidates)
    c = next(c for c in state.candidates if "GraphQL" in c.title)
    ok, reason = evidence_quality_gate(c)
    assert ok, reason


def test_authz_matrix_unauth_collection():
    state = PenState(
        target="http://127.0.0.1:3000",
        dry_run=False,
        surfaces=[
            Surface(path="/api/BasketItems"),
            Surface(path="/api/Users"),
            Surface(path="/rest/user/login"),
        ],
    )

    class Client:
        def __init__(self, *a, **k):
            pass

        def close(self):
            pass

        def post(self, url, content=None, headers=None):
            class R:
                status_code = 200
                text = json.dumps({"authentication": {"token": "tok"}})
                content = text.encode()
                headers = {"content-type": "application/json"}

                def json(self):
                    return json.loads(self.text)

            return R()

        def get(self, url, headers=None):
            class R:
                status_code = 200
                text = json.dumps({"data": [{"id": 1, "ProductId": 2}]})
                content = text.encode()
                headers = {"content-type": "application/json"}

            return R()

        def request(self, method, url, content=None, headers=None):
            # actor_b/anon write succeeds → cross-actor write differential
            class R:
                status_code = 200 if method in ("PUT", "DELETE") else 401
                text = '{"ok":true}'
                content = b'{"ok":true}'
                headers = {"content-type": "application/json"}

            return R()

    with patch("node5.authz_matrix.httpx.Client", Client):
        summary = run_authz_matrix(state)
    assert summary.get("cells", 0) >= 1
    assert len(state.authz_matrix) >= 1
    # write methods present in matrix
    methods = {c.get("method") for c in state.authz_matrix}
    assert "PUT" in methods or "DELETE" in methods
    if summary.get("booked"):
        assert any("access control" in c.title.lower() for c in state.candidates)
        sev = next(c.severity for c in state.candidates if "access control" in c.title.lower())
        assert sev in ("high", "medium")
