"""Replay diff / blast radius (spec §8.10). Shells out to the engine CLI (CONTRACTS §8).

CONTRACTS §8 fixes the exact JSON shape only for `test-pack`; `replay`'s JSON is documented only
as "a single JSON object" (flagged loudly here since it matters for correctness). This module
therefore parses several plausible key names defensively — the same defensive posture
llm/schema.py already takes toward backend/ocsf/ output from a parallel component — and, more
importantly, never trusts a single "blocking" flag: it recomputes which events got worse itself
from parse_status ranks (raw_only < partial < full), so a regression can only be added to the
report, never argued away.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import subprocess
from pathlib import Path
from typing import Any

from ..core.models import FieldDiff, ReplayReport

log = logging.getLogger("studio.replay")

DEFAULT_TIMEOUT_S = 120

_RANK = {"raw_only": 0, "partial": 1, "full": 2}


class ReplayError(RuntimeError):
    """Replay could not run at all (missing/broken engine binary, bad JSON)."""


def _engine_available(engine_bin: str) -> bool:
    return shutil.which(engine_bin) is not None or Path(engine_bin).is_file()


def run_replay(source_id: str, from_version: str, to_version: str, last: int, *,
              engine_bin: str = "aletheia", timeout_s: int = DEFAULT_TIMEOUT_S) -> ReplayReport:
    """`aletheia replay --source <id> --from-version A --to-version B --last N --json` (CONTRACTS §8)."""
    if not _engine_available(engine_bin):
        raise ReplayError(
            f"engine binary {engine_bin!r} not found. Replay requires the Go engine CLI "
            "(CONTRACTS §8: `aletheia replay --source ... --from-version ... --to-version ... "
            "--last ... --json`). Build backend/engine and set the engine.bin setting, or put it "
            "on PATH."
        )
    cmd = [engine_bin, "replay", "--source", source_id, "--from-version", str(from_version),
           "--to-version", str(to_version), "--last", str(last), "--json"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
    except FileNotFoundError as exc:
        raise ReplayError(f"engine binary {engine_bin!r} could not be executed: {exc}") from exc
    except subprocess.TimeoutExpired as exc:
        raise ReplayError(f"engine replay timed out after {timeout_s}s") from exc
    try:
        raw = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ReplayError(
            f"engine replay produced no parseable JSON (exit {proc.returncode}): "
            f"stdout={proc.stdout[:400]!r} stderr={proc.stderr[:400]!r}"
        ) from exc
    return _build_report(source_id, str(from_version), str(to_version), raw)


def _first(raw: dict[str, Any], *keys: str, default: Any = None) -> Any:
    for k in keys:
        if k in raw and raw[k] is not None:
            return raw[k]
    return default


def _status_of(entry: dict[str, Any], side: str) -> str | None:
    for k in (f"{side}_status", side, f"status_{side}", f"parse_status_{side}"):
        v = entry.get(k)
        if isinstance(v, str) and v in _RANK:
            return v
    return None


def _extract_regressions(raw: dict[str, Any]) -> list[dict[str, Any]]:
    """Every event that got worse, whatever shape the engine used to report it.

    A regression found by rank comparison is always kept. An engine-flagged entry with no
    status pair we recognise is kept too (never silently dropped) but not one we invented.
    """
    out: list[dict[str, Any]] = []
    seen_ids: set[int] = set()
    candidates = list(_first(raw, "regressions", "worse", "downgrades", default=[]) or [])
    per_event = list(_first(raw, "events_detail", "per_event", "diffs", default=[]) or [])
    for entry in candidates + per_event:
        if not isinstance(entry, dict) or id(entry) in seen_ids:
            continue
        before = _status_of(entry, "before") or _status_of(entry, "old")
        after = _status_of(entry, "after") or _status_of(entry, "new")
        if before is None or after is None:
            if entry in candidates:               # explicitly engine-flagged: trust, don't drop
                out.append(entry)
                seen_ids.add(id(entry))
            continue
        if _RANK[after] < _RANK[before]:
            out.append(entry)
            seen_ids.add(id(entry))
    return out


def _extract_fields(raw: dict[str, Any]) -> list[FieldDiff]:
    items = _first(raw, "fields", "field_changes", "field_diffs", default=[]) or []
    fields: list[FieldDiff] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        path = it.get("path") or it.get("field") or it.get("ocsf_path")
        if not path:
            continue
        fields.append(FieldDiff(
            path=str(path), changed=int(it.get("changed") or it.get("count") or 0),
            example_before=it.get("example_before") or it.get("before"),
            example_after=it.get("example_after") or it.get("after"),
        ))
    return fields


def _build_report(source_id: str, from_version: str, to_version: str,
                  raw: dict[str, Any]) -> ReplayReport:
    regressions = _extract_regressions(raw)
    report = ReplayReport(
        source_id=source_id, from_version=from_version, to_version=to_version,
        events=int(_first(raw, "events", "total", "event_count", default=0) or 0),
        newly_matched=int(_first(raw, "newly_matched", "newly_matched_count", default=0) or 0),
        template_changes=int(_first(raw, "template_changes", "template_change_count",
                                    default=0) or 0),
        fields=_extract_fields(raw),
        regressions=regressions,
        blocking=bool(regressions) or bool(raw.get("blocking")),
        raw=raw,
    )
    report.sha256 = report_sha256(report)
    return report


def report_sha256(report: ReplayReport) -> str:
    """SHA-256 of the report, stored with the approval (spec §8.10, packs.replay_report_sha256)."""
    payload = report.model_dump(exclude={"sha256"})
    canonical = json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()
