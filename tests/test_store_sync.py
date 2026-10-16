"""app/store.py persistence + app/github_sync.py against tests/mock_github.py."""
import json
import logging
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from app import board as B  # noqa: E402
from app.github_sync import SyncWorker  # noqa: E402
from app.store import OpError, Store  # noqa: E402
from tests.mock_github import MockGitHub  # noqa: E402

REPO = "richard-0417/lab-hub"
TOKEN = "test-token"
TS = "2026-10-16T14:00:00Z"

logging.getLogger("labhub").setLevel(logging.CRITICAL)


def add_task(tid, title, rank=0, **extra):
    item = {"id": tid, "title": title, "rank": rank}
    item.update(extra)
    return {"op": "add", "coll": "tasks", "item": item, "ts": TS, "by": "Richard"}


def update(tid, coll="tasks", **changes):
    return {"op": "update", "coll": coll, "id": tid, "set": changes, "ts": TS, "by": "Richard"}


def titles(board):
    return sorted(t["title"] for t in board["tasks"])


def wait_until(pred, timeout=5.0, step=0.02):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(step)
    return pred()


class TempDirTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="labhub-test-")
        self.state = os.path.join(self.tmp, "state")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def local_store(self):
        return Store(self.state, github_enabled=False)

    def gh_store(self, api="http://127.0.0.1:9", repo=REPO):
        return Store(self.state, github_enabled=True, repo=repo, branch="data", path="board.json",
                     api=api, client_name="lab-pi")


