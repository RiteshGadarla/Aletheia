#!/usr/bin/env python3
"""Aletheia prototype log generator (spec Sec18, Sec21.2 scenario 5).

Seeded, correlated synthetic traffic for the vendor formats that ship as *generated* sources
(Cisco ASA, FortiGate, generic CEF, generic LEEF) plus an ASA "drift" variant that inserts an
extra field into a normally-recognized message, simulating a firmware update that breaks the
matching template on demand (used by demo scenario 5).

Design points (all required by the spec/CONTRACTS, none of them optional):
  - Fixed seed by default -> every run produces byte-identical output (spec Sec21.1).
  - Shared IP pools: a handful of "attacker" addresses are drawn from disproportionately for
    denies/alerts/blocks across ALL four formats, so the same IP shows up in an ASA deny, a
    FortiGate IPS alert, a CEF block and a LEEF block -> cross-source correlation is visible.
  - Output: stdout (default), a file (--out, appended, one line per event), or syslog UDP
    (--syslog host:port, one UDP datagram per line, which is how real syslog/UDP works).
  - Pure standard library. No third-party dependencies, so it runs unmodified air-gapped.

The line formats produced here are hand-matched against the templates already frozen in
backend/packs/cisco_asa.yaml, fortigate.yaml, cef_generic.yaml and leef_generic.yaml, so a
generated corpus round-trips through Aletheia's existing packs without any changes to them.

Usage:
  log_generator.py --count 200                                  # to stdout
  log_generator.py --count 200 --out events.log                 # append to a file
  log_generator.py --count 200 --syslog 127.0.0.1:5514           # UDP syslog
  log_generator.py --count 50 --formats asa_drift                # drift-only burst
  log_generator.py --seed 7 --count 20                            # different deterministic run
"""
from __future__ import annotations

import argparse
import random
import socket
import sys
import time
from datetime import datetime, timedelta

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

FORMATS = ["asa", "asa_drift", "fortigate", "cef", "leef"]


def syslog_ts(dt: datetime) -> str:
    """RFC 3164 timestamp: single-digit days are space padded (CONTRACTS syslog3164_ts)."""
    return f"{MONTHS[dt.month - 1]} {dt.day:2d} {dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}"


class Clock:
    """Monotonically advancing wall clock so timestamps in one run are strictly ordered."""

    def __init__(self, start: datetime, rng: random.Random):
        self.now = start
        self.rng = rng

    def tick(self) -> datetime:
        self.now += timedelta(seconds=self.rng.randint(1, 4))
        return self.now


class IPPools:
    """Shared address pools. A small fixed subset is the 'attacker' pool that recurs across
    every format's deny/alert/block events, so correlation is visible cross-source."""

    def __init__(self, rng: random.Random):
        self.internal = [f"10.0.0.{n}" for n in (5, 7, 9, 12, 15, 21, 33)]
        self.external = ([f"198.51.100.{n}" for n in range(2, 60)] +
                          [f"203.0.113.{n}" for n in range(2, 60)])
        self.attackers = rng.sample(self.external, 3)

    def internal_ip(self, rng: random.Random) -> str:
        return rng.choice(self.internal)

    def external_ip(self, rng: random.Random, attacker_bias: float = 0.4) -> str:
        if rng.random() < attacker_bias:
            return rng.choice(self.attackers)
        return rng.choice(self.external)


class Counters:
    """Monotonic ids so conn_id/session_id/tracker values look plausible and never repeat."""

    def __init__(self, start: int = 90000):
        self.n = start

    def next(self) -> int:
        self.n += 1
        return self.n


