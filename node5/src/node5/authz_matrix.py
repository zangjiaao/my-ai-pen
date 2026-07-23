"""Deterministic dual-actor authz matrix (track 1c).

Bounded HTTP: seed actors if needed, sample ≤3 object resources, record
anon / actor_a / actor_b status for GET (and light write). Emits candidates
on differentials. Medium for unauth reads of sensitive lists; high for
cross-user write/delete.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

from node5.coverage import record_coverage, coverage_outcome
from node5.identity import normalize_path
from node5.state import Candidate, PenState

def record_coverage_authz(state, cov_id, *, action="", status=None, evidence=""):
    outcome = "attempted"
    if status == "booked":
        outcome = "closed"
    elif status == "deadend":
        outcome = "failed"
    elif status == "skipped":
        outcome = "blocked"
    detail = f"{action} {evidence or ''}".strip()
    record_coverage(state, cov_id, outcome=outcome, detail=detail)



def _base(target: str) -> str:
    t = (target or "").rstrip("/")
    if not t.startswith("http"):
        t = "http://" + t
    return t


def _host_ok(url: str, base: str) -> bool:
    try:
        return urlparse(url).hostname == urlparse(base).hostname
    except Exception:
        return False


def _hdr(state: PenState, actor: str = "") -> dict[str, str]:
    bag: dict[str, str] = {}
    if actor and state.actor_cookies.get(actor):
        bag = dict(state.actor_cookies[actor])
    elif state.cookies:
        bag = dict(state.cookies)
    h: dict[str, str] = {}
    if bag:
        h["Cookie"] = "; ".join(f"{k}={v}" for k, v in bag.items())
        for key in ("token", "jwt", "access_token"):
            if bag.get(key):
                val = str(bag[key])
                h["Authorization"] = (
                    val if val.lower().startswith("bearer") else f"Bearer {val}"
                )
                if "token=" not in h["Cookie"]:
                    h["Cookie"] = (h["Cookie"] + f"; token={val}").strip("; ")
                break
    return h


def _seed_two_actors(
    state: PenState, client: httpx.Client, base: str, budget: list[int]
) -> list[str]:
    """Ensure actor_a and actor_b tokens exist; return actor ids ready."""
    ready = [
        a
        for a in ("actor_a", "actor_b")
        if state.actor_cookies.get(a) and any(
            k in state.actor_cookies[a] for k in ("token", "jwt", "access_token")
        )
    ]
    if len(ready) >= 2:
        return ready[:2]

    for aid in ("actor_a", "actor_b"):
        if aid in ready:
            continue
        if budget[0] >= 20:
            break
        email = f"n5{aid}{int(time.time()) % 100000}@lab.invalid"
        password = "N5Authz!234"
        for rpath in ("/api/Users", "/rest/user/register"):
            url = urljoin(base + "/", rpath.lstrip("/"))
            if not _host_ok(url, base):
                continue
            try:
                client.post(
                    url,
                    content=json.dumps(
                        {
                            "email": email,
                            "password": password,
                            "passwordRepeat": password,
                            "securityQuestion": {"id": 1, "question": "q"},
                            "securityAnswer": "a",
                        }
                    ).encode(),
                    headers={"Content-Type": "application/json"},
                )
                budget[0] += 1
            except Exception:
                continue
            break
        for lpath in ("/rest/user/login", "/api/Users/login"):
            url = urljoin(base + "/", lpath.lstrip("/"))
            try:
                resp = client.post(
                    url,
                    content=json.dumps({"email": email, "password": password}).encode(),
                    headers={"Content-Type": "application/json"},
                )
                budget[0] += 1
                data = resp.json() if resp.content else {}
            except Exception:
                continue
            tok = ""
            if isinstance(data, dict):
                auth = data.get("authentication") or {}
                if isinstance(auth, dict):
                    tok = str(auth.get("token") or "")
                tok = tok or str(data.get("token") or "")
            if tok:
                state.actor_cookies.setdefault(aid, {})["token"] = tok
                if not state.cookies.get("token"):
                    state.cookies["token"] = tok
                ready.append(aid)
                state.note(f"authz_matrix: seeded {aid}")
                break
    return ready[:2]


def _candidate_paths(state: PenState) -> list[str]:
    paths: list[str] = []
    for s in state.surfaces:
        p = (s.path or "").split("?", 1)[0]
        pl = p.lower()
        if any(
            x in pl
            for x in (
                "basket",
                "basketitem",
                "users",
                "order",
                "complaint",
                "address",
                "card",
                "feedback",
            )
        ):
            if p not in paths:
                paths.append(p)
    for r in state.resources:
        for p in r.paths[:3]:
            if p and p not in paths:
                paths.append(p)
    # Prefer collection endpoints
    prefer = [p for p in paths if re.search(r"/(api|rest)/", p, re.I)]
    return (prefer or paths)[:6]


def _extract_ids(body: str) -> list[str]:
    ids = re.findall(r'"id"\s*:\s*(\d+)', body or "")
    # unique preserve order
    out: list[str] = []
    for i in ids:
        if i not in out:
            out.append(i)
    return out[:5]


def run_authz_matrix(state: PenState) -> dict[str, Any]:
    """Fill state.authz_matrix and optional candidates. Returns summary."""
    if state.dry_run:
        record_coverage_authz(state, "authz_matrix", action="dry-run", status="skipped")
        return {"dry_run": True}

    base = _base(state.target)
    budget = [0]
    cells: list[dict[str, Any]] = []
    try:
        client = httpx.Client(timeout=12.0, follow_redirects=True, verify=False)
    except Exception as e:
        return {"error": str(e)}

    try:
        record_coverage_authz(
            state, "authz_matrix", action="matrix_start", status="in_progress"
        )
        actors = _seed_two_actors(state, client, base, budget)
        actors_full = ["anon"] + actors
        paths = _candidate_paths(state)
        if not paths:
            record_coverage_authz(
                state,
                "authz_matrix",
                action="no object resources",
                status="deadend",
            )
            return {"cells": 0, "booked": False}

        diffs: list[str] = []
        for path in paths[:3]:
            npath = path if path.startswith("/") else "/" + path
            # collection GET as each actor
            id_for_path: str | None = None
            statuses: dict[str, int] = {}
            for actor in actors_full:
                if budget[0] >= 24:
                    break
                url = urljoin(base + "/", npath.lstrip("/"))
                if not _host_ok(url, base):
                    continue
                try:
                    resp = client.get(url, headers=_hdr(state, "" if actor == "anon" else actor))
                    budget[0] += 1
                except Exception:
                    continue
                statuses[actor] = resp.status_code
                cell = {
                    "resource": npath,
                    "actor": actor,
                    "method": "GET",
                    "status": resp.status_code,
                    "id": None,
                }
                cells.append(cell)
                if resp.status_code == 200 and id_for_path is None:
                    ids = _extract_ids(resp.text or "")
                    if ids:
                        id_for_path = ids[0]

            # cross-id GET if we have an id
            if id_for_path:
                # path with id suffix or replace {id}
                if "{id}" in npath or ":id" in npath:
                    ipath = npath.replace("{id}", id_for_path).replace(":id", id_for_path)
                elif npath.rstrip("/").endswith(id_for_path):
                    ipath = npath
                else:
                    ipath = npath.rstrip("/") + "/" + id_for_path
                for actor in actors_full:
                    if budget[0] >= 30:
                        break
                    url = urljoin(base + "/", ipath.lstrip("/"))
                    try:
                        resp = client.get(
                            url, headers=_hdr(state, "" if actor == "anon" else actor)
                        )
                        budget[0] += 1
                    except Exception:
                        continue
                    cells.append(
                        {
                            "resource": ipath,
                            "actor": actor,
                            "method": "GET",
                            "status": resp.status_code,
                            "id": id_for_path,
                        }
                    )
                    statuses[f"{actor}:{id_for_path}"] = resp.status_code

                # Write/delete matrix: anon + actor_b on object owned/seen by actor_a
                url = urljoin(base + "/", ipath.lstrip("/"))
                write_bodies = (
                    b'{"quantity":2}',
                    b'{"Quantity":2}',
                    b'{}',
                )
                writers = ["anon"] + ([actors[1]] if len(actors) > 1 else [])
                for wactor in writers:
                    if budget[0] >= 40:
                        break
                    for method in ("PUT", "DELETE"):
                        if budget[0] >= 40:
                            break
                        body = write_bodies[0] if method == "PUT" else None
                        try:
                            resp = client.request(
                                method,
                                url,
                                content=body,
                                headers={
                                    **_hdr(state, "" if wactor == "anon" else wactor),
                                    "Content-Type": "application/json",
                                },
                            )
                            budget[0] += 1
                        except Exception:
                            continue
                        cells.append(
                            {
                                "resource": ipath,
                                "actor": wactor,
                                "method": method,
                                "status": resp.status_code,
                                "id": id_for_path,
                            }
                        )
                        if resp.status_code in (200, 201, 204):
                            diffs.append(
                                f"{wactor} {method} {ipath} id={id_for_path} → {resp.status_code}"
                            )
                        elif resp.status_code in (401, 403) and wactor != "anon":
                            # still records tried write under auth
                            pass

            # differential: anon 200 on user/basket-ish collections
            anon_st = statuses.get("anon")
            a_st = statuses.get(actors[0]) if actors else None
            if anon_st == 200 and any(
                x in npath.lower() for x in ("user", "basket", "order", "complaint", "card")
            ):
                diffs.append(f"anon GET {npath} → 200 (sensitive collection)")
            if a_st and anon_st and a_st != anon_st:
                diffs.append(f"status diff {npath}: anon={anon_st} {actors[0]}={a_st}")
            # actor_b GET same object as actor_a when both 200 and path is object-ish
            if len(actors) > 1 and id_for_path:
                bkey = f"{actors[1]}:{id_for_path}"
                akey = f"{actors[0]}:{id_for_path}"
                if statuses.get(bkey) == 200 and statuses.get(akey) == 200:
                    diffs.append(
                        f"cross-actor GET both 200 on id={id_for_path} path={npath}"
                    )

        write_tried = any(
            c.get("method") in ("PUT", "DELETE") for c in cells
        )
        state.authz_matrix = cells
        state.note(
            f"authz_matrix: cells={len(cells)} diffs={len(diffs)} "
            f"write_tried={write_tried} http={budget[0]}"
        )

        booked = False
        if diffs:
            write_diff = any(
                ("PUT" in d or "DELETE" in d) and "→ 20" in d for d in diffs
            ) or any(
                "PUT" in d or "DELETE" in d
                for d in diffs
                if "anon" in d or (actors[1] if len(actors) > 1 else "actor_b") in d
            )
            cross = any("cross-actor" in d for d in diffs)
            sev = "high" if (write_diff or cross) else "medium"
            proof = (
                f"Authz matrix HTTP proof: {'; '.join(diffs[:6])}; "
                f"write_tried={write_tried}; "
                f"cells_sample={json.dumps(cells[:8], ensure_ascii=False)}"
            )
            state.candidates.append(
                Candidate(
                    title=(
                        "Broken access control — cross-actor or unauthenticated object access"
                    ),
                    location=normalize_path(paths[0], state.target) or paths[0],
                    severity=sev,
                    proof_excerpt=proof[:1200],
                    causality=(
                        "Dual-actor/anon matrix requests caused observable "
                        "status/body access differentials including write probes"
                    ),
                    reproducibility="Replay matrix cells with same actors and object ids",
                    impact=(
                        "Unauthorized parties can read or modify other users' resources"
                    ),
                    stage="authz_logic",
                    ready_to_book=True,
                    worker_id="authz_matrix",
                    precondition=(
                        "dual-actor sessions actor_a/actor_b and/or unauthenticated"
                    ),
                    affected_actor=(
                        "actor_b"
                        if write_diff or cross
                        else "anon"
                    ),
                    affected_resource=paths[0],
                )
            )
            booked = True
            record_coverage_authz(
                state,
                "authz_matrix",
                action="matrix differential booked",
                evidence=proof[:400],
                status="booked",
            )
        else:
            detail = f"cells={len(cells)} write_tried={write_tried}"
            record_coverage_authz(
                state,
                "authz_matrix",
                action="matrix completed no strong differential",
                status="deadend",
                evidence=detail,
            )

        return {
            "cells": len(cells),
            "diffs": diffs,
            "booked": booked,
            "http": budget[0],
            "actors": actors,
        }
    finally:
        client.close()
