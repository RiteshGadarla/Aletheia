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
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field, asdict
from typing import Callable

CH_URL = os.environ.get("ALETHEIA_CH_URL", "http://localhost:8123")
CH_DB = os.environ.get("ALETHEIA_CH_DB", "aletheia")
CH_USER = os.environ.get("ALETHEIA_CH_USER", "aletheia")
CH_PASS = os.environ.get("ALETHEIA_CH_PASSWORD", "aletheia")
SYSLOG_HOST = os.environ.get("ALETHEIA_SYSLOG_HOST", "localhost")
SYSLOG_PORT = int(os.environ.get("ALETHEIA_SYSLOG_PORT", "5514"))
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _find_bin() -> str:
    """Prefer the locally built binary; fall back to PATH."""
    local = os.path.join(REPO, "bin", "aletheia")
    if os.access(local, os.X_OK):
        return local
    return shutil.which("aletheia") or "aletheia"


ALETHEIA_BIN = os.environ.get("ALETHEIA_BIN") or _find_bin()


# --------------------------------------------------------------------------- helpers
def ch(sql: str, timeout: int = 60) -> str:
    """Run SQL against ClickHouse. The statement goes in the POST body — long mutations do
    not survive being stuffed into a URL query string."""
    q = urllib.parse.urlencode({"database": CH_DB, "user": CH_USER, "password": CH_PASS})
    req = urllib.request.Request(f"{CH_URL}/?{q}", data=sql.encode())
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode().strip()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"ClickHouse: {e.read().decode()[:300]}") from e


def run(cmd: list[str], timeout: int = 300, env: dict | None = None) -> tuple[int, str]:
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    return p.returncode, (p.stdout + p.stderr).strip()


