"""Write-through cache over the repo's `alerting_objects` table (kinds: rule, contact_point, policy).

Reads come from memory so the evaluator never hits Postgres per tick; every write goes to the repo
first, so a DB failure surfaces as an API error instead of silent divergence.
"""
from __future__ import annotations

import copy
import logging
import threading
from typing import Any

from ..core.db import Repo
from . import seed
from .models import now_iso

log = logging.getLogger("studio.alerting.store")

KINDS = ("rule", "contact_point", "policy")
POLICY_ID = "root"


class AlertingStore:
    def __init__(self, repo: Repo) -> None:
        self._repo = repo
        self._lock = threading.RLock()
        self._loaded = False
        self.rules: dict[str, dict[str, Any]] = {}
        self.contact_points: dict[str, dict[str, Any]] = {}
        self.policy: dict[str, Any] | None = None

    def load(self, initial_sync: dict[str, Any]) -> None:
        """Read everything once; seed on a completely empty store (idempotent)."""
        with self._lock:
            if self._loaded:
                return
            self.rules = {d["id"]: d for d in self._repo.alerting_list("rule")}
            self.contact_points = {d["id"]: d for d in self._repo.alerting_list("contact_point")}
            pol = self._repo.alerting_list("policy")
            self.policy = pol[0] if pol else None
            if not self.rules and not self.contact_points and self.policy is None:
                self._seed(initial_sync)
            elif self.policy is None and self.contact_points:
                # A tree is required; point it at the builtin (or any) contact point.
                recv = seed.BROWSER_ID if seed.BROWSER_ID in self.contact_points else next(iter(self.contact_points))
                self.put("policy", {**seed.seed_policy(), "receiver": recv, "routes": [],
                                    "sync": dict(initial_sync)})
            self._loaded = True

    def _seed(self, sync: dict[str, Any]) -> None:
        log.info("alerting store empty: seeding Browser contact point, root policy and starter rules")
        for cp in seed.seed_contact_points():
            self.put("contact_point", {**cp, "sync": dict(sync)})
        self.put("policy", {**seed.seed_policy(), "sync": dict(sync)})
        for r in seed.seed_rules():
            self.put("rule", {**r, "sync": dict(sync)})

    def _bucket(self, kind: str) -> dict[str, dict[str, Any]]:
        return self.rules if kind == "rule" else self.contact_points

    def put(self, kind: str, doc: dict[str, Any]) -> dict[str, Any]:
        doc = copy.deepcopy(doc)
        now = now_iso()
        with self._lock:
            prev = self.policy if kind == "policy" else self._bucket(kind).get(doc.get("id", ""))
            doc["created_at"] = (prev or {}).get("created_at") or doc.get("created_at") or now
            doc["updated_at"] = now
            oid = POLICY_ID if kind == "policy" else doc["id"]
            self._repo.alerting_put(kind, oid, doc)
            if kind == "policy":
                self.policy = doc
            else:
                self._bucket(kind)[oid] = doc
            return copy.deepcopy(doc)

    def set_sync(self, kind: str, oid: str, sync: dict[str, Any], updated_at: str | None = None) -> None:
        """Record a Grafana sync outcome without bumping updated_at; skip if the doc moved on."""
        with self._lock:
            doc = self.policy if kind == "policy" else self._bucket(kind).get(oid)
            if doc is None or (updated_at and doc.get("updated_at") != updated_at):
                return
            if doc.get("sync") == sync:
                return
            doc["sync"] = dict(sync)
            try:
                self._repo.alerting_put(kind, POLICY_ID if kind == "policy" else oid, doc)
            except Exception as exc:                                # noqa: BLE001
                log.warning("cannot persist sync state for %s/%s: %s", kind, oid, type(exc).__name__)

    def delete(self, kind: str, oid: str) -> None:
        with self._lock:
            self._repo.alerting_delete(kind, oid)
            self._bucket(kind).pop(oid, None)

    def get(self, kind: str, oid: str) -> dict[str, Any] | None:
        with self._lock:
            doc = self.policy if kind == "policy" else self._bucket(kind).get(oid)
            return copy.deepcopy(doc) if doc is not None else None

    def all(self, kind: str) -> list[dict[str, Any]]:
        with self._lock:
            if kind == "policy":
                return [copy.deepcopy(self.policy)] if self.policy else []
            return [copy.deepcopy(d) for d in self._bucket(kind).values()]
