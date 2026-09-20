# Aletheia — Benchmark methodology and results

> **Rule for this document: no unmeasured figures.** Every number below is produced by the harness
> in [`bench/`](../bench/) and recorded together with the machine specification it ran on. Cells
> marked *(pending)* have not been measured yet and must not be quoted until they are.

## How to reproduce

Throughput (section 1):

```bash
make engine && ./bin/aletheia bench --workers 1,2,4 --duration 60s --json
```

Storage (section 2) — one command, fully self-contained:

```bash
make services
bench/storage_bench.sh 120000      # ~35s end to end
```

It builds a throwaway `aletheia_bench` database from the real `deploy/clickhouse/init.sql`, so
the baseline can never drift into different codecs than `events`; fills both tables in a single
ingest pass, so their row counts cannot disagree; merges to Wide parts, without which ClickHouse
reports every per-column size as 0; and leaves the demo corpus in `aletheia` untouched.

Integrity and zero-loss (sections 4-5) are asserted end-to-end by `scripts/worker-smoke.sh`,
which drives the real worker over the bus and fails on any byte that does not rebuild.

Record the machine specification with every run: CPU model, physical core count, RAM, disk type,
and the memory/CPU allocated to Docker.

---

## Machine specification for the results below

Section 2 was measured on this machine. Every other section is still *(pending)*.

| | |
|---|---|
| CPU | 13th Gen Intel Core i7-1360P |
| Physical cores | 12 (4 P + 8 E), 16 threads |
| RAM | 15 GiB |
| Disk | NVMe SSD, ext4 |
| Docker allocation | host defaults (no explicit cgroup limits) |
| ClickHouse | 24.8.14.39 |
| Image tag / commit | `bf9738d` |

---

## 1. Throughput

**Reference targets.** 1 billion events/day = **11,574 eps** average. A 3x burst allowance =
**~35,000 eps**.

### 1a. Engine hot path, in memory — measured

`./bin/aletheia bench --workers 1,2,4,8 --duration 15s`. This is the parse → match →
reconstruct → verify → normalize loop with **no bus and no database**, so it is an upper bound on
the engine itself, not a pipeline figure. Run-to-run variance is roughly ±8% on an unpinned
laptop; the lower of two runs is reported.

| Workers | eps | eps per core | Verified | Reconstruct mismatches |
|---|---|---|---|---|
| 1 | 19,329 | 19,329 | 290,048 | **0** |
| 2 | 32,947 | 16,473 | 494,592 | **0** |
| 4 | 37,712 | 9,428 | 566,272 | **0** |
| 8 | 46,040 | 5,755 | 691,712 | **0** |

A single worker already clears the 11,574 eps average target, and four clear the 35,000 eps burst
allowance. Scaling is clearly sublinear — 8 workers give 2.4x the throughput of one, not 8x — on a
4 P-core + 8 E-core laptop where the corpus is only 30 distinct lines and stays in cache. Do not
quote eps-per-core from this table as a capacity-planning figure.

**Zero reconstruct mismatches across 2.04 million events** is the number that matters here.

### 1b. End-to-end sustained rate with lag — *(pending)*

The Method this section was written for — replay at an increasing rate until consumer lag grows,
and take the rate just below that — has **not** been run. It needs the bus, worker and ClickHouse
together under sustained load. `scripts/worker-smoke.sh` proves that path works correctly but
makes no throughput claim.

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

### Verdict: Aletheia does not save storage. It costs 1.52x the baseline, and the reason is the hash.

Measured on 120,000 generated events (ASA, FortiGate, CEF, LEEF), both tables loaded in one pass
of `bench/ingest.py` so the row counts match exactly, merged to Wide parts so ClickHouse reports
per-column sizes:

| Representation | Compressed | B/event | Ratio vs Aletheia |
|---|---|---|---|
| **Aletheia** (`events`: template + vars + OCSF + integrity) | 11.6 MiB | 100.98 | 1.00x |
| Baseline: raw + normalized JSON | 7.6 MiB | 66.63 | **0.660x** |
| Compressed raw only | 2.9 MiB | 25.12 | **0.249x** |

Aletheia is **1.52x larger** than raw + normalized JSON, and **4.02x larger** than ZSTD-compressed
raw alone. Any claim that this project reduces storage is false and must not be made.

