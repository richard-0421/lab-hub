"""HTTP API (uvicorn in a background thread) + config, calendar, version."""
import asyncio
import errno
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
from datetime import datetime, timedelta
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import uvicorn  # noqa: E402

from app import calendar_feed  # noqa: E402
from app import config as app_config  # noqa: E402
from app import main as app_main  # noqa: E402
from app.config import git_origin_repo, github_config_error, github_enabled, load_config, redacted  # noqa: E402
from app.main import compute_version, create_app, git_head_sha, static_files_hash  # noqa: E402
from app.store import StoreUnavailable  # noqa: E402
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
        end = time.monotonic() + 15
        while not self.server.started:
            if time.monotonic() > end or not self.thread.is_alive():
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
    # monotonic: a wall-clock jump (e.g. the Mac waking from sleep mid-test)
    # must not end the wait early
    end = time.monotonic() + timeout
    while time.monotonic() < end:
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
        return {"LABHUB_GITHUB_REPO": "richard-0421/lab-hub"}

    def test_config(self):
        status, headers, body = get_json(self.base + "/api/config")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("cache-control"), "no-store")
        self.assertIs(body["labhub"], True)
        self.assertEqual(body["name"], "Test Lab")
        self.assertEqual(body["client"], "lab-pi")
        self.assertEqual(body["theme"], "dark")
        github = dict(body["github"])
        self.assertIsNone(github.pop("last_error", None))  # only set for an unusable repo/branch/path
        self.assertEqual(github, {
            "enabled": False,
            "repo": "richard-0421/lab-hub",
            "branch": "data",
            "path": "board.json",
            "pages_url": "https://richard-0421.github.io/lab-hub/",
            "file_url": "https://github.com/richard-0421/lab-hub/blob/data/board.json",
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
        self.assertIsNone(body["last_error"])  # no token is not an error
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

    def test_config_has_lan_url(self):
        _, _, body = get_json(self.base + "/api/config")
        self.assertIn("lan_url", body)
        if body["lan_url"] is not None:  # None on a machine without a LAN address
            self.assertRegex(body["lan_url"], r"^http://\d+\.\d+\.\d+\.\d+:%d$" % self.srv.port)

    def test_lan_url_failure_never_breaks_config(self):
        with mock.patch.object(app_main, "primary_lan_ipv4", side_effect=RuntimeError("boom")):
            status, _, body = get_json(self.base + "/api/config")
        self.assertEqual(status, 200)
        self.assertIs(body["labhub"], True)
        self.assertIsNone(body["lan_url"])

    def board_ids(self):
        return [t["id"] for t in get_json(self.base + "/api/board")[2]["board"]["tasks"]]

    def test_ops_need_json_content_type(self):
        body = {"ops": [add_task("t-ctype", "simple request")]}
        for ctype in ("text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; b=x"):
            status, _, data = http("POST", self.base + "/api/ops", body, headers={"Content-Type": ctype})
            self.assertEqual(status, 415, ctype)
            self.assertEqual(json.loads(data)["index"], None)
        self.assertNotIn("t-ctype", self.board_ids())
        status, _, _ = http("POST", self.base + "/api/ops", body,
                            headers={"Content-Type": "application/json; charset=utf-8"})
        self.assertEqual(status, 200)

    def test_cross_site_writes_are_refused(self):
        body = {"ops": [add_task("t-xsite", "cross-site")]}
        for hdrs in ({"Origin": "https://evil.example"}, {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"},
                     {"Sec-Fetch-Site": "same-site"}, {"Origin": "http://127.0.0.1:1"},
                     {"Origin": self.base.replace("http:", "https:")}):
            status, _, data = http("POST", self.base + "/api/ops", body, headers=hdrs)
            self.assertEqual(status, 403, hdrs)
            self.assertIn("cross-site", json.loads(data)["error"])
            status, _, _ = http("POST", self.base + "/api/sync", headers=hdrs)
            self.assertEqual(status, 403, hdrs)
        self.assertNotIn("t-xsite", self.board_ids())
        # reads, the page itself and scripts without an Origin still work
        status, _, _ = http("GET", self.base + "/api/board", headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 200)
        status, _, _ = http("POST", self.base + "/api/ops", {"ops": [add_task("t-same", "same origin")]},
                            headers={"Origin": self.base, "Sec-Fetch-Site": "same-origin"})
        self.assertEqual(status, 200)
        status, _, _ = http("POST", self.base + "/api/sync", headers={"Origin": self.base.replace("127.0.0.1", "localhost"),
                                                                    "Host": "localhost:%d" % self.srv.port})
        self.assertEqual(status, 200)

    def test_unknown_host_names_are_refused(self):
        bad = {"Host": "rebind.evil.example:%d" % self.srv.port}
        for path in ("/api/board", "/api/config", "/api/calendar", "/"):
            status, _, data = http("GET", self.base + path, headers=bad)
            self.assertEqual(status, 400, path)
            self.assertIn(b"allowed_hosts", data)
        status, _, _ = http("POST", self.base + "/api/ops", {"ops": [add_task("t-rebind", "x")]}, headers=bad)
        self.assertEqual(status, 400)
        self.assertNotIn("t-rebind", self.board_ids())
        for host in ("localhost", "127.0.0.1", "[::1]", socket.gethostname()):
            status, _, _ = http("GET", self.base + "/api/config", headers={"Host": "%s:%d" % (host, self.srv.port)})
            self.assertEqual(status, 200, host)

    def test_body_size_limit(self):
        with mock.patch.object(app_main, "MAX_BODY_BYTES", 1000):
            status, _, data = http("POST", self.base + "/api/ops", {"ops": [add_task("t-big", "x" * 3000)]})
        self.assertEqual(status, 413)
        self.assertIn("too large", json.loads(data)["error"])
        self.assertNotIn("t-big", self.board_ids())

    def test_unsaved_change_is_503(self):
        store = self.app.state.store
        with mock.patch.object(store, "submit", side_effect=StoreUnavailable("the Pi could not save the change")):
            status, _, data = http("POST", self.base + "/api/ops", {"ops": [add_task("t-503", "x")]})
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(data), {"error": "the Pi could not save the change", "index": None})

    def test_unicode_round_trip(self):
        title = "Café ✓ \U0001F9EA"
        status, _, data = http("POST", self.base + "/api/ops", {"ops": [add_task("t-uni", title)]})
        self.assertEqual(status, 200)
        _, _, body = get_json(self.base + "/api/board")
        self.assertIn(title, [t["title"] for t in body["board"]["tasks"]])


class BadGitHubConfigApiTests(_ApiBase):
    """An unusable github_branch: the server still starts, runs local-only,
    never contacts GitHub, and says why."""

    ERROR = "config: github_branch 'x..y' is not a valid branch name"

    @classmethod
    def prepare(cls, tmp):
        cls.mock = MockGitHub(repo="richard-0421/lab-hub", token=SECRET).start()

    @classmethod
    def make_env(cls, tmp):
        return {
            "LABHUB_GITHUB_REPO": "richard-0421/lab-hub",
            "LABHUB_GITHUB_TOKEN": SECRET,
            "LABHUB_GITHUB_BRANCH": "x..y",
            "LABHUB_GITHUB_API": cls.mock.url,
            "LABHUB_SYNC_INTERVAL": "2",
        }

    def test_sync_is_off_and_the_board_still_works(self):
        self.assertEqual(github_config_error(self.cfg), self.ERROR)
        self.assertFalse(github_enabled(self.cfg))
        status, _, data = http("GET", self.base + "/api/config")
        self.assertEqual(status, 200)
        self.assertNotIn(SECRET.encode(), data)
        github = json.loads(data)["github"]
        self.assertIs(github["enabled"], False)
        self.assertEqual(github["repo"], "richard-0421/lab-hub")
        self.assertEqual(github["branch"], "x..y")  # shown as configured
        _, _, sync = get_json(self.base + "/api/sync")
        self.assertIs(sync["enabled"], False)
        self.assertEqual(sync["state"], "off")
        status, _, data = http("POST", self.base + "/api/ops", {"ops": [add_task("t-badcfg", "Still works")]})
        self.assertEqual(status, 200)
        self.assertIn("Still works", [t["title"] for t in json.loads(data)["board"]["tasks"]])
        status, _, data = http("POST", self.base + "/api/sync")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["state"], "off")
        self.assertEqual(self.mock.count(), 0)  # nothing was ever sent to GitHub

    def test_config_error_is_reported(self):
        _, _, body = get_json(self.base + "/api/config")
        self.assertEqual(body["github"]["last_error"], self.ERROR)
        self.assertIs(body["github"]["enabled"], False)
        self.assertEqual(body["github"]["file_url"], "")  # never a link built from an unusable branch/path
        _, _, sync = get_json(self.base + "/api/sync")
        self.assertEqual(sync["state"], "off")
        self.assertIs(sync["enabled"], False)
        self.assertEqual(sync["last_error"], self.ERROR)
        _, _, board = get_json(self.base + "/api/board")
        self.assertEqual(board["sync"]["last_error"], self.ERROR)
        status, _, data = http("POST", self.base + "/api/sync")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["last_error"], self.ERROR)
        # not persisted: sync.json never holds it, so fixing the config clears it
        with open(os.path.join(self.cfg["state_dir"], "sync.json"), encoding="utf-8") as f:
            self.assertIsNone(json.load(f)["last_error"])
        self.assertNotIn(SECRET, json.dumps([body, sync, board]))


