"""Heuristic OCSF mapping proposals (spec §8.8). Always runs first, works with no AI configured.

Combines the KV key-name synonym table (slottype/synonyms.py), literal context in free text, and
the canonical action/direction/status enum-word tables (backend/ocsf/enums.yaml, CONTRACTS §5)
into a MappingProposal with per-field confidence and evidence. An AI suggestion is layered on
top afterwards by merge_ai_suggestion — it never silently replaces a heuristic result.
"""

from __future__ import annotations

import logging
import re
from functools import lru_cache
from typing import Any

import yaml

from ..core.models import FieldMapping, MappingProposal, SlotInfo, TemplateProposal
from ..llm.schema import ocsf_dir
from ..slottype.synonyms import ROLE_PATHS, context_role, lookup

log = logging.getLogger("studio.propose")

_KEY_RE = re.compile(r"([A-Za-z_][A-Za-z0-9_.\-]*)\s*[:=]\s*$")

DEFAULT_CLASS_UID = 4001          # Network Activity: perimeter-device default (spec §10.2)
CLASS_NAMES = {4001: "Network Activity", 4002: "HTTP Activity", 4003: "DNS Activity",
               3002: "Authentication", 2004: "Detection Finding"}

# First path segment -> class it is specific to. Used only to break ties toward a better guess;
# absence of a vote falls back to DEFAULT_CLASS_UID.
_CLASS_VOTES = {
    "http_request": 4002, "http_response": 4002,
    "query": 4003, "rcode_id": 4003, "answers": 4003,
    "auth_protocol": 3002, "logon_type": 3002, "session": 3002, "is_mfa": 3002,
    "finding_info": 2004, "risk_level_id": 2004, "confidence_id": 2004,
}

# OCSF path -> canonical enum word table in backend/ocsf/enums.yaml that resolves its values.
_ENUM_TABLE_BY_PATH = {
    "action_id": "action",
    "connection_info.direction_id": "direction",
    "status_id": "status",
}


@lru_cache(maxsize=1)
def _enums() -> dict[str, Any]:
    """Canonical action/direction/status word tables (backend/ocsf/enums.yaml, CONTRACTS §5)."""
    path = ocsf_dir() / "enums.yaml"
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return yaml.safe_load(fh) or {}
    except OSError as exc:
        log.warning("cannot read %s (%s); enum-word heuristics disabled", path, type(exc).__name__)
        return {}


def _word_enum_lookup(table: Any) -> dict[str, int]:
    """{2: [deny, denied, ...]} -> {'deny': 2, 'denied': 2, ...}."""
    out: dict[str, int] = {}
    if not isinstance(table, dict):
        return out
    for enum_id, words in table.items():
        for w in words or []:
            out[str(w).lower()] = int(enum_id)
    return out


def _extract_kv_key(prev_lit: str) -> str | None:
    """Trailing `key=` / `key:` in the literal right before a slot (KV, CEF, LEEF formats)."""
    m = _KEY_RE.search(prev_lit or "")
    return m.group(1) if m else None


def _canonical_enum_mapping(slot: SlotInfo, path_options: list[tuple[str, str]]
                            ) -> FieldMapping | None:
    """Map an enum slot straight to an OCSF enum path when every value is a known word."""
    values = [v.lower() for v in (slot.enum_values or [])]
    if not values:
        return None
    for table_name, path in path_options:
        word_to_id = _word_enum_lookup(_enums().get(table_name))
        if not word_to_id:
            continue
        hits = {v: word_to_id[v] for v in values if v in word_to_id}
        if hits and len(hits) == len(values):          # every distinct value recognised
            return FieldMapping(
                slot=slot.name, path=path, enum=hits, confidence=0.85,
                evidence=[f"all enum values {sorted(set(values))} match the canonical "
                          f"{table_name} word table (CONTRACTS §5)"],
            )
    return None


def _propose_context_slot(slot: SlotInfo) -> FieldMapping | None:
    """Literal context (from/to/for/src/dst/user...) informs role; role+type resolves a path."""
    role = context_role(slot.prev_lit)
    if not role:
        return None
    path = ROLE_PATHS.get((role, slot.type))
    if not path:
        return None
    words = (slot.prev_lit or "").split()
    word = words[-1] if words else slot.prev_lit
    return FieldMapping(
        slot=slot.name, path=path, confidence=0.55,
        evidence=[f"literal context {word!r} before the slot suggests role={role!r}; "
                  f"combined with type={slot.type!r} -> {path}"],
    )


