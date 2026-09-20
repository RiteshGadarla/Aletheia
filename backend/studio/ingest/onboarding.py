"""Human-approved onboarding: raw lines -> clusters -> template + OCSF mapping proposal -> decision."""
from __future__ import annotations

import hashlib
import time
from typing import Any

from ..cluster.engine import ClusterEngine
from ..derive.exact import derive_exact
from ..propose.heuristics import propose_mapping
from .rawstore import RawStore

SIM_LADDER = [0.4, 0.5, 0.3, 0.6, 0.7]          # each retry re-clusters at a different similarity
CLASS_NAMES = {4001: "Network Activity", 4002: "HTTP Activity", 4003: "DNS Activity",
               3002: "Authentication", 2004: "Detection Finding", 1001: "File Activity",
               6003: "API Activity"}
PROPOSALS: dict[str, dict[str, Any]] = {}


def _gate(p: dict[str, Any], tokens) -> dict[str, Any] | None:
    from .. import main as m
    from ..gate.reconstruction import run_gate
    eng = m._engine_bin()
    if not eng:
        return None
    try:
        rep = run_gate(m._pack_yaml_for(p, tokens), tokens, p["samples"], engine_bin=eng)
        return m._gate_payload(rep, p["proposal_id"])
    except Exception as exc:                                                # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:200]}


def propose(store: RawStore, sid: str, attempt: int = 0, *, class_hint: int | None = None,
            feedback: str = "", limit: int = 2000, max_clusters: int = 8) -> dict[str, Any]:
    lines = [r["line"] for r in store.query(sid, limit=limit)]
    sim = SIM_LADDER[attempt % len(SIM_LADDER)]
    engine = ClusterEngine(sim_th=sim)
    clusters = engine.add_all(reversed(lines), sid)[:max_clusters]
    out = []
    for cl in clusters:
        pid = f"{sid}-c{cl.cluster_id}".replace("/", "_")
        try:
            tpl = derive_exact(cl.samples[:20])
        except ValueError:
            continue
        mp = propose_mapping(tpl, class_hint)
        by_slot = {fm.slot: fm for fm in mp.mappings}
        rows = [{"slot": s.name, "type": s.type, "sample": (s.values or [""])[0],
                 "path": by_slot[s.name].path if s.name in by_slot else None,
                 "confidence": by_slot[s.name].confidence if s.name in by_slot else 0.0,
                 "transform": by_slot[s.name].transform if s.name in by_slot else None,
                 "evidence": (by_slot[s.name].evidence if s.name in by_slot else [])[:3]}
                for s in tpl.slots]
        p = {"proposal_id": pid, "source_id": sid, "samples": cl.samples[:20],
             "template": {"discriminator": tpl.discriminator}, "mapping": mp.model_dump()}
        out.append({
            "cluster_id": pid, "size": cl.size, "share": round(cl.size / max(len(lines), 1), 3),
            "samples": cl.samples[:5], "format": tpl.format, "warnings": tpl.warnings,
            "tokens": tpl.token_dicts(),
            "mapping": {"class_uid": mp.class_uid, "class_name": CLASS_NAMES.get(mp.class_uid, str(mp.class_uid)),
                        "activity_id": mp.activity_id, "confidence": mp.confidence, "origin": mp.origin,
                        "unmapped_keep": mp.unmapped_keep, "rows": rows,
                        "_raw": mp.model_dump()},
            "gate": _gate(p, tpl.tokens),
        })
    prop = {"source_id": sid, "attempt": attempt, "sim_th": sim, "class_hint": class_hint,
            "feedback": feedback, "lines_examined": len(lines), "generated_at": time.time(),
            "covered": sum(c["size"] for c in out), "clusters": out}
    PROPOSALS[sid] = prop
    return prop


def public(prop: dict[str, Any]) -> dict[str, Any]:
    """Strip internals before sending to the UI."""
    cs = [{**c, "mapping": {k: v for k, v in c["mapping"].items() if k != "_raw"}} for c in prop["clusters"]]
    return {**prop, "clusters": cs}


def build_packs(sid: str, cluster_ids: list[str] | None, approver: str) -> list[dict[str, Any]]:
    """One pack row per approved cluster, YAML from the same builder the gate used."""
    from .. import main as m
    from ..core.models import Token
    prop, rows = PROPOSALS[sid], []
    for c in prop["clusters"]:
        if cluster_ids and c["cluster_id"] not in cluster_ids:
            continue
        p = {"proposal_id": c["cluster_id"], "source_id": sid, "samples": c["samples"],
             "template": {"discriminator": None}, "mapping": c["mapping"]["_raw"]}
        y = m._pack_yaml_for(p, [Token(**t) for t in c["tokens"]])
        rows.append({"pack": f"src_{sid}_{c['cluster_id'].rsplit('-c', 1)[-1]}".replace(":", "_"),
                     "version": 1, "status": "approved", "yaml": y,
                     "checksum": hashlib.sha256(y.encode()).hexdigest(),
                     "author": approver, "origin": c["mapping"]["origin"]})
    return rows


def snapshot(repo, new_rows: list[dict[str, Any]]) -> tuple[int, list[dict[str, Any]]]:
    """Full pack set for the next version. The worker reloads `packs WHERE version = N`, so N must
    hold the built-in packs and earlier approvals too, or it would forget every other parser."""
    import yaml
    from ..core.packs import packs_dir
    existing = repo.packs_list()
    version = max((int(r["version"]) for r in existing), default=0) + 1
    slim = lambda r: {k: r.get(k) for k in ("pack", "status", "yaml", "checksum", "author", "origin")}  # noqa: E731
    rows: list[dict[str, Any]] = []
    for f in sorted(packs_dir().glob("*.yaml")):
        if f.name.startswith("_"):
            continue
        text = f.read_text()
        try:
            name = yaml.safe_load(text)["pack"]
        except Exception:                                                        # noqa: BLE001
            continue
        rows.append({"pack": name, "status": "approved", "yaml": text, "author": "builtin",
                     "checksum": hashlib.sha256(text.encode()).hexdigest(), "origin": "heuristic"})
    fresh = {r["pack"] for r in new_rows}
    latest: dict[str, dict[str, Any]] = {}
    for r in existing:
        if str(r["pack"]).startswith("src_") and r.get("status") == "approved" and r["pack"] not in fresh:
            if r["pack"] not in latest or int(r["version"]) > int(latest[r["pack"]]["version"]):
                latest[r["pack"]] = r
    rows += [slim(r) for r in latest.values()] + [slim(r) for r in new_rows]
    return version, [{**r, "version": version} for r in rows]
