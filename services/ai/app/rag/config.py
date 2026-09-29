"""RAG configuration: one model shared by the service, the eval harness and the replay.

Every rag_requests row and every eval result stores `config_hash`, so a number in the README can
always be traced back to the exact configuration that produced it. Override with RAG_* env vars.
"""

import hashlib
import json
from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

from app.ingest.embed import EMBEDDING_DIMENSIONS, EMBEDDING_MODEL

PromptCacheMode = Literal["explicit_breakpoint", "implicit", "explicit_none"]


class RagConfig(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="RAG_", extra="ignore", frozen=True)

    chat_model: str = "gpt-6-luna"
    reasoning_effort: Literal["none", "low", "medium", "high"] = "none"
    verbosity: Literal["low", "medium", "high"] = "low"
    max_output_tokens: int = 600
    prompt_version: str = "v1"
    # explicit_breakpoint: cache only the static prefix. implicit: OpenAI's default (writes the
    # whole prompt). explicit_none: cache nothing. The last two exist for the cost replay.
    prompt_cache_mode: PromptCacheMode = "explicit_breakpoint"

    embedding_model: str = EMBEDDING_MODEL
    embedding_dimensions: int = EMBEDDING_DIMENSIONS
    hybrid_enabled: bool = True
    candidates_per_branch: int = 40
    top_k: int = 5
    context_token_budget: int = 2000
    # Skip the LLM when retrieval is weak on both signals (calibrated on the eval in W2).
    retrieval_gate_tau: float = 0.30
    gate_min_lexemes: int = 2

    history_turns: int = 3
    history_token_budget: int = 800

    breaker_failures: int = 5
    breaker_window_s: float = 60.0
    breaker_open_s: float = 30.0

    def config_hash(self) -> str:
        canonical = json.dumps(self.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode()).hexdigest()[:16]


@lru_cache
def get_rag_config() -> RagConfig:
    return RagConfig()
