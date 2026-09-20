"""Shared runtime for the live generator servers. Stdlib only, one asyncio loop, tiny memory."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import random
import re
import socket
import time
from collections import deque
from urllib.parse import parse_qs, urlsplit

RING = 5000
SEVS = ("info", "notice", "warn", "risk")
WS_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def sev_from_pri(line: str) -> str:
    """Syslog PRI severity -> info/notice/warn/risk. Lines without PRI are info."""
    if line.startswith("<"):
        try:
            n = int(line[1:line.index(">")]) % 8
        except ValueError:
            return "info"
        return "info" if n >= 6 else "notice" if n == 5 else "warn" if n == 4 else "risk"
    return "info"


def blend(calm, bad, r):
    return [c * (1 - r) + b * r for c, b in zip(calm, bad)]


class Mood:
    """Risk level 0..1 drifting between calm, elevated and attack phases; `forced` pins it."""

    def __init__(self, rng: random.Random):
        self.rng, self.risk, self.target, self.until, self.forced = rng, 0.04, 0.04, 0.0, None

    def step(self, now: float) -> None:
        if self.forced is not None:
            self.risk = self.forced
            return
        if now >= self.until:
            r = self.rng.random()
            self.target = 0.04 if r < 0.7 else 0.3 if r < 0.93 else 0.85
            self.until = now + self.rng.uniform(20, 120)
        self.risk += (self.target - self.risk) * 0.2

    @property
    def label(self) -> str:
        return "attack" if self.risk > 0.6 else "elevated" if self.risk > 0.2 else "calm"


class Feed:
    """Endless log producer. gen(feed) -> (line, severity). The rate wanders inside [lo, hi] lines/s
    (random walk plus occasional bursts and dips), so per-second counts are uneven, never a flat N."""

    def __init__(self, name: str, gen, rate: float, seed: int):
        self.name, self.gen = name, gen
        self.rng = random.Random(seed)
        self.mood = Mood(self.rng)
        self.ring: deque = deque(maxlen=RING)
        self.seq = self.total = 0
        self.subs: set[asyncio.Queue] = set()
        self.paused = self.drift = False
        self.counts = dict.fromkeys(SEVS, 0)
        self.started = time.time()
        self.set_center(rate)
        self.cur = self.center
        self._sec, self._sec_n, self.eps_now = int(time.time()), 0, 0

    def set_center(self, rate: float) -> None:
        """Mean rate. Inside 40-80 the steering band is 44-76, so real per-second counts (which jitter a few
        lines around it) stay within 40-80; outside that range it is +-33% around the mean."""
        self.center = max(float(rate), 0.01)
        self.lo, self.hi = (44.0, 76.0) if 40 <= self.center <= 80 else (self.center * 0.67, self.center * 1.33)

    @property
    def rate(self) -> float:
        return self.center

    def wander(self) -> None:
        """One step per second: pulled toward the mean, jostled, and now and then a burst or a dip."""
        c = self.cur + self.rng.gauss(0, 0.09 * self.center) + 0.2 * (self.center - self.cur)
        if self.rng.random() < 0.07:
            c += self.rng.choice((-1, 1)) * self.rng.uniform(0.15, 0.4) * self.center
        self.cur = min(max(c, self.lo), self.hi)

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self.subs.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subs.discard(q)

    def emit(self) -> None:
        line, sev = self.gen(self)
        self.seq += 1
        self.total += 1
        self.counts[sev] += 1
        sec = int(time.time())
        if sec != self._sec:
            self.eps_now, self._sec, self._sec_n = self._sec_n if sec == self._sec + 1 else 0, sec, 0
        self._sec_n += 1
        e = (self.seq, time.time_ns(), line, sev)
        self.ring.append(e)
        for q in self.subs:
            if q.full():
                q.get_nowait()
            q.put_nowait(e)

    async def run(self) -> None:
        last = 0.0
        while True:
            now = time.time()
            if now - last >= 1:
                self.mood.step(now)
                self.wander()
                last = now
            if self.paused:
                await asyncio.sleep(0.5)
                continue
            rate = min(self.cur * (1 + 0.1 * self.mood.risk), self.hi * 1.05)
            self.emit()
            # Gamma inter-arrivals (shape 5): steadier than Poisson, so the count follows `cur`.
            await asyncio.sleep(self.rng.gammavariate(5, 1 / (5 * max(rate, 0.01))))

    def stats(self) -> dict:
        up = max(time.time() - self.started, 1)
        return {"name": self.name, "total": self.total, "seq": self.seq, "by_severity": self.counts,
                "avg_eps": round(self.total / up, 2), "eps_now": self.eps_now, "base_rate": self.center,
                "band": [round(self.lo), round(self.hi)], "mood": self.mood.label,
                "risk": round(self.mood.risk, 2), "paused": self.paused, "drift": self.drift,
                "subscribers": len(self.subs), "uptime_s": int(up)}


# ------------------------------------------------------------------ HTTP / WebSocket
async def _read_request(reader):
    head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
    lines = head.decode("latin1").split("\r\n")
    method, target, _ = lines[0].split(" ", 2)
    headers = {k.lower(): v for k, v in (ln.split(": ", 1) for ln in lines[1:] if ": " in ln)}
    n = int(headers.get("content-length", 0))
    body = await reader.readexactly(min(n, 65536)) if n else b""
    return method, target, headers, body


def _send(writer, status: int, obj) -> None:
    body = json.dumps(obj).encode()
    reason = {200: "OK", 400: "Bad Request", 404: "Not Found"}.get(status, "OK")
    writer.write(f"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n"
                 f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)


def _ws_frame(text: str, op: int = 0x1) -> bytes:
    b = text.encode()
    n = len(b)
    hdr = (bytes([0x80 | op, n]) if n < 126 else bytes([0x80 | op, 126]) + n.to_bytes(2, "big")
           if n < 65536 else bytes([0x80 | op, 127]) + n.to_bytes(8, "big"))
    return hdr + b


def _ns(v: str | None, default: int) -> int:
    if not v:
        return default
    try:
        f = float(v)
    except ValueError:
        return default
    return int(f * 1e9) if f < 1e11 else int(f)


_MATCH = re.compile(r'(\w+)\s*(=~|!=|=)\s*"([^"]*)"')


def loki_query(feed: Feed, q: dict) -> dict:
    """Minimal Loki query_range: label matchers, |= "text" filters, start/end/limit."""
    expr = q.get("query", ["{}"])[0]
    sel, _, rest = expr.partition("}")
    matchers = _MATCH.findall(sel)
    texts = re.findall(r'\|=\s*"([^"]*)"', rest)
    now = time.time_ns()
    start, end = _ns(q.get("start", [None])[0], now - 3600 * 10**9), _ns(q.get("end", [None])[0], now)
    limit = min(int(q.get("limit", ["100"])[0]), 5000)
    rows = [e for e in feed.ring if start <= e[1] <= end and all(t in e[2] for t in texts)]
    if q.get("direction", ["backward"])[0] != "forward":
        rows.reverse()
    streams: dict[str, list] = {}
    for _, ts, line, sev in rows:
        labels = {"job": feed.name, "severity": sev}
        ok = True
        for k, op, v in matchers:
            have = labels.get(k, "")
            ok &= (have == v) if op == "=" else (have != v) if op == "!=" else bool(re.fullmatch(v, have))
        if ok and sum(len(x) for x in streams.values()) < limit:
            streams.setdefault(sev, []).append([str(ts), line])
    result = [{"stream": {"job": feed.name, "severity": s}, "values": v} for s, v in streams.items()]
    return {"status": "success", "data": {"resultType": "streams", "result": result}}


def _control(feed: Feed, method: str, path: str, q: dict, body: bytes):
    if path in ("/healthz", "/ready"):
        return 200, {"status": "ok", "name": feed.name}
    if path == "/stats":
        return 200, feed.stats()
    if path == "/control" and method == "POST":
        try:
            c = json.loads(body or b"{}")
            if "rate" in c:
                feed.set_center(c["rate"])
                feed.cur = feed.center
            if "paused" in c:
                feed.paused = bool(c["paused"])
            if "drift" in c:
                feed.drift = bool(c["drift"])
            if "risk" in c:
                feed.mood.forced = None if c["risk"] is None else min(max(float(c["risk"]), 0.0), 1.0)
        except (ValueError, TypeError):
            return 400, {"error": "bad json"}
        return 200, feed.stats()
    if path == "/logs":
        after, limit = int(q.get("after", ["0"])[0]), min(int(q.get("limit", ["500"])[0]), 2000)
        items = [{"cursor": s, "ts": ts, "severity": sv, "line": ln}
                 for s, ts, ln, sv in feed.ring if s > after][:limit]
        return 200, {"items": items, "next": items[-1]["cursor"] if items else after}
    if path == "/loki/api/v1/query_range":
        return 200, loki_query(feed, q)
    if path == "/loki/api/v1/labels":
        return 200, {"status": "success", "data": ["job", "severity"]}
    if path == "/loki/api/v1/label/severity/values":
        return 200, {"status": "success", "data": list(SEVS)}
    if path == "/loki/api/v1/label/job/values":
        return 200, {"status": "success", "data": [feed.name]}
    return None


async def _stream(feed: Feed, writer, kind: str, loki: bool) -> None:
    q = feed.subscribe()
    try:
        if kind == "ws":
            while True:
                try:
                    _, ts, line, sev = await asyncio.wait_for(q.get(), 15)
                except asyncio.TimeoutError:
                    writer.write(_ws_frame("", 0x9))
                    await writer.drain()
                    continue
                msg = ({"streams": [{"stream": {"job": feed.name, "severity": sev},
                                     "values": [[str(ts), line]]}]} if loki else
                       {"ts": ts, "severity": sev, "line": line})
                writer.write(_ws_frame(json.dumps(msg)))
                await writer.drain()
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\n"
                     b"Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n")
        while True:
            _, ts, line, sev = await q.get()
            chunk = (json.dumps({"ts": ts, "severity": sev, "line": line}) + "\n").encode()
            writer.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
            await writer.drain()
    finally:
        feed.unsubscribe(q)


def http_handler(feed: Feed):
    async def handle(reader, writer):
        try:
            method, target, headers, body = await _read_request(reader)
            u = urlsplit(target)
            q = parse_qs(u.query)
            if u.path in ("/ws", "/loki/api/v1/tail") and "sec-websocket-key" in headers:
                acc = base64.b64encode(hashlib.sha1(headers["sec-websocket-key"].encode() + WS_GUID).digest())
                writer.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                             b"Connection: Upgrade\r\nSec-WebSocket-Accept: " + acc + b"\r\n\r\n")
                await _stream(feed, writer, "ws", u.path.startswith("/loki"))
            elif u.path == "/stream":
                await _stream(feed, writer, "ndjson", False)
            else:
                res = _control(feed, method, u.path, q, body)
                _send(writer, *(res or (404, {"error": "not found"})))
                await writer.drain()
        except (asyncio.TimeoutError, asyncio.IncompleteReadError, ConnectionError, ValueError, OSError):
            pass
        finally:
            writer.close()
    return handle


def tcp_handler(feed: Feed):
    """Raw syslog-over-TCP: every connected client receives newline-delimited lines."""
    async def handle(reader, writer):
        q = feed.subscribe()
        try:
            while True:
                _, _, line, _ = await q.get()
                writer.write(line.encode() + b"\n")
                await writer.drain()
        except (ConnectionError, OSError):
            pass
        finally:
            feed.unsubscribe(q)
            writer.close()
    return handle


async def udp_pusher(feed: Feed, target: str) -> None:
    """Pushes each line as one UDP syslog datagram; retries DNS until the target resolves."""
    host, _, port = target.rpartition(":")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setblocking(False)
    addr = None
    q = feed.subscribe()
    while True:
        _, _, line, _ = await q.get()
        if addr is None:
            try:
                addr = (socket.gethostbyname(host), int(port))
            except OSError:
                await asyncio.sleep(5)
                continue
        try:
            sock.sendto(line.encode(), addr)
        except OSError:
            pass
