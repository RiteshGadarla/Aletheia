# Aletheia — Benchmark methodology and results

> **Rule for this document: no unmeasured figures.** Every number below is produced by the harness
> in [`bench/`](../bench/) and recorded together with the machine specification it ran on. Cells
> marked *(pending)* have not been measured yet and must not be quoted until they are.

## How to reproduce

```bash
docker exec aletheia aletheia bench --workers 1,2,4 --duration 60s --json
# or, against a running deployment:
./bench/run_all.sh --out docs/benchmarks-results.json
```

Record the machine specification with every run: CPU model, physical core count, RAM, disk type,
and the memory/CPU allocated to Docker.

---

## Machine specification for the results below

| | |
|---|---|
| CPU | *(pending)* |
| Physical cores | *(pending)* |
| RAM | *(pending)* |
| Disk | *(pending)* |
| Docker allocation | *(pending)* |
| Image tag / commit | *(pending)* |

---

## 1. Throughput

**Method.** Replay a mixed corpus drawn from all prototype sources at a steadily increasing rate
until consumer lag begins to grow. The sustained rate just below that point is the result. Repeat
with 1, 2 and 4 workers.

**Reference targets.** 1 billion events/day = **11,574 eps** average. A 3× burst allowance =
**~35,000 eps**.

| Workers | Sustained eps | eps per core | Lag stable? |
|---|---|---|---|
| 1 | *(pending)* | *(pending)* | |
| 2 | *(pending)* | *(pending)* | |
| 4 | *(pending)* | *(pending)* | |

> Note: inside the all-in-one evaluation image the bus, workers and ClickHouse share one machine, so
> absolute numbers are lower than a production deployment with separate nodes. What this test
> demonstrates is that throughput **scales with workers**.

## 2. Storage efficiency

**Method.** Load the identical corpus into `events` (template + vars) and into `baseline_events`
(raw text + normalized JSON), both ZSTD-compressed, then read compressed bytes from ClickHouse
`system.parts`.

Reported **two ways**, deliberately:

1. versus the realistic baseline — raw plus a normalized copy, which is what a conventional pipeline
   actually stores;
2. versus **ZSTD-compressed raw alone** — the harder, honest comparison. ClickHouse already
   compresses raw text very well on its own, so comparing only against uncompressed raw would
   overstate the benefit.

| Representation | Compressed bytes | Ratio vs Aletheia |
|---|---|---|
| Aletheia (`events`) | *(pending)* | 1.00× |
| Baseline: raw + normalized JSON | *(pending)* | *(pending)* |
| Compressed raw only | *(pending)* | *(pending)* |

## 3. Verified rate

Share of events stored as **verified template** mode (reconstructed and hash-matched), per source.

| Source | Events | Verified template | `partial` | `raw_only` |
|---|---|---|---|---|
| Cisco ASA | *(pending)* | | | |
| FortiGate | *(pending)* | | | |
| pfSense filterlog | *(pending)* | | | |
| CEF | *(pending)* | | | |
| LEEF | *(pending)* | | | |
| Squid | *(pending)* | | | |
| OpenVPN | *(pending)* | | | |
| Suricata EVE | *(pending)* | | | |

## 4. Zero loss

**Method.** Compare the count of messages emitted by the generator against rows stored.
**Pass condition: exactly equal.** Not "approximately" — requirement (a) admits no tolerance.

| Generated | Stored | Equal? |
|---|---|---|
| *(pending)* | *(pending)* | |

## 5. Integrity detection

**Method.** Flip one byte of one event's stored `vars` directly in ClickHouse via a synchronous
`ALTER TABLE … UPDATE`, bypassing Aletheia entirely — exactly what an attacker with database access
would do. Then run `aletheia verify`.

**Pass condition:** verify fails and names the exact Merkle batch *and* the exact event.

| | |
|---|---|
| Detected | *(pending)* |
| Batch identified | *(pending)* |
| Event identified | *(pending)* |
| Time to detect | *(pending)* |

## 6. Onboarding effort

**Method.** Measure wall-clock time from the first sample of an unknown source to `full` normalized
events via the Studio. Compare against the measured time for the same engineer to hand-write an
equivalent grok/regex parser for the same source.

| Source | Via Studio | Hand-written | Reduction |
|---|---|---|---|
| ASA drift variant | *(pending)* | *(pending)* | |

## 7. Drift detection latency

Time from the first changed-format line to the quarantine alert.

| | |
|---|---|
| Latency | *(pending)* |

## 8. Replay diff speed

Time to diff N events between two pack versions.

| N | Time |
|---|---|
| 5,000 | *(pending)* |
| 50,000 | *(pending)* |

---

## Interpreting these results honestly

- Throughput measured inside a single container understates a production deployment, and is
  reported as such.
- The storage ratio that matters for a sceptical reader is **row 3** of section 2 (versus compressed
  raw alone), not row 2.
- A high verified rate on generated corpora is expected; the meaningful test is the verified rate on
  the evaluator's **own** logs (Demo Console scenario 10).
- Reconstruction proves no loss. It does **not** prove that a mapping put a value in the right OCSF
  field — that is what golden tests, replay diff and human review cover.
