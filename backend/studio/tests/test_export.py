"""Unit and endpoint tests for Report/Logs Export and Supply Log Stream server."""
from __future__ import annotations

import socket
import time
from typing import Any

from studio.api.state import get_state
from studio.ingest.supply import LogSupplyServer, build_report_data, export_logs_data, format_report


def test_format_report_outputs() -> None:
    data = {
        "title": "Test Report",
        "generated_at": "2026-09-21 12:00:00 UTC",
        "kpis": {"lines": 1000, "bytes": 50000, "sources": 2},
        "sources": [
            {"id": "s1", "type": "tcp", "state": "approved", "status": "connected", "lines": 500, "bytes": 25000, "errors": 0, "eps": 10.0},
        ],
        "by_severity": {"info": 800, "warn": 200},
    }

    # Test JSON format
    content_json, mime_json, ext_json = format_report(data, "json")
    assert mime_json == "application/json"
    assert ext_json == "json"
    assert "Test Report" in content_json

    # Test CSV format
    content_csv, mime_csv, ext_csv = format_report(data, "csv")
    assert mime_csv == "text/csv"
    assert ext_csv == "csv"
    assert "Generated At" in content_csv
    assert "s1" in content_csv

    # Test Markdown format
    content_md, mime_md, ext_md = format_report(data, "markdown")
    assert mime_md == "text/markdown"
    assert ext_md == "md"
    assert "# Test Report" in content_md
    assert "| `s1` |" in content_md

    # Test HTML format
    content_html, mime_html, ext_html = format_report(data, "html")
    assert mime_html == "text/html"
    assert ext_html == "html"
    assert "<h1>Test Report</h1>" in content_html


def test_export_logs_formatting() -> None:
    st = get_state()
    st.raw.push("test-src", [(1000, "sample raw line 1", "info"), (2000, "sample raw line 2", "warn")])

    # JSON export
    content, mime, ext = export_logs_data(st, log_type="raw", fmt="json", source_id="test-src")
    assert mime == "application/json"
    assert "sample raw line 1" in content

    # NDJSON / JSONL export
    content_jl, mime_jl, ext_jl = export_logs_data(st, log_type="raw", fmt="jsonl", source_id="test-src")
    assert mime_jl == "application/x-ndjson"
    assert content_jl.count("\n") >= 1

    # Text export
    content_txt, mime_txt, ext_txt = export_logs_data(st, log_type="raw", fmt="text", source_id="test-src")
    assert mime_txt == "text/plain"
    assert "[test-src] [INFO] sample raw line 1" in content_txt


def test_log_supply_server_broadcast() -> None:
    # Use an unprivileged high port for testing
    srv = LogSupplyServer(port=9199, enabled=True, log_type="raw")
    try:
        assert srv.status()["active"] is True
        assert srv.status()["port"] == 9199

        # Connect a client socket
        client_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        client_sock.connect(("127.0.0.1", 9199))
        time.sleep(0.1)

        assert srv.status()["clients_count"] >= 1

        # Broadcast logs
        srv.broadcast("test-src", [(100, "hello supply stream", "info")])
        time.sleep(0.1)

        data = client_sock.recv(1024).decode("utf-8")
        assert "[test-src] [INFO] hello supply stream" in data

        client_sock.close()
    finally:
        srv.stop()
        assert srv.status()["active"] is False


def test_export_api_endpoints(client: Any) -> None:
    # GET /api/v1/export/report
    r = client.get("/api/v1/export/report?format=json")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/json")
    assert "attachment; filename=" in r.headers["content-disposition"]

    # GET /api/v1/export/logs
    r2 = client.get("/api/v1/export/logs?log_type=raw&format=json&limit=10")
    assert r2.status_code == 200
    assert r2.headers["content-type"].startswith("application/json")

    # GET /api/v1/export/supply/status
    r3 = client.get("/api/v1/export/supply/status")
    assert r3.status_code == 200
    body3 = r3.json()
    assert "active" in body3
    assert "port" in body3

    # POST /api/v1/export/supply/configure
    r4 = client.post("/api/v1/export/supply/configure", json={"port": 9099, "enabled": False})
    assert r4.status_code == 200
    assert r4.json()["enabled"] is False
