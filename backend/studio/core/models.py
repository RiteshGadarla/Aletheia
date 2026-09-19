"""Shared dataclasses / pydantic models. Token model is CONTRACTS §1 verbatim."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

# CONTRACTS §1 slot types.
SLOT_TYPES = (
    "int", "port", "ipv4", "ipv6", "ip", "mac", "hostname",
    "syslog3164_ts", "iso8601_ts", "epoch_ts",
    "enum", "word", "quoted", "ws", "text", "custom",
)

FIXED_WIDTH_TYPES = {"mac", "syslog3164_ts"}


class Token(BaseModel):
    """CONTRACTS §1. Exactly one of lit / slot is set."""

    lit: str | None = None
    slot: str | None = None
    type: str | None = None
    values: list[str] | None = None
    pattern: str | None = None

    def is_lit(self) -> bool:
        return not self.slot

    def dump(self) -> dict[str, Any]:
        return self.model_dump(exclude_none=True)


class SlotInfo(BaseModel):
    name: str
    type: str
    values: list[str] = Field(default_factory=list)      # distinct sample values
    enum_values: list[str] | None = None
    prev_lit: str = ""
    next_lit: str = ""
    evidence: list[str] = Field(default_factory=list)


class TemplateProposal(BaseModel):
    tokens: list[Token]
    slots: list[SlotInfo] = Field(default_factory=list)
    method: Literal["exact", "structural"] = "exact"
    format: str = "freetext"                              # cef | leef | kv | csv | freetext
    discriminator: str | None = None
    warnings: list[str] = Field(default_factory=list)

    def token_dicts(self) -> list[dict[str, Any]]:
        return [t.dump() for t in self.tokens]


class FieldMapping(BaseModel):
    slot: str
    path: str
    enum: dict[str, int] | None = None
    transform: str | None = None
    confidence: float = 0.0
    evidence: list[str] = Field(default_factory=list)


class MappingProposal(BaseModel):
    class_uid: int
    activity_id: int
    constants: dict[str, Any] = Field(default_factory=dict)
    mappings: list[FieldMapping] = Field(default_factory=list)
    unmapped_keep: list[str] = Field(default_factory=list)
    confidence: float = 0.0
    evidence: list[str] = Field(default_factory=list)
    origin: str = "heuristic"                             # heuristic | ai:<provider>/<model>


class ConnTest(BaseModel):
    ok: bool
    latency_ms: int | None = None
    json_mode: str | None = None                          # response_schema | json_object | prompt
    models: list[str] = Field(default_factory=list)
    error: str | None = None
    provider: str | None = None
    model: str | None = None


class GateCheck(BaseModel):
    name: str
    ok: bool
    detail: str = ""


class GateReport(BaseModel):
    ok: bool
    checks: list[GateCheck] = Field(default_factory=list)
    samples: int = 0
    reconstructed: int = 0
    failures: list[dict[str, Any]] = Field(default_factory=list)
    coverage: dict[str, Any] = Field(default_factory=dict)


class FieldDiff(BaseModel):
    path: str
    changed: int
    example_before: Any = None
    example_after: Any = None


class ReplayReport(BaseModel):
    source_id: str
    from_version: str
    to_version: str
    events: int = 0
    newly_matched: int = 0
    template_changes: int = 0
    fields: list[FieldDiff] = Field(default_factory=list)
    regressions: list[dict[str, Any]] = Field(default_factory=list)
    blocking: bool = False
    sha256: str = ""
    raw: dict[str, Any] = Field(default_factory=dict)
