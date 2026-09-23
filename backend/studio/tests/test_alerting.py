"""Alerting (CONTRACTS §13): CRUD + validation, secrets, seed, feed, routing, evaluation, Grafana.

Everything runs in local mode with no datasources; the Grafana client is exercised against an
httpx.MockTransport fake, so nothing here touches the network.
"""
from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from studio.alerting import evaluator, grafana
from studio.alerting.models import PolicyIn, parse_duration
from studio.alerting.router import route
from studio.alerting.service import AlertingService
from studio.api.state import get_state
from studio.core.db import MemoryRepo

A = "/api/v1/alerting"

RULE = {"name": "Too many errors", "datasource": "prometheus", "query": "sum(rate(x_total[5m]))",
        "reducer": "max", "condition": {"op": "gte", "threshold": 5}, "for": "2m", "interval": "30s",
        "severity": "critical", "labels": {"team": "soc"}, "summary": "{{ $labels.team }} at {{ $value }}",
        "description": "d", "enabled": True, "no_data_state": "OK"}


# ------------------------------------------------------------------ seed + status
def test_seed_and_status(client: Any) -> None:
    st = client.get(f"{A}/status").json()
    assert st["mode"] == "local" and st["grafana"]["reachable"] is False
    assert st["grafana"]["public_url"] == "http://localhost:3000"
    assert st["receiver_url"] == "http://host.docker.internal:8081"
    assert st["counts"] == {"rules": 4, "firing": 0, "pending": 0, "contact_points": 1}
    cps = client.get(f"{A}/contact-points").json()["contact_points"]
    assert [(c["name"], c["type"], c["builtin"]) for c in cps] == [("Browser", "browser", True)]
    pol = client.get(f"{A}/policies").json()
    assert pol["policy"]["receiver"] == "browser" and pol["sync"]["state"] == "local"
    assert pol["policy"]["routes"][0]["matchers"] == [{"label": "severity", "op": "=", "value": "critical"}]
    rules = client.get(f"{A}/rules").json()["rules"]
    assert {r["datasource"] for r in rules} == {"prometheus", "loki"}
    loki = next(r for r in rules if r["datasource"] == "loki")
    assert loki["query"] == 'sum(count_over_time({parse_status="raw_only"}[5m]))'
    assert loki["condition"] == {"op": "gt", "threshold": 100}


def test_seed_is_idempotent() -> None:
    repo = MemoryRepo()
    s1 = AlertingService(repo, secret="s")
    s1.ensure_loaded()
    s1.delete_rule(s1.list_rules()[0]["id"])
    s2 = AlertingService(repo, secret="s")          # a restart on the same database
    s2.ensure_loaded()
    assert len(s2.list_rules()) == 3 and len(s2.list_contact_points()) == 1


# ------------------------------------------------------------------ rules
def test_rule_crud(client: Any) -> None:
    r = client.post(f"{A}/rules", json={**RULE, "id": "ignored", "state": "firing"})
    assert r.status_code == 201, r.text
    rule = r.json()
    assert rule["id"] != "ignored" and rule["state"] == "normal" and rule["last_value"] is None
    assert rule["group"] == "aletheia" and rule["for"] == "2m" and rule["labels"] == {"team": "soc"}
    assert rule["sync"] == {"state": "local"} and rule["created_at"] and rule["last_eval"] is None
    rid = rule["id"]
    assert client.get(f"{A}/rules/{rid}").json()["name"] == RULE["name"]

    upd = client.put(f"{A}/rules/{rid}", json={**RULE, "enabled": False, "name": "Renamed"}).json()
    assert upd["state"] == "paused" and upd["name"] == "Renamed" and upd["created_at"] == rule["created_at"]
    assert client.post(f"{A}/rules", json={**RULE, "name": "renamed"}).status_code == 409
    assert client.delete(f"{A}/rules/{rid}").status_code == 204
    assert client.get(f"{A}/rules/{rid}").status_code == 404
    assert client.put(f"{A}/rules/{rid}", json=RULE).status_code == 404
    assert client.delete(f"{A}/rules/{rid}").status_code == 404