### Where the 34.35 B/event difference goes

| | B/event |
|---|---|
| `raw_sha256` — the baseline carries no per-event hash at all | 32.00 |
| `merkle_batch` | 0.01 |
| **Integrity metadata subtotal** | **32.02** |
| Everything else (OCSF scalar columns vs one JSON blob) | 2.33 |
| **Total difference** | **34.35** |

**93% of the penalty is one column.** `raw_sha256` is a SHA-256 digest, so it is
indistinguishable from random and compresses at exactly **1.00x** — it is incompressible by
construction, not by poor configuration. Storing it is what makes byte-exact verification and the
Merkle chain possible; removing it would make the tamper-evidence claim unsupportable. It is
declared `CODEC(NONE)` because ZSTD(3) measurably *expanded* it (see
[`deploy/clickhouse/init.sql`](../deploy/clickhouse/init.sql)).

### The compression idea itself does work

Read past the integrity columns and the representation is a genuine, if modest, win:

| | B/event |
|---|---|
| `vars` — the variable parts, from which the line rebuilds **byte-for-byte** | 22.43 |
| `raw` — the baseline storing the same lines as text | 25.12 |

**10.7% smaller than the text it can reconstruct exactly**, because each template's literal
skeleton is stored once rather than once per event. That is the mechanism working as designed.
It is simply outweighed, three times over, by the 32 bytes of provenance layered on top.

### What to say instead

Aletheia trades storage for provenance: **~32 bytes per event buys byte-exact reconstruction and
a tamper-evident Merkle chain**, neither of which the baseline can offer at any size. Sell that
trade, not a compression win. On a corpus where templates repeat more heavily than this one, the
`vars`-vs-`raw` gap widens while the 32-byte hash stays fixed — so the ratio improves with scale,
but it does not cross 1.00x until the average line exceeds roughly 300 bytes.

<details><summary>Full per-column breakdown (reproduce with the command above)</summary>

`aletheia.events` — top columns by compressed size:

| Column | B/event | Share | Compression |
|---|---|---|---|
| `raw_sha256` | 32.00 | 31.7% | 1.00x |
| `vars` | 22.43 | 22.2% | 6.77x |
| `ocsf_extra` | 20.12 | 19.9% | 18.86x |
| `event_uid` | 11.22 | 11.1% | 2.32x |
| `unmapped` | 6.62 | 6.6% | 12.80x |

`aletheia.baseline_events`:

| Column | B/event | Share | Compression |
|---|---|---|---|
| `normalized` | 30.27 | 45.4% | 24.42x |
| `raw` | 25.12 | 37.7% | 10.16x |
| `event_uid` | 11.22 | 16.8% | 2.32x |

`event_uid` appears on both sides at an identical 11.22 B/event, so it is not part of the
difference. It compresses only 2.32x because a ULID is mostly random bits.

</details>

## 3. Verified rate

Share of events stored as **verified template** mode (reconstructed and hash-matched), per source.

Measured on the demo corpus after `make demo` (3,313 events), commit `bf9738d`:

| Source | Events | Verified template | `partial` | `raw_only` |
|---|---|---|---|---|
| Cisco ASA (`asa`) | 853 | 853 (100%) | 0 | 0 |
| ASA device `edge01` | 800 | 800 (100%) | 0 | 0 |
| ASA device `fw01` | 513 | 500 (97.5%) | 0 | **13** |
| FortiGate | 297 | 297 (100%) | 0 | 0 |
| CEF | 225 | 225 (100%) | 0 | 0 |
| LEEF | 211 | 211 (100%) | 0 | 0 |
| pfSense filterlog | 160 | 160 (100%) | 0 | 0 |
| OpenVPN | 80 | 80 (100%) | 0 | 0 |
| Squid | 40 | 40 (100%) | 0 | 0 |
| Suricata EVE | 40 | 40 (100%, `verbatim`) | 0 | 0 |
| unregistered (`unknown`) | 94 | 0 | 0 | **94** |
| **Total** | **3,313** | **3,166 (95.6%)** | **0** | **147** |

The two non-100% rows are the point, not noise:

