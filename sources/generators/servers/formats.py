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


# ------------------------------------------------------------------ AmazonMart (fictional online store)
_ASIN = ["B08N5WRWNW", "B09G9FPHY6", "B07XJ8C8F5", "B0BSHF7WHW", "B08J5F3G18", "B09V3KXJPB", "B0C1H26C46", "B07FZ8S74R"]
_QUERIES = ["wireless earbuds", "usb c cable", "running shoes", "coffee maker", "laptop stand", "yoga mat", "air fryer", "phone case"]
_SHOP_UA = ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125.0 Safari/537.36",
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Mobile/15E148 Safari/604.1",
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/125.0 Mobile Safari/537.36",
            "AmazonMartApp/24.9 (Android 14)", "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) Safari/605.1.15"]
_BOT_UA = ["python-requests/2.31.0", "Scrapy/2.11 (+https://scrapy.org)", "Go-http-client/1.1", "curl/8.4.0"]
_SHOP_PAGES = [("/", 30), ("/s?k={q}", 22), ("/dp/{asin}?ref=sr_1_3", 24), ("/gp/cart/add?asin={asin}", 7),
               ("/gp/cart/view", 5), ("/gp/checkout/place-order", 3), ("/gp/your-account/orders", 3),
               ("/api/v1/recommendations?asin={asin}", 6)]
_SHOP_EVENTS = [
    ("cart", "cart.item.added", "INFO", 30), ("orders", "order.placed", "INFO", 12),
    ("payments", "payment.authorized", "INFO", 12), ("search", "search.query", "INFO", 18),
    ("reco", "recommendations.served", "DEBUG", 12), ("inventory", "inventory.low", "WARN", 3),
    ("shipping", "delivery.delayed", "WARN", 2), ("payments", "payment.declined", "WARN", 3),
    ("search", "search.zero_results", "WARN", 2), ("orders", "checkout.timeout", "ERROR", 1),
]
_SHOP_ATTACK = [
    ("fraud", "fraud.flagged", "ERROR", "card testing pattern: many small authorizations"),
    ("auth", "account.takeover.suspected", "ERROR", "credential stuffing from repeated IP"),
    ("payments", "payment.gateway.error", "FATAL", "payment provider returned 503"),
    ("promo", "coupon.abuse.detected", "ERROR", "same coupon redeemed across 40 accounts"),
]


def shop(seed: int):
    import random
    rng0 = random.Random(seed)
    pools = lg.IPPools(rng0)
    elb = "app/amazonmart-alb/50dc6c495c0c9188"

    def alb(feed):
        r, risk = feed.rng, feed.mood.risk
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        bad = r.random() < risk
        if bad:
            kind = r.choice(["stuff", "card", "scrape"])
            ip, ua, sev = r.choice(pools.attackers), r.choice(_BOT_UA), "risk"
            method, path, st = {"stuff": ("POST", "/ap/signin", r.choice([401, 401, 429])),
                                "card": ("POST", "/api/v1/payments/authorize", r.choice([402, 403, 403])),
                                "scrape": ("GET", f"/dp/{r.choice(_ASIN)}", r.choice([200, 429]))}[kind]
        else:
            ip, ua = pools.external_ip(r, 0.0), r.choice(_SHOP_UA)
            tmpl = r.choices([p for p, _ in _SHOP_PAGES], [w for _, w in _SHOP_PAGES])[0]
            path = tmpl.format(q=r.choice(_QUERIES).replace(" ", "+"), asin=r.choice(_ASIN))
            method = "POST" if "place-order" in path or "cart/add" in path else "GET"
            st = r.choices([200, 304, 301, 404, 500, 502, 503], [84, 6, 3, 4, 1, 1, 1])[0]
            sev = "warn" if st >= 500 else "notice" if st == 404 else "info"
        rt = r.uniform(0.0005, 0.004)
        tt = r.lognormvariate(-3.6 + (1.2 if st >= 500 else 0), 0.7)
        req = f"{method} https://www.amazonmart.example:443{path} HTTP/1.1"
        tid = f"Root=1-{r.getrandbits(32):08x}-{r.getrandbits(96):024x}"
        line = (f'https {ts} {elb} {ip}:{r.randint(1024, 65000)} 10.0.{r.randint(1, 4)}.{r.randint(10, 60)}:8080 '
                f'{rt:.3f} {tt:.3f} 0.000 {st} {st} {r.randint(180, 2400)} {r.randint(300, 90000)} "{req}" "{ua}" '
                f'ECDHE-RSA-AES128-GCM-SHA256 TLSv1.2 arn:aws:elasticloadbalancing:us-east-1:123456789012:'
                f'targetgroup/web/73e2d6bc24d8a067 "{tid}" "www.amazonmart.example"')
        return line, sev

    def event(feed):
        r, risk = feed.rng, feed.mood.risk
        ts = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        if r.random() < risk:
            svc, name, level, msg = r.choice(_SHOP_ATTACK)
        else:
            svc, name, level, _ = r.choices(_SHOP_EVENTS, [w for *_, w in _SHOP_EVENTS])[0]
            msg = name.replace(".", " ")
        ev = {"ts": ts, "level": level, "service": svc, "event": name, "region": "us-east-1",
              "customer_id": f"A{r.randint(10**9, 10**10 - 1)}", "session": f"{r.getrandbits(48):012x}",
              "order_id": f"114-{r.randint(1000000, 9999999)}-{r.randint(1000000, 9999999)}",
              "amount": round(r.lognormvariate(3.4, 0.9), 2), "currency": "USD",
              "latency_ms": int(r.lognormvariate(3.8 + (1.8 if level in ("ERROR", "FATAL") else 0), 0.6)), "msg": msg}
        return json.dumps(ev, separators=(",", ":")), \
            "risk" if level in ("ERROR", "FATAL") else "warn" if level == "WARN" else "info"

    def gen(feed):
        return event(feed) if feed.rng.random() < 0.4 else alb(feed)
    return gen


