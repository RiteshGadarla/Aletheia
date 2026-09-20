"""Sample log servers for the Demo page: start/stop the six generators, read stats, steer them."""
from __future__ import annotations

import atexit
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()
SERVE = Path(__file__).resolve().parents[3] / "sources" / "generators" / "servers" / "serve.py"
HOST = os.environ.get("ALETHEIA_SAMPLES_HOST", "127.0.0.1")
UDP_TARGET = os.environ.get("ALETHEIA_SAMPLES_UDP_TARGET", "127.0.0.1:5514")

# id -> generator type, ports, and the Sources preset the Connect button pre-fills.
SAMPLES: dict[str, dict[str, Any]] = {
    "asa": {"category": "Network security", "purpose": "Cisco firewall: connections built and torn down plus blocked traffic, the classic perimeter log.", "title": "Cisco ASA firewall", "format": "ASA syslog", "transport": "TCP stream", "ctl": 9201,
            "port": 9101, "preset": {"id": "asa-fw", "type": "tcp", "config": {"host": HOST, "port": "9101"}}},
    "fortigate": {"category": "Network security", "purpose": "FortiGate next-gen firewall: traffic, web-filter and intrusion-prevention events in key=value form.", "title": "FortiGate firewall", "format": "key=value", "transport": "HTTP NDJSON", "ctl": 9102,
                  "port": 9102, "preset": {"id": "fortigate", "type": "http_stream",
                                           "config": {"url": f"http://{HOST}:9102/stream"}}},
    "web": {"category": "Web and apps", "purpose": "Company web proxy and site: Squid and nginx access logs, including scanner and blocked-site hits.", "title": "Web proxy and server", "format": "Squid + nginx", "transport": "Loki API", "ctl": 9103,
            "port": 9103, "preset": {"id": "web-proxy", "type": "loki_pull",
                                     "config": {"url": f"http://{HOST}:9103", "query": '{job="web"}'}}},
    "vpn": {"category": "Access", "purpose": "Remote-access VPN gateway: logins, failures and brute-force bursts from repeat attackers.", "title": "OpenVPN gateway", "format": "OpenVPN auth", "transport": "WebSocket", "ctl": 9104,
            "port": 9104, "preset": {"id": "vpn-gw", "type": "websocket", "config": {"url": f"ws://{HOST}:9104/ws"}}},
    "cef": {"category": "Network security", "purpose": "WAF and next-gen firewall alerts in CEF and LEEF: SQL injection, blocks and policy denies.", "title": "WAF and NGFW", "format": "CEF + LEEF", "transport": "UDP push", "ctl": 9105,
            "port": 5514, "preset": {"id": "waf-cef", "type": "udp_listen", "config": {"port": "5514"}}},
    "app": {"category": "Web and apps", "purpose": "Custom JSON microservice logs with no parser yet, made to show onboarding a brand-new format.", "title": "Custom app (no parser)", "format": "JSON app logs", "transport": "REST cursor", "ctl": 9106,
            "port": 9106, "preset": {"id": "app-logs", "type": "rest_cursor", "config": {"url": f"http://{HOST}:9106/logs"}}},
    "shop": {"category": "Web and apps", "purpose": "AmazonMart, a fictional online store: load-balancer access logs plus order, payment, cart and fraud events.",
             "title": "AmazonMart online store", "format": "ALB + JSON events", "transport": "HTTP NDJSON", "ctl": 9107, "port": 9107,
             "preset": {"id": "shop-mart", "type": "http_stream", "config": {"url": f"http://{HOST}:9107/stream"}}},
    "defense": {"category": "Critical", "purpose": "Fictional military command network: classified-access, crypto-tamper and enclave-breach alerts, always high stakes.",
                "title": "Defense command network", "format": "CEF (SentinelDef)", "transport": "TCP stream", "ctl": 9210, "port": 9110,
                "preset": {"id": "defense-net", "type": "tcp", "config": {"host": HOST, "port": "9110"}}},
}
_PROCS: dict[str, subprocess.Popen] = {}


def _up(port: int) -> bool:
    try:
        with socket.create_connection((HOST, port), timeout=0.3):
            return True
    except OSError:
        return False


def _stats(sid: str) -> dict[str, Any] | None:
    try:
        r = httpx.get(f"http://{HOST}:{SAMPLES[sid]['ctl']}/stats", timeout=0.6)
        return r.json() if r.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None


def _view(sid: str) -> dict[str, Any]:
    s, p = SAMPLES[sid], _PROCS.get(sid)
    managed = p is not None and p.poll() is None
    up = _up(s["ctl"])
    return {"id": sid, **{k: s[k] for k in ("title", "format", "transport", "port", "preset", "purpose", "category")},
            "running": up, "managed": managed, "stats": _stats(sid) if up else None}


@router.get("/demo/samples")
def list_samples() -> dict[str, Any]:
    return {"available": SERVE.is_file(), "samples": [_view(i) for i in SAMPLES]}


def _known(sid: str) -> dict[str, Any]:
    if sid not in SAMPLES:
        raise HTTPException(404, f"no sample {sid}")
    return SAMPLES[sid]


@router.post("/demo/samples/{sid}/start")
def start_sample(sid: str) -> dict[str, Any]:
    s = _known(sid)
    if not SERVE.is_file():
        raise HTTPException(503, "generator servers are not part of this build")
    if not _up(s["ctl"]):
        env = {**os.environ, "PUSH_TARGET": UDP_TARGET} if sid == "cef" else dict(os.environ)
        _PROCS[sid] = subprocess.Popen([sys.executable, str(SERVE), "--type", sid, "--host", "127.0.0.1"],
                                       env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       start_new_session=True)
        for _ in range(30):
            if _up(s["ctl"]):
                break
            if _PROCS[sid].poll() is not None:
                raise HTTPException(500, f"{sid} generator exited; is port {s['ctl']} taken?")
            time.sleep(0.1)
    return _view(sid)


@router.post("/demo/samples/{sid}/stop")
def stop_sample(sid: str) -> dict[str, Any]:
    _known(sid)
    p = _PROCS.pop(sid, None)
    if p is None or p.poll() is not None:
        if _up(SAMPLES[sid]["ctl"]):
            raise HTTPException(409, "started outside Studio (make gens or a manual run); stop it there")
        return _view(sid)
    p.terminate()
    try:
        p.wait(3)
    except subprocess.TimeoutExpired:
        p.kill()
    return _view(sid)


class SampleControl(BaseModel):
    rate: float | None = None
    risk: float | None = None
    paused: bool | None = None
    drift: bool | None = None
    clear_risk: bool = False


@router.post("/demo/samples/{sid}/control")
def control_sample(sid: str, body: SampleControl) -> dict[str, Any]:
    s = _known(sid)
    payload = {k: v for k, v in body.model_dump().items() if v is not None and k != "clear_risk"}
    if body.clear_risk:
        payload["risk"] = None
    try:
        httpx.post(f"http://{HOST}:{s['ctl']}/control", json=payload, timeout=2).raise_for_status()
    except httpx.HTTPError as e:
        raise HTTPException(409, "sample is not running") from e
    return _view(sid)


def stop_all_managed() -> None:
    for p in _PROCS.values():
        if p.poll() is None:
            p.terminate()
    _PROCS.clear()


atexit.register(stop_all_managed)