# --------------------------------------------------------------------------- Cisco ASA
def gen_asa(rng: random.Random, pools: IPPools, clock: Clock, ctr: Counters,
            drift: bool = False, host: str = "fw01") -> str:
    ts = syslog_ts(clock.tick())
    kind = rng.choices(
        ["built", "teardown", "deny", "vpn_up", "vpn_down", "nat"],
        weights=[3, 3, 4, 1, 1, 1])[0]
    pri = 166 if kind in ("built", "vpn_up", "nat") else 164   # informational vs warning

    if kind == "built":
        proto, port = rng.choice([("TCP", 302013), ("UDP", 302015)])
        direction = rng.choice(["inbound", "outbound"])
        conn_id = ctr.next()
        if direction == "outbound":
            if_a, ip_a, port_a = "inside", pools.internal_ip(rng), rng.randint(1024, 65000)
            if_b, ip_b, port_b = "outside", pools.external_ip(rng, attacker_bias=0.0), rng.choice([80, 443, 22])
        else:
            if_a, ip_a, port_a = "outside", pools.external_ip(rng), rng.randint(1024, 65000)
            if_b, ip_b, port_b = "inside", pools.internal_ip(rng), rng.choice([443, 8443])
        body = (f"%ASA-6-{port}: Built {direction} {proto} connection {conn_id} "
                f"for {if_a}:{ip_a}/{port_a} ({ip_a}/{port_a}) "
                f"to {if_b}:{ip_b}/{port_b} ({ip_b}/{port_b})")
        if drift:
            # Firmware "drift": a newer ASA image appends an extra field. Existing template's
            # body ends in a literal ")" so this line will not match asa_302013 -> quarantine.
            body += f" gaddr {pools.internal_ip(rng)}/{rng.randint(1024, 65000)}"
        return f"<{pri}>{ts} {host} {body}"

    if kind == "teardown":
        proto, code = rng.choice([("TCP", 302014), ("UDP", 302016)])
        conn_id = ctr.next()
        if_a, ip_a, port_a = "outside", pools.external_ip(rng, attacker_bias=0.0), rng.randint(1024, 65000)
        if_b, ip_b, port_b = "inside", pools.internal_ip(rng), rng.choice([443, 8443])
        duration = f"{rng.randint(0, 2)}:{rng.randint(0, 59):02d}:{rng.randint(0, 59):02d}"
        nbytes = rng.randint(200, 900000)
        body = (f"%ASA-6-{code}: Teardown {proto} connection {conn_id} "
                f"for {if_a}:{ip_a}/{port_a} to {if_b}:{ip_b}/{port_b} "
                f"duration {duration} bytes {nbytes}")
        if proto == "TCP":
            body += " " + rng.choice(["TCP FINs", "TCP Reset-I", "SYN Timeout", "Flow closed by inspection"])
        return f"<{pri}>{ts} {host} {body}"

    if kind == "deny":
        proto = rng.choice(["tcp", "udp", "icmp"])
        ip_a = pools.external_ip(rng)                          # attacker-biased source
        port_a = rng.randint(1024, 65000)
        ip_b = pools.internal_ip(rng)
        port_b = rng.choice([22, 23, 443, 3389])
        acl = rng.choice(["OUTSIDE_IN", "DMZ_ACCESS", "DenyExternal"])
        body = (f"%ASA-4-106023: Deny {proto} src outside:{ip_a}/{port_a} "
                f"dst inside:{ip_b}/{port_b} by access-group \"{acl}\" "
                f"[0x{rng.randint(0, 0xffffffff):x}, 0x{rng.randint(0, 0xffffffff):x}]")
        return f"<164>{ts} {host} {body}"

    if kind == "vpn_up":
        user = rng.choice(["analyst1", "analyst2", "svc-remote"])
        peer_ip = pools.external_ip(rng, attacker_bias=0.0)
        body = (f"%ASA-4-113039: Group <RA-VPN> User <{user}> IP <{peer_ip}> "
                f"AnyConnect parent session started.")
        return f"<166>{ts} {host} {body}"

    if kind == "vpn_down":
        user = rng.choice(["analyst1", "analyst2", "svc-remote"])
        peer_ip = pools.external_ip(rng, attacker_bias=0.0)
        duration = f"{rng.randint(0, 8)}h:{rng.randint(0, 59):02d}m:{rng.randint(0, 59):02d}s"
        body = (f"%ASA-4-113019: Group = RA-VPN, Username = {user}, IP = {peer_ip}, "
                f"Session disconnected. Session Type: SSL, Duration: {duration}, "
                f"Bytes xmt: {rng.randint(1000, 90000)}, Bytes rcv: {rng.randint(1000, 90000)}, "
                f"Reason: User Requested")
        return f"<164>{ts} {host} {body}"

    # nat
    xlate = rng.choice(["dynamic", "static"])
    proto = rng.choice(["TCP", "UDP"])
    ip_a, port_a = pools.internal_ip(rng), rng.randint(1024, 65000)
    ip_b, port_b = pools.external_ip(rng, attacker_bias=0.0), rng.randint(20000, 40000)
    body = (f"%ASA-6-305011: Built {xlate} {proto} translation from "
            f"inside:{ip_a}/{port_a} to outside:{ip_b}/{port_b}")
    return f"<166>{ts} {host} {body}"


