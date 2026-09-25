"""Alerting service: CRUD over the store, Grafana sync, local evaluation and delivery.

Grafana failures never fail an API write: the object is saved, its `sync` records the problem and
the background loop retries. Network calls are made outside the data lock.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import math
import os
import threading
import time
from typing import Any, Callable

import httpx

from ..core.crypto import SecretUnavailable, open_sealed, seal
from ..core.db import Repo
from . import evaluator
from .feed import NotificationFeed
from .grafana import (GrafanaClient, GrafanaConfig, GrafanaError,
                      contact_point_to_grafana, parse_value_string, policy_to_grafana,
                      rule_to_grafana)
from .models import (SECRET_KEYS, ContactPointIn, PolicyIn, RuleIn, ValidationFailed, check_cp,
                     check_select, clean_cp_settings, new_id, now_iso, parse_duration, policy_doc,
                     receivers_in)
from .router import route
from .seed import BROWSER_ID
from .store import POLICY_ID, AlertingStore

log = logging.getLogger("studio.alerting")

HEALTH_EVERY = 30.0          # mode re-check
SYNC_EVERY = 15.0            # retry pending/error objects and refresh Grafana rule state
FULL_SYNC_EVERY = 300.0      # full reconcile, catches drift made in Grafana's UI
EVAL_TICK = 1.0

RULE_FIELDS = ("id", "name", "group", "datasource", "query", "reducer", "condition", "for",
               "interval", "severity", "labels", "summary", "description", "enabled",
               "no_data_state", "created_at", "updated_at", "sync")


class NotFound(KeyError):
    pass


class Conflict(RuntimeError):
    pass


def _finite(v: Any) -> float | None:
    return v if isinstance(v, (int, float)) and math.isfinite(v) else None


def _probe(url: str | None, path: str) -> dict[str, Any]:
    out: dict[str, Any] = {"url": url, "reachable": False}
    if not url:
        return out
    try:
        r = httpx.get(url.rstrip("/") + path, timeout=1.5)
        out["reachable"] = r.status_code == 200
        if r.status_code != 200:
            out["error"] = f"HTTP {r.status_code} {r.text.strip()[:120]}"
    except httpx.HTTPError as exc:
        out["error"] = type(exc).__name__
    return out


class AlertingService:
    def __init__(self, repo: Repo, secret: str | None = None,
                 transport: httpx.BaseTransport | None = None) -> None:
        self.store = AlertingStore(repo)
        self.feed = NotificationFeed()
        self._secret = secret
        self._transport = transport               # tests inject httpx.MockTransport
        self._lock = threading.RLock()            # runtime / outbox / health
        self._sync_lock = threading.Lock()        # serialises Grafana pushes
        self._client: GrafanaClient | None = None
        self._client_cfg: GrafanaConfig | None = None
        self.mode = "local"
        self._health: dict[str, Any] = {}
        self._health_at = 0.0
        self._full_sync_at = 0.0
        self._folder_ok = False
        self.last_sync_at: str | None = None
        self.last_sync_error: str | None = None
        self.runtime: dict[str, dict[str, Any]] = {}
        self._next_eval: dict[str, float] = {}
        self._outbox: dict[str, dict[str, dict[str, Any]]] = {}
        self._tombstones: set[tuple[str, str]] = set()    # Grafana deletes still to retry
        self._tasks: list[asyncio.Task] = []

    # ------------------------------------------------------------------ lifecycle
    def ensure_loaded(self) -> None:
        cfg = GrafanaConfig.from_env()
        self.store.load({"state": "pending"} if cfg.url else {"state": "local"})

    async def start(self) -> None:
        self.ensure_loaded()
        self._tasks = [asyncio.create_task(self._control_loop(), name="alerting-control"),
                       asyncio.create_task(self._eval_loop(), name="alerting-eval")]

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []
        if self._client:
            self._client.close()
            self._client = None

    # ------------------------------------------------------------------ grafana plumbing
    def _grafana(self) -> GrafanaClient | None:
        cfg = GrafanaConfig.from_env()
        if not cfg.url:
            return None
        if self._client is None or self._client_cfg != cfg:
            if self._client:
                self._client.close()
            self._client, self._client_cfg, self._folder_ok = GrafanaClient(cfg, self._transport), cfg, False
        return self._client

    def refresh_health(self) -> bool:
        """Probe Grafana / Loki / Prometheus; return True when the mode switched to grafana."""
        cfg = GrafanaConfig.from_env()
        g: dict[str, Any] = {"url": cfg.url, "public_url": cfg.public_url, "reachable": False}
        client = self._grafana()
        if client:
            try:
                h = client.health()
                g["reachable"] = True
                if h.get("version"):
                    g["version"] = h["version"]
            except GrafanaError as exc:
                g["error"] = str(exc)
        loki = _probe((os.environ.get("ALETHEIA_LOKI_URL") or "").strip() or None, "/ready")
        prom = _probe((os.environ.get("ALETHEIA_PROMETHEUS_URL") or "").strip() or None, "/-/ready")
        with self._lock:
            before = self.mode
            self.mode = "grafana" if g["reachable"] else "local"
            self._health = {"grafana": g, "loki": loki, "prometheus": prom}
            self._health_at = time.time()
            if before != self.mode:
                # The other engine owns rule state now; stale local state would mislead.
                self.runtime.clear()
                self._outbox.clear()
                self._next_eval.clear()
        if before != self.mode:
            log.info("alerting mode: %s -> %s", before, self.mode)
        return before != "grafana" and self.mode == "grafana"

    def _unsynced(self, cfg: GrafanaConfig) -> dict[str, Any]:
        if not cfg.url:
            return {"state": "local"}
        if self.mode == "grafana":
            return {"state": "pending", "at": now_iso()}
        return {"state": "pending", "error": "Grafana unreachable", "at": now_iso()}

    def _push(self, kind: str, oid: str, fn: Callable[[GrafanaClient], None],
              updated_at: str | None) -> dict[str, Any]:
        """Run one Grafana write and record the outcome on the object's `sync`."""
        cfg = GrafanaConfig.from_env()
        client = self._grafana() if self.mode == "grafana" else None
        if client is None:
            sync = self._unsynced(cfg)
        else:
            try:
                with self._sync_lock:
                    if not self._folder_ok:
                        client.ensure_folder()
                        self._folder_ok = True
                    fn(client)
                sync = {"state": "synced", "at": now_iso()}
                self.last_sync_at = sync["at"]
            except GrafanaError as exc:
                log.warning("grafana sync of %s/%s failed: %s", kind, oid, exc)
                sync = {"state": "error", "error": str(exc)[:500], "at": now_iso()}
                self.last_sync_error = sync["error"]
        self.store.set_sync(kind, oid, sync, updated_at)
        return sync

    def _group_interval(self, group: str) -> int:
        # Grafana has one interval per group; use the shortest any rule in it asks for.
        secs = [parse_duration(r["interval"]) for r in self.store.all("rule") if r["group"] == group]
        return int(min(secs)) if secs else 60

    def _push_rule(self, rule: dict[str, Any], moved_from: str | None = None) -> dict[str, Any]:
        def fn(c: GrafanaClient) -> None:
            if moved_from:
                c.delete_rule(rule["id"])         # provisioning PUT cannot move groups everywhere
            c.upsert_rule(rule_to_grafana(rule, c.folder_uid))
            c.set_group_interval(rule["group"], self._group_interval(rule["group"]))
        return self._push("rule", rule["id"], fn, rule.get("updated_at"))

    def _cp_payload(self, cp: dict[str, Any]) -> dict[str, Any]:
        return contact_point_to_grafana(cp, self._secrets(cp), GrafanaConfig.from_env().receiver_url)

    def _push_cp(self, cp: dict[str, Any], exists: bool | None = None) -> dict[str, Any]:
        payload = self._cp_payload(cp)
        return self._push("contact_point", cp["id"],
                          lambda c: c.upsert_contact_point(payload, exists), cp.get("updated_at"))

    def _names(self) -> dict[str, str]:
        return {c["id"]: c["name"] for c in self.store.all("contact_point")}

    def _push_policy(self) -> dict[str, Any]:
        pol = self.store.get("policy", POLICY_ID) or {}
        tree = policy_to_grafana(pol, self._names())
        return self._push("policy", POLICY_ID, lambda c: c.put_policy(tree), pol.get("updated_at"))

    def _delete_remote(self, kind: str, oid: str) -> None:
        client = self._grafana() if self.mode == "grafana" else None
        if client is None:
            if GrafanaConfig.from_env().url:
                self._tombstones.add((kind, oid))
            return
        try:
            with self._sync_lock:
                (client.delete_rule if kind == "rule" else client.delete_contact_point)(oid)
            self._tombstones.discard((kind, oid))
        except GrafanaError as exc:
            log.warning("grafana delete of %s/%s failed: %s", kind, oid, exc)
            self._tombstones.add((kind, oid))
            self.last_sync_error = str(exc)[:500]

    def sync_all(self) -> None:
        """Full push: folder, contact points, policy, rules, then orphan cleanup."""
        client = self._grafana() if self.mode == "grafana" else None
        if client is None:
            return
        try:
            with self._sync_lock:
                client.ensure_folder()
                self._folder_ok = True
                existing_cps = {c.get("uid") for c in client.list_contact_points()}
        except GrafanaError as exc:
            self.last_sync_error = str(exc)[:500]
            log.warning("grafana full sync failed: %s", exc)
            return
        errors = []
        for cp in self.store.all("contact_point"):
            if self._push_cp(cp, cp["id"] in existing_cps)["state"] != "synced":
                errors.append(f"contact point {cp['name']}")
        if self._push_policy()["state"] != "synced":
            errors.append("policy")
        for r in self.store.all("rule"):
            if self._push_rule(r)["state"] != "synced":
                errors.append(f"rule {r['name']}")
        ours = {r["id"] for r in self.store.all("rule")}
        try:
            with self._sync_lock:
                stale = [g["uid"] for g in client.list_rules()
                         if (g.get("labels") or {}).get("aletheia_rule_id")
                         and g.get("uid") not in ours]
            for uid in stale:
                self._delete_remote("rule", uid)
        except GrafanaError as exc:
            errors.append(f"orphan cleanup: {exc}")
        for kind, oid in sorted(self._tombstones):
            self._delete_remote(kind, oid)
        self._full_sync_at = time.time()
        self.last_sync_error = "; ".join(errors)[:500] or None
        if not errors:
            self.last_sync_at = now_iso()

    def retry_pending(self) -> None:
        dirty = lambda d: (d.get("sync") or {}).get("state") in ("pending", "error")   # noqa: E731
        for cp in filter(dirty, self.store.all("contact_point")):
            self._push_cp(cp)
        pol = self.store.get("policy", POLICY_ID)
        if pol and dirty(pol):
            self._push_policy()
        for r in filter(dirty, self.store.all("rule")):
            self._push_rule(r)
        for kind, oid in sorted(self._tombstones):
            self._delete_remote(kind, oid)

    def refresh_runtime(self) -> None:
        client = self._grafana() if self.mode == "grafana" else None
        if client is None:
            return
        try:
            state = client.rules_runtime()
        except GrafanaError as exc:
            log.debug("grafana rule state unavailable: %s", exc)
            return
        with self._lock:
            for rid in [r["id"] for r in self.store.all("rule")]:
                if rid in state:
                    self.runtime[rid] = {**self.runtime.get(rid, {}), **state[rid]}

    async def _control_loop(self) -> None:
        last_health = 0.0
        while True:
            try:
                now = time.time()
                switched = False
                if now - last_health >= HEALTH_EVERY:
                    switched = await asyncio.to_thread(self.refresh_health)
                    last_health = now
                if self.mode == "grafana":
                    if switched or now - self._full_sync_at >= FULL_SYNC_EVERY:
                        await asyncio.to_thread(self.sync_all)
                    else:
                        await asyncio.to_thread(self.retry_pending)
                    await asyncio.to_thread(self.refresh_runtime)
            except asyncio.CancelledError:
                raise
            except Exception:                                           # noqa: BLE001
                log.exception("alerting control loop error")
            await asyncio.sleep(SYNC_EVERY)

    # ------------------------------------------------------------------ status
    def status(self) -> dict[str, Any]:
        self.ensure_loaded()
        if time.time() - self._health_at > HEALTH_EVERY:
            self.refresh_health()
        cfg = GrafanaConfig.from_env()
        with self._lock:
            h = {k: dict(v) for k, v in self._health.items()}
            rt = {k: dict(v) for k, v in self.runtime.items()}
        rules = self.store.all("rule")
        states = [self._rule_state(r, rt.get(r["id"], {})) for r in rules]
        return {
            "mode": self.mode,
            "grafana": h.get("grafana") or {"url": cfg.url, "public_url": cfg.public_url, "reachable": False},
            "loki": h.get("loki") or {"url": None, "reachable": False},
            "prometheus": h.get("prometheus") or {"url": None, "reachable": False},
            "receiver_url": cfg.receiver_url,
            "last_sync_at": self.last_sync_at, "last_sync_error": self.last_sync_error,
            "counts": {"rules": len(rules), "firing": states.count("firing"),
                       "pending": states.count("pending"),
                       "contact_points": len(self.store.all("contact_point"))},
        }

    def force_sync(self) -> dict[str, Any]:
        self.ensure_loaded()
        self.refresh_health()
        self.sync_all()
        return self.status()

    # ------------------------------------------------------------------ rules
    @staticmethod
    def _rule_state(rule: dict[str, Any], rt: dict[str, Any]) -> str:
        return "paused" if not rule.get("enabled", True) else rt.get("state") or "normal"

    def rule_view(self, rule: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            rt = dict(self.runtime.get(rule["id"], {}))
        v = {k: rule.get(k) for k in RULE_FIELDS}
        v["sync"] = rule.get("sync") or {"state": "local"}
        v["state"] = self._rule_state(rule, rt)
        v["last_value"] = _finite(rt.get("last_value"))
        v["last_eval"] = rt.get("last_eval")
        if rt.get("last_error") and v["state"] == "error":
            v["last_error"] = rt["last_error"]
        return v

    def list_rules(self) -> list[dict[str, Any]]:
        self.ensure_loaded()
        rules = sorted(self.store.all("rule"), key=lambda r: (r.get("created_at") or "", r["name"]))
        return [self.rule_view(r) for r in rules]

    def _rule(self, rid: str) -> dict[str, Any]:
        self.ensure_loaded()
        r = self.store.get("rule", rid)
        if r is None:
            raise NotFound(f"no alert rule {rid}")
        return r

    def get_rule(self, rid: str) -> dict[str, Any]:
        return self.rule_view(self._rule(rid))

    def _unique(self, kind: str, name: str, oid: str | None) -> None:
        for d in self.store.all(kind):
            if d["name"].casefold() == name.casefold() and d["id"] != oid:
                raise Conflict(f"name {name!r} is already used")

    def save_rule(self, body: RuleIn, rid: str | None = None) -> dict[str, Any]:
        self.ensure_loaded()
        prev = self._rule(rid) if rid else None
        self._unique("rule", body.name, rid)
        doc = {**body.doc(), "id": rid or new_id(), "sync": self._unsynced(GrafanaConfig.from_env())}
        if prev:
            doc["created_at"] = prev["created_at"]
        doc = self.store.put("rule", doc)
        with self._lock:
            self._next_eval[doc["id"]] = 0.0                # evaluate the new definition soon
            if prev and not doc["enabled"]:
                self.runtime.pop(doc["id"], None)
                self._outbox.pop(doc["id"], None)
        moved = prev["group"] if prev and prev["group"] != doc["group"] else None
        self._push_rule(doc, moved)
        if moved:
            self._regroup(moved)
        return self.get_rule(doc["id"])

    def _regroup(self, group: str) -> None:
        # The group a rule left may now allow a longer interval.
        if any(r["group"] == group for r in self.store.all("rule")) and self.mode == "grafana":
            client = self._grafana()
            try:
                if client:
                    with self._sync_lock:
                        client.set_group_interval(group, self._group_interval(group))
            except GrafanaError as exc:
                log.warning("grafana group interval update failed: %s", exc)

    def delete_rule(self, rid: str) -> None:
        rule = self._rule(rid)
        self.store.delete("rule", rid)
        with self._lock:
            self.runtime.pop(rid, None)
            self._outbox.pop(rid, None)
            self._next_eval.pop(rid, None)
        self._delete_remote("rule", rid)
        self._regroup(rule["group"])

    def preview(self, datasource: str, query: str, reducer: str, condition: dict[str, Any]) -> dict[str, Any]:
        if datasource == "clickhouse":
            try:
                query = check_select(query)
            except ValueError as exc:
                return {"value": None, "firing": False, "error": str(exc), "series": 0}
        res = evaluator.evaluate(datasource, query, reducer, condition)
        out = {"value": _finite(res["value"]), "firing": res["firing"], "series": res["series"]}
        if res.get("error"):
            out["error"] = res["error"]
        return out

    # ------------------------------------------------------------------ contact points
    def _secrets(self, cp: dict[str, Any]) -> dict[str, str]:
        out = {}
        for k, blob in (cp.get("secrets") or {}).items():
            try:
                out[k] = open_sealed(blob, self._secret)
            except Exception as exc:                                # noqa: BLE001
                log.error("cannot open sealed secret %s of contact point %s (%s)",
                          k, cp.get("id"), type(exc).__name__)
        return out

    @staticmethod
    def cp_view(cp: dict[str, Any]) -> dict[str, Any]:
        return {"id": cp["id"], "name": cp["name"], "type": cp["type"],
                "settings": dict(cp.get("settings") or {}),
                "secure_fields": sorted((cp.get("secrets") or {}).keys()),
                "disable_resolve_message": bool(cp.get("disable_resolve_message")),
                "builtin": bool(cp.get("builtin")), "created_at": cp.get("created_at"),
                "updated_at": cp.get("updated_at"), "sync": cp.get("sync") or {"state": "local"}}

    def list_contact_points(self) -> list[dict[str, Any]]:
        self.ensure_loaded()
        cps = sorted(self.store.all("contact_point"),
                     key=lambda c: (not c.get("builtin"), c.get("created_at") or "", c["name"]))
        return [self.cp_view(c) for c in cps]

    def _cp(self, cid: str) -> dict[str, Any]:
        self.ensure_loaded()
        c = self.store.get("contact_point", cid)
        if c is None:
            raise NotFound(f"no contact point {cid}")
        return c

    def get_contact_point(self, cid: str) -> dict[str, Any]:
        return self.cp_view(self._cp(cid))

    def save_contact_point(self, body: ContactPointIn, cid: str | None = None) -> dict[str, Any]:
        self.ensure_loaded()
        prev = self._cp(cid) if cid else None
        if prev and prev.get("builtin") and body.type != prev["type"]:
            raise ValidationFailed("the builtin Browser contact point cannot change type")
        self._unique("contact_point", body.name, cid)
        settings = clean_cp_settings(body.type, body.settings)
        # Omitted secret keeps the stored value, "" clears it (§13.2); a type change starts over.
        plain = self._secrets(prev) if prev and prev["type"] == body.type else {}
        for k in SECRET_KEYS.get(body.type, ()):
            if k in body.settings:
                v = body.settings[k]
                if v in (None, ""):
                    plain.pop(k, None)
                else:
                    plain[k] = str(v).strip()
        check_cp(body.type, settings, plain)
        try:
            sealed = {k: seal(v, self._secret) for k, v in plain.items()}
        except SecretUnavailable as exc:
            raise ValidationFailed("cannot store a secret: ALETHEIA_SECRET is not set") from exc
        doc = {"id": cid or new_id(), "name": body.name, "type": body.type, "settings": settings,
               "secrets": sealed, "disable_resolve_message": body.disable_resolve_message,
               "builtin": bool(prev and prev.get("builtin")),
               "sync": self._unsynced(GrafanaConfig.from_env())}
        doc = self.store.put("contact_point", doc)
        self._push_cp(doc)
        if prev and prev["name"] != doc["name"]:
            self._push_policy()                          # Grafana routes refer to receivers by name
        return self.get_contact_point(doc["id"])

    def delete_contact_point(self, cid: str) -> None:
        cp = self._cp(cid)
        if cp.get("builtin"):
            raise Conflict("the builtin Browser contact point cannot be deleted")
        if cid in receivers_in(self.store.get("policy", POLICY_ID) or {}):
            raise Conflict("contact point is used by the notification policy tree")
        self.store.delete("contact_point", cid)
        self._delete_remote("contact_point", cid)

    def test_contact_point(self, cid: str) -> dict[str, Any]:
        cp = self._cp(cid)
        if cp["type"] == "browser":
            self.feed.add(status="firing", source="test", rule_id=None, rule_name="Test notification",
                          severity="info", summary="Test notification from Aletheia",
                          description="The browser contact point is wired up correctly.",
                          labels={"alertname": "TestAlert"}, value=None, contact_point_id=cp["id"],
                          contact_point_name=cp["name"], starts_at=now_iso(), ends_at=None, link=None)
            return {"ok": True, "detail": "test notification added to the browser feed"}
        client = self._grafana() if self.mode == "grafana" else None
        if client is not None:
            try:
                ok, detail = client.test_receiver(self._cp_payload(cp))
                return {"ok": ok, "detail": detail}
            except GrafanaError as exc:
                return {"ok": False, "detail": str(exc)[:500]}
        if cp["type"] == "webhook":
            payload = self._am_payload(cp, "firing", [self._am_alert(
                "firing", {"alertname": "TestAlert", "severity": "info"},
                {"summary": "Test notification from Aletheia"}, None, now_iso(), None)])
            err = self._post_webhook(cp, payload)
            return {"ok": err is None, "detail": err or f"POST {cp['settings']['url']} succeeded"}
        return {"ok": False, "detail": "needs Grafana"}

    # ------------------------------------------------------------------ policy
    def get_policy(self) -> dict[str, Any]:
        self.ensure_loaded()
        pol = self.store.get("policy", POLICY_ID) or {}
        body = {k: pol[k] for k in ("receiver", "group_by", "group_wait", "group_interval",
                                    "repeat_interval", "routes") if k in pol}
        return {"policy": body, "sync": pol.get("sync") or {"state": "local"}}

    def put_policy(self, body: PolicyIn) -> dict[str, Any]:
        self.ensure_loaded()
        doc = policy_doc(body)
        known = {c["id"] for c in self.store.all("contact_point")}
        unknown = sorted(receivers_in(doc) - known)
        if unknown:
            raise ValidationFailed(f"unknown receiver contact point id(s): {', '.join(unknown)}")
        doc["id"] = POLICY_ID
        doc["sync"] = self._unsynced(GrafanaConfig.from_env())
        self.store.put("policy", doc)
        self._push_policy()
        return self.get_policy()

    # ------------------------------------------------------------------ Grafana webhook receiver
    def receive(self, cid: str | None, payload: dict[str, Any]) -> int:
        self.ensure_loaded()
        cp = self.store.get("contact_point", cid or BROWSER_ID)
        if cp is None:
            log.warning("alert webhook for unknown contact point %r dropped", cid)
            return 0
        cfg = GrafanaConfig.from_env()
        n = 0
        for a in payload.get("alerts") or []:
            labels = {str(k): str(v) for k, v in (a.get("labels") or {}).items()}
            ann = a.get("annotations") or {}
            values = a.get("values") or {}
            value = next((_finite(values[k]) for k in ("B", "C", "A") if _finite(values.get(k)) is not None),
                         None)
            if value is None:
                value = parse_value_string(a.get("valueString"))
            link = a.get("generatorURL") or None
            if link and cfg.url:
                link = cfg.public_link(link)
            ends = a.get("endsAt")
            self.feed.add(status="resolved" if a.get("status") == "resolved" else "firing",
                          source="grafana", rule_id=labels.get("aletheia_rule_id"),
                          rule_name=labels.get("alertname", ""), severity=labels.get("severity", ""),
                          summary=ann.get("summary", ""), description=ann.get("description", ""),
                          labels=labels, value=_finite(value), contact_point_id=cp["id"],
                          contact_point_name=cp["name"], starts_at=a.get("startsAt") or None,
                          ends_at=None if not ends or str(ends).startswith("0001-") else ends,
                          link=link)
            n += 1
        return n

    # ------------------------------------------------------------------ local evaluation
    def _alert_labels(self, rule: dict[str, Any]) -> dict[str, str]:
        return {**rule.get("labels", {}), "alertname": rule["name"], "grafana_folder": "Aletheia",
                "severity": rule["severity"], "aletheia_rule_id": rule["id"]}

    def evaluate_rule(self, rid: str, res: dict[str, Any] | None = None,
                      now: float | None = None) -> str | None:
        """Evaluate one rule (or apply a given result, for tests) and queue notifications."""
        rule = self.store.get("rule", rid)
        if rule is None or not rule.get("enabled", True):
            return None
        if res is None:
            res = evaluator.evaluate(rule["datasource"], rule["query"], rule["reducer"], rule["condition"])
        now = time.time() if now is None else now
        with self._lock:
            rt = self.runtime.setdefault(rid, {})
            transition = evaluator.step(rt, rule, res, now)
            if transition == "firing":
                self._outbox[rid] = {}
                for m in route(self.store.get("policy", POLICY_ID) or {}, self._alert_labels(rule)):
                    self._outbox[rid].setdefault(m.receiver, {
                        "due": now + parse_duration(m.group_wait), "sent": None,
                        "repeat": parse_duration(m.repeat_interval), "starts_at": now_iso()})
                resolved: dict[str, dict[str, Any]] = {}
            elif transition == "resolved":
                resolved = self._outbox.pop(rid, {})
            else:
                resolved = {}
            value = rt.get("last_value")
        for rcv, e in resolved.items():
            if e["sent"] is not None:                    # never resolve what was never announced
                self._deliver(rcv, rule, "resolved", value, e["starts_at"], now_iso())
        return transition

    def flush_outbox(self, now: float | None = None) -> int:
        """Deliver due firing notifications (after group_wait) and repeats (repeat_interval)."""
        now = time.time() if now is None else now
        todo = []
        with self._lock:
            for rid, box in self._outbox.items():
                if not self.runtime.get(rid, {}).get("active"):
                    continue
                for rcv, e in box.items():
                    if (e["sent"] is None and now >= e["due"]) or \
                            (e["sent"] is not None and now - e["sent"] >= e["repeat"]):
                        e["sent"] = now
                        todo.append((rid, rcv, e["starts_at"], self.runtime[rid].get("last_value")))
        for rid, rcv, starts, value in todo:
            rule = self.store.get("rule", rid)
            if rule:
                self._deliver(rcv, rule, "firing", value, starts, None)
        return len(todo)

    def _due(self, now: float) -> list[str]:
        out = []
        with self._lock:
            for r in self.store.all("rule"):
                if not r.get("enabled", True):
                    continue
                if now >= self._next_eval.get(r["id"], 0.0):
                    self._next_eval[r["id"]] = now + parse_duration(r["interval"])
                    out.append(r["id"])
        return out

    async def _eval_loop(self) -> None:
        while True:
            await asyncio.sleep(EVAL_TICK)
            try:
                if self.mode != "local":
                    continue
                due = self._due(time.time())
                if due:
                    await asyncio.gather(*(asyncio.to_thread(self.evaluate_rule, rid) for rid in due))
                if self._outbox:
                    await asyncio.to_thread(self.flush_outbox)
            except asyncio.CancelledError:
                raise
            except Exception:                                           # noqa: BLE001
                log.exception("alerting evaluator error")

    # ------------------------------------------------------------------ delivery
    @staticmethod
    def _am_alert(status: str, labels: dict[str, str], ann: dict[str, str], value: float | None,
                  starts: str | None, ends: str | None) -> dict[str, Any]:
        fp = hashlib.sha256(repr(sorted(labels.items())).encode()).hexdigest()[:16]
        return {"status": status, "labels": labels, "annotations": ann, "startsAt": starts,
                "endsAt": ends or "0001-01-01T00:00:00Z", "generatorURL": "", "fingerprint": fp,
                "values": {"B": value} if value is not None else {},
                "valueString": f"[ var='B' labels={{}} value={value:g} ]" if value is not None else ""}

    @staticmethod
    def _am_payload(cp: dict[str, Any], status: str, alerts: list[dict[str, Any]]) -> dict[str, Any]:
        labels = alerts[0]["labels"] if alerts else {}
        return {"receiver": cp["name"], "status": status, "alerts": alerts,
                "groupLabels": {"alertname": labels.get("alertname", "")},
                "commonLabels": labels, "commonAnnotations": alerts[0]["annotations"] if alerts else {},
                "externalURL": "", "version": "1", "groupKey": f"aletheia:{labels.get('alertname', '')}",
                "truncatedAlerts": 0,
                "title": f"[{status.upper()}:{len(alerts)}] {labels.get('alertname', '')}",
                "state": "alerting" if status == "firing" else "ok",
                "message": (alerts[0]["annotations"].get("summary", "") if alerts else "")}

    def _post_webhook(self, cp: dict[str, Any], payload: dict[str, Any]) -> str | None:
        s = cp.get("settings") or {}
        try:
            r = httpx.request(s.get("http_method") or "POST", s["url"], json=payload, timeout=5.0)
            if r.status_code >= 400:
                return f"HTTP {r.status_code} {r.text.strip()[:200]}"
        except httpx.HTTPError as exc:
            return f"{type(exc).__name__}: {exc}"[:300]
        return None

    def _deliver(self, receiver: str, rule: dict[str, Any], status: str, value: float | None,
                 starts: str | None, ends: str | None) -> None:
        cp = self.store.get("contact_point", receiver)
        if cp is None:
            log.warning("alert %s routed to missing contact point %s", rule["name"], receiver)
            return
        if status == "resolved" and cp.get("disable_resolve_message"):
            return
        labels = self._alert_labels(rule)
        summary = evaluator.render(rule.get("summary", ""), labels, value)
        description = evaluator.render(rule.get("description", ""), labels, value)
        if cp["type"] == "browser":
            self.feed.add(status=status, source="local", rule_id=rule["id"], rule_name=rule["name"],
                          severity=rule["severity"], summary=summary, description=description,
                          labels=labels, value=_finite(value), contact_point_id=cp["id"],
                          contact_point_name=cp["name"], starts_at=starts, ends_at=ends, link=None)
        elif cp["type"] == "webhook":
            alert = self._am_alert(status, labels, {"summary": summary, "description": description},
                                   _finite(value), starts, ends)
            err = self._post_webhook(cp, self._am_payload(cp, status, [alert]))
            if err:
                log.warning("webhook %s delivery failed: %s", cp["name"], err)
        else:
            log.warning("alert %s for %s contact point %r not sent: %s delivery needs Grafana",
                        rule["name"], cp["type"], cp["name"], cp["type"])
