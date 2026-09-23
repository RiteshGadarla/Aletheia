"""Aletheia Onboarding Studio — FastAPI entrypoint.

Serves the Studio API and the Demo Console backend. The heavy lifting lives in the sibling
packages; this module only wires them to HTTP.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .api import alerting as alerting_api, chat as chat_api, export as export_api, samples as samples_api, sources as sources_api, stats as stats_api
from .api.state import get_state
from .cluster.engine import ClusterEngine
from .core import packs
from .core.models import Token
from .derive.exact import derive_exact
from .gate.reconstruction import run_gate
from .llm.factory import origin_tag
from .propose.heuristics import propose_mapping
from .llm.assistant import ask_ai as llm_ask_ai
from .replay.diff import run_replay
from .llm.airgap import AirgapViolation
from .llm.base import LLMUnavailable
from .llm.factory import build_provider

log = logging.getLogger("studio.main")

REPO_ROOT = Path(__file__).resolve().parents[2]
# In a checkout parents[2] is the repo root; in the all-in-one image studio lives at
# /app/studio so it resolves to "/". These overrides let the image point at the real
# install locations instead (same pattern as ALETHEIA_SERVE_PY in api/samples.py).
DEMO_SCRIPT = Path(os.environ.get("ALETHEIA_DEMO_SCRIPT", str(REPO_ROOT / "demo" / "scenarios.py")))
VERIFY_PACKS = Path(os.environ.get(
    "ALETHEIA_VERIFY_PACKS", str(REPO_ROOT / "backend" / "packs" / "verify_packs.py")))

@asynccontextmanager
async def lifespan(_: FastAPI):
    """Start the raw-ingest pipeline, source connectors and the onboarding watcher."""
    st = get_state()
    await st.pipeline.start()
    st.connectors.start_all()
    watcher = asyncio.create_task(sources_api.auto_propose_loop())
    await st.alerting.start()
    yield
    await st.alerting.stop()
    watcher.cancel()
    samples_api.stop_all_managed()
    st.connectors.stop_all()
    if st.supply_server:
        st.supply_server.stop()
    await st.pipeline.stop()


app = FastAPI(title="Aletheia Studio", version="1.0.0", lifespan=lifespan)

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
    # ALETHEIA_ENGINE_BIN is the name the all-in-one image sets; without it /healthz
    # reported engine_cli "absent" even though the CLI was present on PATH.
    for cand in (os.environ.get("ALETHEIA_BIN"), os.environ.get("ALETHEIA_ENGINE_BIN"),
                 str(REPO_ROOT / "bin" / "aletheia"), "aletheia"):
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
    except (AirgapViolation, LLMUnavailable) as exc:
        # The shipped image has provider=gemini and no key (CONTRACTS §9), so an unconfigured
        # provider is the normal first state, not a server fault: answer 400, never a 500.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    result = provider.test_connection()
    return result.model_dump() if hasattr(result, "model_dump") else dict(result)


# --------------------------------------------------------------------------- demo console
def _demo(args: list[str], timeout: int = 600) -> tuple[int, str]:
    if not DEMO_SCRIPT.is_file():
        raise HTTPException(status_code=503, detail="demo engine not installed")
    env = dict(os.environ)
    env.setdefault("ALETHEIA_CH_URL", CH_URL)
    env.setdefault("ALETHEIA_CH_USER", CH_USER)
    env.setdefault("ALETHEIA_CH_PASSWORD", CH_PASS)
    env.setdefault("ALETHEIA_CH_DB", CH_DB)
    env.setdefault("ALETHEIA_PACKS_DIR", str(REPO_ROOT / "backend" / "packs"))  # overridden by the image
    p = subprocess.run([sys.executable, str(DEMO_SCRIPT), *args],
                       capture_output=True, text=True, timeout=timeout, env=env)
    return p.returncode, (p.stdout + p.stderr).strip()


# Static catalogue: scenarios 0, 9 and 10 are performed by the evaluator outside the UI.
SCENARIOS: list[dict[str, Any]] = [
    {"id": "start", "number": 0, "title": "One-command start", "action_label": "—",
     "proves": "the whole stack comes up from one command",
     "expected": "container reports healthy; the UI opens",
     "link": None, "cli": "docker run -d --name aletheia -p 6156:6156 ...",
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
     "cli": "open http://localhost:6156/lineage",
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
    {"id": "zeroloss", "number": 6, "title": "Zero loss check", "action_label": "Count events",
     "proves": "every message produced is a message stored — no tolerance",
     "expected": "the stored count equals the generated count exactly",
     "link": {"label": "Open events", "href": "/events"},
     "cli": "SELECT count() FROM events",
     "requirements": ["a"], "runnable": True},
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
             "tamper": "tamper", "storage": "storage", "drift": "drift", "bench": "bench",
             "zeroloss": "zeroloss"}


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


@api.get("/health")
def api_health() -> dict[str, Any]:
    """/healthz under /api so the UI can ping it through the same proxy as every other call."""
    return healthz()


@api.get("/packs/verify")
def verify_packs() -> dict[str, Any]:
    """Byte-exact reconstruction over every golden sample. Needs no services."""
    script = VERIFY_PACKS
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
    if not isinstance(extra, dict):
        extra = {}
    # Provenance is owned by the row, never by the stored OCSF blob: a stale or crafted
    # `aletheia` key in ocsf_extra must not be able to restate where an event came from.
    extra.pop("aletheia", None)
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
            "pack": packs.registry().pack_of(r.get("template_id") or "",
                                             int(r.get("pack_version") or 0)),
            "pack_version": int(r.get("pack_version") or 0),
            "raw_sha256": r.get("raw_sha256_hex", ""),
            "verified": _verify_row(r)[0],
            "merkle_batch": r.get("merkle_batch", ""),
        },
    }
    aletheia = ev["aletheia"]
    ev = {**ev, **extra, "aletheia": aletheia}
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
    """ClickHouse prints DateTime64 without a zone; it is UTC, not this host's local time."""
    if v in (None, ""):
        return 0
    from datetime import datetime, timezone
    try:
        dt = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return 0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp() * 1000


