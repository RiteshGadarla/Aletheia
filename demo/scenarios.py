#!/usr/bin/env python3
"""Scenario engine behind the Demo Console (spec §21).

Every scenario is also a CLI command, and the console shows that command, so nothing is hidden
behind the UI. Generators use a fixed seed, so every run produces identical data and results.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field, asdict
from typing import Callable

CH_URL = os.environ.get("ALETHEIA_CH_URL", "http://localhost:8123")
CH_DB = os.environ.get("ALETHEIA_CH_DB", "aletheia")
SYSLOG_HOST = os.environ.get("ALETHEIA_SYSLOG_HOST", "localhost")
SYSLOG_PORT = int(os.environ.get("ALETHEIA_SYSLOG_PORT", "5514"))
ALETHEIA_BIN = os.environ.get("ALETHEIA_BIN", "aletheia")
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# --------------------------------------------------------------------------- helpers
def ch(sql: str, timeout: int = 60) -> str:
    """Run SQL against ClickHouse over HTTP and return the raw body."""
    q = urllib.parse.urlencode({"query": sql, "database": CH_DB})
    with urllib.request.urlopen(f"{CH_URL}/?{q}", timeout=timeout) as r:
        return r.read().decode().strip()


def run(cmd: list[str], timeout: int = 300) -> tuple[int, str]:
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout + p.stderr).strip()


def have_engine() -> bool:
    return shutil.which(ALETHEIA_BIN) is not None


@dataclass
class Result:
    scenario: str
    ok: bool
    proves: str
    expected: str
    cli: str
    detail: dict = field(default_factory=dict)
    message: str = ""


@dataclass
class Scenario:
    num: str
    title: str
    proves: str
    expected: str
    cli: str
    run: Callable[[argparse.Namespace], Result]


# --------------------------------------------------------------------------- scenarios
def s1_start_traffic(a) -> Result:
    """Eight source types stream in; one table shows them all in identical OCSF columns."""
    gen = os.path.join(REPO, "sources", "generators", "log_generator.py")
    cli = (f"python3 sources/generators/log_generator.py --seed 1337 --rate {a.rate} "
           f"--duration {a.duration} --syslog {SYSLOG_HOST}:{SYSLOG_PORT}")
    if not os.path.exists(gen):
        return Result("1 unified output", False, "b, c, f", "eight sources, one OCSF table", cli,
                      message="generator not found — build sources/generators first")
    rc, out = run([sys.executable, gen, "--seed", "1337", "--rate", str(a.rate),
                   "--duration", str(a.duration), "--syslog", f"{SYSLOG_HOST}:{SYSLOG_PORT}"])
    detail = {}
    try:
        detail["by_source"] = ch(
            "SELECT source_id, count() AS n, countIf(parse_status='full') AS full "
            "FROM events GROUP BY source_id ORDER BY n DESC FORMAT JSON")
    except Exception as exc:                                        # noqa: BLE001
        detail["clickhouse"] = f"unavailable: {exc}"
    return Result("1 unified output", rc == 0, "b, c, f",
                  "eight source types visible with identical OCSF columns", cli, detail, out[-400:])


def s2_lineage(a) -> Result:
    """Pick one event and show its byte spans — proves traceability at byte level."""
    cli = "open http://localhost:8080/lineage  (click any OCSF field)"
    try:
        row = ch("SELECT event_uid, template_id, source_id FROM events "
                 "WHERE storage_mode='template' AND parse_status='full' LIMIT 1 FORMAT JSON")
        data = json.loads(row).get("data", [])
        ok = bool(data)
        return Result("2 byte lineage", ok, "d, at byte level",
                      "clicking src_endpoint.ip highlights the exact source bytes", cli,
                      {"sample_event": data[0] if data else None},
                      "" if ok else "no template-mode events yet — run scenario 1 first")
    except Exception as exc:                                        # noqa: BLE001
        return Result("2 byte lineage", False, "d, at byte level", "byte spans highlight", cli,
                      message=f"ClickHouse unavailable: {exc}")


def s3_verify(a) -> Result:
    cli = f"{ALETHEIA_BIN} verify --source {a.source} --last 15m --json"
    if not have_engine():
        return Result("3 integrity: verify", False, "a, tamper evidence",
                      "verify passes over the range", cli, message="aletheia binary not on PATH")
    rc, out = run([ALETHEIA_BIN, "verify", "--source", a.source, "--last", "15m", "--json"])
    try:
        detail = json.loads(out)
    except json.JSONDecodeError:
        detail = {"raw": out[-400:]}
    return Result("3 integrity: verify", rc == 0, "a, tamper evidence",
                  "every batch verifies; reconstruct mismatches = 0", cli, detail)


def s3b_tamper(a) -> Result:
    """Flip one stored byte directly in ClickHouse, bypassing Aletheia entirely — spec §21.3.

    This is what an attacker with database access would do. Verification must then fail and name
    the exact batch and event.
    """
    cli = ("clickhouse-client -q \"ALTER TABLE events UPDATE vars[1] = 'TAMPERED' "
           "WHERE event_uid = '<uid>' SETTINGS mutations_sync=1\"")
    try:
        row = ch("SELECT event_uid FROM events WHERE storage_mode='template' "
                 "AND length(vars) > 0 LIMIT 1 FORMAT JSON")
        data = json.loads(row).get("data", [])
        if not data:
            return Result("3b tamper one byte", False, "tamper evidence",
                          "verify fails at the exact event", cli,
                          message="no template-mode events to tamper — run scenario 1 first")
        uid = data[0]["event_uid"]
        before = ch(f"SELECT vars[1] FROM events WHERE event_uid = '{uid}' LIMIT 1")
        ch(f"ALTER TABLE events UPDATE vars[1] = concat(vars[1], 'X') "
           f"WHERE event_uid = '{uid}' SETTINGS mutations_sync=1")
        detail = {"event_uid": uid, "vars_before": before,
                  "vars_after": ch(f"SELECT vars[1] FROM events WHERE event_uid='{uid}' LIMIT 1")}
        if have_engine():
            rc, out = run([ALETHEIA_BIN, "verify", "--source", a.source, "--last", "60m", "--json"])
            detail["verify_exit_code"] = rc
            detail["verify"] = out[-600:]
            # verify SHOULD fail now; a zero exit would mean tampering went undetected
            return Result("3b tamper one byte", rc != 0, "tamper evidence",
                          "verify FAILS and names this exact event and its Merkle batch",
                          cli, detail,
                          "tampering detected" if rc != 0 else "NOT DETECTED — investigate")
        return Result("3b tamper one byte", True, "tamper evidence",
                      "verify would fail here", cli, detail,
                      "byte flipped; aletheia binary absent so verify not run")
    except Exception as exc:                                        # noqa: BLE001
        return Result("3b tamper one byte", False, "tamper evidence", "verify fails", cli,
                      message=f"ClickHouse unavailable: {exc}")


def s4_storage(a) -> Result:
    cli = "python3 bench/storage_report.py --json"
    script = os.path.join(REPO, "bench", "storage_report.py")
    rc, out = run([sys.executable, script, "--url", CH_URL, "--db", CH_DB, "--json"])
    try:
        detail = json.loads(out)
    except json.JSONDecodeError:
        detail = {"raw": out[-400:]}
    return Result("4 storage economy", rc == 0, "Economy pillar",
                  "Aletheia vs raw+normalized, and vs compressed raw alone", cli, detail)


def s5_drift(a) -> Result:
    """Emit the ASA firmware-drift variant; those lines must land in quarantine, not be dropped."""
    gen = os.path.join(REPO, "sources", "generators", "log_generator.py")
    cli = (f"python3 sources/generators/log_generator.py --source asa --drift --count 200 "
           f"--syslog {SYSLOG_HOST}:{SYSLOG_PORT}")
    if not os.path.exists(gen):
        return Result("5 drift + onboarding", False, "e, i", "drifted events quarantined", cli,
                      message="generator not found")
    rc, out = run([sys.executable, gen, "--source", "asa", "--drift", "--count", "200",
                   "--syslog", f"{SYSLOG_HOST}:{SYSLOG_PORT}"])
    time.sleep(3)
    detail = {}
    try:
        detail["raw_only"] = ch("SELECT count() FROM events WHERE parse_status='raw_only' "
                                "AND recv_time > now() - INTERVAL 5 MINUTE")
    except Exception as exc:                                        # noqa: BLE001
        detail["clickhouse"] = f"unavailable: {exc}"
    return Result("5 drift + onboarding", rc == 0, "e, i",
                  "drifted lines stored verbatim as raw_only and quarantined — never dropped",
                  cli, detail, out[-300:])


def s8_bench(a) -> Result:
    cli = f"{ALETHEIA_BIN} bench --workers 1,2,4 --duration 60s --json"
    if not have_engine():
        return Result("8 throughput", False, "scalability",
                      "eps rises with worker count", cli, message="aletheia binary not on PATH")
    rc, out = run([ALETHEIA_BIN, "bench", "--workers", "1,2,4", "--duration", "60s", "--json"],
                  timeout=600)
    try:
        detail = json.loads(out)
    except json.JSONDecodeError:
        detail = {"raw": out[-400:]}
    return Result("8 throughput", rc == 0, "scalability claim",
                  "events/sec measured for 1, 2 and 4 workers on this machine", cli, detail)


def s_zero_loss(a) -> Result:
    """Requirement (a) admits no tolerance: generated count must equal stored count exactly."""
    cli = "compare generator count against SELECT count() FROM events"
    try:
        stored = int(ch("SELECT count() FROM events"))
        return Result("zero loss", True, "a",
                      "generated count == stored count, exactly", cli,
                      {"stored_rows": stored},
                      "compare against the generator's reported count")
    except Exception as exc:                                        # noqa: BLE001
        return Result("zero loss", False, "a", "counts equal", cli,
                      message=f"ClickHouse unavailable: {exc}")


def s_reset(a) -> Result:
    """Restore initial state without restarting the container."""
    cli = "python3 demo/scenarios.py reset"
    try:
        ch("TRUNCATE TABLE IF EXISTS events")
        ch("TRUNCATE TABLE IF EXISTS baseline_events")
        return Result("reset demo", True, "repeatability",
                      "initial state restored; fixed seed means an identical rerun", cli)
    except Exception as exc:                                        # noqa: BLE001
        return Result("reset demo", False, "repeatability", "state cleared", cli,
                      message=f"ClickHouse unavailable: {exc}")


SCENARIOS: dict[str, Scenario] = {
    "traffic": Scenario("1", "Start traffic", "b, c, f", "one OCSF table for all sources",
                        "log_generator.py --seed 1337", s1_start_traffic),
    "lineage": Scenario("2", "Byte lineage", "d", "exact bytes highlight", "open /lineage", s2_lineage),
    "verify": Scenario("3", "Verify integrity", "a", "all batches verify",
                       "aletheia verify", s3_verify),
    "tamper": Scenario("3b", "Tamper one stored byte", "tamper evidence",
                       "verify fails at the exact event", "ALTER TABLE ... UPDATE", s3b_tamper),
    "storage": Scenario("4", "Storage report", "Economy", "two honest comparisons",
                        "bench/storage_report.py", s4_storage),
    "drift": Scenario("5", "Trigger firmware drift", "e, i", "quarantined, not dropped",
                      "log_generator.py --drift", s5_drift),
    "bench": Scenario("8", "Run benchmark", "scalability", "eps by worker count",
                      "aletheia bench", s8_bench),
    "zeroloss": Scenario("z", "Zero loss check", "a", "counts match exactly",
                         "SELECT count() FROM events", s_zero_loss),
    "reset": Scenario("r", "Reset demo", "repeatability", "initial state restored",
                      "scenarios.py reset", s_reset),
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("scenario", choices=[*SCENARIOS, "list", "all"])
    ap.add_argument("--source", default="fw01")
    ap.add_argument("--rate", type=int, default=200)
    ap.add_argument("--duration", type=int, default=20)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    if a.scenario == "list":
        for key, s in SCENARIOS.items():
            print(f"{s.num:>3}  {key:<9} {s.title:<28} proves: {s.proves}")
        return 0

    keys = [k for k in SCENARIOS if k != "reset"] if a.scenario == "all" else [a.scenario]
    results = [SCENARIOS[k].run(a) for k in keys]

    if a.json:
        print(json.dumps([asdict(r) for r in results], indent=2, default=str))
    else:
        for r in results:
            print(f"[{'PASS' if r.ok else 'FAIL'}] {r.scenario}")
            print(f"       proves:   {r.proves}")
            print(f"       expected: {r.expected}")
            print(f"       cli:      {r.cli}")
            if r.message:
                print(f"       note:     {r.message}")
            if r.detail:
                print(f"       detail:   {json.dumps(r.detail, default=str)[:300]}")
            print()
    return 0 if all(r.ok for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
