"""Attack-surface model helpers: actors / resources from recon (P0.1).

Generic aggregation from paths — not target-specific answer keys.
"""

from __future__ import annotations

import re
from typing import Any

from node5.identity import normalize_path
from node5.state import Actor, PenState, Resource, Surface

_SKIP_SEG = frozenset(
    {
        "api",
        "rest",
        "v1",
        "v2",
        "v3",
        "public",
        "assets",
        "static",
        "js",
        "css",
        "images",
        "img",
        "fonts",
        "well-known",
        "i18n",
        "locales",
    }
)

# Resource names that are almost always static noise (not business objects)
_NOISE_RESOURCE_NAMES = frozenset(
    {
        "app",
        "main",
        "polyfill",
        "runtime",
        "vendor",
        "chunk",
        "style",
        "styles",
        "script",
        "scripts",
        "favicon",
        "robot",
        "robots",
        "sitemap",
        "manifest",
        "sw",
        "service-worker",
        "sockjs",
        "socket",
        "icon",
        "logo",
        "font",
        "woff",
        "ttf",
        "map",
        "source",
        "sourcemap",
        "assets",
        "static",
        "dist",
        "bundle",
        "webpack",
        "hot-update",
        "browser",
        "zone",
        "rxjs",
        "angular",
        "material",
        "three",
        "orbitcontrol",
        "dat",
        "stat",
        "effectcomposer",
        "renderpass",
        "copyshader",
        "shaderpass",
        "maskpass",
        "starry_background",
        "orangemap2k",
        "earthspec4k",
        "earth_normalmap_flat4k",
        "fair_clouds_4k",
    }
)

# High-value recon path fragments (real apps: keys, logs, docs, fetch sinks)
_HIGH_VALUE_PATH_HINTS = (
    "encryptionkeys",
    "encryption-keys",
    "support/logs",
    "/logs",
    "api-docs",
    "swagger",
    "openapi",
    "graphql",
    "graphiql",
    "metrics",
    "prometheus",
    "actuator",
    "profile/image",
    "image/url",
    "webhook",
    "callback",
    "forgot-password",
    "reset-password",
    "change-password",
    "2fa",
    "totp",
)

_SENSITIVE_HINTS = (
    "user",
    "account",
    "admin",
    "auth",
    "login",
    "password",
    "token",
    "basket",
    "cart",
    "order",
    "payment",
    "card",
    "address",
    "complaint",
    "message",
    "privacy",
    "upload",
    "ftp",
    "secret",
    "key",
    "session",
)


def is_noise_path(path: str) -> bool:
    """Static asset / SPA bundle paths that should not inflate resources."""
    p = (path or "").lower()
    if re.search(r"\.(css|js|map|woff2?|ttf|eot|ico|png|jpe?g|gif|svg|webp|avif|mp4|webm)(\?|$)", p):
        if "upload" not in p and "profile" not in p:
            return True
    if any(x in p for x in ("/assets/", "/static/", "/dist/", "polyfill", "hot-update")):
        if "upload" not in p:
            return True
    return False


def resource_name_from_path(path: str) -> str | None:
    """Derive a coarse resource name from a URL path. None = skip (noise)."""
    if is_noise_path(path):
        return None
    p = normalize_path(path) or (path or "").strip().lower()
    parts = [x for x in p.split("/") if x]
    for seg in parts:
        base = re.sub(r"\{[^}]+\}", "", seg)
        base = base.split(".")[0]
        if not base or base in _SKIP_SEG:
            continue
        if base.isdigit() or re.match(r"^[0-9a-f-]{8,}$", base):
            continue
        # normalize common plurals lightly
        name = base.lower()
        if name.endswith("ies") and len(name) > 4:
            name = name[:-3] + "y"
        elif name.endswith("s") and not name.endswith("ss") and len(name) > 3:
            name = name[:-1]
        if name in _NOISE_RESOURCE_NAMES:
            return None
        return name
    if any(x in p for x in ("/ftp", "upload", "encryptionkey", "/logs")):
        return "files"
    return None


def infer_sensitivity(name: str, paths: list[str], notes: str = "") -> str:
    blob = f"{name} {' '.join(paths)} {notes}".lower()
    if any(x in blob for x in ("admin", "config", "secret", "key", "ftp", "backup", "hash")):
        return "secret" if any(x in blob for x in ("secret", "key", "hash", "password", "ftp")) else "admin"
    if any(h in blob for h in _SENSITIVE_HINTS):
        return "user"
    if any(x in blob for x in ("product", "catalog", "search", "challenge", "static", "metrics")):
        return "public"
    return "user"


