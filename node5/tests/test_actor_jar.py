"""P0.2 multi-actor cookie jar isolation."""

from __future__ import annotations

from node5.tools_act import CookieJar


def test_actor_jars_isolated():
    jar = CookieJar({"shared": "1"})
    jar.merge({"token": "AAA"}, actor="actor_a")
    jar.merge({"token": "BBB"}, actor="actor_b")
    assert "AAA" in jar.header_value("actor_a")
    assert "BBB" in jar.header_value("actor_b")
    assert "AAA" not in jar.header_value("actor_b")
    assert jar.auth_bearer("actor_a") == "Bearer AAA"
    assert jar.auth_bearer("actor_b") == "Bearer BBB"


def test_default_jar_unchanged_by_actor_merge():
    jar = CookieJar({"token": "DEF"})
    jar.merge({"token": "A"}, actor="actor_a")
    assert jar.snapshot()["token"] == "DEF"
    assert jar.snapshot_actors()["actor_a"]["token"] == "A"
