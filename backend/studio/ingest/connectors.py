"""Pull/listen connectors. Each reads raw lines from an external system into the pipeline."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

import httpx

from .pipeline import IngestPipeline
from .sources import Source, SourceRegistry, check_udp_port

log = logging.getLogger("studio.connectors")


def _lines_from_obj(o: Any, field: str) -> list[str]:
    """One JSON object -> raw lines. Loki tail frames expand; `line_field` picks the payload."""
    if isinstance(o, dict) and "streams" in o:
        return [v[1] for s in o["streams"] for v in s.get("values", [])]
    if isinstance(o, dict) and field and field in o:
        return [str(o[field])]
    return [json.dumps(o, separators=(",", ":"))]


class Runner:
    """One asyncio task per enabled source, with reconnect backoff and live status."""

    def __init__(self, src: Source, pipe: IngestPipeline, loop: asyncio.AbstractEventLoop | None = None) -> None:
        self.src, self.pipe, self.loop = src, pipe, loop
        self.status, self.error, self.since = "starting", "", time.time()
        self.task: asyncio.Task | None = None

    def start(self) -> None:
        """Safe from any thread: sync API handlers have no running loop of their own."""
        if self.loop is None:
            self.loop = asyncio.get_running_loop()
        self.loop.call_soon_threadsafe(self._spawn)

    def _spawn(self) -> None:
        self.task = asyncio.create_task(self._loop())

    def stop(self) -> None:
        if self.loop and self.loop.is_running():
            self.loop.call_soon_threadsafe(lambda: self.task and self.task.cancel())

    def _emit(self, lines: list[str]):
        return self.pipe.submit(self.src.id, lines, self.src.type)

    async def _loop(self) -> None:
        delay = 1.0
        while True:
            try:
                self.status, self.error = "connected", ""
                await getattr(self, f"_{self.src.type}")(self.src.config)
                delay = 1.0
            except asyncio.CancelledError:
                self.status = "stopped"
                raise
            except Exception as exc:                                         # noqa: BLE001
                self.status, self.error = "reconnecting", f"{type(exc).__name__}: {exc}"[:200]
                self.pipe.stats[self.src.id].errors += 1
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)

    async def _tcp(self, c) -> None:
        r, w = await asyncio.open_connection(c["host"], int(c["port"]))
        try:
            while line := await r.readline():
                await self._emit([line.rstrip(b"\r\n").decode("utf-8", "replace")])
        finally:
            w.close()

    async def _udp_listen(self, c) -> None:
        check_udp_port(int(c["port"]))      # sources saved before the guard existed
        loop, pipe, sid = asyncio.get_running_loop(), self.pipe, self.src.id

        class P(asyncio.DatagramProtocol):
            def datagram_received(self, data, addr):
                asyncio.ensure_future(pipe.submit(sid, [data.decode("utf-8", "replace").rstrip("\r\n")], "udp"))

        tr, _ = await loop.create_datagram_endpoint(P, local_addr=(c.get("bind", "0.0.0.0"), int(c["port"])))
        try:
            await asyncio.Event().wait()
        finally:
            tr.close()

    async def _http_stream(self, c) -> None:
        async with httpx.AsyncClient(timeout=None, headers=c.get("headers") or {}) as cl:
            async with cl.stream("GET", c["url"]) as resp:
                resp.raise_for_status()
                async for text in resp.aiter_lines():
                    if text.strip():
                        await self._emit(_lines_from_obj(json.loads(text), c.get("line_field", "line")))

    async def _websocket(self, c) -> None:
        import websockets
        async with websockets.connect(c["url"], ping_interval=20) as ws:
            async for msg in ws:
                try:
                    await self._emit(_lines_from_obj(json.loads(msg), c.get("line_field", "line")))
                except ValueError:
                    await self._emit([msg if isinstance(msg, str) else msg.decode("utf-8", "replace")])

    async def _loki_pull(self, c) -> None:
        last = time.time_ns() - int(c.get("lookback_s", 60)) * 10**9
        async with httpx.AsyncClient(base_url=c["url"].rstrip("/"), timeout=15, headers=c.get("headers") or {}) as cl:
            while True:
                r = await cl.get("/loki/api/v1/query_range", params={
                    "query": c.get("query", '{job=~".+"}'), "start": last + 1, "end": time.time_ns(),
                    "limit": 5000, "direction": "forward"})
                r.raise_for_status()
                rows = sorted((int(t), ln) for s in r.json()["data"]["result"] for t, ln, *_ in s["values"])
                if rows:
                    last = rows[-1][0]
                    await self._emit([ln for _, ln in rows])
                await asyncio.sleep(float(c.get("interval_s", 2)))

    async def _rest_cursor(self, c) -> None:
        cursor = c.get("start_cursor", 0)
        async with httpx.AsyncClient(timeout=15, headers=c.get("headers") or {}) as cl:
            while True:
                r = await cl.get(c["url"], params={c.get("cursor_param", "after"): cursor, "limit": 1000})
                r.raise_for_status()
                d = r.json()
                items = d.get(c.get("items_key", "items"), [])
                if items:
                    await self._emit([str(i[c.get("line_field", "line")]) for i in items])
                    cursor = d.get(c.get("next_key", "next"), items[-1].get(c.get("cursor_field", "cursor"), cursor))
                await asyncio.sleep(float(c.get("interval_s", 1)))


class ConnectorManager:
    def __init__(self, registry: SourceRegistry, pipe: IngestPipeline) -> None:
        self.registry, self.pipe = registry, pipe
        self.runners: dict[str, Runner] = {}
        self.loop: asyncio.AbstractEventLoop | None = None

    def start_all(self, loop: asyncio.AbstractEventLoop | None = None) -> None:
        if loop is not None:
            self.loop = loop
        else:
            try:
                self.loop = asyncio.get_running_loop()
            except RuntimeError:
                if self.loop is None:
                    try:
                        self.loop = asyncio.get_event_loop()
                    except RuntimeError:
                        pass
        for s in self.registry.list():
            self.sync(s)

    def sync(self, src: Source) -> None:
        """Start, restart or stop the runner so it matches the source's current config."""
        old = self.runners.pop(src.id, None)
        if old:
            old.stop()
        if src.enabled and src.type != "push":
            r = Runner(src, self.pipe, self.loop)
            self.runners[src.id] = r
            r.start()

    def remove(self, sid: str) -> None:
        if r := self.runners.pop(sid, None):
            r.stop()

    def status(self, sid: str) -> dict[str, Any]:
        r = self.runners.get(sid)
        return {"status": r.status if r else "passive", "error": r.error if r else ""}

    def stop_all(self) -> None:
        for r in self.runners.values():
            r.stop()
