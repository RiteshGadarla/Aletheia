"""Process-wide singletons for the API layer: repo, settings, cluster engine, usage, bus.

A module-level singleton keeps route handlers simple (no FastAPI dependency-injection ceremony
for what is genuinely process-global state). Tests use reset_state() to get a clean, in-memory
instance between cases.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from ..cluster.engine import ClusterEngine
from ..core.bus import ControlPublisher
from ..core.crypto import resolve_secret
from ..core.db import Repo, build_repo
from ..core.settings import SettingsStore
from ..llm.limits import UsageCounter


@dataclass
class AppState:
    repo: Repo = field(default_factory=build_repo)
    clusters: ClusterEngine = field(default_factory=ClusterEngine)
    usage: UsageCounter = field(default_factory=UsageCounter)
    settings: SettingsStore = field(init=False)
    bus: ControlPublisher = field(init=False)

    def __post_init__(self) -> None:
        # resolve_secret falls back to a persisted local secret, so saving an API key from the
        # Settings page works on a plain `make dev` with nothing configured (CONTRACTS §9).
        self.settings = SettingsStore(self.repo, secret=resolve_secret())
        self.bus = ControlPublisher(str(self.settings.get("bus.brokers") or ""))


_state: AppState | None = None


def get_state() -> AppState:
    global _state
    if _state is None:
        _state = AppState()
    return _state


def reset_state(state: AppState | None = None) -> AppState:
    """Test hook: install a fresh (or caller-provided) state and return it."""
    global _state
    _state = state if state is not None else AppState()
    return _state
