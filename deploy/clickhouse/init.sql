-- Aletheia system of record. Frozen contract (spec §7.5) — do not rename columns.
--
-- Codec choices are measured, not guessed: see docs/benchmarks.md §4. Two rules drive them.
-- (1) Anything ZSTD cannot model is told not to try — raw_sha256 is a hash, so compressing it
--     burns CPU and *grows* the column. (2) Everything text-shaped gets ZSTD(9) rather than the
--     LZ4 default, which is where nearly all of the 20.9% saving comes from.
CREATE DATABASE IF NOT EXISTS aletheia;

CREATE TABLE IF NOT EXISTS aletheia.templates (
  template_id   LowCardinality(String),
  pack          LowCardinality(String),
  pack_version  UInt32,
  tokens        String CODEC(ZSTD(9)),      -- JSON token list
  created_at    DateTime64(3)
) ENGINE = ReplacingMergeTree
ORDER BY (template_id, pack_version);

CREATE TABLE IF NOT EXISTS aletheia.events (
  -- ULIDs share a monotonic 48-bit time prefix and the sort key keeps them adjacent, so ZSTD
  -- models the run; LZ4's short window could not and cost 5.76 bytes/event more.
  event_uid        FixedString(26)   CODEC(ZSTD(3)),
  recv_time        DateTime64(3)     CODEC(DoubleDelta, ZSTD(1)),
  event_time       DateTime64(3)     CODEC(DoubleDelta, ZSTD(1)),
  source_id        LowCardinality(String),
  envelope_id      LowCardinality(String),
  template_id      LowCardinality(String),
  pack_version     UInt32            CODEC(T64, ZSTD(1)),
  storage_mode     Enum8('template' = 1, 'verbatim' = 2),
  parse_status     Enum8('full' = 1, 'partial' = 2, 'raw_only' = 3),
  vars             Array(String)     CODEC(ZSTD(9)),
  raw_verbatim     Nullable(String)  CODEC(ZSTD(9)),
  -- SHA-256 output is indistinguishable from random: ZSTD(3) returned 1.004x *expansion* here.
  -- NONE is the honest codec. This column is the single largest line item in the table and
  -- cannot be made smaller without weakening the tamper-evidence guarantee.
  raw_sha256       FixedString(32)   CODEC(NONE),
  class_uid        UInt16            CODEC(T64, ZSTD(1)),
  activity_id      UInt8             CODEC(ZSTD(1)),
  severity_id      UInt8             CODEC(ZSTD(1)),
  src_ip           Nullable(IPv6)    CODEC(ZSTD(3)),
  src_port         Nullable(UInt16)  CODEC(T64, ZSTD(1)),
  dst_ip           Nullable(IPv6)    CODEC(ZSTD(3)),
  dst_port         Nullable(UInt16)  CODEC(T64, ZSTD(1)),
  protocol         LowCardinality(String),
  action_id        UInt8             CODEC(ZSTD(1)),
  user_name        Nullable(String)  CODEC(ZSTD(9)),
  unmapped         String            CODEC(ZSTD(9)),
  ocsf_extra       String            CODEC(ZSTD(9)),
  merkle_batch     String            CODEC(ZSTD(9))
) ENGINE = ReplacingMergeTree(pack_version)
PARTITION BY toYYYYMMDD(recv_time)
ORDER BY (source_id, recv_time, event_uid);

-- Exists only so the storage benchmark has an honest baseline to compare against. It therefore
-- gets *exactly* the codec treatment `events` gets — tuning one side only would manufacture the
-- result. What it deliberately does not get is a per-event hash, because a conventional
-- raw + normalized-JSON store has none; that asymmetry is the measurement, not a flaw in it.
CREATE TABLE IF NOT EXISTS aletheia.baseline_events (
  event_uid   FixedString(26)  CODEC(ZSTD(3)),
  recv_time   DateTime64(3)    CODEC(DoubleDelta, ZSTD(1)),
  source_id   LowCardinality(String),
  raw         String CODEC(ZSTD(9)),
  normalized  String CODEC(ZSTD(9))
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(recv_time)
ORDER BY (source_id, recv_time, event_uid);
