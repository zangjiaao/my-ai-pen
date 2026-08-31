"""Unit tests for case work-group context (thread + findings + evidence snippets)."""
from app.services.case_context import (
    _normalize_finding_severity,
    build_case_context_payload,
    build_evidence_snippets,
    build_findings_summary,
    build_scope_intel_card,
    coverage_sketch_from_surfaces,
    build_speech_from_messages,
    build_thread_from_messages,
    case_intel_port_scope,
    collapse_prior_index,
    excerpt_from_properties,
    evidence_role,
    extract_artifact_hints,
    extract_hosts_from_task,
    extract_scope_ports_from_task,
    path_or_url_from_properties,
    prior_index_module_key,
    surface_origin_host_keys,
    task_scope_asset_ids,
    unique_identity_asset_ids,
)
from app.services.owner_intel import intel_matches_case_scope


def test_thread_keeps_user_and_agent_text_skips_noise_status():
    messages = [
        {
            "role": "user",
            "msg_type": "text",
            "content": {"text": "Please assess http://lab/app"},
            "created_at": "2026-01-01T00:00:00",
        },
        {
            "role": "agent",
            "msg_type": "status",
            "content": {"text": "checkpoint tick", "status": "running"},
            "created_at": "2026-01-01T00:00:01",
        },
        {
            "role": "agent",
            "msg_type": "text",
            "content": {
                "text": "RCE confirmed; source dumped under notes/source_dump. Suggest code-audit.",
                "expert_name": "app-sec",
            },
            "created_at": "2026-01-01T00:01:00",
        },
        {
            "role": "agent",
            "msg_type": "vuln_found",
            "content": {
                "title": "Command injection RCE",
                "severity": "critical",
                "location": "/upload",
                "status": "confirmed",
            },
            "created_at": "2026-01-01T00:01:05",
        },
    ]
    thread = build_thread_from_messages(messages)
    speakers = [t["speaker"] for t in thread]
    texts = " ".join(t["text"] for t in thread)
    assert "user" in speakers
    assert "app-sec" in speakers
    assert "RCE confirmed" in texts
    assert "Command injection" in texts
    assert "checkpoint tick" not in texts


def test_speech_is_visible_talk_with_ids_skips_findings_and_status():
    messages = [
        {
            "id": "m1",
            "role": "user",
            "msg_type": "text",
            "content": {"text": "Please assess http://lab/app"},
            "created_at": "2026-01-01T00:00:00",
        },
        {
            "id": "m2",
            "role": "agent",
            "msg_type": "status",
            "content": {"text": "checkpoint tick", "status": "running"},
            "created_at": "2026-01-01T00:00:01",
        },
        {
            "id": "m3",
            "role": "agent",
            "msg_type": "text",
            "content": {
                "text": "RCE confirmed; source dumped.",
                "expert_name": "app-sec",
                "expert_id": "exp-1",
                "session_id": "pi-exp-1-a",
            },
            "created_at": "2026-01-01T00:01:00",
        },
        {
            "id": "m4",
            "role": "agent",
            "msg_type": "vuln_found",
            "content": {
                "title": "Command injection RCE",
                "severity": "critical",
                "location": "/upload",
                "status": "confirmed",
            },
            "created_at": "2026-01-01T00:01:05",
        },
        {
            "id": "m5",
            "role": "agent",
            "msg_type": "thinking",
            "content": {"text": "I should try upload next"},
            "created_at": "2026-01-01T00:01:06",
        },
    ]
    speech = build_speech_from_messages(messages)
    ids = [s["id"] for s in speech]
    kinds = [s["kind"] for s in speech]
    assert ids == ["m1", "m3"]
    assert "tool" not in kinds
    assert "status" not in kinds
    assert speech[1]["expert_id"] == "exp-1"
    assert speech[1]["session_id"] == "pi-exp-1-a"
    assert "session_id" not in speech[0]
    texts = " ".join(s["text"] for s in speech)
    assert "checkpoint tick" not in texts
    assert "Command injection" not in texts
    assert "I should try upload" not in texts


