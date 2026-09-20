"""Build a provider from LLMConfig, enforcing the air-gap guard first (CONTRACTS §9)."""

from __future__ import annotations

from ..core.settings import DEFAULT_BASE_URLS, LLMConfig
from . import airgap
from .base import LLMUnavailable, Provider
from .gemini import GeminiProvider
from .none import NoneProvider
from .openai_compat import OpenAICompatibleProvider

# Only two shapes: Gemini (cloud) and a local OpenAI-compatible server.
# "ollama" is accepted as an alias so older configs keep working.
LOCAL_FAMILY = {"local", "ollama"}


def build_provider(cfg: LLMConfig) -> Provider:
    provider = (cfg.provider or "none").strip().lower()
    if provider in ("", "none"):
        return NoneProvider()

    airgap.check(provider, cfg.base_url, cfg.airgap)      # refuses cloud in air-gap mode

    base_url = cfg.base_url or DEFAULT_BASE_URLS.get(provider, "")
    if not cfg.model:
        raise LLMUnavailable(f"provider {provider!r} is configured but no model is set")

    if provider == "gemini":
        if not cfg.api_key:
            raise LLMUnavailable("gemini is configured but no API key is set (Settings page)")
        return GeminiProvider(cfg.model, cfg.api_key, base_url or DEFAULT_BASE_URLS["gemini"],
                              cfg.timeout_s, cfg.max_output_tokens)
    if provider in LOCAL_FAMILY:
        # Local servers (Ollama, vLLM, llama.cpp, LM Studio) all speak the OpenAI shape.
        if not base_url:
            raise LLMUnavailable(f"{provider} needs a base URL (Settings page)")
        return OpenAICompatibleProvider(cfg.model, cfg.api_key, base_url, cfg.timeout_s,
                                        cfg.max_output_tokens, name=provider)
    raise LLMUnavailable(f"unknown provider {provider!r} — supported: none, gemini, local")


def origin_tag(cfg: LLMConfig) -> str:
    """Proposal provenance (spec §8.12.9). Never contains the key."""
    if (cfg.provider or "none").lower() in ("", "none"):
        return "heuristic"
    return f"ai:{cfg.provider}/{cfg.model}"
