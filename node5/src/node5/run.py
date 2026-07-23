"""Execute Node5 ADK workflow and collect final PenState."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from google.adk import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from node5.config import load_config, model_label, maybe_load_dotenv
from node5.pack_loader import default_pack_root
from node5.state import PenState, as_state
from node5.workflow import build_app_assessment_workflow


def default_work_dir(base: Path | None = None) -> Path:
    root = base or (Path(__file__).resolve().parents[2] / "workspace")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return root / f"run-{stamp}"


async def run_async(
    *,
    target: str,
    graph_id: str = "app_assessment",
    dry_run: bool = False,
    model: str | None = None,
    pack_root: str | None = None,
    work_dir: str | Path | None = None,
    allow_postex: bool = False,
    operator_notes: str = "",
    only_stages: list[str] | None = None,
    agent_graph: bool = True,
    max_workers: int = 4,
) -> PenState:
    maybe_load_dotenv()
    cfg = load_config()
    pack = str(pack_root or default_pack_root())
    out = Path(work_dir) if work_dir else default_work_dir()
    out.mkdir(parents=True, exist_ok=True)

    seed = PenState(
        target=target,
        graph_id=graph_id,
        dry_run=dry_run,
        model=model or cfg.model_id,
        pack_root=pack,
        work_dir=str(out),
        roe={"allow_postex": allow_postex},
        operator_notes=operator_notes or "",
        only_stages=list(only_stages or []),
        agent_graph=agent_graph,
        max_workers=max(1, min(max_workers, 8)),
    )

    from node5.sandbox_exec import sandbox_health

    health = sandbox_health()
    meta = {
        "model_label": model_label(cfg, model_id=seed.model),
        "model": seed.model,
        "target": target,
        "graph_id": graph_id,
        "dry_run": dry_run,
        "agent_graph": agent_graph,
        "max_workers": seed.max_workers,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "tooling_health": health.as_dict(),
    }
    (out / "run_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    if not dry_run and not health.ok:
        raise RuntimeError(
            f"sandbox health failed: {health.error or health.as_dict()}. "
            "Build pen-sandbox or set NODE5_ALLOW_HOST_TOOLS=1 for explicit host tools."
        )

    workflow = build_app_assessment_workflow(graph_id=graph_id, pack_root=pack)
    ss = InMemorySessionService()
    session = await ss.create_session(app_name="node5", user_id="operator")
    runner = Runner(app_name="node5", agent=workflow, session_service=ss)

    user_msg = types.Content(
        role="user",
        parts=[types.Part(text=json.dumps(seed.model_dump(), ensure_ascii=False))],
    )

    final_state: PenState | None = None
    event_log: list[dict[str, Any]] = []

    async for event in runner.run_async(
        user_id="operator",
        session_id=session.id,
        new_message=user_msg,
    ):
        entry: dict[str, Any] = {
            "author": getattr(event, "author", None),
            "id": getattr(event, "id", None),
        }
        if event.output is not None:
            entry["has_output"] = True
            try:
                final_state = as_state(event.output)
                entry["stage"] = final_state.stage
                entry["stages_done"] = list(final_state.stages_done)
                entry["errors"] = list(final_state.errors[-3:])
            except Exception as e:
                entry["output_error"] = str(e)
        if event.content and event.content.parts:
            texts = [p.text for p in event.content.parts if p.text]
            if texts:
                entry["text"] = "\n".join(texts)[:2000]
        event_log.append(entry)
        # progressive checkpoint
        if final_state is not None and final_state.stage:
            (out / "events.json").write_text(
                json.dumps(event_log, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            (out / "state.partial.json").write_text(
                json.dumps(final_state.model_dump(), ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

    (out / "events.json").write_text(
        json.dumps(event_log, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    if final_state is None:
        final_state = seed
        final_state.errors.append("workflow produced no state output")
        final_state.work_dir = str(out)
        (out / "state.json").write_text(
            json.dumps(final_state.model_dump(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    meta["finished_at"] = datetime.now(timezone.utc).isoformat()
    meta["finding_count"] = len(final_state.findings)
    meta["error_count"] = len(final_state.errors)
    (out / "run_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    return final_state


def run(**kwargs: Any) -> PenState:
    return asyncio.run(run_async(**kwargs))
