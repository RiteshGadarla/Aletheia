package sink

import (
	"context"
	"sync/atomic"

	"github.com/twmb/franz-go/pkg/kgo"
)

// Publisher produces to the `normalized`, `quarantine` and `dlq` topics.
// Key is always source_id (CONTRACTS §3), so a source's events stay ordered.
type Publisher struct {
	cl     *kgo.Client
	errors atomic.Int64
	sent   atomic.Int64
}

// NewPublisher opens an idempotent producer.
func NewPublisher(brokers []string) (*Publisher, error) {
	cl, err := kgo.NewClient(
		kgo.SeedBrokers(brokers...),
		kgo.ProducerBatchCompression(kgo.Lz4Compression(), kgo.NoCompression()),
		kgo.RecordPartitioner(kgo.StickyKeyPartitioner(nil)),
	)
	if err != nil {
		return nil, err
	}
	return &Publisher{cl: cl}, nil
}

// Publish queues one record asynchronously. Delivery errors are counted, not
// fatal: the ClickHouse row is the system of record.
func (p *Publisher) Publish(topic, key string, value []byte, headers ...kgo.RecordHeader) {
	r := &kgo.Record{Topic: topic, Key: []byte(key), Value: value, Headers: headers}
	p.cl.Produce(context.Background(), r, func(_ *kgo.Record, err error) {
		if err != nil {
			p.errors.Add(1)
			return
		}
		p.sent.Add(1)
	})
}

// Errors reports failed deliveries so far.
func (p *Publisher) Errors() int64 { return p.errors.Load() }

// Sent reports successful deliveries so far.
func (p *Publisher) Sent() int64 { return p.sent.Load() }

// Flush blocks until every queued record is acknowledged.
func (p *Publisher) Flush(ctx context.Context) error { return p.cl.Flush(ctx) }

// Close flushes and shuts the producer down.
func (p *Publisher) Close() {
	_ = p.cl.Flush(context.Background())
	p.cl.Close()
}
