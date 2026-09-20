"""Per-service line generators. Each returns gen(feed) -> (line, severity), driven by feed.mood.risk."""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import log_generator as lg  # noqa: E402

from common import blend, sev_from_pri  # noqa: E402


class LiveClock:
    """Real wall clock; log_generator only needs tick() and .now."""

    def __init__(self):
        self.now = datetime.now()

    def tick(self):
        self.now = datetime.now()
        return self.now


def _risky(line, sev, pools):
    return "risk" if sev == "warn" and any(a in line for a in pools.attackers) else sev


def _syslog_gen(fn, calm, bad, drift_fn=None):
    def make(seed: int):
        pools_rng = __import__("random").Random(seed)
        pools, clock, ctr = lg.IPPools(pools_rng), LiveClock(), lg.Counters()

        def gen(feed):
            w = blend(calm, bad, feed.mood.risk)
            if drift_fn and feed.drift and feed.rng.random() < 0.3:
                line = drift_fn(feed.rng, pools, clock, ctr)
            else:
                line = fn(feed.rng, pools, clock, ctr, w)
            sev = sev_from_pri(line)
            if "%ASA-" in line:
                sev = {"6": "info", "5": "notice", "4": "warn"}.get(line.split("%ASA-")[1][0], "risk")
            return line, _risky(line, sev, pools)
        return gen
    return make


asa = _syslog_gen(lambda r, p, c, k, w: lg.gen_asa(r, p, c, k, weights=w),
                  [6, 6, 1, 1, 1, 2], [1, 1, 14, 0, 0, 0],
                  lambda r, p, c, k: lg.gen_asa(r, p, c, k, drift=True))
fortigate = _syslog_gen(lambda r, p, c, k, w: lg.gen_fortigate(r, p, c, k, weights=w), [8, 2, 0.3], [1, 2, 8])
cef = _syslog_gen(lambda r, p, c, k, w: (lg.gen_leef(r, p, c, weights=w[:3]) if r.random() < 0.3
                                         else lg.gen_cef(r, p, c, weights=w)), [6, 2, 1], [1, 5, 8])


# ------------------------------------------------------------------ web: squid + nginx
_OK_HOSTS = ["example.com", "github.com", "cdn.example.net", "news.example.com", "api.example.org"]
_BAD_HOSTS = ["malware-test.example", "c2.badhost.example", "phish.example.biz"]
_UA = ["Mozilla/5.0 (X11; Linux x86_64) Firefox/126.0", "Mozilla/5.0 (Windows NT 10.0) Chrome/125.0",
       "curl/8.5.0", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4) Safari/605.1"]
_SCAN = [("/wp-login.php", 404), ("/.env", 403), ("/../../etc/passwd", 400), ("/admin/config.php", 404),
         ("/api/v1/items?id=1%27%20OR%201=1--", 500), ("/phpmyadmin/", 404)]
_PATHS = ["/", "/index.html", "/api/v1/items", "/api/v1/users/42", "/static/app.js", "/login", "/health"]


def web(seed: int):
    import random
    pools, ctr = lg.IPPools(random.Random(seed)), lg.Counters()

    def squid(feed):
        r, risk = feed.rng, feed.mood.risk
        now, client = datetime.now().timestamp(), pools.internal_ip(feed.rng)
        if r.random() < risk:
            host, code, st, method = r.choice(_BAD_HOSTS), "TCP_DENIED", 403, "GET"
            sev = "risk"
        else:
            host = r.choice(_OK_HOSTS)
            code, st, method = r.choices(
                [("TCP_TUNNEL", 200, "CONNECT"), ("TCP_MISS", 200, "GET"), ("TCP_HIT", 200, "GET"),
                 ("TCP_REFRESH_UNMODIFIED", 304, "GET"), ("TCP_MISS", 503, "GET"), ("TCP_MISS", 407, "GET")],
                [50, 25, 15, 6, 2, 2])[0]
            sev = "warn" if st >= 500 else "notice" if st == 407 else "info"
        url = f"{host}:443" if method == "CONNECT" else f"http://{host}/{r.choice(['', 'index.html', 'a.js'])}"
        ctype = "-" if method == "CONNECT" else r.choice(["text/html", "application/json", "image/png"])
        peer = f"HIER_DIRECT/{pools.external_ip(r, 0.0)}" if code != "TCP_DENIED" else "HIER_NONE/-"
        line = (f"{now:.3f} {r.randint(2, 900):6d} {client} {code}/{st} {r.randint(200, 900000)} "
                f"{method} {url} - {peer} {ctype}")
        return line, sev

    def nginx(feed):
        r, risk = feed.rng, feed.mood.risk
        if r.random() < risk:
            ip, (path, st) = r.choice(pools.attackers), r.choice(_SCAN)
            ua = r.choice(["sqlmap/1.7", "Nikto/2.5", "masscan/1.3", "python-requests/2.31"])
            sev = "risk"
        else:
            ip, path = pools.external_ip(r, 0.0), r.choice(_PATHS)
            st = r.choices([200, 304, 301, 404, 500], [80, 8, 4, 6, 2])[0]
            ua = r.choice(_UA)
            sev = "warn" if st >= 500 else "notice" if st == 404 else "info"
        ts = datetime.now(timezone.utc).strftime("%d/%b/%Y:%H:%M:%S +0000")
        method = "POST" if path == "/login" else "GET"
        return (f'{ip} - - [{ts}] "{method} {path} HTTP/1.1" {st} {r.randint(120, 90000)} "-" "{ua}"', sev)

    def gen(feed):
        return nginx(feed) if feed.rng.random() < 0.25 else squid(feed)
    return gen


