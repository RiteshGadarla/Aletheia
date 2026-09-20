#!/usr/bin/env python3
"""Turn an `aletheia verify` report into a pass/fail exit status.

`verify` prints a JSON object and exits 0 only when "ok" is true, but "ok" alone
hides which guarantee broke. This names it, so a failing smoke run says whether
reconstruction, the chain, or a single batch is at fault.
"""

import json
import sys


def main(path: str) -> int:
    with open(path, encoding="utf-8") as fh:
        d = json.load(fh)

    bad = []
    if not d.get("ok"):
        bad.append(d.get("error") or "verify reported ok=false")
    missed = d.get("events", 0) - d.get("verified", 0)
    if missed:
        bad.append(f"{missed} of {d.get('events')} events did not rebuild byte-exactly")
    if d.get("batches") and not d.get("chain_ok"):
        bad.append("the merkle chain did not verify")
    bad_batches = d.get("batches", 0) - d.get("batches_ok", 0)
    if bad_batches:
        bad.append(f"{bad_batches} of {d.get('batches')} merkle batches failed")
    for ev in (d.get("failed_events") or [])[:5]:
        bad.append(f"failed event: {ev}")

    if bad:
        print("FAIL: " + "; ".join(bad), file=sys.stderr)
        return 1
    print(f"OK: {d.get('events')} events byte-exact, "
          f"{d.get('batches')} merkle batches, chain verified")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: check_verify.py <verify-report.json>", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
