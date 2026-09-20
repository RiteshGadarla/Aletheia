"""Batching ingest path: connectors submit lines, this buffers, stores raw, counts, forwards."""
from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Callable, Iterable

from .rawstore import Entry, RawStore, guess_severity

log = logging.getLogger("studio.ingest")


@dataclass
class SourceStats:
    lines: int = 0
    bytes: int = 0
    last_seen: float = 0.0
    errors: int = 0
    by_severity: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    series: deque = field(default_factory=lambda: deque(maxlen=300))     # [epoch_sec, lines]

    def add(self, n: int, size: int, sev_counts: dict[str, int]) -> None:
        now = time.time()
        self.lines += n
        self.bytes += size
        self.last_seen = now
        for k, v in sev_counts.items():
            self.by_severity[k] += v
        sec = int(now)
        if self.series and self.series[-1][0] == sec:
            self.series[-1][1] += n
        else:
            self.series.append([sec, n])


class IngestPipeline:
    def __init__(self, store: RawStore, *, max_buffer: int = 100_000, flush_s: float = 1.0,
                 batch: int = 2000, forward: Callable[[str, list[Entry]], None] | None = None) -> None:
        self.store, self.max_buffer, self.flush_s, self.batch = store, max_buffer, flush_s, batch
        self.forward = forward
        self.stats: dict[str, SourceStats] = defaultdict(SourceStats)
        self.fmt: dict[str, str] = {}
        self._buf: dict[str, list[Entry]] = defaultdict(list)
        self._n = 0
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None
        await self.flush()

    async def submit(self, source_id: str, lines: Iterable[str], fmt: str = "",
                     ts_ns: int | None = None) -> int:
        """Queue lines verbatim. Awaits (backpressure) when the buffer is full; never drops."""
        while self._n >= self.max_buffer:
            await asyncio.sleep(0.05)
        now, k = ts_ns or time.time_ns(), 0
        sev_counts: dict[str, int] = defaultdict(int)
        size = 0
        for line in lines:
            if not line:
                continue
            sev = guess_severity(line)
            self._buf[source_id].append((now + k, line, sev))
            sev_counts[sev] += 1
            size += len(line.encode())
            k += 1
        if k:
            self._n += k
            self.fmt.setdefault(source_id, fmt)
            self.stats[source_id].add(k, size, sev_counts)
        return k

    async def flush(self) -> None:
        pending, self._buf = self._buf, defaultdict(list)
        self._n = 0
        for sid, entries in pending.items():
            for i in range(0, len(entries), self.batch):
                chunk = entries[i:i + self.batch]
                try:
                    await asyncio.to_thread(self.store.push, sid, chunk, self.fmt.get(sid, ""))
                except Exception as exc:                                     # noqa: BLE001
                    self.stats[sid].errors += 1
                    log.warning("raw store push failed (%s); will retry", type(exc).__name__)
                    self._buf[sid] = entries[i:] + self._buf[sid]           # keep, retry next tick
                    self._n += len(entries) - i
                    break
                if self.forward:
                    try:
                        await asyncio.to_thread(self.forward, sid, chunk)
                    except Exception as exc:                                 # noqa: BLE001
                        log.warning("bus forward failed (%s)", type(exc).__name__)

    async def _run(self) -> None:
        while True:
            await asyncio.sleep(self.flush_s if self._n < self.batch else 0.05)
            await self.flush()