def merge_actor(state: PenState, incoming: Actor) -> None:
    aid = (incoming.id or "").strip() or "anon"
    for a in state.actors:
        if a.id == aid:
            if incoming.role_hint and incoming.role_hint != "unknown":
                a.role_hint = incoming.role_hint
            if incoming.how and incoming.how != "none":
                a.how = incoming.how
            if incoming.notes and not a.notes:
                a.notes = incoming.notes
            for k in incoming.cookie_keys:
                if k not in a.cookie_keys:
                    a.cookie_keys.append(k)
            return
    state.actors.append(incoming.model_copy(update={"id": aid}))


def merge_resource(state: PenState, incoming: Resource) -> None:
    name = (incoming.name or "").strip().lower()
    if not name:
        return
    for r in state.resources:
        if r.name.lower() == name:
            for p in incoming.paths:
                np = normalize_path(p, state.target) or p
                if np and np not in r.paths:
                    r.paths.append(np)
            for loc in incoming.id_locations:
                if loc and loc not in r.id_locations:
                    r.id_locations.append(loc)
            for act in incoming.actions_seen:
                au = (act or "").upper()
                if au and au not in r.actions_seen:
                    r.actions_seen.append(au)
            rank = {"public": 0, "user": 1, "admin": 2, "secret": 3}
            if rank.get(incoming.sensitivity, 0) > rank.get(r.sensitivity, 0):
                r.sensitivity = incoming.sensitivity
            st_rank = {"open": 0, "probed": 1, "booked": 2, "deadend": 1, "skipped": 0}
            if st_rank.get(incoming.status, 0) > st_rank.get(r.status, 0):
                r.status = incoming.status
            if incoming.notes and not r.notes:
                r.notes = incoming.notes
            return
    state.resources.append(
        incoming.model_copy(
            update={
                "name": name,
                "paths": list(dict.fromkeys(incoming.paths)),
                "actions_seen": [a.upper() for a in incoming.actions_seen if a],
            }
        )
    )


def parse_actors_from_payload(payload: dict[str, Any]) -> list[Actor]:
    out: list[Actor] = []
    raw = payload.get("actors") or payload.get("identities") or []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if isinstance(item, str):
            out.append(Actor(id=item.strip() or "anon"))
            continue
        if not isinstance(item, dict):
            continue
        try:
            out.append(
                Actor.model_validate(
                    {
                        "id": item.get("id") or item.get("name") or "anon",
                        "role_hint": item.get("role_hint") or item.get("role") or "unknown",
                        "how": item.get("how") or item.get("method") or "none",
                        "cookie_keys": item.get("cookie_keys") or item.get("cookies") or [],
                        "notes": item.get("notes") or item.get("note") or "",
                    }
                )
            )
        except Exception:
            continue
    return out


def parse_resources_from_payload(payload: dict[str, Any]) -> list[Resource]:
    out: list[Resource] = []
    raw = payload.get("resources") or payload.get("objects") or payload.get("entities") or []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if isinstance(item, str):
            out.append(Resource(name=item.strip().lower()))
            continue
        if not isinstance(item, dict):
            continue
        name = item.get("name") or item.get("resource") or item.get("type") or ""
        paths = item.get("paths") or item.get("endpoints") or []
        if isinstance(paths, str):
            paths = [paths]
        try:
            out.append(
                Resource.model_validate(
                    {
                        "name": str(name).strip().lower(),
                        "paths": [str(p) for p in paths],
                        "id_locations": item.get("id_locations")
                        or item.get("id_params")
                        or [],
                        "sensitivity": item.get("sensitivity") or item.get("level") or "user",
                        "actions_seen": item.get("actions_seen")
                        or item.get("methods")
                        or item.get("actions")
                        or [],
                        "status": item.get("status") or "open",
                        "notes": item.get("notes") or item.get("note") or "",
                    }
                )
            )
        except Exception:
            if name:
                out.append(Resource(name=str(name).lower(), paths=[str(p) for p in paths]))
    return out


