"""Endpoint smoke tests: status codes and response *shape* for the mounted router.

These are here so a refactor that quietly changes a contract fails in CI instead of in the demo.
The frontend is typed against `frontend/src/lib/types.ts`; the keys asserted below are the keys
those interfaces declare. Routing itself is part of the contract: everything lives under
`/api/v1`, except `/healthz`, which stays unprefixed for container probes.

Nothing here runs a demo scenario — those write to ClickHouse, and the suite is read-only.
"""

from __future__ import annotations

from typing import Any

import pytest

from studio.main import SCENARIOS, _RUNNABLE, api


def test_healthz_is_unprefixed_and_reports_its_checks(client: Any) -> None:
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"status", "checks", "version"}
    assert body["status"] in {"ready", "degraded"}
    assert set(body["checks"]) == {"settings", "repo", "engine_cli"}
    assert client.get("/api/v1/healthz").status_code == 404


def test_every_other_route_is_mounted_under_api_v1(client: Any) -> None:
    """The frontend's dev proxy forwards only /api/v1; a route outside it is unreachable."""
    assert api.prefix == "/api/v1"
    paths = [p for p in client.get("/openapi.json").json()["paths"]
             if not p.startswith("/openapi")]
    outside = [p for p in paths if not p.startswith("/api/v1") and p != "/healthz"]
    assert outside == []


# ------------------------------------------------------------------ demo console
def test_scenario_catalogue_shape(client: Any) -> None:
    r = client.get("/api/v1/demo/scenarios")
    assert r.status_code == 200
    scenarios = r.json()
    assert scenarios, "the Demo Console must always have a catalogue"
    for s in scenarios:
        assert set(s) == {"id", "number", "title", "action_label", "proves", "expected",
                          "link", "cli", "requirements", "runnable"}
        assert isinstance(s["runnable"], bool)
        assert s["link"] is None or set(s["link"]) == {"label", "href"}
    assert len({s["id"] for s in scenarios}) == len(scenarios), "scenario ids must be unique"


def test_every_runnable_scenario_has_a_subcommand() -> None:
    """A button the UI enables must map to something demo/scenarios.py can actually run."""
    runnable = {s["id"] for s in SCENARIOS if s["runnable"]}
    assert runnable == set(_RUNNABLE)


def test_unknown_scenario_is_a_404(client: Any) -> None:
    r = client.post("/api/v1/demo/scenarios/not_a_scenario/run")
    assert r.status_code == 404


@pytest.mark.parametrize("scenario_id", sorted({s["id"] for s in SCENARIOS if not s["runnable"]}))
def test_non_runnable_scenarios_refuse_to_run(client: Any, scenario_id: str) -> None:
    """Scenarios 0, 9 and 10 are performed by the evaluator; the API must not pretend to run them."""
    assert client.post(f"/api/v1/demo/scenarios/{scenario_id}/run").status_code == 404


# ------------------------------------------------------------------ packs
def test_pack_verify_reconstructs_every_golden_sample(client: Any) -> None:
    """The project's central claim, exposed over HTTP. Needs no services, so it always runs."""
    r = client.get("/api/v1/packs/verify")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True, body
    assert body["samples"] == body["reconstructed"] > 0
    assert body["failures"] == 0


# ------------------------------------------------------------------ studio
def test_clusters_endpoint_returns_a_list(client: Any) -> None:
    """Empty is a valid answer: there are no clusters until drift arrives (or CH is down)."""
    r = client.get("/api/v1/studio/clusters")
    assert r.status_code == 200
    clusters = r.json()
    assert isinstance(clusters, list)
    for c in clusters:
        assert set(c) >= {"cluster_id", "source_id", "sample_count", "first_seen", "last_seen",
                          "drain_template", "samples"}
        assert len(c["samples"]) <= 4, "the list view sends at most four samples per cluster"


def test_proposal_for_unknown_cluster_is_a_404(client: Any) -> None:
    assert client.get("/api/v1/studio/clusters/no_such_cluster/proposal").status_code == 404


def test_approval_defaults_to_proposed(client: Any) -> None:
    r = client.get("/api/v1/studio/proposals/smoke_unseen/approval")
    assert r.status_code == 200
    assert r.json() == {"proposal_id": "smoke_unseen", "state": "proposed", "approver": None,
                        "approved_at": None, "report_sha256": None, "reason": None}


def test_approval_records_a_named_human_and_the_diff_hash(client: Any) -> None:
    """AI can never approve: the approver is required and is echoed back with the report hash."""
    r = client.post("/api/v1/studio/proposals/smoke_approve/approve",
                    json={"approver": "ritesh", "report_sha256": "deadbeef"})
    assert r.status_code == 200
    assert r.json()["state"] == "approved"
    assert r.json()["approver"] == "ritesh"
    assert r.json()["report_sha256"] == "deadbeef"
    assert r.json()["approved_at"], "an approval must be timestamped"

    stored = client.get("/api/v1/studio/proposals/smoke_approve/approval").json()
    assert stored["state"] == "approved"


def test_approval_without_an_approver_is_rejected(client: Any) -> None:
    r = client.post("/api/v1/studio/proposals/smoke_anon/approve", json={})
    assert r.status_code == 422


def test_rejection_records_the_reason(client: Any) -> None:
    r = client.post("/api/v1/studio/proposals/smoke_reject/reject",
                    json={"approver": "ritesh", "reason": "slot too greedy"})
    assert r.status_code == 200
    assert r.json()["state"] == "rejected"
    assert r.json()["reason"] == "slot too greedy"
    assert r.json()["approved_at"] is None


def test_ask_ai_on_an_unknown_cluster_is_a_404(client: Any) -> None:
    """AI is onboarding-only and per cluster (CONTRACTS §10.3): no cluster, no request, no call."""
    assert client.post("/api/v1/studio/clusters/no_such_cluster/ask-ai").status_code == 404
