"""Derived templates must not bake a value fragment into a literal.

This guards a bug that was invisible in every test that ran the derivation and the samples in
the same minute: a cluster of syslog lines shares the prefix of its timestamp, so `Sep 20 22:`
was byte-identical across all of them and became structure. The template reconstructed its own
samples perfectly, passed the byte-exact gate, and then silently stopped matching anything at
23:00 and again the next day.

The distinction that matters is containment, not presence. A value lying wholly inside the
shared region really is constant for the cluster and is genuine structure -- the `6` in
`%ASA-6-` must stay literal. Only a value that runs past the edge of the shared region is a
fragment.
"""

from __future__ import annotations

import pytest

from studio.derive.compile import compile_tokens, reconstruct
from studio.derive.exact import derive_exact


def literals(proposal) -> str:
    return " ".join(t.lit for t in proposal.tokens if t.lit is not None)


def slot_types(proposal) -> list[str]:
    return [t.type for t in proposal.tokens if t.slot]


# Deliberately spans two hours AND two days: a template derived from these must work for all
# of them, which is exactly what the old behaviour failed to do.
ASA = [
    '<166>Sep 20 22:33:26 fw01 %ASA-6-302013: Built inbound TCP connection 90068 '
    'for outside:203.0.113.41/27460 (203.0.113.41/27460) to inside:10.0.0.5/22 (198.51.100.7/22)',
    '<166>Sep 20 22:31:37 fw01 %ASA-6-302013: Built inbound TCP connection 90049 '
    'for outside:198.51.100.28/35649 (198.51.100.28/35649) to inside:10.0.0.9/443 (198.51.100.7/443)',
    '<166>Sep 20 23:34:18 fw01 %ASA-6-302013: Built outbound TCP connection 90077 '
    'for inside:10.0.0.33/39922 (10.0.0.33/39922) to outside:93.184.216.34/443 (93.184.216.34/443)',
    '<166>Sep 21 01:02:03 fw01 %ASA-6-302013: Built outbound UDP connection 90101 '
    'for inside:10.0.0.77/51000 (10.0.0.77/51000) to outside:8.8.8.8/53 (8.8.8.8/53)',
]


def test_timestamp_prefix_does_not_become_a_literal() -> None:
    lits = literals(derive_exact(ASA))
    assert "Sep 20" not in lits, f"a calendar date was baked into the template: {lits!r}"
    assert "Sep 21" not in lits
    assert "22:" not in lits, f"an hour was baked into the template: {lits!r}"


def test_timestamp_becomes_a_typed_slot() -> None:
    assert any(t and "ts" in t for t in slot_types(derive_exact(ASA))), \
        "the syslog timestamp should be captured as a timestamp slot, not swallowed by a literal"


def test_shared_subnet_prefix_does_not_become_a_literal() -> None:
    """`10.0.0.` is shared by every sample, but it is three quarters of an address."""
    assert "10.0.0." not in literals(derive_exact(ASA))


def test_a_value_wholly_inside_the_shared_region_stays_structure() -> None:
    """The counter-case: over-trimming would destroy real structure.

    `6` and `302013` in `%ASA-6-302013` are identical in every sample, so they are structure and
    must remain literal -- they are what tells this message type apart from another.
    """
    lits = literals(derive_exact(ASA))
    assert "%ASA-6-302013" in lits, f"the ASA message id was trimmed away: {lits!r}"


def test_discriminator_is_structural() -> None:
    disc = derive_exact(ASA).discriminator or ""
    assert "302013" in disc, f"discriminator carries no message identity: {disc!r}"
    for banned in ("Sep 20", "Sep 21", "22:", "10.0.0."):
        assert banned not in disc, f"discriminator contains a value fragment: {disc!r}"


@pytest.mark.parametrize("samples", [ASA, ASA[:2], ASA[2:]])
def test_every_sample_still_rebuilds_byte_exactly(samples: list[str]) -> None:
    """The invariant with no fallback: trimming must never break reconstruction."""
    p = derive_exact(samples)
    rx = compile_tokens(p.tokens)
    for s in samples:
        m = rx.match(s)
        assert m is not None, f"derived template does not match its own sample: {s!r}"
        assert reconstruct(p.tokens, list(m.groups())) == s


