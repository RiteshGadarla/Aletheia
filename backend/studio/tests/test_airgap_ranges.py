"""The address ranges the air-gap guard treats as "inside your own network", and the
sealing secret that lets a key be saved at all.

Both are security controls with a failure mode that is silent: a guard that accepts a
routable address still returns 200, and a secret that changes between restarts still
stores the key — it just can never be read back. Neither shows up without a test.
"""

from __future__ import annotations

import os

import pytest

from studio.core.crypto import open_sealed, resolve_secret, seal
from studio.llm.airgap import AirgapViolation, check, host_is_private, is_cloud_provider

# Genuinely inside the operator's own network.
PRIVATE = [
    "127.0.0.1", "10.1.2.3", "172.16.5.9", "172.31.255.254", "192.168.1.10",
    "169.254.1.1", "::1", "fc00::1", "fe80::1",
    "localhost", "host.docker.internal", "gateway.docker.internal",
    "ollama.internal", "box.local",
]

# Reachable off-box, so the air-gap guard must refuse them. The documentation and
# benchmarking blocks are here deliberately: `ipaddress.is_private` calls them private,
# which is why this module uses an explicit allowlist instead.
PUBLIC = [
    "8.8.8.8", "1.1.1.1", "93.184.216.34",
    "100.64.0.1", "100.127.255.255",              # CGNAT — routable inside a carrier
    "192.0.2.7", "198.51.100.9", "203.0.113.5",   # TEST-NET-1/2/3
    "198.18.0.1",                                 # benchmarking
    "::ffff:8.8.8.8",                             # IPv4-mapped IPv6 must not slip through
    "172.32.0.1", "9.255.255.255",                # just outside RFC1918
]


@pytest.mark.parametrize("host", PRIVATE)
def test_private_hosts_are_allowed(host: str) -> None:
    assert host_is_private(host), f"{host} should count as inside the network"


@pytest.mark.parametrize("host", PUBLIC)
def test_public_hosts_are_refused(host: str) -> None:
    assert not host_is_private(host), f"{host} is reachable off-box and must not pass"


@pytest.mark.parametrize("host", PUBLIC)
def test_airgap_refuses_a_local_provider_pointed_off_box(host: str) -> None:
    """The whole point of the control: `provider=local` is not a free pass."""
    with pytest.raises(AirgapViolation):
        check("local", f"http://{host}:11434/v1", airgap=True)


@pytest.mark.parametrize("host", ["127.0.0.1", "192.168.1.50", "host.docker.internal"])
def test_airgap_allows_a_genuinely_local_provider(host: str) -> None:
    check("local", f"http://{host}:11434/v1", airgap=True)   # must not raise


def test_a_local_provider_off_box_still_counts_as_cloud_for_the_banner() -> None:
    # The UI banner and the guard must agree, or a user sees "local" while talking to the internet.
    assert is_cloud_provider("local", "http://100.64.0.1:11434/v1")
    assert not is_cloud_provider("local", "http://192.168.1.50:11434/v1")


def test_airgap_always_refuses_gemini_whatever_the_url() -> None:
    with pytest.raises(AirgapViolation):
        check("gemini", "http://127.0.0.1:8080", airgap=True)


def test_provider_none_is_always_allowed() -> None:
    check("none", "", airgap=True)


# ------------------------------------------------------------------ sealing secret
def test_env_secret_always_wins() -> None:
    assert resolve_secret("from-env") == "from-env"


def test_generated_secret_is_stable_and_seals_round_trip(monkeypatch, tmp_path) -> None:
    """A regenerated secret would orphan the stored key, so stability is the property."""
    monkeypatch.delenv("ALETHEIA_SECRET", raising=False)
    monkeypatch.setattr("studio.core.crypto._LOCAL_SECRET", tmp_path / ".studio_secret")

    first = resolve_secret()
    assert first, "no secret generated, so an API key could never be saved"
    assert resolve_secret() == first, "secret changed between calls; stored keys would orphan"

    fake_key = "AIzaTESTTESTTESTTESTTESTTESTTESTFAKE0"
    blob = seal(fake_key, first)
    assert open_sealed(blob, first) == fake_key
    assert fake_key not in blob, "the sealed blob contains the plaintext key"


def test_generated_secret_file_is_owner_only(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("ALETHEIA_SECRET", raising=False)
    path = tmp_path / ".studio_secret"
    monkeypatch.setattr("studio.core.crypto._LOCAL_SECRET", path)
    resolve_secret()
    assert oct(path.stat().st_mode & 0o777) == "0o600"


def test_unwritable_location_returns_none_rather_than_an_ephemeral_key(monkeypatch, tmp_path) -> None:
    """Better to fail loudly than to seal a key with something that dies at restart."""
    monkeypatch.delenv("ALETHEIA_SECRET", raising=False)
    monkeypatch.setattr("studio.core.crypto._LOCAL_SECRET", tmp_path / "nope" / ".studio_secret")
    monkeypatch.setattr(os, "open", lambda *a, **k: (_ for _ in ()).throw(OSError("read-only")))
    assert resolve_secret() is None
