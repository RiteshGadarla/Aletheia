#!/usr/bin/env python3
"""Readiness aggregator for the all-in-one image.

The image starts 20-odd s6 services in dependency order, and "the container is running" says
nothing about whether a log line put in the front door would come out the other end. This answers
one question honestly: is every component that the pipeline depends on actually accepting
connections right now?

It is the single definition of ready. `healthcheck.sh` asks this and nothing else, and nginx
proxies /healthz here, so Docker, the UI and a human curl all get the same answer.

Standard library only: the image is built to run air-gapped, and a readiness probe is the last
place that should need a dependency.
"""

from __future__ import annotations

import json
import os
import socket
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN_HOST = os.environ.get("ALETHEIA_HEALTHZ_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("ALETHEIA_HEALTHZ_PORT", "8088"))

# (name, kind, target). Order is roughly the order they come up, so the first `starting`
# component in the list is usually the one being waited on.
CHECKS: list[tuple[str, str, str]] = [
    ("postgres",   "tcp",  "127.0.0.1:5432"),
    ("clickhouse", "http", "http://127.0.0.1:8123/ping"),
    ("redpanda",   "tcp",  "127.0.0.1:9092"),
    ("loki",       "http", "http://127.0.0.1:3100/ready"),
    ("prometheus", "http", "http://127.0.0.1:9090/-/healthy"),
    ("studio",     "http", "http://127.0.0.1:8081/healthz"),
]

# Components whose absence degrades the demo but does not stop the pipeline. They are reported,
# and they do not hold readiness down -- a container stuck "starting" because Grafana is slow is
# a worse lie than one that says ready with dashboards still warming up.
OPTIONAL = {"loki", "prometheus"}

TIMEOUT = 3.0


def check_tcp(target: str) -> tuple[bool, str]:
    host, _, port = target.rpartition(":")
    try:
        with socket.create_connection((host, int(port)), timeout=TIMEOUT):
            return True, "ok"
    except OSError as exc:
        return False, type(exc).__name__


def check_http(url: str) -> tuple[bool, str]:
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT) as r:
            return (200 <= r.status < 400), f"http {r.status}"
    except urllib.error.HTTPError as exc:
        return False, f"http {exc.code}"
    except (urllib.error.URLError, OSError) as exc:
        return False, type(exc).__name__


def probe() -> tuple[bool, dict[str, str]]:
    results: dict[str, str] = {}
    ready = True
    for name, kind, target in CHECKS:
        ok, detail = check_tcp(target) if kind == "tcp" else check_http(target)
        results[name] = "ok" if ok else f"starting ({detail})"
        if not ok and name not in OPTIONAL:
            ready = False
    return ready, results


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:                        # noqa: N802  (http.server API)
        if self.path.split("?")[0] not in ("/healthz", "/health", "/"):
            self.send_response(404)
            self.end_headers()
            return
        ready, checks = probe()
        payload = json.dumps({
            "status": "ready" if ready else "starting",
            "checks": checks,
            "version": os.environ.get("ALETHEIA_VERSION", "dev"),
        }).encode()
        # 503 while starting, so orchestrators and curl --fail both behave correctly.
        self.send_response(200 if ready else 503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt: str, *args) -> None:
        # One line per probe would drown the s6 log; failures surface in the payload instead.
        pass


def main() -> None:
    srv = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    print(f"[healthz] listening on {LISTEN_HOST}:{LISTEN_PORT}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
