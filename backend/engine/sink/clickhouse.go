// Package sink writes normalized events to ClickHouse in batches and publishes
// copies onto the bus. Spec §11.1, §12.3: offsets commit only after a
// successful insert, so a flush carries the marks of the rows it contains.
package sink

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"

	"github.com/Ritesh2006M/aletheia/normalize"
	"github.com/Ritesh2006M/aletheia/registry"
)

// insertSQL lists the `events` columns in deploy/clickhouse/init.sql order.
const insertSQL = `INSERT INTO %s.events (
	event_uid, recv_time, event_time, source_id, envelope_id, template_id, pack_version,
	storage_mode, parse_status, vars, raw_verbatim, raw_sha256,
	class_uid, activity_id, severity_id,
	src_ip, src_port, dst_ip, dst_port, protocol, action_id, user_name,
	unmapped, ocsf_extra, merkle_batch)`

const templateSQL = `INSERT INTO %s.templates (template_id, pack, pack_version, tokens, created_at)`

// Options configures a Batcher.
type Options struct {
	Addr     []string
	Database string
	User     string
	Password string

	// MaxRows and Interval are the flush triggers: whichever fires first.
	MaxRows  int
	Interval time.Duration

	// OnFlush runs after every insert attempt, with the marks of the rows that
	// were in the batch. The worker commits Kafka offsets here, and only here.
	OnFlush func(marks []any, rows int, took time.Duration, err error)
}

// Batcher accumulates rows and inserts them in bulk.
type Batcher struct {
	conn driver.Conn
	opt  Options
	db   string

	mu    sync.Mutex
	rows  []normalize.Row
	marks []any

	stop chan struct{}
	done chan struct{}
	once sync.Once
}

// Connect opens a ClickHouse native connection.
func Connect(ctx context.Context, o Options) (driver.Conn, error) {
	conn, err := clickhouse.Open(&clickhouse.Options{
		Addr: o.Addr,
		Auth: clickhouse.Auth{Database: o.Database, Username: o.User, Password: o.Password},
		Compression: &clickhouse.Compression{
			Method: clickhouse.CompressionLZ4,
		},
		DialTimeout:     10 * time.Second,
		MaxOpenConns:    8,
		MaxIdleConns:    4,
		ConnMaxLifetime: time.Hour,
	})
	if err != nil {
		return nil, err
	}
	if err := conn.Ping(ctx); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("clickhouse ping: %w", err)
	}
	return conn, nil
}

// NewBatcher connects and starts the interval flusher.
func NewBatcher(ctx context.Context, o Options) (*Batcher, error) {
	if o.MaxRows <= 0 {
		o.MaxRows = 10000
	}
	if o.Interval <= 0 {
		o.Interval = time.Second
	}
	if o.Database == "" {
		o.Database = "aletheia"
	}
	conn, err := Connect(ctx, o)
	if err != nil {
		return nil, err
	}
	b := &Batcher{conn: conn, opt: o, db: o.Database,
		rows: make([]normalize.Row, 0, o.MaxRows), marks: make([]any, 0, o.MaxRows),
		stop: make(chan struct{}), done: make(chan struct{})}
	go b.loop()
	return b, nil
}

// Conn exposes the underlying connection for readers (verify, replay, bench).
func (b *Batcher) Conn() driver.Conn { return b.conn }

func (b *Batcher) loop() {
	defer close(b.done)
	t := time.NewTicker(b.opt.Interval)
	defer t.Stop()
	for {
		select {
		case <-b.stop:
			b.Flush()
			return
		case <-t.C:
			b.Flush()
		}
	}
}

// Add queues one row. mark is opaque to the sink; the worker passes the Kafka
// record so offsets can be committed once the insert succeeds.
func (b *Batcher) Add(r normalize.Row, mark any) {
	b.mu.Lock()
	b.rows = append(b.rows, r)
	b.marks = append(b.marks, mark)
	full := len(b.rows) >= b.opt.MaxRows
	b.mu.Unlock()
	if full {
		b.Flush()
	}
}

