"""Shared fixtures. Nothing here talks to the network, and nothing writes to a datastore.

Two rules the whole suite depends on:

* the process environment is scrubbed of every ALETHEIA_* variable before each test, because
  `SettingsStore` resolves db > env > default (CONTRACTS §9) — a stray key or provider in the
  developer's shell would otherwise silently change what the settings tests are asserting;
* ClickHouse is optional. The integration tests skip, never fail, on a bare checkout.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Iterator

import pytest
import yaml

# `pytest studio/tests` is run from backend/, but allow a bare `pytest` from the repo root too.
_BACKEND = Path(__file__).resolve().parents[2]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from studio.api.state import AppState, reset_state          # noqa: E402
from studio.core.packs import PackRegistry                  # noqa: E402

REPO_ROOT = _BACKEND.parent
REAL_PACKS = _BACKEND / "packs"

# A deliberately fake key: shaped like a real one, last4 "AKE0", never valid anywhere.
FAKE_API_KEY = "AIzaTESTTESTTESTTESTTESTTESTTESTFAKE0"


# Kept out of the scrub: they only point the read-only ClickHouse queries at the right server.
_KEEP_ENV_PREFIXES = ("ALETHEIA_CH_", "ALETHEIA_CLICKHOUSE_")


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Remove every ALETHEIA_* variable so settings resolution starts from the documented defaults.

    Dropping ALETHEIA_PG_DSN / DATABASE_URL also guarantees the settings tests write to a
    MemoryRepo: the suite must never touch the shared Postgres `settings` table.
    """
    for name in [k for k in os.environ if k.startswith("ALETHEIA_")]:
        if name.startswith(_KEEP_ENV_PREFIXES):
            continue
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    yield


_CH_WRITE = ("truncate", "drop", "delete", "alter", "insert", "optimize", "rename", "create")


@pytest.fixture(autouse=True)
def no_datastore_writes(monkeypatch: pytest.MonkeyPatch) -> None:
    """The suite reads the developer's live ClickHouse; it must never wipe it (e.g. via /settings/reset)."""
    from studio import main as studio_main

    real = studio_main._ch

    def guarded(sql: str, *a: Any, **kw: Any) -> list[dict[str, Any]]:
        if sql.lstrip().split(None, 1)[0].lower() in _CH_WRITE:
            return []
        return real(sql, *a, **kw)

    monkeypatch.setattr(studio_main, "_ch", guarded)
    monkeypatch.setattr(studio_main, "_demo", lambda *a, **kw: (0, "demo disabled in tests"))


@pytest.fixture
def state(clean_env: None) -> Iterator[AppState]:
    """A fresh in-memory AppState installed as the process singleton the routes read."""
    st = reset_state(AppState())
    yield st
    reset_state(AppState())


@pytest.fixture
def client(state: AppState) -> Iterator[Any]:
    from fastapi.testclient import TestClient

    from studio.main import app

    # raise_server_exceptions=False so an unhandled 500 is asserted as a status code rather than
    # blowing up the test — a contract break must be reported, not raised.
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


# ------------------------------------------------------------------ pack fixtures
@pytest.fixture
def real_registry(clean_env: None) -> PackRegistry:
    """The shipped packs in backend/packs — the ones the demo actually runs on."""
    return PackRegistry(REAL_PACKS)


# Two envelopes carrying the same body, which is the situation `spliced()` exists for: the
# ClickHouse `templates` table is a ReplacingMergeTree keyed on (template_id, pack_version), so
# it can only remember ONE of them. Tokens must come from the packs on disk instead.
FIXTURE_ENVELOPES = {
    "envelopes": {
        "env_host": [
            {"lit": "<"}, {"slot": "pri", "type": "int"}, {"lit": ">"},
            {"slot": "ts", "type": "syslog3164_ts"}, {"lit": " "},
            {"slot": "host", "type": "hostname"}, {"lit": " "},
            {"slot": "body", "type": "text"},
        ],
        "env_nohost": [
            {"lit": "<"}, {"slot": "pri", "type": "int"}, {"lit": ">"},
            {"slot": "ts", "type": "syslog3164_ts"}, {"lit": " "},
            {"slot": "body", "type": "text"},
        ],
    }
}

FIXTURE_PACK = {
    "pack": "fixture",
    "version": 3,
    "applies_to": {"vendor": "Fixture", "product": "Test"},
    "envelopes": ["env_host", "env_nohost"],
    "templates": [{
        "id": "fx_conn",
        "discriminator": "FXCONN",
        "body": [
            {"lit": "FXCONN "}, {"slot": "direction", "type": "enum",
                                 "values": ["inbound", "outbound"]},
            {"lit": " "}, {"slot": "ip_a", "type": "ip"},
            {"lit": " -> "}, {"slot": "ip_b", "type": "ip"},
            {"slot": "gap", "type": "ws"},
            {"lit": "state="}, {"slot": "state", "type": "word"},
            {"lit": " id="}, {"slot": "conn_id", "type": "int"},
            {"lit": " extra="}, {"slot": "extra", "type": "word"},
        ],
        "ocsf": {
            "class_uid": 4001,
            "activity_id": 1,
            "constants": {"connection_info.protocol_name": "tcp"},
            "map": {
                "conn_id": "connection_info.uid",
                "state": {"path": "status_id", "enum": {"up": 1, "down": 2}},
            },
            "conditional": [
                {"when": {"direction": "outbound"},
                 "map": {"ip_a": "src_endpoint.ip", "ip_b": "dst_endpoint.ip"}},
                {"when": {"direction": "inbound"},
                 "map": {"ip_a": "dst_endpoint.ip", "ip_b": "src_endpoint.ip"}},
            ],
        },
    }],
}

# A pack that declares no envelopes at all: the loader must default it to ["bare"], meaning the
# body template IS the whole line (CEF/LEEF over a non-syslog transport).
FIXTURE_BARE_PACK = {
    "pack": "fixture_bare",
    "version": 1,
    "templates": [{
        "id": "fx_bare",
        "body": [{"lit": "BARE "}, {"slot": "who", "type": "word"}],
        "ocsf": {"class_uid": 4001, "activity_id": 1, "map": {"who": "user.name"}},
    }],
}


@pytest.fixture
def fixture_packs(tmp_path: Path) -> Path:
    """A miniature packs directory: two envelopes, one bodied template, one bare-only pack."""
    (tmp_path / "_envelopes.yaml").write_text(yaml.safe_dump(FIXTURE_ENVELOPES), encoding="utf-8")
    (tmp_path / "fixture.yaml").write_text(yaml.safe_dump(FIXTURE_PACK), encoding="utf-8")
    (tmp_path / "bare.yaml").write_text(yaml.safe_dump(FIXTURE_BARE_PACK), encoding="utf-8")
    return tmp_path


@pytest.fixture
def registry(fixture_packs: Path) -> PackRegistry:
    return PackRegistry(fixture_packs)


@pytest.fixture
def fx_template() -> dict[str, Any]:
    """The `fx_conn` template definition, as a plain dict, for build_field_map() unit tests."""
    return FIXTURE_PACK["templates"][0]


# ------------------------------------------------------------------ ClickHouse
@pytest.fixture(scope="session")
def clickhouse() -> None:
    """Skip, do not fail, when ClickHouse is not up: the suite must run on a bare checkout."""
    from studio import main as studio_main

    if not studio_main._ch_up():
        pytest.skip(f"ClickHouse unavailable at {studio_main.CH_URL} — run `make services`")
    return None
