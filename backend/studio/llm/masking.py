"""Format-preserving, deterministic masking of sample values (spec §8.12.5).

Same input always yields the same placeholder. A masked IPv4 is still an IPv4, so the model
can still infer the slot holds an address. Ports, protocol words, action words and plain
numbers are kept because they carry meaning.
"""

from __future__ import annotations

import ipaddress
import re
import threading

# RFC 5737 documentation ranges, used in order.
_DOC_V4_NETS = ("192.0.2", "198.51.100", "203.0.113")
_DOC_V6_NET = 0x20010DB8            # 2001:db8::/32
_DOC_MAC_PREFIX = "00:00:5e:00:53"  # IANA documentation MAC range

KEEP_TYPES = {
    "int", "port", "enum", "syslog3164_ts", "iso8601_ts", "epoch_ts", "ws",
}

PROTOCOL_WORDS = {
    "tcp", "udp", "icmp", "gre", "esp", "ah", "sctp", "ipv6-icmp", "http", "https",
    "dns", "ssh", "tls", "ssl", "ftp", "smtp", "ipsec", "ike", "arp",
}
ACTION_WORDS = {
    "allow", "allowed", "accept", "accepted", "permit", "permitted", "pass", "passed",
    "deny", "denied", "drop", "dropped", "block", "blocked", "reject", "rejected",
    "built", "teardown", "success", "failure", "failed", "login", "logout",
    "inbound", "outbound", "in", "out", "up", "down",
}

_RE_IPV4 = re.compile(r"^(?:\d{1,3}\.){3}\d{1,3}$")
_RE_MAC = re.compile(r"^(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$")
_RE_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_RE_HOSTNAME = re.compile(r"^(?=.{1,253}$)[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)+\.?$")
_RE_USERISH = re.compile(r"user|acct|account|login|owner|sender|recipient|mail", re.I)
_RE_HOSTISH = re.compile(r"host|fqdn|device|machine|dvchost|computer", re.I)


class MaskingError(ValueError):
    pass


class Masker:
    """Stable registry of value -> placeholder. Collision-free within one Masker."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._map: dict[tuple[str, str], str] = {}
        self._counters: dict[str, int] = {}

    def _placeholder(self, kind: str, value: str) -> str:
        with self._lock:
            hit = self._map.get((kind, value))
            if hit is not None:
                return hit
            n = self._counters.get(kind, 0) + 1
            self._counters[kind] = n
            out = _render(kind, n, value)
            self._map[(kind, value)] = out
            return out

    # ---- public ------------------------------------------------------
    def mask_value(self, value: str, slot_type: str = "word", slot_name: str = "") -> str:
        kind = classify(value, slot_type, slot_name)
        if kind == "keep":
            return value
        return self._placeholder(kind, value)

    def mask_values(self, values, slot_type: str = "word", slot_name: str = "") -> list[str]:
        return [self.mask_value(v, slot_type, slot_name) for v in values]

    def reverse(self) -> dict[str, str]:
        """placeholder -> original. Studio-side only; never sent anywhere."""
        with self._lock:
            return {ph: val for (_, val), ph in self._map.items()}


def classify(value: str, slot_type: str = "word", slot_name: str = "") -> str:
    """Return the placeholder kind, or 'keep' when the value carries meaning and is not sensitive."""
    v = (value or "").strip()
    if not v:
        return "keep"
    t = (slot_type or "word").lower()
    if t in KEEP_TYPES:
        return "keep"
    if t in ("ip", "ipv4", "ipv6"):
        return _ip_kind(v)
    if t == "mac":
        return "mac"
    if t == "hostname":
        return "host" if not _RE_IPV4.match(v) else _ip_kind(v)

    # type-agnostic sniffing for word / text / quoted / custom
    if _RE_IPV4.match(v) or _looks_v6(v):
        return _ip_kind(v)
    if _RE_MAC.match(v):
        return "mac"
    if _RE_EMAIL.match(v):
        return "email"
    if _RE_USERISH.search(slot_name):
        return "user"
    if _RE_HOSTISH.search(slot_name) or _RE_HOSTNAME.match(v):
        return "host"
    low = v.lower()
    if low in PROTOCOL_WORDS or low in ACTION_WORDS:
        return "keep"
    if v.isdigit():
        return "keep"
    return "keep"


def _looks_v6(v: str) -> bool:
    if ":" not in v:
        return False
    try:
        ipaddress.IPv6Address(v)
        return True
    except ValueError:
        return False


def _ip_kind(v: str) -> str:
    try:
        return "ipv6" if isinstance(ipaddress.ip_address(v), ipaddress.IPv6Address) else "ipv4"
    except ValueError:
        return "ipv4" if _RE_IPV4.match(v) else "host"


def _render(kind: str, n: int, original: str) -> str:
    if kind == "ipv4":
        idx = n - 1
        net = _DOC_V4_NETS[(idx // 254) % len(_DOC_V4_NETS)]
        return f"{net}.{(idx % 254) + 1}"
    if kind == "ipv6":
        addr = ipaddress.IPv6Address(_DOC_V6_NET << 96 | n)
        return str(addr)
    if kind == "mac":
        sep = "-" if "-" in original else ":"
        body = f"{_DOC_MAC_PREFIX}:{(n - 1) % 256:02x}"
        return body.replace(":", sep) if sep != ":" else body
    if kind == "user":
        return f"user_{n}"
    if kind == "host":
        return f"host_{n}" if "." not in original else f"host_{n}.example.com"
    if kind == "email":
        return f"user_{n}@example.com"
    return f"val_{n}"


_DEFAULT = Masker()


def mask_value(value: str, slot_type: str = "word", slot_name: str = "") -> str:
    """Process-wide deterministic masking: the same input always yields the same placeholder."""
    return _DEFAULT.mask_value(value, slot_type, slot_name)


def check_send_mode(mode: str, is_cloud: bool) -> str:
    """`raw` is rejected for cloud providers (spec §8.12.5)."""
    m = (mode or "masked").strip().lower()
    if m not in ("masked", "none", "raw"):
        raise MaskingError(f"unknown ALETHEIA_LLM_SEND_SAMPLES value {m!r}")
    if m == "raw" and is_cloud:
        raise MaskingError("send_samples=raw is refused for cloud providers; use masked or none")
    return m
