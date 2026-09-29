"""Onboarding maps each unique format with the rules first, asking the LLM only about the slots
the rules could not map (no network)."""

from __future__ import annotations

import time
from typing import Any

import pytest

from studio.core.models import FieldMapping, MappingProposal
from studio.ingest import onboarding
from studio.ingest.rawstore import MemoryRawStore
from studio.llm.assistant import AIResult

LINES = [f"conn from 10.0.0.{i % 200 + 1} user u{i % 7} outcome {'success' if i % 2 else 'failure'}"
         for i in range(120)]


@pytest.fixture
def store() -> MemoryRawStore:
    st = MemoryRawStore()
    now = time.time_ns()
    st.push("src", [(now + i, ln, "info") for i, ln in enumerate(LINES)], "")
    return st


@pytest.fixture(autouse=True)
def gate_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(onboarding, "_gate", lambda p, tokens: {"ok": True})


def _slot_of(tpl: Any, prev_word: str) -> str:
    return next(s.name for s in tpl.slots if (s.prev_lit or "").strip().endswith(prev_word))


def _slot_of_name(rows: list[dict[str, Any]], type_prefix: str) -> str:
    return next(r["slot"] for r in rows if r["type"].startswith(type_prefix))


class FakeAI:
    """Fills whichever slots it is asked about; records every call."""

    def __init__(self) -> None:
        self.calls: list[tuple[Any, int | None, str, list[str] | None]] = []

    def __call__(self, tpl: Any, hint: int | None, feedback: str,
                 only_slots: list[str] | None = None) -> AIResult:
        self.calls.append((tpl, hint, feedback, only_slots))
        asked = list(only_slots or [s.name for s in tpl.slots])
        mp = MappingProposal(class_uid=3002, activity_id=1, origin="ai:fake/model", confidence=0.9,
                             mappings=[FieldMapping(slot=asked[0], path="user.name", confidence=0.9,
                                                    evidence=["the digits after `user u` name the account"])])
        return AIResult(ok=True, proposal=mp, origin="ai:fake/model")


def test_ai_is_asked_only_about_the_slots_the_rules_could_not_map(store: MemoryRawStore) -> None:
    ai = FakeAI()
    prop = onboarding.propose(store, "src", ai=ai, feedback="outcome is a status, not an action")
    assert prop["clusters"] and ai.calls                        # per format, not per line
    for tpl, hint, fb, only in ai.calls:
        assert only and set(only) < {s.name for s in tpl.slots}          # a strict subset
        assert hint == 4001                                              # the rules' own class
        assert fb == "outcome is a status, not an action"
    m = prop["clusters"][0]["mapping"]
    assert m["origin"] == "heuristic+ai:fake/model" and m["ai_note"] is None


def test_heuristic_mappings_stand_and_the_ai_only_fills_gaps(store: MemoryRawStore) -> None:
    rows = onboarding.propose(store, "src", ai=FakeAI())["clusters"][0]["mapping"]["rows"]
    ip = next(r for r in rows if r["type"].startswith("ip"))
    assert ip["path"] == "src_endpoint.ip"                      # from the rules' `from` context
    assert not ip["evidence"][0].startswith("origin=")          # untouched by the model
    outcome = next(r for r in rows if r["slot"] == _slot_of_name(rows, "enum"))
    assert outcome["path"] == "status_id"                       # the rules got this one too
    gap = next(r for r in rows if r["path"] == "user.name")
    assert gap["evidence"][0].startswith("origin=ai:fake/model")


def test_declined_ai_falls_back_to_rules_and_says_why(store: MemoryRawStore) -> None:
    def off(tpl: Any, hint: int | None, feedback: str,
            only_slots: list[str] | None = None) -> AIResult:
        return AIResult(ok=False, reason="no AI provider configured")
    m = onboarding.propose(store, "src", ai=off)["clusters"][0]["mapping"]
    assert m["origin"] == "heuristic" and m["ai_note"] == "no AI provider configured"


def test_no_mapper_still_produces_a_rules_proposal(store: MemoryRawStore) -> None:
    m = onboarding.propose(store, "src")["clusters"][0]["mapping"]
    assert m["origin"] == "heuristic" and m["ai_note"]


def test_ai_mapping_that_fails_the_gate_is_replaced_by_rules(store: MemoryRawStore,
                                                              monkeypatch: pytest.MonkeyPatch) -> None:
    def gate(p: dict[str, Any], tokens: Any) -> dict[str, Any]:
        return {"ok": "ai:fake/model" not in p["mapping"]["origin"]}
    monkeypatch.setattr(onboarding, "_gate", gate)
    c = onboarding.propose(store, "src", ai=FakeAI())["clusters"][0]
    assert c["gate"]["ok"] is True and c["mapping"]["origin"] == "heuristic"
    assert c["mapping"]["ai_note"] == "AI mapping failed the reconstruction gate"


def test_a_format_the_rules_fully_cover_costs_no_ai_request(monkeypatch: pytest.MonkeyPatch) -> None:
    full = MappingProposal(class_uid=4001, activity_id=1, unmapped_keep=[],
                           mappings=[FieldMapping(slot="x", path="message")])
    monkeypatch.setattr(onboarding, "propose_mapping", lambda t, h=None: full)
    ai = FakeAI()
    chosen, rules, why = onboarding._map_all([object()], None, "", ai)[0]
    assert ai.calls == [] and chosen is rules is full
    assert why == "rules mapped every slot; no AI request needed"


# ------------------------------------------------------------------ rules and allow-list fixes
from studio.core.models import SlotInfo                                   # noqa: E402
from studio.llm import schema as schema_mod                              # noqa: E402
from studio.propose.heuristics import _propose_slot                      # noqa: E402


def _enum_slot(prev: str, vals: list[str]) -> SlotInfo:
    return SlotInfo(name="enum_3", type="enum", prev_lit=prev, enum_values=vals, values=vals)


@pytest.mark.parametrize("prev,vals,want", [
    (" outcome=", ["success", "failure"], ("status_id", {"success": 1, "failure": 2})),
    (" act=", ["deny", "allow"], ("action_id", {"deny": 2, "allow": 1})),
    (" outcome=", ["meh", "blah"], None),                  # no table fits: leave it unmapped
])
def test_enum_key_uses_the_table_its_values_fit(prev: str, vals: list[str], want: Any) -> None:
    fm = _propose_slot(_enum_slot(prev, vals))
    assert ((fm.path, fm.enum) if fm else None) == want


def test_allow_list_has_leaf_and_common_paths_but_no_engine_fields() -> None:
    paths = set(schema_mod.allow_list(4001))
    assert {"src_endpoint.ip", "user.name", "status_id", "message", "time"} <= paths
    assert not paths & {"src_endpoint", "class_uid", "type_uid", "aletheia.pack"}
