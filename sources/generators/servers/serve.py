#!/usr/bin/env python3
"""Live log-generator servers. `serve.py --type asa|fortigate|web|vpn|cef|app|all`."""
from __future__ import annotations

import argparse
import asyncio
import os

import formats
from common import Feed, http_handler, tcp_handler, udp_pusher

# type: (generator factory, data port, control-http port, base eps, transport)
SERVICES = {
    "asa":       (formats.asa,       9101, 9201, 55.0, "tcp"),
    "fortigate": (formats.fortigate, 9102, 9102, 55.0, "http"),
    "web":       (formats.web,       9103, 9103, 55.0, "http"),
    "vpn":       (formats.vpn,       9104, 9104, 55.0, "http"),
    "cef":       (formats.cef,       9105, 9105, 55.0, "udp"),
    "app":       (formats.app,       9106, 9106, 55.0, "http"),
    "shop":      (formats.shop,      9107, 9107, 55.0, "http"),
    "defense":   (formats.defense,   9110, 9210, 55.0, "tcp"),
}


async def start(name: str, seed: int, host: str) -> None:
    make, port, ctl, rate, transport = SERVICES[name]
    rate = float(os.environ.get("RATE", rate))
    feed = Feed(name, make(seed), rate, seed)
    asyncio.create_task(feed.run())
    await asyncio.start_server(http_handler(feed), host, ctl)
    if transport == "tcp":
        await asyncio.start_server(tcp_handler(feed), host, port)
    if transport == "udp" and os.environ.get("PUSH_TARGET"):
        asyncio.create_task(udp_pusher(feed, os.environ["PUSH_TARGET"]))
    print(f"[{name}] data={transport}:{port} http:{ctl} eps~{rate}", flush=True)


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--type", default=os.environ.get("GEN_TYPE", "all"))
    ap.add_argument("--seed", type=int, default=int(os.environ.get("SEED", 1337)))
    ap.add_argument("--host", default="0.0.0.0")
    a = ap.parse_args()
    for n in (SERVICES if a.type == "all" else [a.type]):
        await start(n, a.seed, a.host)
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(main())
