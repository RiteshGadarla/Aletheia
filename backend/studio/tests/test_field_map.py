"""build_field_map() — the inverted OCSF mapping behind click-a-field-see-the-bytes (spec §6.14).

The map is `{ocsf_path: slot}`, and every entry is a *claim about provenance*: those bytes, and
only those bytes, produced that field. So the interesting cases are all about what must NOT be
in the map — constants, unresolved enums, whitespace and engine slots own no bytes the user can
be shown, and an entry for one of them would point the UI at the wrong part of the line.
"""

from __future__ import annotations

from typing import Any

import pytest

from studio.core.packs import ENGINE_SLOTS, PackRegistry, build_field_map

BASE_VALUES = {
    "direction": "outbound",
    "ip_a": "10.0.0.1",
    "ip_b": "203.0.113.7",
    "gap": "   ",
    "state": "up",
    "conn_id": "12345",
    "extra": "zzz",
}

SLOT_TYPES = {"direction": "enum", "ip_a": "ip", "ip_b": "ip", "gap": "ws",
              "state": "word", "conn_id": "int", "extra": "word"}


def fm(template: dict[str, Any], **overrides: str) -> dict[str, str]:
    values = {**BASE_VALUES, **overrides}
    return build_field_map(template, values, SLOT_TYPES)


# ------------------------------------------------------------------ conditionals
def test_conditional_resolves_against_this_events_own_values(fx_template) -> None:
    """The ASA src/dst flip: the same template maps opposite ways on `direction`.

    Getting this wrong does not crash anything — it just highlights the wrong IP in the raw line,
    which is the one failure mode byte lineage exists to make impossible.
    """
    out = fm(fx_template, direction="outbound")
    assert out["src_endpoint.ip"] == "ip_a"
    assert out["dst_endpoint.ip"] == "ip_b"

    flipped = fm(fx_template, direction="inbound")
    assert flipped["src_endpoint.ip"] == "ip_b"
    assert flipped["dst_endpoint.ip"] == "ip_a"


def test_conditional_that_does_not_match_contributes_nothing(fx_template) -> None:
    out = fm(fx_template, direction="sideways")
    assert "src_endpoint.ip" not in out
    assert "dst_endpoint.ip" not in out
    # Unmatched by any branch, so the slots fall through to unmapped provenance.
    assert out["unmapped.ip_a"] == "ip_a"
    assert out["unmapped.ip_b"] == "ip_b"


def test_conditional_when_requires_every_key_to_match(fx_template) -> None:
    tpl = {"ocsf": {"conditional": [
        {"when": {"direction": "outbound", "state": "up"}, "map": {"ip_a": "src_endpoint.ip"}},
    ]}}
    assert fm(tpl, direction="outbound", state="up")["src_endpoint.ip"] == "ip_a"
    assert "src_endpoint.ip" not in fm(tpl, direction="outbound", state="down")


# ------------------------------------------------------------------ constants
def test_constants_overwrite_and_remove_byte_provenance(fx_template) -> None:
    """A constant is written by the pack, not read from the line: it must own no span."""
    out = fm(fx_template)
    assert "connection_info.protocol_name" not in out
    assert all(v in BASE_VALUES for v in out.values())


def test_a_slot_mapped_over_a_constant_keeps_its_provenance() -> None:
    """Write order must mirror the normalizer, which sets constants first and then `map`.

    So a constant loses a path a slot later writes: the stored document really does hold the
    slot's bytes there, and the map has to say so. Only paths nothing overwrites are dropped.
    """
    tpl = {"ocsf": {"constants": {"status_id": 1, "device.type": "firewall"},
                    "map": {"state": "status_id"}}}
    out = fm(tpl)
    assert out["status_id"] == "state"
    assert "device.type" not in out


def test_conditional_constants_also_strip_provenance() -> None:
    tpl = {"ocsf": {
        "map": {"state": "status_id"},
        "conditional": [{"when": {"direction": "outbound"}, "constants": {"status_id": 99}}],
    }}
    assert "status_id" not in fm(tpl, direction="outbound")
    assert fm(tpl, direction="inbound")["status_id"] == "state"