// Pending reports how many rows are waiting.
func (b *Batcher) Pending() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.rows)
}

// Flush inserts everything queued. It is safe to call concurrently.
func (b *Batcher) Flush() {
	b.mu.Lock()
	if len(b.rows) == 0 {
		b.mu.Unlock()
		return
	}
	rows, marks := b.rows, b.marks
	b.rows = make([]normalize.Row, 0, b.opt.MaxRows)
	b.marks = make([]any, 0, b.opt.MaxRows)
	b.mu.Unlock()

	start := time.Now()
	err := b.insert(rows)
	took := time.Since(start)
	if err != nil {
		// Nothing is ever dropped: put the rows back so the next flush retries,
		// and leave the offsets uncommitted so the bus replays if we die.
		b.mu.Lock()
		b.rows = append(rows, b.rows...)
		b.marks = append(marks, b.marks...)
		b.mu.Unlock()
	}
	if b.opt.OnFlush != nil {
		b.opt.OnFlush(marks, len(rows), took, err)
	}
}

func (b *Batcher) insert(rows []normalize.Row) error {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	batch, err := b.conn.PrepareBatch(ctx, fmt.Sprintf(insertSQL, b.db))
	if err != nil {
		return err
	}
	for i := range rows {
		if err := appendRow(batch, &rows[i]); err != nil {
			_ = batch.Abort()
			return err
		}
	}
	return batch.Send()
}

// appendRow binds one Row to the column order above.
func appendRow(batch driver.Batch, r *normalize.Row) error {
	vars := r.Vars
	if vars == nil {
		vars = []string{}
	}
	return batch.Append(
		r.EventUID,
		r.RecvTime,
		r.EventTime,
		r.SourceID,
		r.EnvelopeID,
		r.TemplateID,
		r.PackVersion,
		r.StorageMode,
		r.ParseStatus,
		vars,
		r.RawVerbatim,
		r.RawSHA256,
		r.ClassUID,
		r.ActivityID,
		r.SeverityID,
		ip6(r.SrcIP),
		r.SrcPort,
		ip6(r.DstIP),
		r.DstPort,
		r.Protocol,
		r.ActionID,
		r.UserName,
		jsonOr(r.Unmapped),
		jsonOr(r.OCSFExtra),
		r.MerkleBatch,
	)
}

// ip6 widens IPv4 to its IPv4-mapped IPv6 form, which is what an IPv6 column
// stores. A nil address stays NULL.
func ip6(p *net.IP) *net.IP {
	if p == nil || len(*p) == 0 {
		return nil
	}
	v := (*p).To16()
	if v == nil {
		return nil
	}
	return &v
}

func jsonOr(s string) string {
	if s == "" {
		return "{}"
	}
	return s
}

// InsertTemplates records the live template set so stored events can always be
// rebuilt with the exact version that produced them (spec §6.10).
func (b *Batcher) InsertTemplates(ctx context.Context, packs []*registry.Pack) error {
	batch, err := b.conn.PrepareBatch(ctx, fmt.Sprintf(templateSQL, b.db))
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	n := 0
	for _, p := range packs {
		for _, t := range p.Templates {
			toks, err := json.Marshal(t.Body)
			if err != nil {
				continue
			}
			if err := batch.Append(t.ID, p.Pack, p.Version, string(toks), now); err != nil {
				_ = batch.Abort()
				return err
			}
			n++
		}
	}
	if n == 0 {
		return batch.Abort()
	}
	return batch.Send()
}

// Close stops the flusher, drains and closes the connection.
func (b *Batcher) Close() error {
	var err error
	b.once.Do(func() {
		close(b.stop)
		<-b.done
		if b.Pending() > 0 {
			err = errors.New("clickhouse batcher closed with rows still pending")
		}
		_ = b.conn.Close()
	})
	return err
}
