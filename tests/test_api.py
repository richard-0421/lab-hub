"""HTTP API (uvicorn in a background thread) + config, calendar, version."""
import json
import logging
import os
import shutil
import socket
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import uvicorn  # noqa: E402

from app import calendar_feed  # noqa: E402
from app.config import github_enabled, load_config, redacted  # noqa: E402
from app.main import compute_version, create_app, git_head_sha, static_files_hash  # noqa: E402
from tests.mock_github import MockGitHub  # noqa: E402

logging.getLogger("labhub").setLevel(logging.CRITICAL)

TS = "2026-10-16T14:00:00Z"
SECRET = "ghp_SECRETtoken0417xyz"
STATIC_DIR = os.path.join(ROOT, "static")


def add_task(tid, title, rank=0):
    return {"op": "add", "coll": "tasks", "item": {"id": tid, "title": title, "rank": rank}, "ts": TS, "by": "test"}


class ServerThread(object):
    """Run a uvicorn server for ``app`` on a free localhost port."""

    def __init__(self, app):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.port = self.sock.getsockname()[1]
        config = uvicorn.Config(app, host="127.0.0.1", port=self.port, log_level="warning", lifespan="on")
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(target=self.server.run, kwargs={"sockets": [self.sock]}, daemon=True)

    @property
    def url(self):
        return "http://127.0.0.1:%d" % self.port

    def start(self):
        self.thread.start()
        end = time.time() + 15
        while not self.server.started:
            if time.time() > end or not self.thread.is_alive():
                raise RuntimeError("uvicorn did not start")
            time.sleep(0.02)
        return self

    def stop(self):
        self.server.should_exit = True
        self.thread.join(15)
        self.sock.close()


def http(method, url, body=None, raw=None, headers=None):
    data = raw if raw is not None else (json.dumps(body).encode("utf-8") if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    if data is not None and "Content-Type" not in (headers or {}):
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, {k.lower(): v for k, v in exc.headers.items()}, exc.read()
        finally:
            exc.close()


def get_json(url):
    status, headers, data = http("GET", url)
    return status, headers, json.loads(data.decode("utf-8"))


def wait_until(pred, timeout=8.0, step=0.05):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(step)
    return pred()


class _ApiBase(unittest.TestCase):
    env = {}

    @classmethod
    def make_env(cls, tmp):
        return {}

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="labhub-api-")
        cls.mock = None
        cls.prepare(cls.tmp)
        env = {
            "LABHUB_STATE_DIR": os.path.join(cls.tmp, "state"),
            "LABHUB_DB_PATH": os.path.join(cls.tmp, "labhub.db"),
            "LABHUB_NAME": "Test Lab",
        }
        env.update(cls.make_env(cls.tmp))
        cls.cfg = load_config(config_path=os.path.join(cls.tmp, "no-config.json"), environ=env)
        cls.app = create_app(cls.cfg)
        cls.srv = ServerThread(cls.app).start()
        cls.base = cls.srv.url

    @classmethod
    def prepare(cls, tmp):
        pass

    @classmethod
    def tearDownClass(cls):
        cls.srv.stop()
        if cls.mock is not None:
            cls.mock.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)