def _propose_slot(slot: SlotInfo) -> FieldMapping | None:
    """One slot -> at most one FieldMapping, evidence-ordered per spec §8.8."""
    key = _extract_kv_key(slot.prev_lit) or slot.name
    hit = lookup(key)
    if hit:
        path, conf, transform = hit
        fm = FieldMapping(
            slot=slot.name, path=path, transform=transform, confidence=conf,
            evidence=[f"key name {key!r} matches the KV synonym table -> {path}"],
        )
        table_name = _ENUM_TABLE_BY_PATH.get(path)
        if slot.type == "enum" and table_name:
            canon = _canonical_enum_mapping(slot, [(table_name, path)])
            if canon:
                fm = fm.model_copy(update={"enum": canon.enum,
                                           "evidence": fm.evidence + canon.evidence})
        return fm
    if slot.type == "enum":
        canon = _canonical_enum_mapping(
            slot, [("action", "action_id"), ("direction", "connection_info.direction_id")])
        if canon:
            return canon
    return _propose_context_slot(slot)


def _guess_class(mappings: list[FieldMapping], class_hint: int | None) -> tuple[int, str]:
    if class_hint:
        return class_hint, f"class_uid {class_hint} given as a hint"
    votes: dict[int, int] = {}
    for m in mappings:
        cls = _CLASS_VOTES.get(m.path.split(".")[0])
        if cls:
            votes[cls] = votes.get(cls, 0) + 1
    if votes:
        best = max(votes, key=lambda c: votes[c])
        return best, f"{votes[best]} slot(s) map to {CLASS_NAMES.get(best, best)}-specific paths"
    return DEFAULT_CLASS_UID, f"default: {CLASS_NAMES[DEFAULT_CLASS_UID]} (no stronger signal)"


def propose_mapping(template: TemplateProposal, class_hint: int | None = None) -> MappingProposal:
    """Heuristic mapping proposal (spec §8.8). Works standalone, with no AI configured.

    This is a hard requirement: nothing here touches the llm package. It must always be able to
    run and produce a reviewable proposal even when provider=none.
    """
    mappings: list[FieldMapping] = []
    unmapped: list[str] = []
    for slot in template.slots:
        fm = _propose_slot(slot)
        if fm is not None:
            mappings.append(fm)
        else:
            unmapped.append(slot.name)

    class_uid, class_evidence = _guess_class(mappings, class_hint)
    confidences = [m.confidence for m in mappings]
    overall = round(sum(confidences) / len(confidences), 3) if confidences else 0.0

    return MappingProposal(
        class_uid=class_uid,
        activity_id=1,
        mappings=mappings,
        unmapped_keep=unmapped,
        confidence=overall,
        evidence=[class_evidence,
                  f"{len(mappings)}/{len(template.slots)} slot(s) mapped heuristically"],
        origin="heuristic",
    )


def merge_ai_suggestion(heuristic: MappingProposal, ai: MappingProposal | None,
                        ai_origin: str = "") -> MappingProposal:
    """Layer an AI proposal on top of the heuristic one. Never silently replaces a heuristic field.

    A heuristic mapping always stands. An AI mapping for a slot the heuristic left unmapped is
    added. An AI mapping that *disagrees* with an existing heuristic one for the same slot is
    added alongside it, clearly tagged as an alternative, so a reviewer sees both — this is
    exactly the ASA `ip_a`/`ip_b` disagreement noted in docs/llm-provider-notes.md.
    """
    if ai is None:
        return heuristic
    merged = heuristic.model_copy(deep=True)
    by_slot = {m.slot: m for m in merged.mappings}
    tag = ai_origin or ai.origin or "ai"
    for am in ai.mappings:
        rationale = am.evidence[0] if am.evidence else ""
        existing = by_slot.get(am.slot)
        if existing is None:
            merged.mappings.append(FieldMapping(
                slot=am.slot, path=am.path, enum=am.enum, transform=am.transform,
                confidence=am.confidence, evidence=[f"origin={tag}: {rationale}".strip()],
            ))
        elif existing.path != am.path:
            merged.mappings.append(FieldMapping(
                slot=am.slot, path=am.path, enum=am.enum, transform=am.transform,
                confidence=am.confidence,
                evidence=[f"origin={tag}: {rationale} (alternative to heuristic mapping "
                          f"{existing.path!r} for the same slot; not applied automatically)"],
            ))
        # else: AI agrees with the heuristic path for this slot — nothing to add.
    if ai.class_uid != merged.class_uid:
        merged.evidence.append(
            f"origin={tag} suggests class_uid={ai.class_uid}; heuristic class_uid="
            f"{merged.class_uid} was kept (human review required)"
        )
    merged.evidence.append(f"origin={tag}: merged {len(ai.mappings)} AI mapping(s)")
    if merged.origin == "heuristic":
        merged.origin = f"heuristic+{tag}"
    return merged
