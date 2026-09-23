"""Export and Log Supply Stream API endpoints."""
from __future__ import annotations

import hashlib
import logging
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field

from .auth import current_actor
from .state import get_state
from ..ingest.supply import (MAX_EXPORT, ExportError, SupplyError, build_report_data, collect_records,
                             format_report, render_records)

router = APIRouter()
log = logging.getLogger("studio.export")

REPORT_FORMATS = ("pdf", "html", "markdown", "md", "csv", "json")


class SupplyConfigUpdate(BaseModel):
    enabled: bool | None = Field(default=None, description="Enable or disable log supply stream server")
    port: int | None = Field(default=None, ge=1024, le=65535, description="Port to listen on for stream clients")
    host: str | None = Field(default=None, description="Address to listen on: 127.0.0.1 (this host) or 0.0.0.0 (network)")
    log_type: str | None = Field(default=None, description="Stream format: raw, tagged, json, syslog, cef or ocsf")
    source_id: str | None = Field(default=None, description="Filter log stream by source ID or empty for all")
    allow: list[str] | None = Field(default=None, description="Client IPs / CIDRs allowed to connect; empty allows any")
    mode: str | None = Field(default=None, description="listen (receivers connect here) or push (send to a collector)")
    target: str | None = Field(default=None, description="push mode: the collector's host:port, e.g. siem.example.com:514")


def _audit(actor: str, action: str, subject: str | None, detail: dict[str, Any]) -> None:
    """Who exported what is itself compliance evidence; a failed write must not fail the export."""
    try:
        get_state().repo.audit(actor, action, subject, detail)
    except Exception as exc:                                             # noqa: BLE001
        log.warning("audit write failed for %s (%s)", action, type(exc).__name__)


def _parse_time(v: str, name: str) -> int | None:
    """ISO-8601 (a bare time is UTC) or epoch seconds -> epoch ns."""
    v = (v or "").strip()
    if not v:
        return None
    try:
        return int(float(v) * 1e9)
    except ValueError:
        pass
    try:
        dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(422, f"{name} must be ISO-8601 (2026-09-23T10:00:00Z) or epoch seconds") from None
    return int((dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).timestamp() * 1e9)


def _download(content: str | bytes, media_type: str, filename: str, headers: dict[str, str] | None = None) -> Response:
    body = content.encode("utf-8") if isinstance(content, str) else content
    return Response(content=body, media_type=media_type, headers={
        "Content-Disposition": f'attachment; filename="{filename}"',
        # Lets a receiver check the file arrived intact: sha256sum <file> must print this.
        "X-Aletheia-SHA256": hashlib.sha256(body).hexdigest(),
        "Access-Control-Expose-Headers": "X-Aletheia-SHA256, X-Aletheia-Record-Count, Content-Disposition",
        **(headers or {}),
    })


@router.get("/export/report")
def export_report(
    format: str = Query("pdf", description="Report format: pdf, html, markdown, csv, json"),
    source_id: str = Query("", description="Scope the report to one source"),
    window_s: int = Query(300, ge=5, le=86400, description="Accepted for compatibility; rates use the live 5-minute window"),
    categories: str = Query("", description="Comma-separated categories: kpis,sources,severity,normalized,usage,history,insights,traffic,storage"),
    actor: str = Depends(current_actor),
) -> Response:
    """Generate and download a comprehensive system operational report."""
    if format.lower() not in REPORT_FORMATS:
        raise HTTPException(422, f"format must be one of {', '.join(REPORT_FORMATS)}")
    cat_list = [c.strip() for c in categories.split(",") if c.strip()] or None
    try:
        report_dict = build_report_data(get_state(), source_id=source_id, window_s=window_s, categories=cat_list)
    except ExportError as exc:
        raise HTTPException(exc.status, str(exc)) from None
    content, media_type, ext = format_report(report_dict, fmt=format)
    _audit(actor, "export.report", source_id or None, {"format": format, "categories": cat_list or "all"})
    return _download(content, media_type, f"aletheia-report-{int(time.time())}.{ext}")


