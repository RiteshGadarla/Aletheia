"""Slot typing from all sample values of a slot (spec §8.8). Types are CONTRACTS §1 strings."""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass

RE_INT = re.compile(r"^\d+$")
RE_IPV4 = re.compile(r"^(?:\d{1,3}\.){3}\d{1,3}$")
RE_MAC = re.compile(r"^(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$")
RE_SYSLOG_TS = re.compile(r"^[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}$")
RE_ISO_TS = re.compile(
    r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$")
RE_EPOCH_TS = re.compile(r"^\d{9,10}(?:\.\d+)?$")
RE_HOSTNAME = re.compile(r"^[A-Za-z0-9._-]+$")
RE_WORDISH = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*$")
RE_QUOTED = re.compile(r'^"(?:[^"\\]|\\.)*"$')
RE_WS = re.compile(r"^[ \t]+$")
RE_PORTISH_NAME = re.compile(r"port|^spt$|^dpt$|^sport$|^dport$", re.I)

ENUM_WORDS = {
    "allow", "allowed", "accept", "accepted", "permit", "permitted", "pass", "passed",
    "deny", "denied", "drop", "dropped", "block", "blocked", "reject", "rejected",
    "inbound", "outbound", "in", "out", "success", "failure", "failed", "succeeded",
    "tcp", "udp", "icmp", "up", "down", "start", "stop", "open", "close", "built", "teardown",
}
MAX_ENUM_VALUES = 6


@dataclass
class TypeVerdict:
    type: str
    enum_values: list[str] | None = None
    evidence: list[str] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.evidence is None:
            self.evidence = []


def _is_ip(v: str) -> bool:
    try:
        ipaddress.ip_address(v)
        return True
    except ValueError:
        return False


def _is_v6(v: str) -> bool:
    try:
        return isinstance(ipaddress.ip_address(v), ipaddress.IPv6Address)
    except ValueError:
        return False


def infer_type(values: list[str], prev_lit: str = "", next_lit: str = "",
               slot_name: str = "") -> TypeVerdict:
    """Evidence-ordered per spec §8.8. `values` are exact raw substrings."""
    vals = [v for v in values if v is not None]
    distinct = sorted(set(vals))
    ev: list[str] = []

    if not vals:
        return TypeVerdict("word", evidence=["no sample values"])
    if any(v == "" for v in vals):
        # `text` is the only type that can be empty; legal because a literal always follows.
        return TypeVerdict("text", evidence=["at least one sample is empty"])
    if all(RE_WS.match(v) for v in vals):
        return TypeVerdict("ws", evidence=["all values are whitespace runs"])
    if all(RE_QUOTED.match(v) for v in vals):
        return TypeVerdict("quoted", evidence=["all values are double-quoted strings"])

    if all(_is_ip(v) for v in vals):
        if all(_is_v6(v) for v in vals):
            return TypeVerdict("ipv6", evidence=["all values parse as IPv6"])
        if not any(_is_v6(v) for v in vals):
            return TypeVerdict("ipv4", evidence=["all values parse as IPv4"])
        return TypeVerdict("ip", evidence=["values parse as a mix of IPv4 and IPv6"])
    if all(RE_MAC.match(v) for v in vals):
        return TypeVerdict("mac", evidence=["all values are six hex pairs"])

    if all(RE_SYSLOG_TS.match(v) for v in vals):
        return TypeVerdict("syslog3164_ts", evidence=["all values match RFC 3164 timestamps"])
    if all(RE_ISO_TS.match(v) for v in vals):
        return TypeVerdict("iso8601_ts", evidence=["all values match ISO 8601 timestamps"])

    if all(RE_INT.match(v) for v in vals):
        nums = [int(v) for v in vals]
        port_ctx = bool(RE_PORTISH_NAME.search(slot_name)) or prev_lit.endswith(("/", ":"))
        if port_ctx and all(0 <= n <= 65535 for n in nums):
            ev.append("integers in 0..65535 with port context "
                      f"({'name' if RE_PORTISH_NAME.search(slot_name) else 'separator ' + prev_lit[-1:]})")
            return TypeVerdict("port", evidence=ev)
        if all(RE_EPOCH_TS.match(v) for v in vals) and all(10**8 < n < 2 * 10**9 for n in nums):
            return TypeVerdict("epoch_ts", evidence=["all values look like epoch seconds"])
        return TypeVerdict("int", evidence=["all values are integers"])

    if (len(distinct) <= MAX_ENUM_VALUES and all(RE_WORDISH.match(v) for v in distinct)
            and (all(v.lower() in ENUM_WORDS for v in distinct) or len(vals) >= 3 * len(distinct))):
        ev.append(f"small fixed word set ({len(distinct)} distinct)")
        return TypeVerdict("enum", enum_values=distinct, evidence=ev)

    if any(" " in v for v in vals) and next_lit:
        return TypeVerdict("text", evidence=["values contain spaces and a literal follows"])
    if any(" " in v for v in vals):
        return TypeVerdict("text", evidence=["values contain spaces (last token)"])

    if all(RE_HOSTNAME.match(v) for v in vals) and any("." in v for v in vals) \
            and any(c.isalpha() for v in vals for c in v):
        return TypeVerdict("hostname", evidence=["dotted names of hostname characters"])

    return TypeVerdict("word", evidence=["no stronger evidence; non-space run"])
