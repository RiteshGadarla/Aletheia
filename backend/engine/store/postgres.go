package store

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Ritesh2006M/aletheia/merkle"
	"github.com/Ritesh2006M/aletheia/registry"
)

// SealedBatch mirrors one row of the merkle_batches table.
type SealedBatch struct {
	SourceID    string
	Partition   int32
	Minute      time.Time
	LeafCount   int
	Root        []byte
	ChainedRoot []byte
	SealedAt    time.Time
}

// Key rebuilds the Merkle batch key.
func (b SealedBatch) Key() merkle.Key {
	return merkle.Key{SourceID: b.SourceID, Partition: b.Partition, Minute: b.Minute.UTC()}
}

// OpenPG opens a pooled PostgreSQL connection.
func OpenPG(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

// Batches reads the sealed batches of a source in [from, to), chain order.
func Batches(ctx context.Context, pool *pgxpool.Pool, source string, from, to time.Time) ([]SealedBatch, error) {
	rows, err := pool.Query(ctx, `SELECT source_id, partition, minute, leaf_count, root, chained_root, sealed_at
		FROM merkle_batches WHERE source_id = $1 AND minute >= $2 AND minute < $3
		ORDER BY partition, minute`, source, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SealedBatch
	for rows.Next() {
		var b SealedBatch
		if err := rows.Scan(&b.SourceID, &b.Partition, &b.Minute, &b.LeafCount,
			&b.Root, &b.ChainedRoot, &b.SealedAt); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// PrevChained returns the chained root immediately before minute on a
// (source, partition) chain. Absent means the chain starts at zero.
func PrevChained(ctx context.Context, pool *pgxpool.Pool, source string, partition int32,
	minute time.Time) ([32]byte, bool, error) {

	var b []byte
	err := pool.QueryRow(ctx, `SELECT chained_root FROM merkle_batches
		WHERE source_id = $1 AND partition = $2 AND minute < $3
		ORDER BY minute DESC LIMIT 1`, source, partition, minute).Scan(&b)
	var out [32]byte
	if err != nil {
		return out, false, nil // no row, or unreadable: treat as chain start
	}
	if len(b) != 32 {
		return out, false, nil
	}
	copy(out[:], b)
	return out, true, nil
}

// UpsertBatch records a sealed batch. Re-sealing the same minute is idempotent.
func UpsertBatch(ctx context.Context, pool *pgxpool.Pool, b SealedBatch) error {
	_, err := pool.Exec(ctx, `INSERT INTO merkle_batches
		(source_id, partition, minute, leaf_count, root, chained_root, sealed_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (source_id, partition, minute) DO UPDATE
		SET leaf_count = EXCLUDED.leaf_count, root = EXCLUDED.root,
		    chained_root = EXCLUDED.chained_root, sealed_at = EXCLUDED.sealed_at`,
		b.SourceID, b.Partition, b.Minute, b.LeafCount, b.Root, b.ChainedRoot, b.SealedAt)
	return err
}

// LatestChained returns the newest chained root per (source_id, partition), so
// a restarting sealer resumes the chain instead of restarting it.
func LatestChained(ctx context.Context, pool *pgxpool.Pool) (map[string][32]byte, error) {
	rows, err := pool.Query(ctx, `SELECT DISTINCT ON (source_id, partition)
		source_id, partition, chained_root FROM merkle_batches
		ORDER BY source_id, partition, minute DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][32]byte{}
	for rows.Next() {
		var src string
		var part int32
		var b []byte
		if err := rows.Scan(&src, &part, &b); err != nil {
			return nil, err
		}
		if len(b) != 32 {
			continue
		}
		var h [32]byte
		copy(h[:], b)
		out[ChainKey(src, part)] = h
	}
	return out, rows.Err()
}

// ChainKey is the map key for a (source_id, partition) hash chain.
func ChainKey(source string, partition int32) string {
	return source + "\x00" + itoa(partition)
}

func itoa(n int32) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [12]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

// PacksAtVersion loads every approved pack YAML at a given version. Replay uses
// it so both sides of a diff run the exact bytes that were reviewed.
func PacksAtVersion(ctx context.Context, pool *pgxpool.Pool, version uint32) ([]*registry.Pack, error) {
	rows, err := pool.Query(ctx, `SELECT pack, yaml FROM packs WHERE version = $1 ORDER BY pack`, int64(version))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*registry.Pack
	for rows.Next() {
		var name, body string
		if err := rows.Scan(&name, &body); err != nil {
			return nil, err
		}
		p, err := registry.ParsePack([]byte(body), "pg:"+name)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
