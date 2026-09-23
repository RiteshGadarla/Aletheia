"""Log supply stream server and export utilities for Aletheia.

The supply stream feeds other systems (a SIEM, a data lake, a second collector) over TCP, either
by serving receivers that connect here (`listen`) or by dialling out to a collector that listens,
which is how rsyslog, syslog-ng, QRadar and Splunk TCP inputs expect to be fed (`push`). Every
connection gets its own bounded queue and writer thread, so a slow or stalled receiver loses its
own backlog (counted as dropped) and never holds up ingest or the other receivers.
"""
from __future__ import annotations

import csv
import hashlib
import io
import ipaddress
import json
import logging
import queue
import select
import socket
import threading
import time
import uuid
from typing import Any

from . import logformats as lf

log = logging.getLogger("studio.supply")

# raw/tagged/json/syslog/cef carry the raw pipeline; ocsf tails the worker's `normalized` topic.
STREAM_FORMATS = ("raw", "tagged", "json", "syslog", "cef", "ocsf")
STREAM_MODES = ("listen", "push")
NORMALIZED_TOPIC = "normalized"
CLIENT_QUEUE_CHUNKS = 512        # per-client backlog, in broadcast chunks (up to 2000 lines each)
SEND_TIMEOUT_S = 30.0            # a client that reads nothing for this long is disconnected


class SupplyError(Exception):
    """Configuration the server cannot run with; the message is shown to the operator.

    `status` is 422 for an invalid option and 409 when valid options cannot start (port taken, no bus).
    """

    def __init__(self, msg: str, status: int = 409) -> None:
        super().__init__(msg)
        self.status = status


class _Client:
    def __init__(self, sock: socket.socket, addr: tuple[str, int], on_sent: Any) -> None:
        self.sock, self.addr, self._on_sent = sock, addr, on_sent
        self.q: queue.Queue[tuple[bytes, int]] = queue.Queue(maxsize=CLIENT_QUEUE_CHUNKS)
        self.connected_at = time.time()
        self.lines = self.bytes = self.dropped = 0
        self.alive = True
        sock.settimeout(SEND_TIMEOUT_S)
        self.thread = threading.Thread(target=self._drain, daemon=True, name=f"supply-{addr[0]}:{addr[1]}")
        self.thread.start()

    def offer(self, data: bytes, n: int) -> int:
        """Queue a chunk; returns how many lines were dropped because this client fell behind."""
        try:
            self.q.put_nowait((data, n))
            return 0
        except queue.Full:
            self.dropped += n
            return n

    def _peer_closed(self) -> bool:
        """Notice a hung-up receiver while idle; anything it sends us is read and discarded."""
        try:
            r, _, _ = select.select([self.sock], [], [], 0)
            return bool(r) and not self.sock.recv(4096)
        except (OSError, ValueError):                   # ValueError: closed under us by stop()
            return True

    def _drain(self) -> None:
        while self.alive:
            try:
                data, n = self.q.get(timeout=0.5)
            except queue.Empty:
                if self._peer_closed():
                    break
                continue
            try:
                self.sock.sendall(data)
            except OSError:
                break
            self.lines += n
            self.bytes += len(data)
            self._on_sent(n, len(data))
        self.close()

    def close(self) -> None:
        self.alive = False
        try:
            self.sock.close()
        except OSError:
            pass

    def view(self) -> dict[str, Any]:
        return {"addr": f"{self.addr[0]}:{self.addr[1]}", "connected_at": self.connected_at, "lines": self.lines,
                "bytes": self.bytes, "dropped": self.dropped, "queued": self.q.qsize()}


class _Pusher:
    """Push mode: one outbound connection to a listening collector.

    Chunks queue while the target is down and a chunk whose send failed is resent after the
    reconnect, so a collector restart costs nothing unless it outlasts the queue.
    """

    def __init__(self, host: str, port: int, on_sent: Any, on_error: Any) -> None:
        self.host, self.port, self._on_sent, self._on_error = host, port, on_sent, on_error
        self.q: queue.Queue[tuple[bytes, int]] = queue.Queue(maxsize=CLIENT_QUEUE_CHUNKS)
        self.sock: socket.socket | None = None
        self.connected_at: float | None = None
        self.lines = self.bytes = self.dropped = 0
        self.alive = True
        self.thread = threading.Thread(target=self._run, daemon=True, name=f"supply-push-{host}:{port}")
        self.thread.start()

    def offer(self, data: bytes, n: int) -> int:
        try:
            self.q.put_nowait((data, n))
            return 0
        except queue.Full:
            self.dropped += n
            return n

    def _disconnect(self) -> None:
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
        self.sock, self.connected_at = None, None

    def _run(self) -> None:
        backoff, pending = 1.0, None
        while self.alive:
            if self.sock is None:
                try:
                    self.sock = socket.create_connection((self.host, self.port), timeout=5)
                    self.sock.settimeout(SEND_TIMEOUT_S)
                    self.connected_at, backoff = time.time(), 1.0
                    self._on_error("")
                    log.info("supply stream connected to %s:%s", self.host, self.port)
                except OSError as exc:
                    self._on_error(f"Cannot reach {self.host}:{self.port}: {exc.strerror or exc}. Retrying.")
                    end = time.monotonic() + backoff
                    while self.alive and time.monotonic() < end:
                        time.sleep(0.1)
                    backoff = min(backoff * 2, 30.0)
                    continue
            if pending is None:
                try:
                    pending = self.q.get(timeout=0.5)
                except queue.Empty:
                    continue
            try:
                self.sock.sendall(pending[0])
            except OSError as exc:
                self._on_error(f"Lost {self.host}:{self.port}: {exc.strerror or exc}. Reconnecting.")
                self._disconnect()
                continue
            self.lines += pending[1]
            self.bytes += len(pending[0])
            self._on_sent(pending[1], len(pending[0]))
            pending = None
        self._disconnect()

    def close(self) -> None:
        self.alive = False
        self._disconnect()                              # unblocks a sendall stuck on a dead peer

    def view(self) -> dict[str, Any]:
        return {"addr": f"{self.host}:{self.port}", "connected": self.sock is not None, "connected_at": self.connected_at,
                "lines": self.lines, "bytes": self.bytes, "dropped": self.dropped, "queued": self.q.qsize()}


def parse_target(target: str) -> tuple[str, int]:
    """'host:port' or '[v6]:port' -> (host, port)."""
    t = (target or "").strip()
    host, sep, port = t.rpartition(":")
    host = host.strip("[]")
    if not sep or not host or not port.isdigit() or not 0 < int(port) < 65536:
        raise SupplyError(f"target must be host:port, e.g. siem.example.com:514 (got {t!r})", 422)
    return host, int(port)


def _encode(fmt: str, source_id: str, entries: list[tuple[int, str, str]]) -> bytes:
    out: list[bytes] = []
    for ts_ns, line, sev in entries:
        if fmt == "raw":
            out.append(line.encode("utf-8") + b"\n")
        elif fmt == "tagged":
            out.append(f"[{source_id}] [{sev.upper()}] {line}\n".encode("utf-8"))
        else:
            rec = raw_record(source_id, ts_ns, line, sev)
            if fmt == "json":
                out.append(json.dumps(rec, ensure_ascii=False).encode("utf-8") + b"\n")
            elif fmt == "syslog":
                out.append(lf.octet_frame(lf.to_syslog5424(rec, "raw")))
            else:
                out.append(lf.to_cef(rec, "raw").encode("utf-8") + b"\n")
    return b"".join(out)


