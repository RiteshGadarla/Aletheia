"""Drain3 clustering of quarantined lines (spec §8.6). Similarity ~0.4, depth 4."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Iterable

from drain3 import TemplateMiner
from drain3.template_miner_config import TemplateMinerConfig

from .premask import premask, premask_detail

log = logging.getLogger("studio.cluster")

DEFAULT_SIM_TH = 0.4
DEFAULT_DEPTH = 4
MAX_SAMPLES_KEPT = 200


@dataclass
class Cluster:
    cluster_id: str
    drain_template: str                       # over pre-masked tokens
    size: int = 0
    samples: list[str] = field(default_factory=list)      # original bytes, never masked
    masks: dict[str, int] = field(default_factory=dict)
    source_id: str | None = None

    def public(self, max_samples: int = 10) -> dict[str, Any]:
        return {
            "cluster_id": self.cluster_id,
            "drain_template": self.drain_template,
            "size": self.size,
            "distinct_samples": len(self.samples),
            "samples": self.samples[:max_samples],
            "masks": self.masks,
            "source_id": self.source_id,
        }


class ClusterEngine:
    """Pre-mask, then Drain. Drain's own masking is off: we do it ourselves, explicitly."""

    def __init__(self, sim_th: float = DEFAULT_SIM_TH, depth: int = DEFAULT_DEPTH,
                 max_clusters: int | None = 1024) -> None:
        cfg = TemplateMinerConfig()
        cfg.drain_sim_th = sim_th
        cfg.drain_depth = depth
        cfg.drain_max_children = 100
        cfg.drain_max_clusters = max_clusters
        cfg.profiling_enabled = False
        cfg.masking_instructions = []           # pre-masking already happened
        cfg.snapshot_interval_minutes = 0
        self.sim_th = sim_th
        self.depth = depth
        self._miner = TemplateMiner(persistence_handler=None, config=cfg)
        self._clusters: dict[str, Cluster] = {}

    def add(self, line: str, source_id: str | None = None) -> Cluster:
        raw = line.rstrip("\r\n")
        masked = premask(raw)
        result = self._miner.add_log_message(masked)
        cid = str(result["cluster_id"])
        cl = self._clusters.get(cid)
        if cl is None:
            cl = Cluster(cluster_id=cid, drain_template=result["template_mined"],
                         source_id=source_id)
            self._clusters[cid] = cl
        cl.drain_template = result["template_mined"]
        cl.size += 1
        if raw not in cl.samples and len(cl.samples) < MAX_SAMPLES_KEPT:
            cl.samples.append(raw)
            for k, v in premask_detail(raw).items():
                cl.masks[k] = cl.masks.get(k, 0) + v
        if source_id and not cl.source_id:
            cl.source_id = source_id
        return cl

    def add_all(self, lines: Iterable[str], source_id: str | None = None) -> list[Cluster]:
        seen: dict[str, Cluster] = {}
        for line in lines:
            if not line.strip():
                continue
            cl = self.add(line, source_id)
            seen[cl.cluster_id] = cl
        return sorted(seen.values(), key=lambda c: -c.size)

    def clusters(self) -> list[Cluster]:
        return sorted(self._clusters.values(), key=lambda c: -c.size)

    def get(self, cluster_id: str) -> Cluster | None:
        return self._clusters.get(str(cluster_id))