class LocalApiTests(_ApiBase):
    @classmethod
    def make_env(cls, tmp):
        # repo set but no token -> local-only
        return {"LABHUB_GITHUB_REPO": "richard-0417/lab-hub"}

    def test_config(self):
        status, headers, body = get_json(self.base + "/api/config")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("cache-control"), "no-store")
        self.assertIs(body["labhub"], True)
        self.assertEqual(body["name"], "Test Lab")
        self.assertEqual(body["client"], "lab-pi")
        self.assertEqual(body["theme"], "dark")
        self.assertEqual(body["github"], {
            "enabled": False,
            "repo": "richard-0417/lab-hub",
            "branch": "data",
            "path": "board.json",
            "pages_url": "https://richard-0417.github.io/lab-hub/",
            "file_url": "https://github.com/richard-0417/lab-hub/blob/data/board.json",
        })
        self.assertEqual(body["calendar"], {"configured": False})

    def test_board_ops_and_rev(self):
        status, _, body = get_json(self.base + "/api/board")
        self.assertEqual(status, 200)
        rev0 = body["rev"]
        self.assertIsInstance(rev0, int)
        self.assertEqual(body["sync"]["state"], "off")
        self.assertIn("board", body)

        _, _, same = get_json(self.base + "/api/board?rev=%d" % rev0)
        self.assertEqual(same["unchanged"], True)
        self.assertEqual(same["rev"], rev0)
        self.assertNotIn("board", same)
        self.assertIn("sync", same)
        _, _, junk = get_json(self.base + "/api/board?rev=abc")
        self.assertIn("board", junk)

        status, headers, data = http("POST", self.base + "/api/ops", {"ops": [add_task("t-api-1", "From API", -5)]})
        self.assertEqual(status, 200, data)
        self.assertEqual(headers.get("cache-control"), "no-store")
        res = json.loads(data)
        self.assertGreater(res["rev"], rev0)
        self.assertIn("From API", [t["title"] for t in res["board"]["tasks"]])
        self.assertEqual(res["sync"]["pending"], 0)

        _, _, after = get_json(self.base + "/api/board?rev=%d" % rev0)
        self.assertIn("board", after)
        self.assertEqual(after["rev"], res["rev"])

    def test_ops_validation(self):
        _, _, before = get_json(self.base + "/api/board")
        bad = [add_task("t-ok", "fine"), {"op": "update", "coll": "tasks", "id": "t-ok", "ts": TS, "set": {"status": "nope"}}]
        status, _, data = http("POST", self.base + "/api/ops", {"ops": bad})
        self.assertEqual(status, 400)
        err = json.loads(data)
        self.assertEqual(err["index"], 1)
        self.assertIn("status", err["error"])
        _, _, after = get_json(self.base + "/api/board")
        self.assertEqual(after["rev"], before["rev"])
        self.assertNotIn("t-ok", [t["id"] for t in after["board"]["tasks"]])

        for payload in ({"ops": []}, {"ops": "x"}, {"nope": 1}, [1],
                        {"ops": [add_task("t-%d" % i, "x") for i in range(501)]}):
            status, _, data = http("POST", self.base + "/api/ops", payload)
            self.assertEqual(status, 400, payload if not isinstance(payload, dict) else list(payload))
            self.assertIsNone(json.loads(data)["index"])
        status, _, data = http("POST", self.base + "/api/ops", raw=b"{not json")
        self.assertEqual(status, 400)
        self.assertEqual(set(json.loads(data)), {"error", "index"})
        status, _, _ = http("POST", self.base + "/api/ops", {"ops": [add_task("t-%d" % i, "x") for i in range(500)]})
        self.assertEqual(status, 200)

    def test_sync_endpoints_local_only(self):
        _, _, body = get_json(self.base + "/api/sync")
        self.assertEqual(body["state"], "off")
        self.assertFalse(body["enabled"])
        status, _, data = http("POST", self.base + "/api/sync")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["state"], "off")

    def test_calendar_unconfigured(self):
        _, _, body = get_json(self.base + "/api/calendar")
        self.assertEqual(body, {"configured": False, "events": []})

    def test_version(self):
        status, headers, body = get_json(self.base + "/api/version")
        self.assertEqual(status, 200)
        self.assertIsInstance(body["version"], str)
        self.assertTrue(body["version"])
        self.assertEqual(body["version"], compute_version(ROOT, STATIC_DIR))

    def test_index_served_with_no_cache(self):
        status, headers, data = http("GET", self.base + "/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers.get("content-type", ""))
        self.assertEqual(headers.get("cache-control"), "no-cache")
        with open(os.path.join(STATIC_DIR, "index.html"), "rb") as f:
            self.assertEqual(data, f.read())

    def test_unknown_api_is_json_404(self):
        status, headers, data = http("GET", self.base + "/api/nope")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(data), {"error": "not found"})
        self.assertEqual(headers.get("cache-control"), "no-store")
        status, _, _ = http("GET", self.base + "/definitely-missing.js")
        self.assertEqual(status, 404)

    def test_unicode_round_trip(self):
        title = "Café ✓ \U0001F9EA"
        status, _, data = http("POST", self.base + "/api/ops", {"ops": [add_task("t-uni", title)]})
        self.assertEqual(status, 200)
        _, _, body = get_json(self.base + "/api/board")
        self.assertIn(title, [t["title"] for t in body["board"]["tasks"]])


