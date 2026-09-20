#!/usr/bin/env python3
"""Publish log lines onto the `raw` topic exactly as the collector does (CONTRACTS §3).

The value is the raw bytes with no wrapper; everything else travels in Kafka headers
(`pr_recv_ms`, `pr_peer`, `pr_listener`). Key is the source_id so a source stays ordered.

    produce-raw.py --file events.log --source fw01 --listener udp:5514
"""
from __future__ import annotations

import argparse
import sys
import time

from confluent_kafka import Producer


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True, help="one raw log line per line")
    ap.add_argument("--source", required=True, help="source_id, used as the record key")
    ap.add_argument("--brokers", default="127.0.0.1:9092")
    ap.add_argument("--topic", default="raw")
    ap.add_argument("--peer", default="10.0.0.1:51514")
    ap.add_argument("--listener", default="udp:5514")
    ap.add_argument("--spread-ms", type=int, default=0,
                    help="spread pr_recv_ms backwards over this many ms, oldest line first")
    args = ap.parse_args()

    with open(args.file, "rb") as fh:
        lines = [ln for ln in fh.read().split(b"\n") if ln.strip()]
    if not lines:
        print("no lines", file=sys.stderr)
        return 1

    p = Producer({"bootstrap.servers": args.brokers, "enable.idempotence": True})
    now = int(time.time() * 1000)
    step = args.spread_ms / len(lines) if args.spread_ms else 0
    failed = []

    def ack(err, _msg):
        if err is not None:
            failed.append(err)

    for i, raw in enumerate(lines):
        recv_ms = now - args.spread_ms + int(i * step) if step else now
        p.produce(
            args.topic,
            key=args.source.encode(),
            value=raw,
            headers=[("pr_recv_ms", str(recv_ms).encode()),
                     ("pr_peer", args.peer.encode()),
                     ("pr_listener", args.listener.encode())],
            on_delivery=ack,
        )
        if i % 5000 == 0:
            p.poll(0)
    p.flush(60)
    if failed:
        print(f"{len(failed)} deliveries failed: {failed[0]}", file=sys.stderr)
        return 1
    print(f"produced {len(lines)} lines to {args.topic} key={args.source}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
