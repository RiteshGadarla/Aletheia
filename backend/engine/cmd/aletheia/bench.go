package main

import (
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Ritesh2006M/aletheia/config"
	"github.com/Ritesh2006M/aletheia/pipeline"
)

// BenchPoint is one worker-count measurement.
type BenchPoint struct {
	Workers    int     `json:"workers"`
	Events     int64   `json:"events"`
	Seconds    float64 `json:"seconds"`
	EPS        float64 `json:"eps"`
	EPSPerCore float64 `json:"eps_per_core"`
	Verified   int64   `json:"verified"`
	Quarantine int64   `json:"quarantine"`
	Mismatch   int64   `json:"reconstruct_mismatch"`
}

// BenchResult reports throughput per worker count. Scope is the engine hot
// path (hash, decode, match, reconstruct, verify, normalize) with the corpus in
// memory — the bus and ClickHouse are deliberately out of the measurement, and
// the field says so rather than letting the number be read as end-to-end.
type BenchResult struct {
	OK       bool         `json:"ok"`
	Scope    string       `json:"scope"`
	Duration string       `json:"duration"`
	Corpus   int          `json:"corpus"`
	Cores    int          `json:"cores"`
	Results  []BenchPoint `json:"results"`
	BestEPS  float64      `json:"best_eps"`
	Error    string       `json:"error,omitempty"`
}

func cmdBench(args []string) int {
	fs_ := flag.NewFlagSet("bench", flag.ContinueOnError)
	workers := fs_.String("workers", "1,2,4", "comma-separated worker counts")
	duration := fs_.Duration("duration", 60*time.Second, "run time per worker count")
	packsDir := fs_.String("packs", "", "pack directory (default $ALETHEIA_PACKS_DIR)")
	samples := fs_.String("samples", "", "corpus directory of *.log files (default <packs>/tests)")
	fs_.Bool("json", true, "print JSON (always on)")
	if err := fs_.Parse(args); err != nil {
		return benchFail(fmt.Sprintf("bad flags: %v", err))
	}

	cfg := config.Load()
	if *packsDir == "" {
		*packsDir = cfg.PacksDir
	}
	if *samples == "" {
		*samples = filepath.Join(*packsDir, "tests")
	}

	eng, _, err := pipeline.Load(pipeline.Paths{PacksDir: *packsDir, EnumsFile: cfg.EnumsFile()})
	if err != nil {
		return benchFail("load packs: " + err.Error())
	}
	corpus, err := loadCorpus(*samples)
	if err != nil {
		return benchFail("corpus: " + err.Error())
	}
	if len(corpus) == 0 {
		return benchFail("corpus: no *.log samples under " + *samples)
	}
	counts, err := parseCounts(*workers)
	if err != nil {
		return benchFail(err.Error())
	}

	res := BenchResult{Scope: "engine_hot_path_in_memory", Duration: duration.String(),
		Corpus: len(corpus), Cores: runtime.NumCPU(), Results: []BenchPoint{}}
	for _, n := range counts {
		res.Results = append(res.Results, runBench(eng, corpus, n, *duration))
	}
	for _, p := range res.Results {
		if p.EPS > res.BestEPS {
			res.BestEPS = p.EPS
		}
	}
	res.OK = res.BestEPS > 0
	emit(res)
	return code(res.OK)
}

// runBench drives n goroutines over the corpus for d, counting full events.
func runBench(eng *pipeline.Engine, corpus [][]byte, n int, d time.Duration) BenchPoint {
	var events, verified, quar, mismatch atomic.Int64
	deadline := time.Now().Add(d)
	var wg sync.WaitGroup
	start := time.Now()
	for w := 0; w < n; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			var local, lv, lq, lm int64
			i := 0
			off := int64(w) << 32
			for {
				// Check the clock every 256 events: the clock read costs more
				// than the work being measured.
				if local&0xff == 0 && time.Now().After(deadline) {
					break
				}
				raw := corpus[i%len(corpus)]
				i++
				o := eng.Process(pipeline.Message{
					Raw: raw, SourceID: "bench", RecvMS: 1789828262123,
					Topic: "raw", Partition: int32(w), Offset: off + local,
				})
				local++
				if o.Verified {
					lv++
				}
				if o.Quarantine {
					lq++
				}
				if o.Mismatch {
					lm++
				}
			}
			events.Add(local)
			verified.Add(lv)
			quar.Add(lq)
			mismatch.Add(lm)
		}(w)
	}
	wg.Wait()
	secs := time.Since(start).Seconds()
	p := BenchPoint{Workers: n, Events: events.Load(), Seconds: round(secs, 3),
		Verified: verified.Load(), Quarantine: quar.Load(), Mismatch: mismatch.Load()}
	if secs > 0 {
		p.EPS = round(float64(p.Events)/secs, 1)
		cores := n
		if cores > runtime.NumCPU() {
			cores = runtime.NumCPU()
		}
		p.EPSPerCore = round(p.EPS/float64(cores), 1)
	}
	return p
}

// loadCorpus reads every *.log line under dir, one raw event per line.
func loadCorpus(dir string) ([][]byte, error) {
	var out [][]byte
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".log") {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		out = append(out, splitSamples(b)...)
		return nil
	})
	return out, err
}

func parseCounts(s string) ([]int, error) {
	var out []int
	for _, p := range strings.Split(s, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		n, err := strconv.Atoi(p)
		if err != nil || n <= 0 {
			return nil, fmt.Errorf("--workers: %q is not a positive integer", p)
		}
		out = append(out, n)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("--workers: no worker counts given")
	}
	return out, nil
}

func round(v float64, places int) float64 {
	p := 1.0
	for i := 0; i < places; i++ {
		p *= 10
	}
	return float64(int64(v*p+0.5)) / p
}

func benchFail(reason string) int {
	emit(BenchResult{OK: false, Error: reason, Results: []BenchPoint{}, Cores: runtime.NumCPU()})
	return 1
}
