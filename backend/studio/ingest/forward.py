"""Forward raw lines of approved sources onto the Redpanda `raw` topic (CONTRACTS §3)."""
from __future__ import annotations

import logging

from .rawstore import Entry, RawStore

log = logging.getLogger("studio.forward")


class RawForwarder:
    def __init__(self, brokers: str = "") -> None:
        self.brokers, self._p = (brokers or "").strip(), None
        self.sent = 0

    @property
    def enabled(self) -> bool:
        return bool(self.brokers)

    def send(self, source_id: str, entries: list[Entry], listener: str = "studio") -> int:
        if not self.enabled:
            return 0
        if self._p is None:
            from confluent_kafka import Producer
            self._p = Producer({"bootstrap.servers": self.brokers, "linger.ms": 50})
        for ts, line, _ in entries:
            self._p.produce("raw", key=source_id.encode(), value=line.encode(),
                            headers=[("pr_recv_ms", str(ts // 10**6).encode()),
                                     ("pr_peer", source_id.encode()), ("pr_listener", listener.encode())])
            self._p.poll(0)
        self._p.flush(10)
        self.sent += len(entries)
        return len(entries)


def backfill(store: RawStore, fwd: RawForwarder, source_id: str, max_lines: int = 200_000,
             end_ns: int | None = None) -> int:
    """Replay stored raw lines oldest-first (up to end_ns) so a newly approved pack applies to them."""
    if not fwd.enabled:
        return 0
    done, cursor = 0, None
    while done < max_lines:
        rows = store.query(source_id, limit=2000, start_ns=cursor, end_ns=end_ns, forward=True)
        if not rows:
            break
        fwd.send(source_id, [(r["ts_ns"], r["line"], r["severity"]) for r in rows], "backfill")
        done += len(rows)
        nxt = rows[-1]["ts_ns"] + 1
        if cursor is not None and nxt <= cursor:
            break
        cursor = nxt
    return done
