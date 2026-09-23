"""Browser notification feed: a thread-safe ring buffer the UI polls with `after=<id>` (§13.3)."""
from __future__ import annotations

import threading
from collections import deque
from typing import Any

from .models import now_iso

FIELDS = ("status", "source", "rule_id", "rule_name", "severity", "summary", "description",
          "labels", "value", "contact_point_id", "contact_point_name", "starts_at", "ends_at", "link")


class NotificationFeed:
    def __init__(self, cap: int = 500) -> None:
        self._ring: deque[dict[str, Any]] = deque(maxlen=cap)
        self._lock = threading.Lock()
        self._last = 0

    def add(self, **kw: Any) -> dict[str, Any]:
        item = {k: kw.get(k) for k in FIELDS}
        item["labels"] = dict(item["labels"] or {})
        for k in ("rule_name", "severity", "summary", "description", "contact_point_id",
                  "contact_point_name"):
            item[k] = str(item[k] or "")
        with self._lock:
            self._last += 1
            item = {"id": self._last, "received_at": now_iso(), **item}
            self._ring.append(item)
        return dict(item)

    def list(self, after: int | None = None, limit: int = 50) -> dict[str, Any]:
        limit = max(1, min(int(limit), 200))
        with self._lock:
            items = list(self._ring)
            last = self._last
        if after is None:
            page = items[-limit:]
        else:
            page = [i for i in items if i["id"] > after][:limit]
        # The cursor is the last id returned; with nothing new it is the server's newest id, so a
        # client holding a stale cursor from before a restart resynchronises.
        return {"items": [dict(i) for i in page], "last_id": page[-1]["id"] if page else last}