@pytest.mark.parametrize("patch", [
    {"interval": "15s"},                          # not a multiple of Grafana's 10s tick
    {"interval": "5s"},
    {"for": "soon"},
    {"datasource": "elastic"},
    {"reducer": "median"},
    {"condition": {"op": "between", "threshold": 1}},
    {"labels": {"bad-label": "x"}},
    {"labels": {"aletheia_rule_id": "x"}},
    {"name": "  "},
    {"group": "a/b"},
    {"datasource": "clickhouse", "query": "DROP TABLE events"},
    {"datasource": "clickhouse", "query": "SELECT 1; SELECT 2"},
])
def test_rule_validation(client: Any, patch: dict[str, Any]) -> None:
    assert client.post(f"{A}/rules", json={**RULE, **patch}).status_code == 422


def test_clickhouse_select_accepted_and_severity_label_folded(client: Any) -> None:
    body = {**RULE, "datasource": "clickhouse", "enabled": False,
            "query": "SELECT count() FROM events WHERE parse_status = 'a;b';",
            "labels": {"severity": "info", "x": "1"}}
    r = client.post(f"{A}/rules", json=body)
    assert r.status_code == 201, r.text
    assert r.json()["query"].endswith("'a;b'") and r.json()["labels"] == {"x": "1"}


def test_preview_reports_errors_instead_of_failing(client: Any) -> None:
    body = {"datasource": "loki", "query": "sum(rate({a=\"b\"}[1m]))", "reducer": "last",
            "condition": {"op": "gt", "threshold": 1}}
    r = client.post(f"{A}/rules/preview", json=body).json()
    assert r == {"value": None, "firing": False, "series": 0, "error": "ALETHEIA_LOKI_URL is not set"}
    bad = client.post(f"{A}/rules/preview", json={**body, "datasource": "clickhouse", "query": "DELETE x"})
    assert bad.json()["error"].startswith("ClickHouse rule queries")


# ------------------------------------------------------------------ contact points
def test_contact_point_crud_and_validation(client: Any) -> None:
    wh = client.post(f"{A}/contact-points", json={"name": "Hook", "type": "webhook",
                                                  "settings": {"url": "https://example.test/h"}})
    assert wh.status_code == 201
    assert wh.json()["settings"] == {"url": "https://example.test/h", "http_method": "POST"}
    em = client.post(f"{A}/contact-points", json={"name": "Mail", "type": "email",
                                                  "settings": {"addresses": "a@x.io; b@x.io"}}).json()
    assert em["settings"] == {"addresses": "a@x.io; b@x.io", "single_email": False}
    assert client.post(f"{A}/contact-points", json={"name": "hook", "type": "webhook",
                                                    "settings": {"url": "https://x"}}).status_code == 409
    for bad in ({"type": "webhook", "settings": {"url": "ftp://x"}},
                {"type": "webhook", "settings": {"url": "https://x", "http_method": "GET"}},
                {"type": "email", "settings": {"addresses": "nobody"}},
                {"type": "slack", "settings": {"recipient": "#soc"}}):
        assert client.post(f"{A}/contact-points", json={"name": "Bad", **bad}).status_code == 400
    assert client.post(f"{A}/contact-points", json={"name": "Bad", "type": "sms"}).status_code == 422
    cid = wh.json()["id"]
    upd = client.put(f"{A}/contact-points/{cid}", json={"name": "Hook2", "type": "webhook",
                                                        "settings": {"url": "http://x.test", "http_method": "put"}})
    assert upd.json()["settings"]["http_method"] == "PUT" and upd.json()["name"] == "Hook2"
    assert client.delete(f"{A}/contact-points/{cid}").status_code == 204
    assert client.get(f"{A}/contact-points/{cid}").status_code == 404


