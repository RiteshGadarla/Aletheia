"""Loaded parser packs, read from ALETHEIA_PACKS_DIR (CONTRACTS §2).

Two jobs for the API: name the pack a stored event's template came from, and invert that
template's OCSF mapping into `{ocsf_path: slot}` so the UI can go from a clicked field back to
the bytes it came from (spec §6.14 / §8.4). The inversion mirrors the normalizer in
backend/packs/verify_packs.py step by step, so a path only appears when a slot really produced
it — constants and unresolved enums have no byte provenance and are deliberately left out.
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any, Callable

import yaml

log = logging.getLogger("studio.packs")

# Slots the engine consumes from the envelope itself (verify_packs.ENGINE_SLOTS).
ENGINE_SLOTS = {"pri", "ts", "host", "tag", "pid", "app", "procid", "msgid", "sd", "body"}

# Envelope slot -> the OCSF path the engine always derives from it.
ENVELOPE_PATHS = {"ts": "metadata.original_time", "host": "metadata.log_name",
                  "tag": "metadata.log_provider"}


def packs_dir() -> Path:
    env = os.environ.get("ALETHEIA_PACKS_DIR")
    if env:
        return Path(env)
    return Path(__file__).resolve().parents[2] / "packs"


# Studio-approved packs live in Postgres, not on disk; re-read them at most this often.
REPO_TTL_S = 5.0


class PackRegistry:
    """Pack YAML cache keyed by directory mtime, so an edited pack is picked up on next call.

    Packs approved in Studio exist only in the repo, so an attached loader adds them; disk wins.
    """

    def __init__(self, directory: Path | str | None = None) -> None:
        self._dir = Path(directory) if directory else None
        self._stamp: tuple[Any, ...] | None = None
        self._loader: Callable[[], list[dict[str, Any]]] | None = None
        self._repo_rows: list[dict[str, Any]] = []
        self._repo_at = 0.0
        self._by_template: dict[tuple[str, int], tuple[str, dict[str, Any]]] = {}
        self._envelopes: dict[str, list[dict[str, Any]]] = {}
        self._pack_envelopes: dict[tuple[str, int], list[str]] = {}

    def _root(self) -> Path:
        return self._dir or packs_dir()

    def attach(self, loader: Callable[[], list[dict[str, Any]]] | None) -> None:
        """`loader` returns approved pack rows ({pack, version, yaml}) from the repo."""
        self._loader, self._repo_at, self._stamp = loader, 0.0, None

    def _repo_packs(self) -> list[dict[str, Any]]:
        if self._loader is None:
            return []
        now = time.monotonic()
        if now - self._repo_at >= REPO_TTL_S:
            self._repo_at = now
            try:
                self._repo_rows = [r for r in self._loader() if r.get("yaml")]
            except Exception as exc:                                # noqa: BLE001
                log.warning("cannot read approved packs from repo (%s)", type(exc).__name__)
        return self._repo_rows

    def _reload_if_stale(self) -> None:
        root = self._root()
        repo = self._repo_packs()
        try:
            mtime = root.stat().st_mtime
        except OSError:
            mtime = -1.0
        stamp = (str(root), mtime, tuple((r.get("pack"), int(r.get("version") or 0)) for r in repo))
        if stamp == self._stamp:
            return
        self._stamp = stamp
        by_template: dict[tuple[str, int], tuple[str, dict[str, Any]]] = {}
        pack_envelopes: dict[tuple[str, int], list[str]] = {}
        for path in sorted(root.glob("*.yaml")) if root.is_dir() else []:
            if path.name.startswith("_"):
                continue
            try:
                doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            except (OSError, yaml.YAMLError) as exc:
                log.warning("cannot read pack %s (%s)", path.name, type(exc).__name__)
                continue
            name, version = str(doc.get("pack") or ""), int(doc.get("version") or 0)
            declared = [str(e) for e in (doc.get("envelopes") or ["bare"])]
            for tpl in doc.get("templates") or []:
                tid = str(tpl.get("id") or "")
                if tid:
                    by_template[(tid, version)] = (name, tpl)
                    pack_envelopes[(tid, version)] = declared
        # Oldest repo row first, so the newest approval of a template wins; disk packs win over all.
        on_disk = {tid for tid, _ in by_template}
        for row in sorted(repo, key=lambda r: int(r.get("version") or 0)):
            try:
                doc = yaml.safe_load(row["yaml"]) or {}
            except yaml.YAMLError:
                log.warning("cannot parse repo pack %s v%s", row.get("pack"), row.get("version"))
                continue
            version = int(doc.get("version") or 0)
            declared = [str(e) for e in (doc.get("envelopes") or ["bare"])]
            for tpl in doc.get("templates") or []:
                tid = str(tpl.get("id") or "")
                if tid and tid not in on_disk:
                    by_template[(tid, version)] = (str(row.get("pack") or doc.get("pack") or ""), tpl)
                    pack_envelopes[(tid, version)] = declared
        self._by_template = by_template

        # Envelope templates live beside the packs. `events.envelope_id` records which one
        # matched, so tokens can be spliced exactly — the `templates` table cannot say, because
        # ReplacingMergeTree collapses it to one row per (template_id, pack_version).
        envs: dict[str, list[dict[str, Any]]] = {}
        env_file = root / "_envelopes.yaml"
        if env_file.is_file():
            try:
                doc = yaml.safe_load(env_file.read_text(encoding="utf-8")) or {}
                envs = {str(k): list(v) for k, v in (doc.get("envelopes") or {}).items()}
            except (OSError, yaml.YAMLError) as exc:
                log.warning("cannot read _envelopes.yaml (%s)", type(exc).__name__)
        self._envelopes = envs
        self._pack_envelopes = pack_envelopes

    def template(self, template_id: str, pack_version: int) -> tuple[str, dict[str, Any]] | None:
        """(pack name, template def) for this template at this pack version."""
        self._reload_if_stale()
        hit = self._by_template.get((template_id, int(pack_version)))
        if hit is not None:
            return hit
        # A stored event may predate a pack bump; fall back to any version of the same template.
        for (tid, _ver), value in sorted(self._by_template.items(), key=lambda kv: -kv[0][1]):
            if tid == template_id:
                return value
        return None

    def envelopes_for(self, template_id: str, pack_version: int) -> list[str]:
        """Envelope ids this template may appear under, most specific order as declared."""
        self._reload_if_stale()
        hit = self._pack_envelopes.get((template_id, int(pack_version)))
        if hit:
            return hit
        for (tid, _v), value in sorted(self._pack_envelopes.items(), key=lambda kv: -kv[0][1]):
            if tid == template_id:
                return value
        return ["bare"]

    def spliced(self, template_id: str, pack_version: int,
                envelope_id: str = "") -> list[list[dict[str, Any]]]:
        """Whole-line token lists (envelope with the body substituted for its `body` slot).

        Returns the envelope named by the event first, then the rest, so a caller that verifies
        by hash still succeeds if the stored envelope_id is wrong or missing.
        """
        self._reload_if_stale()
        hit = self.template(template_id, pack_version)
        if hit is None:
            return []
        body = list(hit[1].get("body") or [])
        order = self.envelopes_for(template_id, pack_version)
        if envelope_id:
            order = [envelope_id] + [e for e in order if e != envelope_id]
        out: list[list[dict[str, Any]]] = []
        for env_id in order:
            env = self._envelopes.get(env_id)
            if env is None:
                if env_id == "bare":
                    out.append(body)
                continue
            spliced, seen = [], False
            for tok in env:
                if tok.get("slot") == "body":
                    spliced.extend(body)
                    seen = True
                else:
                    spliced.append(tok)
            if seen and spliced not in out:
                out.append(spliced)
        return out

    def pack_of(self, template_id: str, pack_version: int) -> str:
        hit = self.template(template_id, pack_version)
        return hit[0] if hit else ""


_REGISTRY = PackRegistry()


def registry() -> PackRegistry:
    return _REGISTRY


# ------------------------------------------------------------------ field map
def _targets(spec: Any) -> list[Any]:
    return spec if isinstance(spec, list) else [spec]


def _paths_written(spec: Any, value: str) -> list[str]:
    """OCSF paths a single `map` entry actually writes for this raw value."""
    out: list[str] = []
    for target in _targets(spec):
        if isinstance(target, str):
            out.append(target)
            continue
        if not isinstance(target, dict) or not target.get("path"):
            continue
        # An enum target that does not recognise the value writes nothing (verify_packs).
        if "enum" in target and value not in target["enum"]:
            continue
        out.append(str(target["path"]))
    return out


def build_field_map(template: dict[str, Any], values: dict[str, str],
                    slot_types: dict[str, str] | None = None) -> dict[str, str]:
    """Invert a template's OCSF mapping to `{ocsf_path: slot}` for one event's values.

    `values` is slot name -> the exact raw substring captured for it. Conditionals are resolved
    against those values, so an ASA line that flips src/dst on `direction` maps the way that
    single event was actually normalized.
    """
    ocsf = template.get("ocsf") or {}
    slot_types = slot_types or {}
    out: dict[str, str] = {}
    consumed: set[str] = set()

    def write(path: str, slot: str | None) -> None:
        if slot is None:
            out.pop(path, None)      # a constant overwrites the value; the bytes no longer own it
        elif slot in values:
            out[path] = slot

    constants = ocsf.get("constants") or {}
    if "pri" in values and "severity_id" not in constants:
        write("severity_id", "pri")
    for slot, path in ENVELOPE_PATHS.items():
        if slot in values:
            write(path, slot)
    for path in constants:
        write(str(path), None)

    for slot, spec in (ocsf.get("map") or {}).items():
        if slot not in values:
            continue
        consumed.add(slot)
        for path in _paths_written(spec, values[slot]):
            write(path, slot)

    for cond in ocsf.get("conditional") or []:
        if not all(values.get(k) == v for k, v in (cond.get("when") or {}).items()):
            continue
        for path in cond.get("constants") or {}:
            write(str(path), None)
        for slot, spec in (cond.get("map") or {}).items():
            if slot not in values:
                continue
            consumed.add(slot)
            for path in _paths_written(spec, values[slot]):
                write(path, slot)

    # Verbatim JSON bodies: every mapped path really does come from the one `json` slot.
    json_slot = str(ocsf.get("json_slot", "json"))
    if ocsf.get("json_map") and json_slot in values:
        consumed.add(json_slot)
        for spec in ocsf["json_map"].values():
            for target in _targets(spec):
                path = target if isinstance(target, str) else (target or {}).get("path")
                if path:
                    write(str(path), json_slot)
        write("metadata.original_time", json_slot)

    for slot in values:
        if slot in consumed or slot in ENGINE_SLOTS or slot_types.get(slot) == "ws":
            continue
        write(f"unmapped.{slot}", slot)
    return out
