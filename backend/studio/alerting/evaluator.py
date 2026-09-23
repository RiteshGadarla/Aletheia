"""Local evaluator: datasource queries, reduce + condition, and the per-rule state machine.

Only used in `local` mode (Grafana evaluates in `grafana` mode) and by the rule preview. Unlike
Grafana, which keeps one alert instance per series, the local evaluator reduces across series.
"""
from __future__ import annotations

import math
import os
import re
import time
from typing import Any

import httpx

from .models import check_select, now_iso, parse_duration

MAX_CH_ROWS = 1000
_NUMERIC = re.compile(r"^(Nullable\()?(U?Int\d+|Float\d+|Decimal)")


class EvalError(RuntimeError):
    """The query could not be run or did not return numbers; shown as `last_error`."""


# --------------------------------------------------------------------------- pure logic
def reduce_values(values: list[float], reducer: str) -> float | None:
    vals = [v for v in values if v is not None and not math.isnan(v)]
    if reducer == "count":
        return float(len(vals)) if vals else None
    if not vals:
        return None
    if reducer == "last":
        return vals[-1]
    if reducer == "mean":
        return sum(vals) / len(vals)
    if reducer == "max":
        return max(vals)
    if reducer == "min":
        return min(vals)
    if reducer == "sum":
        return float(sum(vals))
    raise ValueError(f"unknown reducer {reducer!r}")


def compare(value: float | None, op: str, threshold: float) -> bool:
    if value is None:
        return False
    return {"gt": value > threshold, "gte": value >= threshold, "lt": value < threshold,
            "lte": value <= threshold, "eq": value == threshold, "ne": value != threshold}[op]


def render(text: str, labels: dict[str, str], value: float | None) -> str:
    """Coarse stand-in for Grafana templating: {{ $labels.x }}, {{ $value }}, {{ $values.B }}."""
    shown = "" if value is None else f"{value:g}"
    text = re.sub(r"\{\{\s*\$labels\.(\w+)\s*\}\}", lambda m: labels.get(m.group(1), ""), text or "")
    return re.sub(r"\{\{\s*\$values?(\.\w+)?(\.Value)?\s*\}\}", shown, text)


def step(rt: dict[str, Any], rule: dict[str, Any], res: dict[str, Any], now: float) -> str | None:
    """Advance one rule's runtime state; return "firing" / "resolved" on a notifying transition.

    `rt["active"]` is whether a firing notification is outstanding, kept apart from `state` so an
    error in the middle of a firing episode neither re-fires nor resolves it.
    """
    rt["last_eval"] = res.get("at")
    if res.get("error"):
        rt.update(state="error", last_error=res["error"])
        return None
    rt.pop("last_error", None)
    value = res.get("value")
    rt["last_value"] = value
    nodata = value is None
    cond = bool(res.get("firing"))
    if nodata:
        cond = rule.get("no_data_state") == "Alerting"
    if cond:
        if rt.get("active"):
            rt["state"] = "firing"
            return None
        hold = parse_duration(rule.get("for") or "0s")
        if rt.get("state") != "pending" or rt.get("pending_since") is None:
            rt.update(state="pending", pending_since=now)
        if now - rt["pending_since"] >= hold:
            rt.update(state="firing", active=True, fired_at=now, pending_since=None)
            return "firing"
        return None
    was = bool(rt.get("active"))
    rt.update(state="nodata" if nodata and rule.get("no_data_state") == "NoData" else "normal",
              active=False, pending_since=None)
    return "resolved" if was else None


# --------------------------------------------------------------------------- datasources
def _floats(xs: list[Any]) -> list[float]:
    out = []
    for x in xs:
        try:
            out.append(float(x))
        except (TypeError, ValueError):
            continue
    return out


def _prom_values(body: dict[str, Any], what: str) -> list[float]:
    if body.get("status") not in (None, "success"):
        raise EvalError(f"{what}: {body.get('error') or body.get('status')}")
    data = body.get("data") or {}
    kind, result = data.get("resultType"), data.get("result")
    if kind == "vector":
        return _floats([r["value"][1] for r in result or []])
    if kind == "scalar":
        return _floats([result[1]]) if result else []
    if kind == "matrix":
        return _floats([r["values"][-1][1] for r in result or [] if r.get("values")])
    if kind == "streams":
        raise EvalError(f"{what}: the query returns log lines; use a metric query, "
                        "e.g. sum(count_over_time({...}[5m]))")
    raise EvalError(f"{what}: unexpected result type {kind!r}")