# ------------------------------------------------------------------ fictional military command network
_OPS = ["op.kestrel", "op.viper", "op.falcon", "op.harrier", "op.osprey", "svc.relay", "svc.tracker"]
_UNITS = ["1ST-SIG-BN", "CYBER-CMD-7", "AOC-NORTH", "FIRES-DIV-3", "LOGISTICS-9"]
_CLS = ["UNCLASS", "CUI", "SECRET", "TOP SECRET"]
# (signature, name, cef severity, PRI severity, label)
_DEF_CALM = [("4001", "Encryption key rotation completed", 3, 6), ("4002", "Radar track feed heartbeat", 1, 6),
             ("4003", "Badge access granted", 2, 6), ("4004", "Secure message relayed", 2, 6),
             ("4005", "Cross-domain transfer approved", 4, 5)]
_DEF_WARN = [("4101", "SATCOM link degraded", 6, 4), ("4102", "Badge access denied at SCIF door", 7, 4),
             ("4103", "Failed login to command console", 6, 4), ("4104", "Time sync drift on tactical node", 5, 4)]
_DEF_CRIT = [("4201", "Unauthorized device on secure enclave", 9, 2), ("4202", "Classified document accessed above clearance", 10, 2),
             ("4203", "Crypto module tamper detected", 10, 2), ("4204", "Two-person integrity violation", 9, 2),
             ("4205", "Data exfiltration attempt blocked", 10, 2), ("4206", "USB mass storage on air-gapped host", 9, 2),
             ("4207", "GPS spoofing indicators on navigation feed", 9, 2),
             ("4208", "Firmware integrity check failed on fire-control node", 10, 2)]


def defense(seed: int):
    import random
    pools = lg.IPPools(random.Random(seed))

    def gen(feed):
        r, risk = feed.rng, feed.mood.risk
        w = blend([45, 30, 25], [5, 20, 75], risk)
        tier = r.choices([_DEF_CALM, _DEF_WARN, _DEF_CRIT], w)[0]
        sig, name, cs, ps = r.choice(tier)
        crit = tier is _DEF_CRIT
        src = r.choice(pools.attackers) if crit and r.random() < 0.6 else f"10.20.{r.randint(1, 9)}.{r.randint(2, 250)}"
        cls = r.choice(_CLS[2:]) if crit else r.choice(_CLS)
        ext = (f"rt={int(datetime.now().timestamp() * 1000)} suser={r.choice(_OPS)} src={src} "
               f"dst=10.20.{r.randint(1, 9)}.{r.randint(2, 250)} cs1Label=classification cs1={cls} "
               f"cs2Label=unit cs2={r.choice(_UNITS)} cn1Label=clearance cn1={r.randint(1, 5)} "
               f"outcome={'failure' if ps < 6 else 'success'} msg={name}")
        ts = lg.syslog_ts(datetime.now())
        line = f"<{4 * 8 + ps}>{ts} jcn-gw01 CEF:0|SentinelDef|JCN-Gateway|7.2|{sig}|{name}|{cs}|{ext}"
        return line, sev_from_pri(line)
    return gen
