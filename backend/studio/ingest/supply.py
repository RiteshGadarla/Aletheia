"""Supply Log Stream server & Export Exporter utilities for Aletheia.

Provides a dedicated TCP streaming server to supply centralized logs in real-time to external clients,
along with report & log formatting tools for downloadable exports.
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import socket
import threading
import time
from typing import Any

log = logging.getLogger("studio.supply")


class LogSupplyServer:
    """Centralized log streaming server on a dedicated TCP port.

    Broadcasts incoming raw or transformed log entries to connected TCP clients (e.g. nc, syslog receivers, log aggregators).
    """

    def __init__(self, port: int = 9099, enabled: bool = False, log_type: str = "raw", source_id: str = "") -> None:
        self.port = port
        self.enabled = enabled
        self.log_type = log_type  # "raw" or "ocsf"
        self.source_id = source_id  # "" means all sources
        self._server_socket: socket.socket | None = None
        self._clients: set[socket.socket] = set()
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._running = False
        self.lines_sent = 0
        self.bytes_sent = 0
        self.started_at: float | None = None

        if self.enabled:
            self.start()

    def start(self) -> bool:
        """Start the background TCP supply listener."""
        with self._lock:
            if self._running:
                return True
            try:
                srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                srv.bind(("0.0.0.0", self.port))
                srv.listen(10)
                srv.settimeout(0.5)
                self._server_socket = srv
                self._running = True
                self.enabled = True
                self.started_at = time.time()
                self._thread = threading.Thread(target=self._accept_loop, daemon=True)
                self._thread.start()
                log.info(f"LogSupplyServer started on port {self.port}")
                return True
            except Exception as exc:
                log.error(f"Failed to start LogSupplyServer on port {self.port}: {exc}")
                self._running = False
                self.enabled = False
                if self._server_socket:
                    try:
                        self._server_socket.close()
                    except Exception:
                        pass
                    self._server_socket = None
                return False

    def stop(self) -> None:
        """Stop the supply server and disconnect all clients."""
        with self._lock:
            self._running = False
            self.enabled = False
            if self._server_socket:
                try:
                    self._server_socket.close()
                except Exception:
                    pass
                self._server_socket = None
            for client in list(self._clients):
                try:
                    client.close()
                except Exception:
                    pass
            self._clients.clear()
            log.info("LogSupplyServer stopped")

    def configure(self, enabled: bool | None = None, port: int | None = None,
                  log_type: str | None = None, source_id: str | None = None) -> dict[str, Any]:
        """Update supply server options and restart listener if port or state changes."""
        restart_needed = False
        if port is not None and port != self.port:
            self.port = port
            restart_needed = True
        if log_type is not None:
            self.log_type = log_type
        if source_id is not None:
            self.source_id = source_id

        if enabled is not None:
            if enabled and not self._running:
                self.start()
            elif not enabled and self._running:
                self.stop()
        elif restart_needed and self._running:
            self.stop()
            self.start()

        return self.status()

    def _accept_loop(self) -> None:
        while self._running and self._server_socket:
            try:
                client, addr = self._server_socket.accept()
                client.settimeout(1.0)
                with self._lock:
                    self._clients.add(client)
                log.info(f"Supply client connected from {addr}")
            except socket.timeout:
                continue
            except Exception:
                if self._running:
                    log.debug("Supply accept socket closed or errored")
                break

    def broadcast(self, source_id: str, entries: list[tuple[int, str, str]]) -> None:
        """Send new log entries to all connected clients."""
        if not self._running or not self._clients:
            return
        if self.source_id and self.source_id != source_id:
            return

        payload_lines = []
        for ts_ns, raw_line, sev in entries:
            if self.log_type == "ocsf":
                entry = json.dumps({"source": source_id, "timestamp_ns": ts_ns, "severity": sev, "message": raw_line}) + "\n"
            else:
                entry = f"[{source_id}] [{sev.upper()}] {raw_line}\n"
            payload_lines.append(entry.encode("utf-8"))

        if not payload_lines:
            return

        data = b"".join(payload_lines)
        dead_clients = set()
        with self._lock:
            clients_snapshot = list(self._clients)

        for client in clients_snapshot:
            try:
                client.sendall(data)
            except Exception:
                dead_clients.add(client)

        if dead_clients:
            with self._lock:
                for c in dead_clients:
                    self._clients.discard(c)
                    try:
                        c.close()
                    except Exception:
                        pass

        with self._lock:
            self.lines_sent += len(entries)
            self.bytes_sent += len(data)

    def status(self) -> dict[str, Any]:
        """Return supply server operational status and stats."""
        with self._lock:
            return {
                "active": self._running,
                "enabled": self.enabled,
                "port": self.port,
                "log_type": self.log_type,
                "source_id": self.source_id,
                "clients_count": len(self._clients),
                "lines_sent": self.lines_sent,
                "bytes_sent": self.bytes_sent,
                "started_at": self.started_at,
            }


# --------------------------------------------------------------------------- Report Exporters
def build_report_data(st: Any, source_id: str = "", window_s: int = 300, categories: list[str] | None = None) -> dict[str, Any]:
    """Collect system overview, stats, sources, and metrics into a report dictionary."""
    from ..api.stats import overview as get_overview
    ov = get_overview()
    now_ts = int(time.time())

    categories_set = set(categories or ["kpis", "sources", "severity", "normalized", "usage", "history", "insights", "traffic", "storage"])

    report: dict[str, Any] = {
        "title": "Aletheia Centralized Log Pipeline Report",
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(now_ts)),
        "epoch_seconds": now_ts,
        "window_s": window_s,
    }

    if "kpis" in categories_set:
        report["kpis"] = ov.get("kpis", {})
        report["kpis"]["store_backend"] = ov.get("store")
        report["kpis"]["bus_enabled"] = ov.get("bus")

    if "sources" in categories_set:
        srcs = ov.get("sources", [])
        if source_id:
            srcs = [s for s in srcs if s.get("id") == source_id]
        report["sources"] = srcs

    if "severity" in categories_set:
        report["by_severity"] = ov.get("by_severity", {})

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
        report["history"] = ov.get("history", [])

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
                        Paragraph(f"Generated {esc(r.get('generated_at', ''))} &nbsp;|&nbsp; Window {r.get('window_s', 0)}s", sub)]

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
        rows += [[s.get("id"), s.get("type"), s.get("state"), s.get("status"), f"{s.get('lines', 0):,}",
                  f"{s.get('bytes', 0) / 1024:.1f}", s.get("errors", 0), s.get("eps", 0)] for s in r["sources"]]
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
            f"**Generated:** {report_data.get('generated_at', '')}\n",
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
                lines.append(f"| `{s.get('id')}` | {s.get('type')} | {s.get('state')} | {s.get('status')} | {s.get('lines'):,} | {s.get('bytes'):,} | {s.get('errors')} | {s.get('eps')} |")
            lines.append("")
        if "by_severity" in report_data:
            lines.append("## Severity Distribution")
            for k, v in report_data["by_severity"].items():
                lines.append(f"- **{k.upper()}:** {v:,}")
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
        title = report_data.get("title", "Aletheia Pipeline Report")
        gen_at = report_data.get("generated_at", "")
        kpis = report_data.get("kpis", {})
        sources = report_data.get("sources", [])
        sev = report_data.get("by_severity", {})
        norm = report_data.get("normalized_ocsf", {})

        src_rows = "".join([
            f"<tr><td><code>{s.get('id')}</code></td><td>{s.get('type')}</td><td><span class='badge'>{s.get('state')}</span></td><td>{s.get('status')}</td><td>{s.get('lines'):,}</td><td>{s.get('bytes'):,}</td><td>{s.get('errors')}</td><td>{s.get('eps')}</td></tr>"
            for s in sources
        ])
        kpi_cards = "".join([
            f"<div class='card'><div class='card-title'>{k.replace('_', ' ').title()}</div><div class='card-val'>{v}</div></div>"
            for k, v in kpis.items()
        ])
        sev_items = "".join([
            f"<div class='sev-item'><strong>{k.upper()}:</strong> {v:,}</div>"
            for k, v in sev.items()
        ])

        import html as _h
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
    <div class="sub">Generated at {gen_at}</div>
    
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
def export_logs_data(st: Any, log_type: str = "raw", fmt: str = "json",
                     source_id: str = "", severity: str = "", q: str = "", limit: int = 200) -> tuple[str, str, str]:
    """Fetch logs according to log_type and format them for export.

    Returns: (content_string, media_type, file_extension)
    """
    limit = max(1, min(int(limit or 200), 10000))
    records: list[dict[str, Any]] = []

    if log_type == "raw":
        # Fetch from rawstore
        sources_to_query = [source_id] if source_id else st.raw.sources()
        for sid in sources_to_query:
            if len(records) >= limit:
                break
            lines = st.raw.query(sid, limit=limit - len(records), text=q or None, severity=severity or None)
            for item in lines:
                records.append({
                    "source_id": sid,
                    "timestamp_ns": item.get("ts_ns"),
                    "severity": item.get("severity", "info"),
                    "line": item.get("line", ""),
                })

    elif log_type == "ocsf":
        # Fetch from ClickHouse or fallback
        from .. import main as m
        if m._ch_up():
            where = ["1"]
            if source_id:
                where.append(f"source_id = '{m._esc(source_id)}'")
            if severity:
                where.append(f"parse_status = '{m._esc(severity)}'")
            if q:
                where.append(f"(source_id ILIKE '%{m._esc(q)}%' OR template_id ILIKE '%{m._esc(q)}%')")
            cond = " AND ".join(where)
            rows = m._ch(f"""SELECT event_uid, toString(event_time) AS event_time, source_id, template_id,
                pack_version, storage_mode, parse_status, class_uid, activity_id, severity_id,
                toString(src_ip) AS src_ip, src_port, toString(dst_ip) AS dst_ip, dst_port, protocol,
                action_id, user_name, unmapped, ocsf_extra, merkle_batch, vars, raw_verbatim
                FROM events FINAL WHERE {cond} ORDER BY recv_time DESC LIMIT {limit} FORMAT JSON""")
            records = [m._row_to_event(r) for r in rows]
        else:
            records = []

    elif log_type == "system":
        # System audit & dev log summary
        srcs = st.registry.list()
        for s in srcs:
            if source_id and s.id != source_id:
                continue
            for h in s.history:
                records.append({
                    "source_id": s.id,
                    "at": h.get("at"),
                    "action": h.get("action"),
                    "actor": h.get("actor"),
                    "reason": h.get("reason", ""),
                    "feedback": h.get("feedback", ""),
                })
        records.sort(key=lambda x: x.get("at", 0), reverse=True)
        records = records[:limit]

    # Format the collected records
    fmt = fmt.lower()
    if fmt in ("jsonl", "ndjson"):
        content = "\n".join(json.dumps(r) for r in records)
        return content, "application/x-ndjson", "jsonl"

    elif fmt == "csv":
        buf = io.StringIO()
        if records:
            keys = list(records[0].keys())
            writer = csv.DictWriter(buf, fieldnames=keys)
            writer.writeheader()
            for r in records:
                # Stringify complex dicts or lists for CSV compatibility
                flat_r = {k: (json.dumps(v) if isinstance(v, (dict, list)) else v) for k, v in r.items()}
                writer.writerow(flat_r)
        return buf.getvalue(), "text/csv", "csv"

    elif fmt == "text":
        lines = []
        for r in records:
            if log_type == "raw":
                lines.append(f"[{r.get('source_id')}] [{r.get('severity', 'info').upper()}] {r.get('line')}")
            elif log_type == "system":
                lines.append(f"[{r.get('source_id')}] {r.get('action')} by {r.get('actor')} at {r.get('at')}: {r.get('reason') or r.get('feedback')}")
            else:
                lines.append(f"[{r.get('aletheia', {}).get('source_id', 'unknown')}] {r.get('metadata', {}).get('uid', '')} class={r.get('class_uid')} {r.get('message', '')}")
        return "\n".join(lines), "text/plain", "log"

    else:  # json
        return json.dumps(records, indent=2), "application/json", "json"
