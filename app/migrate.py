"""One-time import of the legacy SQLite board (``labhub.db`` from the old
dashboard). See docs/ARCHITECTURE.md section 4 "Legacy migration".

Every legacy row becomes an ``add`` op with a deterministic id
(``t-legacy-<id>``, ``r-legacy-<id>``, ``n-legacy-<id>``), submitted through
the store, so importing twice is harmless. ``state/migrated`` records that the
import ran. The .db file is opened read-only and left in place.
"""
import json
import logging
import os
import pathlib
import sqlite3
from datetime import datetime, timezone

from .board import canonical_timestamp, now_iso, validate_op

log = logging.getLogger("labhub.migrate")

MARKER = "migrated"
BY = "legacy import"

# old display orders (from the old app/main.py)
_ORDER = {
    "tasks": "ORDER BY done ASC, id DESC",
    "requests": "ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'ordered' THEN 1 ELSE 2 END, id DESC",
    "notes": "ORDER BY pinned DESC, id DESC",
}
_REQUEST_STATUS = {"new": "new", "ordered": "ordered", "done": "received", "received": "received"}


def _open_probe(uri):
    con = sqlite3.connect(uri, uri=True, timeout=5)
    try:
        con.execute("SELECT name FROM sqlite_master LIMIT 1").fetchall()
    except sqlite3.Error:
        con.close()
        raise
    return con


def _connect_ro(db_path):
    uri = pathlib.Path(os.path.abspath(db_path)).as_uri()
    try:
        return _open_probe(uri + "?mode=ro")
    except sqlite3.Error:
        # e.g. a WAL database whose -shm can't be created: read it as immutable
        return _open_probe(uri + "?immutable=1")


def read_legacy(db_path):
    """{"tasks": [row dicts in old display order], "requests": [...], "notes": [...]}"""
    con = _connect_ro(db_path)
    try:
        con.row_factory = sqlite3.Row
        tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        out = {}
        for table, order in _ORDER.items():
            if table not in tables:
                out[table] = []
                continue
            try:
                rows = con.execute("SELECT * FROM %s %s" % (table, order)).fetchall()
            except sqlite3.Error:  # columns missing in some odd old version
                rows = con.execute("SELECT * FROM %s" % table).fetchall()
            out[table] = [dict(r) for r in rows]
        return out
    finally:
        con.close()


def legacy_time_to_utc(value):
    """Old ``created_at`` values are naive *local* time
    (``datetime.now().isoformat(timespec="seconds")``); return canonical UTC."""
    if not isinstance(value, str) or not value.strip():
        return None
    s = value.strip()
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return canonical_timestamp(s)
    if dt.tzinfo is None:
        dt = dt.astimezone()  # interpret as local time
    return canonical_timestamp(dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))


def _text(v):
    if v is None:
        return ""
    return v if isinstance(v, str) else str(v)


def build_ops(legacy, fallback_ts=None):
    """Turn legacy rows into ``add`` ops (invalid rows are skipped)."""
    fallback_ts = fallback_ts or now_iso()
    ops = []

    def add(coll, item, ts):
        op = {"op": "add", "coll": coll, "item": item, "ts": ts, "by": BY}
        if validate_op(op) is None:
            ops.append(op)
        else:
            log.warning("skipping legacy %s row %s: %s", coll, item.get("id"), validate_op(op))

    for rank, row in enumerate(legacy.get("tasks") or (), start=1):
        ts = legacy_time_to_utc(row.get("created_at")) or fallback_ts
        done = bool(row.get("done"))
        add("tasks", {
            "id": "t-legacy-%s" % row.get("id"),
            "title": _text(row.get("text")),
            "status": "done" if done else "todo",
            "rank": rank,
            "created_at": ts,
            "updated_at": ts,
            # the old schema kept no completion time; created_at is the best guess
            "done_at": ts if done else "",
        }, ts)

    for rank, row in enumerate(legacy.get("requests") or (), start=1):
        ts = legacy_time_to_utc(row.get("created_at")) or fallback_ts
        status = _REQUEST_STATUS.get(_text(row.get("status")).strip().lower(), "new")
        add("requests", {
            "id": "r-legacy-%s" % row.get("id"),
            "item": _text(row.get("item")),
            "requested_by": _text(row.get("requested_by")),
            "status": status,
            "notes": _text(row.get("notes")),
            "rank": rank,
            "created_at": ts,
            "updated_at": ts,
        }, ts)

    for rank, row in enumerate(legacy.get("notes") or (), start=1):
        ts = legacy_time_to_utc(row.get("created_at")) or fallback_ts
        add("notes", {
            "id": "n-legacy-%s" % row.get("id"),
            "body": _text(row.get("body")),
            "author": _text(row.get("author")),
            "pinned": bool(row.get("pinned")),
            "rank": rank,
            "created_at": ts,
            "updated_at": ts,
        }, ts)
    return ops


def run_migration(cfg, store):
    """Import ``cfg['db_path']`` once. Returns the number of ops submitted
    (0 when there was nothing to do)."""
    db_path = cfg.get("db_path")
    state_dir = cfg.get("state_dir")
    if not db_path or not state_dir:
        return 0
    marker = os.path.join(state_dir, MARKER)
    if os.path.exists(marker) or not os.path.isfile(db_path):
        return 0
    try:
        legacy = read_legacy(db_path)
    except sqlite3.Error as exc:
        log.warning("could not read legacy database %s: %s", db_path, exc)
        return 0
    ops = build_ops(legacy)
    if ops:
        store.submit(ops)
    os.makedirs(state_dir, exist_ok=True)
    info = {"at": now_iso(), "db_path": db_path, "ops": len(ops)}
    tmp = marker + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(info, f)
    os.replace(tmp, marker)
    if ops:
        log.info("imported %d item(s) from legacy %s", len(ops), db_path)
    return len(ops)
