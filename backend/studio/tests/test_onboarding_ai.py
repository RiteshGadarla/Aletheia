"""Onboarding maps each unique format with the LLM first, and falls back to rules (no network)."""

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


class FakeAI:
    """Maps `outcome` to status_id the way an LLM should; records every call."""

    def __init__(self) -> None:
        self.calls: list[tuple[Any, int | None, str]] = []

    def __call__(self, tpl: Any, hint: int | None, feedback: str) -> AIResult:
        self.calls.append((tpl, hint, feedback))
        slot = _slot_of(tpl, "outcome")
        mp = MappingProposal(class_uid=3002, activity_id=1, origin="ai:fake/model", confidence=0.9,
                             mappings=[FieldMapping(slot=slot, path="status_id", confidence=0.9,
                                                    enum={"success": 1, "failure": 2},
                                                    evidence=["outcome words are auth status"])])
        return AIResult(ok=True, proposal=mp, origin="ai:fake/model")


def test_ai_maps_each_unique_format_once(store: MemoryRawStore) -> None:
    ai = FakeAI()
    prop = onboarding.propose(store, "src", ai=ai, feedback="outcome is a status, not an action")
    assert prop["clusters"] and len(ai.calls) == len(prop["clusters"])   # per format, not per line
    assert all(fb == "outcome is a status, not an action" for _, _, fb in ai.calls)
    m = prop["clusters"][0]["mapping"]
    assert m["origin"] == "ai:fake/model" and m["ai_note"] is None
    row = next(r for r in m["rows"] if r["path"] == "status_id")
    assert row["evidence"] == ["outcome words are auth status"]


def test_rules_fill_slots_the_ai_left_unmapped(store: MemoryRawStore) -> None:
    rows = onboarding.propose(store, "src", ai=FakeAI())["clusters"][0]["mapping"]["rows"]
    ip = next(r for r in rows if r["type"].startswith("ip"))
    assert ip["path"] == "src_endpoint.ip"                      # from the rules' `from` context
    assert ip["evidence"][0].startswith("rules: ")


def test_declined_ai_falls_back_to_rules_and_says_why(store: MemoryRawStore) -> None:
    def off(tpl: Any, hint: int | None, feedback: str) -> AIResult:
        return AIResult(ok=False, reason="no AI provider configured")
    m = onboarding.propose(store, "src", ai=off)["clusters"][0]["mapping"]
    assert m["origin"] == "heuristic" and m["ai_note"] == "no AI provider configured"


def test_no_mapper_still_produces_a_rules_proposal(store: MemoryRawStore) -> None:
    m = onboarding.propose(store, "src")["clusters"][0]["mapping"]
    assert m["origin"] == "heuristic" and m["ai_note"]


def test_ai_mapping_that_fails_the_gate_is_replaced_by_rules(store: MemoryRawStore,
                                                              monkeypatch: pytest.MonkeyPatch) -> None:
    def gate(p: dict[str, Any], tokens: Any) -> dict[str, Any]:
        return {"ok": p["mapping"]["origin"] != "ai:fake/model"}
    monkeypatch.setattr(onboarding, "_gate", gate)
    c = onboarding.propose(store, "src", ai=FakeAI())["clusters"][0]
    assert c["gate"]["ok"] is True and c["mapping"]["origin"] == "heuristic"
    assert c["mapping"]["ai_note"] == "AI mapping failed the reconstruction gate"


def test_merge_never_overrides_ai_slots_or_reuses_its_paths() -> None:
    ai = MappingProposal(class_uid=4001, activity_id=1, origin="ai:x/y", unmapped_keep=["b", "c"],
                         mappings=[FieldMapping(slot="a", path="src_endpoint.ip")])
    rules = MappingProposal(class_uid=4001, activity_id=1, mappings=[
        FieldMapping(slot="a", path="dst_endpoint.ip", evidence=["ctx"]),   # AI owns slot a
        FieldMapping(slot="b", path="src_endpoint.ip", evidence=["ctx"]),   # AI owns this path
        FieldMapping(slot="c", path="user.name", evidence=["key"]),         # a genuine gap
    ])
    got = onboarding._merge(ai, rules)
    assert {(m.slot, m.path) for m in got.mappings} == {("a", "src_endpoint.ip"), ("c", "user.name")}
    assert got.unmapped_keep == ["b"] and got.origin == "ai:x/y"


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
