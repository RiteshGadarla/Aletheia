// Command aletheia is the batch-mode face of the engine: the reconstruction
// gate, the integrity verifier, the replay differ and the benchmark.
// Every subcommand prints exactly one JSON object on stdout and exits non-zero
// on failure (CONTRACTS §8) — the Studio shells out to these.
package main

import (
	"encoding/json"
	"fmt"
	"os"
)

var version = "dev"

const usage = `aletheia — Aletheia engine CLI

  aletheia test-pack --pack <file.yaml> --samples <dir> [--json]
  aletheia verify    --source <id> (--last 15m | --from T --to T) [--json]
  aletheia seal      [--source <id>] (--last 24h | --from T --to T) [--dry-run] [--json]
  aletheia replay    --source <id> --from-version A --to-version B --last N [--json]
  aletheia bench     --workers 1,2,4 --duration 60s [--json]
  aletheia version

Every subcommand prints one JSON object on stdout; exit status is 0 only when "ok" is true.
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	args := os.Args[2:]
	switch os.Args[1] {
	case "test-pack":
		os.Exit(cmdTestPack(args))
	case "verify":
		os.Exit(cmdVerify(args))
	case "seal":
		os.Exit(cmdSeal(args))
	case "replay":
		os.Exit(cmdReplay(args))
	case "bench":
		os.Exit(cmdBench(args))
	case "version", "--version", "-v":
		emit(map[string]any{"ok": true, "version": version})
		os.Exit(0)
	case "help", "--help", "-h":
		fmt.Fprint(os.Stderr, usage)
		os.Exit(0)
	default:
		fmt.Fprintf(os.Stderr, "unknown subcommand %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
}

// emit writes one JSON object to stdout. Diagnostics always go to stderr so
// stdout stays machine-parseable.
func emit(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		fmt.Fprintf(os.Stderr, "marshal: %v\n", err)
		fmt.Println(`{"ok":false,"error":"marshal failed"}`)
		return
	}
	fmt.Println(string(b))
}

// code turns an ok flag into a process exit status.
func code(ok bool) int {
	if ok {
		return 0
	}
	return 1
}
