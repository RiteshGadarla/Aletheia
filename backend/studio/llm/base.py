"""Provider interface + retry policy (CONTRACTS §9, docs/llm-provider-notes.md)."""

from __future__ import annotations

import json
import logging
import random
import re
import time
from typing import Any, Callable, Protocol

import httpx
from google.genai import errors as genai_errors

from ..core.models import ConnTest

log = logging.getLogger("studio.llm")

# Measured: the Gemini endpoint 500s roughly half the time. 4 attempts, 1/2/4/8s + jitter.
MAX_ATTEMPTS = 4
BASE_BACKOFF_S = 1.0
RETRY_STATUS = {408, 409, 425, 429, 500, 502, 503, 504}
# Rate limits are per-minute windows: a 1-8s backoff cannot outlast one, so 429 waits longer.
RATE_LIMIT_BACKOFF_S = 20.0
MAX_RATE_WAIT_S = 60.0
_RETRY_DELAY = re.compile(r"retryDelay'?\"?\s*:\s*'?\"?(\d+(?:\.\d+)?)s")
_FENCE = re.compile(r"^```[a-zA-Z]*\s*|\s*```\s*$")


def parse_json_text(text: str) -> Any:
    """JSON from a model reply that may wrap it in a code fence or trail prose after it."""
    t = _FENCE.sub("", (text or "").strip()).strip()
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        start = min((i for i in (t.find("{"), t.find("[")) if i >= 0), default=-1)
        if start < 0:
            raise
        return json.JSONDecoder().raw_decode(t[start:])[0]


def _rate_wait(exc: Exception, attempt: int) -> float:
    """The server's RetryInfo delay when it gives one, else a growing per-minute-sized wait."""
    m = _RETRY_DELAY.search(str(getattr(exc, "details", "") or exc))
    wait = float(m.group(1)) if m else RATE_LIMIT_BACKOFF_S * attempt
    return min(wait + random.uniform(0, 1), MAX_RATE_WAIT_S)


class LLMError(RuntimeError):
    """Any provider failure. Callers fall back to the heuristic proposal; onboarding never blocks."""

    def __init__(self, message: str, *, attempts: int = 0, status: int | None = None) -> None:
        super().__init__(message)
        self.attempts = attempts
        self.status = status


class LLMUnavailable(LLMError):
    """No provider configured, or air-gap / limit refused the call."""


class Provider(Protocol):
    name: str
    model: str

    def complete_json(self, system_prompt: str, user_prompt: str, schema: dict) -> dict: ...
    def test_connection(self) -> ConnTest: ...


def redact(text: str, secrets: list[str]) -> str:
    """Keys must never reach a log line or an API error body."""
    out = text or ""
    for s in secrets:
        if s and len(s) >= 6:
            out = out.replace(s, "***")
    return out


def with_retry(call: Callable[[int], Any], *, what: str, secrets: list[str],
               attempts: int = MAX_ATTEMPTS, sleep=time.sleep) -> Any:
    """Retry 5xx / timeouts with exponential backoff 1/2/4/8s plus jitter."""
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return call(attempt)
        except genai_errors.APIError as exc:                 # google-genai SDK (Gemini)
            status = exc.code
            last = exc
            if status not in RETRY_STATUS:
                body = redact(str(exc.message or exc)[:400], secrets)
                raise LLMError(f"{what}: HTTP {status}: {body}", attempts=attempt,
                               status=status) from exc
            log.warning("%s: HTTP %s on attempt %d/%d", what, status, attempt, attempts)
            if status == 429 and attempt < attempts:
                sleep(_rate_wait(exc, attempt))
                continue
        except httpx.HTTPStatusError as exc:                  # OpenAI-compatible providers
            status = exc.response.status_code
            last = exc
            if status not in RETRY_STATUS:
                body = redact(exc.response.text[:400], secrets)
                raise LLMError(f"{what}: HTTP {status}: {body}", attempts=attempt,
                               status=status) from exc
            log.warning("%s: HTTP %d on attempt %d/%d", what, status, attempt, attempts)
            if status == 429 and attempt < attempts:
                sleep(_rate_wait(exc, attempt))
                continue
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            last = exc
            log.warning("%s: %s on attempt %d/%d", what, type(exc).__name__, attempt, attempts)
        if attempt < attempts:
            delay = BASE_BACKOFF_S * (2 ** (attempt - 1))
            sleep(delay + random.uniform(0, delay * 0.25))
    if isinstance(last, genai_errors.APIError):
        status = last.code
    else:
        status = getattr(getattr(last, "response", None), "status_code", None)
    raise LLMError(f"{what}: giving up after {attempts} attempts ({type(last).__name__}"
                   f"{f' HTTP {status}' if status else ''})",
                   attempts=attempts, status=status) from last