def test_template_matches_a_line_from_a_later_hour() -> None:
    """The actual regression: a template derived at 22:xx must still match at 23:xx tomorrow."""
    p = derive_exact(ASA[:2])          # both samples are 22:3x on Sep 20
    rx = compile_tokens(p.tokens)
    later = (
        '<166>Sep 21 09:05:11 fw01 %ASA-6-302013: Built inbound TCP connection 91234 '
        'for outside:203.0.113.9/1234 (203.0.113.9/1234) to inside:10.0.0.5/22 (198.51.100.7/22)'
    )
    m = rx.match(later)
    assert m is not None, "template derived from one hour does not match the next day"
    assert reconstruct(p.tokens, list(m.groups())) == later


# --------------------------------------------------------------- mapping proposals
# A proposal is only as useful as the number of slots it can place. On this cluster it placed
# 1 of 7, leaving the protocol and the event's own timestamp unmapped -- two of the few fields
# anyone actually filters or sorts by.

from studio.propose.heuristics import propose_mapping  # noqa: E402

# Three samples, one protocol change and one direction change. Kept separate from ASA above
# because that set also varies the parenthetical, which makes the derivation coarse enough to
# swallow "inbound TCP" into a single text slot -- correct, but it yields no enum to map.
ASA_ENUMS = [
    '<166>Sep 20 22:33:26 fw01 %ASA-6-302013: Built inbound TCP connection 90068 '
    'for outside:203.0.113.41/27460 to inside:10.0.0.5/22',
    '<166>Sep 20 22:31:37 fw01 %ASA-6-302013: Built inbound TCP connection 90049 '
    'for outside:198.51.100.28/35649 to inside:10.0.0.9/443',
    '<166>Sep 21 01:02:03 fw01 %ASA-6-302013: Built outbound UDP connection 90101 '
    'for inside:10.0.0.77/51000 to outside:8.8.8.8/53',
]


def mapped_paths(samples: list[str]) -> dict[str, str]:
    return {m.slot: m.path for m in propose_mapping(derive_exact(samples)).mappings}


def test_protocol_enum_is_mapped() -> None:
    paths = mapped_paths(ASA_ENUMS)
    assert "connection_info.protocol_name" in paths.values(), (
        "an enum of TCP/UDP was left unmapped; it matches no KV key, no action/direction "
        f"table and no context role. mapped: {paths}"
    )


def test_timestamp_slot_is_mapped() -> None:
    """True for both clusters: a timestamp slot has one sensible home whatever precedes it."""
    for samples in (ASA, ASA_ENUMS):
        assert "metadata.original_time" in mapped_paths(samples).values()


def test_direction_enum_still_mapped() -> None:
    """The one mapping that already worked must not be displaced by the new rules."""
    assert "connection_info.direction_id" in mapped_paths(ASA_ENUMS).values()


def test_proposal_places_several_slots() -> None:
    paths = mapped_paths(ASA_ENUMS)
    assert len(paths) >= 3, f"only {len(paths)} slots placed: {paths}"


def test_a_non_protocol_enum_is_not_forced_to_protocol() -> None:
    """The protocol rule keys on the canonical vocabulary, not on "looks like an enum"."""
    samples = [
        "state=established zone=trust action=allow",
        "state=closed zone=untrust action=allow",
    ]
    for path in mapped_paths(samples).values():
        assert path != "connection_info.protocol_name"


def test_relaxation_to_zero_literals_does_not_crash() -> None:
    """Regression: lead_slot and tail_slot described the same slot once every literal was
    dropped, so _to_items emitted two adjacent slots while _extract produced one value, and
    derivation died with IndexError. `zone=trust` / `zone=untrust` reaches that state."""
    samples = [
        "state=established zone=trust action=allow",
        "state=closed zone=untrust action=allow",
    ]
    p = derive_exact(samples)
    rx = compile_tokens(p.tokens)
    for s in samples:
        m = rx.match(s)
        assert m is not None
        assert reconstruct(p.tokens, list(m.groups())) == s


@pytest.mark.parametrize("samples", [
    ["a b c", "a b c"],                                  # identical
    ["completely different one", "nothing alike here"],  # almost nothing shared
    ["x", "y"],                                          # single character
    ["", "a"],                                           # empty line in the cluster
])
def test_degenerate_clusters_never_crash(samples: list[str]) -> None:
    """The Studio turns any quarantined cluster into a proposal; a 500 is never acceptable."""
    p = derive_exact(samples)
    propose_mapping(p)                                    # must not raise either