def test_pri_becomes_severity_unless_the_pack_pins_it() -> None:
    """CONTRACTS §5: PRI drives severity_id — but only when the pack has not overridden it."""
    tpl: dict[str, Any] = {"ocsf": {"map": {}}}
    assert build_field_map(tpl, {"pri": "166"}, {"pri": "int"})["severity_id"] == "pri"

    pinned = {"ocsf": {"constants": {"severity_id": 4}, "map": {}}}
    assert "severity_id" not in build_field_map(pinned, {"pri": "166"}, {"pri": "int"})


# ------------------------------------------------------------------ enums
def test_unresolved_enum_target_writes_nothing() -> None:
    """An enum target that does not recognise the raw value produces no OCSF field at all.

    The normalizer in verify_packs.py skips it, so claiming provenance for a field that was never
    written would be a lie. Note it is still *consumed*: it does not reappear under unmapped.*.
    """
    tpl = {"ocsf": {"map": {"state": {"path": "status_id", "enum": {"up": 1, "down": 2}}}}}
    assert fm(tpl, state="up")["status_id"] == "state"
    out = fm(tpl, state="flapping")
    assert "status_id" not in out
    assert "unmapped.state" not in out


def test_a_slot_may_write_several_paths() -> None:
    tpl = {"ocsf": {"map": {"ip_a": ["src_endpoint.ip", "device.ip"]}}}
    out = fm(tpl)
    assert out["src_endpoint.ip"] == "ip_a" and out["device.ip"] == "ip_a"


def test_target_object_without_a_path_is_ignored() -> None:
    """A malformed target must be skipped, not crash and not invent an empty OCSF path."""
    tpl = {"ocsf": {"map": {"ip_a": [{"enum": {"x": 1}}, "src_endpoint.ip"]}}}
    out = fm(tpl)
    assert out["src_endpoint.ip"] == "ip_a"
    assert "" not in out
    assert "unmapped.ip_a" not in out          # the slot was consumed by the good target


# ------------------------------------------------------------------ excluded slots
def test_whitespace_slots_are_never_mapped(fx_template) -> None:
    """`ws` slots exist only to keep Squid's column alignment byte-exact; they carry no field."""
    out = fm(fx_template)
    assert "unmapped.gap" not in out
    assert "gap" not in out.values()


def test_engine_slots_are_never_unmapped(fx_template) -> None:
    """Envelope slots belong to the engine; they get their documented paths, never unmapped.*."""
    values = {**BASE_VALUES, **{s: "x" for s in ENGINE_SLOTS}}
    out = build_field_map(fx_template, values, SLOT_TYPES)
    for slot in ENGINE_SLOTS:
        assert f"unmapped.{slot}" not in out


def test_envelope_slots_get_their_metadata_paths() -> None:
    values = {"ts": "Sep 19 14:31:02", "host": "fw01", "tag": "openvpn"}
    out = build_field_map({"ocsf": {}}, values, {})
    assert out == {"metadata.original_time": "ts", "metadata.log_name": "host",
                   "metadata.log_provider": "tag"}


def test_unmapped_slots_land_under_unmapped(fx_template) -> None:
    """CONTRACTS §5: `unmapped` is slot -> exact raw substring, so it needs provenance too."""
    out = fm(fx_template)
    assert out["unmapped.extra"] == "extra"
    # A slot the pack really did map must not be duplicated into unmapped.*.
    assert "unmapped.conn_id" not in out
    assert out["connection_info.uid"] == "conn_id"


# ------------------------------------------------------------------ json bodies
def test_json_map_attributes_every_path_to_the_single_json_slot() -> None:
    """A verbatim JSON body has one slot; every field really did come from those bytes."""
    tpl = {"ocsf": {"json_map": {"src_ip": "src_endpoint.ip",
                                 "dest_ip": {"path": "dst_endpoint.ip"}}}}
    out = build_field_map(tpl, {"json": '{"src_ip":"10.0.0.1"}'}, {"json": "text"})
    assert out["src_endpoint.ip"] == "json"
    assert out["dst_endpoint.ip"] == "json"
    assert out["metadata.original_time"] == "json"
    assert "unmapped.json" not in out