@router.get("/export/logs")
def export_logs(
    log_type: str = Query("raw", description="Dataset: raw (verbatim lines), ocsf (normalized events) or system (audit trail)"),
    format: str = Query("json", description="json, jsonl, csv, tsv, text, syslog, cef, leef, xml"),
    source_id: str = Query("", description="Filter logs by source ID"),
    severity: str = Query("", description="info, notice, warn or risk"),
    q: str = Query("", description="Keyword: matches the log text, IPs, user, source and template"),
    limit: int = Query(200, ge=1, le=MAX_EXPORT, description="Max records, newest first"),
    since_s: int = Query(0, ge=0, description="Only the last N seconds; 0 means no lower bound"),
    start: str = Query("", description="From (ISO-8601 or epoch seconds); overrides since_s"),
    end: str = Query("", description="Until (ISO-8601 or epoch seconds)"),
    actor: str = Depends(current_actor),
) -> Response:
    """Filter and download centralized logs (raw verbatim, normalized OCSF, or the audit trail)."""
    start_ns = _parse_time(start, "start") or (time.time_ns() - since_s * 1_000_000_000 if since_s else None)
    end_ns = _parse_time(end, "end")
    if start_ns and end_ns and start_ns > end_ns:
        raise HTTPException(422, "start must be before end")
    st = get_state()
    try:
        recs = collect_records(st, log_type=log_type, source_id=source_id, severity=severity, q=q,
                               limit=limit, start_ns=start_ns, end_ns=end_ns)
        content, media_type, ext = render_records(recs, log_type, format, {"source": source_id or "all"})
    except ExportError as exc:
        raise HTTPException(exc.status, str(exc)) from None
    except Exception as exc:                                             # noqa: BLE001
        log.exception("log export failed")
        raise HTTPException(502, f"Could not read the log store: {type(exc).__name__}") from None
    _audit(actor, "export.logs", source_id or None, {
        "dataset": log_type, "format": format, "records": len(recs), "severity": severity, "q": q,
        "start_ns": start_ns, "end_ns": end_ns})
    return _download(content, media_type, f"aletheia-{log_type}-{int(time.time())}.{ext}",
                     {"X-Aletheia-Record-Count": str(len(recs))})


@router.get("/export/supply/status")
def supply_status() -> dict[str, Any]:
    """Get the current operational status and statistics of the Log Supply Stream server."""
    return get_state().supply_server.status()


@router.post("/export/supply/configure")
def supply_configure(update: SupplyConfigUpdate, actor: str = Depends(current_actor)) -> dict[str, Any]:
    """Configure and start/stop the Log Supply Stream server; saved so a restart restores it."""
    st = get_state()
    try:
        out = st.supply_server.configure(enabled=update.enabled, port=update.port, log_type=update.log_type,
                                         source_id=update.source_id, host=update.host, allow=update.allow,
                                         mode=update.mode, target=update.target)
    except SupplyError as exc:
        # Save what actually runs now, so a restart never resurrects a stream that failed to start.
        _save_supply(st, enabled=st.supply_server.enabled)
        raise HTTPException(exc.status, str(exc)) from None
    _save_supply(st, enabled=out["enabled"])
    _audit(actor, "supply.configure", out["source_id"] or None,
           {k: out[k] for k in ("enabled", "mode", "target", "host", "port", "log_type", "allow")})
    return out


def _save_supply(st: Any, enabled: bool) -> None:
    s = st.supply_server
    for key, val in (("supply.enabled", "true" if enabled else "false"), ("supply.host", s.host),
                     ("supply.port", s.port), ("supply.format", s.log_type), ("supply.source_id", s.source_id),
                     ("supply.allow", ",".join(s.allow)), ("supply.mode", s.mode), ("supply.target", s.target)):
        st.settings.set(key, val)


def restore_supply() -> None:
    """Bring the stream back as it was saved. A failure is logged and shown on the Export page."""
    st = get_state()
    g = st.settings.get
    try:
        st.supply_server.configure(
            host=str(g("supply.host") or "127.0.0.1"), port=int(g("supply.port") or 9099),
            log_type=str(g("supply.format") or "raw"), source_id=str(g("supply.source_id") or ""),
            allow=[a for a in str(g("supply.allow") or "").split(",") if a.strip()],
            mode=str(g("supply.mode") or "listen"), target=str(g("supply.target") or ""),
            enabled=str(g("supply.enabled")).lower() in ("1", "true", "yes", "on"))
    except (SupplyError, ValueError) as exc:
        log.error("supply stream not restored: %s", exc)