def test_slack_secrets_are_sealed_and_masked(client: Any) -> None:
    url = "https://hooks.slack.test/services/T/B/SECRETVALUE"
    r = client.post(f"{A}/contact-points", json={"name": "Slack", "type": "slack",
                                                 "settings": {"url": url, "recipient": "#soc"}})
    assert r.status_code == 201, r.text
    cp = r.json()
    assert cp["secure_fields"] == ["url"] and cp["settings"] == {"recipient": "#soc"}
    assert "SECRETVALUE" not in json.dumps(client.get(f"{A}/contact-points").json())
    svc = get_state().alerting
    stored = get_state().repo.alerting_list("contact_point")
    assert "SECRETVALUE" not in json.dumps(stored)                   # sealed at rest
    # Omitted secret keeps its value; "" clears it (then slack has nothing to post to -> 400).
    kept = client.put(f"{A}/contact-points/{cp['id']}", json={"name": "Slack", "type": "slack",
                                                              "settings": {"recipient": "#ops"}}).json()
    assert kept["secure_fields"] == ["url"] and svc._secrets(svc._cp(cp["id"]))["url"] == url
    cleared = client.put(f"{A}/contact-points/{cp['id']}", json={
        "name": "Slack", "type": "slack", "settings": {"url": ""}})
    assert cleared.status_code == 400
    swapped = client.put(f"{A}/contact-points/{cp['id']}", json={
        "name": "Slack", "type": "slack", "settings": {"url": "", "token": "xoxb-1", "recipient": "#a"}})
    assert swapped.json()["secure_fields"] == ["token"]


def test_delete_builtin_or_referenced_contact_point_conflicts(client: Any) -> None:
    assert client.delete(f"{A}/contact-points/browser").status_code == 409
    assert client.put(f"{A}/contact-points/browser", json={"name": "Browser", "type": "webhook",
                                                           "settings": {"url": "https://x"}}).status_code == 400
    cid = client.post(f"{A}/contact-points", json={"name": "Hook", "type": "webhook",
                                                   "settings": {"url": "https://x.test"}}).json()["id"]
    pol = client.get(f"{A}/policies").json()["policy"]
    pol["routes"].append({"id": "r2", "receiver": cid, "matchers": [{"label": "team", "op": "=~", "value": "s.*"}],
                          "continue": True, "routes": []})
    assert client.put(f"{A}/policies", json=pol).status_code == 200
    assert client.delete(f"{A}/contact-points/{cid}").status_code == 409
    assert client.delete(f"{A}/contact-points/nope").status_code == 404


def test_contact_point_test(client: Any) -> None:
    r = client.post(f"{A}/contact-points/browser/test").json()
    assert r["ok"] is True
    item = client.get(f"{A}/notifications").json()["items"][-1]
    assert item["source"] == "test" and item["contact_point_id"] == "browser"
    cid = client.post(f"{A}/contact-points", json={"name": "Mail", "type": "email",
                                                   "settings": {"addresses": "a@x.io"}}).json()["id"]
    assert client.post(f"{A}/contact-points/{cid}/test").json() == {"ok": False, "detail": "needs Grafana"}
    assert client.post(f"{A}/contact-points/missing/test").status_code == 404


# ------------------------------------------------------------------ policy
def test_policy_validation(client: Any) -> None:
    pol = client.get(f"{A}/policies").json()["policy"]
    assert client.put(f"{A}/policies", json={**pol, "receiver": "ghost"}).status_code == 400
    nested = {**pol, "routes": [{"receiver": "browser", "matchers": [], "routes": [
        {"receiver": "ghost", "matchers": []}]}]}
    assert client.put(f"{A}/policies", json=nested).status_code == 400
    bad_regex = {**pol, "routes": [{"receiver": "browser", "matchers": [{"label": "a", "op": "=~", "value": "("}]}]}
    assert client.put(f"{A}/policies", json=bad_regex).status_code == 422
    assert client.put(f"{A}/policies", json={**pol, "group_wait": "later"}).status_code == 422
    ok = client.put(f"{A}/policies", json={"receiver": "browser", "routes": [
        {"receiver": "", "matchers": [{"label": "x", "op": "=", "value": "1"}]}]}).json()
    assert ok["policy"]["group_by"] == ["alertname"] and ok["policy"]["repeat_interval"] == "4h"
    assert ok["policy"]["routes"][0]["id"] and ok["policy"]["routes"][0]["continue"] is False