# --------------------------------------------------------------------------- #
# store (no network)
# --------------------------------------------------------------------------- #
class StoreTests(TempDirTest):
    def test_local_only_applies_straight_into_base(self):
        s = self.local_store()
        res = s.submit([add_task("t-1", "Order tips")])
        self.assertEqual(titles(res["board"]), ["Order tips"])
        self.assertEqual(s.pending(), [])
        self.assertEqual(s.sync_status()["state"], "off")
        self.assertFalse(s.sync_status()["enabled"])
        self.assertTrue(os.path.exists(os.path.join(self.state, "remote.json")))
        s2 = self.local_store()
        self.assertEqual(titles(s2.view()), ["Order tips"])
        self.assertEqual(s2.pending(), [])

    def test_github_mode_queue_persists(self):
        s = self.gh_store()
        s.submit([add_task("t-1", "A"), add_task("t-2", "B", 1)])
        self.assertEqual(len(s.pending()), 2)
        self.assertEqual(s.base()["tasks"], [])
        self.assertEqual(titles(s.view()), ["A", "B"])
        status = s.sync_status()
        self.assertTrue(status["enabled"])
        self.assertEqual(status["pending"], 2)
        self.assertEqual(status["repo"], REPO)
        s2 = self.gh_store()
        self.assertEqual(len(s2.pending()), 2)
        self.assertEqual(s2.view(), s.view())

    def test_rev_monotonic_and_time_based_across_restart(self):
        before = int(time.time() * 1000)
        s = self.gh_store()
        r1 = s.rev
        self.assertGreaterEqual(r1, before)
        s.submit([add_task("t-1", "A")])
        r2 = s.rev
        self.assertGreater(r2, r1)
        s.submit([add_task("t-2", "B")])
        r3 = s.rev
        self.assertGreater(r3, r2)
        s2 = self.gh_store()
        self.assertGreater(s2.rev, r3)
        # a stored rev far in the future (clock went backwards) is still honoured
        meta_path = os.path.join(self.state, "sync.json")
        with open(meta_path) as f:
            meta = json.load(f)
        meta["rev"] = int(time.time() * 1000) + 10 ** 9
        with open(meta_path, "w") as f:
            json.dump(meta, f)
        s3 = self.gh_store()
        self.assertGreater(s3.rev, meta["rev"])

    def test_noop_submit_keeps_rev(self):
        s = self.local_store()
        s.submit([add_task("t-1", "A")])
        r = s.rev
        s.submit([{"op": "delete", "coll": "tasks", "id": "t-missing", "ts": TS}])
        self.assertEqual(s.rev, r)
        self.assertEqual(s.board_response(r), {"rev": r, "unchanged": True, "sync": s.sync_status()})
        self.assertIn("board", s.board_response(r - 1))
        self.assertIn("board", s.board_response(None))

    def test_submit_is_all_or_nothing(self):
        s = self.gh_store()
        rev = s.rev
        with self.assertRaises(OpError) as cm:
            s.submit([add_task("t-1", "A"), update("t-1", status="blocked")])
        self.assertEqual(cm.exception.index, 1)
        self.assertIn("status", cm.exception.message)
        self.assertEqual(s.pending(), [])
        self.assertEqual(s.view()["tasks"], [])
        self.assertEqual(s.rev, rev)
        with self.assertRaises(OpError) as cm:
            s.submit("nope")
        self.assertIsNone(cm.exception.index)

    def test_submitted_ops_are_copied_and_cleaned(self):
        s = self.gh_store()
        op = add_task("t-1", "A")
        op["junk"] = 1
        op["by"] = "x" * 100
        s.submit([op])
        op["item"]["title"] = "changed later"
        queued = s.pending()[0]
        self.assertNotIn("junk", queued)
        self.assertEqual(len(queued["by"]), 60)
        self.assertEqual(queued["item"]["title"], "A")

    def test_corrupt_files_recovered(self):
        os.makedirs(self.state)
        for name in ("remote.json", "pending.json", "sync.json"):
            with open(os.path.join(self.state, name), "w") as f:
                f.write("{this is not json")
        with self.assertLogs("labhub.store", level="WARNING") as logs:
            s = self.gh_store()
        self.assertEqual(len([m for m in logs.output if "corrupt" in m]), 3)
        for name in ("remote.json", "pending.json", "sync.json"):
            self.assertTrue(os.path.exists(os.path.join(self.state, name + ".corrupt")), name)
        self.assertEqual(s.view(), B.empty_board())
        self.assertEqual(s.pending(), [])
        s.submit([add_task("t-1", "A")])
        with open(os.path.join(self.state, "pending.json")) as f:
            self.assertEqual(len(json.load(f)), 1)
        self.assertEqual(titles(self.gh_store().view()), ["A"])

    def test_wrong_shapes_and_invalid_queued_ops(self):
        os.makedirs(self.state)
        with open(os.path.join(self.state, "pending.json"), "w") as f:
            json.dump([add_task("t-1", "A"), {"op": "explode"}], f)
        with open(os.path.join(self.state, "remote.json"), "w") as f:
            json.dump([1, 2, 3], f)
        with self.assertLogs("labhub.store", level="WARNING"):
            s = self.gh_store()
        self.assertEqual(len(s.pending()), 1)
        self.assertEqual(titles(s.view()), ["A"])

    def test_missing_state_dir_is_created_on_write(self):
        s = self.local_store()
        self.assertTrue(os.path.isdir(self.state))
        s.submit([add_task("t-1", "A")])
        leftovers = [n for n in os.listdir(self.state) if ".tmp-" in n]
        self.assertEqual(leftovers, [])

    def test_local_board_is_requeued_when_github_is_enabled(self):
        s = self.local_store()
        s.submit([add_task("t-1", "A"), add_task("t-2", "B", 1),
                  {"op": "add", "coll": "notes", "item": {"id": "n-1", "body": "hi"}, "ts": TS}])
        g = self.gh_store()
        self.assertEqual(g.base(), B.empty_board())
        self.assertEqual(len(g.pending()), 3)
        self.assertEqual(titles(g.view()), ["A", "B"])
        self.assertEqual(len(g.view()["notes"]), 1)
        # restarting in GitHub mode does not queue them a second time
        self.assertEqual(len(self.gh_store().pending()), 3)

    def test_pending_is_folded_when_github_is_disabled(self):
        g = self.gh_store()
        g.submit([add_task("t-1", "A")])
        s = self.local_store()
        self.assertEqual(s.pending(), [])
        self.assertEqual(titles(s.base()), ["A"])