def test_findings_summary_includes_evidence_ids_and_proof():
    findings = [
        {
            "id": "1",
            "title": "Source code leak",
            "severity": "high",
            "location": "/backup/app.tar.gz",
            "status": "confirmed",
            "evidence_ids": ["ev_src_1", "ev_src_2"],
            "description": "Archive downloadable.\n\n[Proof]\nGET /backup/app.tar.gz → 200\npath=notes/source_dump/app",
        },
        {"id": "2", "title": "IDOR", "severity": "high", "location": "b.py:2", "status": "confirmed"},
    ]
    summary = build_findings_summary(findings, limit=2)
    assert len(summary) == 2
    assert summary[0]["title"] == "Source code leak"
    assert summary[0]["evidence_ids"] == ["ev_src_1", "ev_src_2"]
    assert "notes/source_dump" in summary[0].get("proof_excerpt", "")


def test_normalize_finding_severity_fail_closed():
    assert _normalize_finding_severity("Critical") == "critical"
    assert _normalize_finding_severity("HIGH") == "high"
    assert _normalize_finding_severity("medium") == "medium"
    assert _normalize_finding_severity("low") == "low"
    assert _normalize_finding_severity("info") == "info"
    assert _normalize_finding_severity(None) is None
    assert _normalize_finding_severity("") is None
    assert _normalize_finding_severity("   ") is None
    assert _normalize_finding_severity("unknown") is None
    assert _normalize_finding_severity("sev-high") is None


def test_findings_summary_does_not_invent_medium_severity():
    summary = build_findings_summary(
        [
            {"id": "1", "title": "No severity", "location": "/a", "status": "candidate"},
            {"id": "2", "title": "Empty severity", "severity": "", "location": "/b"},
            {"id": "3", "title": "Invalid severity", "severity": "urgent", "location": "/c"},
            {"id": "4", "title": "Valid medium", "severity": "Medium", "location": "/d"},
        ],
        limit=10,
    )
    by_id = {row["id"]: row for row in summary}
    assert by_id["1"]["severity"] == ""
    assert by_id["2"]["severity"] == ""
    assert by_id["3"]["severity"] == ""
    assert by_id["4"]["severity"] == "medium"
    assert all(row["severity"] != "medium" or row["id"] == "4" for row in summary)


def test_evidence_snippets_prefer_linked_proof():
    rows = [
        {
            "evidence_id": "ev_noise",
            "summary": "ls",
            "source_tool": "shell",
            "properties": {"kind": "shell", "role": "trace", "stdout": "total 0", "excerpt": "total 0"},
        },
        {
            "evidence_id": "ev_src",
            "summary": "source dump",
            "source_tool": "write",
            "properties": {
                "kind": "source_excerpt",
                "role": "proof",
                "path": "notes/source_dump/app/Main.java",
                "path_or_url": "notes/source_dump/app/Main.java",
                "preview": "class Main { void login() { ... } }",
                "excerpt": "class Main { void login() { ... } }",
            },
        },
        {
            "evidence_id": "ev_http",
            "summary": "GET leak",
            "source_tool": "http",
            "properties": {
                "kind": "http",
                "role": "proof",
                "url": "http://lab/backup/app.tar.gz",
                "path_or_url": "http://lab/backup/app.tar.gz",
                "status": 200,
                "response_body": "PK\x03\x04...",
                "excerpt": "PK archive bytes",
            },
        },
    ]
    snippets = build_evidence_snippets(rows, referenced_ids={"ev_src"}, limit=5)
    ids = [s["id"] for s in snippets]
    assert "ev_src" in ids
    # Linked source should be first
    assert snippets[0]["id"] == "ev_src"
    assert "Main.java" in (snippets[0].get("path_or_url") or "")
    assert snippets[0].get("excerpt")
    # pure noise not preferred when better material exists
    assert "ev_noise" not in ids or ids.index("ev_src") < ids.index("ev_noise")