def test_routing_semantics() -> None:
    pol = {"receiver": "root", "group_wait": "30s", "repeat_interval": "4h", "routes": [
        {"id": "a", "receiver": "A", "matchers": [{"label": "sev", "op": "=", "value": "crit"}],
         "continue": True, "repeat_interval": "1h", "routes": [
             {"id": "a1", "receiver": "", "matchers": [{"label": "team", "op": "=~", "value": "so.*"}]}]},
        {"id": "b", "receiver": "B", "matchers": [{"label": "team", "op": "!=", "value": ""}]},
        {"id": "c", "receiver": "C", "matchers": []},
    ]}
    got = lambda labels: [(m.receiver, m.route_id) for m in route(pol, labels)]    # noqa: E731
    assert got({"sev": "crit", "team": "soc"}) == [("A", "a1"), ("B", "b")]      # continue + inherit
    assert got({"sev": "crit"}) == [("A", "a"), ("C", "c")]
    assert got({"team": "x"}) == [("B", "b")]                                   # first match stops
    assert got({}) == [("C", "c")]
    assert route(pol, {"sev": "crit", "team": "soc"})[0].repeat_interval == "1h"
    assert route({"receiver": "root", "routes": []}, {})[0].receiver == "root"
    # regexes are anchored, like Alertmanager
    assert got({"team": "", "sev": "xcrit"}) == [("C", "c")]


# ------------------------------------------------------------------ evaluation
def test_reduce_and_compare() -> None:
    vals = [1.0, 5.0, float("nan"), 3.0]
    assert evaluator.reduce_values(vals, "last") == 3.0
    assert evaluator.reduce_values(vals, "max") == 5.0
    assert evaluator.reduce_values(vals, "min") == 1.0
    assert evaluator.reduce_values(vals, "sum") == 9.0
    assert evaluator.reduce_values(vals, "mean") == 3.0
    assert evaluator.reduce_values(vals, "count") == 3.0
    assert evaluator.reduce_values([], "last") is None
    cases = [("gt", 5, False), ("gte", 5, True), ("lt", 6, True), ("lte", 4, False),
             ("eq", 5, True), ("ne", 5, False)]
    for op, t, want in cases:
        assert evaluator.compare(5.0, op, t) is want, op
    assert evaluator.compare(None, "lt", 1) is False
    assert parse_duration("1m30s") == 90 and parse_duration("0") == 0
    assert evaluator.render("{{ $labels.a }}={{ $value }}", {"a": "x"}, 2.5) == "x=2.5"


def test_datasource_result_parsing() -> None:
    vec = {"status": "success", "data": {"resultType": "vector", "result": [
        {"metric": {}, "value": [1, "2"]}, {"metric": {}, "value": [1, "NaN"]}]}}
    assert evaluator._prom_values(vec, "P")[0] == 2.0
    assert evaluator._prom_values({"data": {"resultType": "scalar", "result": [1, "7"]}}, "P") == [7.0]
    with pytest.raises(evaluator.EvalError):
        evaluator._prom_values({"data": {"resultType": "streams", "result": []}}, "Loki")
    ch = {"meta": [{"name": "src", "type": "String"}, {"name": "n", "type": "UInt64"}],
          "data": [{"src": "a", "n": "12"}, {"src": "b", "n": "3"}]}
    assert evaluator.clickhouse_values(ch) == [12.0, 3.0]


def test_state_machine_for_nodata_and_resolve() -> None:
    rule = {"for": "2m", "no_data_state": "OK"}
    rt: dict[str, Any] = {}
    fire = {"value": 9.0, "firing": True}
    assert evaluator.step(rt, rule, fire, 0) is None and rt["state"] == "pending"
    assert evaluator.step(rt, rule, fire, 60) is None and rt["state"] == "pending"
    assert evaluator.step(rt, rule, fire, 120) == "firing" and rt["state"] == "firing"
    assert evaluator.step(rt, rule, {"error": "boom"}, 150) is None and rt["state"] == "error"
    assert evaluator.step(rt, rule, fire, 180) is None and rt["state"] == "firing"   # no re-fire
    assert evaluator.step(rt, rule, {"value": None, "firing": False}, 240) == "resolved"
    assert rt["state"] == "normal"
    nd: dict[str, Any] = {}
    assert evaluator.step(nd, {"for": "0s", "no_data_state": "NoData"}, {"value": None}, 0) is None
    assert nd["state"] == "nodata"
    assert evaluator.step({}, {"for": "0s", "no_data_state": "Alerting"}, {"value": None}, 0) == "firing"