def _get(url: str, path: str, params: dict[str, Any], headers: dict[str, str], what: str,
         timeout: float) -> dict[str, Any]:
    try:
        r = httpx.get(url.rstrip("/") + path, params=params, headers=headers, timeout=timeout)
    except httpx.HTTPError as exc:
        raise EvalError(f"{what} unreachable: {type(exc).__name__}") from exc
    if r.status_code >= 400:
        try:
            msg = r.json().get("error") or r.text
        except ValueError:
            msg = r.text
        raise EvalError(f"{what}: HTTP {r.status_code} {str(msg).strip()[:300]}")
    return r.json()


def query_loki(q: str, timeout: float = 10.0) -> list[float]:
    url = (os.environ.get("ALETHEIA_LOKI_URL") or "").strip()
    if not url:
        raise EvalError("ALETHEIA_LOKI_URL is not set")
    tenant = os.environ.get("ALETHEIA_LOKI_TENANT")
    body = _get(url, "/loki/api/v1/query", {"query": q, "time": time.time_ns()},
                {"X-Scope-OrgID": tenant} if tenant else {}, "Loki", timeout)
    return _prom_values(body, "Loki")


def query_prometheus(q: str, timeout: float = 10.0) -> list[float]:
    url = (os.environ.get("ALETHEIA_PROMETHEUS_URL") or "").strip()
    if not url:
        raise EvalError("ALETHEIA_PROMETHEUS_URL is not set")
    body = _get(url, "/api/v1/query", {"query": q}, {}, "Prometheus", timeout)
    return _prom_values(body, "Prometheus")


def clickhouse_values(body: dict[str, Any]) -> list[float]:
    """One number per row, from the first numeric column ClickHouse reports in `meta`."""
    meta = body.get("meta") or []
    col = next((m["name"] for m in meta if _NUMERIC.match(str(m.get("type", "")))), None)
    if col is None:
        if body.get("data"):
            raise EvalError("ClickHouse: the query returned no numeric column")
        return []
    return _floats([row.get(col) for row in body.get("data") or []])


def query_clickhouse(q: str, timeout: float = 15.0) -> list[float]:
    # Same connection settings as the events API; readonly=1 is the real guard.
    from .. import main as m
    try:
        sql = check_select(q)
    except ValueError as exc:
        raise EvalError(str(exc)) from exc
    params = {"user": m.CH_USER, "password": m.CH_PASS, "database": m.CH_DB, "readonly": 1,
              "max_execution_time": 10, "max_result_rows": MAX_CH_ROWS,
              "result_overflow_mode": "break"}
    try:
        r = httpx.post(f"{m.CH_URL}/", params=params, timeout=timeout,
                       content=f"SELECT * FROM ({sql}) LIMIT {MAX_CH_ROWS} FORMAT JSON".encode())
    except httpx.HTTPError as exc:
        raise EvalError(f"ClickHouse unreachable: {type(exc).__name__}") from exc
    if r.status_code >= 400:
        raise EvalError(f"ClickHouse: {r.text.strip().replace(chr(10), ' ')[:300]}")
    text = r.text.strip()
    return clickhouse_values(r.json()) if text else []


QUERIES = {"loki": query_loki, "prometheus": query_prometheus, "clickhouse": query_clickhouse}


def evaluate(datasource: str, query: str, reducer: str, condition: dict[str, Any]) -> dict[str, Any]:
    """Run one evaluation. Never raises: failures come back as `error`."""
    at = now_iso()
    try:
        values = QUERIES[datasource](query)
    except EvalError as exc:
        return {"value": None, "firing": False, "error": str(exc), "series": 0, "at": at}
    except Exception as exc:                                        # noqa: BLE001
        return {"value": None, "firing": False, "error": f"{type(exc).__name__}: {exc}"[:300],
                "series": 0, "at": at}
    value = reduce_values(values, reducer)
    return {"value": value, "firing": compare(value, condition["op"], float(condition["threshold"])),
            "series": len(values), "at": at}
