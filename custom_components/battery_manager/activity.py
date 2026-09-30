"""Compact, bounded activity journal; disk work stays off the event loop."""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
import json
import logging
import sqlite3
from collections import deque
from pathlib import Path
from time import time

CATEGORIES = ("commands", "scheduler", "weather", "notifications", "users")
MAX_BYTES = 50_000_000
RETENTION_SECONDS = 30 * 86400
_LOGGER = logging.getLogger(__name__)


class ActivityJournal:
    def __init__(self, hass, max_bytes=MAX_BYTES, retention=RETENTION_SECONDS):
        self.hass = hass
        self.path = Path(hass.config.path(".storage", "battery_manager.journal.sqlite"))
        self.max_bytes = max_bytes
        self.retention = retention
        self._pending = deque()
        self._lock = asyncio.Lock()

    @contextmanager
    def _connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=20)
        db.execute("PRAGMA auto_vacuum=FULL")
        db.execute("PRAGMA journal_mode=DELETE")
        db.execute("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, stamp REAL NOT NULL, category TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, battery TEXT, actor TEXT)")
        db.execute("CREATE INDEX IF NOT EXISTS events_category_id ON events(category,id)")
        try:
            with db:
                yield db
        finally:
            db.close()

    def add(self, category, kind, content, battery=None, actor=None):
        """Queue one event; never block a battery command on a disk write."""
        if category not in CATEGORIES:
            raise ValueError(category)
        # A failing disk must not grow the queue without bound.
        if len(self._pending) >= 10000:
            self._pending.popleft()
        self._pending.append((time(), category, str(kind)[:200], str(content)[:4000], battery, actor))

    def _write(self, batch):
        with self._connect() as db:
            db.executemany("INSERT INTO events(stamp,category,kind,content,battery,actor) VALUES (?,?,?,?,?,?)", batch)
            db.execute("DELETE FROM events WHERE stamp < ?", (time() - self.retention,))
        # FULL auto-vacuum reclaims pages on each commit. Bound the actual
        # shared database file, including indexes, rather than text alone.
        with self._connect() as db:
            while self.path.stat().st_size > self.max_bytes:
                count = db.execute("SELECT count(*) FROM events").fetchone()[0]
                if not count:
                    break
                excess = self.path.stat().st_size - self.max_bytes
                number = min(count, max(50, int(count * excess / self.path.stat().st_size) + 50))
                db.execute("DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY id LIMIT ?)", (number,))
                db.commit()

    async def async_flush(self):
        async with self._lock:
            batch = list(self._pending)
            self._pending.clear()
            try:
                await self.hass.async_add_executor_job(self._write, batch)
            except Exception:
                self._pending.extendleft(reversed(batch))
                while len(self._pending) > 10000:
                    self._pending.popleft()
                _LOGGER.exception("Unable to persist Battery Manager activity journal")

    def _read(self, category, before, search, since, until, limit):
        clauses, values = ["category = ?", "stamp >= ?"], [category, max(since or 0, time() - self.retention)]
        if before:
            clauses.append("id < ?")
            values.append(before)
        if until:
            clauses.append("stamp < ?")
            values.append(until)
        if search:
            clauses.append("(instr(lower(kind), lower(?)) > 0 OR instr(lower(content), lower(?)) > 0)")
            values.extend([search, search])
        with self._connect() as db:
            rows = db.execute("SELECT id,stamp,category,kind,content,battery,actor FROM events WHERE " + " AND ".join(clauses) + " ORDER BY id DESC LIMIT ?", (*values, limit + 1)).fetchall()
            count = db.execute("SELECT count(*) FROM events").fetchone()[0]
        keys = ("id", "stamp", "category", "kind", "content", "battery", "actor")
        return {"entries": [dict(zip(keys, row)) for row in rows[:limit]], "next": rows[limit - 1][0] if len(rows) > limit else None, "count": count, "bytes": self.path.stat().st_size, "max_bytes": self.max_bytes, "days": 30}

    async def async_read(self, category, before=None, search="", since=None, until=None, limit=200):
        await self.async_flush()
        async with self._lock:
            return await self.hass.async_add_executor_job(self._read, category, before, search, since, until, limit)

    def _clear(self):
        with self._connect() as db:
            db.execute("DELETE FROM events")
        with self._connect() as db:
            db.execute("VACUUM")

    async def async_clear(self):
        async with self._lock:
            self._pending.clear()
            await self.hass.async_add_executor_job(self._clear)


def configuration_changes(old, new):
    """Describe all saved changes; group large planning edits by battery."""
    def compact(value):
        text = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        return text if len(text) < 180 else text[:177] + "…"

    def walk(a, b, prefix):
        if a == b:
            return
        if prefix.endswith("schedules") or prefix.endswith("schedule"):
            yield f"Modification de la planification {prefix}"
        elif isinstance(a, dict) and isinstance(b, dict):
            for key in sorted(a.keys() | b.keys()):
                yield from walk(a.get(key), b.get(key), f"{prefix}.{key}" if prefix else key)
        else:
            yield f"{prefix} : {compact(a)} → {compact(b)}"

    old_items = {str(b.get("id") or b.get("name")): b for b in old.get("batteries", [])}
    new_items = {str(b.get("id") or b.get("name")): b for b in new.get("batteries", [])}
    for key in old_items.keys() | new_items.keys():
        a, b = old_items.get(key), new_items.get(key)
        if a is None:
            yield f"Création de la batterie {b['name']}"
        elif b is None:
            yield f"Suppression de la batterie {a['name']}"
        else:
            yield from walk(a, b, b["name"])
    for field, label in (("schedule_profiles", "Profil"),):
        previous = {x["id"]: x for x in old.get(field, [])}
        current = {x["id"]: x for x in new.get(field, [])}
        for key in previous.keys() | current.keys():
            a, b = previous.get(key), current.get(key)
            if a is None:
                yield f"Création du {label.lower()} {b['name']}"
            elif b is None:
                yield f"Suppression du {label.lower()} {a['name']}"
            else:
                yield from walk(a, b, f"{label} {b['name']}")
    old_notifications, new_notifications = old.get("notifications", {}), new.get("notifications", {})
    a_targets = {t["id"]: t for t in old_notifications.get("targets", [])}
    b_targets = {t["id"]: t for t in new_notifications.get("targets", [])}
    for key in a_targets.keys() | b_targets.keys():
        a, b = a_targets.get(key), b_targets.get(key)
        if a is None:
            yield f"Création de la cible {b['name']} ({b['action']}, {b['start']}–{b['end']})"
        elif b is None:
            yield f"Suppression de la cible {a['name']}"
        else:
            yield from walk(a, b, f"Cible {b['name']}")
    yield from walk({k: v for k, v in old_notifications.items() if k != "targets"}, {k: v for k, v in new_notifications.items() if k != "targets"}, "Notifications")
    excluded = {"batteries", "notifications", "schedule_profiles"}
    yield from walk({k: v for k, v in old.items() if k not in excluded}, {k: v for k, v in new.items() if k not in excluded}, "")
