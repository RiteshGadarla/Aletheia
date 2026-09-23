"""Request models and validation for alert rules, contact points and the policy tree (§13.2).

Server-owned fields (id, sync, state, ...) are ignored on input rather than rejected, so a client
may PUT back an object it just read.
"""
from __future__ import annotations

import re
import secrets
import warnings
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Datasource = Literal["loki", "prometheus", "clickhouse"]
Reducer = Literal["last", "mean", "max", "min", "sum", "count"]
Op = Literal["gt", "gte", "lt", "lte", "eq", "ne"]
Severity = Literal["critical", "warning", "info"]
NoData = Literal["OK", "NoData", "Alerting"]
CPType = Literal["browser", "webhook", "email", "slack"]
MatchOp = Literal["=", "!=", "=~", "!~"]

# Contact-point settings that are sealed at rest and never returned (only `secure_fields`).
SECRET_KEYS: dict[str, tuple[str, ...]] = {"slack": ("url", "token")}

# Labels Studio sets itself; a user value would break routing or the Grafana state lookup.
RESERVED_LABELS = {"aletheia_rule_id", "alertname", "grafana_folder"}

# FastAPI 0.115 re-wraps body fields in a TypeAdapter, where pydantic 2.13 warns that the
# `for` / `continue` aliases "have no effect". They do: the model itself validates the body.
warnings.filterwarnings("ignore", message=r"The 'alias' attribute with value '(for|continue)'")

