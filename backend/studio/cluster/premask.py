"""Pre-masking for clustering (spec §8.6).

IPs, numbers, hex strings and timestamps are masked *before* Drain sees the line, so lines that
differ only in those values land in the same cluster. The mask is never used for template
derivation — derivation reads the original bytes.
"""

from __future__ import annotations

import re

# Order matters: longest / most specific patterns first.
RULES: list[tuple[str, re.Pattern[str], str]] = [
    ("iso8601_ts", re.compile(
        r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?"), "<TS>"),
    ("syslog_ts", re.compile(r"\b[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}\b"), "<TS>"),
    ("mac", re.compile(r"\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b"), "<MAC>"),
    ("ipv6", re.compile(r"\b(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}\b"), "<IPV6>"),
    ("ipv4", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "<IP>"),
    ("uuid", re.compile(
        r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"), "<UUID>"),
    ("hex", re.compile(r"\b(?:0x[0-9a-fA-F]+|[0-9a-fA-F]{8,})\b"), "<HEX>"),
    ("epoch", re.compile(r"\b\d{9,10}(?:\.\d+)?\b"), "<TS>"),
    ("num", re.compile(r"(?<![\w.])\d+(?:\.\d+)?(?![\w.])"), "<NUM>"),
]


def premask(line: str) -> str:
    """Return the masked form used only as the clustering key."""
    out = line
    for _name, rx, repl in RULES:
        out = rx.sub(repl, out)
    return out


def premask_detail(line: str) -> dict[str, int]:
    """Count of each mask applied — surfaced in the UI to explain a cluster."""
    counts: dict[str, int] = {}
    out = line
    for name, rx, repl in RULES:
        out, n = rx.subn(repl, out)
        if n:
            counts[name] = n
    return counts
