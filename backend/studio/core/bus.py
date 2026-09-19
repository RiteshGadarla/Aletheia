"""Control-topic publisher (CONTRACTS §3). No-op when no broker is configured."""

from __future__ import annotations

import json
import logging
from typing import Any

log = logging.getLogger("studio.bus")

CONTROL_TOPIC = "control"


class ControlPublisher:
    def __init__(self, brokers: str = "") -> None:
        self.brokers = (brokers or "").strip()
        self._producer = None
        self.sent: list[dict[str, Any]] = []        # kept for the UI / tests
        if self.brokers:
            try:
                from confluent_kafka import Producer
                self._producer = Producer({"bootstrap.servers": self.brokers})
            except Exception as exc:
                log.warning("kafka producer unavailable (%s); control messages buffered only",
                            type(exc).__name__)

    def publish_pack_approved(self, pack: str, version: int, checksum: str,
                              source_id: str | None = None) -> dict[str, Any]:
        """Spec §6.10: on approval publish {pack_id, version, checksum} on `control`."""
        msg = {"type": "pack_approved", "pack_id": pack, "version": version, "checksum": checksum}
        self.sent.append(msg)
        if self._producer is not None:
            try:
                self._producer.produce(
                    CONTROL_TOPIC,
                    key=(source_id or pack).encode(),
                    value=json.dumps(msg).encode(),
                )
                self._producer.flush(5)
            except Exception as exc:
                log.error("control publish failed: %s", type(exc).__name__)
        return msg