# ------------------------------------------------------- stored template resolution
_TPL_CACHE: dict[str, Any] = {"fingerprint": None, "index": {}}


def _templates_index() -> dict[tuple[str, int], list[list[dict[str, Any]]]]:
    """(template_id, pack_version) -> every stored token list, newest first.

    The `templates` table stores one row per envelope the template was matched under, with no
    column saying which. Callers therefore try each candidate and keep the one that actually
    reconstructs the event's bytes.
    """
    try:
        fp = (_ch("SELECT count() AS n FROM templates FORMAT JSON") or [{}])[0].get("n", 0)
    except Exception:                                               # noqa: BLE001
        return _TPL_CACHE["index"]
    if fp == _TPL_CACHE["fingerprint"]:
        return _TPL_CACHE["index"]
    index: dict[tuple[str, int], list[list[dict[str, Any]]]] = {}
    for row in _ch("""SELECT template_id, pack_version, tokens FROM templates
                      ORDER BY created_at DESC FORMAT JSON"""):
        try:
            tokens = json.loads(row.get("tokens") or "[]")
        except json.JSONDecodeError:
            continue
        if isinstance(tokens, list) and tokens not in index.setdefault(
                (row.get("template_id", ""), int(row.get("pack_version") or 0)), []):
            index[(row.get("template_id", ""), int(row.get("pack_version") or 0))].append(tokens)
    _TPL_CACHE["fingerprint"], _TPL_CACHE["index"] = fp, index
    return index


def _rebuild(tokens: list[dict[str, Any]], vars_: list[str]) -> tuple[str, int]:
    """Concatenate literals and vars in token order (CONTRACTS §1). Returns (raw, slots used)."""
    parts: list[str] = []
    i = 0
    for t in tokens:
        if t.get("slot"):
            parts.append(vars_[i] if i < len(vars_) else "")
            i += 1
        else:
            parts.append(t.get("lit") or "")
    return "".join(parts), i


def _resolve_tokens(r: dict[str, Any]) -> tuple[list[dict[str, Any]], str, bool]:
    """Pick the stored token list whose reconstruction hashes to the event's raw_sha256.

    Verification is done, never assumed: `verified` is true only when the bytes rebuilt here
    hash to what was recorded at ingest.
    """
    import hashlib

    want = (r.get("raw_sha256_hex") or "").lower()
    vars_ = list(r.get("vars") or [])
    if r.get("storage_mode") != "template":
        raw = r.get("raw_verbatim") or ""
        ok = bool(want) and hashlib.sha256(raw.encode()).hexdigest() == want
        return [], raw, ok
    tid = r.get("template_id") or ""
    ver = int(r.get("pack_version") or 0)
    # Splice from the packs on disk, guided by the envelope the event recorded. The `templates`
    # table is lossy: ReplacingMergeTree keeps one row per (template_id, pack_version), so a
    # template matched under two envelopes loses one of them. Fall back to it only if needed.
    candidates = packs.registry().spliced(tid, ver, r.get("envelope_id") or "")
    for stored in _templates_index().get((tid, ver), []):
        if stored not in candidates:
            candidates.append(stored)
    fallback: tuple[list[dict[str, Any]], str] | None = None
    for tokens in candidates:
        raw, used = _rebuild(tokens, vars_)
        if used != len(vars_):
            continue
        if want and hashlib.sha256(raw.encode()).hexdigest() == want:
            return tokens, raw, True
        if fallback is None:
            fallback = (tokens, raw)
    if fallback is not None:
        return fallback[0], fallback[1], False
    return [], r.get("raw_verbatim") or "", False