class GitHubApiTests(_ApiBase):
    @classmethod
    def prepare(cls, tmp):
        cls.mock = MockGitHub(repo="richard-0421/lab-hub", token=SECRET).start()
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
            "LABHUB_GITHUB_REPO": "richard-0421/lab-hub",
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
        self.assertEqual(sync["repo"], "richard-0421/lab-hub")

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
            {"subgroup_name": "Old Name", "port": "8100", "github_repo": "https://github.com/Richard-0421/lab-hub.git",
             "github_token": "file-token", "theme": "LIGHT", "data_dir": "x", "calendar_ics": "cal/lab.ics"},
            {"LABHUB_PORT": "9000", "LABHUB_SYNC_INTERVAL": "abc", "LABHUB_GITHUB_TOKEN": " ghp_ab\ncd \t",
             "LABHUB_CALENDAR_MAX_EVENTS": "3", "LABHUB_STATE_DIR": "/tmp/labhub-abs-state"},
        )
        self.assertEqual(cfg["name"], "Old Name")
        self.assertEqual(cfg["port"], 9000)
        self.assertEqual(cfg["sync_interval"], 15)
        self.assertEqual(cfg["calendar_max_events"], 3)
        self.assertEqual(cfg["github_token"], "ghp_abcd")
        self.assertEqual(cfg["github_repo"], "Richard-0421/lab-hub")
        self.assertEqual(cfg["pages_url"], "https://richard-0421.github.io/lab-hub/")
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
        cfg = self.load({"github_repo": "richard-0421/richard-0421.github.io"})
        self.assertEqual(cfg["pages_url"], "https://richard-0421.github.io/")
        cfg = self.load({"pages_url": "https://lab.example.org/", "github_repo": "a/b", "theme": "neon"})
        self.assertEqual(cfg["pages_url"], "https://lab.example.org/")
        self.assertEqual(cfg["theme"], "dark")

    def test_allowed_hosts(self):
        self.assertEqual(self.load()["allowed_hosts"], [])
        cfg = self.load({"allowed_hosts": ["Lab.Example.org.", ".seas.harvard.edu", 3, ""]})
        self.assertEqual(cfg["allowed_hosts"], ["lab.example.org", ".seas.harvard.edu"])
        cfg = self.load(env={"LABHUB_ALLOWED_HOSTS": " labpi.example.org, *  "})
        self.assertEqual(cfg["allowed_hosts"], ["labpi.example.org", "*"])

    def test_invalid_github_settings_turn_sync_off(self):
        good = {"github_repo": "richard-0421/lab-hub", "github_token": "t"}
        with self.assertLogs("labhub.config", level="WARNING") as logs:
            cfg = self.load(dict(good, github_branch="x..y"))
        self.assertEqual(github_config_error(cfg), "config: github_branch 'x..y' is not a valid branch name")
        self.assertEqual(len(logs.records), 1)
        self.assertIn("config: github_branch 'x..y' is not a valid branch name; GitHub sync is off", logs.output[0])
        self.assertFalse(github_enabled(cfg))
        self.assertEqual((cfg["github_repo"], cfg["github_branch"]), ("richard-0421/lab-hub", "x..y"))
        with self.assertLogs("labhub.config", level="WARNING") as logs:
            cfg = self.load({"github_repo": "a/..", "github_token": SECRET})
        self.assertNotIn(SECRET, github_config_error(cfg) + "".join(logs.output))

        bad = {
            "github_branch": ["x..y", ".hidden", "feature/.x", "data.lock", "feature/Data.LOCK", "data.", "a//b",
                              "a b", "da~ta", "da:ta", "a\\b", "%2e%2e", "../main", "ref/./x", "dat\u00e4"],
            "github_path": ["../board.json", "..", "...", "a/./b.json", "a//b.json", "a b.json", "a\\b.json",
                            "%2e%2e/board.json", "a?b.json", "board.json#x"],
            "github_repo": ["richard-0421/..", "../lab-hub", "./lab-hub", "a/b/c", "richard-0421/lab hub",
                            "https://github.com/richard-0421/..", "richard-0421/lab-hub?x"],
        }
        for key, values in bad.items():
            for value in values:
                with self.assertLogs("labhub.config", level="WARNING"):
                    cfg = self.load(dict(good, **{key: value}))
                self.assertFalse(github_enabled(cfg), (key, value))
                self.assertTrue(github_config_error(cfg).startswith("config: %s '" % key), (key, value))
                if key == "github_repo":
                    self.assertEqual((cfg["github_repo"], cfg["pages_url"]), ("", ""))
        # from the environment too
        with self.assertLogs("labhub.config", level="WARNING"):
            cfg = self.load(good, {"LABHUB_GITHUB_PATH": "../../etc/passwd"})
        self.assertEqual(github_config_error(cfg), "config: github_path '../../etc/passwd' is not a valid file path")

        # several problems: one message, one log line
        with self.assertLogs("labhub.config", level="WARNING") as logs:
            cfg = self.load({"github_repo": "a/..", "github_branch": "b..", "github_path": "../c", "github_token": "t"})
        self.assertEqual(len(logs.records), 1)
        self.assertEqual(github_config_error(cfg), "; ".join([
            "config: github_repo 'a/..' is not a valid repository (use owner/name, e.g. richard-0421/lab-hub)",
            "config: github_branch 'b..' is not a valid branch name",
            "config: github_path '../c' is not a valid file path",
        ]))
        # odd characters and long values are shown safely
        with self.assertLogs("labhub.config", level="WARNING"):
            cfg = self.load(dict(good, github_branch="a\u0007b" + "x" * 300))
        msg = github_config_error(cfg)
        self.assertIn("'a?bxxx", msg)
        self.assertIn("...'", msg)
        self.assertLess(len(msg), 160)

    def test_valid_github_settings(self):
        good = {"github_repo": "richard-0421/lab-hub", "github_token": "t"}
        with mock.patch.object(app_config.log, "warning") as warn:
            for extra in ({}, {"github_branch": "feature/board-v2"}, {"github_branch": "v1.2"},
                          {"github_branch": "release_2026"}, {"github_path": "boards/lab.json"},
                          {"github_path": "/board.json/"}, {"github_path": ".github/board.json"},
                          {"github_repo": "a_b/c.d"}, {"github_repo": "https://github.com/Richard-0421/Lab.Hub.git"}):
                cfg = self.load(dict(good, **extra))
                self.assertEqual(github_config_error(cfg), "", extra)
                self.assertTrue(github_enabled(cfg), extra)
            # no repo: local-only, the branch and path are never used, nothing to report
            cfg = self.load({"github_branch": "x..y", "github_path": "../x", "github_token": "t"})
            self.assertEqual(github_config_error(cfg), "")
            self.assertFalse(github_enabled(cfg))
            warn.assert_not_called()
        self.assertEqual(self.load(dict(good, github_path="/board.json/"))["github_path"], "board.json")

    def test_public_config_reports_the_config_error(self):
        good = {"github_repo": "richard-0421/lab-hub", "github_token": SECRET}
        gh = app_main.public_config(self.load(good))["github"]
        self.assertIsNone(gh["last_error"])
        self.assertEqual(gh["file_url"], "https://github.com/richard-0421/lab-hub/blob/data/board.json")
        self.assertIs(gh["enabled"], True)
        cases = {
            "github_path": ("a/../board.json", "config: github_path 'a/../board.json' is not a valid file path"),
            "github_branch": ("x..y", "config: github_branch 'x..y' is not a valid branch name"),
            "github_repo": ("richard-0421/..", "config: github_repo 'richard-0421/..' is not a valid repository "
                                               "(use owner/name, e.g. richard-0421/lab-hub)"),
        }
        for key, (value, message) in cases.items():
            with self.assertLogs("labhub.config", level="WARNING"):
                cfg = self.load(dict(good, **{key: value}))
            body = app_main.public_config(cfg)
            gh = body["github"]
            self.assertEqual(gh["last_error"], message, key)
            self.assertIs(gh["enabled"], False, key)
            self.assertEqual(gh["file_url"], "", key)  # never a link built from an unusable value
            self.assertNotIn(SECRET, json.dumps(body))
        # without a token sync is off too, but that is not a config error
        gh = app_main.public_config(self.load({"github_repo": "richard-0421/lab-hub"}))["github"]
        self.assertIsNone(gh["last_error"])
        self.assertTrue(gh["file_url"])
        self.assertIsNone(app_main.public_config(self.load({}))["github"]["last_error"])

    def write_git(self, origin, gitfile=False):
        git = os.path.join(self.tmp, "real.git" if gitfile else ".git")
        os.makedirs(git, exist_ok=True)
        with open(os.path.join(git, "config"), "w") as f:
            f.write('[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/someone/else.git\n'
                    '[remote "origin"]\n\turl = %s\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n' % origin)
        if gitfile:
            with open(os.path.join(self.tmp, ".git"), "w") as f:
                f.write("gitdir: real.git\n")

    def test_pages_url_follows_the_code_repo(self):
        # README "Privacy": the board lives in a private data repo, the site in the code repo
        self.write_git("git@github.com:richard-0421/lab-hub.git")
        self.assertEqual(git_origin_repo(self.tmp), "richard-0421/lab-hub")
        cfg = self.load({"github_repo": "richard-0421/lab-hub-data"})
        self.assertEqual(cfg["pages_url"], "https://richard-0421.github.io/lab-hub/?repo=richard-0421/lab-hub-data")
        self.assertEqual(self.load({"github_repo": "richard-0421/lab-hub"})["pages_url"],
                         "https://richard-0421.github.io/lab-hub/")
        self.assertEqual(self.load({"github_repo": "a/b", "pages_url": "https://lab.example.org/"})["pages_url"],
                         "https://lab.example.org/")

    def test_pages_url_single_repo(self):
        # the default setup: one public repo, main = code + Pages, data = board.json
        for origin in ("https://github.com/richard-0421/lab-hub.git", "https://github.com/richard-0421/lab-hub",
                       "git@github.com:Richard-0421/lab-hub.git", "ssh://git@github.com/richard-0421/lab-hub.git"):
            self.write_git(origin)
            for repo in ("richard-0421/lab-hub", "https://github.com/richard-0421/lab-hub.git"):
                cfg = self.load({"github_repo": repo, "github_branch": "data"})
                self.assertEqual(cfg["pages_url"], "https://richard-0421.github.io/lab-hub/", (origin, repo))
        # github_repo set but no git origin (no checkout, or no "origin" remote): derived from github_repo
        with open(os.path.join(self.tmp, ".git", "config"), "w") as f:
            f.write('[remote "upstream"]\n\turl = https://github.com/someone/else.git\n')
        self.assertEqual(git_origin_repo(self.tmp), "")
        self.assertEqual(self.load({"github_repo": "richard-0421/lab-hub"})["pages_url"],
                         "https://richard-0421.github.io/lab-hub/")
        shutil.rmtree(os.path.join(self.tmp, ".git"))
        self.assertEqual(self.load({"github_repo": "richard-0421/lab-hub"})["pages_url"],
                         "https://richard-0421.github.io/lab-hub/")
        self.assertEqual(self.load(env={"LABHUB_GITHUB_REPO": "richard-0421/lab-hub"})["pages_url"],
                         "https://richard-0421.github.io/lab-hub/")
        # no repo -> no link; an explicit one always wins
        self.assertEqual(self.load({})["pages_url"], "")
        self.assertEqual(self.load({"github_repo": "richard-0421/lab-hub", "pages_url": "https://x.example/"})
                         ["pages_url"], "https://x.example/")

    def test_pages_url_origin_forms(self):
        self.write_git("https://user:secret@github.com/Richard-0421/lab-hub", gitfile=True)
        self.assertEqual(git_origin_repo(self.tmp), "Richard-0421/lab-hub")
        self.write_git("https://gitlab.com/x/lab-hub.git", gitfile=True)
        self.assertEqual(git_origin_repo(self.tmp), "")
        self.assertEqual(self.load({"github_repo": "richard-0421/lab-hub-data"})["pages_url"],
                         "https://richard-0421.github.io/lab-hub-data/")
        self.assertEqual(git_origin_repo(os.path.join(self.tmp, "nowhere")), "")


