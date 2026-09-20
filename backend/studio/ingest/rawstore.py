"""Raw log store. Every line is kept verbatim before any parsing. Loki when configured, else memory.

Labels stay low-cardinality (source, severity, format) like Loki intends; the SHA-256 of the
raw bytes travels as structured metadata.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from collections import defaultdict, deque
from typing import Any, Protocol

import httpx

Entry = tuple[int, str, str]          # (ts_ns, raw line, severity)


class RawStore(Protocol):
    kind: str

    def push(self, source_id: str, entries: list[Entry], fmt: str = "") -> None: ...
    def query(self, source_id: str, *, limit: int = 100, text: str | None = None,
              severity: str | None = None, start_ns: int | None = None,
              end_ns: int | None = None, forward: bool = False) -> list[dict[str, Any]]: ...
    def sources(self) -> list[str]: ...


class MemoryRawStore:
    kind = "memory"

    def __init__(self, cap: int = 50_000) -> None:
        self._cap = cap
        self._d: dict[str, deque] = defaultdict(lambda: deque(maxlen=cap))
        self._lock = threading.Lock()

    def push(self, source_id: str, entries: list[Entry], fmt: str = "") -> None:
        with self._lock:
            self._d[source_id].extend(entries)

    def query(self, source_id, *, limit=100, text=None, severity=None, start_ns=None,
              end_ns=None, forward=False):
        with self._lock:
            rows = list(self._d.get(source_id, ()))
        rows = [r for r in rows
                if (not text or text in r[1]) and (not severity or r[2] == severity)
                and (start_ns is None or r[0] >= start_ns) and (end_ns is None or r[0] <= end_ns)]
        rows.sort(key=lambda r: r[0], reverse=not forward)
        return [{"ts_ns": ts, "line": ln, "severity": sv} for ts, ln, sv in rows[:limit]]

    def sources(self) -> list[str]:
        with self._lock:
            return list(self._d)


def _q(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


class LokiRawStore:
    kind = "loki"

    def __init__(self, url: str, tenant: str | None = None) -> None:
        h = {"X-Scope-OrgID": tenant} if tenant else {}
        self._c = httpx.Client(base_url=url.rstrip("/"), headers=h, timeout=10)

    def push(self, source_id: str, entries: list[Entry], fmt: str = "") -> None:
        by_sev: dict[str, list] = defaultdict(list)
        for ts, line, sev in entries:
            by_sev[sev].append([str(ts), line, {"sha256": hashlib.sha256(line.encode()).hexdigest()}])
        streams = [{"stream": {"source": source_id, "severity": sev, "format": fmt or "unknown"},
                    "values": v} for sev, v in by_sev.items()]
        r = self._c.post("/loki/api/v1/push", json={"streams": streams})
        r.raise_for_status()

    def query(self, source_id, *, limit=100, text=None, severity=None, start_ns=None,
              end_ns=None, forward=False):
        sel = f'{{source="{_q(source_id)}"' + (f',severity="{_q(severity)}"' if severity else "") + "}"
        expr = sel + (f' |= "{_q(text)}"' if text else "")
        now = time.time_ns()
        r = self._c.get("/loki/api/v1/query_range", params={
            "query": expr, "limit": limit, "direction": "forward" if forward else "backward",
            "start": start_ns or now - 7 * 86400 * 10**9, "end": end_ns or now + 10**9})
        r.raise_for_status()
        rows = [{"ts_ns": int(ts), "line": ln, "severity": s["stream"].get("severity", "info")}
                for s in r.json()["data"]["result"] for ts, ln, *_ in s["values"]]
        rows.sort(key=lambda x: x["ts_ns"], reverse=not forward)
        return rows[:limit]

    def sources(self) -> list[str]:
        r = self._c.get("/loki/api/v1/label/source/values")
        r.raise_for_status()
        return r.json().get("data", [])

    def totals(self, source_id: str) -> dict[str, int]:
        now = time.time_ns()
        r = self._c.get("/loki/api/v1/index/stats", params={
            "query": f'{{source="{_q(source_id)}"}}', "start": now - 30 * 86400 * 10**9, "end": now})
        r.raise_for_status()
        d = r.json()
        return {"lines": d.get("entries", 0), "bytes": d.get("bytes", 0)}


def build_rawstore() -> RawStore:
    url = os.environ.get("ALETHEIA_LOKI_URL", "").strip()
    return LokiRawStore(url, os.environ.get("ALETHEIA_LOKI_TENANT") or None) if url else MemoryRawStore()


_PRI = re.compile(r"^<(\d{1,3})>")
_ASA = re.compile(r"%ASA-(\d)-")
_LEVEL = re.compile(r'"level"\s*:\s*"(\w+)"', re.I)
_RISK = re.compile(r"attack|inject|brute|malware|exploit|sqlmap|nikto|masscan|etc/passwd|1=1|TCP_DENIED|stuffing|panic", re.I)
_BAD = re.compile(r"denied|deny|block|failed|fatal|error|timeout|exhausted", re.I)


def guess_severity(line: str) -> str:
    """Cheap, format-agnostic severity for the label; the parsed severity comes later."""
    base = "info"
    a, m, lv = _ASA.search(line[:80]), _PRI.match(line), _LEVEL.search(line)
    if a:
        n = int(a.group(1))
        base = "info" if n >= 6 else "notice" if n == 5 else "warn" if n == 4 else "risk"
    elif m:
        n = int(m.group(1)) % 8
        base = "info" if n >= 6 else "notice" if n == 5 else "warn" if n == 4 else "risk"
    elif lv:
        v = lv.group(1).lower()
        base = "risk" if v in ("error", "fatal", "critical") else "warn" if v in ("warn", "warning") else "info"
    if base != "risk" and _RISK.search(line):
        return "risk"
    if base in ("info", "notice") and _BAD.search(line):
        return "warn"
    return base
