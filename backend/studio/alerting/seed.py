"""First-start seed (§13.4): the builtin Browser contact point, a root policy, starter rules.

The Prometheus rules are the alerting rules in deploy/prometheus/rules/aletheia.rules.yml, rewritten
so the query yields one number and the comparison moves into the rule's condition.
"""
from __future__ import annotations

from typing import Any

BROWSER_ID = "browser"


def seed_contact_points() -> list[dict[str, Any]]:
    return [{"id": BROWSER_ID, "name": "Browser", "type": "browser", "settings": {}, "secrets": {},
             "disable_resolve_message": False, "builtin": True}]


def seed_policy() -> dict[str, Any]:
    return {
        "receiver": BROWSER_ID, "group_by": ["alertname"], "group_wait": "30s",
        "group_interval": "5m", "repeat_interval": "4h",
        "routes": [{"id": "critical", "receiver": BROWSER_ID, "continue": False, "routes": [],
                    "matchers": [{"label": "severity", "op": "=", "value": "critical"}]}],
    }


def _rule(rid: str, name: str, ds: str, query: str, op: str, threshold: float, for_: str,
          severity: str, summary: str, description: str, reducer: str = "last") -> dict[str, Any]:
    return {"id": rid, "name": name, "group": "aletheia", "datasource": ds, "query": query,
            "reducer": reducer, "condition": {"op": op, "threshold": threshold}, "for": for_,
            "interval": "1m", "severity": severity, "labels": {}, "summary": summary,
            "description": description, "enabled": True, "no_data_state": "OK"}


def seed_rules() -> list[dict[str, Any]]:
    return [
        _rule("aletheia-reconstruct-mismatch", "Reconstruction mismatch", "prometheus",
              "sum(increase(aletheia_reconstruct_mismatch_total[5m]))", "gt", 0, "0s", "critical",
              "Reconstruction mismatch detected — must always be zero",
              "Byte-exact reconstruction is a non-negotiable invariant; any mismatch is a bug."),
        _rule("aletheia-format-drift", "Format drift", "prometheus",
              "max(aletheia:quarantine_rate5m - (aletheia:quarantine_rate_baseline * 3 + 0.01))",
              "gt", 0, "2m", "warning",
              "Quarantine rate above a source's baseline — likely firmware/config change",
              "Positive values mean some source quarantines more than 3x its 6h baseline."),
        # `and deriv(...) > 0` keeps the original "and growing" clause: no series means OK.
        _rule("aletheia-consumer-lag", "Consumer lag growing", "prometheus",
              "sum(aletheia_consumer_lag) and deriv(sum(aletheia_consumer_lag)[10m:1m]) > 0",
              "gt", 100000, "5m", "warning",
              "Consumer lag growing — add workers or partitions",
              "Total consumer lag is above 100k messages and still rising."),
        _rule("aletheia-raw-only-lines", "Raw-only lines", "loki",
              'sum(count_over_time({parse_status="raw_only"}[5m]))', "gt", 100, "0s", "warning",
              "More than 100 raw-only lines in 5 minutes",
              "Lines no template parsed; a new format or drift may need onboarding."),
    ]
