"""Gemini native adapter — the default provider (gemma-4-31b-it).

Measured constraints (docs/llm-provider-notes.md), all load-bearing:
 1. gemma-4-31b-it returns HTTP 500 if `systemInstruction` is sent -> fold into first user part.
 2. It is a thinking model -> join only parts whose `thought` flag is falsy.
 3. Native generateContent, not the OpenAI-compat endpoint (that inlines <thought> into content).
 4. responseMimeType=application/json + responseSchema is the primary structured-output mode.
 5. Intermittent HTTP 500 ~50% of calls -> retry with backoff, then fall back to heuristics.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

import httpx

from ..core.models import ConnTest
from .base import LLMError, with_retry
from .schema import to_gemini_schema

log = logging.getLogger("studio.llm.gemini")

DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"


def join_answer_parts(parts: list[dict[str, Any]]) -> str:
    """Keep only non-thought parts (fact 2). A thought part has {"thought": true}."""
    return "".join(
        str(p.get("text", ""))
        for p in (parts or [])
        if isinstance(p, dict) and not p.get("thought")
    )


class GeminiProvider:
    name = "gemini"

    def __init__(self, model: str, api_key: str, base_url: str = DEFAULT_BASE_URL,
                 timeout_s: int = 30, max_output_tokens: int = 2048,
                 client: httpx.Client | None = None) -> None:
        self.model = model
        self._key = api_key
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self.timeout_s = timeout_s
        self.max_output_tokens = max_output_tokens
        self._client = client
        self.last_usage: dict[str, int] = {}

    # ---- internals ---------------------------------------------------
    def _http(self) -> httpx.Client:
        return self._client or httpx.Client(timeout=self.timeout_s)

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.base_url}/{path}"
        client = self._http()
        try:
            # Key travels as a query param; never put it in a log line.
            r = client.post(url, params={"key": self._key}, json=body)
            r.raise_for_status()
            return r.json()
        finally:
            if self._client is None:
                client.close()

    def _generate(self, system_prompt: str, user_prompt: str,
                  schema: dict[str, Any] | None) -> dict[str, Any]:
        # Fact 1: no systemInstruction — the system prompt is folded into the first user part.
        text = f"{system_prompt.strip()}\n\n{user_prompt.strip()}" if system_prompt else user_prompt
        gen: dict[str, Any] = {
            "temperature": 0,
            "maxOutputTokens": self.max_output_tokens,
        }
        if schema is not None:
            gen["responseMimeType"] = "application/json"
            gen["responseSchema"] = to_gemini_schema(schema)
        body = {"contents": [{"role": "user", "parts": [{"text": text}]}],
                "generationConfig": gen}
        return self._post(f"models/{self.model}:generateContent", body)

    # ---- interface ---------------------------------------------------
    def complete_json(self, system_prompt: str, user_prompt: str, schema: dict) -> dict:
        def attempt(_n: int) -> dict[str, Any]:
            return self._generate(system_prompt, user_prompt, schema)

        data = with_retry(attempt, what=f"gemini/{self.model}", secrets=[self._key])
        usage = data.get("usageMetadata") or {}
        self.last_usage = {
            "prompt_tokens": int(usage.get("promptTokenCount") or 0),
            "completion_tokens": int(usage.get("candidatesTokenCount") or 0),
            "total_tokens": int(usage.get("totalTokenCount") or 0),
        }
        candidates = data.get("candidates") or []
        if not candidates:
            reason = (data.get("promptFeedback") or {}).get("blockReason", "no candidates")
            raise LLMError(f"gemini: empty response ({reason})")
        parts = ((candidates[0].get("content") or {}).get("parts")) or []
        text = join_answer_parts(parts).strip()
        if not text:
            finish = candidates[0].get("finishReason", "?")
            raise LLMError(f"gemini: no non-thought text part (finishReason={finish})")
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            snippet = text[:200].replace("\n", " ")
            raise LLMError(f"gemini: response is not JSON: {snippet}") from exc

    def test_connection(self) -> ConnTest:
        probe_schema = {
            "type": "object",
            "properties": {"ok": {"type": "boolean"}},
            "required": ["ok"],
            "additionalProperties": False,
        }
        t0 = time.monotonic()
        try:
            out = self.complete_json(
                "You reply only with JSON.",
                'Reply with exactly {"ok": true}.',
                probe_schema,
            )
        except LLMError as exc:
            return ConnTest(ok=False, error=str(exc), provider=self.name, model=self.model,
                            latency_ms=int((time.monotonic() - t0) * 1000))
        latency = int((time.monotonic() - t0) * 1000)
        return ConnTest(ok=bool(out.get("ok", True)), latency_ms=latency,
                        json_mode="response_schema", models=self.list_models(),
                        provider=self.name, model=self.model)

    def list_models(self) -> list[str]:
        client = self._http()
        try:
            r = client.get(f"{self.base_url}/models", params={"key": self._key, "pageSize": 200})
            r.raise_for_status()
            names = [m.get("name", "").split("/")[-1] for m in (r.json().get("models") or [])]
            return sorted(n for n in names if n)
        except Exception as exc:
            log.info("model listing unavailable: %s", type(exc).__name__)
            return []
        finally:
            if self._client is None:
                client.close()
