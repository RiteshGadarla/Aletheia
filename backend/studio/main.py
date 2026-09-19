"""Aletheia Onboarding Studio — FastAPI entrypoint.

Serves the Studio API and the Demo Console backend. The heavy lifting lives in the sibling
packages; this module only wires them to HTTP.
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .api.state import get_state
from .llm.airgap import AirgapViolation
from .llm.factory import build_provider

log = logging.getLogger("studio.main")

REPO_ROOT = Path(__file__).resolve().parents[2]
DEMO_SCRIPT = REPO_ROOT / "demo" / "scenarios.py"

app = FastAPI(title="Aletheia Studio", version="1.0.0")

# The frontend calls /api/v1/*; /healthz stays unprefixed for container probes.
api = APIRouter(prefix="/api/v1")

# The frontend dev server runs on a different port; in production both sit behind one origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o for o in os.environ.get(
        "ALETHEIA_CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173").split(",") if o],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- health
@app.get("/healthz")
def healthz() -> dict[str, Any]:
    """Ready only when the pieces this process owns are actually usable."""
    st = get_state()
    checks: dict[str, str] = {}
    try:
        st.settings.llm_config()
        checks["settings"] = "ok"
    except Exception as exc:                                        # noqa: BLE001
        checks["settings"] = f"error: {type(exc).__name__}"
    checks["repo"] = "ok" if st.repo is not None else "missing"
    checks["engine_cli"] = "ok" if _engine_bin() else "absent"
    ok = checks["settings"] == "ok" and checks["repo"] == "ok"
    return {"status": "ready" if ok else "degraded", "checks": checks,
            "version": app.version}


def _engine_bin() -> str | None:
    for cand in (os.environ.get("ALETHEIA_BIN"), str(REPO_ROOT / "bin" / "aletheia"), "aletheia"):
        if not cand:
            continue
        p = Path(cand)
        if p.is_file() and os.access(p, os.X_OK):
            return str(p)
    return None


# --------------------------------------------------------------------------- settings
class LlmSettingsUpdate(BaseModel):
    provider: str
    model: str = ""
    base_url: str = ""
    send_samples: str = "masked"
    # Write-only. Omitted keeps the stored key; "" clears it.
    api_key: str | None = Field(default=None)


def _usage_payload(cap_per_hour: int) -> dict[str, Any]:
    """Shape the counter to the frontend contract (CONTRACTS section 9)."""
    snap = get_state().usage.snapshot()
    tokens = (snap.get("prompt_tokens", 0) or 0) + (snap.get("completion_tokens", 0) or 0)
    return {
        "requests": snap.get("requests_last_hour", snap.get("requests", 0)),
        "tokens": tokens or None,
        "window": "hour",
        "cap_per_hour": cap_per_hour,
    }


def _settings_payload() -> dict[str, Any]:
    st = get_state()
    cfg = st.settings.llm_config()
    pub = cfg.public()
    return {
        "provider": pub["provider"],
        "model": pub["model"],
        "base_url": pub["base_url"],
        "send_samples": pub["send_samples"],
        "api_key_last4": pub["api_key_last4"],
        "api_key_set": pub["api_key_set"],
        "airgap": pub["airgap"],
        "sources": pub["source"],
        "usage": _usage_payload(pub["requests_per_hour"]),
        "updated_at": None,
    }


@api.get("/settings/llm")
def get_settings() -> dict[str, Any]:
    return _settings_payload()


@api.put("/settings/llm")
def put_settings(update: LlmSettingsUpdate) -> dict[str, Any]:
    st = get_state()
    st.settings.set("llm.provider", update.provider)
    st.settings.set("llm.model", update.model)
    st.settings.set("llm.base_url", update.base_url)
    st.settings.set("llm.send_samples", update.send_samples)
    if update.api_key is not None:
        if update.api_key == "":
            st.settings.unset("llm.api_key")
        else:
            st.settings.set("llm.api_key", update.api_key)   # sealed on write
    return _settings_payload()


@api.post("/settings/llm/test")
def test_connection() -> dict[str, Any]:
    st = get_state()
    cfg = st.settings.llm_config()
    try:
        provider = build_provider(cfg)
    except AirgapViolation as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    result = provider.test_connection()
    return result.model_dump() if hasattr(result, "model_dump") else dict(result)


# --------------------------------------------------------------------------- demo console
def _demo(args: list[str], timeout: int = 600) -> tuple[int, str]:
    if not DEMO_SCRIPT.is_file():
        raise HTTPException(status_code=503, detail="demo engine not installed")
    p = subprocess.run([sys.executable, str(DEMO_SCRIPT), *args],
                       capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout + p.stderr).strip()


# Static catalogue: scenarios 0, 9 and 10 are performed by the evaluator outside the UI.
SCENARIOS: list[dict[str, Any]] = [
    {"id": "start", "number": 0, "title": "One-command start", "action_label": "—",
     "proves": "the whole stack comes up from one command",
     "expected": "container reports healthy; the UI opens",
     "link": None, "cli": "docker run -d --name aletheia -p 8080:8080 ...",
     "requirements": ["k"], "runnable": False},
    {"id": "traffic", "number": 1, "title": "Start traffic", "action_label": "Start traffic",
     "proves": "every source lands in one OCSF shape",
     "expected": "eight source types stream in; one table, identical columns",
     "link": {"label": "Open events", "href": "/events"},
     "cli": "python3 sources/generators/log_generator.py --seed 1337 --syslog localhost:5514",
     "requirements": ["b", "c", "f"], "runnable": True},
    {"id": "lineage", "number": 2, "title": "Byte lineage", "action_label": "Pick an event",
     "proves": "traceability down to the byte",
     "expected": "clicking src_endpoint.ip highlights the exact bytes it came from",
     "link": {"label": "Open lineage", "href": "/lineage"},
     "cli": "open http://localhost:8080/lineage",
     "requirements": ["d"], "runnable": True},
    {"id": "verify", "number": 3, "title": "Verify integrity", "action_label": "Run verify",
     "proves": "stored evidence still matches what arrived",
     "expected": "every batch verifies; reconstruct mismatches stay at zero",
     "link": None, "cli": "aletheia verify --source fw01 --last 15m --json",
     "requirements": ["a"], "runnable": True},
    {"id": "tamper", "number": 3.5, "title": "Tamper one stored byte",
     "action_label": "Tamper a byte",
     "proves": "tampering is detectable after the fact",
     "expected": "the next verify FAILS and names the exact event and Merkle batch",
     "link": None,
     "cli": "ALTER TABLE events UPDATE vars[1] = ... SETTINGS mutations_sync=1",
     "requirements": ["a"], "runnable": True},
    {"id": "storage", "number": 4, "title": "Storage report", "action_label": "Measure storage",
     "proves": "keeping everything costs less, not more",
     "expected": "compared against raw+normalized AND against compressed raw alone",
     "link": None, "cli": "python3 bench/storage_report.py --json",
     "requirements": [], "runnable": True},
    {"id": "drift", "number": 5, "title": "Trigger firmware drift", "action_label": "Trigger drift",
     "proves": "an unknown format is never dropped",
     "expected": "drifted lines stored verbatim as raw_only and queued for onboarding",
     "link": {"label": "Open Studio", "href": "/studio"},
     "cli": "python3 sources/generators/log_generator.py --source asa --drift",
     "requirements": ["e", "i"], "runnable": True},
    {"id": "bench", "number": 8, "title": "Run benchmark", "action_label": "Run benchmark",
     "proves": "throughput scales with workers",
     "expected": "events/sec reported for 1, 2 and 4 workers on this machine",
     "link": None, "cli": "aletheia bench --workers 1,2,4 --duration 60s --json",
     "requirements": [], "runnable": True},
    {"id": "airgap", "number": 9, "title": "Air-gapped operation", "action_label": "—",
     "proves": "it runs with no network at all",
     "expected": "every scenario above passes on a disconnected machine",
     "link": None, "cli": "docker save / docker load — see README section 8",
     "requirements": ["j"], "runnable": False},
    {"id": "byol", "number": 10, "title": "Bring your own log", "action_label": "—",
     "proves": "the 'any source' claim, on the evaluator's own data",
     "expected": "known formats normalize; unknown ones quarantine and can be onboarded live",
     "link": None, "cli": 'echo "<your log line>" | nc -u -w1 localhost 5514',
     "requirements": [], "runnable": False},
]

# Demo Console id -> demo/scenarios.py subcommand.
_RUNNABLE = {"traffic": "traffic", "lineage": "lineage", "verify": "verify",
             "tamper": "tamper", "storage": "storage", "drift": "drift", "bench": "bench"}


@api.get("/demo/scenarios")
def list_scenarios() -> list[dict[str, Any]]:
    return SCENARIOS


@api.post("/demo/scenarios/{scenario_id}/run")
def run_scenario(scenario_id: str) -> dict[str, Any]:
    cmd = _RUNNABLE.get(scenario_id)
    if cmd is None:
        raise HTTPException(status_code=404, detail=f"scenario {scenario_id} is not runnable here")
    started = time.time()
    rc, out = _demo([cmd, "--json"])
    return {"scenario_id": scenario_id, "ok": rc == 0,
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(started)),
            "duration_ms": int((time.time() - started) * 1000),
            "output": out[-8000:], "link": None}


@api.post("/demo/reset")
def reset_demo() -> dict[str, Any]:
    rc, out = _demo(["reset"])
    return {"ok": rc == 0, "output": out[-2000:]}


@api.get("/packs/verify")
def verify_packs() -> dict[str, Any]:
    """Byte-exact reconstruction over every golden sample. Needs no services."""
    script = REPO_ROOT / "backend" / "packs" / "verify_packs.py"
    if not script.is_file():
        raise HTTPException(status_code=503, detail="verifier not installed")
    p = subprocess.run([sys.executable, str(script)], capture_output=True, text=True, timeout=300)
    last = (p.stdout.strip().splitlines() or [""])[-1]
    try:
        return json.loads(last)
    except json.JSONDecodeError:
        return {"ok": p.returncode == 0, "output": p.stdout[-4000:]}


# --------------------------------------------------------------------------- events + lineage
CH_URL = os.environ.get("ALETHEIA_CH_URL", "http://localhost:8123")
CH_USER = os.environ.get("ALETHEIA_CH_USER", "aletheia")
CH_PASS = os.environ.get("ALETHEIA_CH_PASSWORD", "aletheia")
CH_DB = os.environ.get("ALETHEIA_CH_DB", "aletheia")

CLASS_NAMES = {4001: "Network Activity", 4002: "HTTP Activity", 4003: "DNS Activity",
               3002: "Authentication", 2004: "Detection Finding"}


def _ch(sql: str, timeout: int = 30) -> list[dict[str, Any]]:
    """Query ClickHouse, returning JSON rows. Raises on transport failure."""
    import urllib.parse
    import urllib.request
    q = urllib.parse.urlencode({"user": CH_USER, "password": CH_PASS, "database": CH_DB})
    req = urllib.request.Request(f"{CH_URL}/?{q}", data=sql.encode())
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read().decode().strip()
    return json.loads(body).get("data", []) if body else []


def _ch_up() -> bool:
    try:
        _ch("SELECT 1 FORMAT JSON", timeout=3)
        return True
    except Exception:                                               # noqa: BLE001
        return False


def _row_to_event(r: dict[str, Any]) -> dict[str, Any]:
    """Rebuild the CONTRACTS section 5 event shape from a stored row."""
    extra = {}
    if r.get("ocsf_extra"):
        try:
            extra = json.loads(r["ocsf_extra"])
        except json.JSONDecodeError:
            extra = {}
    unmapped = {}
    if r.get("unmapped"):
        try:
            unmapped = json.loads(r["unmapped"])
        except json.JSONDecodeError:
            unmapped = {}
    cls = int(r.get("class_uid") or 0)
    act = int(r.get("activity_id") or 0)
    ev: dict[str, Any] = {
        "class_uid": cls,
        "category_uid": {4001: 4, 4002: 4, 4003: 4, 3002: 3, 2004: 2}.get(cls, 0),
        "activity_id": act,
        "type_uid": cls * 100 + act,
        "time": int(_epoch_ms(r.get("event_time"))),
        "severity_id": int(r.get("severity_id") or 0),
        "action_id": int(r.get("action_id") or 0),
        "metadata": {
            "log_name": r.get("source_id", ""),
            "product": {"vendor_name": "", "name": ""},
            "original_time": "",
        },
        "unmapped": unmapped,
        "aletheia": {
            "event_uid": r.get("event_uid", ""),
            "source_id": r.get("source_id", ""),
            "parse_status": r.get("parse_status", "raw_only"),
            "storage_mode": r.get("storage_mode", "verbatim"),
            "template_id": r.get("template_id", ""),
            "pack": "",
            "pack_version": int(r.get("pack_version") or 0),
            "raw_sha256": r.get("raw_sha256_hex", ""),
            "verified": r.get("storage_mode") == "template",
            "merkle_batch": r.get("merkle_batch", ""),
        },
        **extra,
    }
    if r.get("src_ip"):
        ev["src_endpoint"] = {"ip": _unmap_v6(r["src_ip"]), "port": int(r.get("src_port") or 0) or None}
    if r.get("dst_ip"):
        ev["dst_endpoint"] = {"ip": _unmap_v6(r["dst_ip"]), "port": int(r.get("dst_port") or 0) or None}
    if r.get("protocol"):
        ev["connection_info"] = {"protocol_name": r["protocol"]}
    if r.get("user_name"):
        ev["user"] = {"name": r["user_name"]}
    return ev


def _unmap_v6(ip: str) -> str:
    """IPv4 is stored as IPv4-mapped IPv6; show it as IPv4 again."""
    return ip[7:] if ip.startswith("::ffff:") else ip


def _epoch_ms(v: Any) -> float:
    if v in (None, ""):
        return 0
    try:
        from datetime import datetime
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).timestamp() * 1000
    except (ValueError, TypeError):
        return 0


def _esc(v: str) -> str:
    return v.replace("\\", "\\\\").replace("'", "\\'")


@api.get("/events")
def list_events(source_id: str = "", class_uid: int = 0, parse_status: str = "",
                q: str = "", limit: int = 200, offset: int = 0) -> dict[str, Any]:
    if not _ch_up():
        # An empty page beats a 500: the UI stays usable before any traffic is generated.
        return {"events": [], "total": 0, "sources": [],
                "classes": [{"class_uid": k, "name": v} for k, v in CLASS_NAMES.items()]}
    where = ["1"]
    if source_id:
        where.append(f"source_id = '{_esc(source_id)}'")
    if class_uid:
        where.append(f"class_uid = {int(class_uid)}")
    if parse_status:
        where.append(f"parse_status = '{_esc(parse_status)}'")
    if q:
        where.append(f"(source_id ILIKE '%{_esc(q)}%' OR template_id ILIKE '%{_esc(q)}%')")
    cond = " AND ".join(where)
    limit = max(1, min(int(limit or 200), 1000))

    rows = _ch(f"""SELECT event_uid, toString(event_time) AS event_time, source_id, template_id,
        pack_version, storage_mode, parse_status, class_uid, activity_id, severity_id,
        toString(src_ip) AS src_ip, src_port, toString(dst_ip) AS dst_ip, dst_port, protocol,
        action_id, user_name, unmapped, ocsf_extra, merkle_batch, hex(raw_sha256) AS raw_sha256_hex
        FROM events WHERE {cond}
        ORDER BY recv_time DESC LIMIT {limit} OFFSET {max(0, int(offset))} FORMAT JSON""")
    total = int((_ch(f"SELECT count() AS n FROM events WHERE {cond} FORMAT JSON") or [{}])[0].get("n", 0))
    sources = [r["source_id"] for r in _ch("SELECT DISTINCT source_id FROM events FORMAT JSON")]
    classes = [{"class_uid": int(r["class_uid"]),
                "name": CLASS_NAMES.get(int(r["class_uid"]), str(r["class_uid"]))}
               for r in _ch("SELECT DISTINCT class_uid FROM events WHERE class_uid > 0 FORMAT JSON")]
    return {"events": [_row_to_event(r) for r in rows], "total": total,
            "sources": sorted(sources), "classes": classes or
            [{"class_uid": k, "name": v} for k, v in CLASS_NAMES.items()]}


@api.get("/events/{event_uid}/lineage")
def get_lineage(event_uid: str) -> dict[str, Any]:
    if not _ch_up():
        raise HTTPException(status_code=503, detail="ClickHouse unavailable — run `make services`")
    rows = _ch(f"""SELECT event_uid, source_id, template_id, pack_version, storage_mode,
        parse_status, vars, raw_verbatim, merkle_batch, hex(raw_sha256) AS raw_sha256_hex,
        toString(event_time) AS event_time, class_uid, activity_id, severity_id,
        toString(src_ip) AS src_ip, src_port, toString(dst_ip) AS dst_ip, dst_port, protocol,
        action_id, user_name, unmapped, ocsf_extra
        FROM events WHERE event_uid = '{_esc(event_uid)}' LIMIT 1 FORMAT JSON""")
    if not rows:
        raise HTTPException(status_code=404, detail=f"no event {event_uid}")
    r = rows[0]
    tpl = _ch(f"""SELECT tokens FROM templates
        WHERE template_id = '{_esc(r.get('template_id') or '')}' ORDER BY pack_version DESC
        LIMIT 1 FORMAT JSON""")
    tokens: list[dict[str, Any]] = []
    if tpl:
        try:
            tokens = json.loads(tpl[0]["tokens"])
        except (json.JSONDecodeError, KeyError):
            tokens = []
    vars_ = list(r.get("vars") or [])

    # Spans are recomputed here, never stored (spec 8.4).
    raw, spans, i = "", {}, 0
    for t in tokens:
        if t.get("lit") is not None and not t.get("slot"):
            raw += t["lit"]
        else:
            v = vars_[i] if i < len(vars_) else ""
            spans[t.get("slot", f"slot{i}")] = {"start": len(raw), "end": len(raw) + len(v)}
            raw += v
            i += 1
    if not tokens:
        raw = r.get("raw_verbatim") or ""

    return {
        "event_uid": r["event_uid"], "raw": raw, "raw_sha256": r.get("raw_sha256_hex", ""),
        "verified": r.get("storage_mode") == "template",
        "storage_mode": r.get("storage_mode", "verbatim"),
        "parse_status": r.get("parse_status", "raw_only"),
        "template_id": r.get("template_id", ""), "pack": "",
        "pack_version": int(r.get("pack_version") or 0),
        "merkle_batch": r.get("merkle_batch", ""),
        "tokens": tokens, "vars": vars_, "spans": spans, "field_map": {},
        "event": _row_to_event(r),
    }


# --------------------------------------------------------------------------- studio + airgap
@api.get("/studio/clusters")
def list_clusters() -> list[dict[str, Any]]:
    """Quarantined events, clustered. Empty until drifted traffic arrives."""
    if not _ch_up():
        return []
    rows = _ch("""SELECT source_id, count() AS n, min(toString(recv_time)) AS first_seen,
        max(toString(recv_time)) AS last_seen, groupArray(4)(raw_verbatim) AS samples
        FROM events WHERE parse_status = 'raw_only' AND raw_verbatim IS NOT NULL
        GROUP BY source_id ORDER BY n DESC LIMIT 50 FORMAT JSON""")
    out = []
    for i, r in enumerate(rows):
        samples = [s for s in (r.get("samples") or []) if s]
        out.append({
            "cluster_id": f"{r['source_id']}-{i}", "source_id": r["source_id"],
            "sample_count": int(r.get("n") or 0),
            "first_seen": r.get("first_seen", ""), "last_seen": r.get("last_seen", ""),
            "drain_template": get_state().clusters.template_for(samples)
            if hasattr(get_state().clusters, "template_for") else (samples[0] if samples else ""),
            "samples": samples[:4],
        })
    return out


class AirgapUpdate(BaseModel):
    airgap: bool


@api.post("/settings/airgap")
def set_airgap(update: AirgapUpdate) -> dict[str, Any]:
    get_state().settings.set("llm.airgap", "true" if update.airgap else "false")
    return _settings_payload()


app.include_router(api)