_LABEL = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_DUR = re.compile(r"(\d+(?:\.\d+)?)(ms|s|m|h|d|w)")
_UNIT = {"ms": 0.001, "s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}
_SQL_STRING = re.compile(r"'(?:[^'\\]|\\.|'')*'")


class ValidationFailed(ValueError):
    """A semantic check failed; the API maps it to 400."""


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def new_id() -> str:
    # Grafana uids allow [A-Za-z0-9-_] up to 40 chars.
    return secrets.token_hex(7)


def parse_duration(text: str) -> float:
    """Go / Prometheus duration ("0s", "1m30s", "500ms") -> seconds. Raises ValueError."""
    s = str(text or "").strip()
    if s == "0":
        return 0.0
    if not s or _DUR.sub("", s):
        raise ValueError(f"invalid duration {text!r} (use e.g. 30s, 5m, 1h)")
    return sum(float(n) * _UNIT[u] for n, u in _DUR.findall(s))


def _duration(v: str, *, minimum: float = 0.0, step: float = 0.0) -> str:
    secs = parse_duration(v)
    if secs < minimum:
        raise ValueError(f"duration {v!r} is below the minimum of {minimum:g}s")
    if step and secs % step:
        raise ValueError(f"duration {v!r} must be a multiple of {step:g}s")
    return str(v).strip()


def check_labels(labels: dict[str, str]) -> dict[str, str]:
    for k in labels:
        if not _LABEL.match(k):
            raise ValueError(f"invalid label name {k!r}")
        if k in RESERVED_LABELS:
            raise ValueError(f"label {k!r} is reserved")
    return {k: str(v) for k, v in labels.items()}


def check_select(sql: str) -> str:
    """ClickHouse rule queries must be one SELECT; the evaluator also runs them readonly=1."""
    q = sql.strip().rstrip(";").strip()
    bare = _SQL_STRING.sub("''", q)
    if not re.match(r"(?is)\s*(select|with)\b", bare):
        raise ValueError("ClickHouse rule queries must be a single SELECT")
    if ";" in bare:
        raise ValueError("ClickHouse rule queries must be a single statement")
    return q


class _In(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class Condition(_In):
    op: Op
    threshold: float


class RuleIn(_In):
    name: str = Field(min_length=1, max_length=190)
    group: str = "aletheia"
    datasource: Datasource
    query: str = Field(min_length=1)
    reducer: Reducer = "last"
    condition: Condition
    for_: str = Field("0s", alias="for")
    interval: str = "1m"
    severity: Severity = "warning"
    labels: dict[str, str] = Field(default_factory=dict)
    summary: str = ""
    description: str = ""
    enabled: bool = True
    no_data_state: NoData = "OK"

    @field_validator("name", "group")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be empty")
        return v

    @field_validator("group")
    @classmethod
    def _group(cls, v: str) -> str:
        # The group name is a path segment of Grafana's rule-group API.
        if "/" in v or "\\" in v or len(v) > 190:
            raise ValueError("group must not contain '/' or '\\'")
        return v

    @field_validator("for_")
    @classmethod
    def _for(cls, v: str) -> str:
        return _duration(v)

    @field_validator("interval")
    @classmethod
    def _interval(cls, v: str) -> str:
        # Grafana's scheduler ticks every 10s; intervals must be multiples of it.
        return _duration(v, minimum=10, step=10)

    @field_validator("labels")
    @classmethod
    def _labels(cls, v: dict[str, str]) -> dict[str, str]:
        v = check_labels(v)
        v.pop("severity", None)          # the `severity` field is the one source of truth
        return v

    @model_validator(mode="after")
    def _query(self) -> "RuleIn":
        self.query = self.query.strip()
        if self.datasource == "clickhouse":
            self.query = check_select(self.query)
        return self

    def doc(self) -> dict[str, Any]:
        d = self.model_dump(by_alias=True)
        d["condition"] = self.condition.model_dump()
        return d


class PreviewIn(_In):
    datasource: Datasource
    query: str = Field(min_length=1)
    reducer: Reducer = "last"
    condition: Condition


class ContactPointIn(_In):
    name: str = Field(min_length=1, max_length=190)
    type: CPType
    settings: dict[str, Any] = Field(default_factory=dict)
    disable_resolve_message: bool = False

    @field_validator("name")
    @classmethod
    def _strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("must not be empty")
        return v


def clean_cp_settings(cp_type: str, settings: dict[str, Any]) -> dict[str, Any]:
    """Keep the known non-secret keys for a type and normalise them."""
    s = settings or {}
    if cp_type == "webhook":
        out: dict[str, Any] = {"url": str(s.get("url") or "").strip()}
        method = str(s.get("http_method") or "POST").upper()
        if method not in ("POST", "PUT"):
            raise ValidationFailed("webhook http_method must be POST or PUT")
        out["http_method"] = method
        return out
    if cp_type == "email":
        return {"addresses": str(s.get("addresses") or "").strip(),
                "single_email": bool(s.get("single_email", False))}
    if cp_type == "slack":
        return {"recipient": str(s.get("recipient") or "").strip()}
    return {}


def check_cp(cp_type: str, settings: dict[str, Any], secrets_: dict[str, str]) -> None:
    """Validate the merged view (plain settings + effective secrets)."""
    if cp_type == "webhook":
        if not re.match(r"^https?://\S+$", settings.get("url", "")):
            raise ValidationFailed("webhook url must be an http(s) URL")
    elif cp_type == "email":
        addrs = [a for a in re.split(r"[;,\n]", settings.get("addresses", "")) if a.strip()]
        if not addrs or any("@" not in a for a in addrs):
            raise ValidationFailed("email addresses must be one or more addresses, ';' or ',' separated")
    elif cp_type == "slack":
        if secrets_.get("url"):
            if not re.match(r"^https?://\S+$", secrets_["url"]):
                raise ValidationFailed("slack url must be an http(s) webhook URL")
        elif not (secrets_.get("token") and settings.get("recipient")):
            raise ValidationFailed("slack needs a webhook url, or a token and a recipient")


class MatcherIn(_In):
    label: str
    op: MatchOp = "="
    value: str = ""

    @model_validator(mode="after")
    def _check(self) -> "MatcherIn":
        if not _LABEL.match(self.label):
            raise ValueError(f"invalid label name {self.label!r}")
        if self.op in ("=~", "!~"):
            try:
                re.compile(self.value)
            except re.error as exc:
                raise ValueError(f"invalid regex {self.value!r}: {exc}") from exc
        return self


class _Timing(_In):
    @field_validator("group_wait", "group_interval", "repeat_interval", check_fields=False)
    @classmethod
    def _dur(cls, v: str | None) -> str | None:
        return None if v in (None, "") else _duration(v)


class RouteIn(_Timing):
    id: str = ""
    receiver: str = ""                   # "" inherits the parent's receiver (Alertmanager)
    matchers: list[MatcherIn] = Field(default_factory=list)
    continue_: bool = Field(False, alias="continue")
    group_by: list[str] | None = None
    group_wait: str | None = None
    group_interval: str | None = None
    repeat_interval: str | None = None
    routes: list["RouteIn"] = Field(default_factory=list)


class PolicyIn(_Timing):
    receiver: str = Field(min_length=1)
    group_by: list[str] = Field(default_factory=lambda: ["alertname"])
    group_wait: str = "30s"
    group_interval: str = "5m"
    repeat_interval: str = "4h"
    routes: list[RouteIn] = Field(default_factory=list)


def route_doc(r: RouteIn) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": r.id or new_id(), "receiver": r.receiver,
        "matchers": [m.model_dump() for m in r.matchers], "continue": r.continue_,
        "routes": [route_doc(c) for c in r.routes],
    }
    for k in ("group_by", "group_wait", "group_interval", "repeat_interval"):
        if getattr(r, k) is not None:
            d[k] = getattr(r, k)
    return d


def policy_doc(p: PolicyIn) -> dict[str, Any]:
    return {"receiver": p.receiver, "group_by": list(p.group_by), "group_wait": p.group_wait or "30s",
            "group_interval": p.group_interval or "5m", "repeat_interval": p.repeat_interval or "4h",
            "routes": [route_doc(r) for r in p.routes]}


def receivers_in(policy: dict[str, Any]) -> set[str]:
    """Every contact-point id the tree references (empty = inherit, skipped)."""
    out = {policy["receiver"]} if policy.get("receiver") else set()
    for r in policy.get("routes", []):
        out |= receivers_in(r)
    return out