class GitHubApiTests(_ApiBase):
    @classmethod
    def prepare(cls, tmp):
        cls.mock = MockGitHub(repo="richard-0417/lab-hub", token=SECRET).start()
        # a legacy db is imported (and pushed) at startup
        con = sqlite3.connect(os.path.join(tmp, "labhub.db"))
        con.executescript("CREATE TABLE tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, "
                          "done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);")
        con.execute("INSERT INTO tasks(text, done, created_at) VALUES('Legacy task', 0, '2026-07-01T09:00:00')")
        con.commit()
        con.close()

    @classmethod
    def make_env(cls, tmp):
        return {
            "LABHUB_GITHUB_REPO": "richard-0417/lab-hub",
            "LABHUB_GITHUB_TOKEN": "  %s \n" % SECRET,
            "LABHUB_GITHUB_API": cls.mock.url,
            "LABHUB_SYNC_INTERVAL": "60",
        }

    def remote_titles(self):
        doc = self.mock.get_file_json("data", "board.json")
        return sorted(t["title"] for t in doc["tasks"]) if doc else []

    def test_config_never_leaks_token(self):
        self.assertEqual(self.cfg["github_token"], SECRET)
        status, _, data = http("GET", self.base + "/api/config")
        self.assertEqual(status, 200)
        self.assertNotIn(SECRET.encode(), data)
        self.assertNotIn(b"token", data.lower())
        body = json.loads(data)
        self.assertTrue(body["github"]["enabled"])
        for path in ("/api/sync", "/api/board", "/api/version", "/api/calendar"):
            _, _, data = http("GET", self.base + path)
            self.assertNotIn(SECRET.encode(), data, path)
        self.assertNotIn(SECRET, json.dumps(redacted(self.cfg)))

    def test_legacy_import_and_ops_reach_github(self):
        self.assertTrue(wait_until(lambda: "Legacy task" in self.remote_titles()), self.remote_titles())
        status, _, data = http("POST", self.base + "/api/ops", {"ops": [add_task("t-gh-1", "Pushed by kick")]})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(data)["sync"]["enabled"])
        self.assertTrue(wait_until(lambda: "Pushed by kick" in self.remote_titles()), self.remote_titles())
        self.assertTrue(wait_until(lambda: get_json(self.base + "/api/sync")[2]["pending"] == 0))
        _, _, sync = get_json(self.base + "/api/sync")
        self.assertEqual(sync["state"], "ok")
        self.assertEqual(sync["repo"], "richard-0417/lab-hub")

    def test_manual_sync_pulls_web_edit(self):
        self.assertTrue(wait_until(lambda: self.mock.get_file_text("data", "board.json") is not None))
        self.assertTrue(wait_until(lambda: get_json(self.base + "/api/sync")[2]["pending"] == 0))
        doc = self.mock.get_file_json("data", "board.json")
        doc["tasks"].append({"id": "t-web", "title": "Added on the web", "rank": 99})
        self.mock.set_file_text("data", "board.json", json.dumps(doc))
        status, _, data = http("POST", self.base + "/api/sync")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["state"], "ok")
        _, _, body = get_json(self.base + "/api/board")
        self.assertIn("Added on the web", [t["title"] for t in body["board"]["tasks"]])


