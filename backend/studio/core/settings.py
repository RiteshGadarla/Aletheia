"""Runtime config with UI precedence: Postgres settings table > env var > default (CONTRACTS §9).

The Docker image ships with NO key: the operator sets provider/model/key at runtime.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any

from .crypto import SecretUnavailable, last4, open_sealed, seal
from .db import MemoryRepo, Repo

log = logging.getLogger("studio.settings")

# setting key -> (env var, default, encrypted)
SPEC: dict[str, tuple[str | None, Any, bool]] = {
    "llm.provider":          ("ALETHEIA_LLM_PROVIDER", "gemini", False),
    "llm.model":             ("ALETHEIA_LLM_MODEL", "gemini-3.5-flash-lite", False),
    "llm.chat_model":        ("ALETHEIA_LLM_CHAT_MODEL", "", False),   # Lyra only; "" = provider default
    "llm.base_url":          ("ALETHEIA_LLM_BASE_URL", "", False),
    "llm.api_key":           (None, "", True),   # Taken from frontend input / DB settings only
    "llm.send_samples":      ("ALETHEIA_LLM_SEND_SAMPLES", "masked", False),
    "llm.timeout_s":         ("ALETHEIA_LLM_TIMEOUT_S", 120, False),
    "llm.max_output_tokens": ("ALETHEIA_LLM_MAX_OUTPUT_TOKENS", 8192, False),
    "llm.requests_per_hour": ("ALETHEIA_LLM_REQUESTS_PER_HOUR", 60, False),
    "airgap":                ("ALETHEIA_AIRGAP", False, False),
    "engine.bin":            ("ALETHEIA_ENGINE_BIN", "aletheia", False),
    "bus.brokers":           ("ALETHEIA_BUS_BROKERS", "", False),
}

SECRET_KEYS = {k for k, (_, _, enc) in SPEC.items() if enc}

# Two shapes only: Gemini (the one cloud option) and a local OpenAI-compatible server.
# "local" covers Ollama, vLLM, llama.cpp and LM Studio alike — they share the same API,
# so the base URL is what distinguishes them, not the provider name.
DEFAULT_BASE_URLS = {
    "gemini": "https://generativelanguage.googleapis.com/v1beta",
    "local": "http://localhost:11434/v1",      # Ollama's default; change for vLLM etc.
    "none": "",
}

PROVIDERS = ("none", "gemini", "local")


def _as_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    return str(v).strip().lower() in {"1", "true", "yes", "on"}


def _as_int(v: Any, default: int) -> int:
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


def _key_from_file() -> str:
    """ALETHEIA_LLM_API_KEY_FILE — the preferred env-side key source (spec §8.12.7)."""
    path = os.environ.get("ALETHEIA_LLM_API_KEY_FILE", "")
    if not path:
        return ""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError as exc:
        log.warning("cannot read ALETHEIA_LLM_API_KEY_FILE: %s", type(exc).__name__)
        return ""


@dataclass
class LLMConfig:
    provider: str = "none"
    model: str = ""
    base_url: str = ""
    api_key: str = ""           # never serialise this field
    send_samples: str = "masked"
    timeout_s: int = 120
    max_output_tokens: int = 8192
    requests_per_hour: int = 60
    airgap: bool = False
    source: dict[str, str] = field(default_factory=dict)   # key -> db|env|default

    def public(self) -> dict[str, Any]:
        """Safe for the API: key becomes last4 only."""
        return {
            "provider": self.provider,
            "model": self.model,
            "base_url": self.base_url,
            "api_key_set": bool(self.api_key),
            "api_key_last4": last4(self.api_key) if self.api_key else None,
            "send_samples": self.send_samples,
            "timeout_s": self.timeout_s,
            "max_output_tokens": self.max_output_tokens,
            "requests_per_hour": self.requests_per_hour,
            "airgap": self.airgap,
            "source": self.source,
        }


class SettingsStore:
    """Resolves every key through db > env > default and seals secrets on write."""

    def __init__(self, repo: Repo | None = None, secret: str | None = None) -> None:
        self.repo: Repo = repo or MemoryRepo()
        self._secret = secret

    # ---- resolution -------------------------------------------------
    def resolve(self, key: str) -> tuple[Any, str]:
        """Return (value, origin) where origin is db | env | default."""
        env_name, default, encrypted = SPEC[key]
        rows = self.repo.settings_all()
        row = rows.get(key)
        if row is not None:
            if row.encrypted:
                try:
                    return open_sealed(row.value, self._secret), "db"
                except (SecretUnavailable, ValueError, Exception) as exc:
                    log.error("cannot open sealed setting %s (%s); ignoring DB value",
                              key, type(exc).__name__)
            else:
                return row.value, "db"
        if env_name:
            env_val = os.environ.get(env_name)
            if env_val not in (None, ""):
                return env_val, "env"
        return default, "default"

    def get(self, key: str) -> Any:
        return self.resolve(key)[0]

    def set(self, key: str, value: Any) -> None:
        if key not in SPEC:
            raise KeyError(f"unknown setting {key}")
        encrypted = SPEC[key][2]
        text = str(value)
        if encrypted:
            text = seal(text, self._secret)
        self.repo.settings_set(key, text, encrypted)

    def unset(self, key: str) -> None:
        self.repo.settings_delete(key)

    # ---- typed view -------------------------------------------------
    def llm_config(self) -> LLMConfig:
        src: dict[str, str] = {}

        def pick(key: str) -> Any:
            v, origin = self.resolve(key)
            src[key.split(".")[-1] if key.startswith("llm.") else key] = origin
            return v

        provider = str(pick("llm.provider") or "none").strip().lower()
        base_url = str(pick("llm.base_url") or "").strip()
        if not base_url:
            base_url = DEFAULT_BASE_URLS.get(provider, "")
        cfg = LLMConfig(
            provider=provider,
            model=str(pick("llm.model") or "").strip(),
            base_url=base_url.rstrip("/"),
            api_key=str(pick("llm.api_key") or ""),
            send_samples=str(pick("llm.send_samples") or "masked").strip().lower(),
            timeout_s=_as_int(pick("llm.timeout_s"), 120),
            max_output_tokens=_as_int(pick("llm.max_output_tokens"), 8192),
            requests_per_hour=_as_int(pick("llm.requests_per_hour"), 60),
            airgap=_as_bool(pick("airgap")),
            source=src,
        )
        return cfg
