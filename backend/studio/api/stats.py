"""Dashboard stats: ingest rate, severity mix, source health, onboarding queue, normalized counts."""
from __future__ import annotations

import threading
import time
from typing import Any, Callable

from fastapi import APIRouter

from .state import get_state

router = APIRouter()
WINDOW_S, BUCKET_S = 300, 5
CH_TTL_S = 10
_CH_CACHE: dict[str, Any] = {"at": 0.0, "val": None, "lock": threading.Lock()}
_INS_CACHE: dict[str, Any] = {"at": 0.0, "val": None, "lock": threading.Lock()}


def _cached(cache: dict[str, Any], compute: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    """Serve from cache; one thread refreshes while concurrent callers get the previous value.
    Without this, every poll that lands during a slow refresh re-runs all queries against a loaded ClickHouse."""
    if cache["val"] is not None and time.time() - cache["at"] < CH_TTL_S:
        return cache["val"]
    if not cache["lock"].acquire(blocking=cache["val"] is None):
        return cache["val"]
    try:
        if cache["val"] is None or time.time() - cache["at"] >= CH_TTL_S:
            cache.update(val=compute(), at=time.time())
        return cache["val"]
    finally:
        cache["lock"].release()


def _spark(series, now: int) -> list[float]:
    """Lines/sec in 5 s buckets over the last 5 minutes, oldest first."""
    n, start = WINDOW_S // BUCKET_S, now - WINDOW_S
    out = [0.0] * n
    for sec, cnt in series:
        if sec >= start:
            out[min((sec - start) // BUCKET_S, n - 1)] += cnt / BUCKET_S
    return [round(v, 2) for v in out]


def _normalized() -> dict[str, Any]:
    """ClickHouse counts of parsed events; cached 10 s, `available: false` when it is down."""
    return _cached(_CH_CACHE, _normalized_now)


def _normalized_now() -> dict[str, Any]:
    from .. import main as m
    val: dict[str, Any] = {"available": False}
    if m._ch_up():
        try:
            by = {r["parse_status"]: int(r["c"]) for r in m._ch(
                "SELECT toString(parse_status) AS parse_status, count() AS c FROM events GROUP BY parse_status FORMAT JSON")}
            tpl = m._ch("SELECT count() AS c FROM templates FORMAT JSON")
            total = sum(by.values())
            val = {"available": True, "total": total, "full": by.get("full", 0), "partial": by.get("partial", 0),
                   "raw_only": by.get("raw_only", 0), "templates": int(tpl[0]["c"]) if tpl else 0,
                   "normalized_pct": round(100 * (by.get("full", 0) + by.get("partial", 0)) / total, 1) if total else 0}
        except Exception:                                                            # noqa: BLE001
            pass
    return val


def _insights_ch() -> dict[str, Any]:
    """Deep ClickHouse aggregates for the Overview; cached 10 s, each query fails independently."""
    return _cached(_INS_CACHE, _insights_now)


def _insights_now() -> dict[str, Any]:
    from .. import main as m
    out: dict[str, Any] = {"available": False}
    if m._ch_up():
        out["available"] = True

        def q(name: str, sql: str) -> list[dict[str, Any]]:
            try:
                return m._ch(sql + " FORMAT JSON")
            except Exception:                                                        # noqa: BLE001
                return []

        ip = lambda c: f"replaceOne(toString({c}), '::ffff:', '')"                   # noqa: E731
        out["top_src"] = [{"k": r["k"], "n": int(r["n"])} for r in q("s", f"SELECT {ip('src_ip')} AS k, count() AS n FROM events WHERE src_ip IS NOT NULL GROUP BY k ORDER BY n DESC LIMIT 8")]
        out["top_dst"] = [{"k": r["k"], "n": int(r["n"])} for r in q("d", f"SELECT {ip('dst_ip')} AS k, count() AS n FROM events WHERE dst_ip IS NOT NULL GROUP BY k ORDER BY n DESC LIMIT 8")]
        out["top_ports"] = [{"k": str(r["k"]), "n": int(r["n"])} for r in q("p", "SELECT dst_port AS k, count() AS n FROM events WHERE dst_port IS NOT NULL GROUP BY k ORDER BY n DESC LIMIT 8")]
        out["top_users"] = [{"k": r["k"], "n": int(r["n"])} for r in q("u", "SELECT user_name AS k, count() AS n FROM events WHERE user_name IS NOT NULL AND user_name != '' GROUP BY k ORDER BY n DESC LIMIT 6")]
        out["top_templates"] = [{"k": r["k"], "n": int(r["n"])} for r in q("t", "SELECT template_id AS k, count() AS n FROM events WHERE template_id != '' GROUP BY k ORDER BY n DESC LIMIT 8")]
        out["protocols"] = [{"k": r["k"] or "n/a", "n": int(r["n"])} for r in q("pr", "SELECT protocol AS k, count() AS n FROM events GROUP BY k ORDER BY n DESC LIMIT 6")]
        out["actions"] = [{"k": int(r["k"]), "n": int(r["n"])} for r in q("a", "SELECT action_id AS k, count() AS n FROM events GROUP BY k ORDER BY n DESC")]
        out["classes"] = [{"k": int(r["k"]), "n": int(r["n"])} for r in q("c", "SELECT class_uid AS k, count() AS n FROM events GROUP BY k ORDER BY n DESC LIMIT 8")]
        out["ocsf_sev"] = [{"k": int(r["k"]), "n": int(r["n"])} for r in q("o", "SELECT severity_id AS k, count() AS n FROM events GROUP BY k ORDER BY k")]
        out["modes"] = {r["k"]: int(r["n"]) for r in q("m", "SELECT toString(storage_mode) AS k, count() AS n FROM events GROUP BY k")}
        out["timeline"] = [{"t": int(r["t"]), "n": int(r["n"]), "hi": int(r["hi"])} for r in q("tl",
            "SELECT toUnixTimestamp(toStartOfMinute(recv_time)) AS t, count() AS n, countIf(severity_id >= 4) AS hi "
            "FROM events WHERE recv_time > now() - INTERVAL 60 MINUTE GROUP BY t ORDER BY t")]
        out["top_denied"] = [{"k": r["k"], "n": int(r["n"])} for r in q("td", f"SELECT {ip('src_ip')} AS k, count() AS n FROM events WHERE action_id = 2 AND src_ip IS NOT NULL GROUP BY k ORDER BY n DESC LIMIT 8")]
        out["scanners"] = [{"k": r["k"], "n": int(r["n"])} for r in q("sc", f"SELECT {ip('src_ip')} AS k, uniqExact(dst_port) AS n FROM events WHERE src_ip IS NOT NULL GROUP BY k HAVING n >= 5 ORDER BY n DESC LIMIT 8")]
        out["fanout"] = [{"k": r["k"], "n": int(r["n"])} for r in q("fo", f"SELECT {ip('src_ip')} AS k, uniqExact(dst_ip) AS n FROM events WHERE src_ip IS NOT NULL GROUP BY k HAVING n >= 3 ORDER BY n DESC LIMIT 8")]
        d = "dateDiff('millisecond', event_time, recv_time)"
        ts = "event_time != recv_time"              # equal means the line had no timestamp and arrival time was copied in
        ok = f"{ts} AND {d} BETWEEN 0 AND 3600000"   # a plausible lag; anything else is producer clock/timezone skew
        bad = f"{ts} AND NOT ({d} BETWEEN 0 AND 3600000)"
        lag = q("lag", f"SELECT avgIf({d}, {ok}) AS a, quantileIf(0.95)({d}, {ok}) AS p, countIf({ok}) AS good, countIf({bad}) AS skew, "
                       f"quantileIf(0.5)({d}, {bad}) AS so, countIf(NOT ({ts})) AS nts, "
                       "toUnixTimestamp(min(recv_time)) AS f, toUnixTimestamp(max(recv_time)) AS l, avg(length(vars)) AS v, countIf(action_id = 2) AS den FROM events")
        if lag:
            r0 = lag[0]
            out["lag"] = {"avg_ms": round(float(r0["a"] or 0)), "p95_ms": round(float(r0["p"] or 0)), "good": int(r0["good"]), "skewed": int(r0["skew"]),
                          "skew_ms": round(float(r0["so"] or 0)), "no_ts": int(r0["nts"]),
                          "first": int(r0["f"]), "last": int(r0["l"]), "avg_vars": round(float(r0["v"] or 0), 1), "denied": int(r0["den"])}
        out["hours"] = [{"t": int(r["t"]), "n": int(r["n"]), "hi": int(r["hi"])} for r in q("hr",
            "SELECT toUnixTimestamp(toStartOfHour(recv_time)) AS t, count() AS n, countIf(severity_id >= 4) AS hi "
            "FROM events WHERE recv_time > now() - INTERVAL 24 HOUR GROUP BY t ORDER BY t")]
        u = q("uq", "SELECT uniqExact(src_ip) AS si, uniqExact(dst_ip) AS di, uniqExact(user_name) AS us, uniqExact(merkle_batch) AS mb, "
                    "countIf(raw_sha256 != toFixedString('', 32)) AS hashed, count() AS n FROM events")
        if u:
            out["unique"] = {k: int(v) for k, v in u[0].items()}
        disk = {}
        for r in q("disk", "SELECT `table` AS t, sum(data_compressed_bytes) AS c, sum(data_uncompressed_bytes) AS u, sum(rows) AS r "
                           "FROM system.parts WHERE active AND database = 'aletheia' AND `table` IN ('events','baseline_events') GROUP BY t"):
            disk[r["t"]] = {"compressed": int(r["c"]), "uncompressed": int(r["u"]), "rows": int(r["r"])}
        out["disk"] = disk
    return out


def _derived(rows: list[dict[str, Any]], series: list[float], kp: dict[str, Any], sev: dict[str, int], hist: dict[str, list] | None = None) -> dict[str, Any]:
    """Judge-facing analytics computed from in-memory stats: anomalies, leaderboards, posture score."""
    n = len(series)
    peak = max(series) if series else 0.0
    mean = sum(series) / n if n else 0.0
    sd = (sum((v - mean) ** 2 for v in series) / n) ** 0.5 if n else 0.0
    now_r = sum(series[-2:]) / 2 if n else 0.0
    z = round((now_r - mean) / sd, 2) if sd > 0.01 else 0.0
    active = [r for r in rows if r["lines"]]
    risk_rank = sorted(({"id": r["id"], "risk": r["by_severity"].get("risk", 0), "lines": r["lines"],
                         "pct": round(100 * r["by_severity"].get("risk", 0) / r["lines"], 1)} for r in active),
                       key=lambda r: -r["pct"])[:6]
    noisy = sorted(active, key=lambda r: -r["eps"])[:1]
    lines = kp["lines"]
    warn_pct = round(100 * (sev["warn"] + sev["risk"]) / lines, 1) if lines else 0.0
    onboarded = round(100 * kp["approved"] / kp["sources"], 1) if kp["sources"] else 0.0
    health = round(100 * kp["connected"] / kp["sources"], 1) if kp["sources"] else 0.0
    err_rate = round(100 * kp["errors"] / lines, 3) if lines else 0.0
    # Posture: coverage of onboarding + connection health, minus penalties for open risk and pipeline errors.
    posture = max(0, min(100, round(0.4 * onboarded + 0.4 * health + 20 - min(20, kp["risk_pct"] * 2) - min(10, err_rate * 10))))
    seen = [r["last_seen"] for r in rows if r["last_seen"]]
    fresh = int(time.time() - max(seen)) if seen else None
    stale = sum(1 for r in rows if r["enabled"] and r["last_seen"] and time.time() - r["last_seen"] > 60)
    by_type: dict[str, int] = {}
    for r in rows:
        by_type[r["type"]] = by_type.get(r["type"], 0) + r["lines"]
    share = sorted(({"k": r["id"], "n": r["lines"]} for r in active), key=lambda r: -r["n"])[:6]
    last_min, prev_min = sum(series[-12:]) / 12 if n >= 12 else 0.0, sum(series[-24:-12]) / 12 if n >= 24 else 0.0
    trend = round(100 * (last_min - prev_min) / prev_min, 1) if prev_min > 0.01 else 0.0
    ttas = []
    for h in (hist or {}).values():
        c = next((x["at"] for x in h if x["action"] == "created"), None)
        a = next((x["at"] for x in reversed(h) if x["action"] == "approved"), None)
        if c and a and a >= c:
            ttas.append(a - c)
    return {"freshness_s": fresh, "stale": stale, "by_type": [{"k": k, "n": v} for k, v in sorted(by_type.items(), key=lambda kv: -kv[1])],
            "share": share, "trend_pct": trend, "eps_min": round(last_min, 2), "mean_approval_s": round(sum(ttas) / len(ttas)) if ttas else None,
            "proj_day_lines": int(mean * 86400), "proj_day_bytes": int(mean * 86400 * (kp["bytes"] / lines)) if lines else 0,
            "peak_eps": round(peak, 2), "mean_eps": round(mean, 2), "z": z, "spike": z >= 2.5,
            "noisiest": noisy[0]["id"] if noisy else None, "risk_rank": risk_rank, "warn_pct": warn_pct,
            "onboarded_pct": onboarded, "health_pct": health, "error_rate": err_rate, "posture": posture,
            "bytes_per_line": round(kp["bytes"] / lines, 1) if lines else 0}


def _live_packs(rows: list[dict[str, Any]]) -> int:
    """Approved packs in the newest version. Each approval re-publishes the whole set as a new version,
    so counting rows across versions multiplies the real number."""
    if not rows:
        return 0
    latest = max(int(r["version"]) for r in rows)
    return len({r["pack"] for r in rows if int(r["version"]) == latest and r.get("status") == "approved"})


@router.get("/stats/overview")
def overview() -> dict[str, Any]:
    st, now = get_state(), int(time.time())
    srcs, rows, total_series = st.registry.list(), [], [0.0] * (WINDOW_S // BUCKET_S)
    sev = {"info": 0, "notice": 0, "warn": 0, "risk": 0}
    for s in srcs:
        ps = st.pipeline.stats.get(s.id)
        spark = _spark(ps.series if ps else [], now)
        total_series = [a + b for a, b in zip(total_series, spark)]
        by = dict(ps.by_severity) if ps else {}
        for k in sev:
            sev[k] += by.get(k, 0)
        rows.append({"id": s.id, "type": s.type, "state": s.state, "enabled": s.enabled,
                     **st.connectors.status(s.id), "lines": ps.lines if ps else 0, "bytes": ps.bytes if ps else 0,
                     "errors": ps.errors if ps else 0, "eps": round(sum(spark[-2:]) / 2, 2), "by_severity": by,
                     "last_seen": ps.last_seen if ps else None, "spark": spark})
    lines, size = sum(r["lines"] for r in rows), sum(r["bytes"] for r in rows)
    history = sorted(({**h, "source": s.id} for s in srcs for h in s.history if h["action"] != "created"),
                     key=lambda h: -h["at"])[:10]
    kp = {"lines": lines, "bytes": size, "sources": len(srcs), "errors": sum(r["errors"] for r in rows),
          "connected": sum(1 for r in rows if r["status"] in ("connected", "passive") and r["enabled"]),
          "approved": sum(1 for s in srcs if s.state == "approved"), "risk_pct": round(100 * sev["risk"] / lines, 1) if lines else 0.0}
    return {
        "insights": {**_derived(rows, total_series, kp, sev, {x.id: x.history for x in srcs}), "ch": _insights_ch()},
        "generated_at": now, "window_s": WINDOW_S, "bucket_s": BUCKET_S,
        "kpis": {
            "lines": lines, "bytes": size, "eps": round(sum(total_series[-2:]) / 2, 2),
            "sources": len(srcs), "connected": sum(1 for r in rows if r["status"] in ("connected", "passive") and r["enabled"]),
            "in_review": sum(1 for s in srcs if s.state == "review"), "approved": sum(1 for s in srcs if s.state == "approved"),
            "rejected": sum(1 for s in srcs if s.state == "rejected"),
            "risk_pct": round(100 * sev["risk"] / lines, 1) if lines else 0.0,
            "errors": sum(r["errors"] for r in rows), "buffered": st.pipeline._n, "forwarded": st.forwarder.sent,
            "packs": _live_packs(st.repo.packs_list()),
        },
        "store": st.raw.kind, "bus": st.forwarder.enabled, "by_severity": sev,
        "series": total_series, "sources": sorted(rows, key=lambda r: -r["lines"]),
        "normalized": _normalized(), "history": history,
    }
