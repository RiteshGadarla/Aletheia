"""PackRegistry.spliced() — whole-line token lists for lineage (CONTRACTS §1, §2).

Why this function exists, and therefore why these tests do: the ClickHouse `templates` table is
a ReplacingMergeTree keyed on `(template_id, pack_version)`. A template that matches under two
different envelopes collapses to ONE stored row, so one of the two token lists is simply gone.
Lineage cannot be rebuilt from that table alone — it must be spliced from the packs on disk,
guided by `events.envelope_id`. Every test below pins one property of that splice.
"""

from __future__ import annotations

import hashlib

from studio.core.packs import PackRegistry

from .conftest import FIXTURE_BARE_PACK, FIXTURE_ENVELOPES, FIXTURE_PACK


def _slots(tokens: list[dict]) -> list[str]:
    return [t["slot"] for t in tokens if t.get("slot")]


BODY = FIXTURE_PACK["templates"][0]["body"]


def test_named_envelope_comes_back_first(registry: PackRegistry) -> None:
    """The envelope the event recorded must be candidate 0, so the common case hashes on try 1."""
    first = registry.spliced("fx_conn", 3, "env_nohost")[0]
    assert _slots(first)[:2] == ["pri", "ts"]
    assert "host" not in _slots(first)

    first_host = registry.spliced("fx_conn", 3, "env_host")[0]
    assert _slots(first_host)[:3] == ["pri", "ts", "host"]


def test_every_declared_envelope_is_offered(registry: PackRegistry) -> None:
    """Both envelopes must come back — this is exactly what the templates table cannot store."""
    cands = registry.spliced("fx_conn", 3, "env_host")
    assert len(cands) == 2
    assert ["host" in _slots(c) for c in cands] == [True, False]


def test_unknown_envelope_id_still_yields_candidates(registry: PackRegistry) -> None:
    """A wrong or missing envelope_id must degrade to "try them all", never to an empty list.

    Stored envelope ids can be stale after a pack edit; lineage must still reconstruct.
    """
    for envelope_id in ("", "not_an_envelope"):
        cands = registry.spliced("fx_conn", 3, envelope_id)
        assert len(cands) == 2, envelope_id
        assert all(_slots(c)[-1] == "extra" for c in cands)


def test_explicit_bare_adds_the_body_alone_as_a_candidate(registry: PackRegistry) -> None:
    """An event stored with envelope_id="bare" gets the un-enveloped body first, then the rest.

    A template declared under syslog envelopes can still arrive over a transport that has no
    header at all, so "bare" is a real answer, not an error.
    """
    cands = registry.spliced("fx_conn", 3, "bare")
    assert len(cands) == 3
    assert cands[0] == BODY
    assert [("host" in _slots(c)) for c in cands[1:]] == [True, False]


def test_body_slot_is_substituted_exactly_once(registry: PackRegistry) -> None:
    """The `body` slot is a hole, not a value: it must vanish and be filled once, not twice."""
    env = FIXTURE_ENVELOPES["envelopes"]["env_host"]
    spliced = registry.spliced("fx_conn", 3, "env_host")[0]

    assert "body" not in _slots(spliced)
    assert len(spliced) == len(env) - 1 + len(BODY)
    assert spliced.count(BODY[0]) == 1
    # Envelope prefix preserved verbatim, body appended in order, nothing after it.
    assert spliced[:len(env) - 1] == env[:-1]
    assert spliced[len(env) - 1:] == BODY


def test_bare_envelope_is_the_body_alone(registry: PackRegistry) -> None:
    """A pack with no `envelopes:` key defaults to ["bare"]: the body IS the whole line."""
    assert registry.envelopes_for("fx_bare", 1) == ["bare"]
    cands = registry.spliced("fx_bare", 1)
    assert cands == [FIXTURE_BARE_PACK["templates"][0]["body"]]
    assert _slots(cands[0]) == ["who"]


def test_missing_template_yields_no_candidates(registry: PackRegistry) -> None:
    assert registry.spliced("no_such_template", 3, "env_host") == []
    assert registry.spliced("no_such_template", 3) == []


def test_template_falls_back_across_pack_versions(registry: PackRegistry) -> None:
    """A stored event may predate a pack bump; the template must still resolve, not disappear."""
    assert registry.template("fx_conn", 3) is not None
    hit = registry.template("fx_conn", 99)
    assert hit is not None and hit[0] == "fixture"
    assert registry.pack_of("fx_conn", 99) == "fixture"
    assert registry.pack_of("no_such_template", 1) == ""


def test_edited_pack_is_picked_up(registry: PackRegistry, fixture_packs) -> None:
    """The cache is keyed on the directory mtime, so a newly dropped pack must appear."""
    import yaml

    assert registry.template("late_arrival", 1) is None
    (fixture_packs / "late.yaml").write_text(yaml.safe_dump({
        "pack": "late", "version": 1,
        "templates": [{"id": "late_arrival", "body": [{"lit": "L"}]}],
    }), encoding="utf-8")
    assert registry.template("late_arrival", 1) is not None


# ------------------------------------------------------------------ against the shipped packs
def test_real_asa_splice_reconstructs_every_golden_sample(real_registry: PackRegistry) -> None:
    """End to end on the shipped pack: splice cisco_asa, match each golden line, rebuild the bytes.

    This is the property lineage rests on — a spliced token list plus its captured `vars` must
    reproduce the raw line byte for byte, *including* the syslog header that the body template
    knows nothing about. The two goldens deliberately sit under different envelopes
    (rfc3164_std and rfc3164_nohost), which is the collapse the templates table cannot survive.
    """
    from studio.core.models import Token
    from studio.derive.compile import match_values, reconstruct

    from .conftest import REAL_PACKS

    goldens = sorted((REAL_PACKS / "tests" / "asa_302013").glob("*.log"))
    assert len(goldens) >= 2, "expected golden samples under both ASA envelopes"

    cands = real_registry.spliced("asa_302013", 1, "rfc3164_std")
    assert len(cands) >= 2, "cisco_asa declares two envelopes; both must be offered"

    for golden in goldens:
        sample = golden.read_text(encoding="utf-8").rstrip("\n")
        rebuilt = None
        for raw_tokens in cands:
            tokens = [Token(**t) for t in raw_tokens]
            values = match_values(tokens, sample)
            if values is None:
                continue
            assert len(values) == sum(1 for t in tokens if not t.is_lit())
            rebuilt = reconstruct(tokens, values)
            break
        assert rebuilt is not None, f"no spliced candidate matched {golden.name}"
        assert rebuilt.encode() == sample.encode()
        assert hashlib.sha256(rebuilt.encode()).hexdigest() == hashlib.sha256(
            sample.encode()).hexdigest()


def test_real_packs_all_splice_into_whole_lines(real_registry: PackRegistry) -> None:
    """Every shipped template must produce at least one candidate, or its events lose lineage."""
    import yaml

    from .conftest import REAL_PACKS

    checked = 0
    for path in sorted(REAL_PACKS.glob("*.yaml")):
        if path.name.startswith("_"):
            continue
        doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        version = int(doc.get("version") or 0)
        for tpl in doc.get("templates") or []:
            cands = real_registry.spliced(str(tpl["id"]), version)
            assert cands, f"{path.name}:{tpl['id']} spliced to nothing"
            for c in cands:
                assert "body" not in _slots(c), f"{tpl['id']} kept an unfilled body slot"
            checked += 1
    assert checked > 0
