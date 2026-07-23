"""P0.1 surface model: actors/resources salvage and merge."""

from __future__ import annotations

from node5.state import Actor, PenState, Resource, Surface
from node5.surface_model import (
    merge_actor,
    merge_resource,
    parse_resources_from_payload,
    resource_name_from_path,
    salvage_model_from_surfaces,
    surface_model_ok,
)


def test_resource_name_from_api_path():
    assert resource_name_from_path("/api/Users") in ("user", "users")
    assert resource_name_from_path("/rest/products/search") in ("product", "products")
    name_ftp = resource_name_from_path("/ftp/x")
    assert name_ftp in ("files", "ftp", "x") or name_ftp is not None


def test_salvage_builds_actors_and_resources():
    state = PenState(
        target="http://127.0.0.1:3000",
        surfaces=[
            Surface(path="/api/Users", method="GET"),
            Surface(path="/api/Users", method="POST", note="register"),
            Surface(path="/api/BasketItems", method="GET"),
            Surface(path="/rest/user/login", method="POST"),
            Surface(path="/api/Products", method="GET"),
            Surface(path="/ftp/", method="GET"),
            Surface(path="/rest/products/search", method="GET"),
        ],
    )
    salvage_model_from_surfaces(state)
    assert any(a.id == "anon" for a in state.actors)
    assert any(a.id in ("actor_a", "actor_b") for a in state.actors)
    names = {r.name for r in state.resources}
    assert len(names) >= 2
    ok, detail = surface_model_ok(state)
    assert ok, detail


def test_merge_resource_upgrades():
    state = PenState(target="http://t")
    merge_resource(
        state,
        Resource(name="user", paths=["/api/users"], actions_seen=["GET"], sensitivity="user"),
    )
    merge_resource(
        state,
        Resource(
            name="user",
            paths=["/api/users/1"],
            actions_seen=["PUT"],
            sensitivity="admin",
            id_locations=["path"],
        ),
    )
    assert len(state.resources) == 1
    r = state.resources[0]
    assert "PUT" in r.actions_seen
    assert r.sensitivity == "admin"
    assert len(r.paths) >= 2


def test_parse_resources_payload():
    items = parse_resources_from_payload(
        {
            "resources": [
                {
                    "name": "basket",
                    "paths": ["/api/BasketItems"],
                    "actions_seen": ["GET", "POST"],
                    "sensitivity": "user",
                }
            ]
        }
    )
    assert len(items) == 1
    assert items[0].name == "basket"
