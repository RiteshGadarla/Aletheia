"""Live generator servers: severity mix shifts with risk and formats stay parseable."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "sources", "generators", "servers"))
import formats  # noqa: E402
from common import Feed  # noqa: E402

TYPES = ["asa", "fortigate", "web", "vpn", "cef", "app"]


def _mix(name, risk, n=400):
    f = Feed(name, getattr(formats, name)(7), 1, 7)
    f.mood.forced = risk
    f.mood.step(0)
    for _ in range(n):
        f.emit()
    return f


def _bad(f):
    return f.counts["risk"] + f.counts["warn"]


def test_every_type_emits_lines():
    for t in TYPES:
        f = _mix(t, 0.04, 50)
        assert f.total == 50 and all(e[2] for e in f.ring)


def test_risk_raises_risky_share():
    for t in TYPES:
        calm, hot = _bad(_mix(t, 0.0)), _bad(_mix(t, 0.9))
        assert hot > calm, t


def test_app_lines_are_json():
    f = _mix("app", 0.5, 50)
    assert all(json.loads(e[2])["level"] for e in f.ring)