class LogSupplyServer:
    """Centralized log streaming server on a dedicated TCP port."""

    def __init__(self, port: int = 9099, enabled: bool = False, log_type: str = "raw", source_id: str = "",
                 host: str = "127.0.0.1", allow: list[str] | None = None, brokers: str = "",
                 mode: str = "listen", target: str = "") -> None:
        self.port, self.host, self.log_type, self.source_id = port, host, log_type, source_id
        self.mode, self.target = mode, target
        self._pusher: _Pusher | None = None
        self.allow: list[str] = []
        self._nets: list[Any] = []
        self.set_allow(allow or [])
        self.brokers = brokers
        self.enabled = False
        self.last_error = ""
        self._server_socket: socket.socket | None = None
        self._clients: list[_Client] = []
        self._lock = threading.Lock()
        self._running = False
        self._threads: list[threading.Thread] = []
        self.lines_sent = self.bytes_sent = self.dropped_lines = self.refused = 0
        self.started_at: float | None = None
        if enabled:
            self.start()

    # ------------------------------------------------------------ lifecycle
    def set_allow(self, allow: list[str]) -> None:
        nets = []
        for a in (x.strip() for x in allow):
            if not a:
                continue
            try:
                nets.append(ipaddress.ip_network(a, strict=False))
            except ValueError as exc:
                raise SupplyError(f"{a!r} is not an IP address or CIDR range", 422) from exc
        self.allow, self._nets = [str(n) for n in nets], nets

    def start(self) -> bool:
        """Bind and start serving. On failure `last_error` says why and the server stays off."""
        with self._lock:
            if self._running:
                return True
            if self.log_type == "ocsf" and not self.brokers:
                self.last_error = "The OCSF stream reads normalized events from the event bus, and no bus is configured."
                self.enabled = False
                return False
            if self.mode == "push":
                return self._start_push()
            fam = socket.AF_INET6 if ":" in self.host else socket.AF_INET
            srv = socket.socket(fam, socket.SOCK_STREAM)
            try:
                srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                srv.bind((self.host, self.port))
                srv.listen(16)
                srv.settimeout(0.5)
            except OSError as exc:
                srv.close()
                self.last_error = f"Cannot listen on {self.host}:{self.port}: {exc.strerror or exc}"
                self.enabled = False
                log.error("supply stream: %s", self.last_error)
                return False
            self._server_socket, self._running, self.enabled = srv, True, True
            self.last_error, self.started_at = "", time.time()
            self._threads = [threading.Thread(target=self._accept_loop, daemon=True, name="supply-accept")]
            if self.log_type == "ocsf":
                self._threads.append(threading.Thread(target=self._bus_loop, daemon=True, name="supply-bus"))
            for t in self._threads:
                t.start()
            log.info("supply stream on %s:%s (%s)", self.host, self.port, self.log_type)
            return True

    def _start_push(self) -> bool:
        """Caller holds the lock. Connecting happens in the background; failures show in last_error."""
        try:
            host, port = parse_target(self.target)
        except SupplyError as exc:
            self.last_error, self.enabled = str(exc), False
            return False
        self._running, self.enabled, self.last_error, self.started_at = True, True, "", time.time()
        self._pusher = _Pusher(host, port, self._count, self._set_error)
        self._threads = [threading.Thread(target=self._bus_loop, daemon=True, name="supply-bus")] if self.log_type == "ocsf" else []
        for t in self._threads:
            t.start()
        log.info("supply stream pushing to %s:%s (%s)", host, port, self.log_type)
        return True

    def _set_error(self, msg: str) -> None:
        self.last_error = msg

    def stop(self) -> None:
        with self._lock:
            self._running = False
            self.enabled = False
            if self._pusher:
                self._pusher.close()
                self._pusher = None
            if self._server_socket:
                try:
                    self._server_socket.close()
                except OSError:
                    pass
                self._server_socket = None
            clients, self._clients = self._clients, []
            threads, self._threads = self._threads, []
        for c in clients:
            c.close()
        for t in threads:
            if t is not threading.current_thread():
                t.join(timeout=2)

    def configure(self, enabled: bool | None = None, port: int | None = None, log_type: str | None = None,
                  source_id: str | None = None, host: str | None = None, allow: list[str] | None = None,
                  mode: str | None = None, target: str | None = None) -> dict[str, Any]:
        """Apply options; a change to where or what it serves restarts a running server.

        Raises SupplyError for invalid options or when the server cannot start.
        """
        if log_type is not None and log_type not in STREAM_FORMATS:
            raise SupplyError(f"format must be one of {', '.join(STREAM_FORMATS)}", 422)
        if host is not None:
            try:
                ipaddress.ip_address(host.strip())
            except ValueError as exc:
                raise SupplyError(f"{host!r} is not an IP address to listen on (use 127.0.0.1 or 0.0.0.0)", 422) from exc
        if mode is not None and mode not in STREAM_MODES:
            raise SupplyError(f"mode must be one of {', '.join(STREAM_MODES)}", 422)
        if target:
            parse_target(target)
        if (mode or self.mode) == "push" and enabled and not (target if target is not None else self.target):
            raise SupplyError("push mode needs a target, the collector's host:port", 422)
        if allow is not None:
            self.set_allow(allow)
        rebind = any(v is not None and v != cur for v, cur in
                     ((port, self.port), (host and host.strip(), self.host), (log_type, self.log_type),
                      (mode, self.mode), (target and target.strip(), self.target)))
        self.mode = mode if mode is not None else self.mode
        self.target = target.strip() if target is not None else self.target
        self.port = port if port is not None else self.port
        self.host = host.strip() if host is not None else self.host
        self.log_type = log_type if log_type is not None else self.log_type
        self.source_id = source_id if source_id is not None else self.source_id
        want = self._running if enabled is None else enabled
        if self._running and (rebind or not want):
            self.stop()
        if want and not self._running and not self.start():
            raise SupplyError(self.last_error)
        return self.status()

    # ------------------------------------------------------------ serving
    def _count(self, n: int, size: int) -> None:
        with self._lock:
            self.lines_sent += n
            self.bytes_sent += size

    def _accept_loop(self) -> None:
        while self._running and self._server_socket:
            try:
                sock, addr = self._server_socket.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            ip = ipaddress.ip_address(addr[0])
            ip = getattr(ip, "ipv4_mapped", None) or ip       # dual-stack binds report IPv4 as ::ffff:a.b.c.d
            if self._nets and not any(ip in n for n in self._nets):
                self.refused += 1
                log.warning("supply stream refused %s (not in allowlist)", addr[0])
                sock.close()
                continue
            with self._lock:
                self._clients.append(_Client(sock, addr[:2], self._count))
            log.info("supply client connected from %s:%s", addr[0], addr[1])

    def _fanout(self, data: bytes, n: int) -> None:
        with self._lock:
            self._clients = [c for c in self._clients if c.alive]
            clients: list[Any] = list(self._clients) + ([self._pusher] if self._pusher else [])
        dropped = sum(c.offer(data, n) for c in clients)
        if dropped:
            with self._lock:
                self.dropped_lines += dropped

    def broadcast(self, source_id: str, entries: list[tuple[int, str, str]]) -> None:
        """Called by the ingest pipeline for every stored chunk of raw lines."""
        if not self._running or not (self._clients or self._pusher) or self.log_type == "ocsf":
            return
        if self.source_id and self.source_id != source_id:
            return
        if entries:
            self._fanout(_encode(self.log_type, source_id, entries), len(entries))

    def _bus_loop(self) -> None:
        """Tail `normalized` from now on under a private group, so every stream sees every event."""
        try:
            from confluent_kafka import Consumer
            c = Consumer({"bootstrap.servers": self.brokers, "group.id": f"studio-supply-{uuid.uuid4().hex[:12]}",
                          "auto.offset.reset": "latest", "enable.auto.commit": False})
            c.subscribe([NORMALIZED_TOPIC])
        except Exception as exc:                                             # noqa: BLE001
            self.last_error = f"Cannot read the event bus: {exc}"
            log.error("supply stream: %s", self.last_error)
            return
        try:
            while self._running:
                batch = []
                for m in c.consume(1000, timeout=0.5):
                    if m.error() or not m.value():
                        continue
                    if self.source_id and (m.key() or b"").decode("utf-8", "replace") != self.source_id:
                        continue
                    batch.append(m.value().rstrip(b"\n") + b"\n")
                if batch and (self._clients or self._pusher):
                    self._fanout(b"".join(batch), len(batch))
        finally:
            c.close()

    def status(self) -> dict[str, Any]:
        with self._lock:
            clients = [c.view() for c in self._clients if c.alive] + ([self._pusher.view()] if self._pusher else [])
            return {
                "active": self._running, "enabled": self.enabled, "mode": self.mode, "target": self.target,
                "host": self.host, "port": self.port,
                "log_type": self.log_type, "source_id": self.source_id, "allow": self.allow,
                "clients_count": sum(1 for c in clients if c.get("connected", True)), "clients": clients,
                "lines_sent": self.lines_sent, "bytes_sent": self.bytes_sent,
                "dropped_lines": self.dropped_lines, "refused": self.refused,
                "started_at": self.started_at, "last_error": self.last_error,
                "bus": bool(self.brokers), "formats": list(STREAM_FORMATS), "modes": list(STREAM_MODES),
            }


