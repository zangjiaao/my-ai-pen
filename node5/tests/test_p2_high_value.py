"""P2 high-value capability: noise filter, forced packages, refs."""

from __future__ import annotations

from pathlib import Path

from node5.feedback import evidence_quality_gate
from node5.knowledge import query_refs
from node5.packages import packages_from_surfaces
from node5.state import Candidate, PenState, Surface
from node5.surface_model import (
    is_noise_path,
    resource_name_from_path,
    salvage_model_from_surfaces,
)


def test_noise_paths_filtered():
    assert is_noise_path("/polyfills.js")
    assert is_noise_path("/assets/public/favicon.ico")
    assert not is_noise_path("/profile/image/url")
    assert not is_noise_path("/api/Users")
    assert resource_name_from_path("/main.js") is None
    assert resource_name_from_path("/api/BasketItems") in ("basketitem", "basket")


def test_salvage_drops_static_noise_resources():
    state = PenState(
        target="http://t",
        surfaces=[
            Surface(path="/polyfills.js"),
            Surface(path="/main.js"),
            Surface(path="/styles.css"),
            Surface(path="/api/Users"),
            Surface(path="/api/BasketItems"),
            Surface(path="/profile/image/url", note="avatar url"),
            Surface(path="/rest/products/search"),
            Surface(path="/ftp/"),
            Surface(path="/rest/user/login"),
        ],
    )
    salvage_model_from_surfaces(state)
    names = {r.name for r in state.resources}
    assert "polyfill" not in names
    assert "main" not in names
    assert any(n in names for n in ("user", "basket", "basketitem", "product", "ftp", "file"))
    assert len(state.resources) <= 12


def test_force_ssrf_package_when_image_url():
    pack = Path(__file__).resolve().parents[1].parent / "experts" / "pentest"
    state = PenState(
        target="http://127.0.0.1:3000",
        pack_root=str(pack),
        max_workers=4,
        surfaces=[
            Surface(path="/api/Products"),
            Surface(path="/api/Users"),
            Surface(path="/api/BasketItems"),
            Surface(path="/api/Feedbacks"),
            Surface(path="/rest/user/login", method="POST"),
            Surface(path="/profile/image/url", note="server fetches avatar url"),
            Surface(path="/rest/products/search"),
        ],
    )
    pkgs = packages_from_surfaces(state, max_workers=4, pack_root=pack)
    skills = [p["skill_id"] for p in pkgs]
    assert "pentest-ssrf" in skills, skills
    ssrf = next(p for p in pkgs if p["skill_id"] == "pentest-ssrf")
    assert any("image" in (x or "") or "url" in (x or "") for x in ssrf.get("paths") or [])
    # discovery P2: effective workers expanded / forced recorded
    assert state.effective_max_workers >= 4
    assert "pentest-ssrf" in (state.forced_packages or skills)


def test_force_sql_when_search():
    pack = Path(__file__).resolve().parents[1].parent / "experts" / "pentest"
    state = PenState(
        target="http://t",
        pack_root=str(pack),
        max_workers=3,
        surfaces=[
            Surface(path="/api/Users"),
            Surface(path="/api/Products"),
            Surface(path="/api/BasketItems"),
            Surface(path="/rest/products/search", note="q="),
            Surface(path="/rest/user/login"),
        ],
    )
    pkgs = packages_from_surfaces(state, max_workers=3, pack_root=pack)
    skills = [p["skill_id"] for p in pkgs]
    assert "pentest-sql-injection" in skills, skills


def test_force_ssrf_and_sql_under_tight_max_workers():
    """P2: image/url + search must both schedule even when max_workers is small."""
    pack = Path(__file__).resolve().parents[1].parent / "experts" / "pentest"
    state = PenState(
        target="http://t",
        pack_root=str(pack),
        max_workers=3,
        surfaces=[
            Surface(path="/api/Users"),
            Surface(path="/api/Products"),
            Surface(path="/api/BasketItems"),
            Surface(path="/api/Feedbacks"),
            Surface(path="/api/Quantitys"),
            Surface(path="/rest/user/login"),
            Surface(path="/rest/products/search", note="q="),
            Surface(path="/profile/image/url", note="egress"),
            Surface(path="/encryptionkeys", note="[key_material]"),
        ],
    )
    pkgs = packages_from_surfaces(state, max_workers=3, pack_root=pack)
    skills = [p["skill_id"] for p in pkgs]
    assert "pentest-ssrf" in skills, skills
    assert "pentest-sql-injection" in skills, skills
    assert state.effective_max_workers >= len(skills)


def test_jwt_advanced_ref():
    pack = Path(__file__).resolve().parents[1].parent / "experts" / "pentest"
    hits = query_refs(pack, "jwt advanced signed encryptionkeys", kind="payloads", limit=5)
    assert any("jwt" in h["path"] for h in hits)


def test_nosql_ref():
    pack = Path(__file__).resolve().parents[1].parent / "experts" / "pentest"
    hits = query_refs(pack, "nosql mongo injection", kind="payloads", limit=5)
    assert any("nosql" in h["path"] for h in hits)


def test_ssti_gate():
    c = Candidate(
        title="SSTI in profile username",
        location="/profile",
        proof_excerpt="POST username=#{7*7} HTTP 200 template evaluated shows 49",
        causality="c",
        reproducibility="r",
        impact="i",
        ready_to_book=True,
    )
    ok, reason = evidence_quality_gate(c)
    assert ok, reason
    c2 = Candidate(
        title="SSTI suspected",
        location="/profile",
        proof_excerpt="GET /profile looks like pug template",
        causality="c",
        reproducibility="r",
        impact="i",
    )
    ok2, _ = evidence_quality_gate(c2)
    assert not ok2
