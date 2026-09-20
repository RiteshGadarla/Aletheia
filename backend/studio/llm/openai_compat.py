"""OpenAI Chat Completions adapter — used for every local server (Ollama, vLLM, llama.cpp, LM Studio)."""

from __future__ import annotations

import json
import logging
import re
import time
from typing import Any

import httpx

from ..core.models import ConnTest
from .base import LLMError, with_retry

log = logging.getLogger("studio.llm.openai")

_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.I)


class OpenAICompatibleProvider:
    """Tries json_schema mode, then json_object, then prompt-only (spec §8.12.4 step 1)."""

    def __init__(self, model: str, api_key: str = "", base_url: str = "",
                 timeout_s: int = 30, max_output_tokens: int = 2048,
                 name: str = "local", client: httpx.Client | None = None) -> None:
        self.name = name
        self.model = model
        self._key = api_key
        self.base_url = (base_url or "").rstrip("/")
        self.timeout_s = timeout_s
        self.max_output_tokens = max_output_tokens
        self._client = client
        self.json_mode: str | None = None
        self.last_usage: dict[str, int] = {}
        if not self.base_url:
            raise LLMError(f"{name}: base_url is required")

    def _http(self) -> httpx.Client:
        return self._client or httpx.Client(timeout=self.timeout_s)

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self._key:
            h["Authorization"] = f"Bearer {self._key}"
        return h

    def _body(self, system_prompt: str, user_prompt: str, schema: dict[str, Any],
              mode: str) -> dict[str, Any]:
        user = user_prompt
        messages = [{"role": "system", "content": system_prompt},
                    {"role": "user", "content": user}]
        body: dict[str, Any] = {"model": self.model, "messages": messages,
                                "temperature": 0, "max_tokens": self.max_output_tokens}
        if mode == "response_schema":
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "aletheia_mapping", "strict": True, "schema": schema},
            }
        elif mode == "json_object":
            body["response_format"] = {"type": "json_object"}
            messages[1]["content"] = (
                f"{user}\n\nRespond with JSON matching this schema:\n{json.dumps(schema)}"
            )
        else:
            messages[1]["content"] = (
                f"{user}\n\nRespond with JSON only (no prose, no code fence) matching:\n"
                f"{json.dumps(schema)}"
            )
        return body

    def _post_chat(self, body: dict[str, Any]) -> dict[str, Any]:
        client = self._http()
        try:
            r = client.post(f"{self.base_url}/chat/completions", headers=self._headers(), json=body)
            r.raise_for_status()
            return r.json()
        finally:
            if self._client is None:
                client.close()

    def complete_json(self, system_prompt: str, user_prompt: str, schema: dict) -> dict:
        modes = [self.json_mode] if self.json_mode else ["response_schema", "json_object", "prompt"]
        last: Exception | None = None
        for mode in modes:
            body = self._body(system_prompt, user_prompt, schema, mode)
            try:
                data = with_retry(lambda _n, b=body: self._post_chat(b),
                                  what=f"{self.name}/{self.model}[{mode}]", secrets=[self._key])
            except LLMError as exc:
                # 4xx here usually means the endpoint does not support this JSON mode.
                if exc.status and 400 <= exc.status < 500 and mode != "prompt":
                    log.info("%s: mode %s unsupported, downgrading", self.name, mode)
                    last = exc
                    continue
                raise
            self.json_mode = mode
            usage = data.get("usage") or {}
            self.last_usage = {
                "prompt_tokens": int(usage.get("prompt_tokens") or 0),
                "completion_tokens": int(usage.get("completion_tokens") or 0),
                "total_tokens": int(usage.get("total_tokens") or 0),
            }
            choices = data.get("choices") or []
            if not choices:
                raise LLMError(f"{self.name}: empty response")
            text = _FENCE.sub("", str((choices[0].get("message") or {}).get("content") or "")).strip()
            try:
                return json.loads(text)
            except json.JSONDecodeError as exc:
                if mode != "prompt":
                    last = exc
                    continue
                raise LLMError(f"{self.name}: response is not JSON: {text[:200]}") from exc
        raise LLMError(f"{self.name}: no usable JSON mode ({type(last).__name__ if last else '?'})")

    def list_models(self) -> list[str]:
        client = self._http()
        try:
            r = client.get(f"{self.base_url}/models", headers=self._headers())
            r.raise_for_status()
            payload = r.json()
            items = payload.get("data") or payload.get("models") or []
            names = [str(m.get("id") or m.get("name") or "") for m in items if isinstance(m, dict)]
            return sorted(n for n in names if n)
        except Exception as exc:
            log.info("%s: model listing unavailable (%s)", self.name, type(exc).__name__)
            return []
        finally:
            if self._client is None:
                client.close()

    def test_connection(self) -> ConnTest:
        schema = {"type": "object", "properties": {"ok": {"type": "boolean"}},
                  "required": ["ok"], "additionalProperties": False}
        t0 = time.monotonic()
        try:
            out = self.complete_json("You reply only with JSON.",
                                     'Reply with exactly {"ok": true}.', schema)
        except LLMError as exc:
            return ConnTest(ok=False, error=str(exc), provider=self.name, model=self.model,
                            latency_ms=int((time.monotonic() - t0) * 1000))
        return ConnTest(ok=bool(out.get("ok", True)),
                        latency_ms=int((time.monotonic() - t0) * 1000),
                        json_mode=self.json_mode, models=self.list_models(),
                        provider=self.name, model=self.model)