def raw_record(source_id: str, ts_ns: int, line: str, severity: str) -> dict[str, Any]:
    """One raw line as exported and streamed: the verbatim text plus the hash that proves it."""
    return {"time": lf.iso_ns(ts_ns), "timestamp_ns": ts_ns, "source_id": source_id, "severity": severity,
            "sha256": hashlib.sha256(line.encode("utf-8")).hexdigest(), "line": line}


# --------------------------------------------------------------------------- Report Exporters
def build_report_data(st: Any, source_id: str = "", window_s: int = 300, categories: list[str] | None = None) -> dict[str, Any]:
    """Collect system overview, stats, sources, and metrics into a report dictionary.

    The report is a snapshot of the live overview: rates cover its fixed 5-minute window and totals
    cover everything since Studio started. With `source_id`, per-source figures replace the fleet ones.
    """
    from ..api.stats import overview as get_overview
    ov = get_overview()
    now_ts = int(time.time())
    src_row = next((s for s in ov.get("sources", []) if s.get("id") == source_id), None) if source_id else None
    if source_id and src_row is None:
        raise ExportError(f"unknown source {source_id!r}", 404)

    categories_set = set(categories or ["kpis", "sources", "severity", "normalized", "usage", "history", "insights", "traffic", "storage"])

    report: dict[str, Any] = {
        "title": "Aletheia Centralized Log Pipeline Report",
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(now_ts)),
        "epoch_seconds": now_ts,
        "window_s": ov.get("window_s", window_s),
        "scope": source_id or "all sources",
    }

    if "kpis" in categories_set:
        report["kpis"] = dict(ov.get("kpis", {}))
        if src_row:
            report["kpis"].update({"lines": src_row.get("lines", 0), "bytes": src_row.get("bytes", 0),
                                   "eps": src_row.get("eps", 0), "errors": src_row.get("errors", 0), "sources": 1,
                                   "connected": int(src_row.get("status") in ("connected", "passive") and bool(src_row.get("enabled")))})
        report["kpis"]["store_backend"] = ov.get("store")
        report["kpis"]["bus_enabled"] = ov.get("bus")

    if "sources" in categories_set:
        report["sources"] = [src_row] if src_row else ov.get("sources", [])

    if "severity" in categories_set:
        by = src_row.get("by_severity", {}) if src_row else ov.get("by_severity", {})
        report["by_severity"] = {k: by.get(k, 0) for k in ("info", "notice", "warn", "risk")}

    if "normalized" in categories_set:
        report["normalized_ocsf"] = ov.get("normalized", {})

    if "usage" in categories_set:
        snap = st.usage.snapshot()
        report["system_usage"] = {
            "llm_requests_last_hour": snap.get("requests_last_hour", snap.get("requests", 0)),
            "tokens": (snap.get("prompt_tokens", 0) or 0) + (snap.get("completion_tokens", 0) or 0),
            "airgap_active": getattr(st.settings, "airgap", False),
        }

    if "history" in categories_set:
        hist = ov.get("history", [])
        report["history"] = [h for h in hist if h.get("source") == source_id] if source_id else hist

    ins = ov.get("insights", {})
    if "insights" in categories_set:
        report["insights"] = _insights_section(ov)
    if "traffic" in categories_set:
        report["traffic"] = _traffic_section(ins.get("ch", {}))
    if "storage" in categories_set:
        report["storage"] = _storage_section(ov)

    return report


# --------------------------------------------------------------------------- Analytics sections
_ACTIONS = {0: "unknown", 1: "allowed", 2: "denied", 3: "observed", 4: "modified"}
_SEV = {0: "unknown", 1: "informational", 2: "low", 3: "medium", 4: "high", 5: "critical"}
_CLASSES = {1001: "File activity", 1007: "Process activity", 2004: "Detection finding", 3001: "Account change", 3002: "Authentication",
            4001: "Network activity", 4002: "HTTP activity", 4003: "DNS activity", 4007: "SSH activity", 6003: "API activity"}


def _b(n: float) -> str:
    v, i = float(n), 0
    while v >= 1024 and i < 4:
        v /= 1024
        i += 1
    return f"{v:.0f} {'B KB MB GB TB'.split()[i]}" if v >= 100 or i == 0 else f"{v:.1f} {'B KB MB GB TB'.split()[i]}"


def _dur(s: Any) -> str:
    return "n/a" if s is None else f"{s}s" if s < 60 else f"{round(s / 60)}m" if s < 3600 else f"{s / 3600:.1f}h"


def _findings(ov: dict[str, Any]) -> list[dict[str, str]]:
    """Plain-language findings; mirrors the Overview page so the report says what the dashboard says."""
    ins, k, nm = ov.get("insights", {}), ov.get("kpis", {}), ov.get("normalized", {})
    ch, out = ins.get("ch", {}), []
    disk, base = ch.get("disk", {}).get("events"), ch.get("disk", {}).get("baseline_events")
    if disk and base and base["compressed"] > 0 and disk["compressed"] > 0:
        pct = round((1 - disk["compressed"] / base["compressed"]) * 100)
        out.append({"tone": "ok" if pct > 0 else "info", "title": f"{pct}% smaller than a raw + JSON baseline store" if pct > 0 else "Comparable to a raw + JSON baseline store",
                    "body": f"{_b(disk['compressed'])} on disk vs {_b(base['compressed'])} for the baseline, with a SHA-256 kept on every event."})
    if disk and k.get("bytes") and disk["compressed"] > 0:
        out.append({"tone": "ok", "title": f"{k['bytes'] / disk['compressed']:.1f}x reduction from raw log bytes",
                    "body": f"{_b(k['bytes'])} of raw lines became {_b(disk['compressed'])} of normalized, queryable events."})
    if ins.get("spike"):
        out.append({"tone": "warn", "title": "Ingest spike detected", "body": f"Rate is {ins.get('z')} sigma above the 5-minute mean (peak {ins.get('peak_eps')}/s)."})
    top = (ins.get("risk_rank") or [None])[0]
    if top and top["risk"] > 0:
        out.append({"tone": "bad" if top["pct"] >= 20 else "warn", "title": f"{top['id']} is the risk hotspot", "body": f"{top['pct']}% of its {top['lines']:,} lines are risk-severity."})
    elif k.get("lines"):
        out.append({"tone": "ok", "title": "No risk-severity lines observed", "body": "Every ingested line is info, notice or warn."})
    sc = (ch.get("scanners") or [None])[0]
    if sc:
        out.append({"tone": "bad" if sc["n"] >= 15 else "warn", "title": f"Possible port scan from {sc['k']}", "body": f"Touched {sc['n']} distinct destination ports; {len(ch['scanners'])} suspect source(s)."})
    lag = ch.get("lag") or {}
    if lag.get("denied") and nm.get("total"):
        out.append({"tone": "info", "title": f"{round(100 * lag['denied'] / nm['total'])}% of traffic was denied", "body": f"{lag['denied']:,} denied connections."})
    if lag.get("skewed"):
        out.append({"tone": "warn", "title": f"{lag['skewed']:,} events have clock skew", "body": "Log timestamps disagree with arrival time by over an hour; check source timezones."})
    if ins.get("stale"):
        out.append({"tone": "warn", "title": f"{ins['stale']} source(s) have gone quiet", "body": "No lines for over a minute on an enabled source."})
    if k.get("in_review"):
        out.append({"tone": "warn", "title": f"{k['in_review']} source(s) waiting for approval", "body": "Events stay raw until a pack is approved."})
    if k.get("errors"):
        out.append({"tone": "bad", "title": f"{k['errors']:,} pipeline errors", "body": f"Error rate {ins.get('error_rate')}% of lines."})
    if nm.get("available") and nm.get("total"):
        out.append({"tone": "ok" if nm.get("normalized_pct", 0) >= 90 else "warn", "title": f"{nm.get('normalized_pct')}% of events parsed into OCSF",
                    "body": f"{nm.get('raw_only', 0):,} raw-only events; {nm.get('templates', 0):,} templates."})
    return out