# --------------------------------------------------------------------------- #
# config
# --------------------------------------------------------------------------- #
class ConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="labhub-cfg-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def load(self, file_obj=None, env=None):
        path = os.path.join(self.tmp, "config.json")
        if file_obj is not None:
            with open(path, "w") as f:
                f.write(file_obj if isinstance(file_obj, str) else json.dumps(file_obj))
        return load_config(base_dir=self.tmp, config_path=path, environ=env or {})

    def test_defaults(self):
        cfg = self.load()
        self.assertEqual(cfg["name"], "Lab Hub")
        self.assertEqual(cfg["port"], 8000)
        self.assertEqual(cfg["calendar_max_events"], 8)
        self.assertEqual(cfg["sync_interval"], 15)
        self.assertEqual(cfg["github_branch"], "data")
        self.assertEqual(cfg["github_path"], "board.json")
        self.assertEqual(cfg["github_api"], "https://api.github.com")
        self.assertEqual(cfg["client_name"], "lab-pi")
        self.assertEqual(cfg["pages_url"], "")
        self.assertEqual(cfg["state_dir"], os.path.join(self.tmp, "state"))
        self.assertEqual(cfg["db_path"], os.path.join(self.tmp, "labhub.db"))
        self.assertFalse(github_enabled(cfg))
        for key in ("data_dir", "csv_glob", "tracker_cmd", "monitor_points", "subgroup_name"):
            self.assertNotIn(key, cfg)

    def test_file_alias_env_and_coercion(self):
        cfg = self.load(
            {"subgroup_name": "Old Name", "port": "8100", "github_repo": "https://github.com/Richard-0417/lab-hub.git",
             "github_token": "file-token", "theme": "LIGHT", "data_dir": "x", "calendar_ics": "cal/lab.ics"},
            {"LABHUB_PORT": "9000", "LABHUB_SYNC_INTERVAL": "abc", "LABHUB_GITHUB_TOKEN": " ghp_ab\ncd \t",
             "LABHUB_CALENDAR_MAX_EVENTS": "3", "LABHUB_STATE_DIR": "/tmp/labhub-abs-state"},
        )
        self.assertEqual(cfg["name"], "Old Name")
        self.assertEqual(cfg["port"], 9000)
        self.assertEqual(cfg["sync_interval"], 15)
        self.assertEqual(cfg["calendar_max_events"], 3)
        self.assertEqual(cfg["github_token"], "ghp_abcd")
        self.assertEqual(cfg["github_repo"], "Richard-0417/lab-hub")
        self.assertEqual(cfg["pages_url"], "https://richard-0417.github.io/lab-hub/")
        self.assertEqual(cfg["theme"], "light")
        self.assertEqual(cfg["state_dir"], "/tmp/labhub-abs-state")
        self.assertEqual(cfg["calendar_ics"], os.path.join(self.tmp, "cal", "lab.ics"))
        self.assertNotIn("data_dir", cfg)
        self.assertTrue(github_enabled(cfg))
        self.assertEqual(redacted(cfg)["github_token"], "<set>")

    def test_name_beats_alias_and_env_alias(self):
        self.assertEqual(self.load({"subgroup_name": "Old", "name": "New"})["name"], "New")
        self.assertEqual(self.load(env={"LABHUB_SUBGROUP_NAME": "Env Old"})["name"], "Env Old")
        self.assertEqual(self.load(env={"LABHUB_SUBGROUP_NAME": "a", "LABHUB_NAME": "b"})["name"], "b")

    def test_bad_file_and_bad_repo(self):
        cfg = self.load("{nope")
        self.assertEqual(cfg["name"], "Lab Hub")
        cfg = self.load({"github_repo": "not a repo", "github_token": "t"})
        self.assertEqual(cfg["github_repo"], "")
        self.assertFalse(github_enabled(cfg))
        cfg = self.load({"github_repo": "richard-0417/richard-0417.github.io"})
        self.assertEqual(cfg["pages_url"], "https://richard-0417.github.io/")
        cfg = self.load({"pages_url": "https://lab.example.org/", "github_repo": "a/b", "theme": "neon"})
        self.assertEqual(cfg["pages_url"], "https://lab.example.org/")
        self.assertEqual(cfg["theme"], "dark")


# --------------------------------------------------------------------------- #
# calendar
# --------------------------------------------------------------------------- #
ICS = """BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Group meeting\\, room 2
LOCATION:Pierce 301
DTSTART:20261016T150000
DTEND:20261016T160000
END:VEVENT
BEGIN:VEVENT
SUMMARY:Old event
DTSTART:20261001T090000
DTEND:20261001T100000
END:VEVENT
BEGIN:VEVENT
SUMMARY:Lab cleanup day
DTSTART;VALUE=DATE:20261016
DTEND;VALUE=DATE:20261017
END:VEVENT
BEGIN:VEVENT
SUMMARY:No end
DTSTART:20261020T090000
END:VEVENT
BEGIN:VEVENT
SUMMARY:Long
  folded title
DTSTART:20261021T090000
DTEND:20261021T093000
END:VEVENT
END:VCALENDAR
"""


class CalendarTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="labhub-cal-")
        self.ics = os.path.join(self.tmp, "lab.ics")
        with open(self.ics, "w") as f:
            f.write(ICS)
        calendar_feed.clear_cache()

    def tearDown(self):
        calendar_feed.clear_cache()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_events_with_end(self):
        now = datetime(2026, 10, 16, 12, 0, 0)
        res = calendar_feed.get_events({"calendar_ics": self.ics, "calendar_max_events": 8}, now=now)
        self.assertTrue(res["configured"])
        summaries = [e["summary"] for e in res["events"]]
        self.assertEqual(summaries, ["Lab cleanup day", "Group meeting, room 2", "No end", "Long folded title"])
        by = {e["summary"]: e for e in res["events"]}
        self.assertEqual(by["Group meeting, room 2"]["end"], "2026-10-16T16:00:00")
        self.assertEqual(by["Group meeting, room 2"]["location"], "Pierce 301")
        self.assertIsNone(by["No end"]["end"])
        self.assertTrue(by["Lab cleanup day"]["all_day"])
        self.assertEqual(by["Lab cleanup day"]["end"], "2026-10-17T00:00:00")
        self.assertEqual(set(res["events"][0]), {"summary", "location", "start", "end", "all_day"})

    def test_max_events_and_unconfigured(self):
        now = datetime(2026, 10, 16, 12, 0, 0)
        res = calendar_feed.get_events({"calendar_ics": self.ics, "calendar_max_events": 2}, now=now)
        self.assertEqual(len(res["events"]), 2)
        self.assertEqual(calendar_feed.get_events({"calendar_ics": ""}), {"configured": False, "events": []})
        missing = calendar_feed.get_events({"calendar_ics": os.path.join(self.tmp, "nope.ics")}, now=now)
        self.assertEqual(missing, {"configured": True, "events": []})

    def test_last_good_copy_used_when_source_fails(self):
        cfg = {"calendar_ics": self.ics, "calendar_max_events": 8}
        first = calendar_feed.get_events(cfg, now=datetime(2026, 10, 16, 12))
        os.remove(self.ics)
        calendar_feed._cache["at"] = time.time() - calendar_feed.CACHE_SECONDS - 1
        again = calendar_feed.get_events(cfg, now=datetime(2026, 10, 16, 12))
        self.assertEqual(first, again)
        self.assertEqual(len(again["events"]), 4)


# --------------------------------------------------------------------------- #
# version
# --------------------------------------------------------------------------- #
class VersionTests(unittest.TestCase):
    SHA1 = "a" * 40
    SHA2 = "b" * 40

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="labhub-ver-")
        self.git = os.path.join(self.tmp, ".git")
        os.makedirs(os.path.join(self.git, "refs", "heads"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, rel, text):
        p = os.path.join(self.tmp, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(text)

    def test_loose_ref(self):
        self.write(".git/HEAD", "ref: refs/heads/main\n")
        self.write(".git/refs/heads/main", self.SHA1 + "\n")
        self.assertEqual(git_head_sha(self.tmp), self.SHA1)

    def test_packed_ref(self):
        self.write(".git/HEAD", "ref: refs/heads/main\n")
        self.write(".git/packed-refs", "# pack-refs with: peeled fully-peeled sorted\n%s refs/heads/main\n^%s\n"
                   % (self.SHA2, self.SHA1))
        self.assertEqual(git_head_sha(self.tmp), self.SHA2)

    def test_detached_head(self):
        self.write(".git/HEAD", self.SHA1 + "\n")
        self.assertEqual(git_head_sha(self.tmp), self.SHA1)

    def test_gitdir_file(self):
        real = os.path.join(self.tmp, "elsewhere.git")
        os.makedirs(os.path.join(real, "refs", "heads"))
        shutil.rmtree(self.git)
        self.write(".git", "gitdir: elsewhere.git\n")
        self.write("elsewhere.git/HEAD", "ref: refs/heads/dev\n")
        self.write("elsewhere.git/refs/heads/dev", self.SHA2)
        self.assertEqual(git_head_sha(self.tmp), self.SHA2)

    def test_fallback_static_hash(self):
        self.write(".git/HEAD", "ref: refs/heads/unborn\n")
        self.assertIsNone(git_head_sha(self.tmp))
        static = os.path.join(self.tmp, "static")
        self.write("static/index.html", "<html></html>")
        v1 = compute_version(self.tmp, static)
        self.assertTrue(v1.startswith("static-"))
        self.assertEqual(v1, static_files_hash(static))
        self.write("static/js/app.js", "console.log(1)")
        self.assertNotEqual(compute_version(self.tmp, static), v1)


if __name__ == "__main__":
    unittest.main()