def test_payload_has_version_and_evidence_snippets():
    messages = [
        {
            "id": "u1",
            "role": "user",
            "msg_type": "text",
            "content": {
                "text": "Source is at notes/source_dump and HANDOFF_FROM_PENTEST.md"
            },
            "created_at": "t0",
        }
    ]
    payload = build_case_context_payload(
        messages=messages,
        findings=[
            {
                "title": "RCE",
                "severity": "critical",
                "location": "host",
                "id": "f1",
                "evidence_ids": ["ev_src"],
                "description": "RCE\n\n[Proof]\nuid=0 root",
            }
        ],
        evidence_rows=[
            {
                "evidence_id": "ev_src",
                "summary": "dumped source",
                "source_tool": "shell",
                "properties": {
                    "role": "proof",
                    "kind": "shell",
                    "command": "cat notes/source_dump/app.py",
                    "path": "notes/source_dump/app.py",
                    "path_or_url": "notes/source_dump/app.py",
                    "stdout": "def vuln():\n  eval(request)",
                    "excerpt": "def vuln():\n  eval(request)",
                },
            }
        ],
        conversation_id="conv-1",
    )
    assert payload["version"] == 2
    assert payload["conversation_id"] == "conv-1"
    assert payload["thread"]
    assert payload["speech"]
    assert payload["speech"][0]["id"] == "u1"
    assert payload["findings_summary"][0]["title"] == "RCE"
    assert payload["findings_summary"][0]["evidence_ids"] == ["ev_src"]
    assert payload["evidence_snippets"]
    assert payload["evidence_snippets"][0]["id"] == "ev_src"
    assert "source_dump" in (payload["evidence_snippets"][0].get("path_or_url") or "")
    assert any("source_dump" in h or "HANDOFF" in h for h in payload["artifact_hints"])
    assert any("/" in h or h.endswith(".md") for h in payload["artifact_hints"] if "source_dump" in h or "HANDOFF" in h)


def test_artifact_hints_are_path_shaped_not_prose_words():
    """Needles stay, but only path-like tokens are hints (not status/prose 'Handoff')."""
    thread = [
        {"text": "Handoff authorized — starting destination expert."},
        {"text": "kind=handoff handoff_pack_id=pentest Cross-pack handoff"},
        {
            "text": (
                "Read notes/source_dump/app.py and HANDOFF_FROM_PENTEST.md "
                "plus /workspace/scripts/x.py and /opt/app/notes/foo.md"
            )
        },
    ]
    hints = extract_artifact_hints(thread, [])
    assert "Handoff" not in hints
    assert not any(h.lower() == "handoff" for h in hints)
    assert not any("handoff_pack_id" in h.lower() for h in hints)
    assert not any(h.lower() == "kind=handoff" for h in hints)
    assert any("notes/source_dump" in h for h in hints)
    assert any("HANDOFF_FROM_PENTEST.md" in h for h in hints)
    assert any("/workspace/scripts/x.py" in h for h in hints)
    assert any("/opt/app/notes/foo.md" in h for h in hints)


def test_artifact_hints_ignore_host_drive_needles():
    """Lab mount/drive letters are not product needles."""
    thread = [
        {"text": "see /mnt/d/Coding/foo/bar.txt and D:\\Coding\\secret.log on this box"},
    ]
    hints = extract_artifact_hints(thread, [])
    assert hints == []
    assert not any("/mnt/" in h or "D:\\" in h or "D:/" in h for h in hints)


def test_this_turn_task_overlays_empty_sticky_context():
    from app.services.case_context import conv_context_with_this_turn_task

    overlay = conv_context_with_this_turn_task(
        {},
        {
            "target": {"type": "url", "value": "http://host.docker.internal:8080"},
            "scope": {"allow": ["http://host.docker.internal:8080"]},
        },
    )
    hosts = extract_hosts_from_task(overlay.get("task"))
    assert "host.docker.internal" in hosts


def test_this_turn_target_wins_over_sticky_task():
    from app.services.case_context import conv_context_with_this_turn_task

    overlay = conv_context_with_this_turn_task(
        {"task": {"target": {"type": "url", "value": "http://old.example"}}},
        {"target": {"type": "url", "value": "http://host.docker.internal:8080"}},
    )
    hosts = extract_hosts_from_task(overlay.get("task"))
    assert "host.docker.internal" in hosts
    assert "old.example" not in hosts


def test_extract_hosts_from_task_target_and_scope():
    hosts = extract_hosts_from_task(
        {
            "target": {"type": "url", "value": "http://host.docker.internal:3000"},
            "scope": {"allow": ["http://host.docker.internal:3000", "10.0.0.1"]},
        }
    )
    assert "host.docker.internal" in hosts
    assert "10.0.0.1" in hosts
    # Port is not part of address key
    assert not any("3000" in h for h in hosts)