def test_local_evaluation_delivers_to_browser_feed(client: Any) -> None:
    svc = get_state().alerting
    client.put(f"{A}/policies", json={"receiver": "browser", "group_wait": "10s", "repeat_interval": "1h"})
    rid = client.post(f"{A}/rules", json={**RULE, "for": "0s"}).json()["id"]
    before = client.get(f"{A}/notifications").json()["last_id"]
    assert svc.evaluate_rule(rid, {"value": 7.0, "firing": True, "at": "t"}, now=1000) == "firing"
    assert svc.flush_outbox(now=1005) == 0                    # group_wait not over yet
    assert svc.flush_outbox(now=1010) == 1
    assert svc.flush_outbox(now=1011) == 0
    assert client.get(f"{A}/rules/{rid}").json()["state"] == "firing"
    assert client.get(f"{A}/status").json()["counts"]["firing"] == 1
    assert svc.flush_outbox(now=1010 + 3600) == 1             # repeat_interval
    svc.evaluate_rule(rid, {"value": 1.0, "firing": False, "at": "t"}, now=5000)
    items = client.get(f"{A}/notifications", params={"after": before}).json()["items"]
    assert [i["status"] for i in items] == ["firing", "firing", "resolved"]
    assert items[0]["source"] == "local" and items[0]["summary"] == "soc at 7"
    assert items[0]["labels"]["alertname"] == RULE["name"] and items[0]["value"] == 7.0


# ------------------------------------------------------------------ receiver + feed
GRAFANA_PAYLOAD = {"status": "firing", "alerts": [
    {"status": "firing", "labels": {"alertname": "X", "severity": "critical", "aletheia_rule_id": "r1"},
     "annotations": {"summary": "s", "description": "d"}, "startsAt": "2026-01-01T00:00:00Z",
     "endsAt": "0001-01-01T00:00:00Z", "generatorURL": "http://g/alerting/grafana/r1/view",
     "fingerprint": "f", "values": {"B": 12, "C": 1}, "valueString": "[ var='B' value=12 ]"},
    {"status": "resolved", "labels": {"alertname": "Y"}, "annotations": {},
     "startsAt": "2026-01-01T00:00:00Z", "endsAt": "2026-01-01T00:05:00Z",
     "valueString": "[ var='B' labels={} value=3.5 ]"},
]}


def test_receiver_feed_and_paging(client: Any) -> None:
    assert client.post(f"{A}/receive?contact_point=browser", json=GRAFANA_PAYLOAD).status_code == 204
    assert client.post(f"{A}/receive?contact_point=ghost", json=GRAFANA_PAYLOAD).status_code == 204
    assert client.post(f"{A}/receive", content=b"not json").status_code == 204
    feed = client.get(f"{A}/notifications").json()
    assert len(feed["items"]) == 2 and feed["last_id"] == feed["items"][-1]["id"]
    first, second = feed["items"]
    assert first["source"] == "grafana" and first["rule_id"] == "r1" and first["value"] == 12
    assert first["ends_at"] is None and first["link"].endswith("/r1/view")
    assert second["status"] == "resolved" and second["value"] == 3.5 and second["rule_id"] is None
    for _ in range(3):
        client.post(f"{A}/contact-points/browser/test")
    page = client.get(f"{A}/notifications", params={"after": first["id"], "limit": 2}).json()
    assert [i["id"] for i in page["items"]] == [first["id"] + 1, first["id"] + 2]
    assert page["last_id"] == first["id"] + 2
    tail = client.get(f"{A}/notifications", params={"after": page["last_id"]}).json()
    assert len(tail["items"]) == 2
    empty = client.get(f"{A}/notifications", params={"after": tail["last_id"]}).json()
    assert empty == {"items": [], "last_id": tail["last_id"]}
    assert client.get(f"{A}/notifications", params={"limit": 500}).status_code == 422


def test_feed_is_a_ring_buffer() -> None:
    from studio.alerting.feed import NotificationFeed
    f = NotificationFeed(cap=3)
    for _ in range(5):
        f.add(status="firing", source="test")
    assert [i["id"] for i in f.list()["items"]] == [3, 4, 5]
    assert f.list(after=99)["last_id"] == 5                  # stale cursor resynchronises


# ------------------------------------------------------------------ Grafana translation
def _rule_doc(**kw: Any) -> dict[str, Any]:
    return {**RULE, "id": "r1", "group": "g1", **kw}