- **`fw01`'s 13 `raw_only` events** are the firmware-drift variant from demo scenario 5 — an ASA
  message with an extra field that no frozen template matches. They are quarantined and stored
  **in full**, which is what makes the drift demo meaningful.
- **`unknown`'s 94** are lines from no registered source at all.

Neither was dropped. `raw_only` is the zero-loss guarantee doing its job, and every one of the
3,313 events still reconstructs byte-exactly (section 4).

Suricata is the only source stored `verbatim`, because its pack declares that mode — byte-exact
templating of arbitrary JSON is fragile (spec §9.7). It verifies through `aletheia verify`'s
verbatim branch rather than by reconstruction, so `rebuilt` is 0 and `verbatim` is 40 for it.

A 100% rate on generated corpora is expected and proves little on its own; the number that would
mean something is the rate on an evaluator's own logs (Demo Console scenario 10).

## 4. Zero loss

**Method.** Compare the count of messages emitted by the generator against rows stored.
**Pass condition: exactly equal.** Not "approximately" — requirement (a) admits no tolerance.

| Corpus | Generated | Stored | Dropped | Equal? |
|---|---|---|---|---|
| `bench/storage_bench.sh 120000` | 120,000 | 120,000 | 0 | **yes** |
| `scripts/worker-smoke.sh` (bus -> worker -> ClickHouse) | 12 | 12 | 0 | **yes** |
| demo corpus after `make demo` | 3,313 | 3,313 | 0 | **yes** |

All three paths agree, which matters because they are different code: the 120,000 went through
`bench/ingest.py`, the 12 went through the **real Go worker over Redpanda**, and the demo corpus
is a mix. Of the 3,313 demo events, 147 matched no template — those are stored `raw_only` in
full and counted as stored, because quarantine is not loss.

Replay is idempotent rather than duplicative: re-running the worker over a 1,345-record backlog
produced **0 new events**, because the ULID is derived from `(topic, partition, offset)` and the
ReplacingMergeTree collapses the redelivery. Row count rose to 4,026 before the merge and
returned to exactly 2,713 distinct events after `OPTIMIZE FINAL`.

## 5. Integrity detection

**Method.** Flip one byte of one event's stored `vars` directly in ClickHouse via a synchronous
`ALTER TABLE … UPDATE`, bypassing Aletheia entirely — exactly what an attacker with database access
would do. Then run `aletheia verify`.

**Pass condition:** verify fails and names the exact Merkle batch *and* the exact event.

Reproduce: `curl -X POST localhost:8081/api/v1/demo/scenarios/tamper/run`

| | |
|---|---|
| Detected | **yes** — `verify` exits 1, `ok:false` |
| Batch identified | **yes** — `asa/p0/2026-09-20T07:17Z`, *"leaf count differs: the stored events do not account for the sealed batch"* |
| Event identified | **yes** — `01M2YTV0RH6T5GETAM758Y6KHM`, *"hash mismatch: stored ce35f333…, recomputed 922fda40…"* |
| Time to detect | 0.27 s over 593 events in that source |
| Byte restored afterwards | yes — the scenario puts it back and re-verifies clean |

The scenario deliberately verifies **the source the tampered event actually belongs to**. An
earlier version picked an event with no source filter and then verified the busiest source
instead, so it tampered `asa`, checked `edge01`, and printed *"NOT DETECTED — investigate"* — an
accusation against the engine caused entirely by the harness. The engine was correct throughout.

Deleting events is caught by the same mechanism from the other direction: a batch whose sealed
leaf count no longer matches the surviving rows fails, which is how 12,379 rows removed behind
Aletheia's back were spotted.

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
  raw alone), not row 2. Both are unflattering: Aletheia is larger on every comparison, and the
  section says so in its own heading rather than burying it.
- Section 2 uses a generated corpus whose templates repeat more than real-world traffic would in
  some respects and less in others. It is reproducible and honest about what it measured; it is
  not a claim about the reader's logs.
- A high verified rate on generated corpora is expected; the meaningful test is the verified rate on
  the evaluator's **own** logs (Demo Console scenario 10).
- Reconstruction proves no loss. It does **not** prove that a mapping put a value in the right OCSF
  field — that is what golden tests, replay diff and human review cover.