# ------------------------------------------------------------------ OpenVPN
_USERS = ["analyst1", "analyst2", "svc-remote", "dbaker", "mlee", "jsmith"]
_GUESS = ["admin", "root", "test", "guest", "vpnuser", "administrator"]


def vpn(seed: int):
    import random
    pools = lg.IPPools(random.Random(seed))

    def gen(feed):
        r, risk = feed.rng, feed.mood.risk
        ts, pri = lg.syslog_ts(datetime.now()), "<29>"
        pre = f"{pri}{ts} vpn01 openvpn[812]:"
        if r.random() < risk:                                    # brute force from a recurring attacker
            ip = r.choice(pools.attackers)
            return (f"{pre} {ip}:{r.randint(1024, 65000)} TLS: Username/Password authentication "
                    f"failed for username '{r.choice(_GUESS)}'", "risk")
        k = r.choices(["ok", "fail", "peer", "learn", "tls"], [55, 10, 12, 15, 8])[0]
        ip, port = pools.external_ip(r, 0.0), r.randint(1024, 65000)
        user = r.choice(_USERS)
        if k == "ok":
            return f"{pre} {ip}:{port} TLS: Username/Password authentication succeeded for username '{user}'", "info"
        if k == "fail":
            return f"{pre} {ip}:{port} TLS: Username/Password authentication failed for username '{user}'", "warn"
        if k == "peer":
            return f"{pre} {user}/{ip}:{port} Peer Connection Initiated with [AF_INET]{ip}:{port}", "info"
        if k == "learn":
            return f"{pre} {user}/{ip}:{port} MULTI: Learn: 10.8.0.{r.randint(2, 250)} -> {user}/{ip}:{port}", "info"
        return f"{pre} {ip}:{port} TLS Error: TLS handshake failed", "notice"
    return gen


# ------------------------------------------------------------------ custom JSON app logs
_SVC = ["payments-api", "auth-service", "inventory", "search-gateway"]
_ROUTES = ["/v1/checkout", "/v1/login", "/v1/items", "/v1/search", "/v1/orders/{id}"]


def app(seed: int):
    import random
    pools = lg.IPPools(random.Random(seed))

    def gen(feed):
        r, risk = feed.rng, feed.mood.risk
        svc, route = r.choice(_SVC), r.choice(_ROUTES)
        bad = r.random() < risk
        mid = r.random() < risk * 2 + 0.05
        if bad:
            level, msg, status = r.choice([
                ("ERROR", "upstream timeout", 504), ("ERROR", "db connection pool exhausted", 503),
                ("ERROR", "credential stuffing suspected", 401), ("FATAL", "unrecoverable panic in handler", 500)])
        elif mid:
            level, msg, status = r.choice([
                ("WARN", "slow query", 200), ("WARN", "rate limit exceeded", 429), ("WARN", "retrying upstream", 200)])
        else:
            level, msg, status = r.choices(
                [("INFO", "request completed", 200), ("INFO", "user logged in", 200), ("DEBUG", "cache hit", 200)],
                [70, 10, 20])[0]
        ev = {"ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
              "level": level, "service": svc, "route": route, "status": status,
              "latency_ms": int(r.lognormvariate(4.2 + (1.5 if bad else 0.5 if mid else 0), 0.6)),
              "trace_id": f"{r.getrandbits(64):016x}", "user_id": r.randint(1000, 9999),
              "client_ip": r.choice(pools.attackers) if bad else pools.external_ip(r, 0.0), "msg": msg}
        return json.dumps(ev, separators=(",", ":")), \
            "risk" if level in ("ERROR", "FATAL") else "warn" if level == "WARN" else "info"
    return gen
