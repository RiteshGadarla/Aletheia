"""Only Gemini models on the gemini provider; tolerant JSON parsing; rate-limit-aware retries."""

from __future__ import annotations

from typing import Any

import pytest
from google.genai import errors as genai_errors

from studio.core.settings import DEFAULT_GEMINI_MODEL
from studio.llm.base import LLMError, parse_json_text, with_retry


def test_stale_non_gemini_model_falls_back_to_default(state: Any) -> None:
    state.settings.set("llm.provider", "gemini")
    state.settings.set("llm.model", "gemma-4-31b-it")
    assert state.settings.llm_config().model == DEFAULT_GEMINI_MODEL


def test_gemini_model_is_kept(state: Any) -> None:
    state.settings.set("llm.provider", "gemini")
    state.settings.set("llm.model", "gemini-2.5-pro")
    assert state.settings.llm_config().model == "gemini-2.5-pro"


def test_saving_a_non_gemini_model_is_rejected(client: Any) -> None:
    r = client.put("/api/v1/settings/llm", json={"provider": "gemini", "model": "gemma-4-31b-it"})
    assert r.status_code == 422 and "Gemini" in r.json()["detail"]
    ok = client.put("/api/v1/settings/llm", json={"provider": "gemini", "model": "gemini-3.5-flash-lite"})
    assert ok.status_code == 200


@pytest.mark.parametrize("text", ['```json\n{"a": 1}\n```', ' {"a": 1}\n```', '{"a": 1}\nnote: done'])
def test_parse_json_text_strips_fences_and_trailing_prose(text: str) -> None:
    assert parse_json_text(text) == {"a": 1}


def _api_error(code: int, delay: str | None = None) -> genai_errors.APIError:
    details = [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": delay}] if delay else []
    return genai_errors.APIError(code, {"error": {"code": code, "message": "x", "details": details}})


def test_rate_limit_waits_for_the_servers_retry_delay() -> None:
    sleeps: list[float] = []
    calls = iter([_api_error(429, "31s"), "ok"])

    def call(_n: int) -> Any:
        v = next(calls)
        if isinstance(v, Exception):
            raise v
        return v

    assert with_retry(call, what="t", secrets=[], sleep=sleeps.append) == "ok"
    assert len(sleeps) == 1 and 31 <= sleeps[0] <= 32


def test_rate_limit_without_delay_backs_off_per_minute_and_reports_status() -> None:
    sleeps: list[float] = []

    def call(_n: int) -> Any:
        raise _api_error(429)

    with pytest.raises(LLMError) as ei:
        with_retry(call, what="t", secrets=[], sleep=sleeps.append)
    assert [round(s) // 10 for s in sleeps] == [2, 4, 6] and "HTTP 429" in str(ei.value)
