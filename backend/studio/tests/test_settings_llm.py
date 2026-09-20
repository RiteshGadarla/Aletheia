"""LLM config precedence, the air-gap rule and key secrecy (CONTRACTS §9, §10.5).

Three things are frozen by the contract and have to stay frozen:

* precedence is **PostgreSQL settings > environment variable > default**, because the shipped
  image has no key and the operator sets one at runtime;
* air-gap mode refuses cloud providers outright — that is the whole point of the switch;
* **the API never returns an API key, only `last4`.** Every response and every error body in
  this module is searched for the key, because a leak here is not a bug the UI would show.

No test in this file makes a network call: the provider is stubbed wherever one is needed.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from studio.core.models import ConnTest
from studio.core.settings import DEFAULT_BASE_URLS, PROVIDERS, SettingsStore
from studio.llm import airgap
from studio.llm.base import LLMUnavailable
from studio.llm.factory import build_provider, origin_tag

from .conftest import FAKE_API_KEY

SECRET = "test-secret-not-a-real-one"


class StubProvider:
    """Stands in for GeminiProvider / OpenAICompatibleProvider. Never opens a socket."""

    name = "stub"
    model = "stub-model"
    last_usage: dict[str, int] | None = None

    def complete_json(self, system_prompt: str, user_prompt: str, schema: dict) -> dict:
        return {}

    def test_connection(self) -> ConnTest:
        return ConnTest(ok=True, latency_ms=1, json_mode="response_schema",
                        models=["stub-model"], provider="stub", model="stub-model")


# ------------------------------------------------------------------ precedence (§9)
def test_default_is_used_when_nothing_else_says_otherwise(state) -> None:
    cfg = state.settings.llm_config()
    assert cfg.provider == "gemini" and cfg.model == "gemma-4-31b-it"
    assert cfg.source["provider"] == "default"
    assert cfg.base_url == DEFAULT_BASE_URLS["gemini"]


def test_env_beats_default(state, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ALETHEIA_LLM_PROVIDER", "local")
    monkeypatch.setenv("ALETHEIA_LLM_MODEL", "qwen2.5")
    cfg = state.settings.llm_config()
    assert (cfg.provider, cfg.model) == ("local", "qwen2.5")
    assert cfg.source["provider"] == "env"
    # An unset base_url still falls back to the provider default, not to Gemini's.
    assert cfg.base_url == DEFAULT_BASE_URLS["local"]


def test_db_beats_env(state, monkeypatch: pytest.MonkeyPatch) -> None:
    """The Settings page must win over the container's environment, or the UI would be a lie."""
    monkeypatch.setenv("ALETHEIA_LLM_PROVIDER", "local")
    state.settings.set("llm.provider", "none")
    cfg = state.settings.llm_config()
    assert cfg.provider == "none"
    assert cfg.source["provider"] == "db"


def test_key_file_is_read_when_no_env_key_is_set(state, tmp_path, monkeypatch) -> None:
    """ALETHEIA_LLM_API_KEY_FILE is the env-side key source Docker secrets use."""
    key_file = tmp_path / "key"
    key_file.write_text(FAKE_API_KEY + "\n", encoding="utf-8")
    monkeypatch.setenv("ALETHEIA_LLM_API_KEY_FILE", str(key_file))
    cfg = state.settings.llm_config()
    assert cfg.api_key == FAKE_API_KEY
    assert cfg.source["api_key"] == "env"


def test_sealed_db_key_round_trips(monkeypatch: pytest.MonkeyPatch) -> None:
    """Encrypted settings are AES-GCM sealed; the stored blob must not be the key itself."""
    monkeypatch.setenv("ALETHEIA_SECRET", SECRET)
    from studio.core.db import MemoryRepo

    repo = MemoryRepo()
    store = SettingsStore(repo, secret=SECRET)
    store.set("llm.api_key", FAKE_API_KEY)

    stored = repo.settings_all()["llm.api_key"]
    assert stored.encrypted is True
    assert FAKE_API_KEY not in stored.value
    assert store.get("llm.api_key") == FAKE_API_KEY


