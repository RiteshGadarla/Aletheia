"""Export and Log Supply Stream API endpoints."""
from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, Field

from .state import get_state
from ..ingest.supply import build_report_data, export_logs_data, format_report

router = APIRouter()


class SupplyConfigUpdate(BaseModel):
    enabled: bool | None = Field(default=None, description="Enable or disable log supply stream server")
    port: int | None = Field(default=None, ge=1024, le=65535, description="Port to listen on for stream clients")
    log_type: str | None = Field(default=None, description="Log stream format: 'raw' or 'ocsf'")
    source_id: str | None = Field(default=None, description="Filter log stream by source ID or empty for all")


@router.get("/export/report")
def export_report(
    format: str = Query("json", description="Report format: json, csv, markdown, html"),
    source_id: str = Query("", description="Filter metrics for a specific source ID"),
    window_s: int = Query(300, ge=5, le=86400, description="Stats window in seconds"),
    categories: str = Query("", description="Comma-separated categories: kpis,sources,severity,normalized,usage,history"),
) -> Response:
    """Generate and download a comprehensive system operational report."""
    st = get_state()
    cat_list = [c.strip() for c in categories.split(",") if c.strip()] if categories else None
    report_dict = build_report_data(st, source_id=source_id, window_s=window_s, categories=cat_list)
    content, media_type, ext = format_report(report_dict, fmt=format)

    filename = f"aletheia-report-{int(time.time())}.{ext}"
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/export/logs")
def export_logs(
    log_type: str = Query("raw", description="Type of logs: raw, ocsf, or system"),
    format: str = Query("json", description="Output format: json, jsonl, csv, text"),
    source_id: str = Query("", description="Filter logs by source ID"),
    severity: str = Query("", description="Filter logs by severity/level"),
    q: str = Query("", description="Search term/keyword query"),
    limit: int = Query(200, ge=1, le=10000, description="Max logs limit"),
) -> Response:
    """Filter and download centralized logs (raw verbatim, normalized OCSF, or system logs)."""
    st = get_state()
    content, media_type, ext = export_logs_data(
        st, log_type=log_type, fmt=format, source_id=source_id, severity=severity, q=q, limit=limit
    )

    filename = f"aletheia-logs-{log_type}-{int(time.time())}.{ext}"
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/export/supply/status")
def supply_status() -> dict[str, Any]:
    """Get the current operational status and statistics of the Log Supply Stream server."""
    st = get_state()
    return st.supply_server.status()


@router.post("/export/supply/configure")
def supply_configure(update: SupplyConfigUpdate) -> dict[str, Any]:
    """Configure and start/stop the Log Supply Stream server."""
    st = get_state()
    return st.supply_server.configure(
        enabled=update.enabled,
        port=update.port,
        log_type=update.log_type,
        source_id=update.source_id,
    )
