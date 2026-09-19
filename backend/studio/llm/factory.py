"""Build a provider from LLMConfig, enforcing the air-gap guard first (CONTRACTS §9)."""

from __future__ import annotations

from ..core.settings import DEFAULT_BASE_URLS, LLMConfig
from . import airgap
from .anthropic import AnthropicProvider
from .base import LLMUnavailable, Provider
from .gemini import GeminiProvider
from .none import NoneProvider
from .openai_compat import OpenAICompatibleProvider

OPENAI_FAMILY = {"openai", "groq", "ollama", "openai_compatible"}


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
    if provider == "anthropic":
        if not cfg.api_key:
            raise LLMUnavailable("anthropic is configured but no API key is set (Settings page)")
        return AnthropicProvider(cfg.model, cfg.api_key,
                                 base_url or DEFAULT_BASE_URLS["anthropic"],
                                 cfg.timeout_s, cfg.max_output_tokens)
    if provider in OPENAI_FAMILY:
        if provider in ("openai", "groq") and not cfg.api_key:
            raise LLMUnavailable(f"{provider} is configured but no API key is set (Settings page)")
        return OpenAICompatibleProvider(cfg.model, cfg.api_key, base_url, cfg.timeout_s,
                                        cfg.max_output_tokens, name=provider)
    raise LLMUnavailable(f"unknown provider {provider!r}")


def origin_tag(cfg: LLMConfig) -> str:
    """Proposal provenance (spec §8.12.9). Never contains the key."""
    if (cfg.provider or "none").lower() in ("", "none"):
        return "heuristic"
    return f"ai:{cfg.provider}/{cfg.model}"
