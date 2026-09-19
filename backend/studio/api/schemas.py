"""Request bodies for the Studio API."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class IngestRequest(BaseModel):
    """Ad hoc feed of quarantined lines into the clustering engine (spec §8.6)."""

    source_id: str | None = None
    lines: list[str]


class PackCreateRequest(BaseModel):
    pack: str
    version: int
    yaml: str
    author: str | None = None
    origin: str = "heuristic"          # heuristic | ai:<provider>/<model>


class GateRequest(BaseModel):
    samples: list[str]
    golden_samples: list[str] | None = None
    total_quarantined: int | None = None
    template_id: str | None = None     # which template in the pack yaml to check; default: last


class ReplayRequest(BaseModel):
    source_id: str
    from_version: str
    to_version: str
    last: int = 500


class ApproveRequest(BaseModel):
    samples: list[str]
    golden_samples: list[str] | None = None
    total_quarantined: int | None = None
    template_id: str | None = None
    replay_report_sha256: str | None = None


class SettingsUpdate(BaseModel):
    values: dict[str, Any] = Field(default_factory=dict)
