#!/usr/bin/env python3
"""Live log-generator servers. `serve.py --type asa|fortigate|web|vpn|cef|app|all`."""
from __future__ import annotations

import argparse
import asyncio
import os

import formats
from common import Feed, http_handler, tcp_handler, udp_pusher

# type: (generator factory, data port, control-http port, mean lines/s, transport). Each mean differs;
# the live rate wanders within 40-80 (see common.Feed.wander).
SERVICES = {
    "asa":       (formats.asa,       9101, 9201, 48.0, "tcp"),
    "fortigate": (formats.fortigate, 9102, 9102, 60.0, "http"),
    "web":       (formats.web,       9103, 9103, 70.0, "http"),
    "vpn":       (formats.vpn,       9104, 9104, 46.0, "http"),
    "cef":       (formats.cef,       9105, 9105, 55.0, "udp"),
    "app":       (formats.app,       9106, 9106, 65.0, "http"),
    "shop":      (formats.shop,      9107, 9107, 72.0, "http"),
    "defense":   (formats.defense,   9110, 9210, 52.0, "tcp"),
    "llm":       (formats.llm,       9111, 9211, 58.0, "tcp"),
}


async def start(name: str, seed: int, host: str, live: set[str], done: asyncio.Event) -> None:
    make, port, ctl, rate, transport = SERVICES[name]
    rate = float(os.environ.get("RATE", rate))
    feed = Feed(name, make(seed), rate, seed + sum(map(ord, name)))
    tasks = [asyncio.create_task(feed.run())]
    servers = [await asyncio.start_server(http_handler(feed), host, ctl)]
    if transport == "tcp":
        servers.append(await asyncio.start_server(tcp_handler(feed), host, port))
    if transport == "udp" and os.environ.get("PUSH_TARGET"):
        tasks.append(asyncio.create_task(udp_pusher(feed, os.environ["PUSH_TARGET"])))

    def shutdown() -> None:
        # Studio's Stop button: close this service's ports; the process exits once none are left.
        for srv in servers:
            srv.close()
        for t in tasks:
            t.cancel()
        live.discard(name)
        print(f"[{name}] stopped", flush=True)
        if not live:
            done.set()

    feed.on_shutdown = shutdown
    live.add(name)
    print(f"[{name}] data={transport}:{port} http:{ctl} eps~{rate}", flush=True)


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--type", default=os.environ.get("GEN_TYPE", "all"))
    ap.add_argument("--seed", type=int, default=int(os.environ.get("SEED", 1337)))
    ap.add_argument("--host", default="0.0.0.0")
    a = ap.parse_args()
    live: set[str] = set()
    done = asyncio.Event()
    for n in (SERVICES if a.type == "all" else [a.type]):
        await start(n, a.seed, a.host, live, done)
    await done.wait()


if __name__ == "__main__":
    asyncio.run(main())