# --------------------------------------------------------------------------- #
# request guard + LAN address helpers
# --------------------------------------------------------------------------- #
class _FakeSock(object):
    def __init__(self, ip=None, error=None):
        self.ip, self.error, self.closed = ip, error, False

    def connect(self, addr):
        if self.error:
            raise self.error

    def getsockname(self):
        return (self.ip, 50000)

    def close(self):
        self.closed = True


class _FakeRequest(object):
    def __init__(self, chunks, length=None):
        self.headers = {} if length is None else {"content-length": str(length)}
        self._chunks = chunks

    async def stream(self):
        for c in self._chunks:
            yield c


class GuardTests(unittest.TestCase):
    def tearDown(self):
        app_main.clear_lan_cache()

    def test_split_host(self):
        self.assertEqual(app_main.split_host("LabPi.Local:8000"), ("labpi.local", "8000"))
        self.assertEqual(app_main.split_host("[::1]:8000"), ("::1", "8000"))
        self.assertEqual(app_main.split_host("example.org."), ("example.org", ""))
        self.assertEqual(app_main.split_host(None), ("", ""))

    def test_host_allowed(self):
        names = {"labpi", "labpi.local"}
        for host in ("", "localhost", "kiosk.localhost", "127.0.0.1", "192.168.1.5", "::1", "labpi", "labpi.local"):
            self.assertTrue(app_main.host_allowed(host, names), host)
        for host in ("evil.example", "labpi.evil.example", "raspberrypi.attacker.com", "192.168.1.5.nip.io"):
            self.assertFalse(app_main.host_allowed(host, names), host)
        extra = (".seas.harvard.edu", "lab.example.org")
        self.assertTrue(app_main.host_allowed("labpi.seas.harvard.edu", names, extra))
        self.assertTrue(app_main.host_allowed("lab.example.org", names, extra))
        self.assertFalse(app_main.host_allowed("seas.harvard.edu.evil.com", names, extra))
        self.assertTrue(app_main.host_allowed("anything.example", names, ("*",)))
        self.assertIn("localhost", app_main.local_host_names())

    def test_same_origin(self):
        self.assertTrue(app_main.same_origin("http://192.168.1.5:8000", "192.168.1.5:8000"))
        self.assertTrue(app_main.same_origin("http://LabPi.local", "labpi.local:80"))
        self.assertTrue(app_main.same_origin("http://[::1]:8000", "[::1]:8000"))
        self.assertFalse(app_main.same_origin("http://192.168.1.5:9000", "192.168.1.5:8000"))
        self.assertFalse(app_main.same_origin("https://192.168.1.5:8000", "192.168.1.5:8000"))
        self.assertFalse(app_main.same_origin("null", "192.168.1.5:8000"))
        self.assertFalse(app_main.same_origin("http://x:notaport", "x"))

    def test_read_body_limit(self):
        run = asyncio.run
        self.assertEqual(run(app_main.read_body(_FakeRequest([b"ab", b"cd"]), 4)), b"abcd")
        self.assertIsNone(run(app_main.read_body(_FakeRequest([b"ab", b"cde"]), 4)))  # no Content-Length
        self.assertIsNone(run(app_main.read_body(_FakeRequest([], length=5), 4)))

    def test_primary_lan_ipv4(self):
        socks = []

        def factory(ip=None, error=None):
            def make(family, kind):
                socks.append(_FakeSock(ip, error))
                return socks[-1]
            return make

        app_main.clear_lan_cache()
        self.assertEqual(app_main.primary_lan_ipv4(factory("192.168.1.23")), "192.168.1.23")
        self.assertTrue(socks[-1].closed)
        # cached: no new socket for a while
        self.assertEqual(app_main.primary_lan_ipv4(factory(error=OSError(errno.ENETUNREACH, "no route"))),
                         "192.168.1.23")
        self.assertEqual(len(socks), 1)
        self.assertEqual(app_main.lan_url({"host": "0.0.0.0", "port": 8000}, 8123), "http://192.168.1.23:8123")
        self.assertEqual(app_main.lan_url({"host": "", "port": 80}), "http://192.168.1.23")
        with mock.patch.object(app_main, "LAN_CACHE_SECONDS", 0):
            self.assertIsNone(app_main.primary_lan_ipv4(factory(error=OSError(errno.ENETUNREACH, "no route"))))
            self.assertIsNone(app_main.primary_lan_ipv4(factory("127.0.1.1")))
        self.assertIsNone(app_main.lan_url({"host": "0.0.0.0", "port": 8000}))
        # bound to loopback: nobody else can reach it; bound to one address: that one
        self.assertIsNone(app_main.lan_url({"host": "127.0.0.1", "port": 8000}))
        self.assertIsNone(app_main.lan_url({"host": "localhost", "port": 8000}))
        self.assertEqual(app_main.lan_url({"host": "10.0.0.7", "port": 8000}), "http://10.0.0.7:8000")


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