# --------------------------------------------------------------------------- #
# sync against the mock
# --------------------------------------------------------------------------- #
class SyncTests(TempDirTest):
    def setUp(self):
        TempDirTest.setUp(self)
        self.mock = None

    def tearDown(self):
        if getattr(self, "worker", None) is not None:
            self.worker.stop()
        if self.mock is not None:
            self.mock.stop()
        TempDirTest.tearDown(self)

    def start(self, token=TOKEN, repo=REPO, interval=15, **mock_kw):
        self.mock = MockGitHub(repo=REPO, token=TOKEN, **mock_kw).start()
        self.store = self.gh_store(api=self.mock.url, repo=repo)
        cfg = {
            "github_repo": repo, "github_branch": "data", "github_path": "board.json",
            "github_token": token, "github_api": self.mock.url, "client_name": "lab-pi",
            "sync_interval": interval,
        }
        self.worker = SyncWorker(self.store, cfg)
        return self.store, self.worker

    def remote(self):
        return self.mock.get_file_json("data", "board.json")

    def puts(self):
        return [r for r in self.mock.requests if r["method"] == "PUT"]

    def test_initial_create_when_file_missing(self):
        store, worker = self.start()
        store.submit([add_task("t-1", "Order pipette tips", -1)])
        status = worker.sync_once()
        self.assertEqual(status["state"], "ok", status)
        self.assertEqual(status["pending"], 0)
        self.assertIsNotNone(status["last_push"])
        self.assertIsNone(status["last_error"])
        remote = self.remote()
        self.assertEqual(titles(remote), ["Order pipette tips"])
        self.assertEqual(remote["updated_by"], "lab-pi")
        self.assertEqual(remote["updated_at"], TS)
        self.assertEqual(B.normalize_board(remote), store.view())
        put_body = json.loads(self.puts()[0]["body"])
        self.assertNotIn("sha", put_body)
        self.assertEqual(put_body["branch"], "data")
        msg = self.mock.commits("data")[-1]["message"]
        subject = msg.split("\n")[0]
        self.assertEqual(subject, "lab-pi: add “Order pipette tips”")
        self.assertLessEqual(len(subject), 72)
        self.assertIn("(by Richard)", msg)
        # file text is exactly the canonical serialization
        self.assertEqual(self.mock.get_file_text("data", "board.json"), B.serialize_board(store.base()))

    def test_empty_board_is_created(self):
        store, worker = self.start()
        self.assertEqual(worker.sync_once()["state"], "ok")
        self.assertEqual(self.remote()["tasks"], [])
        self.assertEqual(self.mock.commits("data")[-1]["message"], "lab-pi: create board.json")

    def test_branch_is_created_when_missing(self):
        store, worker = self.start(create_data_branch=False)
        self.assertNotIn("data", self.mock.branches)
        store.submit([add_task("t-1", "A")])
        status = worker.sync_once()
        self.assertEqual(status["state"], "ok", status)
        self.assertIn("data", self.mock.branches)
        self.assertEqual(self.mock.count("POST", "/git/refs", 201), 1)
        self.assertEqual(titles(self.remote()), ["A"])
        self.assertIsNone(self.mock.get_file_text("main", "board.json"))

    def test_two_way_merge(self):
        store, worker = self.start()
        store.submit([add_task("t-a", "Alpha", 1), add_task("t-b", "Beta", 2)])
        worker.sync_once()
        # someone edits on the web: renames Alpha, adds Web task
        web = self.remote()
        web["tasks"][0]["title"] = "Alpha (web)"
        web["tasks"].append({"id": "t-w", "title": "Web task", "rank": 3})
        self.mock.set_file_text("data", "board.json", json.dumps(web, indent=2))
        # meanwhile on the Pi: change Alpha's priority, add Local task, delete Beta
        store.submit([update("t-a", priority="high"), add_task("t-l", "Local task", 4),
                      {"op": "delete", "coll": "tasks", "id": "t-b", "ts": TS}])
        status = worker.sync_once()
        self.assertEqual(status["state"], "ok", status)
        remote = self.remote()
        self.assertEqual(titles(remote), ["Alpha (web)", "Local task", "Web task"])
        alpha = [t for t in remote["tasks"] if t["id"] == "t-a"][0]
        self.assertEqual(alpha["priority"], "high")
        self.assertEqual(store.view(), B.normalize_board(remote))
        self.assertEqual(status["pending"], 0)

    def test_conflict_409_is_retried(self):
        store, worker = self.start()
        store.submit([add_task("t-a", "Alpha", 1)])
        worker.sync_once()
        store.submit([add_task("t-l", "Local", 2)])

        def web_edit():
            doc = self.remote()
            doc["tasks"].append({"id": "t-w", "title": "Web", "rank": 3})
            self.mock.set_file_text("data", "board.json", json.dumps(doc))

        self.mock.on_next("PUT", web_edit, "/contents/")
        self.mock.clear_log()
        status = worker.sync_once()
        self.assertEqual(status["state"], "ok", status)
        self.assertEqual([p["status"] for p in self.puts()], [409, 200])
        self.assertEqual(titles(self.remote()), ["Alpha", "Local", "Web"])
        self.assertEqual(titles(store.view()), ["Alpha", "Local", "Web"])

    def test_422_missing_sha_is_treated_as_conflict(self):
        store, worker = self.start()
        # the file appears on GitHub between our 404 and our create-PUT
        self.mock.on_next("PUT", lambda: self.mock.set_file_text(
            "data", "board.json", json.dumps({"tasks": [{"id": "t-w", "title": "Web"}]})), "/contents/")
        store.submit([add_task("t-l", "Local")])
        status = worker.sync_once()
        self.assertEqual(status["state"], "ok", status)
        self.assertEqual([p["status"] for p in self.puts()], [422, 200])
        self.assertEqual(titles(self.remote()), ["Local", "Web"])

    def test_conflicts_give_up_after_three_attempts(self):
        store, worker = self.start()
        worker.sync_once()
        store.submit([add_task("t-l", "Local")])
        for i in range(3):
            self.mock.fail_next(409, "board.json does not match", method="PUT")
        status = worker.sync_once()
        self.assertEqual(status["state"], "error")
        self.assertEqual(status["pending"], 1)
        self.assertEqual(len([p for p in self.puts() if p["status"] == 409]), 3)
        self.assertEqual(worker.sync_once()["state"], "ok")  # next cycle succeeds
        self.assertEqual(titles(self.remote()), ["Local"])

    def test_304_does_not_redownload(self):
        store, worker = self.start()
        store.submit([add_task("t-a", "Alpha")])
        worker.sync_once()                 # push (etag dropped)
        worker.sync_once()                 # GET 200, etag stored
        self.mock.clear_log()
        rev = store.rev
        status = worker.sync_once()        # GET 304
        self.assertEqual(status["state"], "ok")
        self.assertEqual(len(self.mock.requests), 1)
        req = self.mock.requests[0]
        self.assertEqual((req["method"], req["status"]), ("GET", 304))
        self.assertTrue(req["if_none_match"])
        self.assertEqual(store.rev, rev)

    def test_remote_change_bumps_rev(self):
        store, worker = self.start()
        worker.sync_once()
        rev = store.rev
        self.mock.set_file_text("data", "board.json", json.dumps({"tasks": [{"id": "t-w", "title": "Web"}]}))
        worker.sync_once()
        self.assertGreater(store.rev, rev)
        self.assertEqual(titles(store.view()), ["Web"])

    def test_offline_keeps_ops_and_recovers(self):
        store, worker = self.start()
        worker.sync_once()
        self.mock.set_offline(True)
        store.submit([add_task("t-1", "Written offline")])
        status = worker.sync_once()
        self.assertEqual(status["state"], "offline")
        self.assertEqual(status["pending"], 1)
        self.assertIn("Can't reach GitHub", status["last_error"])
        self.assertEqual(titles(store.view()), ["Written offline"])
        # survives a restart while offline
        store2 = self.gh_store(api=self.mock.url)
        self.assertEqual(len(store2.pending()), 1)
        self.mock.set_offline(False)
        status = worker.sync_once()
        self.assertEqual(status["state"], "ok")
        self.assertEqual(status["pending"], 0)
        self.assertEqual(titles(self.remote()), ["Written offline"])

    def test_connection_refused_is_offline(self):
        store, worker = self.start()
        self.mock.stop()
        self.mock = None
        status = worker.sync_once()
        self.assertEqual(status["state"], "offline")

    def test_invalid_remote_json_blocks_push(self):
        store, worker = self.start()
        worker.sync_once()
        self.mock.set_file_text("data", "board.json", "{ broken json,,")
        store.submit([add_task("t-1", "A")])
        self.mock.clear_log()
        status = worker.sync_once()
        self.assertEqual(status["state"], "error")
        self.assertTrue(status["last_error"].startswith("board.json on GitHub is not valid JSON"), status)
        self.assertEqual(self.mock.count("PUT"), 0)
        self.assertEqual(status["pending"], 1)
        # NaN is not JSON either (JSON.parse in the browser rejects it)
        self.mock.set_file_text("data", "board.json", '{"tasks": [], "x": NaN}')
        self.assertEqual(worker.sync_once()["state"], "error")
        self.assertEqual(self.mock.count("PUT"), 0)
        # once fixed on GitHub, the queued op goes through
        self.mock.set_file_text("data", "board.json", '{"tasks": []}')
        status = worker.sync_once()
        self.assertEqual(status["state"], "ok")
        self.assertEqual(titles(self.remote()), ["A"])

    def test_bad_token_401(self):
        store, worker = self.start(token="wrong-token")
        store.submit([add_task("t-1", "A")])
        status = worker.sync_once()
        self.assertEqual(status["state"], "error")
        self.assertEqual(status["last_error"], "GitHub token rejected (expired or revoked?)")
        self.assertEqual(status["pending"], 1)
        self.assertNotIn("wrong-token", json.dumps(status))

    def test_repo_not_found(self):
        store, worker = self.start(repo="richard-0417/does-not-exist")
        status = worker.sync_once()
        self.assertEqual(status["state"], "error")
        self.assertEqual(status["last_error"], "repo not found, or the token can't see it")

    def test_private_repo(self):
        store, worker = self.start(private=True)
        store.submit([add_task("t-1", "A")])
        self.assertEqual(worker.sync_once()["state"], "ok")
        self.assertTrue(all(r["auth"] for r in self.mock.requests))

    def test_rate_limit_403(self):
        store, worker = self.start()
        self.mock.fail_next(403, "API rate limit exceeded for user ID 1.", method="GET",
                            headers={"X-RateLimit-Remaining": "0"})
        status = worker.sync_once()
        self.assertEqual(status["state"], "error")
        self.assertIn("rate limit", status["last_error"].lower())
        self.mock.fail_next(403, "Resource not accessible by personal access token", method="PUT")
        store.submit([add_task("t-1", "A")])
        status = worker.sync_once()
        self.assertIn("Contents: read & write", status["last_error"])
        self.assertIn("Resource not accessible", status["last_error"])

    def test_server_error_then_recovery(self):
        store, worker = self.start()
        self.mock.fail_next(502, "Server Error", method="GET")
        self.assertEqual(worker.sync_once()["state"], "error")
        self.assertEqual(worker.sync_once()["state"], "ok")

    def test_hand_edit_is_normalized_and_written_back(self):
        store, worker = self.start()
        raw = {"tasks": [
            {"id": "t-2", "title": " Second ", "status": "DONE", "rank": 2, "junk": 1},
            {"id": "t-1", "title": "First", "rank": 1},
        ]}
        self.mock.set_file_text("data", "board.json", json.dumps(raw))
        status = worker.sync_once()
        self.assertEqual(status["state"], "ok")
        self.assertEqual(self.mock.count("PUT", status=200), 1)
        remote = self.remote()
        self.assertEqual([t["id"] for t in remote["tasks"]], ["t-1", "t-2"])
        self.assertEqual(remote["tasks"][1]["status"], "done")
        self.assertNotIn("junk", remote["tasks"][1])
        self.assertIn("clean up", self.mock.commits("data")[-1]["message"])
        # a clean file is left alone afterwards
        self.mock.clear_log()
        worker.sync_once()
        worker.sync_once()
        self.assertEqual(self.mock.count("PUT"), 0)

    def test_noop_ops_are_not_committed(self):
        store, worker = self.start()
        worker.sync_once()
        commits = len(self.mock.commits("data"))
        store.submit([update("t-gone", title="x")])
        status = worker.sync_once()
        self.assertEqual(status["pending"], 0)
        self.assertEqual(status["state"], "ok")
        self.assertEqual(len(self.mock.commits("data")), commits)

    def test_ops_queued_during_push_are_kept(self):
        store, worker = self.start()
        store.submit([add_task("t-1", "First")])
        self.mock.on_next("PUT", lambda: store.submit([add_task("t-2", "Second")]), "/contents/")
        status = worker.sync_once()
        self.assertEqual(status["pending"], 1)
        self.assertEqual(titles(self.remote()), ["First"])
        self.assertEqual(titles(store.view()), ["First", "Second"])
        status = worker.sync_once()
        self.assertEqual(status["pending"], 0)
        self.assertEqual(titles(self.remote()), ["First", "Second"])

    def test_large_file_falls_back_to_blob_api(self):
        store, worker = self.start()
        self.mock.set_file_text("data", "board.json", json.dumps({"tasks": [{"id": "t-1", "title": "Big"}]}))
        # emulate GitHub's >1 MB response: no inline content
        orig = self.mock.server.RequestHandlerClass._file_info

        def no_content(handler, fpath, data):
            info = orig(handler, fpath, data)
            info["encoding"] = "none"
            return info

        self.mock.server.RequestHandlerClass._file_info = no_content
        try:
            worker.sync_once()
        finally:
            self.mock.server.RequestHandlerClass._file_info = orig
        self.assertEqual(titles(store.view()), ["Big"])
        self.assertEqual(self.mock.count("GET", "/git/blobs/"), 1)

    def test_background_thread_pushes_after_kick(self):
        store, worker = self.start(interval=60)
        worker.start()
        self.assertTrue(wait_until(lambda: store.sync_status()["state"] == "ok"), store.sync_status())
        store.submit([add_task("t-1", "Kicked")])
        t0 = time.time()
        worker.kick()
        self.assertTrue(wait_until(lambda: store.sync_status()["pending"] == 0, timeout=8))
        self.assertLess(time.time() - t0, 6)
        self.assertEqual(titles(self.remote()), ["Kicked"])
        # a burst of kicks is debounced into one commit
        commits = len(self.mock.commits("data"))
        for i in range(5):
            store.submit([update("t-1", rank=i + 1)])
            worker.kick()
            time.sleep(0.05)
        self.assertTrue(wait_until(lambda: store.sync_status()["pending"] == 0, timeout=8))
        self.assertEqual(len(self.mock.commits("data")), commits + 1)
        self.assertEqual(self.mock.commits("data")[-1]["message"].split("\n")[0], "lab-pi: reorder 5 tasks")

    def test_backoff_grows_and_kick_overrides(self):
        store, worker = self.start(interval=15)
        self.mock.set_offline(True)
        delays = []
        for _ in range(7):
            worker.sync_once()
            delays.append(round(worker._next_at - time.monotonic()))
        self.assertEqual(delays, [15, 30, 60, 120, 240, 300, 300])
        worker.start()
        self.mock.set_offline(False)
        store.submit([add_task("t-1", "A")])
        worker.kick(delay=0.05)
        self.assertTrue(wait_until(lambda: store.sync_status()["state"] == "ok", timeout=5))
        self.assertGreater(worker._next_at - time.monotonic(), 10)  # back to the normal interval

    def test_manual_sync_waits_for_running_cycle(self):
        store, worker = self.start()
        acquired = worker._cycle_lock.acquire()
        self.assertTrue(acquired)
        try:
            t0 = time.time()
            status = worker.sync_once(wait=0.2)
            self.assertLess(time.time() - t0, 2)
            self.assertEqual(self.mock.requests, [])
            self.assertEqual(status["state"], "syncing")
        finally:
            worker._cycle_lock.release()
        # with the lock free the manual sync runs a full cycle
        self.assertEqual(worker.sync_now()["state"], "ok")

    def test_concurrent_cycles_are_serialized(self):
        store, worker = self.start()
        for i in range(5):
            store.submit([add_task("t-%d" % i, "T%d" % i, i)])
        threads = [threading.Thread(target=worker.sync_once) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        self.assertEqual(store.sync_status()["pending"], 0)
        self.assertEqual(len(self.remote()["tasks"]), 5)
        self.assertEqual(len([p for p in self.puts() if p["status"] in (200, 201)]), 1)
        self.assertEqual([p for p in self.puts() if p["status"] == 409], [])


if __name__ == "__main__":
    unittest.main()
