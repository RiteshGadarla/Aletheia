"""Local mirror of the engine's template compiler (CONTRACTS §1).

Used for self-checks, type validation and coverage only — the authoritative matcher is the Go
engine, which the gate shells out to. Patterns here must stay identical to the table in §1.
"""

from __future__ import annotations

import re
from typing import Iterable

from ..core.models import FIXED_WIDTH_TYPES, Token

IPV4 = r"(?:\d{1,3}\.){3}\d{1,3}"
IPV6 = r"[0-9A-Fa-f:]{2,45}"

PATTERNS: dict[str, str] = {
    "int": r"\d+",
    "port": r"\d{1,5}",
    "ipv4": IPV4,
    "ipv6": IPV6,
    "ip": f"(?:{IPV4}|{IPV6})",
    "mac": r"(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}",
    "hostname": r"[A-Za-z0-9._-]+",
    "syslog3164_ts": r"[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}",
    "iso8601_ts": r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?",
    "epoch_ts": r"\d{9,10}(?:\.\d+)?",
    "word": r"\S+",
    "quoted": r'"(?:[^"\\]|\\.)*"',
    "ws": r"[ \t]+",
    "text": r".*?",
}


class CompileError(ValueError):
    pass


def slot_pattern(tok: Token) -> str:
    t = (tok.type or "word").lower()
    if t == "enum":
        vals = sorted(tok.values or [], key=len, reverse=True)
        if not vals:
            raise CompileError(f"slot {tok.slot!r}: enum with no values")
        return "|".join(re.escape(v) for v in vals)
    if t == "custom":
        if not tok.pattern:
            raise CompileError(f"slot {tok.slot!r}: custom with no pattern")
        return tok.pattern
    if t not in PATTERNS:
        raise CompileError(f"slot {tok.slot!r}: unknown type {t!r}")
    return PATTERNS[t]


def validate_tokens(tokens: list[Token]) -> list[str]:
    """CONTRACTS §1 validation rules. Returns human-readable problems."""
    problems: list[str] = []
    slots = [t for t in tokens if not t.is_lit()]
    names = [t.slot for t in slots]
    dupes = {n for n in names if names.count(n) > 1}
    if dupes:
        problems.append(f"duplicate slot names: {sorted(dupes)}")
    for i, tok in enumerate(tokens):
        if tok.is_lit():
            if not tok.lit:
                problems.append(f"token {i}: empty literal")
            continue
        t = (tok.type or "word").lower()
        nxt = tokens[i + 1] if i + 1 < len(tokens) else None
        if t == "text" and nxt is not None and not nxt.is_lit():
            problems.append(f"slot {tok.slot!r}: `text` must be followed by a literal or be last")
        if nxt is not None and not nxt.is_lit():
            if not (t in FIXED_WIDTH_TYPES and (nxt.type or "") in FIXED_WIDTH_TYPES):
                problems.append(
                    f"adjacent slots {tok.slot!r} and {nxt.slot!r} are ambiguous "
                    "(only fixed-width types may be adjacent)"
                )
    return problems


def compile_tokens(tokens: list[Token]) -> re.Pattern[str]:
    """^ + QuoteMeta(lit) | (pattern) + $ — one capture group per slot, in order."""
    parts = ["^"]
    for tok in tokens:
        if tok.is_lit():
            parts.append(re.escape(tok.lit or ""))
        else:
            parts.append("(" + slot_pattern(tok) + ")")
    parts.append("$")
    return re.compile("".join(parts))


def reconstruct(tokens: list[Token], values: Iterable[str]) -> str:
    """Concatenate literals and values in token order (CONTRACTS §1)."""
    it = iter(values)
    out: list[str] = []
    for tok in tokens:
        out.append(tok.lit or "" if tok.is_lit() else next(it))
    return "".join(out)


def match_values(tokens: list[Token], line: str) -> list[str] | None:
    rx = compile_tokens(tokens)
    m = rx.match(line)
    return list(m.groups()) if m else None


def type_ok(slot_type: str, value: str, tok: Token | None = None) -> bool:
    probe = tok or Token(slot="x", type=slot_type)
    try:
        return re.fullmatch(slot_pattern(probe), value) is not None
    except CompileError:
        return False
