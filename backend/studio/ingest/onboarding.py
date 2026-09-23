"""Human-approved onboarding: raw lines -> clusters -> template + OCSF mapping proposal -> decision."""
from __future__ import annotations

import hashlib
import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, TYPE_CHECKING

if TYPE_CHECKING:
    from ..core.db import Repo

from ..cluster.engine import ClusterEngine
from ..core.models import MappingProposal, TemplateProposal
from ..derive.exact import derive_exact
from ..propose.heuristics import propose_mapping
from .rawstore import RawStore

log = logging.getLogger("studio.onboarding")

SIM_LADDER = [0.4, 0.5, 0.3, 0.6, 0.7]          # each retry re-clusters at a different similarity
CLASS_NAMES = {4001: "Network Activity", 4002: "HTTP Activity", 4003: "DNS Activity",
               3002: "Authentication", 2004: "Detection Finding", 1001: "File Activity",
               6003: "API Activity"}
PROPOSALS: dict[str, dict[str, Any]] = {}


def save_proposal(sid: str, prop: dict[str, Any], repo: Repo | None = None) -> None:
    """Save proposal to in-memory cache and repo settings for persistence."""
    PROPOSALS[sid] = prop
    if repo:
        try:
            repo.settings_set(f"onboarding.proposal.{sid}", json.dumps(prop), False)
        except Exception as exc:                                            # noqa: BLE001
            log.warning("failed to save proposal to repo for %s: %s", sid, exc)


def delete_proposal(sid: str, repo: Repo | None = None) -> None:
    """Remove proposal from memory and repo settings."""
    PROPOSALS.pop(sid, None)
    if repo:
        try:
            repo.settings_delete(f"onboarding.proposal.{sid}")
        except Exception:                                                   # noqa: BLE001
            pass


def clear_proposals(repo: Repo | None = None) -> None:
    """Reset proposal cache (used during test resets)."""
    PROPOSALS.clear()


def reconstruct_proposal_from_packs(sid: str, repo: Repo, store: RawStore | None = None) -> dict[str, Any] | None:
    """Reconstruct a proposal object from approved pack YAMLs if server restarted."""
    import yaml
    from ..core.packs import packs_dir
    packs: list[dict[str, Any]] = []

    try:
        all_packs = repo.packs_list()
        for p in all_packs:
            if p.get("status") == "approved":
                pname = str(p.get("pack", ""))
                pyaml = str(p.get("yaml", ""))
                if pname.startswith(f"src_{sid}_") or pname == f"proposed_{sid}" or f"product: {sid}" in pyaml:
                    packs.append(p)
    except Exception:                                                       # noqa: BLE001
        pass

    if not packs:
        pdir = packs_dir()
        if pdir.is_dir():
            for f in sorted(pdir.glob("*.yaml")):
                if f.name.startswith("_"):
                    continue
                try:
                    text = f.read_text(encoding="utf-8")
                    doc = yaml.safe_load(text) or {}
                    pname = str(doc.get("pack", ""))
                    prod = str(doc.get("applies_to", {}).get("product", ""))
                    if pname.startswith(f"src_{sid}_") or pname == f"proposed_{sid}" or prod == sid:
                        packs.append({"pack": pname, "yaml": text, "status": "approved", "origin": doc.get("origin", "builtin")})
                except Exception:                                           # noqa: BLE001
                    continue

    if not packs:
        return None

    raw_lines = [r["line"] for r in store.query(sid, limit=50)] if store else []

    clusters: list[dict[str, Any]] = []
    for p in packs:
        try:
            doc = yaml.safe_load(p["yaml"]) or {}
        except Exception:                                                   # noqa: BLE001
            continue

        for tpl in doc.get("templates") or []:
            tid = str(tpl.get("id") or f"{sid}-c0")
            ocsf = tpl.get("ocsf") or {}
            class_uid = int(ocsf.get("class_uid") or 4001)
            activity_id = int(ocsf.get("activity_id") or 1)
            ocsf_map = ocsf.get("map") or {}
            tokens = tpl.get("body") or []

            matching_samples = []
            for line in raw_lines:
                if line and len(matching_samples) < 5:
                    matching_samples.append(line)
            if not matching_samples:
                matching_samples = [sid]

            rows = []
            for tok in tokens:
                if not isinstance(tok, dict):
                    continue
                s_name = tok.get("slot") or ""
                if not s_name:
                    continue
                s_type = tok.get("type", "string")
                s_val = ""
                vals = tok.get("values")
                if vals and isinstance(vals, list) and vals[0]:
                    s_val = str(vals[0])
                elif tok.get("pattern"):
                    s_val = str(tok["pattern"])

                path = ocsf_map.get(s_name)
                rows.append({
                    "slot": s_name,
                    "type": s_type,
                    "sample": s_val,
                    "path": path,
                    "confidence": 1.0 if path else 0.0,
                    "transform": None,
                    "evidence": [],
                })

            clusters.append({
                "cluster_id": tid,
                "size": max(len(matching_samples), 1),
                "share": 1.0,
                "samples": matching_samples,
                "format": "custom",
                "warnings": [],
                "tokens": tokens,
                "mapping": {
                    "class_uid": class_uid,
                    "class_name": CLASS_NAMES.get(class_uid, str(class_uid)),
                    "activity_id": activity_id,
                    "confidence": 1.0,
                    "origin": p.get("origin", "approved_pack"),
                    "unmapped_keep": True,
                    "rows": rows,
                    "_raw": ocsf,
                },
                "gate": {"ok": True},
            })

    if not clusters:
        return None

    return {
        "source_id": sid,
        "attempt": 0,
        "sim_th": 0.5,
        "class_hint": None,
        "feedback": "",
        "lines_examined": sum(c["size"] for c in clusters),
        "generated_at": time.time(),
        "covered": sum(c["size"] for c in clusters),
        "clusters": clusters,
    }


