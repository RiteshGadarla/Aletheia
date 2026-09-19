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

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .api.state import get_state
from .llm.airgap import AirgapViolation
from .llm.factory import build_provider

log = logging.getLogger("studio.main")

REPO_ROOT = Path(__file__).resolve().parents[2]
DEMO_SCRIPT = REPO_ROOT / "demo" / "scenarios.py"

app = FastAPI(title="Aletheia Studio", version="1.0.0")

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


@app.get("/settings/llm")
def get_settings() -> dict[str, Any]:
    return _settings_payload()


@app.put("/settings/llm")
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


@app.post("/settings/llm/test")
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


@app.get("/demo/scenarios")
def list_scenarios() -> list[dict[str, Any]]:
    return SCENARIOS


@app.post("/demo/scenarios/{scenario_id}/run")
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


@app.post("/demo/reset")
def reset_demo() -> dict[str, Any]:
    rc, out = _demo(["reset"])
    return {"ok": rc == 0, "output": out[-2000:]}


@app.get("/packs/verify")
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