def test_rule_payload_translation() -> None:
    p = grafana.rule_to_grafana(_rule_doc())
    assert p["uid"] == "r1" and p["folderUID"] == "aletheia" and p["ruleGroup"] == "g1"
    assert p["condition"] == "C" and p["execErrState"] == "Error" and p["noDataState"] == "OK"
    assert p["isPaused"] is False and p["for"] == "2m"
    assert p["labels"] == {"team": "soc", "severity": "critical", "aletheia_rule_id": "r1"}
    a, b, c = p["data"]
    assert a["datasourceUid"] == "aletheia-prometheus" and a["model"]["instant"] is True
    assert b["model"]["type"] == "reduce" and b["model"]["reducer"] == "max"
    assert c["model"] == {"refId": "C", "type": "math", "expression": "$B >= 5"}
    gt = grafana.rule_to_grafana(_rule_doc(condition={"op": "lt", "threshold": 2.5}, enabled=False))
    assert gt["isPaused"] is True
    assert gt["data"][2]["model"]["conditions"][0]["evaluator"] == {"type": "lt", "params": [2.5]}
    loki = grafana.query_model("loki", "q")
    assert loki["queryType"] == "instant" and loki["expr"] == "q"
    ch = grafana.query_model("clickhouse", "SELECT 1")
    assert (ch["rawSql"], ch["format"], ch["queryType"], ch["editorType"]) == ("SELECT 1", 1, "sql", "sql")


def test_contact_point_and_policy_translation() -> None:
    browser = grafana.contact_point_to_grafana(
        {"id": "browser", "name": "Browser", "type": "browser"}, {}, "http://studio:8081/")
    assert browser["type"] == "webhook"
    assert browser["settings"]["url"] == "http://studio:8081/api/v1/alerting/receive?contact_point=browser"
    email = grafana.contact_point_to_grafana(
        {"id": "e", "name": "E", "type": "email", "settings": {"addresses": "a@b", "single_email": True},
         "disable_resolve_message": True}, {}, "x")
    assert email["settings"] == {"addresses": "a@b", "singleEmail": True} and email["disableResolveMessage"]
    slack = grafana.contact_point_to_grafana(
        {"id": "s", "name": "S", "type": "slack", "settings": {"recipient": "#a"}}, {"token": "t"}, "x")
    assert slack["settings"] == {"token": "t", "recipient": "#a"}
    hook = grafana.contact_point_to_grafana(
        {"id": "w", "name": "W", "type": "webhook", "settings": {"url": "http://h", "http_method": "PUT"}}, {}, "x")
    assert hook["settings"] == {"url": "http://h", "httpMethod": "PUT"}
    pol = {"receiver": "browser", "group_by": ["alertname"], "group_wait": "30s", "group_interval": "5m",
           "repeat_interval": "4h", "routes": [
               {"id": "1", "receiver": "w", "continue": True, "group_wait": "10s",
                "matchers": [{"label": "severity", "op": "=~", "value": "crit.*"}], "routes": [
                    {"id": "2", "receiver": "", "matchers": [], "continue": False, "routes": []}]}]}
    tree = grafana.policy_to_grafana(pol, {"browser": "Browser", "w": "W"})
    assert tree["receiver"] == "Browser"
    r = tree["routes"][0]
    assert r["receiver"] == "W" and r["object_matchers"] == [["severity", "=~", "crit.*"]]
    assert r["continue"] is True and r["group_wait"] == "10s" and "receiver" not in r["routes"][0]


def test_runtime_state_parsing() -> None:
    body = {"data": {"groups": [{"rules": [
        {"labels": {"aletheia_rule_id": "r1"}, "state": "firing", "health": "ok",
         "lastEvaluation": "2026-01-01T00:00:00Z",
         "alerts": [{"value": "[ var='A' labels={} value=4 ], [ var='B' labels={} value=5 ]"}]},
        {"labels": {"aletheia_rule_id": "r2"}, "state": "inactive", "health": "error", "lastError": "x"},
        {"labels": {"aletheia_rule_id": "r3"}, "state": "inactive", "health": "nodata",
         "lastEvaluation": "0001-01-01T00:00:00Z"},
        {"labels": {}, "state": "firing"},
    ]}]}}
    rt = grafana.runtime_from_prometheus(body)
    assert rt["r1"] == {"state": "firing", "last_eval": "2026-01-01T00:00:00Z", "last_value": 5.0,
                        "last_error": None}
    assert rt["r2"]["state"] == "error" and rt["r2"]["last_error"] == "x"
    assert rt["r3"]["state"] == "nodata" and rt["r3"]["last_eval"] is None
    assert set(rt) == {"r1", "r2", "r3"}


