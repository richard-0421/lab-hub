"""app/migrate.py: one-time import of the legacy SQLite board."""
import json
import logging
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from app import migrate  # noqa: E402
from app.github_sync import SyncWorker  # noqa: E402
from app.store import Store  # noqa: E402
from tests.mock_github import MockGitHub  # noqa: E402

logging.getLogger("labhub").setLevel(logging.CRITICAL)

# the schema created by the old app/db.py
LEGACY_SCHEMA = """
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


def local_to_utc(naive_iso):
    dt = datetime.strptime(naive_iso, "%Y-%m-%dT%H:%M:%S").astimezone()
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class MigrateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="labhub migrate ")  # space on purpose
        self.db = os.path.join(self.tmp, "labhub.db")
        self.state = os.path.join(self.tmp, "state")
        con = sqlite3.connect(self.db)
        con.execute("PRAGMA journal_mode=WAL")
        con.executescript(LEGACY_SCHEMA)
        con.executemany("INSERT INTO tasks(text, done, created_at) VALUES(?,?,?)", [
            ("Calibrate pump", 0, "2026-07-01T09:00:00"),
            ("Order tips", 1, "2026-07-02T10:30:00"),
            ("Clean bench", 0, "2026-07-03T11:00:00"),
            ("   ", 0, "2026-07-03T11:00:00"),          # blank -> skipped
        ])
        con.executemany("INSERT INTO requests(item, requested_by, status, notes, created_at) VALUES(?,?,?,?,?)", [
            ("Gloves (M)", "Mei", "done", "", "2026-07-01T09:00:00"),
            ("Pipette tips", "Ann", "new", "200 uL", "2026-07-02T09:00:00"),
            ("Ethanol", "", "ordered", "", "not a date"),
        ])
        con.executemany("INSERT INTO notes(author, body, pinned, created_at) VALUES(?,?,?,?)", [
            ("Richard", "Freezer B is full\nuse A", 0, "2026-07-01T09:00:00"),
            ("Mei", "Group meeting moved", 1, "2026-07-02T09:00:00"),
        ])
        con.commit()
        con.close()
        self.cfg = {"db_path": self.db, "state_dir": self.state}

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_import_local_only_and_idempotent(self):
        store = Store(self.state, github_enabled=False)
        n = migrate.run_migration(self.cfg, store)
        self.assertEqual(n, 8)
        board = store.view()

        tasks = {t["id"]: t for t in board["tasks"]}
        self.assertEqual(set(tasks), {"t-legacy-1", "t-legacy-2", "t-legacy-3"})
        self.assertEqual(tasks["t-legacy-2"]["status"], "done")
        self.assertEqual(tasks["t-legacy-2"]["done_at"], local_to_utc("2026-07-02T10:30:00"))
        self.assertEqual(tasks["t-legacy-1"]["status"], "todo")
        self.assertEqual(tasks["t-legacy-1"]["done_at"], "")
        self.assertEqual(tasks["t-legacy-1"]["created_at"], local_to_utc("2026-07-01T09:00:00"))
        # old display order: open tasks first (newest first), then done
        self.assertEqual([t["id"] for t in board["tasks"]], ["t-legacy-3", "t-legacy-1", "t-legacy-2"])

        reqs = {r["id"]: r for r in board["requests"]}
        self.assertEqual(reqs["r-legacy-1"]["status"], "received")
        self.assertEqual(reqs["r-legacy-1"]["requested_by"], "Mei")
        self.assertEqual(reqs["r-legacy-2"]["notes"], "200 uL")
        self.assertEqual(reqs["r-legacy-3"]["status"], "ordered")
        self.assertRegex(reqs["r-legacy-3"]["created_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual([r["id"] for r in board["requests"]], ["r-legacy-2", "r-legacy-3", "r-legacy-1"])

        notes = {x["id"]: x for x in board["notes"]}
        self.assertTrue(notes["n-legacy-2"]["pinned"])
        self.assertEqual(notes["n-legacy-1"]["body"], "Freezer B is full\nuse A")
        self.assertEqual(notes["n-legacy-1"]["author"], "Richard")
        self.assertEqual(board["notes"][0]["id"], "n-legacy-2")

        marker = os.path.join(self.state, "migrated")
        self.assertTrue(os.path.exists(marker))
        with open(marker) as f:
            self.assertEqual(json.load(f)["ops"], 8)
        self.assertTrue(os.path.exists(self.db), "the legacy db must stay in place")

        # second run (fresh process): marker -> nothing happens
        rev = store.rev
        store2 = Store(self.state, github_enabled=False)
        self.assertEqual(migrate.run_migration(self.cfg, store2), 0)
        self.assertEqual(store2.view(), board)
        self.assertEqual(store.rev, rev)

        # even without the marker the deterministic ids make a re-import a no-op
        os.remove(marker)
        store3 = Store(self.state, github_enabled=False)
        before = store3.rev
        self.assertEqual(migrate.run_migration(self.cfg, store3), 8)
        self.assertEqual(store3.view(), board)
        self.assertEqual(store3.rev, before)

    def test_import_queues_ops_in_github_mode(self):
        store = Store(self.state, github_enabled=True, repo="richard-0417/lab-hub")
        self.assertEqual(migrate.run_migration(self.cfg, store), 8)
        pending = store.pending()
        self.assertEqual(len(pending), 8)
        self.assertTrue(all(op["op"] == "add" and op["by"] == "legacy import" for op in pending))
        self.assertEqual(len(store.view()["tasks"]), 3)

    def test_db_is_not_modified(self):
        with open(self.db, "rb") as f:
            before = f.read()
        migrate.run_migration(self.cfg, Store(self.state, github_enabled=False))
        with open(self.db, "rb") as f:
            self.assertEqual(f.read(), before)

    def test_missing_or_broken_db(self):
        store = Store(self.state, github_enabled=False)
        self.assertEqual(migrate.run_migration({"db_path": os.path.join(self.tmp, "nope.db"),
                                                "state_dir": self.state}, store), 0)
        self.assertFalse(os.path.exists(os.path.join(self.state, "migrated")))
        broken = os.path.join(self.tmp, "broken.db")
        with open(broken, "wb") as f:
            f.write(b"this is not sqlite" * 100)
        self.assertEqual(migrate.run_migration({"db_path": broken, "state_dir": self.state}, store), 0)
        self.assertFalse(os.path.exists(os.path.join(self.state, "migrated")))

    def test_empty_legacy_db_writes_marker(self):
        empty = os.path.join(self.tmp, "empty.db")
        con = sqlite3.connect(empty)
        con.executescript(LEGACY_SCHEMA)
        con.close()
        store = Store(self.state, github_enabled=False)
        self.assertEqual(migrate.run_migration({"db_path": empty, "state_dir": self.state}, store), 0)
        self.assertTrue(os.path.exists(os.path.join(self.state, "migrated")))

    def test_time_conversion(self):
        self.assertEqual(migrate.legacy_time_to_utc("2026-07-01T09:00:00"), local_to_utc("2026-07-01T09:00:00"))
        self.assertEqual(migrate.legacy_time_to_utc("2026-07-01T09:00:00+02:00"), "2026-07-01T07:00:00Z")
        self.assertIsNone(migrate.legacy_time_to_utc("garbage"))
        self.assertIsNone(migrate.legacy_time_to_utc(None))



class ReimportTests(unittest.TestCase):
    """A second import (new clone / empty state/, same labhub.db) must not
    bring back legacy items deleted on GitHub since the first one."""

    REPO = "richard-0417/lab-hub"

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="labhub-reimport-")
        self.db = os.path.join(self.tmp, "labhub.db")
        con = sqlite3.connect(self.db)
        con.executescript(LEGACY_SCHEMA)
        con.executemany("INSERT INTO tasks(text, done, created_at) VALUES(?,?,?)", [
            ("Calibrate pump", 0, "2026-07-01T09:00:00"),
            ("Order tips", 1, "2026-07-02T10:30:00"),
        ])
        con.commit()
        con.close()
        self.mock = MockGitHub(repo=self.REPO, token="t").start()
        self.cfg = {"github_repo": self.REPO, "github_branch": "data", "github_path": "board.json",
                    "github_token": "t", "github_api": self.mock.url, "client_name": "lab-pi"}

    def tearDown(self):
        self.mock.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def install(self, name):
        """A fresh install: its own state/ folder, the same legacy db."""
        state = os.path.join(self.tmp, name)
        store = Store(state, github_enabled=True, repo=self.REPO, api=self.mock.url)
        n = migrate.run_migration({"db_path": self.db, "state_dir": state}, store)
        return store, SyncWorker(store, self.cfg), n

    def remote_ids(self):
        return sorted(t["id"] for t in self.mock.get_file_json("data", "board.json")["tasks"])

    def test_deleted_legacy_items_stay_deleted(self):
        store, worker, n = self.install("state1")
        self.assertEqual(n, 2)
        self.assertEqual(worker.sync_once()["state"], "ok")
        self.assertEqual(self.remote_ids(), ["t-legacy-1", "t-legacy-2"])
        store.submit([{"op": "delete", "coll": "tasks", "id": "t-legacy-2", "ts": "2026-10-16T14:00:00Z"}])
        worker.sync_once()
        self.assertEqual(self.remote_ids(), ["t-legacy-1"])

        store2, worker2, n2 = self.install("state2")
        self.assertEqual(n2, 2)
        store2.submit([{"op": "add", "coll": "tasks", "item": {"id": "t-new", "title": "New"},
                        "ts": "2026-10-16T14:00:00Z"}])
        status = worker2.sync_once()
        self.assertEqual(status["state"], "ok")
        self.assertEqual(status["pending"], 0)
        self.assertEqual(self.remote_ids(), ["t-legacy-1", "t-new"])
        self.assertEqual(sorted(t["id"] for t in store2.view()["tasks"]), ["t-legacy-1", "t-new"])

    def test_first_import_still_reaches_github(self):
        store, worker, _ = self.install("state1")
        self.mock.set_file_text("data", "board.json", '{"tasks": [{"id": "t-web", "title": "Web"}]}')
        self.assertEqual(worker.sync_once()["pending"], 0)
        self.assertEqual(self.remote_ids(), ["t-legacy-1", "t-legacy-2", "t-web"])


if __name__ == "__main__":
    unittest.main()
