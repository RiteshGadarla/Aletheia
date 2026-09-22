"""Sources: raw ingest, Loki push receiver, connectors and the approve/reject/retry flow."""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from typing import Any

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "sources", "generators", "servers"))
import formats  # noqa: E402
from common import Feed  # noqa: E402

from studio.api.state import get_state  # noqa: E402
from studio.ingest import onboarding  # noqa: E402


def _lines(kind: str, n: int) -> list[str]:
    f = Feed(kind, getattr(formats, kind)(3), 1, 3)
    for _ in range(n):
        f.emit()
    return [e[2] for e in f.ring]


def _flush(c: Any) -> None:
    asyncio.run(get_state().pipeline.flush())


def test_push_autoregisters_and_stores_raw_verbatim(client: Any) -> None:
    lines = _lines("app", 20)
    r = client.post("/api/v1/ingest/app-live", content="\n".join(lines))
    assert r.status_code == 202 and r.json()["accepted"] == 20
    _flush(client)
    src = client.get("/api/v1/sources").json()["sources"][0]
    assert src["id"] == "app-live" and src["state"] == "collecting" and src["lines"] == 20
    raw = client.get("/api/v1/sources/app-live/raw?limit=100").json()["lines"]
    assert {x["line"] for x in raw} == set(lines)                   # byte-for-byte


def test_loki_push_receiver(client: Any) -> None:
    body = {"streams": [{"stream": {"job": "nginx"}, "values": [[str(time.time_ns()), "GET / 200"]]}]}
    assert client.post("/api/v1/ingest/loki/push", json=body).status_code == 204
    _flush(client)
    assert client.get("/api/v1/sources/nginx/raw").json()["lines"][0]["line"] == "GET / 200"


def test_create_validates(client: Any) -> None:
    assert client.post("/api/v1/sources", json={"id": "x", "type": "tcp", "config": {}}).status_code == 422
    ok = {"id": "fw", "type": "tcp", "config": {"host": "127.0.0.1", "port": 1}, "enabled": False}
    assert client.post("/api/v1/sources", json=ok).status_code == 201
    assert client.post("/api/v1/sources", json=ok).status_code == 409
    assert client.patch("/api/v1/sources/fw", json={"enabled": False}).json()["status"] == "passive"


def test_onboarding_approve_reject_retry(client: Any) -> None:
    client.post("/api/v1/ingest/app-live", content="\n".join(_lines("app", 300)))
    _flush(client)
    prop = client.post("/api/v1/sources/app-live/propose").json()
    assert prop["clusters"] and prop["clusters"][0]["mapping"]["rows"]
    assert "_raw" not in json.dumps(prop)
    assert client.get("/api/v1/sources/app-live/review").json()["source"]["state"] == "review"

    r = client.post("/api/v1/sources/app-live/decision", json={"action": "approve"})
    assert r.status_code == 422                                     # human approver required

    r = client.post("/api/v1/sources/app-live/decision", json={"action": "retry", "approver": "ritesh",
                                                                "feedback": "try auth", "class_hint": 3002})
    assert r.status_code == 200 and r.json()["proposal"]["attempt"] == 1
    assert r.json()["proposal"]["class_hint"] == 3002

    r = client.post("/api/v1/sources/app-live/decision", json={"action": "approve", "approver": "ritesh"})
    if r.status_code == 409:                                        # gate failed: must not approve
        assert "gate" in r.json()["detail"]
        assert client.get("/api/v1/sources/app-live/review").json()["source"]["state"] == "review"
    else:
        assert r.status_code == 200 and r.json()["source"]["state"] == "approved"
        assert get_state().repo.packs_list()

    client.post("/api/v1/ingest/other", content="\n".join(_lines("vpn", 150)))
    _flush(client)
    client.post("/api/v1/sources/other/propose")
    r = client.post("/api/v1/sources/other/decision", json={"action": "reject", "approver": "ritesh", "reason": "noise"})
    assert r.json()["source"]["state"] == "rejected"
    assert client.get("/api/v1/sources/other/raw").json()["count"] > 0    # still raw-only


def test_proposal_persists_and_reconstructs_after_restart(client: Any) -> None:
    client.post("/api/v1/ingest/restart-src", content="\n".join(_lines("app", 150)))
    _flush(client)
    prop = client.post("/api/v1/sources/restart-src/propose").json()
    assert prop["clusters"]

    # 1. Simulate server restart (in-memory proposals cache cleared)
    onboarding.clear_proposals()

    # Proposal should still be returned (reloaded from repo settings)
    rev1 = client.get("/api/v1/sources/restart-src/review").json()
    assert rev1["proposal"] is not None
    assert len(rev1["proposal"]["clusters"]) == len(prop["clusters"])

    # Approve the source
    client.post("/api/v1/sources/restart-src/decision", json={"action": "approve", "approver": "ritesh"})

    # 2. Simulate server restart and remove stored proposal setting to test pack reconstruction
    onboarding.clear_proposals()
    get_state().repo.settings_delete("onboarding.proposal.restart-src")

    # Proposal should be reconstructed from approved packs
    rev2 = client.get("/api/v1/sources/restart-src/review").json()
    assert rev2["proposal"] is not None
    assert rev2["proposal"]["clusters"][0]["mapping"]["class_name"]