def _insights_section(ov: dict[str, Any]) -> dict[str, Any]:
    ins, k, nm = ov.get("insights", {}), ov.get("kpis", {}), ov.get("normalized", {})
    ch = ins.get("ch", {})
    lag, u = ch.get("lag") or {}, ch.get("unique") or {}
    p = ins.get("posture", 0)
    return {
        "posture": p, "posture_label": "healthy" if p >= 80 else "attention" if p >= 55 else "at risk",
        "findings": _findings(ov),
        "ingest": {"ingest_eps": k.get("eps"), "eps_last_minute": ins.get("eps_min"), "trend_vs_prev_minute_pct": ins.get("trend_pct"),
                   "peak_eps": ins.get("peak_eps"), "mean_eps_5m": ins.get("mean_eps"), "burst_score_sigma": ins.get("z"),
                   "projected_lines_per_day": ins.get("proj_day_lines"), "projected_raw_bytes_per_day": ins.get("proj_day_bytes"),
                   "avg_line_bytes": ins.get("bytes_per_line"), "seconds_since_last_line": ins.get("freshness_s"),
                   "busiest_source": ins.get("noisiest")},
        "threat": {"risk_share_pct": k.get("risk_pct"), "warn_plus_risk_pct": ins.get("warn_pct"), "denied_events": lag.get("denied"),
                   "port_scan_suspects": len(ch.get("scanners") or []), "fanout_sources": len(ch.get("fanout") or []),
                   "pipeline_errors": k.get("errors"), "pipeline_error_rate_pct": ins.get("error_rate")},
        "integrity": {"events_normalized_pct": nm.get("normalized_pct"), "templates": nm.get("templates"), "avg_fields_per_event": lag.get("avg_vars"),
                      "tamper_evident_pct": round(100 * u["hashed"] / u["n"], 1) if u.get("n") else None, "merkle_batches": u.get("mb"),
                      "ingest_lag_avg_ms": lag.get("avg_ms") if lag.get("good") else None, "ingest_lag_p95_ms": lag.get("p95_ms") if lag.get("good") else None,
                      "clock_skewed_events": lag.get("skewed")},
        "governance": {"sources_online": f"{k.get('connected')}/{k.get('sources')}", "quiet_sources": ins.get("stale"),
                       "onboarded_pct": ins.get("onboarded_pct"), "mean_time_to_approve": _dur(ins.get("mean_approval_s")), "packs_approved": k.get("packs")},
        "risk_leaderboard": [{"source": r["id"], "risk_lines": r["risk"], "lines": r["lines"], "risk_pct": r["pct"]} for r in ins.get("risk_rank", []) if r["risk"]],
    }


def _traffic_section(ch: dict[str, Any]) -> dict[str, Any]:
    if not ch.get("available"):
        return {"available": False}
    named = lambda rows, f: [{"name": f(r["k"]), "count": r["n"]} for r in rows or []]   # noqa: E731
    plain = lambda rows: named(rows, str)                                                 # noqa: E731
    u = ch.get("unique") or {}
    return {"available": True, "unique_src_ips": u.get("si"), "unique_dst_ips": u.get("di"), "unique_users": u.get("us"),
            "top_source_ips": plain(ch.get("top_src")), "top_destination_ips": plain(ch.get("top_dst")), "top_destination_ports": plain(ch.get("top_ports")),
            "top_users": plain(ch.get("top_users")), "most_blocked_sources": plain(ch.get("top_denied")),
            "port_scan_suspects": [{"name": r["k"], "count": r["n"]} for r in ch.get("scanners") or []],
            "fanout_sources": [{"name": r["k"], "count": r["n"]} for r in ch.get("fanout") or []],
            "protocols": plain(ch.get("protocols")), "firewall_actions": named(ch.get("actions"), lambda k: _ACTIONS.get(int(k), f"action {k}")),
            "ocsf_severity": named(ch.get("ocsf_sev"), lambda k: _SEV.get(int(k), f"sev {k}")),
            "ocsf_classes": named(ch.get("classes"), lambda k: _CLASSES.get(int(k), f"class {k}")), "busiest_templates": plain(ch.get("top_templates"))}


def _storage_section(ov: dict[str, Any]) -> dict[str, Any]:
    ch, raw = ov.get("insights", {}).get("ch", {}), ov.get("kpis", {}).get("bytes", 0)
    disk, base, modes = ch.get("disk", {}).get("events"), ch.get("disk", {}).get("baseline_events"), ch.get("modes") or {}
    if not disk:
        return {"available": False}
    tm = modes.get("template", 0) + modes.get("verbatim", 0)
    return {"available": True, "raw_bytes": raw, "aletheia_bytes": disk["compressed"], "baseline_bytes": base["compressed"] if base else None,
            "reduction_vs_raw": round(raw / disk["compressed"], 2) if disk["compressed"] and raw else None,
            "smaller_than_baseline_pct": round((1 - disk["compressed"] / base["compressed"]) * 100, 1) if base and base["compressed"] else None,
            "bytes_per_event": round(disk["compressed"] / disk["rows"]) if disk["rows"] else None, "space_saved_bytes": max(0, raw - disk["compressed"]),
            "template_mode_pct": round(100 * modes.get("template", 0) / tm, 1) if tm else None}


_WORDS = {"eps": "EPS", "pct": "%", "ms": "(ms)", "ips": "IPs", "ip": "IP", "ocsf": "OCSF", "p95": "p95", "5m": "(5 min)", "prev": "previous", "avg": "average"}


def _label(k: str) -> str:
    words = [_WORDS.get(w, w) for w in k.split("_")]
    return " ".join(words).capitalize() if words[0] not in _WORDS.values() else " ".join(words)