def _verify_row(r: dict[str, Any]) -> tuple[bool, str, list[dict[str, Any]]]:
    if "vars" not in r:                     # caller did not select vars: cannot verify honestly
        return False, "", []
    tokens, raw, ok = _resolve_tokens(r)
    return ok, raw, tokens


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
        action_id, user_name, unmapped, ocsf_extra, merkle_batch, vars, raw_verbatim,
        hex(raw_sha256) AS raw_sha256_hex
        FROM events FINAL WHERE {cond}
        ORDER BY recv_time DESC, event_uid DESC LIMIT {limit} OFFSET {max(0, int(offset))}
        FORMAT JSON""")
    # FINAL and the event_uid tiebreaker are both load-bearing for pagination. Without FINAL the
    # ReplacingMergeTree still holds every redelivery of an event, and recv_time alone does not
    # order them uniquely, so deep offsets returned rows already shown on an earlier page — one
    # page of 100 came back with 34 distinct events. The engine's store.QueryRange does the same.
    total = int((_ch(f"SELECT count() AS n FROM events FINAL WHERE {cond} FORMAT JSON")
                 or [{}])[0].get("n", 0))
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
    # The token list is chosen by rebuilding the bytes and hashing them, because `templates`
    # stores one row per envelope with no column naming it (see _templates_index).
    verified, raw, tokens = _verify_row(r)
    vars_ = list(r.get("vars") or [])

    # Spans are recomputed here, never stored (spec 8.4). Offsets are in BYTES, not characters,
    # and each span is a [start, end) pair to match the frontend's Span tuple.
    spans: dict[str, list[int]] = {}
    values: dict[str, str] = {}
    off, i = 0, 0
    for t in tokens:
        if not t.get("slot"):
            off += len((t.get("lit") or "").encode())
            continue
        v = vars_[i] if i < len(vars_) else ""
        spans[t["slot"]] = [off, off + len(v.encode())]
        values[t["slot"]] = v
        off += len(v.encode())
        i += 1

    template_id = r.get("template_id") or ""
    pack_version = int(r.get("pack_version") or 0)
    hit = packs.registry().template(template_id, pack_version)
    field_map: dict[str, str] = {}
    if hit is not None and values:
        slot_types = {t["slot"]: t.get("type", "") for t in tokens if t.get("slot")}
        field_map = packs.build_field_map(hit[1], values, slot_types)

    return {
        "event_uid": r["event_uid"], "raw": raw, "raw_sha256": r.get("raw_sha256_hex", ""),
        "verified": verified,
        "storage_mode": r.get("storage_mode", "verbatim"),
        "parse_status": r.get("parse_status", "raw_only"),
        "template_id": template_id, "pack": hit[0] if hit else "",
        "pack_version": pack_version,
        "merkle_batch": r.get("merkle_batch", ""),
        "tokens": tokens, "vars": vars_, "spans": spans, "field_map": field_map,
        "event": _row_to_event(r),
    }


# --------------------------------------------------------------------------- studio + airgap
_CLUSTER_CACHE: dict[str, dict[str, Any]] = {}
_DERIVED: dict[str, Any] = {}          # cluster_id -> TemplateProposal, for the AI helper


def _rebuild_clusters() -> list[dict[str, Any]]:
    """Cluster the quarantined events with Drain3 (spec 8.6). Empty until drift arrives."""
    if not _ch_up():
        return []
    rows = _ch("""SELECT source_id, raw_verbatim, toString(recv_time) AS at
        FROM events FINAL WHERE parse_status = 'raw_only' AND raw_verbatim IS NOT NULL
        ORDER BY recv_time DESC, event_uid DESC LIMIT 2000 FORMAT JSON""")
    engine = ClusterEngine()
    seen: dict[str, dict[str, Any]] = {}
    for r in rows:
        line = r.get("raw_verbatim") or ""
        if not line:
            continue
        c = engine.add(line, r.get("source_id"))
        e = seen.setdefault(c.cluster_id, {
            "cluster_id": c.cluster_id, "source_id": r.get("source_id") or "unknown",
            "sample_count": 0, "first_seen": r.get("at", ""), "last_seen": r.get("at", ""),
            "drain_template": c.drain_template, "samples": [],
        })
        e["sample_count"] += 1
        e["drain_template"] = c.drain_template
        e["first_seen"] = min(e["first_seen"], r.get("at", ""))
        e["last_seen"] = max(e["last_seen"], r.get("at", ""))
        if len(e["samples"]) < 20 and line not in e["samples"]:
            e["samples"].append(line)
    out = sorted(seen.values(), key=lambda e: -e["sample_count"])
    _CLUSTER_CACHE.clear()
    _CLUSTER_CACHE.update({e["cluster_id"]: e for e in out})
    return out


@api.get("/studio/clusters")
def list_clusters() -> list[dict[str, Any]]:
    return [{**e, "samples": e["samples"][:4]} for e in _rebuild_clusters()]


def _cluster(cluster_id: str) -> dict[str, Any]:
    if cluster_id not in _CLUSTER_CACHE:
        _rebuild_clusters()
    c = _CLUSTER_CACHE.get(cluster_id)
    if c is None:
        raise HTTPException(status_code=404, detail=f"no cluster {cluster_id}")
    return c


def _proposal_for(cluster_id: str) -> dict[str, Any]:
    """Derive a byte-exact template from the cluster, then propose OCSF mappings (spec 8.7-8.8)."""
    c = _cluster(cluster_id)
    samples = c["samples"]
    if not samples:
        raise HTTPException(status_code=422, detail="cluster has no samples to derive from")
    tpl = derive_exact(samples)
    mapping = propose_mapping(tpl)
    _DERIVED[cluster_id] = tpl
    return {
        "proposal_id": cluster_id,
        "cluster_id": cluster_id,
        "source_id": c["source_id"],
        "template": {
            "tokens": tpl.token_dicts(),
            "slots": [sl.model_dump() for sl in tpl.slots],
            "method": tpl.method,
            "format": tpl.format,
            "discriminator": tpl.discriminator,
            "warnings": tpl.warnings,
        },
        "mapping": mapping.model_dump(),
        "samples": samples[:10],
        "origin": mapping.origin,
    }


@api.get("/studio/clusters/{cluster_id}/proposal")
def get_proposal(cluster_id: str) -> dict[str, Any]:
    return _proposal_for(cluster_id)


@api.post("/studio/clusters/{cluster_id}/ask-ai")
def ask_ai_ep(cluster_id: str) -> dict[str, Any]:
    """One request per cluster, never per event. Heuristics stand on their own if this fails."""
    base = _proposal_for(cluster_id)
    st = get_state()
    cfg = st.settings.llm_config()
    if (cfg.provider or "none") == "none":
        return {"available": False, "origin": "heuristic",
                "reason": "No AI provider configured. Heuristic proposal is unaffected.",
                "proposal": base}
    try:
        provider = build_provider(cfg)
        st.usage.check(cfg.requests_per_hour)
        result = llm_ask_ai(_DERIVED[cluster_id], cfg, provider=provider)
        st.usage.record(origin_tag(cfg), getattr(provider, "last_usage", None), ok=True)
        if not getattr(result, "ok", False):
            return {"available": False, "origin": "heuristic",
                    "reason": getattr(result, "error", None) or "AI suggestion unavailable.",
                    "proposal": base}
        sug = getattr(result, "proposal", None)
        return {"available": True, "origin": origin_tag(cfg), "proposal": base,
                "suggestion": sug.model_dump() if sug is not None else None}
    except Exception as exc:                                        # noqa: BLE001
        log.info("AI suggestion unavailable: %s", type(exc).__name__)
        st.usage.record(origin_tag(cfg), None, ok=False)
        return {"available": False, "origin": "heuristic",
                "reason": f"AI suggestion unavailable ({type(exc).__name__}). "
                          "The heuristic proposal is unaffected.",
                "proposal": base}


class GateRequest(BaseModel):
    faulty: bool = False


@api.post("/studio/proposals/{proposal_id}/gate")
def run_gate_ep(proposal_id: str, req: GateRequest) -> dict[str, Any]:
    """The reconstruction gate: 100% byte-exact rebuild or the pack is rejected (spec 8.9)."""
    p = _proposal_for(proposal_id)
    tokens = [Token(**t) for t in p["template"]["tokens"]]
    if req.faulty and tokens:
        # Deliberately corrupt one literal byte so the gate can be seen rejecting it.
        for i, t in enumerate(tokens):
            if t.lit:
                tokens[i] = Token(lit=t.lit + "X")
                break
    pack_yaml = _pack_yaml_for(p, tokens)
    try:
        report = run_gate(pack_yaml, tokens, p["samples"], engine_bin=_engine_bin() or "aletheia")
    except Exception as exc:                                        # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"gate could not run: {exc}") from exc
    return _gate_payload(report, proposal_id)


def _check(report: Any, name: str) -> bool:
    return any(c.name == name and c.ok for c in report.checks)


def _gate_payload(report: Any, proposal_id: str) -> dict[str, Any]:
    """Flatten GateReport into the shape the UI is typed against."""
    cov = report.coverage or {}
    matched, total = cov.get("matched"), cov.get("of")
    ratio = (matched / total) if isinstance(matched, int) and isinstance(total, int) and total else (
        1.0 if report.samples and report.reconstructed == report.samples else 0.0)
    return {
        "ok": report.ok,
        "samples": report.samples,
        "reconstructed": report.reconstructed,
        "failures": report.failures,
        "type_validation_ok": _check(report, "type_validation"),
        "golden_tests_ok": _check(report, "golden_tests_no_regression"),
        "no_adjacent_slots_ok": _check(report, "no_adjacent_ambiguous_slots"),
        "coverage": round(ratio, 4),
        "ran_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "cli": f"aletheia test-pack --pack {proposal_id}.yaml --samples ./samples --json",
        "checks": [c.model_dump() for c in report.checks],
    }


def _pack_yaml_for(p: dict[str, Any], tokens: list[Any]) -> str:
    import yaml as _yaml
    m = p["mapping"]
    return _yaml.safe_dump({
        "pack": f"proposed_{p['source_id']}".replace("/", "_"),
        "version": 1,
        "applies_to": {"vendor": "proposed", "product": p["source_id"]},
        "envelopes": ["bare"],
        "templates": [{
            "id": p["proposal_id"].replace("/", "_"),
            "discriminator": p["template"].get("discriminator") or "",
            "body": [t.dump() if hasattr(t, "dump") else t for t in tokens],
            "ocsf": {"class_uid": m["class_uid"], "activity_id": m["activity_id"],
                     "map": {fm["slot"]: fm["path"] for fm in m.get("mappings", [])}},
            # The gate writes the cluster samples to <tmp>/samples; point the engine at them
            # explicitly, otherwise it globs <template_id>/*.log and finds nothing.
            "tests": {"samples": "samples/*.log"},
        }],
    }, sort_keys=False)


@api.post("/studio/proposals/{proposal_id}/replay")
def run_replay_ep(proposal_id: str) -> dict[str, Any]:
    p = _proposal_for(proposal_id)
    try:
        report = run_replay(p["source_id"], "1", "2", 1000,
                            engine_bin=_engine_bin() or "aletheia")
    except Exception as exc:                                        # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"replay could not run: {exc}") from exc
    return {
        "proposal_id": proposal_id,
        "source_id": report.source_id,
        "events_examined": report.events,
        "from_version": int(report.from_version or 0),
        "to_version": int(report.to_version or 0),
        "newly_matched": report.newly_matched,
        "template_changed": report.template_changes,
        "fields": [f.model_dump() for f in report.fields],
        "regressions": report.regressions,
        "blocking": report.blocking,
        "report_sha256": report.sha256,
        "cli": (f"aletheia replay --source {report.source_id} "
                f"--from-version {report.from_version} --to-version {report.to_version} "
                f"--last 1000 --json"),
    }


_APPROVALS: dict[str, dict[str, Any]] = {}


@api.get("/studio/proposals/{proposal_id}/approval")
def get_approval(proposal_id: str) -> dict[str, Any]:
    return _APPROVALS.get(proposal_id, {"proposal_id": proposal_id, "state": "proposed",
                                        "approver": None, "approved_at": None,
                                        "report_sha256": None, "reason": None})


class ApproveRequest(BaseModel):
    approver: str
    report_sha256: str = ""


class RejectRequest(BaseModel):
    approver: str
    reason: str = ""


@api.post("/studio/proposals/{proposal_id}/approve")
def approve(proposal_id: str, req: ApproveRequest) -> dict[str, Any]:
    """AI can never approve — only a named human, and the diff hash is recorded with it."""
    rec = {"proposal_id": proposal_id, "state": "approved", "approver": req.approver,
           "approved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "report_sha256": req.report_sha256 or None, "reason": None}
    _APPROVALS[proposal_id] = rec
    return rec


@api.post("/studio/proposals/{proposal_id}/reject")
def reject(proposal_id: str, req: RejectRequest) -> dict[str, Any]:
    rec = {"proposal_id": proposal_id, "state": "rejected", "approver": req.approver,
           "approved_at": None, "report_sha256": None, "reason": req.reason}
    _APPROVALS[proposal_id] = rec
    return rec


class AirgapUpdate(BaseModel):
    airgap: bool


@api.post("/settings/airgap")
def set_airgap(update: AirgapUpdate) -> dict[str, Any]:
    # The setting is keyed "airgap", not "llm.airgap": SettingsStore.set rejects unknown keys,
    # so the wrong name turned the whole air-gap toggle into a 500.
    get_state().settings.set("airgap", "true" if update.airgap else "false")
    return _settings_payload()


@api.post("/settings/reset")
async def reset_settings() -> dict[str, Any]:
    """Full system data reset: clears all sources, raw logs, proposals, history, and events while preserving LLM provider configuration."""
    st = get_state()
    # Preserve LLM provider configuration and Strict Offline (airgap) mode
    cfg = st.settings.llm_config()
    provider = cfg.provider
    model = cfg.model
    base_url = cfg.base_url
    api_key = cfg.api_key
    send_samples = cfg.send_samples
    airgap = cfg.airgap

    # 1. Reset connectors & source registry
    try:
        st.connectors.stop_all()
    except Exception:                                               # noqa: BLE001
        pass
    with st.registry._lock:
        st.registry._d.clear()
        st.registry._save()

    # 2. Reset raw store
    if hasattr(st.raw, "_d") and hasattr(st.raw, "_lock"):
        with st.raw._lock:
            st.raw._d.clear()

    # 3. Reset pipeline stats & buffers
    st.pipeline.stats.clear()
    st.pipeline._buf.clear()
    st.pipeline.fmt.clear()
    st.pipeline._n = 0

    # 4. Clear proposals & approvals caches
    from .ingest import onboarding
    onboarding.PROPOSALS.clear()
    _CLUSTER_CACHE.clear()
    _DERIVED.clear()
    _APPROVALS.clear()

    # 5. Clear repo custom packs
    try:
        if hasattr(st.repo, "_packs") and hasattr(st.repo, "_lock"):
            with st.repo._lock:
                st.repo._packs.clear()
    except Exception:                                               # noqa: BLE001
        pass

    # 6. Reset demo scenarios & ClickHouse tables if reachable
    try:
        _demo(["reset"])
    except Exception:                                               # noqa: BLE001
        pass
    if _ch_up():
        try:
            _ch("TRUNCATE TABLE IF EXISTS events")
            _ch("TRUNCATE TABLE IF EXISTS baseline_events")
            _ch("TRUNCATE TABLE IF EXISTS templates")
        except Exception:                                           # noqa: BLE001
            pass

    # 7. Reset settings preferences while preserving LLM config and airgap status
    st.settings.set("airgap", "true" if airgap else "false")
    st.settings.set("llm.timeout_s", "120")
    st.settings.set("llm.max_output_tokens", "8192")
    st.settings.set("llm.requests_per_hour", "60")
    st.settings.set("llm.provider", provider)
    st.settings.set("llm.model", model)
    st.settings.set("llm.base_url", base_url)
    st.settings.set("llm.send_samples", send_samples)
    if api_key:
        st.settings.set("llm.api_key", api_key)
    else:
        st.settings.unset("llm.api_key")

    st.usage.reset()

    # 8. Reset Log Supply Stream server & Chat Session history
    if hasattr(st, "supply_server") and st.supply_server:
        try:
            st.supply_server.stop()
        except Exception:                                           # noqa: BLE001
            pass

    if hasattr(st, "chat_store") and st.chat_store:
        try:
            st.chat_store.clear_all()
        except Exception:                                           # noqa: BLE001
            pass

    st.connectors.start_all()
    return _settings_payload()


api.include_router(sources_api.router)
api.include_router(stats_api.router)
api.include_router(samples_api.router)
api.include_router(export_api.router)
api.include_router(chat_api.router)
api.include_router(alerting_api.router)
app.include_router(api)