def salvage_model_from_surfaces(state: PenState) -> tuple[int, int]:
    """Deterministic fill of actors/resources when model omitted them.

    Returns (actors_added, resources_touched).
    """
    a0 = len(state.actors)
    if not any(a.id == "anon" for a in state.actors):
        merge_actor(state, Actor(id="anon", role_hint="anon", how="none", notes="default unauthenticated"))
    # pending register/login actors if surfaces suggest
    blob = " ".join(f"{s.path} {s.note}" for s in state.surfaces).lower()
    if any(x in blob for x in ("register", "signup", "sign-up", "/users")) and not any(
        a.id == "actor_a" for a in state.actors
    ):
        merge_actor(
            state,
            Actor(
                id="actor_a",
                role_hint="customer",
                how="register",
                notes="planned dual-actor A (register if open)",
            ),
        )
    if any(x in blob for x in ("register", "signup", "login")) and not any(
        a.id == "actor_b" for a in state.actors
    ):
        merge_actor(
            state,
            Actor(
                id="actor_b",
                role_hint="customer",
                how="register",
                notes="planned dual-actor B (register if open)",
            ),
        )

    # Aggregate resources from surfaces (skip static noise)
    buckets: dict[str, Resource] = {
        r.name.lower(): r
        for r in state.resources
        if r.name.lower() not in _NOISE_RESOURCE_NAMES
    }
    for s in state.surfaces:
        if is_noise_path(s.path):
            continue
        name = resource_name_from_path(s.path)
        if not name:
            continue
        path = normalize_path(s.path, state.target) or s.path
        method = (s.method or "GET").upper()
        if name not in buckets:
            buckets[name] = Resource(
                name=name,
                paths=[path] if path else [],
                actions_seen=[method] if method else [],
                sensitivity=infer_sensitivity(name, [path], s.note or ""),
                notes=s.note or "",
            )
        else:
            r = buckets[name]
            if path and path not in r.paths:
                r.paths.append(path)
            if method and method not in r.actions_seen:
                r.actions_seen.append(method)
            r.sensitivity = infer_sensitivity(
                name, r.paths, f"{r.notes} {s.note or ''}"
            )
        r = buckets[name]
        # P1.2: tag egress / upload capabilities on resources
        path_l = (path or "").lower()
        note_l = (s.note or "").lower()
        tags: list[str] = []
        if any(
            x in path_l or x in note_l
            for x in (
                "image/url",
                "webhook",
                "callback",
                "fetch",
                "import",
                "avatar",
                "url=",
                "photo",
            )
        ):
            tags.append("egress")
        if any(
            x in path_l or x in note_l
            for x in ("upload", "multipart", "image/file", "/file")
        ):
            tags.append("upload")
        for t in tags:
            if t not in (r.notes or ""):
                r.notes = f"{r.notes} [{t}]".strip()
        # id location hints
        if re.search(r"/\{[^}]+\}|/\d+(?:/|$)", path or ""):
            if "path" not in r.id_locations:
                r.id_locations.append("path")

    state.resources = [r for r in buckets.values() if r.name not in _NOISE_RESOURCE_NAMES]
    # Prefer business-ish / high-value resources first
    def _score(r: Resource) -> int:
        order = {"secret": 0, "admin": 1, "user": 2, "public": 3}
        bonus = 0
        blob = f"{r.name} {' '.join(r.paths)} {r.notes}".lower()
        if any(h in blob for h in _HIGH_VALUE_PATH_HINTS):
            bonus -= 2
        if "[egress]" in (r.notes or "") or "[upload]" in (r.notes or ""):
            bonus -= 1
        return order.get(r.sensitivity, 9) + bonus

    state.resources.sort(key=_score)
    return len(state.actors) - a0, len(state.resources)


def high_value_path_checklist() -> str:
    """Prompt bullet for recon of high-value technical surfaces (generic)."""
    return (
        "Also probe common high-value technical paths if in scope (record hits only): "
        "/encryptionkeys, /support/logs, /api-docs, /graphql, /metrics, /actuator, "
        "profile image URL/file upload, forgot/reset/change-password, webhook/callback URLs."
    )


def surface_model_ok(state: PenState) -> tuple[bool, str]:
    """Feedback: business surface model adequacy after surface stage."""
    if state.dry_run:
        return True, "dry-run"
    n_res = len(state.resources)
    n_act = len(state.actors)
    if n_res >= 2 and n_act >= 1:
        return True, f"resources={n_res} actors={n_act}"
    if n_res >= 1 and len(state.surfaces) >= 6:
        return True, f"resources={n_res} actors={n_act} surfaces_ok"
    return False, f"resources={n_res} actors={n_act} need resources>=2 or >=1 with surfaces"