def test_json_slot_name_is_configurable() -> None:
    tpl = {"ocsf": {"json_slot": "payload", "json_map": {"a": "user.name"}}}
    out = build_field_map(tpl, {"payload": "{}"}, {"payload": "text"})
    assert out["user.name"] == "payload"


# ------------------------------------------------------------------ global invariants
def test_every_value_is_a_slot_that_actually_has_bytes(fx_template) -> None:
    """The UI resolves each mapped slot through `spans`; a slot with no value would dead-end."""
    values = {"direction": "inbound", "ip_a": "10.0.0.1", "conn_id": "7"}
    out = build_field_map(fx_template, values, SLOT_TYPES)
    assert out, "a mapped template with values must produce a non-empty field map"
    assert set(out.values()) <= set(values)


def test_no_values_means_no_map(fx_template) -> None:
    assert build_field_map(fx_template, {}, {}) == {}


@pytest.mark.parametrize("template_id", ["asa_302013", "asa_302015"])
def test_real_asa_template_flips_endpoints_on_direction(
        real_registry: PackRegistry, template_id: str) -> None:
    """The shipped cisco_asa pack, not a fixture: this is the mapping the demo actually shows."""
    hit = real_registry.template(template_id, 1)
    assert hit is not None
    values = {"direction": "outbound", "conn_id": "90024",
              "if_a": "outside", "ip_a": "203.0.113.20", "port_a": "443",
              "if_b": "inside", "ip_b": "10.1.1.5", "port_b": "51234",
              "mip_a": "203.0.113.20", "mport_a": "443",
              "mip_b": "10.1.1.5", "mport_b": "51234"}
    out = build_field_map(hit[1], values, {})
    assert out["src_endpoint.ip"] == "ip_b"
    assert out["dst_endpoint.ip"] == "ip_a"
    assert out["connection_info.direction_id"] == "direction"
    # constants: the pack writes these, the line does not.
    assert "connection_info.protocol_name" not in out
    assert "action_id" not in out

    inbound = build_field_map(hit[1], {**values, "direction": "inbound"}, {})
    assert inbound["src_endpoint.ip"] == "ip_a"
    assert inbound["dst_endpoint.ip"] == "ip_b"


# ------------------------------------------------------------------ Studio-approved (repo) packs
_REPO_YAML = """pack: proposed_x
version: 1
envelopes: [bare]
templates:
- id: repo_tpl
  body: [{lit: "X "}, {slot: who, type: word}]
  ocsf: {class_uid: 4001, activity_id: 1, map: {who: user.name}}
"""


def test_attached_repo_packs_resolve_templates(fixture_packs) -> None:
    reg = PackRegistry(fixture_packs)
    assert reg.template("repo_tpl", 1) is None
    reg.attach(lambda: [{"pack": "src_x_1", "version": 5, "yaml": _REPO_YAML}])
    name, tpl = reg.template("repo_tpl", 1)
    assert name == "src_x_1"
    assert build_field_map(tpl, {"who": "alice"}, {"who": "word"})["user.name"] == "who"
    assert reg.spliced("repo_tpl", 1) == [tpl["body"]]


def test_disk_packs_win_over_repo_packs(fixture_packs) -> None:
    shadow = _REPO_YAML.replace("repo_tpl", "fx_conn")
    reg = PackRegistry(fixture_packs)
    reg.attach(lambda: [{"pack": "src_shadow", "version": 9, "yaml": shadow}])
    assert reg.template("fx_conn", 3)[0] == "fixture"


def test_a_failing_repo_loader_keeps_disk_packs(fixture_packs) -> None:
    def boom() -> list[dict[str, Any]]:
        raise RuntimeError("db down")
    reg = PackRegistry(fixture_packs)
    reg.attach(boom)
    assert reg.template("fx_conn", 3)[0] == "fixture"
