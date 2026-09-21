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

    categories_set = set(categories or ["kpis", "sources", "severity", "normalized", "usage", "history"])

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

    return report


def format_report(report_data: dict[str, Any], fmt: str = "json") -> tuple[str, str, str]:
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
        return "\n".join(lines), "text/markdown", "md"

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
