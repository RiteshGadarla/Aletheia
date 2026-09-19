-- Aletheia metadata. Frozen contract (spec §7.6 + settings table, CONTRACTS §9).
CREATE TABLE IF NOT EXISTS sources (
  source_id   TEXT PRIMARY KEY,
  peers       TEXT[]      NOT NULL DEFAULT '{}',
  listener    TEXT,
  vendor      TEXT        NOT NULL,
  product     TEXT        NOT NULL,
  device_type TEXT        NOT NULL,
  timezone    TEXT        NOT NULL DEFAULT 'UTC',
  enabled     BOOLEAN     NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS packs (
  pack                 TEXT    NOT NULL,
  version              INTEGER NOT NULL,
  status               TEXT    NOT NULL CHECK (status IN ('proposed','approved','retired')),
  yaml                 TEXT    NOT NULL,
  checksum             TEXT    NOT NULL,
  author               TEXT,
  approver             TEXT,
  approved_at          TIMESTAMPTZ,
  replay_report_sha256 TEXT,
  origin               TEXT    NOT NULL DEFAULT 'heuristic',  -- heuristic | ai:<provider>/<model>
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pack, version)
);

CREATE TABLE IF NOT EXISTS merkle_batches (
  source_id    TEXT        NOT NULL,
  partition    INTEGER     NOT NULL,
  minute       TIMESTAMPTZ NOT NULL,
  leaf_count   INTEGER     NOT NULL,
  root         BYTEA       NOT NULL,
  chained_root BYTEA       NOT NULL,
  sealed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, partition, minute)
);

CREATE TABLE IF NOT EXISTS anchors (
  date         DATE  NOT NULL,
  source_id    TEXT  NOT NULL,
  chained_root BYTEA NOT NULL,
  signature    BYTEA,
  PRIMARY KEY (date, source_id)
);

-- Append-only. Every approval, retirement, config change and verify run.
CREATE TABLE IF NOT EXISTS audit_log (
  id       BIGSERIAL PRIMARY KEY,
  at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor    TEXT        NOT NULL,
  action   TEXT        NOT NULL,
  subject  TEXT,
  detail   JSONB       NOT NULL DEFAULT '{}'::jsonb
);

-- Runtime config set from the UI. Overrides env vars (CONTRACTS §9).
-- Encrypted values are AES-GCM sealed with a key derived from ALETHEIA_SECRET.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT        NOT NULL,
  encrypted  BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