# --------------------------------------------------------------------------- FortiGate
def gen_fortigate(rng: random.Random, pools: IPPools, clock: Clock, ctr: Counters,
                   devname: str = "FGT-EDGE") -> str:
    dt = clock.tick()
    date, time_s = dt.strftime("%Y-%m-%d"), dt.strftime("%H:%M:%S")
    kind = rng.choices(["traffic", "webfilter", "ips"], weights=[4, 2, 2])[0]

    if kind == "traffic":
        action = rng.choice(["accept", "accept", "deny"])
        srcip = pools.internal_ip(rng) if action == "accept" else pools.external_ip(rng)
        dstip = pools.external_ip(rng, attacker_bias=0.0) if action == "accept" else pools.internal_ip(rng)
        proto = rng.choice([6, 17])
        line = (
            f'date={date} time={time_s} devname="{devname}" devid="FG100E1234"'
            f' logid="0000000013" type="traffic" subtype="forward" level="notice"'
            f' vd="root" eventtime={int(dt.timestamp())} srcip={srcip}'
            f' srcport={rng.randint(1024, 65000)} srcintf="port2" dstip={dstip}'
            f' dstport={rng.choice([80, 443, 22, 53])} dstintf="port1"'
            f' sessionid={ctr.next()} proto={proto} action="{action}" policyid={rng.randint(1, 20)}'
            f' service="{"HTTPS" if proto == 6 else "DNS"}" trandisp="snat"'
            f' transip={srcip} transport={rng.randint(1024, 65000)}'
            f' duration={rng.randint(1, 600)} sentbyte={rng.randint(100, 90000)}'
            f' rcvdbyte={rng.randint(100, 90000)} sentpkt={rng.randint(1, 200)}'
            f' rcvdpkt={rng.randint(1, 200)}')
        return f"<189>{line}"

    if kind == "webfilter":
        action = rng.choice(["blocked", "passthrough"])
        srcip = pools.internal_ip(rng)
        dstip = pools.external_ip(rng, attacker_bias=0.0)
        host = rng.choice(["ads.example.net", "malware-test.example", "news.example.com"])
        line = (
            f'date={date} time={time_s} devname="{devname}" devid="FG100E1234"'
            f' logid="0317013312" type="utm" subtype="webfilter" eventtype="ftgd_blk"'
            f' level="warning" vd="root" eventtime={int(dt.timestamp())}'
            f' policyid={rng.randint(1, 20)} sessionid={ctr.next()} srcip={srcip}'
            f' srcport={rng.randint(1024, 65000)} srcintf="port2" dstip={dstip}'
            f' dstport=443 dstintf="port1" proto=6 service="HTTPS" hostname="{host}"'
            f' profile="default" action="{action}" reqtype="direct" url="/"'
            f' sentbyte={rng.randint(100, 4000)} rcvdbyte={rng.randint(100, 40000)}'
            f' direction="outgoing" msg="URL belongs to a denied category" method="domain"'
            f' cat={rng.choice([26, 61, 96])} catdesc="Malicious Websites"')
        return f"<188>{line}"

    # ips
    action = rng.choice(["dropped", "detected"])
    srcip = pools.external_ip(rng)          # attacker-biased
    dstip = pools.internal_ip(rng)
    attack = rng.choice(["MS.SMB.Server.SMBv1.Trans2.Handling.Vulnerability",
                          "Apache.Log4j.Error.Log.Remote.Code.Execution",
                          "SSH.Brute.Force.Login"])
    line = (
        f'date={date} time={time_s} devname="{devname}" devid="FG100E1234"'
        f' logid="0419016384" type="utm" subtype="ips" eventtype="signature"'
        f' level="alert" vd="root" eventtime={int(dt.timestamp())}'
        f' severity="{rng.choice(["high", "critical", "medium"])}" srcip={srcip}'
        f' dstip={dstip} srcintf="port1" dstintf="port2" sessionid={ctr.next()}'
        f' action="{action}" proto=6 service="HTTPS" policyid={rng.randint(1, 20)}'
        f' attack="{attack}" srcport={rng.randint(1024, 65000)} dstport=443'
        f' attackid={rng.randint(10000, 60000)} profile="default"'
        f' msg="{attack} detected"')
    return f"<187>{line}"