def test_task_scope_asset_ids_keeps_valid_uuids_only():
    aid = "948484b0-aaaa-4b03-81d3-916b7cbd6cd0"
    assert task_scope_asset_ids({"scope": {"asset_ids": [aid, "not-a-uuid", aid]}}) == [aid]
    assert task_scope_asset_ids({"scope": {"allow": ["localhost"]}}) == []


def test_unique_identity_skips_ambiguous_key():
    a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    catalog = [
        (a, {"host.docker.internal", "localhost"}),
        (b, {"other.local", "localhost"}),
    ]
    assert unique_identity_asset_ids(["localhost"], catalog) == []
    assert unique_identity_asset_ids(["host.docker.internal"], catalog) == [a]
    assert unique_identity_asset_ids(["localhost", "host.docker.internal"], catalog) == [a]


def test_surface_origin_host_keys_from_ledger():
    hosts = surface_origin_host_keys(
        {
            "surface_ledger": {
                "surfaces": [
                    {"origin_key": "http://localhost:3000", "path_key": "/"},
                    {"origin_key": "http://localhost:3000", "path_key": "/login"},
                    {"location": "http://10.0.0.1:8080/x"},
                ]
            }
        }
    )
    assert hosts == ["localhost", "10.0.0.1"]


def test_case_intel_alias_allow_maps_ports_onto_owner_host():
    task = {"scope": {"allow": ["http://localhost:3000"]}}
    identities = {"a1": {"host.docker.internal", "localhost"}}
    scope = case_intel_port_scope(
        [("a1", "host.docker.internal")],
        task,
        identities=identities,
    )
    assert scope["a1"] == {"3000"}
    assert intel_matches_case_scope(asset_id="a1", port="3000", port_scope=scope) is True
    assert intel_matches_case_scope(asset_id="a1", port="8080", port_scope=scope) is False


def test_extract_scope_ports_named_service_not_sibling():
    ports = extract_scope_ports_from_task(
        {
            "target": {"type": "url", "value": "http://host.docker.internal:3000"},
            "scope": {"allow": ["http://host.docker.internal:3000"]},
        }
    )
    assert ports["host.docker.internal"] == ["3000"]


def test_extract_scope_ports_host_only_has_no_named_ports():
    ports = extract_scope_ports_from_task(
        {
            "target": {"type": "url", "value": "http://host.docker.internal"},
            "scope": {"allow": ["http://host.docker.internal"]},
        }
    )
    assert ports["host.docker.internal"] == []


def test_extract_scope_ports_structured_port_field():
    ports = extract_scope_ports_from_task(
        {"target": {"type": "host", "value": "lab.local", "port": "8443"}}
    )
    assert ports["lab.local"] == ["8443"]


def test_case_intel_scope_3000_keeps_host_level_drops_8080():
    task = {
        "target": {"type": "url", "value": "http://host.docker.internal:3000"},
        "scope": {"allow": ["http://host.docker.internal:3000"]},
    }
    scope = case_intel_port_scope([("a1", "host.docker.internal")], task)
    assert scope["a1"] == {"3000"}
    assert intel_matches_case_scope(asset_id="a1", port=None, port_scope=scope) is True
    assert intel_matches_case_scope(asset_id="a1", port="", port_scope=scope) is True
    assert intel_matches_case_scope(asset_id="a1", port="3000", port_scope=scope) is True
    assert intel_matches_case_scope(asset_id="a1", port="8080", port_scope=scope) is False


def test_case_intel_scope_host_only_includes_all_services():
    task = {
        "target": {"type": "url", "value": "http://host.docker.internal"},
        "scope": {"allow": ["http://host.docker.internal"]},
    }
    scope = case_intel_port_scope([("a1", "host.docker.internal")], task)
    assert scope["a1"] is None
    assert intel_matches_case_scope(asset_id="a1", port="8080", port_scope=scope) is True


