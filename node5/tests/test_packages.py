"""Package scoring: SPA/API vs DVWA-style path selection (no target answer keys)."""

from __future__ import annotations

from pathlib import Path

from node5.packages import packages_from_surfaces
from node5.state import PenState, Surface


def _pack_root() -> Path:
    # repo experts/pentest
    here = Path(__file__).resolve()
    node5_root = here.parents[1]  # node5/
    pack = node5_root.parent / "experts" / "pentest"
    assert pack.is_dir(), pack
    return pack


def test_spa_api_surfaces_prefer_api_auth_sql_not_sitemap_xxe():
    state = PenState(
        target="http://127.0.0.1:3000",
        pack_root=str(_pack_root()),
        max_workers=4,
        surfaces=[
            Surface(path="/", note="spa"),
            Surface(path="/sitemap.xml", note="html not xml api"),
            Surface(path="/rest/user/login", method="POST"),
            Surface(path="/rest/products/search", note="q param"),
            Surface(path="/rest/basket/1"),
            Surface(path="/api/Users", method="POST", note="register"),
            Surface(path="/api/Products"),
            Surface(path="/api/Feedbacks"),
            Surface(path="/rest/products/1/reviews"),
            Surface(path="/ftp/"),
        ],
    )
    pkgs = packages_from_surfaces(state, max_workers=4, pack_root=_pack_root())
    skills = [p["skill_id"] for p in pkgs]
    assert "pentest-xxe" not in skills, skills
    assert "pentest-api" in skills or "pentest-auth-session" in skills, skills
    # multi-skill: expect injection or authz among top set
    assert any(
        s in skills
        for s in (
            "pentest-sql-injection",
            "pentest-authz-logic",
            "pentest-auth-session",
            "pentest-xss",
        )
    ), skills


def test_dvwa_style_paths_still_select_classic_modules():
    state = PenState(
        target="http://127.0.0.1:8080",
        pack_root=str(_pack_root()),
        max_workers=4,
        surfaces=[
            Surface(path="/vulnerabilities/sqli/"),
            Surface(path="/vulnerabilities/xss_r/"),
            Surface(path="/vulnerabilities/upload/"),
            Surface(path="/vulnerabilities/exec/"),
            Surface(path="/vulnerabilities/fi/"),
            Surface(path="/login.php"),
        ],
    )
    pkgs = packages_from_surfaces(state, max_workers=4, pack_root=_pack_root())
    skills = [p["skill_id"] for p in pkgs]
    assert "pentest-sql-injection" in skills, skills
    assert "pentest-xss" in skills, skills
    assert any(
        s in skills for s in ("pentest-file-upload", "pentest-service-exposure")
    ), skills