@pytest.mark.asyncio
async def test_tcp_connector_reads_generator_stream() -> None:
    from studio.ingest.connectors import Runner
    from studio.ingest.pipeline import IngestPipeline
    from studio.ingest.rawstore import MemoryRawStore
    from studio.ingest.sources import Source

    async def serve(_r, w):
        for i in range(5):
            w.write(f"line {i}\n".encode())
        await w.drain()
        w.close()

    srv = await asyncio.start_server(serve, "127.0.0.1", 0)
    port = srv.sockets[0].getsockname()[1]
    store = MemoryRawStore()
    pipe = IngestPipeline(store, flush_s=0.05)
    await pipe.start()
    run = Runner(Source(id="t", type="tcp", config={"host": "127.0.0.1", "port": port}), pipe)
    run.start()
    await asyncio.sleep(0.4)
    run.stop()
    await asyncio.sleep(0.05)
    await pipe.stop()
    srv.close()
    assert {r["line"] for r in store.query("t")} >= {f"line {i}" for i in range(5)}


def test_stats_overview(client: Any) -> None:
    client.post("/api/v1/ingest/app-live", content="\n".join(_lines("app", 120)))
    _flush(client)
    d = client.get("/api/v1/stats/overview").json()
    k = d["kpis"]
    assert k["lines"] == 120 and k["sources"] == 1 and k["bytes"] > 0
    assert len(d["series"]) == d["window_s"] // d["bucket_s"] and sum(d["series"]) > 0
    assert sum(d["by_severity"].values()) == 120
    assert d["sources"][0]["id"] == "app-live" and len(d["sources"][0]["spark"]) == len(d["series"])
    assert d["normalized"]["available"] in (True, False)


_OLD_PRI = __import__("re").compile(r"^<(\d{1,3})>")
_OLD_ASA = __import__("re").compile(r"%ASA-(\d)-")
_OLD_LEVEL = __import__("re").compile(r'"level"\s*:\s*"(\w+)"', __import__("re").I)
_OLD_RISK = __import__("re").compile(r"attack|inject|brute|malware|exploit|sqlmap|nikto|masscan|etc/passwd|1=1|TCP_DENIED|stuffing|panic", __import__("re").I)
_OLD_BAD = __import__("re").compile(r"denied|deny|block|failed|fatal|error|timeout|exhausted", __import__("re").I)


def _old_guess(line: str) -> str:
    """The regex implementation the substring version replaced; must agree on real lines."""
    base = "info"
    a, m, lv = _OLD_ASA.search(line[:80]), _OLD_PRI.match(line), _OLD_LEVEL.search(line)
    num = lambda n: "info" if n >= 6 else "notice" if n == 5 else "warn" if n == 4 else "risk"  # noqa: E731
    if a:
        base = num(int(a.group(1)))
    elif m:
        base = num(int(m.group(1)) % 8)
    elif lv:
        v = lv.group(1).lower()
        base = "risk" if v in ("error", "fatal", "critical") else "warn" if v in ("warn", "warning") else "info"
    if base != "risk" and _OLD_RISK.search(line):
        return "risk"
    if base in ("info", "notice") and _OLD_BAD.search(line):
        return "warn"
    return base


def test_guess_severity_matches_regex_version() -> None:
    from studio.ingest.rawstore import guess_severity
    lines = [ln for k in ("asa", "fortigate", "web", "vpn", "cef", "app") for ln in _lines(k, 400)]
    lines += ["", "plain text", "<>x", "<999>y", '{"level":"FATAL"}', "%ASA-x-1: a", "<164>%ASA-6-1: brute"]
    bad = [ln for ln in lines if guess_severity(ln) != _old_guess(ln)]
    assert not bad, bad[:3]


def test_sample_catalogue_and_errors(client: Any) -> None:
    from studio.api import samples
    listing = client.get("/api/v1/demo/samples").json()
    assert listing["available"] and {x["id"] for x in listing["samples"]} == set(samples.SAMPLES)
    assert all(x["preset"]["type"] and x["preset"]["id"] and x["purpose"] for x in listing["samples"])
    assert client.post("/api/v1/demo/samples/nope/start").status_code == 404
    assert client.post("/api/v1/demo/samples/nope/control", json={"rate": 5}).status_code == 404


def test_snapshot_keeps_builtin_packs_and_bumps_version() -> None:
    from studio.core.db import MemoryRepo
    from studio.ingest.onboarding import snapshot
    repo = MemoryRepo()
    new = [{"pack": "src_a_1", "yaml": "pack: src_a_1\n", "checksum": "c", "status": "approved", "author": "me", "origin": "heuristic"}]
    v1, rows1 = snapshot(repo, new)
    names = {r["pack"] for r in rows1}
    assert v1 == 1 and "src_a_1" in names and "cisco_asa" in names          # built-ins ride along
    assert all(r["version"] == 1 for r in rows1)
    for r in rows1:
        repo.pack_upsert(r)
    v2, rows2 = snapshot(repo, [{**new[0], "pack": "src_b_1"}])
    n2 = {r["pack"] for r in rows2}
    assert v2 == 2 and {"src_a_1", "src_b_1", "cisco_asa"} <= n2            # earlier approval is kept