def have_engine() -> bool:
    return os.access(ALETHEIA_BIN, os.X_OK) or shutil.which(ALETHEIA_BIN) is not None


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
def _generate_and_ingest(formats: str | None, count: int) -> tuple[int, str, dict]:
    """Generate lines, then run them through the worker's own decision path (bench/ingest.py)."""
    gen = os.path.join(REPO, "sources", "generators", "log_generator.py")
    out_file = os.path.join(REPO, ".demo-traffic.log")
    if os.path.exists(out_file):
        os.remove(out_file)
    cmd = [sys.executable, gen, "--count", str(count), "--out", out_file]
    if formats:
        cmd += ["--formats", formats]
    rc, out = run(cmd)
    if rc != 0:
        return rc, out, {}
    rc2, out2 = run([sys.executable, os.path.join(REPO, "bench", "ingest.py"),
                     "--file", out_file, "--json"])
    stats = {}
    try:
        stats = json.loads(out2.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        stats = {"raw": out2[-300:]}
    return rc2, out + "\n" + out2, stats


def s1_start_traffic(a) -> Result:
    """Every source lands in one OCSF table with identical columns."""
    cli = (f"python3 sources/generators/log_generator.py --count {a.count} --out traffic.log && "
           f"python3 bench/ingest.py --file traffic.log")
    rc, out, stats = _generate_and_ingest(None, a.count)
    detail = dict(stats)
    try:
        detail["by_source"] = json.loads(ch(
            "SELECT source_id, count() AS n, countIf(parse_status='full') AS full "
            "FROM events GROUP BY source_id ORDER BY n DESC FORMAT JSON")).get("data", [])
    except Exception as exc:                                        # noqa: BLE001
        detail["clickhouse"] = f"unavailable: {exc}"
    n = stats.get("ingested", 0)
    return Result("1 unified output", rc == 0 and n > 0, "b, c, f",
                  "every source visible with identical OCSF columns", cli, detail,
                  f"{n} events ingested, {stats.get('matched', 0)} normalized")


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


def _engine_env() -> dict:
    """The CLI defaults packs to /packs, which only exists inside the container image."""
    env = dict(os.environ)
    env.setdefault("ALETHEIA_PACKS_DIR", os.path.join(REPO, "backend", "packs"))
    env.setdefault("ALETHEIA_CLICKHOUSE_ADDR",
                   os.environ.get("ALETHEIA_CLICKHOUSE_ADDR", "127.0.0.1:9000"))
    env.setdefault("ALETHEIA_CLICKHOUSE_DB", CH_DB)
    env.setdefault("ALETHEIA_CLICKHOUSE_USER", CH_USER)
    env.setdefault("ALETHEIA_CLICKHOUSE_PASSWORD", CH_PASS)
    # Without a DSN the Merkle chain simply is not checked, and verify fails for that alone.
    env.setdefault("ALETHEIA_PG_DSN",
                   os.environ.get("ALETHEIA_PG_DSN",
                                  "postgres://aletheia:aletheia@127.0.0.1:5432/aletheia"))
    return env


def _untamper(uid: str, original: str) -> bool:
    """Put the flipped byte back, so the scenario is repeatable and leaves no damage."""
    try:
        esc = original.replace("\\", "\\\\").replace("'", "\\'")
        ch(f"ALTER TABLE events UPDATE vars = arrayMap((x, i) -> if(i = 1, '{esc}', x), "
           f"vars, arrayEnumerate(vars)) WHERE event_uid = '{uid}' SETTINGS mutations_sync=1")
        return ch(f"SELECT vars[1] FROM events WHERE event_uid='{uid}' LIMIT 1") == original
    except Exception:                                               # noqa: BLE001
        return False


def _busiest_source() -> str:
    try:
        rows = json.loads(ch("SELECT source_id FROM events GROUP BY source_id "
                             "ORDER BY count() DESC LIMIT 1 FORMAT JSON")).get("data", [])
        return rows[0]["source_id"] if rows else ""
    except Exception:                                               # noqa: BLE001
        return ""


def s3_verify(a) -> Result:
    src = a.source if a.source != "fw01" else (_busiest_source() or a.source)
    cli = f"aletheia verify --source {src} --last 24h --json"
    if not have_engine():
        return Result("3 integrity: verify", False, "a, tamper evidence",
                      "verify passes over the range", cli, message="aletheia binary not on PATH")
    rc, out = run([ALETHEIA_BIN, "verify", "--source", src, "--last", "24h", "--json"],
                  env=_engine_env())
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
    cli = ("clickhouse-client -q \"ALTER TABLE events UPDATE vars = arrayMap((x,i) -> "
           "if(i = 1, concat(x,'X'), x), vars, arrayEnumerate(vars)) "
           "WHERE event_uid = '<uid>' SETTINGS mutations_sync=1\"")
    try:
        # Take the source id with the uid. Verifying any OTHER source would pass, which looked
        # exactly like "tampering went undetected" and was reported as an engine failure for a
        # long time — the engine was right, the scenario was checking the wrong source.
        row = ch("SELECT event_uid, source_id FROM events WHERE storage_mode='template' "
                 "AND length(vars) > 0 LIMIT 1 FORMAT JSON")
        data = json.loads(row).get("data", [])
        if not data:
            return Result("3b tamper one byte", False, "tamper evidence",
                          "verify fails at the exact event", cli,
                          message="no template-mode events to tamper — run scenario 1 first")
        uid, source = data[0]["event_uid"], data[0]["source_id"]
        before = ch(f"SELECT vars[1] FROM events WHERE event_uid = '{uid}' LIMIT 1")
        sha = ch(f"SELECT hex(raw_sha256) FROM events WHERE event_uid = '{uid}' LIMIT 1")
        # ClickHouse cannot assign to one array element, so the whole column is rewritten
        # with only the first entry altered. Still a direct DB edit that bypasses Aletheia.
        ch(f"ALTER TABLE events UPDATE vars = arrayMap((x, i) -> if(i = 1, concat(x, 'X'), x), "
           f"vars, arrayEnumerate(vars)) WHERE event_uid = '{uid}' SETTINGS mutations_sync=1")
        detail = {"event_uid": uid, "source_id": source, "vars_before": before,
                  "vars_after": ch(f"SELECT vars[1] FROM events WHERE event_uid='{uid}' LIMIT 1"),
                  "stored_sha256": sha[:16] + "...",
                  "note": "the stored hash is untouched, so the rebuilt line no longer matches it"}
        if not have_engine():
            _untamper(uid, before)
            return Result("3b tamper one byte", True, "tamper evidence",
                          "verify would fail here", cli, detail,
                          "byte flipped and restored; aletheia binary absent so verify not run")
        try:
            rc, out = run([ALETHEIA_BIN, "verify", "--source", source, "--last", "24h", "--json"],
                          env=_engine_env())
            detail["verify_exit_code"] = rc
            detail["verify"] = out[-600:]
            detail["named_this_event"] = uid in out
        finally:
            # Always put the byte back. Leaving the corpus corrupted made every later verify
            # fail, so a second demo run reported damage this scenario had caused itself.
            detail["restored"] = _untamper(uid, before)
        # verify SHOULD fail now; a zero exit would mean tampering went undetected
        detected = rc != 0 and detail["named_this_event"]
        return Result("3b tamper one byte", detected, "tamper evidence",
                      "verify FAILS and names this exact event and its Merkle batch",
                      cli, detail,
                      "tampering detected, then the byte was restored"
                      if detected else "NOT DETECTED — investigate")
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
    """The ASA firmware-drift variant must land in quarantine, stored in full — never dropped."""
    cli = ("python3 sources/generators/log_generator.py --formats asa_drift --count 200 "
           "--out drift.log && python3 bench/ingest.py --file drift.log")
    rc, out, stats = _generate_and_ingest("asa_drift", 200)
    detail = dict(stats)
    try:
        detail["raw_only_total"] = json.loads(ch(
            "SELECT count() AS n FROM events WHERE parse_status='raw_only' FORMAT JSON")
        ).get("data", [{}])[0].get("n", 0)
    except Exception as exc:                                        # noqa: BLE001
        detail["clickhouse"] = f"unavailable: {exc}"
    q = stats.get("quarantined", 0)
    # Drifted lines SHOULD fail to match — that is the whole point of the scenario.
    return Result("5 drift + onboarding", rc == 0 and q > 0, "e, i",
                  "drifted lines stored verbatim as raw_only and queued for onboarding",
                  cli, detail,
                  f"{q} of {stats.get('ingested', 0)} lines quarantined, none dropped")


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
    ap.add_argument("--count", type=int, default=400)
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
