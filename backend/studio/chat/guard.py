"""Lyra SQL guardrail: only a single read-only SELECT over allow-listed tables, columns, functions."""

from __future__ import annotations

import re

TABLES = {"events", "templates"}
COLUMNS = {
    "event_uid", "recv_time", "event_time", "source_id", "envelope_id", "template_id", "pack_version",
    "storage_mode", "parse_status", "class_uid", "activity_id", "severity_id", "src_ip", "src_port",
    "dst_ip", "dst_port", "protocol", "action_id", "user_name", "pack", "created_at",
}
FUNCTIONS = {
    "count", "sum", "avg", "min", "max", "uniq", "uniqexact", "countif", "sumif", "topk", "quantile",
    "median", "tostring", "tostartofminute", "tostartofhour", "tostartofday", "tostartoffiveminutes",
    "tounixtimestamp", "now", "today", "todate", "todatetime", "replaceone", "lower", "upper", "length",
    "if", "multiif", "coalesce", "ifnull", "round", "floor", "ceil", "abs", "has", "startswith",
    "endswith", "touint32", "toint32", "touint16", "tofloat64", "tohour", "todayofweek", "datediff",
    "substring", "concat", "isipaddressinrange", "ipv6stringtonum", "in", "positioncaseinsensitive",
    "position", "notlike", "like",
}
KEYWORDS = {
    "select", "from", "where", "group", "by", "order", "having", "limit", "as", "and", "or", "not", "in",
    "is", "null", "like", "ilike", "between", "asc", "desc", "distinct", "case", "when", "then", "else",
    "end", "interval", "second", "minute", "hour", "day", "week", "month", "year", "join", "on", "left",
    "inner", "with", "union", "all", "true", "false", "offset", "seconds", "minutes", "hours", "days",
}
FORBIDDEN = {
    "insert", "update", "delete", "drop", "alter", "create", "truncate", "attach", "detach", "rename",
    "grant", "revoke", "optimize", "system", "kill", "set", "use", "into", "outfile", "format",
    "settings", "exec", "information_schema",
}
MAX_LEN, MAX_LIMIT = 2000, 200


class GuardError(ValueError):
    """The query was refused; the message is safe to show the user and to feed back to the model."""


def _strip_strings(sql: str) -> str:
    return re.sub(r"'(?:[^'\\]|\\.|'')*'", "''", sql)


def validate_sql(sql: str) -> str:
    """Return the cleaned query or raise GuardError."""
    q = (sql or "").strip().rstrip(";").strip()
    if not q:
        raise GuardError("empty query")
    if len(q) > MAX_LEN:
        raise GuardError(f"query too long (>{MAX_LEN} chars)")
    if "--" in q or "/*" in q or "#" in _strip_strings(q):
        raise GuardError("comments are not allowed")
    bare = _strip_strings(q)
    if ";" in bare:
        raise GuardError("only one statement is allowed")
    low = bare.lower()
    if not re.match(r"\s*(select|with)\b", low):
        raise GuardError("only SELECT queries are allowed")
    if "`" in bare or '"' in bare:
        raise GuardError("quoted identifiers are not allowed")
    no_cnt = re.sub(r"count\s*\(\s*\*\s*\)", "count()", low)
    if "*" in no_cnt:
        raise GuardError("SELECT * is not allowed; name the columns (raw payloads are off limits)")
    if re.search(r"\b(from|join)\s+[\w.]+(\s+(as\s+)?\w+)?\s*,", low):
        raise GuardError("comma joins are not allowed")
    aliases = set(re.findall(r"\bas\s+([a-z_]\w*)", low))
    for m in re.finditer(r"\b(?:from|join)\s+(?:aletheia\.)?([a-z_]\w*)", low):
        if m.group(1) not in TABLES:
            raise GuardError(f"table {m.group(1)!r} is not available; use: {', '.join(sorted(TABLES))}")
    for m in re.finditer(r"[a-z_]\w*", low):
        tok, end = m.group(0), m.end()
        if tok in FORBIDDEN:
            raise GuardError(f"keyword {tok!r} is not allowed")
        if low[m.start() - 1:m.start()] == "." or low[end:end + 1] == ".":
            if tok != "aletheia" and low[m.start() - 1:m.start()] == ".":
                pass
        if re.match(r"\s*\(", low[end:]):
            if tok not in FUNCTIONS and tok not in KEYWORDS:
                raise GuardError(f"function {tok!r} is not allowed")
        elif tok not in KEYWORDS | COLUMNS | TABLES | aliases | {"aletheia"}:
            raise GuardError(f"unknown or restricted identifier {tok!r}")
    if re.search(r"\blimit\s+(\d+)", low):
        if int(re.search(r"\blimit\s+(\d+)", low).group(1)) > MAX_LIMIT:
            raise GuardError(f"LIMIT may not exceed {MAX_LIMIT}")
    return q
