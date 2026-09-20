"""Dashboard stats: ingest rate, severity mix, source health, onboarding queue, normalized counts."""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter

from .state import get_state

router = APIRouter()
WINDOW_S, BUCKET_S = 300, 5
_CH_CACHE: dict[str, Any] = {"at": 0.0, "val": None}


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
    if time.time() - _CH_CACHE["at"] < 10 and _CH_CACHE["val"] is not None:
        return _CH_CACHE["val"]
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
    _CH_CACHE.update(at=time.time(), val=val)
    return val


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
    return {
        "generated_at": now, "window_s": WINDOW_S, "bucket_s": BUCKET_S,
        "kpis": {
            "lines": lines, "bytes": size, "eps": round(sum(total_series[-2:]) / 2, 2),
            "sources": len(srcs), "connected": sum(1 for r in rows if r["status"] in ("connected", "passive") and r["enabled"]),
            "in_review": sum(1 for s in srcs if s.state == "review"), "approved": sum(1 for s in srcs if s.state == "approved"),
            "rejected": sum(1 for s in srcs if s.state == "rejected"),
            "risk_pct": round(100 * sev["risk"] / lines, 1) if lines else 0.0,
            "errors": sum(r["errors"] for r in rows), "buffered": st.pipeline._n, "forwarded": st.forwarder.sent,
            "packs": sum(1 for p in st.repo.packs_list() if p.get("status") == "approved"),
        },
        "store": st.raw.kind, "bus": st.forwarder.enabled, "by_severity": sev,
        "series": total_series, "sources": sorted(rows, key=lambda r: -r["lines"]),
        "normalized": _normalized(), "history": history,
    }
