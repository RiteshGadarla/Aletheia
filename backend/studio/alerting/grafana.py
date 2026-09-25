"""Grafana HTTP client and the pure translation of Studio objects to provisioning payloads.

Every write carries `X-Disable-Provenance: true` so the objects stay editable in Grafana's UI;
Studio's reconcile loop overwrites drift anyway.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx

from .models import parse_duration

FOLDER_UID = "aletheia"
FOLDER_TITLE = "Aletheia"
DATASOURCE_UIDS = {"loki": "aletheia-loki", "prometheus": "aletheia-prometheus",
                   "clickhouse": "aletheia-clickhouse"}
RECEIVE_PATH = "/api/v1/alerting/receive"


# --------------------------------------------------------------------------- config
@dataclass(frozen=True)
class GrafanaConfig:
    url: str | None
    public_url: str
    token: str | None
    user: str
    password: str
    receiver_url: str

    @classmethod
    def from_env(cls) -> "GrafanaConfig":
        url = (os.environ.get("ALETHEIA_GRAFANA_URL") or "").strip().rstrip("/") or None
        public = (os.environ.get("ALETHEIA_GRAFANA_PUBLIC_URL") or "").strip().rstrip("/")
        return cls(
            url=url,
            public_url=public or url or "http://localhost:3000",
            token=(os.environ.get("ALETHEIA_GRAFANA_TOKEN") or "").strip() or None,
            user=os.environ.get("ALETHEIA_GRAFANA_USER") or "admin",
            password=os.environ.get("ALETHEIA_GRAFANA_PASSWORD") or "aletheia",
            receiver_url=((os.environ.get("ALETHEIA_ALERT_RECEIVER_URL") or "").strip().rstrip("/")
                          or "http://host.docker.internal:8081"),
        )

    def public_link(self, link: str) -> str:
        """Re-root a URL Grafana rendered onto public_url. Matches on the sub-path, not the host:
        Grafana builds links from its root_url, which is the browser origin, never `url`."""
        sub = urlsplit(self.url or "").path.rstrip("/")
        u = urlsplit(link)
        if not u.path.startswith(sub + "/"):
            return link
        return (self.public_url + u.path[len(sub):] + (f"?{u.query}" if u.query else "")
                + (f"#{u.fragment}" if u.fragment else ""))


# --------------------------------------------------------------------------- translation
def _num(x: float) -> str:
    return f"{x:.17g}"


def query_model(datasource: str, query: str) -> dict[str, Any]:
    if datasource == "loki":
        return {"refId": "A", "expr": query, "queryType": "instant", "instant": True,
                "intervalMs": 1000, "maxDataPoints": 43200}
    if datasource == "prometheus":
        return {"refId": "A", "expr": query, "instant": True, "range": False,
                "intervalMs": 1000, "maxDataPoints": 43200}
    return {"refId": "A", "rawSql": query, "format": 1, "queryType": "sql", "editorType": "sql",
            "intervalMs": 1000, "maxDataPoints": 43200}


def condition_model(op: str, threshold: float) -> dict[str, Any]:
    # The threshold node only knows strict gt/lt; the rest become a math expression (1 = firing).
    if op in ("gt", "lt"):
        return {"refId": "C", "type": "threshold", "expression": "B",
                "conditions": [{"evaluator": {"type": op, "params": [threshold]}}]}
    sym = {"gte": ">=", "lte": "<=", "eq": "==", "ne": "!="}[op]
    return {"refId": "C", "type": "math", "expression": f"$B {sym} {_num(threshold)}"}


def rule_data(rule: dict[str, Any]) -> list[dict[str, Any]]:
    """The standard A (query) -> B (reduce) -> C (condition) pipeline."""
    window = max(600, int(parse_duration(rule.get("interval") or "1m")) * 2)
    expr = {"from": 0, "to": 0}
    return [
        {"refId": "A", "datasourceUid": DATASOURCE_UIDS[rule["datasource"]],
         "relativeTimeRange": {"from": window, "to": 0},
         "model": query_model(rule["datasource"], rule["query"])},
        {"refId": "B", "datasourceUid": "__expr__", "relativeTimeRange": expr,
         "model": {"refId": "B", "type": "reduce", "expression": "A",
                   "reducer": rule.get("reducer") or "last", "settings": {"mode": "dropNN"}}},
        {"refId": "C", "datasourceUid": "__expr__", "relativeTimeRange": expr,
         "model": condition_model(rule["condition"]["op"], float(rule["condition"]["threshold"]))},
    ]


def rule_to_grafana(rule: dict[str, Any], folder_uid: str = FOLDER_UID) -> dict[str, Any]:
    labels = {**rule.get("labels", {}), "severity": rule["severity"], "aletheia_rule_id": rule["id"]}
    return {
        "uid": rule["id"], "orgID": 1, "folderUID": folder_uid, "ruleGroup": rule["group"],
        "title": rule["name"], "condition": "C", "data": rule_data(rule),
        "noDataState": rule.get("no_data_state") or "OK", "execErrState": "Error",
        "for": rule.get("for") or "0s", "isPaused": not rule.get("enabled", True),
        "labels": labels,
        "annotations": {"summary": rule.get("summary", ""), "description": rule.get("description", "")},
    }


def receiver_webhook_url(receiver_url: str, cp_id: str) -> str:
    return f"{receiver_url.rstrip('/')}{RECEIVE_PATH}?contact_point={cp_id}"


def contact_point_to_grafana(cp: dict[str, Any], secrets: dict[str, str],
                             receiver_url: str) -> dict[str, Any]:
    t, s = cp["type"], cp.get("settings", {})
    if t == "browser":
        gtype, gs = "webhook", {"url": receiver_webhook_url(receiver_url, cp["id"]), "httpMethod": "POST"}
    elif t == "webhook":
        gtype, gs = "webhook", {"url": s["url"], "httpMethod": s.get("http_method") or "POST"}
    elif t == "email":
        gtype, gs = "email", {"addresses": s["addresses"], "singleEmail": bool(s.get("single_email"))}
    else:
        gtype = "slack"
        gs = ({"url": secrets["url"]} if secrets.get("url")
              else {"token": secrets.get("token", ""), "recipient": s.get("recipient", "")})
        if secrets.get("url") and s.get("recipient"):
            gs["recipient"] = s["recipient"]
    return {"uid": cp["id"], "name": cp["name"], "type": gtype, "settings": gs,
            "disableResolveMessage": bool(cp.get("disable_resolve_message"))}


def _route_to_grafana(r: dict[str, Any], names: dict[str, str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if r.get("receiver"):
        out["receiver"] = names[r["receiver"]]
    out["object_matchers"] = [[m["label"], m["op"], m["value"]] for m in r.get("matchers", [])]
    out["continue"] = bool(r.get("continue"))
    for k in ("group_by", "group_wait", "group_interval", "repeat_interval"):
        if r.get(k) not in (None, ""):
            out[k] = r[k]
    if r.get("routes"):
        out["routes"] = [_route_to_grafana(c, names) for c in r["routes"]]
    return out


def policy_to_grafana(policy: dict[str, Any], names: dict[str, str]) -> dict[str, Any]:
    """`names` maps contact-point id -> name (Grafana routes refer to receivers by name)."""
    return {
        "receiver": names[policy["receiver"]],
        "group_by": list(policy.get("group_by") or ["alertname"]),
        "group_wait": policy.get("group_wait") or "30s",
        "group_interval": policy.get("group_interval") or "5m",
        "repeat_interval": policy.get("repeat_interval") or "4h",
        "routes": [_route_to_grafana(r, names) for r in policy.get("routes", [])],
    }


_STATE = {"firing": "firing", "pending": "pending", "inactive": "normal", "normal": "normal",
          "recovering": "firing"}
_VALUE = re.compile(r"var='(\w+)'[^\]]*?value=([-+0-9.eE]+|NaN)")


def parse_value_string(s: str | None, prefer: str = "B") -> float | None:
    """`[ var='B' labels={} value=5 ], ...` -> 5.0 (Grafana's valueString / alert value)."""
    found = {k: v for k, v in _VALUE.findall(s or "") if v != "NaN"}
    pick = found.get(prefer) or found.get("A") or next(iter(found.values()), None)
    try:
        return float(pick) if pick is not None else None
    except ValueError:
        return None


def runtime_from_prometheus(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Grafana's Prometheus-compatible rules API -> {rule_id: {state, last_eval, last_value, ...}}."""
    out: dict[str, dict[str, Any]] = {}
    for g in (body.get("data") or {}).get("groups") or []:
        for r in g.get("rules") or []:
            rid = (r.get("labels") or {}).get("aletheia_rule_id") or r.get("uid")
            if not rid:
                continue
            health = r.get("health") or ""
            state = _STATE.get(str(r.get("state") or "").lower(), "normal")
            if health == "error":
                state = "error"
            elif health == "nodata" and state == "normal":
                state = "nodata"
            value = None
            for a in r.get("alerts") or []:
                value = parse_value_string(a.get("value"))
                if value is not None:
                    break
            last = r.get("lastEvaluation")
            out[rid] = {"state": state,
                        "last_eval": None if not last or last.startswith("0001-") else last,
                        "last_value": value, "last_error": r.get("lastError") or None}
    return out


# --------------------------------------------------------------------------- client
class GrafanaError(RuntimeError):
    pass


class GrafanaClient:
    def __init__(self, cfg: GrafanaConfig, transport: httpx.BaseTransport | None = None,
                 timeout: float = 5.0) -> None:
        if not cfg.url:
            raise GrafanaError("ALETHEIA_GRAFANA_URL is not set")
        auth = None if cfg.token else (cfg.user, cfg.password)
        headers = {"X-Disable-Provenance": "true", "Accept": "application/json"}
        if cfg.token:
            headers["Authorization"] = f"Bearer {cfg.token}"
        self.cfg = cfg
        self.folder_uid = FOLDER_UID
        self._c = httpx.Client(base_url=cfg.url, auth=auth, headers=headers, timeout=timeout,
                               transport=transport)

    def close(self) -> None:
        self._c.close()

    def _call(self, method: str, path: str, ok: tuple[int, ...] = (200, 201, 202, 204),
              **kw: Any) -> httpx.Response:
        try:
            r = self._c.request(method, path, **kw)
        except httpx.HTTPError as exc:
            raise GrafanaError(f"{method} {path}: {type(exc).__name__}: {exc}") from exc
        if r.status_code not in ok:
            detail = r.text.strip().replace("\n", " ")[:300]
            raise GrafanaError(f"{method} {path}: HTTP {r.status_code} {detail}")
        return r

    # -- health
    def health(self) -> dict[str, Any]:
        return self._call("GET", "/api/health", timeout=2.0).json()

    # -- folder
    def ensure_folder(self) -> str:
        """Dashboard provisioning may already own an "Aletheia" folder with a random uid; reuse it."""
        r = self._call("GET", f"/api/folders/{FOLDER_UID}", ok=(200, 404))
        if r.status_code == 404:
            same = [f for f in self._call("GET", "/api/folders").json() or []
                    if f.get("title") == FOLDER_TITLE]
            if same:
                self.folder_uid = same[0]["uid"]
                return self.folder_uid
            self._call("POST", "/api/folders", ok=(200, 201),
                       json={"uid": FOLDER_UID, "title": FOLDER_TITLE})
        self.folder_uid = FOLDER_UID
        return self.folder_uid

    # -- rules
    def upsert_rule(self, payload: dict[str, Any]) -> None:
        uid = payload["uid"]
        r = self._call("GET", f"/api/v1/provisioning/alert-rules/{uid}", ok=(200, 404))
        if r.status_code == 200:
            self._call("PUT", f"/api/v1/provisioning/alert-rules/{uid}", json=payload)
        else:
            self._call("POST", "/api/v1/provisioning/alert-rules", json=payload)

    def delete_rule(self, uid: str) -> None:
        self._call("DELETE", f"/api/v1/provisioning/alert-rules/{uid}", ok=(200, 202, 204, 404))

    def list_rules(self) -> list[dict[str, Any]]:
        return self._call("GET", "/api/v1/provisioning/alert-rules").json() or []

    def set_group_interval(self, group: str, seconds: int) -> None:
        """Rule-group PUT replaces the whole group, so read it and change only the interval."""
        path = f"/api/v1/provisioning/folder/{self.folder_uid}/rule-groups/{group}"
        r = self._call("GET", path, ok=(200, 404))
        if r.status_code == 404:
            return
        body = r.json()
        if int(body.get("interval") or 0) == seconds:
            return
        body["interval"] = seconds
        self._call("PUT", path, json=body)

    def rules_runtime(self) -> dict[str, dict[str, Any]]:
        return runtime_from_prometheus(self._call("GET", "/api/prometheus/grafana/api/v1/rules").json())

    # -- contact points
    def list_contact_points(self) -> list[dict[str, Any]]:
        return self._call("GET", "/api/v1/provisioning/contact-points").json() or []

    def upsert_contact_point(self, payload: dict[str, Any], exists: bool | None = None) -> None:
        if exists is None:
            exists = any(c.get("uid") == payload["uid"] for c in self.list_contact_points())
        if exists:
            self._call("PUT", f"/api/v1/provisioning/contact-points/{payload['uid']}", json=payload)
        else:
            self._call("POST", "/api/v1/provisioning/contact-points", json=payload)

    def delete_contact_point(self, uid: str) -> None:
        self._call("DELETE", f"/api/v1/provisioning/contact-points/{uid}", ok=(200, 202, 204, 404))

    # -- policy tree
    def put_policy(self, tree: dict[str, Any]) -> None:
        self._call("PUT", "/api/v1/provisioning/policies", json=tree)

    # -- receiver test
    def test_receiver(self, payload: dict[str, Any]) -> tuple[bool, str]:
        body = {"receivers": [{"name": payload["name"], "grafana_managed_receiver_configs": [{
            "uid": "", "name": payload["name"], "type": payload["type"],
            "settings": payload["settings"], "secureSettings": {},
            "disableResolveMessage": payload.get("disableResolveMessage", False)}]}]}
        r = self._call("POST", "/api/alertmanager/grafana/config/api/v1/receivers/test",
                       ok=(200, 207, 400, 408), json=body, timeout=35.0)
        try:
            cfgs = r.json()["receivers"][0]["grafana_managed_receiver_configs"]
            errors = [c.get("error") for c in cfgs if c.get("status") != "ok"]
        except (KeyError, IndexError, TypeError, ValueError):
            return r.status_code == 200, r.text.strip()[:300] or f"HTTP {r.status_code}"
        if errors:
            return False, "; ".join(str(e) for e in errors if e) or "delivery failed"
        return True, "test notification sent by Grafana"
