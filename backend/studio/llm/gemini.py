"""Gemini adapter via the official `google-genai` SDK — default provider (gemini-3.5-flash-lite).

Replaces a hand-rolled `httpx` client that worked around gemma-4-31b-it's quirks (rejected
`systemInstruction`, thought parts mixed into `content.parts`). Gemma is no longer used by this
app (too slow and unreliable for a chat agent — see docs/llm-provider-notes.md), and measured
against the SDK directly (2026-09):
 1. `response.text` already excludes thinking parts; no manual part-filtering needed.
 2. `system_instruction` works normally on `gemini-*` models.
 3. `response_mime_type="application/json"` + `response_schema=<dict>` still works, fed the same
    upper-cased schema dict `to_gemini_schema()` already produces.
 4. The SDK raises `google.genai.errors.APIError` with a `.code` (HTTP status); `with_retry`
    (llm/base.py) now retries on that the same way it retried on `httpx.HTTPStatusError`, so the
    measured 500/503 backoff policy is unchanged. The SDK's own `retry_options` is left unset so
    there is only one retry loop, not two stacked ones.
 5. `gemini-3*` models take `thinking_config.thinking_level`; `gemini-2.5*`/`gemini-2*` take
    `thinking_config.thinking_budget=0` (the SDK rejects `thinking_level` on 2.x, and rejects
    `thinking_budget` on 3.x with HTTP 400 — measured, not guessed).
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from google import genai
from google.genai import errors as genai_errors
from google.genai import types as genai_types

from ..core.models import ConnTest
from .base import LLMError, redact, with_retry
from .schema import to_gemini_schema

log = logging.getLogger("studio.llm.gemini")

DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"


def _http_options(base_url: str, timeout_s: int) -> genai_types.HttpOptions:
    # Measured: the SDK 404s if `HttpOptions.base_url` includes the version path (`/v1beta`) —
    # it appends `api_version` itself, so a base_url carrying its own version segment doubles up
    # and misses. Split the host from the version and pass them separately.
    host, _, version = base_url.rstrip("/").partition("/v1")
    return genai_types.HttpOptions(base_url=host, api_version=f"v1{version}" if version else "v1beta",
                                   timeout=timeout_s * 1000)


class GeminiProvider:
    name = "gemini"

    def __init__(self, model: str, api_key: str, base_url: str = DEFAULT_BASE_URL,
                 timeout_s: int = 120, max_output_tokens: int = 8192,
                 client: "genai.Client | None" = None) -> None:
        self.model = model
        self._key = api_key
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.timeout_s = timeout_s
        self.max_output_tokens = max_output_tokens
        self._client = client or genai.Client(api_key=api_key, http_options=_http_options(self.base_url, timeout_s))
        self.last_usage: dict[str, int] = {}

    # ---- internals ---------------------------------------------------
    def _thinking_config(self) -> genai_types.ThinkingConfig | None:
        if self.model.startswith("gemini-3"):
            return genai_types.ThinkingConfig(thinking_level="minimal")
        if self.model.startswith("gemini-2"):
            return genai_types.ThinkingConfig(thinking_budget=0)
        return None

    def _generate(self, system_prompt: str, user_prompt: str,
                  schema: dict[str, Any] | None,
                  max_tokens: int | None = None) -> genai_types.GenerateContentResponse:
        cfg = genai_types.GenerateContentConfig(
            temperature=0,
            max_output_tokens=max_tokens or self.max_output_tokens,
            system_instruction=system_prompt.strip() or None,
            thinking_config=self._thinking_config(),
        )
        if schema is not None:
            cfg.response_mime_type = "application/json"
            cfg.response_schema = to_gemini_schema(schema)

        def attempt(_n: int) -> genai_types.GenerateContentResponse:
            return self._client.models.generate_content(model=self.model, contents=user_prompt, config=cfg)

        return with_retry(attempt, what=f"gemini/{self.model}", secrets=[self._key])

    # ---- interface ---------------------------------------------------
    def complete_json(self, system_prompt: str, user_prompt: str, schema: dict) -> dict:
        # Thinking models can still spend the whole budget on thought tokens before answering, so
        # a truncated reply is plausible rather than exceptional. Retry once with double the budget.
        budget = self.max_output_tokens
        for widen in (False, True):
            if widen:
                budget *= 2
            r = self._generate(system_prompt, user_prompt, schema, max_tokens=budget)
            usage = r.usage_metadata
            self.last_usage = {
                "prompt_tokens": int(usage.prompt_token_count or 0) if usage else 0,
                "completion_tokens": int(usage.candidates_token_count or 0) if usage else 0,
                "total_tokens": int(usage.total_token_count or 0) if usage else 0,
            }
            candidates = r.candidates or []
            if not candidates:
                reason = getattr(r.prompt_feedback, "block_reason", None) or "no candidates"
                raise LLMError(f"gemini: empty response ({reason})")
            finish = candidates[0].finish_reason
            text = (r.text or "").strip()

            truncated = str(finish).endswith("MAX_TOKENS")
            if not text:
                if truncated and not widen:
                    continue          # thinking consumed the whole budget
                raise LLMError(f"gemini: no text in response (finishReason={finish})")
            try:
                return json.loads(text)
            except json.JSONDecodeError as exc:
                if truncated and not widen:
                    continue          # JSON cut mid-object; one wider retry
                snippet = text[:200].replace("\n", " ")
                hint = " (truncated at maxOutputTokens)" if truncated else ""
                raise LLMError(f"gemini: response is not JSON{hint}: {snippet}") from exc
        raise LLMError(f"gemini: response still truncated at {budget} output tokens")

    def test_connection(self) -> ConnTest:
        t0 = time.monotonic()
        try:
            models = list(self._client.models.list(config={"page_size": 50}))
        except genai_errors.APIError as exc:
            latency = int((time.monotonic() - t0) * 1000)
            msg = redact(str(exc.message or exc), [self._key])
            if exc.code in (400, 401, 403):
                return ConnTest(ok=False, error=f"gemini: {msg or 'Invalid API key'}", provider=self.name,
                                model=self.model, latency_ms=latency)
            return ConnTest(ok=False, error=f"gemini: HTTP {exc.code}: {msg}", provider=self.name,
                            model=self.model, latency_ms=latency)
        except Exception as exc:                                                     # noqa: BLE001
            latency = int((time.monotonic() - t0) * 1000)
            return ConnTest(ok=False, error=f"gemini: {redact(str(exc), [self._key])}", provider=self.name,
                            model=self.model, latency_ms=latency)
        latency = int((time.monotonic() - t0) * 1000)
        names = sorted(m.name.split("/")[-1] for m in models if m.name)
        return ConnTest(ok=True, latency_ms=latency, json_mode="response_schema", models=names,
                        provider=self.name, model=self.model)

    def list_models(self) -> list[str]:
        try:
            models = list(self._client.models.list(config={"page_size": 200}))
            names = [m.name.split("/")[-1] for m in models if m.name]
            return sorted(n for n in names if n)
        except Exception as exc:                                                     # noqa: BLE001
            log.info("model listing unavailable: %s", type(exc).__name__)
            return []