def test_public_view_exposes_last4_and_nothing_more(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ALETHEIA_LLM_API_KEY", FAKE_API_KEY)
    store = SettingsStore(secret=SECRET)
    pub = store.llm_config().public()
    assert "api_key" not in pub
    assert pub["api_key_set"] is True
    assert pub["api_key_last4"] == FAKE_API_KEY[-4:]
    assert FAKE_API_KEY not in json.dumps(pub)


# ------------------------------------------------------------------ providers (§9)
def test_exactly_three_providers_are_supported() -> None:
    """OpenAI, Groq and Anthropic were removed from the product; the UI list must not grow back."""
    assert PROVIDERS == ("none", "gemini", "local")
    assert set(DEFAULT_BASE_URLS) == {"gemini", "local", "none"}


def test_ollama_is_a_legacy_alias_for_local_and_not_a_ui_option() -> None:
    from studio.core.settings import LLMConfig

    assert "ollama" not in PROVIDERS
    provider = build_provider(LLMConfig(provider="ollama", model="llama3",
                                        base_url="http://localhost:11434/v1"))
    assert provider.name == "ollama"        # honoured, but never offered


def test_origin_tag_never_contains_the_key() -> None:
    from studio.core.settings import LLMConfig

    cfg = LLMConfig(provider="gemini", model="gemma-4-31b-it", api_key=FAKE_API_KEY)
    tag = origin_tag(cfg)
    assert tag == "ai:gemini/gemma-4-31b-it"
    assert FAKE_API_KEY not in tag
    assert origin_tag(LLMConfig(provider="none")) == "heuristic"


# ------------------------------------------------------------------ air gap (§8.12.6)
def test_airgap_refuses_the_cloud_provider() -> None:
    with pytest.raises(airgap.AirgapViolation):
        airgap.check("gemini", DEFAULT_BASE_URLS["gemini"], airgap=True)


@pytest.mark.parametrize("base_url", ["http://localhost:11434/v1", "http://127.0.0.1:11434/v1",
                                      "http://10.1.2.3:8000/v1", "http://host.docker.internal:1234"])
def test_airgap_allows_a_private_local_endpoint(base_url: str) -> None:
    airgap.check("local", base_url, airgap=True)          # must not raise


def test_airgap_refuses_a_local_provider_pointed_at_the_public_internet() -> None:
    """`provider=local` is not a loophole: the address is what decides, not the label."""
    # A literal, globally routable address: the check needs no DNS, so the suite stays offline.
    # Not a documentation range (203.0.113.0/24 and friends) — Python's ipaddress reports those
    # as `is_private`, so they would pass the guard and prove nothing.
    with pytest.raises(airgap.AirgapViolation):
        airgap.check("local", "https://8.8.8.8:8000/v1", airgap=True)
    with pytest.raises(airgap.AirgapViolation):
        airgap.check("local", "", airgap=True)


def test_airgap_always_allows_provider_none() -> None:
    airgap.check("none", "", airgap=True)
    assert airgap.banner("none", "") is None
    assert "gemini" in (airgap.banner("gemini", DEFAULT_BASE_URLS["gemini"]) or "")


def test_build_provider_refuses_cloud_under_airgap() -> None:
    from studio.core.settings import LLMConfig

    cfg = LLMConfig(provider="gemini", model="gemma-4-31b-it", api_key=FAKE_API_KEY,
                    base_url=DEFAULT_BASE_URLS["gemini"], airgap=True)
    with pytest.raises(airgap.AirgapViolation):
        build_provider(cfg)


def test_build_provider_checks_airgap_before_anything_else() -> None:
    """Air-gap must not be reachable only through a fully configured provider."""
    from studio.core.settings import LLMConfig

    with pytest.raises(airgap.AirgapViolation):
        build_provider(LLMConfig(provider="gemini", model="", api_key="", airgap=True))


def test_build_provider_reports_missing_config_as_unavailable() -> None:
    from studio.core.settings import LLMConfig

    with pytest.raises(LLMUnavailable):
        build_provider(LLMConfig(provider="gemini", model=""))
    with pytest.raises(LLMUnavailable):
        build_provider(LLMConfig(provider="gemini", model="gemma-4-31b-it", api_key=""))
    with pytest.raises(LLMUnavailable):
        build_provider(LLMConfig(provider="openai", model="gpt-4"))


# ------------------------------------------------------------------ the HTTP surface
def _assert_no_key(response: Any) -> None:
    body = response.text
    assert FAKE_API_KEY not in body
    assert FAKE_API_KEY[:-4] not in body, "even a truncated key must not appear"


def test_settings_endpoint_returns_the_frontend_shape(client: Any) -> None:
    r = client.get("/api/v1/settings/llm")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"provider", "model", "base_url", "send_samples", "api_key_last4",
                         "api_key_set", "airgap", "sources", "usage", "updated_at"}
    assert set(body["usage"]) == {"requests", "tokens", "window", "cap_per_hour"}
    assert body["usage"]["window"] == "hour"
    assert body["api_key_last4"] is None and body["api_key_set"] is False
    assert set(body["sources"].values()) <= {"db", "env", "default"}


