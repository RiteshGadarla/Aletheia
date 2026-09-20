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
from ..ingest.connectors import ConnectorManager
from ..ingest.forward import RawForwarder
from ..ingest.pipeline import IngestPipeline
from ..ingest.rawstore import RawStore, build_rawstore
from ..ingest.sources import SourceRegistry
from ..llm.limits import UsageCounter


@dataclass
class AppState:
    repo: Repo = field(default_factory=build_repo)
    clusters: ClusterEngine = field(default_factory=ClusterEngine)
    usage: UsageCounter = field(default_factory=UsageCounter)
    settings: SettingsStore = field(init=False)
    bus: ControlPublisher = field(init=False)
    raw: RawStore = field(default_factory=build_rawstore)
    registry: SourceRegistry = field(init=False)
    forwarder: RawForwarder = field(init=False)
    pipeline: IngestPipeline = field(init=False)
    connectors: ConnectorManager = field(init=False)

    def __post_init__(self) -> None:
        # resolve_secret falls back to a persisted local secret, so saving an API key from the
        # Settings page works on a plain `make dev` with nothing configured (CONTRACTS §9).
        self.settings = SettingsStore(self.repo, secret=resolve_secret())
        self.bus = ControlPublisher(str(self.settings.get("bus.brokers") or ""))
        self.registry = SourceRegistry(self.repo)
        self.forwarder = RawForwarder(str(self.settings.get("bus.brokers") or ""))

        def forward(sid, entries):
            s = self.registry.get(sid)
            if s and s.state == "approved":
                self.forwarder.send(sid, [e for e in entries if e[0] >= s.approved_ns])

        self.pipeline = IngestPipeline(self.raw, forward=forward)
        self.connectors = ConnectorManager(self.registry, self.pipeline)


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
