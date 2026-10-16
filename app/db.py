"""SQLite storage for tasks, item requests, and notes.

A single file (labhub.db) in the lab-hub folder. WAL mode so reads during a
write don't block. No ORM on purpose — the schema is tiny and this keeps the
dependency surface minimal for a Raspberry Pi.
"""
import sqlite3
from datetime import datetime

from .config import CONFIG


def _conn():
    con = sqlite3.connect(CONFIG["db_path"], timeout=5)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    return con


def init_db():
    con = _conn()
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS tasks(
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            text       TEXT    NOT NULL,
            done       INTEGER NOT NULL DEFAULT 0,
            created_at TEXT    NOT NULL
        );
        CREATE TABLE IF NOT EXISTS requests(
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            item         TEXT    NOT NULL,
            requested_by TEXT    DEFAULT '',
            status       TEXT    NOT NULL DEFAULT 'new',
            notes        TEXT    DEFAULT '',
            created_at   TEXT    NOT NULL
        );
        CREATE TABLE IF NOT EXISTS notes(
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            author     TEXT    DEFAULT '',
            body       TEXT    NOT NULL,
            pinned     INTEGER NOT NULL DEFAULT 0,
            created_at TEXT    NOT NULL
        );
        """
    )
    con.commit()
    con.close()


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def query(sql, args=()):
    con = _conn()
    try:
        rows = [dict(r) for r in con.execute(sql, args).fetchall()]
    finally:
        con.close()
    return rows


def execute(sql, args=()):
    con = _conn()
    try:
        cur = con.execute(sql, args)
        con.commit()
        last = cur.lastrowid
    finally:
        con.close()
    return last