class FakeGrafana:
    """Just enough of Grafana's provisioning API, recording every request."""

    def __init__(self) -> None:
        self.calls: list[httpx.Request] = []
        self.rules: dict[str, dict[str, Any]] = {"orphan": {"uid": "orphan", "folderUID": "aletheia",
                                                            "ruleGroup": "g",
                                                            "labels": {"aletheia_rule_id": "orphan"}},
                                                 "hand-made": {"uid": "hand-made", "folderUID": "aletheia",
                                                               "ruleGroup": "g"}}
        self.cps: dict[str, dict[str, Any]] = {}
        self.policy: dict[str, Any] | None = None
        self.groups: dict[str, int] = {}
        self.fail = False

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.calls.append(req)
        m, p = req.method, req.url.path
        body = json.loads(req.content) if req.content else None
        if p == "/api/health":
            return httpx.Response(200, json={"database": "ok", "version": "11.4.0"})
        if self.fail:
            return httpx.Response(500, text="boom")
        if p == "/api/folders/aletheia":
            return httpx.Response(404)
        if p == "/api/folders":
            return httpx.Response(200, json=[] if m == "GET" else {"uid": "aletheia"})
        if p == "/api/v1/provisioning/alert-rules" and m == "GET":
            return httpx.Response(200, json=list(self.rules.values()))
        if p == "/api/v1/provisioning/alert-rules" and m == "POST":
            self.rules[body["uid"]] = body
            self.groups.setdefault(body["ruleGroup"], 60)
            return httpx.Response(201, json=body)
        if p.startswith("/api/v1/provisioning/alert-rules/"):
            uid = p.rsplit("/", 1)[1]
            if m == "GET":
                return httpx.Response(200, json=self.rules[uid]) if uid in self.rules else httpx.Response(404)
            if m == "PUT":
                self.rules[uid] = body
                return httpx.Response(200, json=body)
            self.rules.pop(uid, None)
            return httpx.Response(204)
        if p.startswith("/api/v1/provisioning/folder/aletheia/rule-groups/"):
            g = p.rsplit("/", 1)[1]
            if m == "GET":
                return httpx.Response(200, json={"title": g, "interval": self.groups.get(g, 60), "rules": []})
            self.groups[g] = body["interval"]
            return httpx.Response(200, json=body)
        if p == "/api/v1/provisioning/contact-points":
            if m == "GET":
                return httpx.Response(200, json=list(self.cps.values()))
            self.cps[body["uid"]] = body
            return httpx.Response(202, json=body)
        if p.startswith("/api/v1/provisioning/contact-points/"):
            uid = p.rsplit("/", 1)[1]
            if m == "PUT":
                self.cps[uid] = body
            else:
                self.cps.pop(uid, None)
            return httpx.Response(202)
        if p == "/api/v1/provisioning/policies":
            self.policy = body
            return httpx.Response(202)
        if p == "/api/prometheus/grafana/api/v1/rules":
            return httpx.Response(200, json={"data": {"groups": [{"rules": [
                {"labels": {"aletheia_rule_id": "aletheia-format-drift"}, "state": "pending",
                 "health": "ok", "lastEvaluation": "2026-01-01T00:00:00Z"}]}]}})
        if p == "/api/alertmanager/grafana/config/api/v1/receivers/test":
            return httpx.Response(207, json={"receivers": [{"grafana_managed_receiver_configs": [
                {"status": "failed", "error": "smtp not configured"}]}]})
        return httpx.Response(404, text=f"unexpected {m} {p}")


@pytest.fixture
def grafana_svc(monkeypatch: pytest.MonkeyPatch) -> tuple[AlertingService, FakeGrafana]:
    monkeypatch.setenv("ALETHEIA_GRAFANA_URL", "http://grafana.test")
    monkeypatch.setenv("ALETHEIA_GRAFANA_TOKEN", "tok")
    monkeypatch.setenv("ALETHEIA_ALERT_RECEIVER_URL", "http://studio:8081")
    fake = FakeGrafana()
    svc = AlertingService(MemoryRepo(), secret="s", transport=httpx.MockTransport(fake))
    svc.ensure_loaded()
    return svc, fake


