"""Settings / pack / audit repositories. Postgres when DATABASE_URL is set, else in-memory."""

from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol

log = logging.getLogger("studio.db")


@dataclass
class SettingRow:
    key: str
    value: str
    encrypted: bool = False
    updated_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


class Repo(Protocol):
    def settings_all(self) -> dict[str, SettingRow]: ...
    def settings_set(self, key: str, value: str, encrypted: bool) -> None: ...
    def settings_delete(self, key: str) -> None: ...
    def packs_list(self) -> list[dict[str, Any]]: ...
    def pack_get(self, pack: str, version: int) -> dict[str, Any] | None: ...
    def pack_upsert(self, row: dict[str, Any]) -> None: ...
    def pack_set_status(self, pack: str, version: int, status: str, **extra: Any) -> None: ...
    def audit(self, actor: str, action: str, subject: str | None, detail: dict[str, Any]) -> None: ...
    def audit_list(self, limit: int = 100) -> list[dict[str, Any]]: ...


class MemoryRepo:
    """Dev / test backend. Same semantics as the Postgres tables."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._settings: dict[str, SettingRow] = {}
        self._packs: dict[tuple[str, int], dict[str, Any]] = {}
        self._audit: list[dict[str, Any]] = []

    def settings_all(self) -> dict[str, SettingRow]:
        with self._lock:
            return dict(self._settings)

    def settings_set(self, key: str, value: str, encrypted: bool) -> None:
        with self._lock:
            self._settings[key] = SettingRow(key, value, encrypted)

    def settings_delete(self, key: str) -> None:
        with self._lock:
            self._settings.pop(key, None)

    def packs_list(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(v) for v in self._packs.values()]

    def pack_get(self, pack: str, version: int) -> dict[str, Any] | None:
        with self._lock:
            row = self._packs.get((pack, version))
            return dict(row) if row else None

    def pack_upsert(self, row: dict[str, Any]) -> None:
        with self._lock:
            row = dict(row)
            row.setdefault("created_at", datetime.now(timezone.utc))
            self._packs[(row["pack"], int(row["version"]))] = row

    def pack_set_status(self, pack: str, version: int, status: str, **extra: Any) -> None:
        with self._lock:
            row = self._packs.get((pack, version))
            if row is None:
                raise KeyError(f"{pack}/{version}")
            row["status"] = status
            row.update({k: v for k, v in extra.items() if v is not None})

    def audit(self, actor: str, action: str, subject: str | None, detail: dict[str, Any]) -> None:
        with self._lock:
            self._audit.append({
                "at": datetime.now(timezone.utc), "actor": actor, "action": action,
                "subject": subject, "detail": detail,
            })

    def audit_list(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._lock:
            return list(reversed(self._audit))[:limit]


class PostgresRepo:
    """Thin psycopg wrapper over deploy/postgres/init.sql."""

    def __init__(self, dsn: str) -> None:
        import psycopg  # imported lazily so the Studio runs without a DB
        from psycopg.rows import dict_row

        self._psycopg = psycopg
        self._dict_row = dict_row
        self._dsn = dsn

    def _conn(self):
        return self._psycopg.connect(self._dsn, row_factory=self._dict_row, autocommit=True)

    def settings_all(self) -> dict[str, SettingRow]:
        with self._conn() as c, c.cursor() as cur:
            cur.execute("SELECT key, value, encrypted, updated_at FROM settings")
            return {r["key"]: SettingRow(r["key"], r["value"], r["encrypted"], r["updated_at"])
                    for r in cur.fetchall()}

    def settings_set(self, key: str, value: str, encrypted: bool) -> None:
        with self._conn() as c, c.cursor() as cur:
            cur.execute(
                "INSERT INTO settings (key, value, encrypted, updated_at) VALUES (%s,%s,%s, now()) "
                "ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, "
                "encrypted=EXCLUDED.encrypted, updated_at=now()",
                (key, value, encrypted),
            )

    def settings_delete(self, key: str) -> None:
        with self._conn() as c, c.cursor() as cur:
            cur.execute("DELETE FROM settings WHERE key=%s", (key,))

    def packs_list(self) -> list[dict[str, Any]]:
        with self._conn() as c, c.cursor() as cur:
            cur.execute("SELECT * FROM packs ORDER BY pack, version")
            return cur.fetchall()

    def pack_get(self, pack: str, version: int) -> dict[str, Any] | None:
        with self._conn() as c, c.cursor() as cur:
            cur.execute("SELECT * FROM packs WHERE pack=%s AND version=%s", (pack, version))
            return cur.fetchone()

    def pack_upsert(self, row: dict[str, Any]) -> None:
        with self._conn() as c, c.cursor() as cur:
            cur.execute(
                "INSERT INTO packs (pack, version, status, yaml, checksum, author, origin) "
                "VALUES (%(pack)s,%(version)s,%(status)s,%(yaml)s,%(checksum)s,%(author)s,%(origin)s) "
                "ON CONFLICT (pack, version) DO UPDATE SET status=EXCLUDED.status, "
                "yaml=EXCLUDED.yaml, checksum=EXCLUDED.checksum, origin=EXCLUDED.origin",
                {"author": None, "origin": "heuristic", **row},
            )

    def pack_set_status(self, pack: str, version: int, status: str, **extra: Any) -> None:
        with self._conn() as c, c.cursor() as cur:
            cur.execute(
                "UPDATE packs SET status=%s, approver=COALESCE(%s, approver), "
                "approved_at=COALESCE(%s, approved_at), "
                "replay_report_sha256=COALESCE(%s, replay_report_sha256) "
                "WHERE pack=%s AND version=%s",
                (status, extra.get("approver"), extra.get("approved_at"),
                 extra.get("replay_report_sha256"), pack, version),
            )

    def audit(self, actor: str, action: str, subject: str | None, detail: dict[str, Any]) -> None:
        with self._conn() as c, c.cursor() as cur:
            cur.execute(
                "INSERT INTO audit_log (actor, action, subject, detail) VALUES (%s,%s,%s,%s)",
                (actor, action, subject, json.dumps(detail)),
            )

    def audit_list(self, limit: int = 100) -> list[dict[str, Any]]:
        with self._conn() as c, c.cursor() as cur:
            cur.execute("SELECT * FROM audit_log ORDER BY id DESC LIMIT %s", (limit,))
            return cur.fetchall()


def build_repo(dsn: str | None = None) -> Repo:
    dsn = dsn if dsn is not None else os.environ.get("ALETHEIA_PG_DSN") or os.environ.get("DATABASE_URL")
    if not dsn:
        log.warning("no ALETHEIA_PG_DSN/DATABASE_URL: settings and pack registry are in-memory only")
        return MemoryRepo()
    try:
        repo = PostgresRepo(dsn)
        repo.settings_all()
        return repo
    except Exception as exc:  # never block startup on the DB
        log.warning("postgres unavailable (%s); falling back to in-memory repo", type(exc).__name__)
        return MemoryRepo()
