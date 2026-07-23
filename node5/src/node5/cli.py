"""Node5 CLI — ADK graph pentest control arm (no platform)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="node5",
        description=(
            "Node5 research control arm: ADK hard graph for structured pentest. "
            "CLI only — not a product runtime (see Node4)."
        ),
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    run_p = sub.add_parser("run", help="Run app_assessment (or other pack graph) hard workflow")
    run_p.add_argument("--target", required=True, help="Authorized target URL/host")
    run_p.add_argument(
        "--graph-id",
        default="app_assessment",
        help="Pack graph id under experts/pentest/graphs (default: app_assessment)",
    )
    run_p.add_argument(
        "--dry-run",
        action="store_true",
        help="Walk the graph without LLM/network (structure control)",
    )
    run_p.add_argument(
        "--model",
        default=None,
        help="Override model id (default: PI_MODEL / deepseek-v4-flash from env)",
    )
    run_p.add_argument("--pack-root", default=None, help="Override experts/pentest path")
    run_p.add_argument(
        "--work-dir",
        default=None,
        help="Output directory (default: node5/workspace/run-<stamp>)",
    )
    run_p.add_argument(
        "--allow-postex",
        action="store_true",
        help="Set RoE allow_postex=true (default false from graph)",
    )
    run_p.add_argument(
        "--notes",
        default="",
        help="Operator notes injected into every stage (e.g. lab creds, scope)",
    )
    run_p.add_argument(
        "--only-stages",
        default="",
        help="Comma-separated stage filter (e.g. surface,class_probe,validate_book)",
    )
    run_p.add_argument(
        "--agent-graph",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Enable Agent Graph fan-out on class_probe (default: on)",
    )
    run_p.add_argument(
        "--max-workers",
        type=int,
        default=4,
        help="Max concurrent Agent Graph workers for class_probe (default 4, max 8)",
    )

    desc = sub.add_parser("describe", help="Print three-layer Graph topology")
    desc.add_argument("--graph-id", default="app_assessment")
    desc.add_argument("--pack-root", default=None)

    conf = sub.add_parser("config", help="Show resolved model/env (secrets redacted)")

    return p


def main(argv: list[str] | None = None) -> int:
    from node5.config import load_config, maybe_load_dotenv, model_label

    maybe_load_dotenv()
    args = _build_parser().parse_args(argv)

    if args.cmd == "config":
        cfg = load_config()
        print(
            json.dumps(
                {
                    "model_label": model_label(cfg),
                    "model_provider": cfg.model_provider,
                    "model_id": cfg.model_id,
                    "llm_base_url": cfg.llm_base_url,
                    "llm_api": cfg.llm_api,
                    "llm_api_key_set": bool(cfg.llm_api_key),
                    "context_window": cfg.context_window,
                    "max_tokens": cfg.max_tokens,
                    "stage_max_llm_calls": cfg.stage_max_llm_calls,
                },
                indent=2,
            )
        )
        return 0

    if args.cmd == "describe":
        from node5.workflow import describe_graph

        info = describe_graph(graph_id=args.graph_id, pack_root=args.pack_root)
        print(json.dumps(info, ensure_ascii=False, indent=2))
        return 0

    if args.cmd == "run":
        from node5.run import run

        cfg = load_config()
        if not args.dry_run and not cfg.llm_api_key and not cfg.llm_base_url:
            # Gemini path would need GOOGLE_API_KEY; custom path needs LLM_API_KEY
            if not (
                __import__("os").environ.get("GOOGLE_API_KEY")
                or __import__("os").environ.get("GEMINI_API_KEY")
            ):
                print(
                    "error: live run needs LLM_API_KEY (+ LLM_BASE_URL for OpenCode) "
                    "or GOOGLE_API_KEY. Use --dry-run to validate structure only.\n"
                    "Tip: node5 loads node4/.env automatically when present.",
                    file=sys.stderr,
                )
                return 2

        only = [s.strip() for s in (args.only_stages or "").split(",") if s.strip()]
        try:
            state = run(
                target=args.target,
                graph_id=args.graph_id,
                dry_run=args.dry_run,
                model=args.model,
                pack_root=args.pack_root,
                work_dir=args.work_dir,
                allow_postex=args.allow_postex,
                operator_notes=args.notes or "",
                only_stages=only or None,
                agent_graph=bool(args.agent_graph),
                max_workers=int(args.max_workers or 4),
            )
        except RuntimeError as e:
            print(f"error: {e}", file=sys.stderr)
            return 3
        summary = {
            "target": state.target,
            "graph_id": state.graph_id,
            "dry_run": state.dry_run,
            "model": state.model,
            "model_label": model_label(cfg, model_id=state.model),
            "agent_graph": state.agent_graph,
            "agent_packages": state.agent_packages,
            "stages_done": state.stages_done,
            "surfaces": len(state.surfaces),
            "candidates": len(state.candidates),
            "findings": len(state.findings),
            "feedback_ok": sum(1 for f in state.feedback if f.ok),
            "feedback_fail": sum(1 for f in state.feedback if not f.ok),
            "cookie_keys": list(state.cookies.keys()),
            "errors": state.errors,
            "work_dir": state.work_dir,
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        if state.work_dir:
            print(f"\nartifacts: {Path(state.work_dir).resolve()}", file=sys.stderr)
        return 1 if state.errors else 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