def test_saved_key_is_never_echoed_back(client: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    """The single most important assertion in this file: the key leaves the process as last4.

    It is checked on the PUT response, on the following GET, on the connection test and on the
    OpenAPI document, because any one of those is a place a key could quietly surface.
    """
    monkeypatch.setenv("ALETHEIA_SECRET", SECRET)

    put = client.put("/api/v1/settings/llm", json={
        "provider": "gemini", "model": "gemma-4-31b-it", "base_url": "",
        "send_samples": "masked", "api_key": FAKE_API_KEY})
    assert put.status_code == 200, put.text
    _assert_no_key(put)
    assert put.json()["api_key_last4"] == FAKE_API_KEY[-4:]
    assert put.json()["api_key_set"] is True
    assert put.json()["sources"]["api_key"] == "db"

    get = client.get("/api/v1/settings/llm")
    _assert_no_key(get)
    assert get.json()["api_key_last4"] == FAKE_API_KEY[-4:]

    monkeypatch.setattr("studio.main.build_provider", lambda cfg: StubProvider())
    test = client.post("/api/v1/settings/llm/test")
    assert test.status_code == 200
    _assert_no_key(test)

    _assert_no_key(client.get("/openapi.json"))
    _assert_no_key(client.get("/healthz"))


def test_omitted_key_keeps_the_stored_one_and_empty_clears_it(
        client: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ALETHEIA_SECRET", SECRET)
    base = {"provider": "gemini", "model": "gemma-4-31b-it", "base_url": "",
            "send_samples": "masked"}
    client.put("/api/v1/settings/llm", json={**base, "api_key": FAKE_API_KEY})

    kept = client.put("/api/v1/settings/llm", json=base)             # api_key omitted
    assert kept.json()["api_key_set"] is True

    cleared = client.put("/api/v1/settings/llm", json={**base, "api_key": ""})
    assert cleared.json()["api_key_set"] is False
    assert cleared.json()["api_key_last4"] is None


def test_connection_test_is_a_400_not_a_500_when_nothing_is_configured(client: Any) -> None:
    """Regression: provider=gemini with no key is the shipped default state (CONTRACTS §9).

    build_provider raised LLMUnavailable straight through the handler, so the Settings page's
    "Test connection" button answered 500 with a traceback out of the box.
    """
    r = client.post("/api/v1/settings/llm/test")
    assert r.status_code == 400, r.text
    assert "key" in r.json()["detail"].lower()


def test_connection_test_succeeds_with_a_stubbed_provider(
        client: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("studio.main.build_provider", lambda cfg: StubProvider())
    r = client.post("/api/v1/settings/llm/test")
    assert r.status_code == 200
    body = r.json()
    assert set(body) >= {"ok", "latency_ms", "json_mode", "models", "error", "provider", "model"}
    assert body["ok"] is True


def test_airgap_toggle_persists_and_then_refuses_the_cloud(client: Any) -> None:
    """Regression: the handler wrote the setting under "llm.airgap", which SettingsStore rejects.

    SPEC keys the value "airgap", so `set` raised KeyError and the entire air-gap switch — the
    feature that makes the product usable on a disconnected network — answered 500.
    """
    on = client.post("/api/v1/settings/airgap", json={"airgap": True})
    assert on.status_code == 200, on.text
    assert on.json()["airgap"] is True
    assert client.get("/api/v1/settings/llm").json()["airgap"] is True

    # Default provider is gemini, so with air-gap on the connection test must be refused.
    refused = client.post("/api/v1/settings/llm/test")
    assert refused.status_code == 400
    assert "airgap" in refused.json()["detail"].lower()

    off = client.post("/api/v1/settings/airgap", json={"airgap": False})
    assert off.status_code == 200 and off.json()["airgap"] is False


def test_redact_removes_secrets_from_provider_error_text() -> None:
    from studio.llm.base import redact

    assert FAKE_API_KEY not in redact(f"HTTP 400: bad key {FAKE_API_KEY}", [FAKE_API_KEY])
    # Short strings are left alone so redaction cannot blank out an entire error message.
    assert redact("boom", ["ab"]) == "boom"