def test_ensure_folder_reuses_existing_title() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/api/folders/aletheia":
            return httpx.Response(404)
        if req.url.path == "/api/folders" and req.method == "GET":
            return httpx.Response(200, json=[{"uid": "cfz39yrkva0hse", "title": "Aletheia"}])
        return httpx.Response(409, text="a folder with the same name already exists")
    cfg = grafana.GrafanaConfig("http://g", "http://g", None, "admin", "x", "http://s")
    client = grafana.GrafanaClient(cfg, httpx.MockTransport(handler))
    assert client.ensure_folder() == "cfz39yrkva0hse"
    assert grafana.rule_to_grafana(_rule_doc(), client.folder_uid)["folderUID"] == "cfz39yrkva0hse"


def test_grafana_full_sync_and_mode(grafana_svc: tuple[AlertingService, FakeGrafana]) -> None:
    svc, fake = grafana_svc
    assert svc.list_rules()[0]["sync"]["state"] == "pending"
    assert svc.refresh_health() is True and svc.mode == "grafana"
    svc.sync_all()
    assert all(c.headers["X-Disable-Provenance"] == "true" for c in fake.calls)
    assert all(c.headers["Authorization"] == "Bearer tok" for c in fake.calls)
    # Only Studio-labelled orphans are removed; hand-made Grafana rules in the folder survive.
    assert "orphan" not in fake.rules and "hand-made" in fake.rules and len(fake.rules) == 5
    assert fake.cps["browser"]["settings"]["url"] == \
        "http://studio:8081/api/v1/alerting/receive?contact_point=browser"
    assert fake.policy["receiver"] == "Browser" and fake.groups["aletheia"] == 60
    assert {r["sync"]["state"] for r in svc.list_rules()} == {"synced"}
    assert svc.get_policy()["sync"]["state"] == "synced"
    st = svc.status()
    assert st["mode"] == "grafana" and st["grafana"]["version"] == "11.4.0" and st["last_sync_error"] is None
    svc.refresh_runtime()
    assert svc.get_rule("aletheia-format-drift")["state"] == "pending"


def test_grafana_failures_never_fail_writes(grafana_svc: tuple[AlertingService, FakeGrafana]) -> None:
    from studio.alerting.models import RuleIn
    svc, fake = grafana_svc
    svc.refresh_health()
    fake.fail = True
    rule = svc.save_rule(RuleIn.model_validate({**RULE, "interval": "20s"}))
    assert rule["sync"]["state"] == "error" and "HTTP 500" in rule["sync"]["error"]
    svc.delete_rule("aletheia-format-drift")
    assert ("rule", "aletheia-format-drift") in svc._tombstones
    fake.fail = False
    svc.retry_pending()
    assert svc.get_rule(rule["id"])["sync"]["state"] == "synced"
    assert rule["id"] in fake.rules and fake.groups["aletheia"] == 20
    assert not svc._tombstones
    ok = svc.test_contact_point("browser")
    assert ok["ok"] is True                                       # browser test stays local
    from studio.alerting.models import ContactPointIn
    em = svc.save_contact_point(ContactPointIn(name="Mail", type="email", settings={"addresses": "a@b.c"}))
    assert svc.test_contact_point(em["id"]) == {"ok": False, "detail": "smtp not configured"}


def test_policy_model_roundtrip() -> None:
    p = PolicyIn.model_validate({"receiver": "x", "routes": [{"receiver": "y", "continue": True,
                                                              "matchers": [{"label": "a", "value": "b"}]}]})
    assert p.routes[0].continue_ is True and p.routes[0].matchers[0].op == "="


# ------------------------------------------------------------------ raw store
def test_rawstore_falls_back_when_loki_is_down(monkeypatch: pytest.MonkeyPatch) -> None:
    from studio.ingest import rawstore

    def refuse(*_: Any, **__: Any) -> None:
        raise httpx.ConnectError("refused")

    monkeypatch.setenv("ALETHEIA_LOKI_URL", "http://loki.test:3100")
    monkeypatch.setattr(rawstore.httpx, "get", refuse)
    assert rawstore.build_rawstore().kind == "memory"
    monkeypatch.setattr(rawstore.httpx, "get", lambda *a, **k: httpx.Response(503, text="warming up"))
    assert rawstore.build_rawstore().kind == "loki"
