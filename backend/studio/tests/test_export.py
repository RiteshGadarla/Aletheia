"""Report/log export and the log supply stream: every advertised format, filters, and delivery."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import socket
import time
import xml.etree.ElementTree as ET
from typing import Any

import pytest

from studio.api.state import AppState
from studio.ingest import logformats as lf
from studio.ingest import supply
from studio.ingest.supply import (LogSupplyServer, SupplyError, collect_records, export_logs_data, format_report,
                                  render_records)

ASA = '<164>Sep 23 18:11:27 fw01 %ASA-4-106023: Deny tcp src outside:203.0.113.12/63303 dst inside:10.0.0.9/23 by access-group "OUTSIDE_IN"'


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _connect(port: int) -> socket.socket:
    return socket.create_connection(("127.0.0.1", port), timeout=3)


def _wait(cond: Any, timeout: float = 3.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False


def _recv_until(c: socket.socket, needle: bytes, timeout: float = 3.0) -> bytes:
    buf, end = b"", time.time() + timeout
    c.settimeout(0.2)
    while needle not in buf and time.time() < end:
        try:
            chunk = c.recv(65536)
        except socket.timeout:
            continue
        if not chunk:
            break
        buf += chunk
    return buf


@pytest.fixture
def raw_state(state: AppState) -> AppState:
    state.raw.push("asa-fw", [(3000, ASA, "warn"), (1000, "fw boot ok", "info")])
    state.raw.push("web", [(2000, 'GET /a?x=1\t"quoted",comma', "info"), (4000, "sqlmap attack", "risk")])
    return state


# --------------------------------------------------------------------------- report
def test_format_report_outputs() -> None:
    data = {
        "title": "Test Report", "generated_at": "2026-09-21 12:00:00 UTC", "scope": "all sources",
        "kpis": {"lines": 1000, "bytes": 50000, "sources": 2},
        "sources": [{"id": "s1", "type": "tcp", "state": "approved", "status": "connected", "lines": 500, "bytes": 25000, "errors": 0, "eps": 10.0},
                    {"id": "s2", "type": "udp", "state": "review", "status": "connected", "lines": None, "bytes": None, "errors": 0, "eps": 0}],
        "by_severity": {"info": 800, "warn": 200},
    }
    content_json, mime_json, ext_json = format_report(data, "json")
    assert (mime_json, ext_json) == ("application/json", "json") and "Test Report" in content_json
    content_csv, mime_csv, _ = format_report(data, "csv")
    assert mime_csv == "text/csv" and "Generated At" in content_csv and "s1" in content_csv
    content_md, _, ext_md = format_report(data, "markdown")
    assert ext_md == "md" and "# Test Report" in content_md and "| `s1` |" in content_md and "Scope" in content_md
    content_html, _, _ = format_report(data, "html")
    assert "<h1>Test Report</h1>" in content_html
    pdf, mime_pdf, _ = format_report(data, "pdf")
    assert mime_pdf == "application/pdf" and pdf[:4] == b"%PDF"


def test_report_scopes_figures_to_one_source(state: AppState) -> None:
    for sid, n, sev in (("asa-fw", 30, "risk"), ("web", 70, "info")):
        state.registry.ensure(sid)
        state.pipeline.stats[sid].add(n, n * 100, {sev: n})
    everything = supply.build_report_data(state, categories=["kpis", "sources", "severity"])
    assert everything["kpis"]["lines"] == 100 and len(everything["sources"]) == 2
    one = supply.build_report_data(state, source_id="asa-fw", categories=["kpis", "sources", "severity"])
    assert one["scope"] == "asa-fw" and one["kpis"]["lines"] == 30 and one["kpis"]["sources"] == 1
    assert [s["id"] for s in one["sources"]] == ["asa-fw"]
    assert one["by_severity"] == {"info": 0, "notice": 0, "warn": 0, "risk": 30}


def test_report_rejects_unknown_source_and_format(client: Any) -> None:
    r = client.get("/api/v1/export/report?format=json&source_id=nope")
    assert r.status_code == 404
    r = client.get("/api/v1/export/report?format=docx")
    assert r.status_code == 422


# --------------------------------------------------------------------------- wire formats
def test_cef_escapes_and_keeps_hash() -> None:
    rec = supply.raw_record("fw|01", 1_790_000_000_000_000_000, "a=b\\c\nnext", "risk")
    line = lf.to_cef(rec, "raw")
    assert line.startswith("CEF:0|Aletheia|Aletheia|1.0|raw|Raw log line|7|")
    assert "dvchost=fw|01" in line                      # pipes only need escaping in the header
    assert "msg=a\\=b\\\\c\\nnext" in line
    assert f"cs1={rec['sha256']}" in line and "\n" not in line


def test_leef_is_tab_delimited_single_line() -> None:
    ev = {"class_uid": 4001, "severity_id": 4, "time": 1_790_000_000_000, "action_id": 2,
          "src_endpoint": {"ip": "203.0.113.12", "port": 63303}, "dst_endpoint": {"ip": "10.0.0.9", "port": 23},
          "aletheia": {"source_id": "asa-fw", "event_uid": "U1", "raw_sha256": "ab" * 32, "verified": True},
          "raw_data": "line\twith tab"}
    line = lf.to_leef(ev, "ocsf")
    head, attrs = line.split("|x09|", 1)
    assert head == "LEEF:2.0|Aletheia|Aletheia|1.0|4001"
    kv = dict(a.split("=", 1) for a in attrs.split("\t"))
    assert kv["src"] == "203.0.113.12" and kv["dstPort"] == "23" and kv["action"] == "Denied"
    assert kv["msg"] == "line\\twith tab" and kv["verified"] == "true" and kv["sev"] == "7"


def test_syslog_5424_octet_framing_is_exact() -> None:
    rec = supply.raw_record("asa-fw", 1_790_000_000_123_000_000, "multi\nline ü", "warn")
    msg = lf.to_syslog5424(rec, "raw")
    assert msg.startswith("<132>1 2026-09-21T") and " asa-fw aletheia - raw [aletheia@32473 " in msg
    assert msg.endswith("] multi\nline ü")
    framed = lf.octet_frame(msg)
    n, body = framed.split(b" ", 1)
    assert int(n) == len(body) == len(msg.encode())


def test_delimited_and_xml_handle_heterogeneous_records() -> None:
    recs = [{"a": 1, "nested": {"x": "1"}}, {"a": 2, "b": "tab\there", "nested": {"y": [1, 2]}, "bad": "\x01"}]
    rows = list(csv.DictReader(io.StringIO(lf.to_csv(recs))))
    assert set(rows[0]) == {"a", "nested.x", "b", "nested.y", "bad"}
    assert rows[1]["nested.y"] == "[1,2]" and rows[0]["b"] == ""
    tsv = lf.to_tsv(recs).splitlines()
    assert tsv[0].split("\t") == ["a", "nested.x", "b", "nested.y", "bad"] and "tab\\there" in tsv[2]
    root = ET.fromstring(lf.to_xml(recs, "raw", {"dataset": "raw", "count": 2}))
    assert root.get("count") == "2" and len(root.findall("record")) == 2


# --------------------------------------------------------------------------- log export
def test_raw_export_merges_sources_newest_first(raw_state: AppState) -> None:
    recs = collect_records(raw_state, "raw", limit=3)
    assert [r["timestamp_ns"] for r in recs] == [4000, 3000, 2000]
    assert recs[1]["line"] == ASA and recs[1]["sha256"] == hashlib.sha256(ASA.encode()).hexdigest()
    assert collect_records(raw_state, "raw", severity="risk")[0]["line"] == "sqlmap attack"
    assert [r["timestamp_ns"] for r in collect_records(raw_state, "raw", start_ns=2000, end_ns=3000)] == [3000, 2000]


def test_every_advertised_log_format_renders_its_own_type(raw_state: AppState) -> None:
    recs = collect_records(raw_state, "raw", limit=10)
    seen = {}
    for fmt in supply.LOG_FORMATS:
        content, mime, ext = render_records(recs, "raw", fmt)
        seen[fmt] = (mime, ext)
        assert content, fmt
    assert seen["tsv"] == ("text/tab-separated-values", "tsv") and seen["xml"][1] == "xml"
    assert seen["cef"][1] == "cef" and seen["leef"][1] == "leef"
    text, _, _ = render_records(recs, "raw", "text")
    assert text.splitlines()[1] == ASA                  # plain text is the original line, byte for byte
    with pytest.raises(supply.ExportError):
        render_records(recs, "raw", "docx")


def test_raw_export_pages_past_the_store_cap(monkeypatch: pytest.MonkeyPatch, state: AppState) -> None:
    monkeypatch.setattr(supply, "_RAW_PAGE", 7)
    # Timestamps collide in threes, so page boundaries fall inside a run of equal timestamps.
    state.raw.push("s", [(1000 + i // 3, f"line {i}", "info") for i in range(40)])
    recs = collect_records(state, "raw", source_id="s", limit=40)
    assert len(recs) == 40 and len({r["line"] for r in recs}) == 40
    assert len(collect_records(state, "raw", source_id="s", limit=25)) == 25


def _ch_row(uid: str, raw: str, sev: int = 4) -> dict[str, Any]:
    return {"event_uid": uid, "event_time": "2026-09-23 12:00:00.000", "source_id": "asa-fw", "template_id": "",
            "envelope_id": "", "pack_version": 0, "storage_mode": "verbatim", "parse_status": "raw_only",
            "class_uid": 4001, "activity_id": 1, "severity_id": sev, "src_ip": "::ffff:203.0.113.12", "src_port": 63303,
            "dst_ip": "::ffff:10.0.0.9", "dst_port": 23, "protocol": "tcp", "action_id": 2, "user_name": None,
            "unmapped": "{}", "ocsf_extra": "{}", "merkle_batch": "asa-fw/p0/2026-09-23T12:00Z", "vars": [],
            "raw_verbatim": raw, "raw_sha256_hex": hashlib.sha256(raw.encode()).hexdigest().upper()}


def test_ocsf_export_carries_verified_original(monkeypatch: pytest.MonkeyPatch, state: AppState) -> None:
    from studio import main as m
    sql: list[str] = []
    monkeypatch.setattr(m, "_ch_up", lambda: True)
    monkeypatch.setattr(m, "_ch", lambda q, *a, **k: sql.append(q) or [_ch_row("U1", ASA)])
    recs = collect_records(state, "ocsf", severity="risk", q="203.0.113")
    assert "severity_id >= 4" in sql[0] and "arrayExists" in sql[0]
    ev = recs[0]
    assert ev["raw_data"] == ASA and ev["aletheia"]["verified"] is True
    assert ev["src_endpoint"] == {"ip": "203.0.113.12", "port": 63303}
    cef = lf.to_cef(ev, "ocsf")
    assert "|4001|Network Activity|7|" in cef and "act=Denied" in cef and "src=203.0.113.12" in cef
    text, _, _ = render_records(recs, "ocsf", "text")
    assert text == ASA + "\n"


def test_ocsf_export_reports_store_down(client: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from studio import main as m
    monkeypatch.setattr(m, "_ch_up", lambda: False)
    r = client.get("/api/v1/export/logs?log_type=ocsf&format=json")
    assert r.status_code == 503 and "ClickHouse" in r.json()["detail"]


def test_export_api_headers_and_audit(client: Any, raw_state: AppState) -> None:
    r = client.get("/api/v1/export/logs?log_type=raw&format=jsonl&limit=10", headers={"X-Aletheia-Actor": "auditor"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/x-ndjson")
    assert r.headers["x-aletheia-record-count"] == "4"
    assert r.headers["x-aletheia-sha256"] == hashlib.sha256(r.content).hexdigest()
    assert len(r.text.splitlines()) == 4 and "aletheia-raw-" in r.headers["content-disposition"]
    assert client.get("/api/v1/export/logs?log_type=nope").status_code == 422
    assert client.get("/api/v1/export/logs?format=pdf").status_code == 422
    assert client.get("/api/v1/export/logs?start=yesterday").status_code == 422
    assert client.get("/api/v1/export/logs?limit=50000").status_code == 200

    trail = json.loads(client.get("/api/v1/export/logs?log_type=system&format=json").text)
    exp = [t for t in trail if t["action"] == "export.logs"]
    assert exp and exp[-1]["actor"] == "auditor" and exp[-1]["detail"]["records"] == 4


def test_export_logs_data_keeps_its_signature(raw_state: AppState) -> None:
    content, mime, ext = export_logs_data(raw_state, log_type="raw", fmt="csv", source_id="web")
    assert (mime, ext) == ("text/csv", "csv") and 'GET /a?x=1\t""quoted"",comma' in content


# --------------------------------------------------------------------------- supply stream
@pytest.mark.parametrize("fmt,check", [
    ("raw", lambda b: b == (ASA + "\n").encode()),
    ("tagged", lambda b: b == f"[asa-fw] [WARN] {ASA}\n".encode()),
    ("json", lambda b: json.loads(b)["line"] == ASA and json.loads(b)["sha256"] == hashlib.sha256(ASA.encode()).hexdigest()),
    ("cef", lambda b: b.startswith(b"CEF:0|Aletheia|") and b.endswith(b"\n")),
    ("syslog", lambda b: int(b.split(b" ", 1)[0]) == len(b.split(b" ", 1)[1]) and b.endswith(ASA.encode())),
])
def test_supply_formats(fmt: str, check: Any) -> None:
    srv = LogSupplyServer(port=_free_port(), enabled=True, log_type=fmt)
    try:
        c = _connect(srv.port)
        assert _wait(lambda: srv.status()["clients_count"] == 1)
        srv.broadcast("asa-fw", [(1_790_000_000_000_000_000, ASA, "warn")])
        data = _recv_until(c, ASA.encode()[-12:] if fmt == "syslog" else b"\n")
        assert check(data), data
        assert _wait(lambda: srv.status()["lines_sent"] == 1)
        c.close()
        assert _wait(lambda: srv.status()["clients_count"] == 0)   # hang-ups are noticed while idle
    finally:
        srv.stop()
    assert srv.status()["active"] is False


def test_supply_source_filter() -> None:
    srv = LogSupplyServer(port=_free_port(), enabled=True, source_id="web")
    try:
        c = _connect(srv.port)
        assert _wait(lambda: srv.status()["clients_count"] == 1)
        srv.broadcast("asa-fw", [(1, "not me", "info")])
        srv.broadcast("web", [(2, "me", "info")])
        assert _recv_until(c, b"me\n") == b"me\n"
    finally:
        srv.stop()


def test_slow_client_never_blocks_ingest(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(supply, "CLIENT_QUEUE_CHUNKS", 2)
    srv = LogSupplyServer(port=_free_port(), enabled=True)
    try:
        stalled = _connect(srv.port)                       # connects, never reads
        fast = _connect(srv.port)
        assert _wait(lambda: srv.status()["clients_count"] == 2)
        chunk = [(i, "x" * 1000, "info") for i in range(2000)]   # ~2 MB per broadcast
        t0 = time.time()
        for _ in range(20):
            srv.broadcast("s", chunk)
        assert time.time() - t0 < 2.0
        assert _wait(lambda: srv.status()["dropped_lines"] > 0)
        fast.settimeout(0.5)
        assert fast.recv(10)
        stalled.close()
        fast.close()
    finally:
        srv.stop()


def test_supply_allowlist_refuses_other_hosts() -> None:
    srv = LogSupplyServer(port=_free_port(), enabled=True, allow=["10.0.0.0/8"])
    try:
        c = _connect(srv.port)
        assert _wait(lambda: srv.status()["refused"] == 1)
        c.settimeout(1)
        assert c.recv(10) == b""                           # closed by the server
        assert srv.status()["clients_count"] == 0
    finally:
        srv.stop()
    with pytest.raises(SupplyError) as e:
        LogSupplyServer().configure(allow=["not-a-cidr"])
    assert e.value.status == 422


def test_supply_reports_why_it_cannot_start() -> None:
    port = _free_port()
    blocker = socket.socket()
    blocker.bind(("127.0.0.1", port))
    blocker.listen(1)
    try:
        with pytest.raises(SupplyError) as e:
            LogSupplyServer().configure(enabled=True, port=port)
        assert e.value.status == 409 and str(port) in str(e.value)
    finally:
        blocker.close()
    with pytest.raises(SupplyError) as e:
        LogSupplyServer(brokers="").configure(enabled=True, port=_free_port(), log_type="ocsf")
    assert "event bus" in str(e.value)
    with pytest.raises(SupplyError) as e:
        LogSupplyServer().configure(log_type="garbage")
    assert e.value.status == 422


def test_supply_api_persists_and_restores(client: Any, state: AppState) -> None:
    from studio.api.export import restore_supply

    port = _free_port()
    r = client.post("/api/v1/export/supply/configure",
                    json={"enabled": True, "port": port, "log_type": "syslog", "allow": ["127.0.0.1"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["active"] and body["host"] == "127.0.0.1" and body["allow"] == ["127.0.0.1/32"]
    assert state.settings.get("supply.enabled") == "true" and state.settings.get("supply.format") == "syslog"

    state.supply_server.stop()                            # as if Studio restarted
    restore_supply()
    st = state.supply_server.status()
    assert st["active"] and st["port"] == port and st["log_type"] == "syslog"

    assert client.post("/api/v1/export/supply/configure", json={"log_type": "nope"}).status_code == 422
    assert state.supply_server.status()["active"]          # a rejected edit leaves the stream running
    r = client.post("/api/v1/export/supply/configure", json={"enabled": False})
    assert r.status_code == 200 and not r.json()["active"]
    assert state.settings.get("supply.enabled") == "false"


def test_pipeline_forward_feeds_the_stream(state: AppState) -> None:
    srv = state.supply_server
    srv.configure(enabled=True, port=_free_port())
    try:
        c = _connect(srv.port)
        assert _wait(lambda: srv.status()["clients_count"] == 1)
        state.pipeline.forward("asa-fw", [(1, ASA, "warn")])
        assert _recv_until(c, ASA.encode()) == (ASA + "\n").encode()
    finally:
        srv.stop()


def _collector(port: int) -> socket.socket:
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", port))
    srv.listen(1)
    srv.settimeout(5)
    return srv


def test_push_mode_delivers_to_a_listening_collector() -> None:
    port = _free_port()
    collector = _collector(port)
    srv = LogSupplyServer()
    try:
        srv.configure(enabled=True, mode="push", target=f"127.0.0.1:{port}", log_type="syslog")
        conn, _ = collector.accept()
        assert _wait(lambda: srv.status()["clients_count"] == 1)
        srv.broadcast("asa-fw", [(1_790_000_000_000_000_000, ASA, "warn")])
        data = _recv_until(conn, ASA.encode()[-12:])
        n, body = data.split(b" ", 1)
        assert int(n) == len(body) and body.endswith(ASA.encode())
        conn.close()
    finally:
        srv.stop()
        collector.close()


def test_push_mode_buffers_while_the_collector_is_down() -> None:
    port = _free_port()
    srv = LogSupplyServer()
    try:
        srv.configure(enabled=True, mode="push", target=f"127.0.0.1:{port}")
        assert _wait(lambda: "Cannot reach" in srv.status()["last_error"])
        srv.broadcast("s", [(1, "while down", "info")])
        assert srv.status()["clients"][0]["queued"] == 1
        collector = _collector(port)                      # collector comes back; backoff retries
        conn, _ = collector.accept()
        assert _recv_until(conn, b"\n", timeout=5) == b"while down\n"
        assert _wait(lambda: srv.status()["last_error"] == "")
        conn.close()
        collector.close()
    finally:
        srv.stop()


def test_push_mode_validates_target() -> None:
    for bad in ("siem.example.com", "host:0", "host:http"):
        with pytest.raises(SupplyError) as e:
            LogSupplyServer().configure(mode="push", target=bad)
        assert e.value.status == 422
    with pytest.raises(SupplyError):
        LogSupplyServer().configure(enabled=True, mode="push", target="")
    with pytest.raises(SupplyError):
        LogSupplyServer().configure(mode="broadcast")
