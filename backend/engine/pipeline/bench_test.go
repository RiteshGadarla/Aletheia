package pipeline_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Ritesh2006M/aletheia/config"
	"github.com/Ritesh2006M/aletheia/pipeline"
)

func BenchmarkProcess(b *testing.B) {
	cfg := config.Load()
	packs := "../../packs"
	eng, _, err := pipeline.Load(pipeline.Paths{PacksDir: packs, EnumsFile: cfg.EnumsFile()})
	if err != nil {
		b.Skip(err)
	}
	logs, _ := filepath.Glob(filepath.Join(packs, "tests", "*", "*.log"))
	var corpus [][]byte
	for _, p := range logs {
		if raw, err := os.ReadFile(p); err == nil {
			corpus = append(corpus, raw)
		}
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		eng.Process(pipeline.Message{Raw: corpus[i%len(corpus)], SourceID: "bench", RecvMS: 1789828262123,
			Topic: "raw", Partition: 0, Offset: int64(i)})
	}
}
