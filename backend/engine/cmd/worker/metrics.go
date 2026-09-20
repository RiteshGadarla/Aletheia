package main

import (
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// buckets for aletheia_insert_latency_seconds, in seconds.
var buckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30}

// srcStat is the per-source counter set behind the spec §16 metrics.
type srcStat struct {
	byStatus   map[string]uint64
	total      uint64
	verified   uint64
	quarantine uint64
}

// Metrics is the spec §16 metric set. Hand-rolled Prometheus text exposition:
// the engine takes no dependency it cannot vendor into an air-gapped image.
type Metrics struct {
	mu sync.Mutex

	sources map[string]*srcStat
	lag     map[int32]int64

	mismatch  uint64
	templates int
	packs     int
	reloads   uint64
	sealed    uint64
	sealFail  uint64
	sealDelay float64

	insertCount   uint64
	insertSum     float64
	insertBuckets []uint64
	insertErrors  uint64

	busErrors uint64
	rows      uint64
	commits   uint64
	commitErr uint64

	start time.Time
}

// NewMetrics returns an empty metric set.
func NewMetrics() *Metrics {
	return &Metrics{
		sources:       map[string]*srcStat{},
		lag:           map[int32]int64{},
		insertBuckets: make([]uint64, len(buckets)),
		start:         time.Now(),
	}
}

func (m *Metrics) src(id string) *srcStat {
	s, ok := m.sources[id]
	if !ok {
		s = &srcStat{byStatus: map[string]uint64{}}
		m.sources[id] = s
	}
	return s
}

// Event records one processed event.
func (m *Metrics) Event(source, status string, verified, quarantined, mismatch bool) {
	m.mu.Lock()
	s := m.src(source)
	s.byStatus[status]++
	s.total++
	if verified {
		s.verified++
	}
	if quarantined {
		s.quarantine++
	}
	if mismatch {
		m.mismatch++
	}
	m.mu.Unlock()
}

// Lag records the backlog of one partition.
func (m *Metrics) Lag(partition int32, lag int64) {
	if lag < 0 {
		lag = 0
	}
	m.mu.Lock()
	m.lag[partition] = lag
	m.mu.Unlock()
}

// Insert records one ClickHouse batch insert.
func (m *Metrics) Insert(d time.Duration, rows int, err error) {
	sec := d.Seconds()
	m.mu.Lock()
	m.insertCount++
	m.insertSum += sec
	for i, b := range buckets {
		if sec <= b {
			m.insertBuckets[i]++
		}
	}
	if err != nil {
		m.insertErrors++
	} else {
		m.rows += uint64(rows)
	}
	m.mu.Unlock()
}

// Commit records an offset commit attempt.
func (m *Metrics) Commit(err error) {
	m.mu.Lock()
	if err != nil {
		m.commitErr++
	} else {
		m.commits++
	}
	m.mu.Unlock()
}

// Index records the size of the live matcher index after a (re)load.
func (m *Metrics) Index(templates, packs int, reload bool) {
	m.mu.Lock()
	m.templates, m.packs = templates, packs
	if reload {
		m.reloads++
	}
	m.mu.Unlock()
}

// Sealed records a Merkle batch sealed and persisted, with its seal delay.
func (m *Metrics) Sealed(n int, delay time.Duration) {
	m.mu.Lock()
	m.sealed += uint64(n)
	if d := delay.Seconds(); d > 0 {
		m.sealDelay = d
	}
	m.mu.Unlock()
}

// SealFailed records a batch that could not be persisted and will be retried.
func (m *Metrics) SealFailed() {
	m.mu.Lock()
	m.sealFail++
	m.mu.Unlock()
}

// BusError records a failed publish.
func (m *Metrics) BusError(n int64) {
	m.mu.Lock()
	m.busErrors = uint64(n)
	m.mu.Unlock()
}

// Mismatches reports the reconstruct mismatch count, which must stay zero.
func (m *Metrics) Mismatches() uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.mismatch
}

