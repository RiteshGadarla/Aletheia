"""Air-gap guard (spec §8.12.6). ALETHEIA_AIRGAP=true refuses cloud providers."""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

CLOUD_PROVIDERS = {"openai", "gemini", "groq", "anthropic"}
SELF_HOSTED_PROVIDERS = {"ollama", "openai_compatible"}
ALWAYS_PRIVATE_HOSTS = {"host.docker.internal", "localhost", "gateway.docker.internal"}


class AirgapViolation(RuntimeError):
    pass


def is_cloud_provider(provider: str, base_url: str = "") -> bool:
    """Cloud by provider name; a self-hosted provider pointed at a public address counts too."""
    p = (provider or "none").strip().lower()
    if p in CLOUD_PROVIDERS:
        return True
    if p in SELF_HOSTED_PROVIDERS and base_url:
        return not host_is_private(_host_of(base_url))
    return False


def _host_of(base_url: str) -> str:
    parsed = urlparse(base_url if "//" in base_url else f"//{base_url}")
    return (parsed.hostname or "").strip()


def host_is_private(host: str) -> bool:
    """True for loopback / RFC1918 / link-local / host.docker.internal / *.local."""
    if not host:
        return False
    h = host.lower().rstrip(".")
    if h in ALWAYS_PRIVATE_HOSTS or h.endswith(".local") or h.endswith(".internal"):
        return True
    try:
        addr = ipaddress.ip_address(h)
        return _addr_private(addr)
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(h, None)
    except OSError:
        return False        # unresolvable: treat as not provably private
    if not infos:
        return False
    return all(_addr_private(ipaddress.ip_address(i[4][0])) for i in infos)


def _addr_private(addr) -> bool:
    return bool(addr.is_loopback or addr.is_private or addr.is_link_local)


def check(provider: str, base_url: str, airgap: bool) -> None:
    """Raise AirgapViolation when this configuration is not allowed. Called at startup and per request."""
    p = (provider or "none").strip().lower()
    if not airgap or p == "none":
        return
    if p in CLOUD_PROVIDERS:
        raise AirgapViolation(
            f"ALETHEIA_AIRGAP=true: cloud provider {p!r} is refused. "
            "Use provider=none or a self-hosted endpoint on a private address."
        )
    host = _host_of(base_url)
    if not host:
        raise AirgapViolation("ALETHEIA_AIRGAP=true: a self-hosted base URL is required")
    if not host_is_private(host):
        raise AirgapViolation(
            f"ALETHEIA_AIRGAP=true: base URL host {host!r} does not resolve to a loopback, "
            "RFC1918, link-local or host.docker.internal address"
        )


def banner(provider: str, base_url: str) -> str | None:
    """Persistent UI banner text when cloud AI is active (spec §8.12.6)."""
    if is_cloud_provider(provider, base_url):
        return f"Cloud AI enabled: masked samples are sent to {provider}."
    return None
