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
    """Supports OpenAI-compatible endpoints as well as Ollama native fallbacks."""

    def __init__(self, model: str, api_key: str = "", base_url: str = "",
                 timeout_s: int = 30, max_output_tokens: int = 2048,
                 name: str = "local", client: httpx.Client | None = None) -> None:
        self.name = name
        self.model = (model or "").strip()
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

    def _chat_endpoints(self) -> list[str]:
        url = self.base_url
        if url.endswith("/v1") or url.endswith("/api"):
            return [f"{url}/chat/completions", f"{url}/api/chat"]
        return [f"{url}/v1/chat/completions", f"{url}/chat/completions", f"{url}/api/chat"]

    def _models_endpoints(self) -> list[str]:
        url = self.base_url
        if url.endswith("/v1") or url.endswith("/api"):
            return [f"{url}/models", f"{url}/api/tags"]
        return [f"{url}/v1/models", f"{url}/models", f"{url}/api/tags"]

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
        if not self.model:
            raise LLMError(f"Provider '{self.name}' is configured but no model name is set.")
        client = self._http()
        endpoints = self._chat_endpoints()
        last_exc: Exception | None = None
        for i, url in enumerate(endpoints):
            try:
                r = client.post(url, headers=self._headers(), json=body)
                if r.status_code == 404 and i < len(endpoints) - 1:
                    continue
                r.raise_for_status()
                return r.json()
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code == 404 and i < len(endpoints) - 1:
                    last_exc = exc
                    continue
                raise LLMError(f"{self.name} endpoint {url} returned HTTP {exc.response.status_code}: {exc.response.text[:200]}", status=exc.response.status_code) from exc
            except (httpx.ConnectError, httpx.NetworkError) as exc:
                raise LLMError(f"Could not connect to {self.name} server at {self.base_url}. Is the server running?") from exc
            except httpx.TimeoutException as exc:
                raise LLMError(f"Request to {self.name} server at {self.base_url} timed out after {self.timeout_s}s.") from exc
            except Exception as exc:
                last_exc = exc
                raise LLMError(f"{self.name} request failed: {exc}") from exc
        if last_exc:
            raise LLMError(f"Could not connect to chat endpoint at {self.base_url}: {last_exc}")
        raise LLMError(f"{self.name}: unable to reach chat endpoint at {self.base_url}")

    def complete_json(self, system_prompt: str, user_prompt: str, schema: dict) -> dict:
        modes = [self.json_mode] if self.json_mode else ["response_schema", "json_object", "prompt"]
        last: Exception | None = None
        for mode in modes:
            body = self._body(system_prompt, user_prompt, schema, mode)
            try:
                data = with_retry(lambda _n, b=body: self._post_chat(b),
                                  what=f"{self.name}/{self.model}[{mode}]", secrets=[self._key])
            except LLMError as exc:
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
                msg = data.get("message") or {}
                text_content = msg.get("content") or data.get("response") or ""
                if text_content:
                    text = _FENCE.sub("", str(text_content)).strip()
                    try:
                        return json.loads(text)
                    except json.JSONDecodeError as exc:
                        if mode != "prompt":
                            last = exc
                            continue
                        raise LLMError(f"{self.name}: response is not JSON: {text[:200]}") from exc
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
        endpoints = self._models_endpoints()
        names: set[str] = set()
        for url in endpoints:
            try:
                r = client.get(url, headers=self._headers())
                if r.status_code != 200:
                    continue
                payload = r.json()
                items = payload.get("data") or payload.get("models") or []
                if isinstance(items, list):
                    for m in items:
                        if isinstance(m, dict):
                            val = str(m.get("id") or m.get("name") or m.get("model") or "").strip()
                            if val:
                                names.add(val)
                if names:
                    break
            except Exception as exc:
                log.info("%s: model listing error on %s (%s)", self.name, url, type(exc).__name__)
        return sorted(names)

    def test_connection(self) -> ConnTest:
        if not self.model:
            return ConnTest(
                ok=False,
                error=f"Provider '{self.name}' is configured but no model is set.",
                provider=self.name,
                model=self.model,
                latency_ms=0,
            )

        t0 = time.monotonic()
        models = self.list_models()

        if models:
            found = any(m == self.model or m.lower() == self.model.lower() for m in models)
            if not found:
                base_name = self.model.split(":")[0]
                partial = [m for m in models if m.startswith(base_name)]
                err_msg = f"Model '{self.model}' not found on {self.name} server at {self.base_url}."
                if partial:
                    err_msg += f" Matching available models: {', '.join(partial)}."
                else:
                    err_msg += f" Installed models: {', '.join(models)}."
                err_msg += f" Run 'ollama pull {self.model}' to install it."
                return ConnTest(
                    ok=False,
                    error=err_msg,
                    models=models,
                    provider=self.name,
                    model=self.model,
                    latency_ms=int((time.monotonic() - t0) * 1000),
                )

        sample_prompt = "Explain this log in one sentence:\nERROR payment_service connection timeout"
        sample_response_text: str | None = None

        try:
            body = {
                "model": self.model,
                "messages": [{"role": "user", "content": sample_prompt}],
                "temperature": 0,
                "max_tokens": 120,
            }
            data = with_retry(lambda _n: self._post_chat(body), what=f"{self.name}/{self.model}[test]", secrets=[self._key])
            choices = data.get("choices") or []
            if choices:
                sample_response_text = str((choices[0].get("message") or {}).get("content") or "").strip()
            elif "message" in data or "response" in data:
                sample_response_text = str((data.get("message") or {}).get("content") or data.get("response") or "").strip()
        except Exception as exc:
            log.warning("%s: sample inference test failed: %s", self.name, exc)

        schema = {"type": "object", "properties": {"ok": {"type": "boolean"}},
                  "required": ["ok"], "additionalProperties": False}
        try:
            out = self.complete_json("You reply only with JSON.",
                                     'Reply with exactly {"ok": true}.', schema)
            ok_status = bool(out.get("ok", True))
        except LLMError as exc:
            if sample_response_text:
                return ConnTest(
                    ok=True,
                    latency_ms=int((time.monotonic() - t0) * 1000),
                    json_mode="prompt",
                    models=models,
                    provider=self.name,
                    model=self.model,
                    sample_response=sample_response_text,
                )
            return ConnTest(
                ok=False,
                error=str(exc),
                provider=self.name,
                model=self.model,
                latency_ms=int((time.monotonic() - t0) * 1000),
                models=models,
            )

        return ConnTest(
            ok=ok_status,
            latency_ms=int((time.monotonic() - t0) * 1000),
            json_mode=self.json_mode,
            models=models,
            provider=self.name,
            model=self.model,
            sample_response=sample_response_text,
        )
