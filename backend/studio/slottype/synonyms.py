"""Curated key-name synonym table (spec §8.8) and free-text literal context.

Keys are lower-cased and stripped of separators before lookup, so `src_ip`, `srcIP` and
`src-ip` all resolve the same way.
"""

from __future__ import annotations

import re

# key -> (ocsf path, confidence, transform or None)
SYNONYMS: dict[str, tuple[str, float, str | None]] = {}


def _add(paths: str, conf: float, transform: str | None, *keys: str) -> None:
    for k in keys:
        SYNONYMS[k] = (paths, conf, transform)


_add("src_endpoint.ip", 0.95, "to_ip",
     "srcip", "src", "sip", "sourceip", "saddr", "srcaddr", "sourceaddress", "clientip",
     "source", "ipsrc", "s_ip", "origin")
_add("src_endpoint.port", 0.95, "to_int",
     "spt", "srcport", "sport", "sourceport", "srcprt", "s_port", "clientport")
_add("src_endpoint.hostname", 0.85, None, "shost", "srchost", "sourcehost", "clienthost")
_add("src_endpoint.mac", 0.9, None, "smac", "srcmac", "sourcemac")
_add("src_endpoint.interface_name", 0.8, None, "srcintf", "srcif", "ifin", "inint", "interfacein")
_add("dst_endpoint.ip", 0.95, "to_ip",
     "dstip", "dst", "dip", "destip", "daddr", "dstaddr", "destinationaddress", "serverip",
     "destination", "ipdst", "d_ip", "target")
_add("dst_endpoint.port", 0.95, "to_int",
     "dpt", "dstport", "dport", "destport", "destinationport", "d_port", "serverport")
_add("dst_endpoint.hostname", 0.85, None, "dhost", "dsthost", "desthost", "serverhost")
_add("dst_endpoint.mac", 0.9, None, "dmac", "dstmac", "destmac")
_add("dst_endpoint.interface_name", 0.8, None, "dstintf", "dstif", "ifout", "outint", "interfaceout")
_add("connection_info.protocol_name", 0.9, "lowercase",
     "proto", "protocol", "ipproto", "transport", "service")
_add("connection_info.protocol_num", 0.85, "to_int", "protonum", "protocolnumber", "ipprotonum")
_add("connection_info.uid", 0.85, None,
     "connid", "connectionid", "sessionid", "sessid", "sessionuid", "flowid", "cid")
_add("connection_info.direction_id", 0.8, None, "direction", "dir", "flowdirection")
_add("connection_info.tcp_flags", 0.8, None, "tcpflags", "flags")
_add("action_id", 0.9, None, "act", "action", "disposition", "verdict", "result", "outcome")
_add("user.name", 0.9, None,
     "user", "suser", "username", "usr", "account", "accountname", "login", "loginname",
     "duser", "targetuser", "principal")
_add("user.uid", 0.8, None, "uid", "userid", "suid", "duid")
_add("user.domain", 0.8, None, "domain", "userdomain", "realm")
_add("device.hostname", 0.8, None, "dvchost", "devicehostname", "deviceName", "devname", "hostname")
_add("device.ip", 0.8, "to_ip", "dvc", "dvchost_ip", "deviceaddress", "devip")
_add("traffic.bytes", 0.85, "to_int", "bytes", "totalbytes", "len", "length", "size")
_add("traffic.bytes_in", 0.85, "to_int", "bytesin", "rcvdbyte", "rcvd", "inbytes", "rxbytes")
_add("traffic.bytes_out", 0.85, "to_int", "bytesout", "sentbyte", "sent", "outbytes", "txbytes")
_add("traffic.packets", 0.85, "to_int", "packets", "pkts", "packetcount")
_add("policy.name", 0.8, None, "policy", "policyname", "rule", "rulename", "policyid", "ruleid")
_add("severity_id", 0.7, "to_int", "severity", "sev", "level", "priority")
_add("message", 0.7, None, "msg", "message", "description", "text", "reason")
_add("duration", 0.8, "to_int", "duration", "dur", "elapsed")
_add("http_request.url.text", 0.9, None, "url", "requesturl", "uri", "request")
_add("http_request.http_method", 0.9, None, "method", "requestmethod", "httpmethod", "verb")
_add("http_request.user_agent", 0.9, None, "useragent", "ua", "requestclientapplication")
_add("http_request.referrer", 0.85, None, "referer", "referrer")
_add("http_response.code", 0.9, "to_int", "status", "statuscode", "httpstatus", "responsecode")
_add("query.hostname", 0.85, None, "query", "qname", "dnsquery", "queryname")
_add("query.type", 0.8, None, "qtype", "querytype", "dnstype")
_add("time", 0.7, "ts_parse", "rt", "timestamp", "eventtime", "starttime", "date", "start")

_SEP = re.compile(r"[^a-z0-9]+")


def normalise_key(key: str) -> str:
    return _SEP.sub("", (key or "").strip().lower())


def lookup(key: str) -> tuple[str, float, str | None] | None:
    """Resolve a KV/CEF key name, or a derived slot name, to an OCSF path."""
    k = normalise_key(key)
    if not k:
        return None
    hit = SYNONYMS.get(k)
    if hit:
        return hit
    # de-pluralise / strip common prefixes before giving up
    for candidate in (k.rstrip("s"), k.removeprefix("cs"), k.removeprefix("field")):
        hit = SYNONYMS.get(candidate)
        if hit:
            return (hit[0], max(hit[1] - 0.1, 0.1), hit[2])
    return None


# Literal context in free text informs the role of the slot that follows (spec §8.8).
CONTEXT_ROLE: dict[str, str] = {
    "from": "src", "src": "src", "source": "src", "by": "src", "client": "src",
    "to": "dst", "dst": "dst", "destination": "dst", "for": "dst", "server": "dst",
    "user": "user", "username": "user", "account": "user", "as": "user",
    "on": "device", "interface": "iface", "port": "port", "proto": "proto",
}

ROLE_PATHS = {
    ("src", "ip"): "src_endpoint.ip", ("src", "ipv4"): "src_endpoint.ip",
    ("src", "ipv6"): "src_endpoint.ip", ("src", "port"): "src_endpoint.port",
    ("src", "hostname"): "src_endpoint.hostname", ("src", "mac"): "src_endpoint.mac",
    ("src", "word"): "src_endpoint.hostname",
    ("dst", "ip"): "dst_endpoint.ip", ("dst", "ipv4"): "dst_endpoint.ip",
    ("dst", "ipv6"): "dst_endpoint.ip", ("dst", "port"): "dst_endpoint.port",
    ("dst", "hostname"): "dst_endpoint.hostname", ("dst", "mac"): "dst_endpoint.mac",
    ("dst", "word"): "dst_endpoint.hostname",
    ("user", "word"): "user.name", ("user", "quoted"): "user.name",
    ("user", "hostname"): "user.name", ("user", "text"): "user.name",
}

_WORD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def context_role(prev_lit: str) -> str | None:
    """Last meaningful word of the preceding literal, e.g. ' for ' -> dst."""
    words = _WORD.findall(prev_lit or "")
    for w in reversed(words):
        role = CONTEXT_ROLE.get(w.lower())
        if role:
            return role
    return None
