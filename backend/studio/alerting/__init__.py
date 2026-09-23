"""Grafana-backed alerting (CONTRACTS §13).

Studio is the store of truth for rules, contact points and the policy tree. In `grafana` mode it
pushes them to Grafana's provisioning API; in `local` mode its own evaluator runs the same rules.
"""