def get_proposal(sid: str, repo: Repo | None = None, store: RawStore | None = None) -> dict[str, Any] | None:
    """Retrieve proposal from in-memory cache, repo settings, or reconstructed approved packs."""
    if sid in PROPOSALS:
        return PROPOSALS[sid]

    if repo:
        try:
            row = repo.settings_all().get(f"onboarding.proposal.{sid}")
            if row and row.value:
                prop = json.loads(row.value)
                PROPOSALS[sid] = prop
                return prop
        except Exception as exc:                                            # noqa: BLE001
            log.warning("failed to load proposal for %s from repo: %s", sid, exc)

        rec = reconstruct_proposal_from_packs(sid, repo, store)
        if rec:
            save_proposal(sid, rec, repo)
            return rec

    return None


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


# (template, class_hint, reviewer feedback) -> llm.assistant.AIResult. Never raises.
AIMapper = Callable[[TemplateProposal, "int | None", str], Any]
AI_WORKERS = 2                                   # free tiers cap tokens per minute


def _merge(ai: MappingProposal, rules: MappingProposal) -> MappingProposal:
    """AI mapping first; rules fill only slots the AI left unmapped, never a path it already used."""
    taken = {fm.slot for fm in ai.mappings}
    used = {fm.path for fm in ai.mappings}
    fills = [fm.model_copy(update={"evidence": ["rules: " + e for e in fm.evidence] or ["rules"]})
             for fm in rules.mappings if fm.slot not in taken and fm.path not in used]
    mapped = taken | {fm.slot for fm in fills}
    return ai.model_copy(update={"mappings": [*ai.mappings, *fills],
                                 "unmapped_keep": [s for s in ai.unmapped_keep if s not in mapped]})


def _map_all(tpls: list[TemplateProposal], class_hint: int | None, feedback: str,
             ai: AIMapper | None) -> list[tuple[MappingProposal, MappingProposal, str | None]]:
    """Per cluster: (chosen mapping, rules mapping, why rules were used or None). AI calls overlap."""
    rules = [propose_mapping(t, class_hint) for t in tpls]
    if ai is None:
        return [(r, r, "no AI mapper attached") for r in rules]
    with ThreadPoolExecutor(max_workers=AI_WORKERS) as pool:
        results = list(pool.map(lambda t: ai(t, class_hint, feedback), tpls))
    out = []
    for r, res in zip(rules, results):
        if getattr(res, "ok", False) and res.proposal is not None:
            out.append((_merge(res.proposal, r), r, None))
        else:
            out.append((r, r, getattr(res, "reason", None) or "AI mapping unavailable"))
    return out