def analytics_blocks(r: dict[str, Any]) -> list[tuple[str, str, Any]]:
    """Flatten the insights/traffic/storage sections into (title, kind, payload) for every output format.

    kind is `findings` (list of dicts), `kv` (list of pairs) or `table` ((header, rows)).
    """
    blocks: list[tuple[str, str, Any]] = []
    i, t, sg = r.get("insights"), r.get("traffic"), r.get("storage")
    if i:
        blocks.append((f"Posture: {i['posture']}/100 ({i['posture_label']})", "findings", i["findings"]))
        for key, title in (("ingest", "Ingest analytics"), ("threat", "Threat signals"), ("integrity", "Normalization & integrity"), ("governance", "Governance")):
            blocks.append((title, "kv", [(_label(k), "n/a" if v is None else f"{v:,}" if isinstance(v, int) else v) for k, v in i[key].items()]))
        if i["risk_leaderboard"]:
            blocks.append(("Risk leaderboard", "table", (["Source", "Risk lines", "Lines", "Risk %"],
                           [[x["source"], f"{x['risk_lines']:,}", f"{x['lines']:,}", x["risk_pct"]] for x in i["risk_leaderboard"]])))
    if t is not None:
        if not t.get("available"):
            blocks.append(("Traffic analysis", "kv", [("Status", "Event store unavailable")]))
        else:
            blocks.append(("Traffic analysis", "kv", [("Unique source IPs", t["unique_src_ips"]), ("Unique destination IPs", t["unique_dst_ips"]), ("Unique users", t["unique_users"])]))
            for key in ("top_source_ips", "top_destination_ips", "top_destination_ports", "top_users", "most_blocked_sources", "port_scan_suspects",
                        "fanout_sources", "protocols", "firewall_actions", "ocsf_severity", "ocsf_classes", "busiest_templates"):
                if t.get(key):
                    blocks.append((_label(key), "table", (["Name", "Count"], [[x["name"], f"{x['count']:,}"] for x in t[key]])))
    if sg is not None:
        if not sg.get("available"):
            blocks.append(("Storage efficiency", "kv", [("Status", "Event store unavailable")]))
        else:
            blocks.append(("Storage efficiency", "kv", [
                ("Raw log bytes", _b(sg["raw_bytes"])), ("Aletheia on disk", _b(sg["aletheia_bytes"])),
                ("Baseline (raw + JSON)", _b(sg["baseline_bytes"]) if sg["baseline_bytes"] else "n/a"),
                ("Reduction vs raw", f"{sg['reduction_vs_raw']}x" if sg["reduction_vs_raw"] else "n/a"),
                ("Smaller than baseline", f"{sg['smaller_than_baseline_pct']}%" if sg["smaller_than_baseline_pct"] is not None else "n/a"),
                ("Bytes per event (compressed)", sg["bytes_per_event"] if sg["bytes_per_event"] is not None else "n/a"),
                ("Space saved vs raw", _b(sg["space_saved_bytes"])), ("Stored as template + vars", f"{sg['template_mode_pct']}%" if sg["template_mode_pct"] is not None else "n/a")]))
    return blocks


def generate_reportlab_pdf(report_data: dict[str, Any]) -> bytes:
    """Branded PDF report covering every collected stats section."""
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    brand, ink, muted, line, soft = (colors.HexColor(c) for c in ("#1c58c9", "#0f172a", "#64748b", "#d5dce8", "#f4f7fc"))
    base = getSampleStyleSheet()["Normal"]
    cell = ParagraphStyle("c", parent=base, fontSize=8.5, leading=11, textColor=colors.HexColor("#334155"))
    head = ParagraphStyle("h", parent=cell, fontName="Helvetica-Bold", textColor=ink)
    h2 = ParagraphStyle("h2", parent=base, fontName="Helvetica-Bold", fontSize=12, leading=15, textColor=brand, spaceBefore=14, spaceAfter=6)
    title_style = ParagraphStyle("t", parent=base, fontName="Helvetica-Bold", fontSize=20, leading=24, textColor=ink)
    sub = ParagraphStyle("s", parent=base, fontSize=9, leading=13, textColor=muted, spaceAfter=8)

    def esc(v: Any) -> str:
        return str(v if v is not None else "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    def table(rows: list[list[Any]], widths: list[int], header: bool = True) -> Table:
        data = [[Paragraph(esc(c), head if (header and i == 0) else cell) for c in r] for i, r in enumerate(rows)]
        t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
        style = [("BOX", (0, 0), (-1, -1), 0.5, line), ("INNERGRID", (0, 0), (-1, -1), 0.5, line),
                 ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                 ("ROWBACKGROUNDS", (0, 1 if header else 0), (-1, -1), [colors.white, soft])]
        if header:
            style.append(("BACKGROUND", (0, 0), (-1, 0), soft))
        t.setStyle(TableStyle(style))
        return t

    def kv(pairs: list[tuple[str, Any]]) -> Table:
        rows = [[k, v] for k, v in pairs]
        return table(rows, [220, 320], header=False)

    def banner(canvas: Any, doc: Any) -> None:
        w, h = letter
        canvas.saveState()
        canvas.setFillColor(brand)
        canvas.rect(0, h - 54, w, 54, stroke=0, fill=1)
        canvas.setFillColor(colors.white)
        # Logo mark: same hexagon + triangle as the app sidebar (24-unit grid, y flipped)
        ox, oy, sc = 36, h - 45, 1.4
        pt = lambda x, y: (ox + x * sc, oy + (24 - y) * sc)   # noqa: E731
        canvas.setStrokeColor(colors.white)
        canvas.setLineWidth(1.6)
        canvas.setLineJoin(1)
        for poly in ([(12, 3), (20, 7.5), (20, 16.5), (12, 21), (4, 16.5), (4, 7.5)], [(12, 8.2), (15.4, 15.8), (8.6, 15.8)]):
            path = canvas.beginPath()
            path.moveTo(*pt(*poly[0]))
            for q in poly[1:]:
                path.lineTo(*pt(*q))
            path.close()
            canvas.drawPath(path, stroke=1, fill=0)
        canvas.setFont("Helvetica-Bold", 18)
        canvas.drawString(36 + 24 * sc + 8, h - 35, "ALETHEIA")
        canvas.setFont("Helvetica", 9)
        canvas.drawRightString(w - 36, h - 33, "Centralized Log Intelligence")
        canvas.setFillColor(muted)
        canvas.setFont("Helvetica", 8)
        canvas.drawString(36, 22, "Aletheia Studio  |  Confidential operational report")
        canvas.drawRightString(w - 36, 22, f"Page {doc.page}")
        canvas.restoreState()

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=letter, leftMargin=36, rightMargin=36, topMargin=78, bottomMargin=44,
                            title=report_data.get("title", "Aletheia Report"), author="Aletheia")
    r = report_data
    story: list[Any] = [Paragraph(esc(r.get("title", "Aletheia Report")), title_style),
                        Paragraph(f"Generated {esc(r.get('generated_at', ''))} &nbsp;|&nbsp; Scope: {esc(r.get('scope', 'all sources'))}"
                                  f" &nbsp;|&nbsp; Rates over the last {r.get('window_s', 300) // 60} min", sub)]

    k = r.get("kpis")
    if k:
        story.append(Paragraph("Key Performance Indicators", h2))
        pairs = [("Stored lines", f"{k.get('lines', 0):,}"), ("Raw volume", f"{k.get('bytes', 0) / 1048576:.2f} MB"),
                 ("Ingest EPS", k.get("eps", 0)), ("Sources (connected / total)", f"{k.get('connected', 0)} / {k.get('sources', 0)}"),
                 ("Review / Approved / Rejected", f"{k.get('in_review', 0)} / {k.get('approved', 0)} / {k.get('rejected', 0)}"),
                 ("Risk share", f"{k.get('risk_pct', 0)}%"), ("Errors", k.get("errors", 0)),
                 ("Buffered / Forwarded", f"{k.get('buffered', 0)} / {k.get('forwarded', 0)}"),
                 ("Approved packs", k.get("packs", 0)), ("Store backend", k.get("store_backend")),
                 ("Message bus", "enabled" if k.get("bus_enabled") else "disabled")]
        story.append(kv(pairs))

    if r.get("sources"):
        story.append(Paragraph(f"Log Sources ({len(r['sources'])})", h2))
        rows = [["Source", "Type", "State", "Status", "Lines", "KB", "Errors", "EPS"]]
        rows += [[s.get("id"), s.get("type"), s.get("state"), s.get("status"), f"{(s.get('lines') or 0):,}",
                  f"{(s.get('bytes') or 0) / 1024:.1f}", s.get("errors") or 0, s.get("eps") or 0] for s in r["sources"]]
        story.append(table(rows, [110, 60, 65, 70, 65, 55, 45, 40]))

    if r.get("by_severity"):
        story.append(Paragraph("Severity Breakdown", h2))
        tot = sum(r["by_severity"].values()) or 1
        rows = [["Severity", "Records", "Share"]] + [[n.upper(), f"{v:,}", f"{100 * v / tot:.1f}%"] for n, v in r["by_severity"].items()]
        story.append(table(rows, [180, 180, 180]))

    n = r.get("normalized_ocsf")
    if n is not None:
        story.append(Paragraph("OCSF Normalization", h2))
        if n.get("available"):
            story.append(kv([("Total events", f"{n.get('total', 0):,}"), ("Fully normalized", f"{n.get('full', 0):,}"),
                             ("Partially normalized", f"{n.get('partial', 0):,}"), ("Raw only", f"{n.get('raw_only', 0):,}"),
                             ("Templates", n.get("templates", 0)), ("Normalization rate", f"{n.get('normalized_pct', 0)}%")]))
        else:
            story.append(Paragraph("Event store unavailable; no normalization data.", cell))

    u = r.get("system_usage")
    if u:
        story.append(Paragraph("LLM Usage", h2))
        story.append(kv([("Requests (last hour)", u.get("llm_requests_last_hour", 0)), ("Tokens", f"{u.get('tokens', 0):,}"),
                         ("Air-gap mode", "active" if u.get("airgap_active") else "off")]))

    if r.get("history"):
        story.append(Paragraph("Recent Source Activity", h2))
        rows = [["Time", "Source", "Action", "Detail"]]
        for h in r["history"]:
            rows.append([time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(h.get("at", 0))), h.get("source"), h.get("action"),
                         h.get("note") or h.get("detail") or ""])
        story.append(table(rows, [110, 110, 90, 230]))

    for title, kind, payload in analytics_blocks(r):
        story.append(Paragraph(esc(title), h2))
        if kind == "findings":
            story.append(table([["", "Finding", "Detail"]] + [[f["tone"].upper(), f["title"], f["body"]] for f in payload] if payload
                               else [["No findings yet"]], [50, 200, 290] if payload else [540]))
        elif kind == "kv":
            story.append(kv(payload))
        else:
            hdr, rows = payload
            story.append(table([hdr] + rows, [540 - 90 * (len(hdr) - 1)] + [90] * (len(hdr) - 1)))

    doc.build(story, onFirstPage=banner, onLaterPages=banner)
    return buf.getvalue()


