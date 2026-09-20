"""Request cap and usage counter (spec §8.12.9)."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field


class RateLimited(RuntimeError):
    pass


@dataclass
class Usage:
    requests: int = 0
    failures: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    last_at: float | None = None
    last_origin: str | None = None
    window: list[float] = field(default_factory=list)

    def public(self) -> dict:
        return {
            "requests": self.requests,
            "failures": self.failures,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "requests_last_hour": len(self.window),
            "last_at": self.last_at,
            "last_origin": self.last_origin,
        }


class UsageCounter:
    """Per-hour cap plus the counter shown in Settings. Never records the key."""

    def __init__(self, per_hour: int = 60) -> None:
        self.per_hour = per_hour
        self._lock = threading.RLock()
        self.usage = Usage()

    def _prune(self, now: float) -> None:
        cutoff = now - 3600
        self.usage.window = [t for t in self.usage.window if t > cutoff]

    def check(self, per_hour: int | None = None) -> None:
        cap = self.per_hour if per_hour is None else per_hour
        with self._lock:
            now = time.time()
            self._prune(now)
            if cap and len(self.usage.window) >= cap:
                raise RateLimited(f"AI request cap reached ({cap}/hour)")

    def record(self, origin: str, tokens: dict | None = None, ok: bool = True) -> None:
        with self._lock:
            now = time.time()
            self._prune(now)
            self.usage.window.append(now)
            self.usage.requests += 1
            if not ok:
                self.usage.failures += 1
            self.usage.last_at = now
            self.usage.last_origin = origin
            if tokens:
                self.usage.prompt_tokens += int(tokens.get("prompt_tokens") or 0)
                self.usage.completion_tokens += int(tokens.get("completion_tokens") or 0)

    def snapshot(self) -> dict:
        with self._lock:
            self._prune(time.time())
            return self.usage.public()

    def reset(self) -> None:
        with self._lock:
            self.usage = Usage()
