"""`make seed`: reset the local stack, wire up Gemini, connect two demo servers, seed alerts.

Talks to Postgres directly, so it works whether or not Studio is currently running — but Studio
only picks up newly-registered sources at startup (ConnectorManager.start_all), so run this
before `make dev`/`make studio`, or restart Studio afterwards.
"""
from __future__ import annotations

import argparse
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERVICES = ROOT / "deploy" / "docker-compose.services.yml"
SECRETS_ENV = ROOT / "deploy" / "secrets" / "aletheia.env"
LOG_DIR = ROOT / ".dev-logs"

# Demo-page sample ids: one TCP stream and one Loki-API pull, so two connector types get exercised.
DEMO_SAMPLES = ("asa", "web")


def sh(*args: str) -> None:
    print("+", " ".join(args))
    subprocess.run(args, check=True, cwd=ROOT)


def load_secrets() -> dict[str, str]:
    """Parse the gitignored local secrets file, for this process only; the key must be set."""
    if not SECRETS_ENV.exists():
        sys.exit(f"missing {SECRETS_ENV} — run `make secrets` and put your Gemini key in it first")
    env: dict[str, str] = {}
    for line in SECRETS_ENV.read_text().splitlines():
        name, sep, value = line.strip().partition("=")
        if sep and not name.startswith("#"):
            env[name.strip()] = value.split(" #", 1)[0].strip()
    if not env.get("ALETHEIA_LLM_API_KEY"):
        sys.exit(f"ALETHEIA_LLM_API_KEY is empty in {SECRETS_ENV} — add your Gemini key there first")
    return env


def reset_db() -> None:
    print("== resetting the whole stack: postgres, clickhouse, redpanda, loki ==")
    sh("docker", "compose", "-f", str(SERVICES), "down", "-v")
    sh("make", "services")


def _up(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=0.3):
            return True
    except OSError:
        return False


def start_generators() -> None:
    """Start the same native generators the Demo page starts; reuse any already running."""
    from .api.samples import HOST, SAMPLES, SERVE

    print(f"== turning on demo servers: {', '.join(DEMO_SAMPLES)} ==")
    LOG_DIR.mkdir(exist_ok=True)
    for sid in DEMO_SAMPLES:
        ctl = SAMPLES[sid]["ctl"]
        if _up(HOST, ctl):
            print(f"  {sid} already running on :{ctl}")
            continue
        log = open(LOG_DIR / f"gen-{sid}.log", "ab")
        # Own session so the generator outlives `make seed`, as a manual `serve.py` run would.
        subprocess.Popen([sys.executable, str(SERVE), "--type", sid, "--host", HOST],
                         stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        for _ in range(50):
            if _up(HOST, ctl):
                break
            time.sleep(0.1)
        else:
            sys.exit(f"{sid} generator did not come up on :{ctl}; see {LOG_DIR / f'gen-{sid}.log'}")
        print(f"  {sid} started on :{SAMPLES[sid]['port']}")


def configure(secrets: dict[str, str]) -> None:
    os.environ.setdefault("ALETHEIA_PG_DSN", "postgres://aletheia:aletheia@127.0.0.1:5432/aletheia")
    os.environ.setdefault("ALETHEIA_GRAFANA_URL", "http://127.0.0.1:3000")
    os.environ.setdefault("ALETHEIA_GRAFANA_PUBLIC_URL", "http://localhost:3000")
    os.environ.setdefault("ALETHEIA_ALERT_RECEIVER_URL", "http://host.docker.internal:8081")

    from .alerting.service import AlertingService
    from .api.samples import SAMPLES
    from .core.crypto import resolve_secret
    from .core.db import build_repo
    from .core.settings import SPEC, SettingsStore
    from .ingest.sources import Source, SourceRegistry

    repo = build_repo()
    secret = resolve_secret()

    print("== setting Gemini as the LLM provider ==")
    settings = SettingsStore(repo, secret=secret)
    settings.set("llm.provider", "gemini")
    model = secrets.get("ALETHEIA_LLM_MODEL") or SPEC["llm.model"][1]
    settings.set("llm.model", model)
    settings.set("llm.api_key", secrets["ALETHEIA_LLM_API_KEY"])   # sealed on write, never logged
    print(f"  provider=gemini model={model}")

    print("== connecting demo sources ==")
    registry = SourceRegistry(repo)
    for sid in DEMO_SAMPLES:
        s = SAMPLES[sid]
        p = s["preset"]
        if registry.get(p["id"]) is None:
            registry.add(Source(id=p["id"], type=p["type"], name=s["title"], config=dict(p["config"])))
            registry.event(p["id"], "created", "make seed")
            print(f"  {p['id']} ({p['type']}) registered")
        else:
            print(f"  {p['id']} already registered, skipping")

    print("== seeding and syncing alert rules, contact points and policy ==")
    alerting = AlertingService(repo, secret=secret)
    st = alerting.force_sync()
    print(f"  mode={st.get('mode')} rules={st['counts']['rules']} "
          f"contact_points={st['counts']['contact_points']}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--no-reset", action="store_true", help="skip wiping the DB/volumes")
    args = ap.parse_args()

    secrets = load_secrets()   # fail fast, before touching anything

    if args.no_reset:
        sh("make", "services")
    else:
        reset_db()

    start_generators()
    configure(secrets)

    print()
    print("done. Start (or restart) Studio to pick up the new sources: make dev")
    print("The sources are collecting; approve them on the Sources page once enough lines arrive.")


if __name__ == "__main__":
    main()
