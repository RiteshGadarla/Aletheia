-- Aletheia system of record. Frozen contract (spec §7.5) — do not rename columns.
CREATE DATABASE IF NOT EXISTS aletheia;

CREATE TABLE IF NOT EXISTS aletheia.templates (
  template_id   LowCardinality(String),
  pack          LowCardinality(String),
  pack_version  UInt32,
  tokens        String,                      -- JSON token list
  created_at    DateTime64(3)
) ENGINE = ReplacingMergeTree
ORDER BY (template_id, pack_version);

CREATE TABLE IF NOT EXISTS aletheia.events (
  event_uid        FixedString(26),
  recv_time        DateTime64(3),
  event_time       DateTime64(3),
  source_id        LowCardinality(String),
  envelope_id      LowCardinality(String),
  template_id      LowCardinality(String),
  pack_version     UInt32,
  storage_mode     Enum8('template' = 1, 'verbatim' = 2),
  parse_status     Enum8('full' = 1, 'partial' = 2, 'raw_only' = 3),
  vars             Array(String)     CODEC(ZSTD(3)),
  raw_verbatim     Nullable(String)  CODEC(ZSTD(3)),
  raw_sha256       FixedString(32),
  class_uid        UInt16,
  activity_id      UInt8,
  severity_id      UInt8,
  src_ip           Nullable(IPv6),
  src_port         Nullable(UInt16),
  dst_ip           Nullable(IPv6),
  dst_port         Nullable(UInt16),
  protocol         LowCardinality(String),
  action_id        UInt8,
  user_name        Nullable(String),
  unmapped         String CODEC(ZSTD(3)),
  ocsf_extra       String CODEC(ZSTD(3)),
  merkle_batch     String
) ENGINE = ReplacingMergeTree(pack_version)
PARTITION BY toYYYYMMDD(recv_time)
ORDER BY (source_id, recv_time, event_uid);

-- Exists only so the storage benchmark has an honest baseline to compare against.
CREATE TABLE IF NOT EXISTS aletheia.baseline_events (
  event_uid   FixedString(26),
  recv_time   DateTime64(3),
  source_id   LowCardinality(String),
  raw         String CODEC(ZSTD(3)),
  normalized  String CODEC(ZSTD(3))
) ENGINE = MergeTree
PARTITION BY toYYYYMMDD(recv_time)
ORDER BY (source_id, recv_time, event_uid);