def test_case_intel_scope_per_host_ports():
    task = {
        "scope": {
            "allow": [
                "http://alpha.lab:3000",
                "http://beta.lab:8080",
            ]
        }
    }
    scope = case_intel_port_scope(
        [("a1", "alpha.lab"), ("b1", "beta.lab")],
        task,
    )
    assert scope["a1"] == {"3000"}
    assert scope["b1"] == {"8080"}
    assert intel_matches_case_scope(asset_id="a1", port="8080", port_scope=scope) is False
    assert intel_matches_case_scope(asset_id="b1", port="8080", port_scope=scope) is True
    assert intel_matches_case_scope(asset_id="a1", port=None, port_scope=scope) is True


def test_scope_intel_card_is_thin_and_disciplined():
    card = build_scope_intel_card(
        hosts=[
            {
                "id": "a1",
                "address": "host.docker.internal",
                "name": "本机docker",
                "ports": ["3000", "8080"],
                "on_ledger": True,
            }
        ],
        prior_counts={"total": 211, "open_or_retest": 180, "by_severity": {"critical": 40, "high": 50}},
        high_sample=[
            {"id": "v1", "severity": "critical", "title": "SQLi login", "location": "/rest/user/login"},
        ],
        surface_paths=["/rest/user/login", "/file-upload", "/api/Users"],
        sample_urls=["http://host.docker.internal:3000/api/Users"],
        this_case_surface_n=0,
    )
    assert card is not None
    assert card["hosts"][0]["address"] == "host.docker.internal"
    assert card["prior_findings"]["total"] == 211
    assert len(card["high_priority_sample"]) == 1
    assert "known_paths" in card["surface_sketch"]
    assert "expand" in card["discipline"].lower() or "Primary work" in card["discipline"]
    assert "index" in card["discipline"].lower()
    assert "interleaved" not in card["discipline"].lower()
    # No PoC field in sample
    assert "poc" not in card["high_priority_sample"][0]


def test_scope_intel_card_coverage_counts_and_samples():
    card = build_scope_intel_card(
        hosts=[{"id": "a1", "address": "lab.example", "on_ledger": True}],
        coverage={
            "new": 1,
            "untested": 2,
            "tested": 1,
            "skipped": 1,
            "untested_samples": ["/login", "/api"],
        },
    )
    assert card is not None
    sketch = card["surface_sketch"]
    assert sketch["untested"] == 2
    assert sketch["tested"] == 1
    assert sketch["skipped"] == 1
    assert sketch["untested_samples"][0] == "/login"
    assert "finding(get)" in card["discipline"]
    assert "platform_get_vulnerability" not in card["discipline"]


def test_coverage_sketch_from_surfaces_caps_untested_samples():
    rows = [
        {"coverage": "tested", "path_key": "/ok"},
        {"coverage": "skipped", "path_key": "/skip"},
        {"coverage": "untested", "status": "seen", "path_key": "/login"},
        {"coverage": "untested", "location": "/api"},
        *[{"coverage": "untested", "path_key": f"/extra{i}"} for i in range(6)],
    ]
    sketch = coverage_sketch_from_surfaces(rows)
    assert sketch["tested"] == 1
    assert sketch["skipped"] == 1
    assert sketch["untested"] == 8
    assert sketch["new"] == 1
    assert "/login" in sketch["untested_samples"]
    assert len(sketch["untested_samples"]) == 5


def test_prior_index_module_key_folds_dvwa_paths():
    assert prior_index_module_key("/vulnerabilities/exec/") == "/vulnerabilities/exec"
    assert prior_index_module_key("/hackable/uploads/cmd_shell.php") == "/hackable/uploads"
    assert prior_index_module_key("http://host.docker.internal:8080/vulnerabilities/sqli/?id=1") == "/vulnerabilities/sqli"


