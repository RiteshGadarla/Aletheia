"""Byte-exact template derivation from a cluster (spec §8.7).

Drain gives token-level templates and loses exact whitespace. Here the literal segments are
taken from the sample bytes themselves: a segment becomes a literal only when it is
byte-identical in EVERY sample, otherwise it is a slot. Adjacent literals are merged and two
slots are never left adjacent.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

from ..core.models import SlotInfo, TemplateProposal, Token
from ..slottype.typing_rules import infer_type
from .compile import compile_tokens, reconstruct, validate_tokens

Span = tuple[int, int]
Item = tuple[str, object]          # ("lit", str) | ("slot", column index)

# A one-character alphanumeric "literal" is nearly always a fragment of a value, not structure.
_MIN_ALNUM_LITERAL = 2
_VAR_RE = re.compile(
    r"(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)"
    r"|(?:[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2})"
    r"|(?:(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2})"
    r"|(?:(?:\d{1,3}\.){3}\d{1,3})"
    r"|(?:0x[0-9A-Fa-f]+)"
    r"|(?:\d+)"
)


@dataclass
class _Segments:
    """Alternating structure: optional leading slot, then literal / slot pairs."""

    literals: list[str]
    lead_slot: bool
    tail_slot: bool


# ---- span discovery ---------------------------------------------------

def _intersect(a: list[Span], b: list[Span]) -> list[Span]:
    out: list[Span] = []
    i = j = 0
    while i < len(a) and j < len(b):
        s, e = max(a[i][0], b[j][0]), min(a[i][1], b[j][1])
        if s < e:
            out.append((s, e))
        if a[i][1] <= b[j][1]:
            i += 1
        else:
            j += 1
    return out


def _common_spans(base: str, others: list[str]) -> list[Span]:
    """Byte ranges of `base` that are byte-identical, in order, in every other sample."""
    spans: list[Span] = [(0, len(base))]
    for other in others:
        sm = SequenceMatcher(None, base, other, autojunk=False)
        blocks = [(i, i + n) for i, _j, n in sm.get_matching_blocks() if n > 0]
        spans = _intersect(spans, blocks)
        if not spans:
            break
    return spans


def _char_class(ch: str) -> str:
    return "d" if ch.isdigit() else ("a" if ch.isalpha() else "o")


def _refine(base: str, spans: list[Span]) -> list[Span]:
    """Spec §8.7 step 2: character-level boundary refinement.

    A literal edge that continues a same-class alphanumeric run into the neighbouring gap
    belongs to the value (`/443` vs `/445` must not yield literal `/44`), while a class change
    (`ab` | `12`) is a real boundary and is kept.
    """
    refined: list[Span] = []
    for idx, (s, e) in enumerate(spans):
        prev_end = spans[idx - 1][1] if idx else 0
        next_start = spans[idx + 1][0] if idx + 1 < len(spans) else len(base)
        gap_before, gap_after = base[prev_end:s], base[e:next_start]
        while s < e and gap_before and base[s].isalnum() \
                and _char_class(base[s]) == _char_class(gap_before[-1]):
            s += 1
        while e > s and gap_after and base[e - 1].isalnum() \
                and _char_class(base[e - 1]) == _char_class(gap_after[0]):
            e -= 1
        if s < e:
            refined.append((s, e))
    return refined


def _trim_partial_values(base: str, spans: list[Span]) -> list[Span]:
    """Drop the part of a literal that is only a *fragment* of a value.

    Byte identity alone cannot tell structure from a value that happens to start the same way.
    Cluster samples a minute apart share the prefix of their syslog timestamp, so `Sep 20 22:`
    became a literal and the derived template silently stopped matching at 23:00 and again the
    next day. The same thing turned a shared `10.0.0.` subnet prefix into structure.

    The test is containment, not presence: a value lying wholly inside the common span really is
    constant across the cluster and is genuine structure -- the `6` in `%ASA-6-` must stay a
    literal. Only a value that starts or ends outside the span is a fragment, and the overlap is
    removed so it becomes part of the neighbouring slot.
    """
    values = [(m.start(), m.end()) for m in _VAR_RE.finditer(base)]
    out: list[Span] = []
    for s, e in spans:
        pieces = [(s, e)]
        for vs, ve in values:
            if vs >= s and ve <= e:
                continue                                  # wholly inside: constant, keep it
            if ve <= s or vs >= e:
                continue                                  # no overlap
            nxt: list[Span] = []
            for ps, pe in pieces:
                if ve <= ps or vs >= pe:
                    nxt.append((ps, pe))
                    continue
                if ps < vs:
                    nxt.append((ps, min(vs, pe)))
                if pe > ve:
                    nxt.append((max(ve, ps), pe))
            pieces = nxt
        out.extend((ps, pe) for ps, pe in pieces if pe > ps)
    return out


def _filter_weak(base: str, spans: list[Span]) -> list[Span]:
    return [(s, e) for s, e in spans
            if len(base[s:e]) >= _MIN_ALNUM_LITERAL or not base[s:e].isalnum()]


def _segments(base: str, spans: list[Span]) -> _Segments:
    merged: list[Span] = []
    for s, e in spans:                                   # step 4: merge adjacent literals
        if merged and merged[-1][1] == s:
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))
    return _Segments(
        literals=[base[s:e] for s, e in merged],
        lead_slot=bool(merged) and merged[0][0] > 0,
        tail_slot=bool(merged) and merged[-1][1] < len(base),
    )


# ---- value extraction -------------------------------------------------

def _extract(sample: str, seg: _Segments) -> list[str] | None:
    """Leftmost sequential literal search — the same semantics as non-greedy slots."""
    values: list[str] = []
    pos = 0
    for i, lit in enumerate(seg.literals):
        idx = sample.find(lit, pos)
        if idx < 0:
            return None
        if i == 0 and not seg.lead_slot:
            if idx != 0:
                return None
        else:
            values.append(sample[pos:idx])
        pos = idx + len(lit)
    if seg.tail_slot:
        values.append(sample[pos:])
    elif pos != len(sample):
        return None
    return values


def _drop_literal(seg: _Segments, index: int) -> _Segments:
    lits = list(seg.literals)
    lead, tail = seg.lead_slot, seg.tail_slot
    last = len(lits) - 1
    lits.pop(index)
    if index == 0 and not lead:
        lead = True
    if index == last and not tail:
        tail = True
    return _Segments(literals=lits, lead_slot=lead, tail_slot=tail)


def _single_sample_segments(sample: str) -> _Segments:
    """One sample only: nothing can be confirmed, so fall back to value-shaped tokens."""
    literals: list[str] = []
    lead_slot = False
    pos = 0
    for m in _VAR_RE.finditer(sample):
        lit = sample[pos:m.start()]
        if lit:
            literals.append(lit)
        elif pos == 0 and m.start() == 0:
            lead_slot = True
        pos = m.end()
    if not literals:
        return _Segments(literals=[sample], lead_slot=False, tail_slot=False)
    return _Segments(literals=literals, lead_slot=lead_slot, tail_slot=pos < len(sample))


# ---- items -> tokens --------------------------------------------------

def _to_items(seg: _Segments) -> list[Item]:
    items: list[Item] = []
    slot_i = 0
    if not seg.literals:
        # With no literals there is exactly one region, so lead and tail describe the SAME slot.
        # Emitting both produced two adjacent slots -- which this module promises never to do --
        # while _extract still returned a single value, and derive_exact then crashed with an
        # IndexError reading a column that did not exist. Relaxation reaches this state whenever
        # the last literal has to be dropped, e.g. a kv cluster where one value contains another
        # ("zone=trust" / "zone=untrust").
        return [("slot", 0)] if (seg.lead_slot or seg.tail_slot) else []
    if seg.lead_slot:
        items.append(("slot", slot_i))
        slot_i += 1
    for li, lit in enumerate(seg.literals):
        items.append(("lit", lit))
        if li < len(seg.literals) - 1:
            items.append(("slot", slot_i))
            slot_i += 1
    if seg.tail_slot:
        items.append(("slot", slot_i))
    return items


def _fold_constants(items: list[Item], columns: list[list[str]]) -> tuple[list[Item], list[list[str]]]:
    """A column identical in every sample is structure, not a value: fold it into the literals."""
    out: list[Item] = []
    kept: list[list[str]] = []
    remap: dict[int, int] = {}
    for kind, payload in items:
        if kind == "lit":
            out.append(("lit", payload))
            continue
        col = columns[int(payload)]                      # type: ignore[arg-type]
        if len(set(col)) == 1 and col[0] != "":
            out.append(("lit", col[0]))
            continue
        remap[int(payload)] = len(kept)                  # type: ignore[arg-type]
        kept.append(col)
        out.append(("slot", remap[int(payload)]))        # type: ignore[arg-type]
    return _merge_lits(out), kept


def _merge_lits(items: list[Item]) -> list[Item]:
    out: list[Item] = []
    for kind, payload in items:
        if kind == "lit" and out and out[-1][0] == "lit":
            out[-1] = ("lit", str(out[-1][1]) + str(payload))
        elif kind == "lit" and payload == "":
            continue
        else:
            out.append((kind, payload))
    return out


def _name_slots(types: list[str]) -> list[str]:
    counts: dict[str, int] = {}
    names: list[str] = []
    for t in types:
        stem = {"ipv4": "ip", "ipv6": "ip", "syslog3164_ts": "ts", "iso8601_ts": "ts",
                "epoch_ts": "ts", "quoted": "str"}.get(t, t)
        counts[stem] = counts.get(stem, 0) + 1
        names.append(f"{stem}_{counts[stem]}")
    return names


def _neighbours(items: list[Item], pos: int) -> tuple[str, str]:
    prev_lit = str(items[pos - 1][1]) if pos > 0 and items[pos - 1][0] == "lit" else ""
    next_lit = (str(items[pos + 1][1])
                if pos + 1 < len(items) and items[pos + 1][0] == "lit" else "")
    return prev_lit, next_lit


def build_tokens(items: list[Item], columns: list[list[str]],
                 names: list[str] | None = None) -> tuple[list[Token], list[SlotInfo]]:
    positions = {int(p): i for i, (k, p) in enumerate(items) if k == "slot"}  # type: ignore[arg-type]
    prelim = []
    for ci in range(len(columns)):
        prev_lit, next_lit = _neighbours(items, positions[ci])
        prelim.append((prev_lit, next_lit, infer_type(columns[ci], prev_lit, next_lit)))
    names = names or _name_slots([p[2].type for p in prelim])

    tokens: list[Token] = []
    slots: list[SlotInfo] = []
    for kind, payload in items:
        if kind == "lit":
            tokens.append(Token(lit=str(payload)))
            continue
        ci = int(payload)                                # type: ignore[arg-type]
        prev_lit, next_lit, _ = prelim[ci]
        verdict = infer_type(columns[ci], prev_lit, next_lit, names[ci])
        tok = Token(slot=names[ci], type=verdict.type)
        if verdict.type == "enum":
            tok.values = verdict.enum_values
        tokens.append(tok)
        distinct: list[str] = []
        for v in columns[ci]:
            if v not in distinct:
                distinct.append(v)
        slots.append(SlotInfo(name=names[ci], type=verdict.type, values=distinct,
                              enum_values=verdict.enum_values, prev_lit=prev_lit,
                              next_lit=next_lit, evidence=verdict.evidence))
    return tokens, slots


def discriminator_of(tokens: list[Token]) -> str | None:
    """Longest literal — the fast index key the engine uses (spec §7.3)."""
    lits = [t.lit or "" for t in tokens if t.is_lit()]
    if not lits:
        return None
    best = max(lits, key=len).strip()
    return best if len(best) >= 4 else None


# ---- entry point ------------------------------------------------------

def derive_exact(samples: list[str], max_relax: int = 8) -> TemplateProposal:
    """Derive a byte-exact template that reconstructs every sample in the cluster."""
    uniq: list[str] = []
    for s in samples:
        s = s.rstrip("\n")
        if s and s not in uniq:
            uniq.append(s)
    if not uniq:
        raise ValueError("no samples")

    warnings: list[str] = []
    base = uniq[0]

    if len(uniq) == 1:
        seg = _single_sample_segments(base)
        warnings.append("single sample: literals could not be confirmed across the cluster")
    else:
        spans = _common_spans(base, uniq[1:])
        spans = _filter_weak(base, _refine(base, _trim_partial_values(base, spans)))
        seg = _segments(base, spans)

    rows: list[list[str]] | None = None
    for _ in range(max_relax + 1):
        attempt = [_extract(s, seg) for s in uniq]
        if all(r is not None for r in attempt):
            rows = attempt                               # type: ignore[assignment]
            break
        if not seg.literals:
            break
        weakest = min(range(len(seg.literals)), key=lambda i: len(seg.literals[i]))
        seg = _drop_literal(seg, weakest)
        warnings.append("dropped an ambiguous literal so every sample stays reconstructable")
    if rows is None:
        seg = _Segments(literals=[], lead_slot=True, tail_slot=False)
        rows = [[s] for s in uniq]
        warnings.append("fell back to one whole-line slot; review carefully before approving")

    columns = [[row[i] for row in rows] for i in range(len(rows[0]))]
    items, columns = _fold_constants(_to_items(seg), columns)
    tokens, slots = build_tokens(items, columns)

    problems = validate_tokens(tokens)
    warnings.extend(problems)

    for i, sample in enumerate(uniq):                    # local byte-exactness self-check
        if reconstruct(tokens, [c[i] for c in columns]) != sample:
            warnings.append(f"sample {i} does not reconstruct locally")
    if not problems:
        try:
            rx = compile_tokens(tokens)
            unmatched = sum(1 for s in uniq if not rx.match(s))
            if unmatched:
                warnings.append(f"{unmatched}/{len(uniq)} samples do not match the compiled regex")
        except Exception as exc:
            warnings.append(f"compile failed: {exc}")

    return TemplateProposal(tokens=tokens, slots=slots, method="exact", format="freetext",
                            discriminator=discriminator_of(tokens),
                            warnings=sorted(set(warnings)))