# effective ends (RFC 5545 DURATION / defaults); read at 2026-10-16 15:00
ICS_ENDS = """BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
SUMMARY:Holiday
DTSTART;VALUE=DATE:20261016
END:VEVENT
BEGIN:VEVENT
SUMMARY:Retreat
DTSTART;VALUE=DATE:20261015
DURATION:P3D
END:VEVENT
BEGIN:VEVENT
SUMMARY:Yesterday
DTSTART;VALUE=DATE:20261015
END:VEVENT
BEGIN:VEVENT
SUMMARY:Seminar
DTSTART:20261016T080000
DURATION:PT8H
BEGIN:VALARM
TRIGGER:-PT15M
DURATION:PT5M
REPEAT:2
ACTION:DISPLAY
SUMMARY:Alarm text
END:VALARM
END:VEVENT
BEGIN:VEVENT
SUMMARY:Short seminar
DTSTART:20261016T080000
DURATION:PT6H30M
END:VEVENT
BEGIN:VEVENT
SUMMARY:Standup
DTSTART:20261016T090000
END:VEVENT
BEGIN:VEVENT
SUMMARY:Week block
DTSTART:20261012T100000
DURATION:P1W
END:VEVENT
BEGIN:VEVENT
SUMMARY:Soon
DTSTART:20261016T130000
END:VEVENT
BEGIN:VEVENT
SUMMARY:Backwards
DTSTART:20261016T170000
DURATION:-PT1H
END:VEVENT
BEGIN:VEVENT
SUMMARY:Ended dtend
DTSTART:20261016T080000
DTEND:20261016T070000
DURATION:PT10H
END:VEVENT
BEGIN:VEVENT
SUMMARY:Bad duration
DTSTART;VALUE=DATE:20261016
DURATION:PTX
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
        # RFC 5545: a timed event without DTEND/DURATION ends when it starts
        self.assertEqual(by["No end"]["end"], "2026-10-20T09:00:00")
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

    def events_at(self, ics, now):
        with open(self.ics, "w") as f:
            f.write(ics)
        calendar_feed.clear_cache()
        res = calendar_feed.get_events({"calendar_ics": self.ics, "calendar_max_events": 20}, now=now)
        return {e["summary"]: e for e in res["events"]}, [e["summary"] for e in res["events"]]

    def test_effective_end_from_duration_or_default(self):
        # 15:00, so anything that started before 12:00 stays only while it lasts
        by, order = self.events_at(ICS_ENDS, datetime(2026, 10, 16, 15, 0, 0))
        self.assertEqual(order, ["Week block", "Retreat", "Holiday", "Bad duration", "Seminar", "Soon", "Backwards"])
        # all-day without DTEND: lasts its own day (it used to vanish at 03:00)
        self.assertEqual(by["Holiday"]["end"], "2026-10-17T00:00:00")
        self.assertTrue(by["Holiday"]["all_day"])
        self.assertEqual(by["Retreat"]["end"], "2026-10-18T00:00:00")  # DATE + P3D
        self.assertEqual(by["Week block"]["end"], "2026-10-19T10:00:00")  # P1W
        # the VALARM's DURATION / SUMMARY belong to the alarm, not the event
        self.assertEqual(by["Seminar"]["end"], "2026-10-16T16:00:00")
        # timed without DTEND/DURATION: no length; a negative DURATION or a
        # DTEND before the start doesn't put the end before the start
        self.assertEqual(by["Soon"]["end"], "2026-10-16T13:00:00")
        self.assertEqual(by["Backwards"]["end"], "2026-10-16T17:00:00")
        self.assertEqual(by["Bad duration"]["end"], "2026-10-17T00:00:00")
        for gone in ("Standup", "Yesterday", "Short seminar", "Alarm text", "Ended dtend"):
            self.assertNotIn(gone, by)

        # the all-day event is still listed late in its own day, gone at midnight
        by, _ = self.events_at(ICS_ENDS, datetime(2026, 10, 16, 23, 59, 0))
        self.assertIn("Holiday", by)
        by, _ = self.events_at(ICS_ENDS, datetime(2026, 10, 17, 0, 0, 0))
        self.assertNotIn("Holiday", by)
        self.assertIn("Retreat", by)

    def test_parse_duration(self):
        d = calendar_feed.parse_duration
        self.assertEqual(d("PT1H"), timedelta(hours=1))
        self.assertEqual(d("P2W"), timedelta(weeks=2))
        self.assertEqual(d("P15DT5H0M20S"), timedelta(days=15, hours=5, seconds=20))
        self.assertEqual(d("+P1D"), timedelta(days=1))
        self.assertEqual(d("-PT15M"), timedelta(minutes=-15))
        self.assertEqual(d(" pt30m "), timedelta(minutes=30))
        self.assertEqual(d("P0D"), timedelta(0))
        for bad in ("", "P", "PT", "P1DT", "PT5", "P1W2D", "1H", "P1H", "PT1D", "P-1D", "P99999999999D", None):
            self.assertIsNone(d(bad), bad)

    def test_effective_end(self):
        end = calendar_feed.effective_end
        day = datetime(2026, 10, 16)
        at9 = datetime(2026, 10, 16, 9)
        self.assertEqual(end(at9, datetime(2026, 10, 16, 10)), datetime(2026, 10, 16, 10))
        self.assertEqual(end(at9, None, timedelta(minutes=45)), datetime(2026, 10, 16, 9, 45))
        self.assertEqual(end(at9, datetime(2026, 10, 16, 10), timedelta(hours=5)), datetime(2026, 10, 16, 10))
        self.assertEqual(end(at9), at9)
        self.assertEqual(end(day, all_day=True), datetime(2026, 10, 17))
        self.assertEqual(end(day, day, all_day=True), datetime(2026, 10, 17))  # DTEND is exclusive
        self.assertEqual(end(at9, datetime(2026, 10, 16, 8)), at9)
        self.assertEqual(end(datetime(9999, 12, 31), all_day=True), datetime(9999, 12, 31))
        self.assertIsNone(end(None, at9))


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
