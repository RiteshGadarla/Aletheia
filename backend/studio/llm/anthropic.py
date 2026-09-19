"""Anthropic Messages API adapter. Structured output via a forced tool call."""

from __future__ import annotations

import json
import time
from typing import Any

import httpx

from ..core.models import ConnTest
from .base import LLMError, with_retry

DEFAULT_BASE_URL = "https://api.anthropic.com/v1"
API_VERSION = "2023-06-01"
TOOL_NAME = "emit_mapping"


class AnthropicProvider:
    name = "anthropic"

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

    def _http(self) -> httpx.Client:
        return self._client or httpx.Client(timeout=self.timeout_s)

    def _headers(self) -> dict[str, str]:
        return {"x-api-key": self._key, "anthropic-version": API_VERSION,
                "Content-Type": "application/json"}

    def _post(self, body: dict[str, Any]) -> dict[str, Any]:
        client = self._http()
        try:
            r = client.post(f"{self.base_url}/messages", headers=self._headers(), json=body)
            r.raise_for_status()
            return r.json()
        finally:
            if self._client is None:
                client.close()

    def complete_json(self, system_prompt: str, user_prompt: str, schema: dict) -> dict:
        body = {
            "model": self.model,
            "max_tokens": self.max_output_tokens,
            "temperature": 0,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_prompt}],
            "tools": [{"name": TOOL_NAME, "description": "Return the OCSF mapping proposal.",
                       "input_schema": schema}],
            "tool_choice": {"type": "tool", "name": TOOL_NAME},
        }
        data = with_retry(lambda _n: self._post(body), what=f"anthropic/{self.model}",
                          secrets=[self._key])
        usage = data.get("usage") or {}
        self.last_usage = {
            "prompt_tokens": int(usage.get("input_tokens") or 0),
            "completion_tokens": int(usage.get("output_tokens") or 0),
            "total_tokens": int(usage.get("input_tokens") or 0) + int(usage.get("output_tokens") or 0),
        }
        for block in data.get("content") or []:
            if block.get("type") == "tool_use" and block.get("name") == TOOL_NAME:
                out = block.get("input")
                if isinstance(out, dict):
                    return out
        for block in data.get("content") or []:      # fallback: plain text JSON
            if block.get("type") == "text":
                try:
                    return json.loads(block.get("text", "").strip())
                except json.JSONDecodeError:
                    break
        raise LLMError("anthropic: no tool_use block in response")

    def list_models(self) -> list[str]:
        client = self._http()
        try:
            r = client.get(f"{self.base_url}/models", headers=self._headers())
            r.raise_for_status()
            return sorted(str(m.get("id")) for m in (r.json().get("data") or []))
        except Exception:
            return []
        finally:
            if self._client is None:
                client.close()

    def test_connection(self) -> ConnTest:
        schema = {"type": "object", "properties": {"ok": {"type": "boolean"}},
                  "required": ["ok"]}
        t0 = time.monotonic()
        try:
            out = self.complete_json("You reply only with JSON.",
                                     'Reply with exactly {"ok": true}.', schema)
        except LLMError as exc:
            return ConnTest(ok=False, error=str(exc), provider=self.name, model=self.model,
                            latency_ms=int((time.monotonic() - t0) * 1000))
        return ConnTest(ok=bool(out.get("ok", True)),
                        latency_ms=int((time.monotonic() - t0) * 1000),
                        json_mode="tool_schema", models=self.list_models(),
                        provider=self.name, model=self.model)
