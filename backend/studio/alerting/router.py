"""Policy-tree routing for local mode, with Alertmanager semantics.

Depth-first: the first matching child wins unless it sets `continue`; a node with no matching
child handles the alert itself. Receivers and timings inherit from the parent when unset.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

_TIMINGS = ("group_wait", "group_interval", "repeat_interval")


@dataclass
class Match:
    receiver: str
    route_id: str
    group_by: list[str] = field(default_factory=list)
    group_wait: str = "30s"
    group_interval: str = "5m"
    repeat_interval: str = "4h"


def matcher_ok(m: dict[str, Any], labels: dict[str, str]) -> bool:
    # A missing label matches as "" (Alertmanager behaviour), so `x!=""` means "x is set".
    got, op, want = labels.get(m["label"], ""), m.get("op", "="), m.get("value", "")
    if op == "=":
        return got == want
    if op == "!=":
        return got != want
    try:
        hit = re.fullmatch(want, got) is not None     # Alertmanager regexes are anchored
    except re.error:
        return False
    return hit if op == "=~" else not hit


def _inherit(node: dict[str, Any], parent: Match | None) -> Match:
    base = parent or Match(receiver="", route_id="root")
    return Match(
        receiver=node.get("receiver") or base.receiver,
        route_id=node.get("id") or "root",
        group_by=list(node["group_by"]) if node.get("group_by") is not None else list(base.group_by),
        **{k: node.get(k) or getattr(base, k) for k in _TIMINGS},
    )


def _walk(node: dict[str, Any], labels: dict[str, str], here: Match) -> list[Match]:
    out: list[Match] = []
    for child in node.get("routes", []):
        if all(matcher_ok(m, labels) for m in child.get("matchers", [])):
            out += _walk(child, labels, _inherit(child, here))
            if not child.get("continue"):
                break
    return out or [here]


def route(policy: dict[str, Any], labels: dict[str, str]) -> list[Match]:
    """Every (receiver, timing) an alert with these labels is delivered to, in tree order."""
    return _walk(policy, labels, _inherit(policy, None))
