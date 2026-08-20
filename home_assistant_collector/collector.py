#!/usr/bin/env python3
"""Reliable outbound Home Assistant sensor collector for the Soter normality service."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import math
import os
import secrets
import sqlite3
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

VERSION = "0.1.0"
OPTIONS_PATH = Path(os.environ.get("SOTER_OPTIONS_PATH", "/data/options.json"))
DATABASE_PATH = Path(os.environ.get("SOTER_DATABASE_PATH", "/data/collector.sqlite3"))
HA_API = os.environ.get("SOTER_HA_API", "http://supervisor/core/api")
HA_WEBSOCKET = os.environ.get("SOTER_HA_WEBSOCKET", "ws://supervisor/core/websocket")
LOG = logging.getLogger("soter-collector")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


@dataclass(frozen=True)
class Entity:
    entity_id: str
    kind: str
    label: str | None = None


@dataclass(frozen=True)
class Settings:
    ingest_url: str
    household_id: str
    collector_id: str
    ingest_secret: str
    entities: dict[str, Entity]
    upload_interval: int
    backfill_hours: int

    @classmethod
    def load(cls, path: Path = OPTIONS_PATH) -> "Settings":
        raw = json.loads(path.read_text(encoding="utf-8"))
        configured: dict[str, Entity] = {}
        for item in raw.get("entities", []):
            entity = Entity(str(item["entity_id"]), str(item["kind"]), str(item.get("label") or "") or None)
            if entity.kind not in {"motion", "current", "power"}:
                raise ValueError(f"Unsupported kind for {entity.entity_id}: {entity.kind}")
            configured[entity.entity_id] = entity
        secret = str(raw.get("ingest_secret") or "")
        if len(secret) < 32:
            raise ValueError("ingest_secret must contain at least 32 characters")
        if not configured:
            raise ValueError("Configure at least one movement, current, or power entity")
        url = str(raw["firebase_ingest_url"]).rstrip("/")
        if not url.startswith("https://"):
            raise ValueError("firebase_ingest_url must use HTTPS")
        return cls(
            ingest_url=url,
            household_id=str(raw["household_id"]),
            collector_id=str(raw["collector_id"]),
            ingest_secret=secret,
            entities=configured,
            upload_interval=int(raw.get("upload_interval_seconds", 60)),
            backfill_hours=int(raw.get("history_backfill_hours", 336)),
        )


class Store:
    def __init__(self, path: Path = DATABASE_PATH):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, observed_at TEXT NOT NULL, payload TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self.db.commit()

    def add(self, event: dict[str, Any]) -> bool:
        cursor = self.db.execute(
            "INSERT OR IGNORE INTO events(id, observed_at, payload) VALUES (?, ?, ?)",
            (event["id"], event["observedAt"], json.dumps(event, separators=(",", ":"), ensure_ascii=False)),
        )
        self.db.commit()
        self.db.execute("DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY observed_at DESC LIMIT -1 OFFSET 100000)")
        self.db.commit()
        return cursor.rowcount == 1

    def batch(self, limit: int = 300) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT payload FROM events ORDER BY observed_at, id LIMIT ?", (limit,)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def remove(self, ids: list[str]) -> None:
        self.db.executemany("DELETE FROM events WHERE id = ?", ((event_id,) for event_id in ids))
        self.db.commit()

    def depth(self) -> int:
        return int(self.db.execute("SELECT COUNT(*) FROM events").fetchone()[0])

    def get(self, key: str) -> str | None:
        row = self.db.execute("SELECT value FROM state WHERE key = ?", (key,)).fetchone()
        return str(row[0]) if row else None

    def set(self, key: str, value: str) -> None:
        self.db.execute("INSERT INTO state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))
        self.db.commit()


def event_from_state(entity: Entity, state: dict[str, Any], cutoff: datetime | None = None) -> dict[str, Any] | None:
    observed_raw = state.get("last_changed") or state.get("last_updated")
    if not observed_raw or state.get("state") is None:
        return None
    try:
        observed = parse_time(str(observed_raw))
    except ValueError:
        return None
    if cutoff and observed < cutoff:
        return None
    value = str(state["state"])
    try:
        numeric: float | None = float(value)
        if not math.isfinite(numeric):
            numeric = None
    except ValueError:
        numeric = None
    attributes = state.get("attributes") if isinstance(state.get("attributes"), dict) else {}
    event_id = hashlib.sha256(f"{entity.entity_id}|{iso(observed)}|{value}".encode()).hexdigest()
    return {
        "id": event_id,
        "entityId": entity.entity_id,
        "kind": entity.kind,
        "state": value,
        "numericValue": numeric,
        "observedAt": iso(observed),
        "unit": attributes.get("unit_of_measurement"),
        "friendlyName": entity.label or attributes.get("friendly_name"),
    }


def signature(secret: str, timestamp: str, nonce: str, body: bytes) -> str:
    digest = hashlib.sha256(body).hexdigest()
    canonical = f"{timestamp}\n{nonce}\n{digest}".encode()
    return hmac.new(secret.encode(), canonical, hashlib.sha256).hexdigest()


class Collector:
    def __init__(self, settings: Settings, store: Store, token: str):
        self.settings = settings
        self.store = store
        self.token = token
        self.started_at = store.get("started_at") or iso(utc_now())
        store.set("started_at", self.started_at)

    def ha_json(self, path: str) -> Any:
        request = urllib.request.Request(
            f"{HA_API}{path}", headers={"Authorization": f"Bearer {self.token}", "Accept": "application/json", "User-Agent": f"SoterCollector/{VERSION}"},
        )
        with urllib.request.urlopen(request, timeout=90, context=ssl.create_default_context()) as response:
            return json.load(response)

    def remember(self, event: dict[str, Any] | None) -> int:
        return int(bool(event and self.store.add(event)))

    def backfill(self) -> int:
        now = utc_now()
        saved = self.store.get("history_cursor")
        start = parse_time(saved) - timedelta(minutes=5) if saved else now - timedelta(hours=self.settings.backfill_hours)
        start = max(start, now - timedelta(days=90))
        inserted = 0
        cursor = start
        LOG.info("History recovery from %s to %s", iso(start), iso(now))
        while cursor < now:
            end = min(cursor + timedelta(hours=24), now)
            query = urllib.parse.urlencode({
                "filter_entity_id": ",".join(self.settings.entities),
                "end_time": iso(end),
            })
            path = f"/history/period/{urllib.parse.quote(iso(cursor), safe='')}?{query}"
            history = self.ha_json(path)
            for series in history if isinstance(history, list) else []:
                remembered: str | None = None
                for state in series if isinstance(series, list) else []:
                    if not isinstance(state, dict):
                        continue
                    remembered = str(state.get("entity_id") or remembered or "") or None
                    entity = self.settings.entities.get(remembered or "")
                    if entity:
                        inserted += self.remember(event_from_state(entity, state, cursor))
            self.store.set("history_cursor", iso(end))
            cursor = end
        self.store.set("last_backfill_at", iso(now))
        LOG.info("History recovery complete: %d new events queued", inserted)
        return inserted

    def upload(self) -> bool:
        events = self.store.batch()
        now = utc_now()
        payload = {
            "version": 1,
            "householdId": self.settings.household_id,
            "collectorId": self.settings.collector_id,
            "sentAt": iso(now),
            "events": events,
            "health": {
                "version": VERSION,
                "queueDepth": max(0, self.store.depth() - len(events)),
                "lastBackfillAt": self.store.get("last_backfill_at"),
            },
        }
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        timestamp = str(int(now.timestamp()))
        nonce = secrets.token_urlsafe(24)
        request = urllib.request.Request(self.settings.ingest_url, data=body, method="POST", headers={
            "Content-Type": "application/json",
            "User-Agent": f"SoterCollector/{VERSION}",
            "X-Soter-Timestamp": timestamp,
            "X-Soter-Nonce": nonce,
            "X-Soter-Signature": signature(self.settings.ingest_secret, timestamp, nonce, body),
        })
        try:
            with urllib.request.urlopen(request, timeout=45, context=ssl.create_default_context()) as response:
                response.read()
                if response.status not in {200, 202}:
                    raise RuntimeError(f"ingest returned HTTP {response.status}")
        except urllib.error.HTTPError as error:
            detail = error.read(512).decode("utf-8", "replace")
            if error.code == 409:
                LOG.warning("Firebase reported a replay; treating the idempotent batch as accepted")
            else:
                raise RuntimeError(f"ingest returned HTTP {error.code}: {detail}") from error
        if events:
            self.store.remove([event["id"] for event in events])
        LOG.info("Upload accepted: %d events, %d still queued", len(events), self.store.depth())
        return True

    def connect(self):
        import websocket  # Installed in the app image; kept lazy so unit tests need only the standard library.

        socket = websocket.create_connection(HA_WEBSOCKET, timeout=30, enable_multithread=False)
        hello = json.loads(socket.recv())
        if hello.get("type") != "auth_required":
            socket.close()
            raise RuntimeError(f"unexpected WebSocket greeting: {hello.get('type')}")
        socket.send(json.dumps({"type": "auth", "access_token": self.token}))
        authenticated = json.loads(socket.recv())
        if authenticated.get("type") != "auth_ok":
            socket.close()
            raise RuntimeError(f"Home Assistant authentication failed: {authenticated.get('message', authenticated.get('type'))}")
        socket.send(json.dumps({"id": 1, "type": "subscribe_events", "event_type": "state_changed"}))
        subscribed = json.loads(socket.recv())
        if subscribed.get("type") != "result" or not subscribed.get("success"):
            socket.close()
            raise RuntimeError("Home Assistant rejected the state_changed subscription")
        socket.settimeout(1)
        LOG.info("Subscribed to Home Assistant state changes")
        return socket

    def consume(self, message: str) -> None:
        parsed = json.loads(message)
        if parsed.get("type") != "event":
            return
        data = parsed.get("event", {}).get("data", {})
        entity = self.settings.entities.get(str(data.get("entity_id") or ""))
        state = data.get("new_state")
        if entity and isinstance(state, dict) and self.remember(event_from_state(entity, state)):
            LOG.debug("Queued %s state at %s", entity.entity_id, state.get("last_changed"))

    def run(self) -> None:
        import websocket

        socket = None
        next_upload = 0.0
        next_backfill = 0.0
        reconnect_delay = 1
        while True:
            current = time.monotonic()
            if current >= next_upload:
                try:
                    self.upload()
                except Exception as error:  # Network and server errors are retried without dropping the queue.
                    LOG.error("Upload failed; queued events retained: %s", error)
                next_upload = current + self.settings.upload_interval
            if current >= next_backfill:
                try:
                    self.backfill()
                    next_backfill = time.monotonic() + 3600
                except Exception as error:
                    LOG.error("History recovery failed; will retry: %s", error)
                    next_backfill = time.monotonic() + min(300, reconnect_delay * 10)
            if socket is None:
                try:
                    socket = self.connect()
                    reconnect_delay = 1
                    next_backfill = 0
                except Exception as error:
                    LOG.error("Home Assistant WebSocket connection failed: %s", error)
                    time.sleep(reconnect_delay)
                    reconnect_delay = min(60, reconnect_delay * 2)
                    continue
            try:
                self.consume(socket.recv())
            except websocket.WebSocketTimeoutException:
                continue
            except Exception as error:
                LOG.warning("Home Assistant WebSocket disconnected: %s", error)
                try:
                    socket.close()
                except Exception:
                    pass
                socket = None


def main() -> int:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    try:
        settings = Settings.load()
        token = os.environ.get("SUPERVISOR_TOKEN", "")
        if not token:
            raise ValueError("SUPERVISOR_TOKEN is unavailable; homeassistant_api must be enabled")
        LOG.info("Starting Soter Activity Collector %s for %s with %d entities", VERSION, settings.collector_id, len(settings.entities))
        Collector(settings, Store(), token).run()
    except KeyboardInterrupt:
        return 0
    except Exception as error:
        LOG.critical("Collector stopped: %s", error)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
