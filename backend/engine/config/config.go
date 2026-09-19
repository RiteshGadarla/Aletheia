// Package config loads runtime settings from ALETHEIA_* environment variables.
// Stdlib only: the CLI, the worker and the sealer all share it.
package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

// Roles the worker binary can run as.
const (
	RoleWorker = "worker"
	RoleSealer = "sealer"
)

// Bus topic defaults (CONTRACTS §3).
const (
	DefaultTopicRaw        = "raw"
	DefaultTopicNormalized = "normalized"
	DefaultTopicQuarantine = "quarantine"
	DefaultTopicControl    = "control"
	DefaultTopicDLQ        = "dlq"
)

// Kafka headers carried on `raw` messages (CONTRACTS §3).
const (
	HeaderRecvMS   = "pr_recv_ms"
	HeaderPeer     = "pr_peer"
	HeaderListener = "pr_listener"
	HeaderSourceID = "pr_source_id"
)

// Config is the fully resolved engine configuration.
type Config struct {
	Role     string
	WorkerID string

	Brokers       []string
	ConsumerGroup string
	TopicRaw      string
	TopicNorm     string
	TopicQuar     string
	TopicControl  string
	TopicDLQ      string

	ClickHouseAddr []string
	ClickHouseDB   string
	ClickHouseUser string
	ClickHousePass string

	PostgresDSN string

	PacksDir     string
	EnvelopeFile string
	OCSFDir      string
	SourcesFile  string

	BatchRows     int
	BatchInterval time.Duration

	Workers     int
	MetricsAddr string

	SealGrace    time.Duration
	SealInWorker bool
}

// Load reads the environment and applies defaults. It never fails; callers
// validate what they actually need.
func Load() *Config {
	c := &Config{
		Role:     str("ALETHEIA_ROLE", RoleWorker),
		WorkerID: str("ALETHEIA_WORKER_ID", hostOr("w1")),

		Brokers:       list("ALETHEIA_BUS_BROKERS", "127.0.0.1:9092"),
		ConsumerGroup: str("ALETHEIA_CONSUMER_GROUP", "aletheia-workers"),
		TopicRaw:      str("ALETHEIA_TOPIC_RAW", DefaultTopicRaw),
		TopicNorm:     str("ALETHEIA_TOPIC_NORMALIZED", DefaultTopicNormalized),
		TopicQuar:     str("ALETHEIA_TOPIC_QUARANTINE", DefaultTopicQuarantine),
		TopicControl:  str("ALETHEIA_TOPIC_CONTROL", DefaultTopicControl),
		TopicDLQ:      str("ALETHEIA_TOPIC_DLQ", DefaultTopicDLQ),

		ClickHouseAddr: list("ALETHEIA_CLICKHOUSE_ADDR", "127.0.0.1:9000"),
		ClickHouseDB:   str("ALETHEIA_CLICKHOUSE_DB", "aletheia"),
		ClickHouseUser: str("ALETHEIA_CLICKHOUSE_USER", "default"),
		ClickHousePass: str("ALETHEIA_CLICKHOUSE_PASSWORD", ""),

		PostgresDSN: firstNonEmpty(
			os.Getenv("ALETHEIA_PG_DSN"),
			os.Getenv("ALETHEIA_POSTGRES_DSN"),
			os.Getenv("DATABASE_URL"),
		),

		PacksDir:    str("ALETHEIA_PACKS_DIR", "/packs"),
		OCSFDir:     str("ALETHEIA_OCSF_DIR", "/ocsf"),
		SourcesFile: os.Getenv("ALETHEIA_SOURCES_FILE"),

		BatchRows:     num("ALETHEIA_BATCH_ROWS", 10000),
		BatchInterval: dur("ALETHEIA_BATCH_INTERVAL", time.Second),

		Workers:     num("ALETHEIA_WORKERS", 2),
		MetricsAddr: str("ALETHEIA_METRICS_ADDR", ":9108"),

		SealGrace:    dur("ALETHEIA_SEAL_GRACE", 2*time.Minute),
		SealInWorker: boolean("ALETHEIA_SEAL_IN_WORKER", false),
	}
	c.EnvelopeFile = str("ALETHEIA_ENVELOPES_FILE", c.PacksDir+"/_envelopes.yaml")
	if c.SourcesFile == "" {
		c.SourcesFile = c.PacksDir + "/_sources.yaml"
	}
	return c
}

// EnumsFile is the path to the shared OCSF enum table.
func (c *Config) EnumsFile() string { return c.OCSFDir + "/enums.yaml" }

func str(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func list(k, def string) []string {
	v := str(k, def)
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func num(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil && n > 0 {
			return n
		}
	}
	return def
}

func dur(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if d, err := time.ParseDuration(strings.TrimSpace(v)); err == nil && d > 0 {
			return d
		}
	}
	return def
}

func boolean(k string, def bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(k)))
	switch v {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return def
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func hostOr(def string) string {
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return def
}
