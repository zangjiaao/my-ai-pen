"""Load Node5 settings — same env contract as Node4 for model routing.

Mirrors node4/.env / node4/src/config.ts + session-runner custom LLM wiring:
  PI_MODEL_PROVIDER, PI_MODEL
  LLM_BASE_URL / OPENAI_BASE_URL
  LLM_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY
  LLM_API (openai-completions)
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Node5Config:
    model_provider: str
    model_id: str
    llm_base_url: str | None
    llm_api_key: str | None
    llm_api: str
    context_window: int
    max_tokens: int
    stage_max_llm_calls: int


def _first_env(*names: str) -> str | None:
    for n in names:
        v = (os.environ.get(n) or "").strip()
        if v:
            return v
    return None


def load_config() -> Node5Config:
    return Node5Config(
        model_provider=_first_env("PI_MODEL_PROVIDER", "NODE5_MODEL_PROVIDER") or "deepseek",
        model_id=_first_env("PI_MODEL", "NODE5_MODEL", "MODEL") or "deepseek-v4-flash",
        llm_base_url=_first_env("LLM_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE"),
        llm_api_key=_first_env(
            "LLM_API_KEY",
            "OPENAI_API_KEY",
            "DEEPSEEK_API_KEY",
            "GOOGLE_API_KEY",
            "GEMINI_API_KEY",
        ),
        llm_api=_first_env("LLM_API") or "openai-completions",
        context_window=max(1024, int(os.environ.get("LLM_CONTEXT_WINDOW") or "128000")),
        max_tokens=max(256, int(os.environ.get("LLM_MAX_TOKENS") or "8192")),
        stage_max_llm_calls=max(4, int(os.environ.get("NODE5_STAGE_MAX_LLM_CALLS") or "24")),
    )


def resolve_adk_model(
    cfg: Node5Config | None = None,
    *,
    model_id: str | None = None,
) -> Any:
    """Build an ADK model object (LiteLlm for OpenAI-compatible / opencode).

    Node4 points LLM_BASE_URL at OpenCode Go (`https://opencode.ai/zen/go/v1`)
    with openai-completions. ADK uses LiteLLM `openai/<model_id>` + api_base.

    ``model_id`` overrides env default (CLI ``--model`` / PenState.model).
    """
    cfg = cfg or load_config()
    mid = (model_id or cfg.model_id or "deepseek-v4-flash").strip()

    # Native Gemini string only when no custom base URL and no opencode-style key path
    if not cfg.llm_base_url and cfg.model_provider in ("google", "gemini"):
        return mid

    try:
        from google.adk.models.lite_llm import LiteLlm
    except ImportError as e:
        raise ImportError(
            "LiteLlm requires: uv pip install 'google-adk[extensions]' litellm"
        ) from e

    # LiteLLM OpenAI-compatible prefix
    litellm_id = mid
    if not litellm_id.startswith(("openai/", "deepseek/", "anthropic/", "gemini/")):
        # Always route custom gateway as openai-compatible
        litellm_id = f"openai/{litellm_id}"

    kwargs: dict[str, Any] = {"model": litellm_id}
    if cfg.llm_base_url:
        kwargs["api_base"] = cfg.llm_base_url.rstrip("/")
    if cfg.llm_api_key:
        kwargs["api_key"] = cfg.llm_api_key
    # deepseek-v4-* spends tokens on reasoning_content first; keep headroom
    kwargs["max_tokens"] = cfg.max_tokens
    kwargs["num_retries"] = 2

    return LiteLlm(**kwargs)


def model_label(cfg: Node5Config | None = None, *, model_id: str | None = None) -> str:
    cfg = cfg or load_config()
    mid = (model_id or cfg.model_id).strip()
    base = cfg.llm_base_url or "(provider default)"
    return f"{cfg.model_provider}/{mid} @ {base}"


def node5_root() -> Path:
    return Path(__file__).resolve().parents[2]


def maybe_load_dotenv() -> None:
    """Load node5/.env then fall back to node4/.env (same monorepo keys)."""
    from dotenv import load_dotenv

    root = node5_root()
    # node5 local overrides first
    load_dotenv(root / ".env", override=False)
    # inherit Node4 model/gateway settings when not set
    node4_env = root.parent / "node4" / ".env"
    if node4_env.is_file():
        load_dotenv(node4_env, override=False)
