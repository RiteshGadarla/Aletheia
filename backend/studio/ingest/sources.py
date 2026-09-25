"""Source registry: what is connected, how, and where onboarding stands. Persisted in the repo."""
from __future__ import annotations

import json
import os
import re
import threading
import time
from dataclasses import asdict, dataclass, field
from typing import Any

from ..core.db import Repo

KEY = "sources.registry"
TYPES = ("tcp", "udp_listen", "http_stream", "websocket", "loki_pull", "rest_cursor", "push")
STATES = ("collecting", "review", "approved", "rejected")
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,62}$")
# UDP ports another process in this network namespace owns (Vector's syslog in the all-in-one).
# Binding one first at boot makes that process fail to start, so udp_listen may never take them.
RESERVED_UDP = {int(p) for p in os.environ.get("ALETHEIA_RESERVED_UDP_PORTS", "").split(",") if p.strip()}


def check_udp_port(port: int) -> None:
    if port in RESERVED_UDP:
        raise ValueError(f"UDP port {port} is reserved for the syslog listener; pick another port")


@dataclass
class Source:
    id: str
    type: str
    config: dict[str, Any] = field(default_factory=dict)
    name: str = ""
    enabled: bool = True
    state: str = "collecting"
    attempts: int = 0
    approved_ns: int = 0          # lines at or after this go live; earlier ones are backfilled
    created_at: float = field(default_factory=time.time)
    history: list[dict[str, Any]] = field(default_factory=list)


def validate(src: Source) -> None:
    if not _ID.match(src.id):
        raise ValueError("id must be 1-63 chars of letters, digits, _ . : -")
    if src.type not in TYPES:
        raise ValueError(f"type must be one of {', '.join(TYPES)}")
    c, need = src.config, {"tcp": ("host", "port"), "udp_listen": ("port",), "http_stream": ("url",),
                           "websocket": ("url",), "loki_pull": ("url",), "rest_cursor": ("url",), "push": ()}
    for k in need[src.type]:
        if not c.get(k):
            raise ValueError(f"{src.type} needs config.{k}")
    if "port" in c and not (1 <= int(c["port"]) <= 65535):
        raise ValueError("port out of range")
    if src.type == "udp_listen":
        check_udp_port(int(c["port"]))


class SourceRegistry:
    def __init__(self, repo: Repo) -> None:
        self._repo, self._lock = repo, threading.RLock()
        self._d: dict[str, Source] = {}
        row = repo.settings_all().get(KEY)
        if row:
            for raw in json.loads(row.value):
                self._d[raw["id"]] = Source(**raw)

    def _save(self) -> None:
        self._repo.settings_set(KEY, json.dumps([asdict(s) for s in self._d.values()]), False)

    def list(self) -> list[Source]:
        with self._lock:
            return sorted(self._d.values(), key=lambda s: s.created_at)

    def get(self, sid: str) -> Source | None:
        with self._lock:
            return self._d.get(sid)

    def add(self, src: Source) -> Source:
        validate(src)
        with self._lock:
            if src.id in self._d:
                raise KeyError(f"source {src.id} exists")
            self._d[src.id] = src
            self._save()
        return src

    def ensure(self, sid: str, type_: str = "push") -> Source:
        """Auto-register an unknown pushing system as a pending source (never inherits packs)."""
        with self._lock:
            if sid not in self._d:
                self._d[sid] = Source(id=sid, type=type_, name=sid)
                self._save()
            return self._d[sid]

    def update(self, sid: str, **kw: Any) -> Source:
        with self._lock:
            s = self._d[sid]
            for k, v in kw.items():
                setattr(s, k, v)
            self._save()
            return s

    def event(self, sid: str, action: str, actor: str, detail: dict[str, Any] | None = None) -> None:
        with self._lock:
            s = self._d[sid]
            s.history.append({"at": time.time(), "action": action, "actor": actor, **(detail or {})})
            del s.history[:-50]
            self._save()

    def delete(self, sid: str) -> None:
        with self._lock:
            self._d.pop(sid)
            self._save()
