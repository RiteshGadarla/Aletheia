#!/usr/bin/env python3
"""Reconstruction + normalization gate for Aletheia parser packs.

For every pack, every template and every golden sample this script:
  1. builds the full token list  = envelope tokens with the `body` slot replaced by the
     template's body tokens (CONTRACTS §2);
  2. compiles it to a regex with exactly the CONTRACTS §1 sub-patterns, one capture group
     per slot, fully anchored (^...$);
  3. matches the sample and extracts the vars as exact byte substrings;
  4. RECONSTRUCTS by concatenating literals and vars, and asserts byte-equality with the
     original sample  <- the whole point of the project;
  5. normalizes to OCSF using the pack's constants/map/conditional/json_map, validates every
     target path against backend/ocsf/schema_subset.yaml, and diffs against the golden .json;
  6. cross-checks that no template matches ANOTHER template's golden sample -- an over-matching
     template is a correctness bug even when its reconstruction happens to succeed.

Golden .json convention: only what is derivable from the raw bytes alone. Fields that depend on
runtime (see RUNTIME_ONLY) are omitted from goldens and ignored in the diff.

Usage:
  verify_packs.py                 verify everything
  verify_packs.py --write         (re)generate golden .json files from the packs
  verify_packs.py --pack cisco_asa [--verbose]
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sys

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
OCSFDIR = os.path.abspath(os.path.join(HERE, "..", "ocsf"))
sys.path.insert(0, OCSFDIR)
import validate as ocsf_validate  # noqa: E402

# ----------------------------------------------------------------- token model (CONTRACTS §1)
IPV4 = r"(?:\d{1,3}\.){3}\d{1,3}"
IPV6 = r"[0-9A-Fa-f:]{2,45}"
PATTERNS = {
    "int": r"\d+",
    "port": r"\d{1,5}",
    "ipv4": IPV4,
    "ipv6": IPV6,
    "ip": rf"(?:{IPV4}|{IPV6})",
    "mac": r"(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}",
    "hostname": r"[A-Za-z0-9._-]+",
    "syslog3164_ts": r"[A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2}",
    "iso8601_ts": r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?",
    "epoch_ts": r"\d{9,10}(?:\.\d+)?",
    "word": r"\S+",
    "quoted": r"\"(?:[^\"\\]|\\.)*\"",
    "ws": r"[ \t]+",
    "text": r".*?",
}
FIXED_WIDTH = {"syslog3164_ts", "mac"}

# Slots the engine consumes from the envelope itself; never pack-mapped, never `unmapped`.
ENGINE_SLOTS = {"pri", "ts", "host", "tag", "pid", "app", "procid", "msgid", "sd", "body"}
# Fields that only exist at runtime: omitted from goldens, ignored in the diff.
RUNTIME_ONLY = {"time", "metadata.uid", "metadata.version", "metadata.logged_time",
                "aletheia.event_uid", "aletheia.source_id", "aletheia.raw_sha256",
                "aletheia.verified", "aletheia.merkle_batch"}


class PackError(Exception):
    pass


def slot_pattern(tok: dict) -> str:
    ty = tok.get("type")
    if ty == "custom":
        return tok["pattern"]
    if ty == "enum":
        vals = sorted(tok["values"], key=len, reverse=True)
        return "|".join(re.escape(v) for v in vals)
    if ty not in PATTERNS:
        raise PackError(f"unknown slot type {ty!r} on slot {tok.get('slot')!r}")
    return PATTERNS[ty]


def validate_tokens(tokens: list, where: str) -> None:
    """CONTRACTS §1: no adjacent variable-width slots; `text` must be followed by a literal."""
    for i, tok in enumerate(tokens):
        if "slot" not in tok:
            continue
        nxt = tokens[i + 1] if i + 1 < len(tokens) else None
        if tok.get("type") == "text" and nxt is not None and "slot" in nxt:
            raise PackError(f"{where}: `text` slot {tok['slot']!r} not followed by a literal")
        if nxt is not None and "slot" in nxt:
            if not (tok.get("type") in FIXED_WIDTH and nxt.get("type") in FIXED_WIDTH):
                raise PackError(f"{where}: adjacent variable-width slots "
                                f"{tok['slot']!r} and {nxt['slot']!r}")


def compile_tokens(tokens: list, where: str):
    validate_tokens(tokens, where)
    parts, names = ["^"], []
    for tok in tokens:
        if "slot" not in tok:
            parts.append(re.escape(tok["lit"]))
        else:
            parts.append("(" + slot_pattern(tok) + ")")
            names.append(tok["slot"])
    parts.append("$")
    return re.compile("".join(parts)), names


def splice(envelope: list, body: list, where: str) -> list:
    out = []
    seen = False
    for tok in envelope:
        if tok.get("slot") == "body":
            out.extend(body)
            seen = True
        else:
            out.append(tok)
    if not seen:
        raise PackError(f"{where}: envelope has no `body` slot")
    return out


def reconstruct(tokens: list, vars_: dict) -> str:
    out = []
    for tok in tokens:
        out.append(tok["lit"] if "slot" not in tok else vars_[tok["slot"]])
    return "".join(out)


# ----------------------------------------------------------------- normalization (CONTRACTS §5)
def _set(doc: dict, path: str, value) -> None:
    node = doc
    parts = path.split(".")
    for p in parts[:-1]:
        node = node.setdefault(p, {})
    node[parts[-1]] = value


def _apply_transform(value: str, transform: str):
    if transform == "to_int":
        return int(value)
    if transform == "lowercase":
        return value.lower()
    if transform in ("to_ip", "ts_parse", "none", None):
        return value           # to_ip validates in the engine; ts_parse is runtime-dependent
    raise PackError(f"unknown transform {transform!r}")


def _apply_target(doc: dict, target, raw: str) -> None:
    if isinstance(target, str):
        _set(doc, target, raw)
        return
    value = raw
    if "enum" in target:
        table = target["enum"]
        if raw not in table:
            return                             # unmatched enum: leave unset, keep raw in vars
        value = table[raw]
    elif "transform" in target:
        value = _apply_transform(raw, target["transform"])
    _set(doc, target["path"], value)


def _targets_for(spec):
    return spec if isinstance(spec, list) else [spec]


def _json_get(doc, path: str):
    node = doc
    for p in path.split("."):
        if not isinstance(node, dict) or p not in node:
            return None
        node = node[p]
    return node


def normalize(pack: dict, tpl: dict, tokens: list, vars_: dict, enums: dict,
              raw: str) -> dict:
    ocsf = tpl["ocsf"]
    cuid, aid = ocsf["class_uid"], ocsf["activity_id"]
    doc: dict = {
        "class_uid": cuid,
        "category_uid": enums["category"][cuid],
        "activity_id": aid,
        "type_uid": cuid * 100 + aid,
    }
    types = {t["slot"]: t.get("type") for t in tokens if "slot" in t}
    consumed: set[str] = set()

    # envelope-derived fields the engine always fills
    if "pri" in vars_:
        sev = enums["syslog_severity"][int(vars_["pri"]) % 8]
        doc["severity_id"] = ocsf.get("constants", {}).get("severity_id", sev)
    if "ts" in vars_:
        _set(doc, "metadata.original_time", vars_["ts"])
    if "host" in vars_:
        _set(doc, "metadata.log_name", vars_["host"])
    if "tag" in vars_:
        _set(doc, "metadata.log_provider", vars_["tag"])
    ap = pack.get("applies_to", {})
    if ap.get("vendor"):
        _set(doc, "metadata.product.vendor_name", ap["vendor"])
    if ap.get("product"):
        _set(doc, "metadata.product.name", ap["product"])

    for path, value in (ocsf.get("constants") or {}).items():
        _set(doc, path, value)

    for slot, spec in (ocsf.get("map") or {}).items():
        if slot not in vars_:
            raise PackError(f"{tpl['id']}: map references unknown slot {slot!r}")
        consumed.add(slot)
        for t in _targets_for(spec):
            _apply_target(doc, t, vars_[slot])

    for cond in (ocsf.get("conditional") or []):
        if all(vars_.get(k) == v for k, v in cond["when"].items()):
            for path, value in (cond.get("constants") or {}).items():
                _set(doc, path, value)
            for slot, spec in (cond.get("map") or {}).items():
                consumed.add(slot)
                for t in _targets_for(spec):
                    _apply_target(doc, t, vars_[slot])

    # JSON bodies (spec §9.7): storage verbatim, mapping by key path
    if ocsf.get("json_map"):
        payload = json.loads(vars_[ocsf.get("json_slot", "json")])
        for keypath, spec in ocsf["json_map"].items():
            value = _json_get(payload, keypath)
            if value is None:
                continue
            for t in _targets_for(spec):
                if isinstance(t, str):
                    _set(doc, t, value)
                elif "enum" in t:
                    if str(value) in t["enum"]:
                        _set(doc, t["path"], t["enum"][str(value)])
                elif "transform" in t:
                    _set(doc, t["path"], _apply_transform(str(value), t["transform"]))
                else:
                    _set(doc, t["path"], value)
        ts = _json_get(payload, ocsf.get("json_time_key", "timestamp"))
        if ts is not None:
            _set(doc, "metadata.original_time", str(ts))

    unmapped = {}
    for slot, value in vars_.items():
        if slot in consumed or slot in ENGINE_SLOTS or types.get(slot) == "ws":
            continue
        unmapped[slot] = value
    if unmapped:
        doc["unmapped"] = unmapped

    doc["aletheia"] = {
        "parse_status": "full",
        "storage_mode": tpl.get("storage_mode", pack.get("storage_mode", "template")),
        "template_id": tpl["id"],
        "pack": pack["pack"],
        "pack_version": pack["version"],
    }
    return doc


def strip_runtime(doc: dict, prefix: str = "") -> dict:
    out = {}
    for k, v in doc.items():
        path = f"{prefix}{k}"
        if path in RUNTIME_ONLY:
            continue
        out[k] = strip_runtime(v, f"{path}.") if isinstance(v, dict) else v
    return out


# ----------------------------------------------------------------- over-matching
def cross_match_failures(packs: list, envelopes: dict) -> list:
    """A template must not match a sample that belongs to a different template.

    A template whose regex accepts foreign text is a correctness bug: whichever template the
    matcher tries first wins, so a permissive one silently steals another's traffic.
    """
    compiled, samples, out = [], [], []
    for pf in packs:
        pack = yaml.safe_load(open(pf, encoding="utf-8"))
        for tpl in pack["templates"]:
            for env_name in tpl.get("envelopes", pack["envelopes"]):
                if env_name not in envelopes:
                    continue
                try:
                    rx, _ = compile_tokens(splice(envelopes[env_name], tpl["body"], "x"), "x")
                except PackError:
                    continue                    # already reported by the main pass
                compiled.append((pack["pack"], tpl["id"], env_name, rx))
            for sf in sorted(glob.glob(os.path.join(HERE, tpl["tests"]["samples"]))):
                with open(sf, "rb") as fh:
                    samples.append((tpl["id"], os.path.basename(sf),
                                    fh.read().decode("utf-8").rstrip("\n")))
    for pname, tid, env_name, rx in compiled:
        for stid, sname, raw in samples:
            if stid != tid and rx.match(raw):
                out.append(f"{pname}: {tid}@{env_name}: OVER-MATCHES {stid}/{sname}")
    return out


# ----------------------------------------------------------------- driver
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack")
    ap.add_argument("--write", action="store_true", help="regenerate golden .json files")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    envelopes = yaml.safe_load(open(os.path.join(HERE, "_envelopes.yaml"), encoding="utf-8"))["envelopes"]
    enums = yaml.safe_load(open(os.path.join(OCSFDIR, "enums.yaml"), encoding="utf-8"))
    allow = ocsf_validate.allow_list()

    for name, toks in envelopes.items():
        validate_tokens(toks, f"envelope {name}")

    packs = sorted(glob.glob(os.path.join(HERE, "*.yaml")))
    packs = [p for p in packs if not os.path.basename(p).startswith("_")]
    if args.pack:
        packs = [p for p in packs if os.path.basename(p) == f"{args.pack}.yaml"]

    totals = {"samples": 0, "reconstructed": 0, "normalized": 0, "failures": []}
    per_pack = []

    for pf in packs:
        pack = yaml.safe_load(open(pf, encoding="utf-8"))
        pname = pack["pack"]
        stats = {"pack": pname, "templates": 0, "samples": 0, "recon_ok": 0,
                 "norm_ok": 0, "failures": []}

        def fail(msg: str) -> None:
            stats["failures"].append(msg)
            totals["failures"].append(f"{pname}: {msg}")

        for tpl in pack["templates"]:
            stats["templates"] += 1
            tid = tpl["id"]
            env_names = tpl.get("envelopes", pack["envelopes"])
            try:
                validate_tokens(tpl["body"], f"{pname}/{tid} body")
            except PackError as exc:
                fail(str(exc))
                continue
            disc = tpl.get("discriminator")

            sample_glob = os.path.join(HERE, tpl["tests"]["samples"])
            samples = sorted(glob.glob(sample_glob))
            if not samples:
                fail(f"{tid}: no samples matched {tpl['tests']['samples']}")
                continue

            for sf in samples:
                stats["samples"] += 1
                totals["samples"] += 1
                with open(sf, "rb") as fh:
                    raw = fh.read().decode("utf-8").rstrip("\n")
                matched = None
                for env_name in env_names:
                    if env_name not in envelopes:
                        fail(f"{tid}: unknown envelope {env_name}")
                        continue
                    try:
                        tokens = splice(envelopes[env_name], tpl["body"], f"{pname}/{tid}")
                        rx, names = compile_tokens(tokens, f"{pname}/{tid}@{env_name}")
                    except PackError as exc:
                        fail(str(exc))
                        continue
                    m = rx.match(raw)
                    if m:
                        matched = (env_name, tokens, dict(zip(names, m.groups())))
                        break
                if not matched:
                    fail(f"{tid}: {os.path.basename(sf)}: no envelope matched "
                         f"(tried {','.join(env_names)})")
                    continue
                env_name, tokens, vars_ = matched
                if disc and disc not in raw:
                    fail(f"{tid}: discriminator {disc!r} absent from sample "
                         f"{os.path.basename(sf)}")
                rebuilt = reconstruct(tokens, vars_)
                if rebuilt != raw:
                    off = next((i for i in range(min(len(raw), len(rebuilt)))
                                if raw[i] != rebuilt[i]), min(len(raw), len(rebuilt)))
                    fail(f"{tid}: {os.path.basename(sf)}: RECONSTRUCTION MISMATCH at byte {off}")
                    continue
                stats["recon_ok"] += 1
                totals["reconstructed"] += 1
                if args.verbose:
                    print(f"  ok  {tid:28s} {env_name:18s} {os.path.basename(sf)}")

                # normalization
                try:
                    doc = normalize(pack, tpl, tokens, vars_, enums, raw)
                except PackError as exc:
                    fail(f"{tid}: {os.path.basename(sf)}: normalize: {exc}")
                    continue
                except (ValueError, KeyError) as exc:
                    fail(f"{tid}: {os.path.basename(sf)}: normalize: {exc!r}")
                    continue
                errs = ocsf_validate.check_event(doc, where=f"{tid}/{os.path.basename(sf)}")
                for e in errs:
                    fail(e)
                if errs:
                    continue

                ef = os.path.splitext(sf)[0] + ".json"
                if args.write:
                    with open(ef, "w", encoding="utf-8") as fh:
                        json.dump(doc, fh, indent=2, sort_keys=True)
                        fh.write("\n")
                    stats["norm_ok"] += 1
                    totals["normalized"] += 1
                    continue
                if not os.path.exists(ef):
                    fail(f"{tid}: missing expected {os.path.basename(ef)}")
                    continue
                want = strip_runtime(json.load(open(ef, encoding="utf-8")))
                got = strip_runtime(doc)
                if want != got:
                    fail(f"{tid}: {os.path.basename(sf)}: NORMALIZED MISMATCH\n"
                         f"      want {json.dumps(want, sort_keys=True)}\n"
                         f"      got  {json.dumps(got, sort_keys=True)}")
                    continue
                stats["norm_ok"] += 1
                totals["normalized"] += 1
        per_pack.append(stats)

    for msg in cross_match_failures(packs, envelopes):
        totals["failures"].append(msg)
        pname = msg.split(":", 1)[0]
        for s in per_pack:
            if s["pack"] == pname:
                s["failures"].append(msg)

    print("=" * 78)
    print(f"{'pack':22s} {'tmpl':>5s} {'samples':>8s} {'recon':>7s} {'norm':>6s} {'fail':>6s}")
    print("-" * 78)
    for s in per_pack:
        print(f"{s['pack']:22s} {s['templates']:5d} {s['samples']:8d} "
              f"{s['recon_ok']:7d} {s['norm_ok']:6d} {len(s['failures']):6d}")
    print("-" * 78)
    print(f"{'TOTAL':22s} {sum(s['templates'] for s in per_pack):5d} "
          f"{totals['samples']:8d} {totals['reconstructed']:7d} {totals['normalized']:6d} "
          f"{len(totals['failures']):6d}")
    print("=" * 78)
    for f in totals["failures"]:
        print("FAIL " + f)
    ok = not totals["failures"] and totals["samples"] > 0
    print(json.dumps({"ok": ok, "samples": totals["samples"],
                      "reconstructed": totals["reconstructed"],
                      "normalized": totals["normalized"],
                      "failures": len(totals["failures"])}))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