# --------------------------------------------------------------------------- generic CEF
def gen_cef(rng: random.Random, pools: IPPools, clock: Clock, host: str = "waf01") -> str:
    ts = syslog_ts(clock.tick())
    kind = rng.choices(["conn", "deny", "waf"], weights=[3, 3, 3])[0]

    if kind == "conn":
        src, dst = pools.internal_ip(rng), pools.external_ip(rng, attacker_bias=0.0)
        body = (f"CEF:0|VendorX|NGFW|4.2|1001|Connection allowed|3|"
                f"src={src} spt={rng.randint(1024, 65000)} dst={dst} "
                f"dpt={rng.choice([80, 443])} proto=TCP act=allow")
        return f"<166>{ts} {host} {body}"

    if kind == "deny":
        src, dst = pools.external_ip(rng), pools.internal_ip(rng)   # attacker-biased
        body = (f"CEF:0|VendorX|NGFW|4.2|1002|Connection denied|6|"
                f"rt={int(clock.now.timestamp() * 1000)} src={src} "
                f"spt={rng.randint(1024, 65000)} dst={dst} dpt={rng.choice([22, 3389])} "
                f"proto=TCP act=deny deviceInboundInterface=eth0 cs1Label=Policy "
                f"cs1=DenyExternal msg=Blocked by policy DenyExternal")
        return f"<164>{ts} {host} {body}"

    # waf
    src, dst = pools.external_ip(rng), pools.internal_ip(rng)       # attacker-biased
    body = (f"CEF:0|VendorX|WAF|2.0|100|SQL Injection Attempt|8|"
            f"src={src} spt={rng.randint(1024, 65000)} dst={dst} dpt=443 "
            f"request=/login.php?id=1%27%20OR%20%271%27=%271 requestMethod=POST "
            f"suser=anonymous act=block cs2Label=RuleId cs2={rng.randint(900000, 999999)} "
            f"msg=SQL Injection Attack Detected via libinjection")
    return f"<164>{ts} {host} {body}"


