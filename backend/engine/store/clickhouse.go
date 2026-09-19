// Package store holds the read-side queries the CLI needs: stored events from
// ClickHouse and sealed Merkle batches and pack versions from PostgreSQL.
package store

import (
	"context"
	"fmt"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
)

// Event is one stored row, enough to rebuild and re-verify it.
type Event struct {
	EventUID    string
	RecvTime    time.Time
	EventTime   time.Time
	SourceID    string
	EnvelopeID  string
	TemplateID  string
	PackVersion uint32
	StorageMode string
	ParseStatus string
	Vars        []string
	RawVerbatim *string
	RawSHA256   string // 32 raw bytes as a Go string (FixedString(32))
	MerkleBatch string
}

const eventCols = `event_uid, recv_time, event_time, source_id, envelope_id, template_id,
	pack_version, storage_mode, parse_status, vars, raw_verbatim, raw_sha256, merkle_batch`

// QueryRange reads a source's events in [from, to) in storage order.
func QueryRange(ctx context.Context, conn driver.Conn, db, source string,
	from, to time.Time, limit int) ([]Event, error) {

	q := fmt.Sprintf(`SELECT %s FROM %s.events
		WHERE source_id = ? AND recv_time >= ? AND recv_time < ?
		ORDER BY recv_time, event_uid`, eventCols, db)
	if limit > 0 {
		q += fmt.Sprintf(" LIMIT %d", limit)
	}
	rows, err := conn.Query(ctx, q, source, from, to)
	if err != nil {
		return nil, err
	}
	return scan(rows)
}

// QueryLast reads the most recent n events of a source, oldest first.
func QueryLast(ctx context.Context, conn driver.Conn, db, source string, n int) ([]Event, error) {
	if n <= 0 {
		n = 1000
	}
	q := fmt.Sprintf(`SELECT %s FROM %s.events
		WHERE source_id = ? ORDER BY recv_time DESC, event_uid DESC LIMIT %d`, eventCols, db, n)
	rows, err := conn.Query(ctx, q, source)
	if err != nil {
		return nil, err
	}
	out, err := scan(rows)
	if err != nil {
		return nil, err
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out, nil
}

func scan(rows driver.Rows) ([]Event, error) {
	defer rows.Close()
	var out []Event
	for rows.Next() {
		var e Event
		if err := rows.Scan(&e.EventUID, &e.RecvTime, &e.EventTime, &e.SourceID,
			&e.EnvelopeID, &e.TemplateID, &e.PackVersion, &e.StorageMode, &e.ParseStatus,
			&e.Vars, &e.RawVerbatim, &e.RawSHA256, &e.MerkleBatch); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
