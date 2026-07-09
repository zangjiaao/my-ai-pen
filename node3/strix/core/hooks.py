"""SDK run hooks used by Strix orchestration."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from agents.lifecycle import RunHooks

from strix.core.task_shape import classify_child_task_shape
from strix.report.state import get_global_report_state


if TYPE_CHECKING:
    from agents import RunContextWrapper
    from agents.agent import Agent
    from agents.items import ModelResponse


logger = logging.getLogger(__name__)


class BudgetExceededError(RuntimeError):
    """Raised when the accumulated LLM cost reaches the configured budget."""


class AgentTokenBudgetExceeded(RuntimeError):
    """Raised when a narrow child task consumes far more tokens than its scope warrants."""


_REPORTER_TOKEN_LIMIT = 300_000
_VALIDATOR_TOKEN_LIMIT = 750_000
_FOCUSED_CHILD_TOKEN_LIMIT = 1_500_000


class ReportUsageHooks(RunHooks[dict[str, Any]]):
    """Persist SDK-native usage after every model response."""

    def __init__(self, *, model: str, max_budget_usd: float | None = None) -> None:
        import math
        if max_budget_usd is not None and (not math.isfinite(max_budget_usd) or max_budget_usd <= 0):
            raise ValueError("max_budget_usd must be a finite number greater than 0")
        self._model = model
        self._max_budget_usd = max_budget_usd

    async def on_llm_end(
        self,
        context: RunContextWrapper[dict[str, Any]],
        agent: Agent[dict[str, Any]],
        response: ModelResponse,
    ) -> None:
        report_state = get_global_report_state()
        if report_state is None:
            return

        ctx = context.context if isinstance(context.context, dict) else {}
        agent_name = getattr(agent, "name", None)
        if not isinstance(agent_name, str):
            agent_name = None
        agent_id = ctx.get("agent_id")
        if not isinstance(agent_id, str) or not agent_id:
            agent_id = agent_name or "unknown"

        try:
            report_state.record_sdk_usage(
                agent_id=agent_id,
                agent_name=agent_name,
                model=self._model,
                usage=response.usage,
            )
        except Exception:
            logger.exception("failed to record SDK usage for agent %s", agent_id)

        _enforce_narrow_child_token_budget(
            report_state=report_state,
            agent_id=agent_id,
            agent_name=agent_name,
            task=ctx.get("task"),
            parent_id=ctx.get("parent_id"),
        )

        if self._max_budget_usd is not None:
            cost = report_state.get_total_llm_cost()
            if cost >= self._max_budget_usd:
                raise BudgetExceededError(
                    f"Token budget of ${self._max_budget_usd:.2f} exceeded (spent ${cost:.4f})"
                )


def _enforce_narrow_child_token_budget(
    *,
    report_state: Any,
    agent_id: str,
    agent_name: str | None,
    task: Any,
    parent_id: Any,
) -> None:
    """Stop runaway validation/reporting chains without constraining discovery work."""
    if not isinstance(parent_id, str) or not parent_id:
        return

    text = f"{agent_name or ''} {task or ''}".lower()
    shape = classify_child_task_shape(name=agent_name, task=task)
    if shape == "reporting":
        limit = _REPORTER_TOKEN_LIMIT
    elif shape == "validation":
        limit = _VALIDATOR_TOKEN_LIMIT
    elif _is_broad_recon_or_orchestration_task(text):
        return
    else:
        limit = _FOCUSED_CHILD_TOKEN_LIMIT
        shape = "focused"

    getter = getattr(report_state, "get_agent_llm_tokens", None)
    if not callable(getter):
        return
    try:
        total_tokens = int(getter(agent_id) or 0)
    except Exception:
        logger.exception("failed to read token total for agent %s", agent_id)
        return
    if total_tokens <= limit:
        return

    raise AgentTokenBudgetExceeded(
        f"{shape} child agent {agent_name or agent_id} exceeded its token budget "
        f"({total_tokens:,} > {limit:,}). Stop this narrow task and continue with "
        "coverage-oriented work or a smaller follow-up task."
    )


def _is_broad_recon_or_orchestration_task(text: str) -> bool:
    """Leave genuinely broad mapping/orchestration work to turn limits."""
    if "root" in text or "orchestrat" in text or "coordinat" in text:
        return True
    recon_terms = ("recon", "reconnaissance", "crawl", "map", "mapping", "inventory", "sitemap")
    broad_terms = ("entire", "whole", "all in-scope", "attack surface", "site-wide", "application-wide")
    return any(term in text for term in recon_terms) and any(term in text for term in broad_terms)