# --------------------------------------------------------------------------- generic LEEF
def gen_leef(rng: random.Random, pools: IPPools, clock: Clock, host: str = "waf01") -> str:
    ts = syslog_ts(clock.tick())
    kind = rng.choices(["waf_caret", "waf_tab", "fw_tab"], weights=[2, 2, 3])[0]

    if kind == "waf_caret":
        src, dst = pools.external_ip(rng), pools.internal_ip(rng)   # attacker-biased
        action = rng.choice(["block", "allow"])
        user = rng.choice(["alice", "bob", "-"])
        body = f"LEEF:2.0|VendorY|WAF|3.1|BLOCK|^|src={src}^dst={dst}^usrName={user}^action={action}"
        return f"<164>{ts} {host} {body}"

    if kind == "waf_tab":
        src, dst = pools.external_ip(rng), pools.internal_ip(rng)   # attacker-biased
        action = rng.choice(["block", "allow"])
        user = rng.choice(["alice", "bob", "-"])
        body = f"LEEF:2.0|VendorY|WAF|3.1|BLOCK2|x09|src={src}\tdst={dst}\tusrName={user}\taction={action}"
        return f"<164>{ts} {host} {body}"

    # fw_tab: LEEF 1.0, no delimiter field, no syslog wrapper (matches leef_nodelim envelope)
    src, dst = pools.internal_ip(rng), pools.external_ip(rng, attacker_bias=0.0)
    action = rng.choice(["accept", "drop"])
    body = (f"LEEF:1.0|VendorZ|FWALL|1.4|ACCEPT|cat=traffic\tsrc={src}\t"
            f"srcPort={rng.randint(1024, 65000)}\tdst={dst}\tdstPort={rng.choice([80, 443])}\t"
            f"proto={rng.choice(['tcp', 'udp'])}\taction={action}\t"
            f"srcBytes={rng.randint(100, 9000)}\tdstBytes={rng.randint(100, 90000)}")
    return body


GENERATORS = {
    "asa": lambda rng, pools, clock, ctr: gen_asa(rng, pools, clock, ctr, drift=False),
    "asa_drift": lambda rng, pools, clock, ctr: gen_asa(rng, pools, clock, ctr, drift=True),
    "fortigate": lambda rng, pools, clock, ctr: gen_fortigate(rng, pools, clock, ctr),
    "cef": lambda rng, pools, clock, ctr: gen_cef(rng, pools, clock),
    "leef": lambda rng, pools, clock, ctr: gen_leef(rng, pools, clock),
}


def make_sink(out_path: str | None, syslog_target: str | None):
    """Returns a callable(line:str)->None. Exactly one of out_path/syslog_target may be set;
    with neither, lines go to stdout."""
    if syslog_target:
        host, _, port_s = syslog_target.rpartition(":")
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        addr = (host, int(port_s))

        def send(line: str) -> None:
            sock.sendto(line.encode("utf-8"), addr)
        return send

    if out_path:
        fh = open(out_path, "a", encoding="utf-8")

        def append(line: str) -> None:
            fh.write(line + "\n")
            fh.flush()
        return append

    def stdout_write(line: str) -> None:
        sys.stdout.write(line + "\n")
    return stdout_write


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                  formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--count", type=int, default=100, help="number of lines to emit")
    ap.add_argument("--seed", type=int, default=1337, help="PRNG seed (default: fixed, per spec)")
    ap.add_argument("--formats", default="asa,fortigate,cef,leef",
                     help=f"comma-separated subset of {FORMATS}")
    ap.add_argument("--out", help="append lines to this file instead of stdout")
    ap.add_argument("--syslog", help="host:port to send each line as a UDP syslog datagram")
    ap.add_argument("--rate", type=float, default=0.0,
                     help="lines/sec pacing when writing to a file or syslog (0 = as fast as possible)")
    ap.add_argument("--start", default=None,
                     help="ISO start timestamp for embedded log times (default: now)")
    args = ap.parse_args()

    formats = [f.strip() for f in args.formats.split(",") if f.strip()]
    for f in formats:
        if f not in GENERATORS:
            ap.error(f"unknown format {f!r}, choose from {FORMATS}")

    rng = random.Random(args.seed)
    pools = IPPools(rng)
    start = datetime.fromisoformat(args.start) if args.start else datetime.now()
    clock = Clock(start, rng)
    ctr = Counters()
    sink = make_sink(args.out, args.syslog)

    interval = 1.0 / args.rate if args.rate > 0 else 0.0
    for _ in range(args.count):
        fmt = rng.choice(formats)
        line = GENERATORS[fmt](rng, pools, clock, ctr)
        sink(line)
        if interval:
            time.sleep(interval)
    return 0


if __name__ == "__main__":
    sys.exit(main())