def format_report(report_data: dict[str, Any], fmt: str = "pdf") -> tuple[bytes | str, str, str]:
    """Format report dict into string output, content-type, and file extension.

    Returns: (formatted_content_str, mime_type, file_extension)
    """
    fmt = fmt.lower()

    if fmt == "csv":
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["=== ALETHEIA SYSTEM REPORT ==="])
        writer.writerow(["Generated At", report_data.get("generated_at", "")])
        writer.writerow([])
        if "kpis" in report_data:
            writer.writerow(["=== KEY PERFORMANCE INDICATORS ==="])
            writer.writerow(["Metric", "Value"])
            for k, v in report_data["kpis"].items():
                writer.writerow([k, v])
            writer.writerow([])
        if "sources" in report_data:
            writer.writerow(["=== SOURCES SUMMARY ==="])
            writer.writerow(["ID", "Type", "State", "Status", "Lines", "Bytes", "Errors", "EPS"])
            for s in report_data["sources"]:
                writer.writerow([s.get("id"), s.get("type"), s.get("state"), s.get("status"),
                                 s.get("lines"), s.get("bytes"), s.get("errors"), s.get("eps")])
            writer.writerow([])
        if "by_severity" in report_data:
            writer.writerow(["=== SEVERITY BREAKDOWN ==="])
            writer.writerow(["Severity", "Count"])
            for k, v in report_data["by_severity"].items():
                writer.writerow([k, v])
            writer.writerow([])
        for title, kind, payload in analytics_blocks(report_data):
            writer.writerow([f"=== {title.upper()} ==="])
            if kind == "findings":
                writer.writerow(["Tone", "Finding", "Detail"])
                writer.writerows([[f["tone"], f["title"], f["body"]] for f in payload])
            elif kind == "kv":
                writer.writerow(["Metric", "Value"])
                writer.writerows([list(x) for x in payload])
            else:
                writer.writerow(payload[0])
                writer.writerows(payload[1])
            writer.writerow([])
        return buf.getvalue(), "text/csv", "csv"

    elif fmt in ("md", "markdown"):
        lines = [
            f"# {report_data.get('title', 'Aletheia Pipeline Report')}",
            f"**Generated:** {report_data.get('generated_at', '')} · **Scope:** {report_data.get('scope', 'all sources')}\n",
        ]
        if "kpis" in report_data:
            lines.append("## Executive Summary (KPIs)")
            for k, v in report_data["kpis"].items():
                lines.append(f"- **{k.replace('_', ' ').title()}:** {v}")
            lines.append("")
        if "sources" in report_data:
            lines.append("## Connected Log Sources")
            lines.append("| Source ID | Type | State | Status | Lines | Bytes | Errors | EPS |")
            lines.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
            for s in report_data["sources"]:
                lines.append(f"| `{s.get('id')}` | {s.get('type')} | {s.get('state')} | {s.get('status')} | {(s.get('lines') or 0):,} | {(s.get('bytes') or 0):,} | {s.get('errors')} | {s.get('eps')} |")
            lines.append("")
        if "by_severity" in report_data:
            lines.append("## Severity Distribution")
            for k, v in report_data["by_severity"].items():
                lines.append(f"- **{k.upper()}:** {(v or 0):,}")
            lines.append("")
        if "normalized_ocsf" in report_data:
            lines.append("## OCSF Normalization Status")
            norm = report_data["normalized_ocsf"]
            lines.append(f"- Available: {norm.get('available')}")
            if norm.get("available"):
                lines.append(f"- Total Events: {norm.get('total', 0):,}")
                lines.append(f"- Fully Normalized: {norm.get('full', 0):,}")
                lines.append(f"- Partially Normalized: {norm.get('partial', 0):,}")
                lines.append(f"- Raw Only: {norm.get('raw_only', 0):,}")
                lines.append(f"- Templates Registered: {norm.get('templates', 0):,}")
                lines.append(f"- Normalization Rate: {norm.get('normalized_pct', 0)}%")
            lines.append("")
        for title, kind, payload in analytics_blocks(report_data):
            lines.append(f"## {title}")
            if kind == "findings":
                lines += [f"- **[{f['tone'].upper()}] {f['title']}** — {f['body']}" for f in payload] or ["- No findings yet"]
            elif kind == "kv":
                lines += [f"- **{k}:** {v}" for k, v in payload]
            else:
                lines += ["| " + " | ".join(payload[0]) + " |", "| " + " | ".join("---" for _ in payload[0]) + " |"]
                lines += ["| " + " | ".join(str(c) for c in row) + " |" for row in payload[1]]
            lines.append("")
        return "\n".join(lines), "text/markdown", "md"

    elif fmt == "pdf":
        pdf_bytes = generate_reportlab_pdf(report_data)
        return pdf_bytes, "application/pdf", "pdf"

    elif fmt == "html":
        import html as _h
        title = _h.escape(report_data.get("title", "Aletheia Pipeline Report"))
        gen_at = report_data.get("generated_at", "")
        kpis = report_data.get("kpis", {})
        sources = report_data.get("sources", [])
        sev = report_data.get("by_severity", {})
        norm = report_data.get("normalized_ocsf", {})

        src_rows = "".join([
            f"<tr><td><code>{s.get('id')}</code></td><td>{s.get('type')}</td><td><span class='badge'>{s.get('state')}</span></td><td>{s.get('status')}</td><td>{(s.get('lines') or 0):,}</td><td>{(s.get('bytes') or 0):,}</td><td>{s.get('errors')}</td><td>{s.get('eps')}</td></tr>"
            for s in sources
        ])
        kpi_cards = "".join([
            f"<div class='card'><div class='card-title'>{k.replace('_', ' ').title()}</div><div class='card-val'>{v}</div></div>"
            for k, v in kpis.items()
        ])
        sev_items = "".join([
            f"<div class='sev-item'><strong>{k.upper()}:</strong> {(v or 0):,}</div>"
            for k, v in sev.items()
        ])

        extra = ""
        for btitle, kind, payload in analytics_blocks(report_data):
            e = _h.escape
            if kind == "findings":
                body = "".join(f"<div class='find {f['tone']}'><strong>{e(f['title'])}</strong><span>{e(f['body'])}</span></div>" for f in payload) or "<p>No findings yet</p>"
            elif kind == "kv":
                body = "<div class='grid'>" + "".join(f"<div class='card'><div class='card-title'>{e(str(k))}</div><div class='card-val sm'>{e(str(v))}</div></div>" for k, v in payload) + "</div>"
            else:
                body = "<table><thead><tr>" + "".join(f"<th>{e(str(c))}</th>" for c in payload[0]) + "</tr></thead><tbody>" + \
                       "".join("<tr>" + "".join(f"<td>{e(str(c))}</td>" for c in row) + "</tr>" for row in payload[1]) + "</tbody></table>"
            extra += f"<h2>{e(btitle)}</h2>{body}"

        html_content = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>{title}</title>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; max-width: 1100px; margin: 0 auto; }}
        h1 {{ color: #38bdf8; font-size: 1.8rem; margin-bottom: 0.25rem; }}
        .sub {{ color: #94a3b8; font-size: 0.9rem; margin-bottom: 2rem; }}
        h2 {{ color: #f1f5f9; border-bottom: 1px solid #334155; padding-bottom: 0.5rem; margin-top: 2rem; }}
        .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 2rem; }}
        .card {{ background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 1rem; }}
        .card-title {{ font-size: 0.8rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; }}
        .card-val {{ font-size: 1.5rem; font-weight: 700; color: #38bdf8; margin-top: 0.5rem; }}
        table {{ width: 100%; border-collapse: collapse; margin-top: 1rem; background: #1e293b; border-radius: 8px; overflow: hidden; }}
        th, td {{ padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #334155; font-size: 0.9rem; }}
        th {{ background: #0f172a; color: #94a3b8; font-weight: 600; }}
        .badge {{ background: #0284c7; color: white; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; }}
        .flex {{ display: flex; gap: 1.5rem; flex-wrap: wrap; }}
        .sev-item {{ background: #1e293b; border: 1px solid #334155; padding: 0.75rem 1.25rem; border-radius: 6px; font-size: 1rem; }}
        code {{ font-family: monospace; color: #38bdf8; }}
        .card-val.sm {{ font-size: 1.1rem; }}
        .find {{ display: flex; flex-direction: column; gap: 2px; background: #1e293b; border-left: 4px solid #38bdf8; border-radius: 6px; padding: 0.7rem 1rem; margin: 0.5rem 0; }}
        .find span {{ color: #94a3b8; font-size: 0.85rem; }}
        .find.ok {{ border-left-color: #22c55e; }} .find.warn {{ border-left-color: #f59e0b; }} .find.bad {{ border-left-color: #ef4444; }}
    </style>
</head>
<body>
    <h1>{title}</h1>
    <div class="sub">Generated at {gen_at} · Scope: {_h.escape(str(report_data.get("scope", "all sources")))}</div>
    
    <h2>System Key Performance Indicators</h2>
    <div class="grid">{kpi_cards}</div>
    
    <h2>Connected Log Sources ({len(sources)})</h2>
    <table>
        <thead>
            <tr><th>Source ID</th><th>Type</th><th>State</th><th>Status</th><th>Lines</th><th>Bytes</th><th>Errors</th><th>EPS</th></tr>
        </thead>
        <tbody>{src_rows}</tbody>
    </table>
    
    <h2>Severity Distribution</h2>
    <div class="flex">{sev_items}</div>
    {extra}
</body>
</html>"""
        return html_content, "text/html", "html"

    else:  # json default
        return json.dumps(report_data, indent=2), "application/json", "json"


# --------------------------------------------------------------------------- Logs Exporters
DATASETS = ("raw", "ocsf", "system")
LOG_FORMATS: dict[str, tuple[str, str]] = {
    "json": ("application/json", "json"), "jsonl": ("application/x-ndjson", "jsonl"),
    "csv": ("text/csv", "csv"), "tsv": ("text/tab-separated-values", "tsv"), "text": ("text/plain", "log"),
    "syslog": ("text/plain", "syslog"), "cef": ("text/plain", "cef"), "leef": ("text/plain", "leef"),
    "xml": ("application/xml", "xml"),
}
MAX_EXPORT = 50_000
_RAW_PAGE = 5_000            # Loki's default max_entries_limit_per_query
# Ingest severity words against OCSF severity_id (CONTRACTS §5 maps syslog PRI the same way).
_OCSF_SEV = {"info": "severity_id <= 1", "notice": "severity_id = 2", "warn": "severity_id = 3", "risk": "severity_id >= 4"}


class ExportError(Exception):
    """A request the exporter cannot serve; `status` is the HTTP code to answer with."""

    def __init__(self, msg: str, status: int = 422) -> None:
        super().__init__(msg)
        self.status = status


def _raw_paged(store: Any, sid: str, limit: int, text: str | None, severity: str | None,
               start_ns: int | None, end_ns: int | None) -> list[dict[str, Any]]:
    """Newest-first lines for one source, paging past the store's per-query cap.

    Each page ends at the oldest timestamp seen so far (inclusive), and lines already returned at
    that boundary are skipped, so equal timestamps are neither lost nor duplicated.
    """
    out: list[dict[str, Any]] = []
    end, seen = end_ns, set()
    while len(out) < limit:
        ask = min(_RAW_PAGE, limit - len(out) + len(seen))
        page = store.query(sid, limit=ask, text=text, severity=severity, start_ns=start_ns, end_ns=end)
        fresh = [r for r in page if (r["ts_ns"], r["line"]) not in seen]
        out += fresh
        if not fresh or len(page) < ask:
            break
        last = page[-1]["ts_ns"]
        end = last + 1
        seen = {(r["ts_ns"], r["line"]) for r in page if r["ts_ns"] <= end}
    return out[:limit]


def _raw_records(st: Any, source_id: str, severity: str, q: str, limit: int,
                 start_ns: int | None, end_ns: int | None) -> list[dict[str, Any]]:
    rows: list[tuple[str, dict[str, Any]]] = []
    for sid in [source_id] if source_id else st.raw.sources():
        rows += [(sid, r) for r in _raw_paged(st.raw, sid, limit, q or None, severity or None, start_ns, end_ns)]
    rows.sort(key=lambda x: x[1]["ts_ns"], reverse=True)
    return [raw_record(sid, r["ts_ns"], r["line"], r.get("severity", "info")) for sid, r in rows[:limit]]


def _ocsf_records(source_id: str, severity: str, q: str, limit: int,
                  start_ns: int | None, end_ns: int | None) -> list[dict[str, Any]]:
    from .. import main as m
    if not m._ch_up():
        raise ExportError("The event store (ClickHouse) is not reachable, so normalized events cannot be exported.", 503)
    where = ["1"]
    if source_id:
        where.append(f"source_id = '{m._esc(source_id)}'")
    if severity:
        if severity not in _OCSF_SEV:
            raise ExportError(f"severity must be one of {', '.join(_OCSF_SEV)}")
        where.append(_OCSF_SEV[severity])
    if q:
        n = m._esc(q)
        # Template-mode events keep their text in `vars`, not raw_verbatim: search both.
        where.append(f"""(positionCaseInsensitiveUTF8(ifNull(raw_verbatim, ''), '{n}') > 0
            OR arrayExists(v -> positionCaseInsensitiveUTF8(v, '{n}') > 0, vars)
            OR positionCaseInsensitiveUTF8(source_id, '{n}') > 0 OR positionCaseInsensitiveUTF8(template_id, '{n}') > 0
            OR positionCaseInsensitiveUTF8(ifNull(user_name, ''), '{n}') > 0
            OR position(toString(src_ip), '{n}') > 0 OR position(toString(dst_ip), '{n}') > 0)""")
    if start_ns:
        where.append(f"recv_time >= fromUnixTimestamp64Milli(toInt64({int(start_ns) // 1_000_000}))")
    if end_ns:
        where.append(f"recv_time <= fromUnixTimestamp64Milli(toInt64({int(end_ns) // 1_000_000}))")
    rows = m._ch(f"""SELECT event_uid, toString(event_time) AS event_time, source_id, template_id, envelope_id,
        pack_version, storage_mode, parse_status, class_uid, activity_id, severity_id,
        toString(src_ip) AS src_ip, src_port, toString(dst_ip) AS dst_ip, dst_port, protocol,
        action_id, user_name, unmapped, ocsf_extra, merkle_batch, vars, raw_verbatim,
        hex(raw_sha256) AS raw_sha256_hex
        FROM events FINAL WHERE {" AND ".join(where)}
        ORDER BY recv_time DESC, event_uid DESC LIMIT {limit} FORMAT JSON""", timeout=120)
    out = []
    for r in rows:
        ev = m._row_to_event(r)
        # OCSF `raw_data`: the original bytes rebuilt from template + vars, hash-checked in `verified`.
        ev["raw_data"] = m._verify_row(r)[1]
        ev["aletheia"]["raw_sha256"] = str(ev["aletheia"].get("raw_sha256") or "").lower()   # as sha256sum prints it
        out.append(ev)
    return out


def _system_records(st: Any, source_id: str, q: str, limit: int,
                    start_ns: int | None, end_ns: int | None) -> list[dict[str, Any]]:
    """Audit log (approvals, rejections, exports, stream changes, Lyra SQL) plus source lifecycle."""
    recs: list[dict[str, Any]] = []
    for a in st.repo.audit_list(max(limit, 1000)):
        at, detail = a.get("at"), a.get("detail") or {}
        if isinstance(detail, str):
            try:
                detail = json.loads(detail)
            except json.JSONDecodeError:
                detail = {"text": detail}
        ts = at.timestamp() if hasattr(at, "timestamp") else float(at or 0)
        recs.append({"time": lf.iso_ns(int(ts * 1e9)), "actor": a.get("actor"), "action": a.get("action"),
                     "subject": a.get("subject") or "", "detail": detail, "_ts": ts})
    for s in st.registry.list():
        for h in s.history:
            if h.get("action") in ("approved", "rejected"):      # already in the audit log
                continue
            extra = {k: v for k, v in h.items() if k not in ("at", "action", "actor")}
            recs.append({"time": lf.iso_ns(int(h.get("at", 0) * 1e9)), "actor": h.get("actor"),
                         "action": f"source.{h.get('action')}", "subject": s.id, "detail": extra, "_ts": h.get("at", 0)})
    lo, hi = (start_ns or 0) / 1e9, (end_ns / 1e9) if end_ns else float("inf")
    ql = q.lower()
    recs = [r for r in recs if lo <= r["_ts"] <= hi and (not source_id or r["subject"] == source_id)
            and (not ql or ql in json.dumps(r, default=str).lower())]
    recs.sort(key=lambda r: r["_ts"], reverse=True)
    return [{k: v for k, v in r.items() if k != "_ts"} for r in recs[:limit]]


def collect_records(st: Any, log_type: str = "raw", source_id: str = "", severity: str = "", q: str = "",
                    limit: int = 200, start_ns: int | None = None, end_ns: int | None = None) -> list[dict[str, Any]]:
    if log_type not in DATASETS:
        raise ExportError(f"dataset must be one of {', '.join(DATASETS)}")
    limit = max(1, min(int(limit or 200), MAX_EXPORT))
    if log_type == "raw":
        return _raw_records(st, source_id, severity, q, limit, start_ns, end_ns)
    if log_type == "ocsf":
        return _ocsf_records(source_id, severity, q, limit, start_ns, end_ns)
    return _system_records(st, source_id, q, limit, start_ns, end_ns)


def _text_line(r: dict[str, Any], log_type: str) -> str:
    """Plain text is the original log line, exactly as received, so the file can be re-ingested."""
    if log_type == "raw":
        return r["line"]
    if log_type == "ocsf":
        return r.get("raw_data", "")
    return f"{r['time']} {r['actor']} {r['action']} {r['subject'] or '-'} {json.dumps(r['detail'], default=str)}"


def render_records(records: list[dict[str, Any]], log_type: str, fmt: str,
                   meta: dict[str, Any] | None = None) -> tuple[str, str, str]:
    """Returns (content, media_type, file_extension)."""
    fmt = fmt.lower()
    if fmt == "ndjson":
        fmt = "jsonl"
    if fmt not in LOG_FORMATS:
        raise ExportError(f"format must be one of {', '.join(LOG_FORMATS)}")
    mime, ext = LOG_FORMATS[fmt]
    if fmt == "json":
        content = json.dumps(records, indent=2, ensure_ascii=False, default=str)
    elif fmt == "jsonl":
        content = "".join(json.dumps(r, ensure_ascii=False, default=str) + "\n" for r in records)
    elif fmt == "csv":
        content = lf.to_csv(records)
    elif fmt == "tsv":
        content = lf.to_tsv(records)
    elif fmt == "text":
        content = "".join(_text_line(r, log_type) + "\n" for r in records)
    elif fmt == "syslog":
        content = lf.lines(records, lf.to_syslog5424, log_type)
    elif fmt == "cef":
        content = lf.lines(records, lf.to_cef, log_type)
    elif fmt == "leef":
        content = lf.lines(records, lf.to_leef, log_type)
    else:
        content = lf.to_xml(records, log_type, {"dataset": log_type, "count": len(records), **(meta or {})})
    return content, mime, ext


def export_logs_data(st: Any, log_type: str = "raw", fmt: str = "json", source_id: str = "", severity: str = "",
                     q: str = "", limit: int = 200, start_ns: int | None = None,
                     end_ns: int | None = None) -> tuple[str, str, str]:
    """Fetch logs for `log_type` and render them. Returns (content, media_type, file_extension)."""
    recs = collect_records(st, log_type, source_id, severity, q, limit, start_ns, end_ns)
    return render_records(recs, log_type, fmt)