def _cluster_payload(sid: str, cl: Any, tpl: TemplateProposal, mp: MappingProposal,
                     n_lines: int) -> tuple[dict[str, Any], dict[str, Any]]:
    pid = f"{sid}-c{cl.cluster_id}".replace("/", "_")
    by_slot = {fm.slot: fm for fm in mp.mappings}
    rows = [{"slot": s.name, "type": s.type, "sample": (s.values or [""])[0],
             "path": by_slot[s.name].path if s.name in by_slot else None,
             "confidence": by_slot[s.name].confidence if s.name in by_slot else 0.0,
             "transform": by_slot[s.name].transform if s.name in by_slot else None,
             "evidence": (by_slot[s.name].evidence if s.name in by_slot else [])[:3]}
            for s in tpl.slots]
    p = {"proposal_id": pid, "source_id": sid, "samples": cl.samples[:20],
         "template": {"discriminator": tpl.discriminator}, "mapping": mp.model_dump()}
    c = {
        "cluster_id": pid, "size": cl.size, "share": round(cl.size / max(n_lines, 1), 3),
        "samples": cl.samples[:5], "format": tpl.format, "warnings": tpl.warnings,
        "tokens": tpl.token_dicts(),
        "mapping": {"class_uid": mp.class_uid, "class_name": CLASS_NAMES.get(mp.class_uid, str(mp.class_uid)),
                    "activity_id": mp.activity_id, "confidence": mp.confidence, "origin": mp.origin,
                    "unmapped_keep": mp.unmapped_keep, "rows": rows,
                    "_raw": mp.model_dump()},
    }
    return p, c


def propose(store: RawStore, sid: str, attempt: int = 0, *, class_hint: int | None = None,
            feedback: str = "", limit: int = 2000, max_clusters: int = 8,
            repo: Repo | None = None, ai: AIMapper | None = None) -> dict[str, Any]:
    """Cluster the stream, derive one byte-exact template per format, then map it.

    Mapping is AI-first: one LLM request per unique format (never per event), rules filling gaps
    and standing in whenever the AI is off, fails, or its mapping fails the reconstruction gate.
    """
    lines = [r["line"] for r in store.query(sid, limit=limit)]
    sim = SIM_LADDER[attempt % len(SIM_LADDER)]
    engine = ClusterEngine(sim_th=sim)
    clusters = engine.add_all(reversed(lines), sid)[:max_clusters]
    derived = []
    for cl in clusters:
        try:
            derived.append((cl, derive_exact(cl.samples[:20])))
        except ValueError:
            continue
    mapped = _map_all([t for _, t in derived], class_hint, feedback, ai)
    out = []
    for (cl, tpl), (mp, rules, why_rules) in zip(derived, mapped):
        p, c = _cluster_payload(sid, cl, tpl, mp, len(lines))
        gate = _gate(p, tpl.tokens)
        if why_rules is None and not (gate or {}).get("ok", True) and rules is not mp:
            # The AI's mapping broke the pack; the rules' mapping may still pass.
            p2, c2 = _cluster_payload(sid, cl, tpl, rules, len(lines))
            gate2 = _gate(p2, tpl.tokens)
            if (gate2 or {}).get("ok"):
                p, c, gate = p2, c2, gate2
                why_rules = "AI mapping failed the reconstruction gate"
        c["mapping"]["ai_note"] = why_rules
        c["gate"] = gate
        out.append(c)
    prop = {"source_id": sid, "attempt": attempt, "sim_th": sim, "class_hint": class_hint,
            "feedback": feedback, "lines_examined": len(lines), "generated_at": time.time(),
            "covered": sum(c["size"] for c in out), "clusters": out}
    save_proposal(sid, prop, repo)
    return prop


def public(prop: dict[str, Any]) -> dict[str, Any]:
    """Strip internals before sending to the UI."""
    cs = [{**c, "mapping": {k: v for k, v in c["mapping"].items() if k != "_raw"}} for c in prop["clusters"]]
    return {**prop, "clusters": cs}


def build_packs(sid: str, cluster_ids: list[str] | None, approver: str, repo: Repo | None = None) -> list[dict[str, Any]]:
    """One pack row per approved cluster, YAML from the same builder the gate used."""
    from .. import main as m
    from ..core.models import Token
    prop = get_proposal(sid, repo)
    if not prop:
        raise KeyError(f"no proposal for source {sid}")
    rows = []
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