// Write renders the Prometheus text exposition format.
func (m *Metrics) Write(w io.Writer) {
	m.mu.Lock()
	defer m.mu.Unlock()

	ids := make([]string, 0, len(m.sources))
	for id := range m.sources {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	fmt.Fprint(w, "# HELP aletheia_events_total Events processed by parse status.\n# TYPE aletheia_events_total counter\n")
	for _, id := range ids {
		s := m.sources[id]
		sts := make([]string, 0, len(s.byStatus))
		for st := range s.byStatus {
			sts = append(sts, st)
		}
		sort.Strings(sts)
		for _, st := range sts {
			fmt.Fprintf(w, "aletheia_events_total{source=\"%s\",status=\"%s\"} %d\n", esc(id), esc(st), s.byStatus[st])
		}
	}

	fmt.Fprint(w, "# HELP aletheia_verified_ratio Share of events stored in verified template mode.\n# TYPE aletheia_verified_ratio gauge\n")
	for _, id := range ids {
		s := m.sources[id]
		r := 0.0
		if s.total > 0 {
			r = float64(s.verified) / float64(s.total)
		}
		fmt.Fprintf(w, "aletheia_verified_ratio{source=\"%s\"} %s\n", esc(id), f(r))
	}

	fmt.Fprint(w, "# HELP aletheia_quarantine_total Unmatched events, the drift signal.\n# TYPE aletheia_quarantine_total counter\n")
	for _, id := range ids {
		fmt.Fprintf(w, "aletheia_quarantine_total{source=\"%s\"} %d\n", esc(id), m.sources[id].quarantine)
	}

	fmt.Fprint(w, "# HELP aletheia_reconstruct_mismatch_total Reconstruction failures. Must stay at zero.\n# TYPE aletheia_reconstruct_mismatch_total counter\n")
	fmt.Fprintf(w, "aletheia_reconstruct_mismatch_total %d\n", m.mismatch)

	parts := make([]int, 0, len(m.lag))
	for p := range m.lag {
		parts = append(parts, int(p))
	}
	sort.Ints(parts)
	fmt.Fprint(w, "# HELP aletheia_consumer_lag Backlog per partition, the primary scaling alert.\n# TYPE aletheia_consumer_lag gauge\n")
	for _, p := range parts {
		fmt.Fprintf(w, "aletheia_consumer_lag{partition=\"%d\"} %d\n", p, m.lag[int32(p)])
	}

	fmt.Fprint(w, "# HELP aletheia_insert_latency_seconds ClickHouse batch insert time.\n# TYPE aletheia_insert_latency_seconds histogram\n")
	for i, b := range buckets {
		fmt.Fprintf(w, "aletheia_insert_latency_seconds_bucket{le=\"%s\"} %d\n", strconv.FormatFloat(b, 'g', -1, 64), m.insertBuckets[i])
	}
	fmt.Fprintf(w, "aletheia_insert_latency_seconds_bucket{le=\"+Inf\"} %d\n", m.insertCount)
	fmt.Fprintf(w, "aletheia_insert_latency_seconds_sum %s\n", f(m.insertSum))
	fmt.Fprintf(w, "aletheia_insert_latency_seconds_count %d\n", m.insertCount)

	fmt.Fprint(w, "# HELP aletheia_templates Live template count; explosion alert.\n# TYPE aletheia_templates gauge\n")
	// The index is global, not per source: one scope label keeps the name honest.
	fmt.Fprintf(w, "aletheia_templates{source=\"_all\"} %d\n", m.templates)

	fmt.Fprint(w, "# HELP aletheia_merkle_sealed_total Merkle batches sealed and persisted.\n# TYPE aletheia_merkle_sealed_total counter\n")
	fmt.Fprintf(w, "aletheia_merkle_sealed_total %d\n", m.sealed)
	fmt.Fprint(w, "# HELP aletheia_merkle_seal_delay_seconds Age of the last sealed batch when it was sealed.\n# TYPE aletheia_merkle_seal_delay_seconds gauge\n")
	fmt.Fprintf(w, "aletheia_merkle_seal_delay_seconds %s\n", f(m.sealDelay))
	fmt.Fprint(w, "# HELP aletheia_merkle_seal_failures_total Batches awaiting a PostgreSQL retry.\n# TYPE aletheia_merkle_seal_failures_total counter\n")
	fmt.Fprintf(w, "aletheia_merkle_seal_failures_total %d\n", m.sealFail)

	fmt.Fprint(w, "# HELP aletheia_rows_inserted_total Rows written to ClickHouse.\n# TYPE aletheia_rows_inserted_total counter\n")
	fmt.Fprintf(w, "aletheia_rows_inserted_total %d\n", m.rows)
	fmt.Fprint(w, "# HELP aletheia_insert_errors_total Failed batch inserts; offsets stay uncommitted.\n# TYPE aletheia_insert_errors_total counter\n")
	fmt.Fprintf(w, "aletheia_insert_errors_total %d\n", m.insertErrors)
	fmt.Fprint(w, "# HELP aletheia_offset_commits_total Offset commits after a successful insert.\n# TYPE aletheia_offset_commits_total counter\n")
	fmt.Fprintf(w, "aletheia_offset_commits_total %d\n", m.commits)
	fmt.Fprint(w, "# HELP aletheia_offset_commit_errors_total Failed offset commits.\n# TYPE aletheia_offset_commit_errors_total counter\n")
	fmt.Fprintf(w, "aletheia_offset_commit_errors_total %d\n", m.commitErr)
	fmt.Fprint(w, "# HELP aletheia_bus_publish_errors_total Failed publishes to normalized/quarantine/dlq.\n# TYPE aletheia_bus_publish_errors_total counter\n")
	fmt.Fprintf(w, "aletheia_bus_publish_errors_total %d\n", m.busErrors)
	fmt.Fprint(w, "# HELP aletheia_packs Loaded parser packs.\n# TYPE aletheia_packs gauge\n")
	fmt.Fprintf(w, "aletheia_packs %d\n", m.packs)
	fmt.Fprint(w, "# HELP aletheia_index_reloads_total Hot reloads applied from the control topic.\n# TYPE aletheia_index_reloads_total counter\n")
	fmt.Fprintf(w, "aletheia_index_reloads_total %d\n", m.reloads)
	fmt.Fprint(w, "# HELP aletheia_uptime_seconds Worker uptime.\n# TYPE aletheia_uptime_seconds gauge\n")
	fmt.Fprintf(w, "aletheia_uptime_seconds %s\n", f(time.Since(m.start).Seconds()))
}

func f(v float64) string { return strconv.FormatFloat(v, 'g', -1, 64) }

// esc escapes a Prometheus label value.
func esc(s string) string {
	if !strings.ContainsAny(s, `\"`+"\n") {
		return s
	}
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)
	return r.Replace(s)
}

// serveMetrics starts the /metrics and /healthz endpoints.
func serveMetrics(addr string, m *Metrics) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		m.Write(w)
	})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "ok\n")
	})
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logf("metrics: %v", err)
		}
	}()
	return srv
}