def test_collapse_prior_index_folds_rediscoveries():
    rows = [
        {
            "id": "a",
            "severity": "critical",
            "title": "DVWA OS命令注入漏洞（RCE）",
            "location": "/vulnerabilities/exec/",
            "vuln_type": "command_injection",
            "port": "8080",
            "asset_id": "h1",
            "summary": "low ;id",
        },
        {
            "id": "b",
            "severity": "critical",
            "title": "DVWA OS命令注入漏洞（RCE）",
            "location": "/vulnerabilities/exec",
            "vuln_type": "command_injection",
            "port": "8080",
            "asset_id": "h1",
            "summary": "high pipe",
        },
        {
            "id": "c",
            "severity": "high",
            "title": "SQL注入",
            "location": "/vulnerabilities/sqli/",
            "vuln_type": "sqli",
            "port": "8080",
            "asset_id": "h1",
            "summary": "union",
        },
        {
            "id": "d",
            "severity": "critical",
            "title": "上传目录Webshell",
            "location": "/hackable/uploads/cmd_shell.php",
            "port": "8080",
            "asset_id": "h1",
            "summary": "unauth rce",
        },
        {
            "id": "e",
            "severity": "critical",
            "title": "已上传的Webshell文件暴露",
            "location": "/hackable/uploads/shell.php",
            "vuln_type": "rce",
            "port": "8080",
            "asset_id": "h1",
            "summary": "shell.php",
        },
    ]
    out = collapse_prior_index(rows, limit=24)
    assert len(out) == 3
    exec_row = next(r for r in out if r["location"] == "/vulnerabilities/exec")
    assert exec_row["discoveries"] == 2
    assert exec_row["id"] == "a"
    assert next(r for r in out if r["location"] == "/vulnerabilities/sqli")["discoveries"] == 1
    assert next(r for r in out if r["location"] == "/hackable/uploads")["discoveries"] == 2


def test_vuln_scope_sql_empty_does_not_match_all():
    from app.services.case_context import vuln_scope_sql_clause

    clause = vuln_scope_sql_clause({})
    text = str(clause.compile(compile_kwargs={"literal_binds": True})).lower()
    assert "false" in text


def test_payload_includes_scope_intel():
    payload = build_case_context_payload(
        messages=[],
        findings=[],
        conversation_id="conv-x",
        scope_intel=build_scope_intel_card(
            hosts=[{"address": "lab.local", "on_ledger": True, "ports": ["80"]}],
            prior_counts={"total": 3, "open_or_retest": 2, "by_severity": {"high": 2}},
        ),
    )
    assert payload.get("scope_intel")
    assert payload["scope_intel"]["hosts"][0]["address"] == "lab.local"
    assert "scope_intel" in payload["note"]


def test_payload_includes_intel_summary_distinct_from_scope_intel():
    payload = build_case_context_payload(
        messages=[],
        findings=[],
        conversation_id="conv-x",
        intel_summary=[
            {"id": "i1", "summary": "admin:admin invalid", "kind": "credential_status", "asset_id": "a1"},
        ],
    )
    assert payload["intel_summary"][0]["id"] == "i1"
    assert "intel_summary" in payload["note"]
    assert "sibling ports" in payload["note"]
    assert "scope_intel" not in payload


def test_excerpt_and_role_helpers():
    assert excerpt_from_properties({"stdout": "hello world proof"}) == "hello world proof"
    assert evidence_role({"role": "trace"}) == "trace"
    assert evidence_role({"excerpt": "x" * 40}, "shell") == "proof"
    assert evidence_role({}, "todo") == "trace"
    # Book-time Case evidence (source_tool=finding) is product proof, not meta noise.
    assert evidence_role({"role": "proof", "observation": "SQL syntax error near ''1'''"}, "finding") == "proof"
    assert "SQL syntax" in excerpt_from_properties({"observation": "SQL syntax error near ''1'''"})
    assert path_or_url_from_properties({"location": "/vulnerabilities/sqli/"}) == "/vulnerabilities/sqli/"


def test_evidence_snippets_include_book_time_finding_proof():
    rows = [
        {
            "evidence_id": "ev_book_1",
            "summary": "SQLi @ /vulnerabilities/sqli/",
            "source_tool": "finding",
            "properties": {
                "role": "proof",
                "kind": "proof",
                "path_or_url": "http://t/vulnerabilities/sqli/",
                "observation": "You have an error in your SQL syntax near ''1'''",
                "excerpt": "You have an error in your SQL syntax near ''1'''",
            },
        }
    ]
    snippets = build_evidence_snippets(rows, referenced_ids=["ev_book_1"], limit=5)
    assert len(snippets) == 1
    assert snippets[0]["id"] == "ev_book_1"
    assert snippets[0]["role"] == "proof"
    assert "SQL syntax" in (snippets[0].get("excerpt") or "")
    assert "sqli" in (snippets[0].get("path_or_url") or "").lower()

