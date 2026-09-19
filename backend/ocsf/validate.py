#!/usr/bin/env python3
"""Validator for the pinned OCSF subset (backend/ocsf/schema_subset.yaml).

Three jobs:
  1. expand the subset into a flat, enumerable allow-list of OCSF paths per class
     (this is what the Studio feeds the LLM as the only legal mapping targets);
  2. check that every parser pack maps/constants only into allowed paths;
  3. check a normalized event JSON (CONTRACTS §5 invariants) against the subset.

Usage:
  validate.py paths [--class 4001] [--json]      print the allow-list
  validate.py packs [<packdir>]                  check every pack's OCSF targets
  validate.py event <file.json> [...]            check normalized event documents
  validate.py self                               self-check the schema file
Exit code is non-zero on any failure.
"""
from __future__ import annotations

import glob
import json
import os
import sys

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = os.path.join(HERE, "schema_subset.yaml")
ENUMS = os.path.join(HERE, "enums.yaml")
PACKDIR = os.path.abspath(os.path.join(HERE, "..", "packs"))

SCALARS = {"string", "integer", "long", "boolean", "float", "timestamp_ms",
           "string[]", "integer[]", "object"}


def load_schema(path: str = SCHEMA) -> dict:
    with open(path, encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def _expand(attrs: dict, objects: dict, prefix: str = "") -> dict:
    """Flatten {name: {$ref: obj}} into fully qualified leaf paths."""
    out = {}
    for name, spec in attrs.items():
        path = f"{prefix}{name}"
        if isinstance(spec, dict) and "$ref" in spec:
            ref = objects[spec["$ref"]]
            out.update(_expand(ref, objects, prefix=f"{path}."))
        else:
            out[path] = spec
    return out


def allow_list(schema: dict | None = None) -> dict:
    """class_uid -> {path: spec}. Includes the common attributes."""
    schema = schema or load_schema()
    objects = schema.get("objects", {})
    common = _expand(schema.get("common", {}), objects)
    result = {}
    for cuid, cls in schema["classes"].items():
        paths = dict(common)
        paths.update(_expand(cls.get("attributes", {}), objects))
        result[int(cuid)] = paths
    return result


def _leaf_ok(paths: dict, path: str) -> bool:
    """A path is legal if it is a listed leaf, or sits under an `object` leaf."""
    if path in paths:
        return True
    parts = path.split(".")
    for i in range(len(parts) - 1, 0, -1):
        head = ".".join(parts[:i])
        spec = paths.get(head)
        if isinstance(spec, dict) and spec.get("type") == "object":
            return True
    return False


# --------------------------------------------------------------------------- packs
def _targets(ocsf: dict):
    """Yield every OCSF path a pack template writes to."""
    for p in (ocsf.get("constants") or {}):
        yield p
    for _slot, target in (ocsf.get("map") or {}).items():
        yield target if isinstance(target, str) else target["path"]
    for cond in (ocsf.get("conditional") or []):
        for _slot, target in (cond.get("map") or {}).items():
            yield target if isinstance(target, str) else target["path"]
    for _key, target in (ocsf.get("json_map") or {}).items():
        yield target if isinstance(target, str) else target["path"]


def check_packs(packdir: str = PACKDIR) -> list[str]:
    errs: list[str] = []
    paths_by_class = allow_list()
    for pf in sorted(glob.glob(os.path.join(packdir, "*.yaml"))):
        if os.path.basename(pf).startswith("_"):
            continue
        with open(pf, encoding="utf-8") as fh:
            pack = yaml.safe_load(fh)
        for tpl in pack.get("templates", []):
            ocsf = tpl.get("ocsf") or {}
            cuid = ocsf.get("class_uid")
            if cuid not in paths_by_class:
                errs.append(f"{pack['pack']}/{tpl['id']}: class_uid {cuid} not in subset")
                continue
            cls = load_schema()["classes"][cuid]
            if ocsf.get("activity_id") not in cls["activity_ids"]:
                errs.append(f"{pack['pack']}/{tpl['id']}: activity_id "
                            f"{ocsf.get('activity_id')} not valid for class {cuid}")
            for path in _targets(ocsf):
                if not _leaf_ok(paths_by_class[cuid], path):
                    errs.append(f"{pack['pack']}/{tpl['id']}: path not in OCSF subset "
                                f"for class {cuid}: {path}")
    return errs


# --------------------------------------------------------------------------- events
def _flatten(doc: dict, prefix: str = ""):
    for k, v in doc.items():
        path = f"{prefix}{k}"
        if isinstance(v, dict):
            yield from _flatten(v, prefix=f"{path}.")
        else:
            yield path, v


def check_event(doc: dict, where: str = "event") -> list[str]:
    errs: list[str] = []
    schema = load_schema()
    paths_by_class = allow_list(schema)
    enums = yaml.safe_load(open(ENUMS, encoding="utf-8"))

    cuid = doc.get("class_uid")
    if cuid not in paths_by_class:
        return [f"{where}: class_uid {cuid} not in subset"]
    aid = doc.get("activity_id")
    if aid is None:
        errs.append(f"{where}: activity_id missing")
    else:
        if aid not in schema["classes"][cuid]["activity_ids"]:
            errs.append(f"{where}: activity_id {aid} invalid for class {cuid}")
        if "type_uid" in doc and doc["type_uid"] != cuid * 100 + aid:
            errs.append(f"{where}: type_uid {doc['type_uid']} != {cuid * 100 + aid}")
    if "category_uid" in doc and doc["category_uid"] != enums["category"][cuid]:
        errs.append(f"{where}: category_uid {doc['category_uid']} wrong for class {cuid}")
    if "time" in doc and not isinstance(doc["time"], int):
        errs.append(f"{where}: time must be epoch milliseconds (int)")
    for k, v in (doc.get("unmapped") or {}).items():
        if not isinstance(v, str):
            errs.append(f"{where}: unmapped.{k} must be a string (exact raw substring)")
    al = doc.get("aletheia") or {}
    if al.get("parse_status") and al["parse_status"] not in ("full", "partial", "raw_only"):
        errs.append(f"{where}: bad parse_status {al['parse_status']}")
    if al.get("storage_mode") and al["storage_mode"] not in ("template", "verbatim"):
        errs.append(f"{where}: bad storage_mode {al['storage_mode']}")

    skip = {"unmapped", "observables", "answers", "evidences", "attacks", "malware",
            "resources", "vulnerabilities", "auth_factors"}
    for path, _v in _flatten(doc):
        if path.split(".")[0] in skip:
            continue
        if not _leaf_ok(paths_by_class[cuid], path):
            errs.append(f"{where}: path not in OCSF subset for class {cuid}: {path}")
    return errs


def check_self() -> list[str]:
    errs: list[str] = []
    schema = load_schema()
    objects = schema.get("objects", {})
    enums = yaml.safe_load(open(ENUMS, encoding="utf-8"))
    for cuid, cls in schema["classes"].items():
        if enums["category"].get(cuid) != cls["category_uid"]:
            errs.append(f"class {cuid}: category_uid disagrees with enums.yaml")
    for cuid, paths in allow_list(schema).items():
        for path, spec in paths.items():
            if not isinstance(spec, dict) or spec.get("type") not in SCALARS:
                errs.append(f"class {cuid}: {path} has unknown type {spec}")
    for name, obj in objects.items():
        for path, spec in _expand(obj, objects).items():
            if spec.get("type") not in SCALARS:
                errs.append(f"object {name}: {path} has unknown type {spec}")
    return errs


def main(argv: list[str]) -> int:
    cmd = argv[1] if len(argv) > 1 else "self"
    if cmd == "paths":
        al = allow_list()
        want = None
        if "--class" in argv:
            want = int(argv[argv.index("--class") + 1])
        sel = {k: sorted(v) for k, v in al.items() if want is None or k == want}
        if "--json" in argv:
            print(json.dumps(sel, indent=2))
        else:
            for cuid, paths in sel.items():
                print(f"# class {cuid} ({len(paths)} paths)")
                for p in paths:
                    print(f"{cuid}\t{p}\t{al[cuid][p]['type']}")
        return 0
    if cmd == "packs":
        errs = check_packs(argv[2] if len(argv) > 2 else PACKDIR)
    elif cmd == "event":
        errs = []
        for f in argv[2:]:
            with open(f, encoding="utf-8") as fh:
                errs += check_event(json.load(fh), where=os.path.basename(f))
    elif cmd == "self":
        errs = check_self()
    else:
        print(__doc__)
        return 2
    for e in errs:
        print(f"FAIL {e}")
    print(f"{cmd}: {'OK' if not errs else str(len(errs)) + ' failures'}")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
