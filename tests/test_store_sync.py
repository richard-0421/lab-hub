"""app/store.py persistence + app/github_sync.py against tests/mock_github.py."""
import contextlib
import errno
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from app import board as B  # noqa: E402
from app import store as S  # noqa: E402
from app.github_sync import GitHubClient, SyncWorker, git_blob_sha  # noqa: E402
from app.store import OpError, Store, StoreUnavailable  # noqa: E402
from tests.mock_github import MockGitHub  # noqa: E402

REPO = "richard-0421/lab-hub"
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


def delete(tid, coll="tasks"):
    return {"op": "delete", "coll": coll, "id": tid, "ts": TS, "by": "Richard"}


def board_of(*tasks):
    return B.normalize_board({"tasks": list(tasks)})


@contextlib.contextmanager
def failing_writes(*names):
    """Writes of these state files fail like a full SD card (ENOSPC)."""
    real = S.atomic_write

    def write(path, data):
        if os.path.basename(path) in names:
            raise OSError(errno.ENOSPC, "No space left on device")
        return real(path, data)

    with mock.patch.object(S, "atomic_write", write):
        yield


def wait_until(pred, timeout=5.0, step=0.02):
    # monotonic: a wall-clock jump (e.g. waking from sleep) must not end the wait early
    end = time.monotonic() + timeout
    while time.monotonic() < end:
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

    def test_config_error_is_shown_while_off_and_never_persisted(self):
        msg = "config: github_branch 'x..y' is not a valid branch name"
        # an error recorded while sync was on (same target) ...
        g = self.gh_store()
        g.set_error("GitHub token rejected (expired or revoked?)")
        self.assertEqual(g.sync_status()["last_error"], "GitHub token rejected (expired or revoked?)")
        # ... is stale once sync is off; only the config problem is reported
        s = Store(self.state, github_enabled=False, repo=REPO, branch="data", path="board.json",
                  api="http://127.0.0.1:9", config_error=msg)
        for status in (s.sync_status(), s.board_response()["sync"], s.submit([add_task("t-1", "A")])["sync"]):
            self.assertEqual(status["state"], "off")
            self.assertIs(status["enabled"], False)
            self.assertEqual(status["last_error"], msg)
        with open(os.path.join(self.state, "sync.json"), encoding="utf-8") as f:
            self.assertNotIn(msg, f.read())
        # config fixed but still no token: off, and nothing to report
        s = Store(self.state, github_enabled=False, repo=REPO, branch="data", path="board.json",
                  api="http://127.0.0.1:9")
        self.assertIsNone(s.sync_status()["last_error"])
        self.assertIsNone(self.local_store().sync_status()["last_error"])
        # sync on: the config error (if a caller passed one) never masks the real state
        g = Store(self.state, github_enabled=True, repo=REPO, branch="data", path="board.json",
                  api="http://127.0.0.1:9", config_error=msg)
        self.assertNotEqual(g.sync_status()["last_error"], msg)

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

    def test_queued_ops_are_normalized_and_stored_compactly(self):
        s = self.gh_store()
        op = add_task("t-1", "  " + "A" * 1000, junk="x" * 5000, notes=["not text"])
        op["ts"] = "2026-10-16T16:00:00.123456789+02:00"
        edit = update("t-1", assignee="m" * 500, tags=["#Bio", "bio", " x "], rank=2.0)
        s.submit([op, edit])
        added, changed = s.pending()
        self.assertNotIn("junk", added["item"])
        self.assertEqual(len(added["item"]["title"]), 300)
        self.assertEqual(added["item"]["notes"], "")
        self.assertEqual(added["ts"], "2026-10-16T14:00:00Z")
        self.assertEqual(changed["set"], {"assignee": "m" * 60, "tags": ["bio", "x"], "rank": 2})
        self.assertEqual(set(changed), {"op", "coll", "id", "set", "ts", "by"})
        with open(os.path.join(self.state, "pending.json"), "rb") as f:
            raw = f.read()
        self.assertLess(len(raw), 1200)
        self.assertNotIn(b"\n", raw)
        # same view as applying the raw ops
        self.assertEqual(s.view(), B.apply_ops(B.empty_board(), [op, edit]))

    def test_full_collection_rejects_adds(self):
        os.makedirs(self.state)
        with open(os.path.join(self.state, "remote.json"), "wb") as f:
            f.write(B.serialize_board_bytes(board_of(*[{"id": "t%04d" % i, "title": "x", "rank": i}
                                                       for i in range(B.MAX_ITEMS)])))
        for s in (self.local_store(), self.gh_store()):
            with self.assertRaises(OpError) as cm:
                s.submit([add_task("t-new", "New", -1)])
            self.assertEqual(cm.exception.index, 0)
            self.assertIn("board full", cm.exception.message)
            with self.assertRaises(OpError) as cm:
                s.submit([delete("t0001"), add_task("t-new", "New", -1), add_task("t-new2", "Too many")])
            self.assertEqual(cm.exception.index, 2)
            self.assertEqual(len(s.view()["tasks"]), B.MAX_ITEMS)
            # re-adding an existing id is still fine, and a delete makes room
            s.submit([add_task("t0005", "dup")])
            res = s.submit([delete("t0001"), add_task("t-new", "New", -1)])
            self.assertEqual(res["board"]["tasks"][0]["id"], "t-new")
            self.assertEqual(len(res["board"]["tasks"]), B.MAX_ITEMS)

    def test_pending_queue_is_capped(self):
        s = self.gh_store()
        with mock.patch.object(S, "MAX_PENDING", 3):
            s.submit([add_task("t-1", "A"), add_task("t-2", "B")])
            rev = s.rev
            with self.assertRaises(StoreUnavailable):
                s.submit([add_task("t-3", "C"), add_task("t-4", "D")])
        self.assertEqual(len(s.pending()), 2)
        self.assertEqual(s.rev, rev)
        self.assertEqual(titles(s.view()), ["A", "B"])

    def test_unsaved_change_is_refused_not_acknowledged(self):
        g = self.gh_store()
        g.submit([add_task("t-1", "Kept")])
        rev = g.rev
        with failing_writes("pending.json"):
            with self.assertRaises(StoreUnavailable) as cm:
                g.submit([add_task("t-2", "Lost?")])
        self.assertIn("disk full", cm.exception.message)
        self.assertEqual(titles(g.view()), ["Kept"])
        self.assertEqual(len(g.pending()), 1)
        self.assertEqual(g.rev, rev)
        shutil.rmtree(self.state)
        s = self.local_store()
        s.submit([add_task("t-1", "Kept")])
        with failing_writes("remote.json"):
            with self.assertRaises(StoreUnavailable):
                s.submit([add_task("t-2", "Lost?")])
        self.assertEqual(titles(s.view()), ["Kept"])
        self.assertEqual(titles(self.local_store().view()), ["Kept"])

    def test_board_write_failure_never_leaves_an_etag_for_a_stale_board(self):
        g = self.gh_store()
        g.on_remote_fetched(board_of({"id": "t-a", "title": "Alpha"}), "s1", '"s1"')
        newer = board_of({"id": "t-a", "title": "Alpha"}, {"id": "t-web", "title": "Web", "rank": 1})
        with failing_writes("remote.json"):
            g.on_remote_fetched(newer, "s2", '"s2"')
        self.assertEqual(titles(g.view()), ["Alpha", "Web"])
        with open(os.path.join(self.state, "sync.json")) as f:
            self.assertIsNone(json.load(f)["etag"])
        # a restart now downloads the board instead of trusting a 304
        self.assertIsNone(self.gh_store().fetch_params()["etag"])
        # the next fetch retries the write although the board did not change
        g.on_remote_fetched(newer, "s2", '"s2"')
        again = self.gh_store()
        self.assertEqual(titles(again.base()), ["Alpha", "Web"])
        self.assertEqual(again.fetch_params()["etag"], '"s2"')

    def test_missing_board_file_drops_the_etag(self):
        g = self.gh_store()
        g.on_remote_fetched(board_of({"id": "t-a", "title": "Alpha"}), "s1", '"s1"')
        self.assertEqual(self.gh_store().fetch_params()["etag"], '"s1"')
        os.remove(os.path.join(self.state, "remote.json"))
        self.assertIsNone(self.gh_store().fetch_params()["etag"])


class ModeSwitchTests(TempDirTest):
    """GitHub sync switched off (bad config.json, token removed ...) and on again."""

    def seed(self, store, *tasks, sha="s1"):
        store.on_remote_fetched(board_of(*tasks), sha, '"%s"' % sha)

    ABCD = ({"id": "t-a", "title": "Alpha", "rank": 1}, {"id": "t-b", "title": "Beta", "rank": 2},
            {"id": "t-c", "title": "Gamma", "rank": 3}, {"id": "t-d", "title": "Delta", "rank": 4})

    def test_changes_made_around_a_local_only_spell_are_replayed_exactly(self):
        g = self.gh_store()
        self.seed(g, *self.ABCD)
        # offline: complete Alpha, delete Beta (queued)
        g.submit([update("t-a", status="done", done_at=TS), delete("t-b")])
        # the service restarts without the token: local-only
        s = self.local_store()
        self.assertEqual(titles(s.view()), ["Alpha", "Delta", "Gamma"])
        self.assertEqual(s.pending(), [])
        self.assertTrue(os.path.exists(os.path.join(self.state, "snapshot.json")))
        s.submit([update("t-d", title="Delta (kiosk)")])
        self.assertEqual(titles(self.local_store().view()), ["Alpha", "Delta (kiosk)", "Gamma"])
        # the token is back
        g2 = self.gh_store()
        queued = g2.pending()
        self.assertEqual(sorted((op["op"], op.get("id")) for op in queued),
                         [("delete", "t-b"), ("update", "t-a"), ("update", "t-d")])
        changes = {op["id"]: op["set"] for op in queued if op["op"] == "update"}
        self.assertEqual(changes["t-a"], {"status": "done", "done_at": TS})
        self.assertEqual(changes["t-d"], {"title": "Delta (kiosk)"})
        self.assertFalse(os.path.exists(os.path.join(self.state, "snapshot.json")))
        # meanwhile on GitHub: Gamma deleted, Delta's priority raised
        self.seed(g2, self.ABCD[0], self.ABCD[1], dict(self.ABCD[3], priority="high"), sha="s2")
        view = {t["id"]: t for t in g2.view()["tasks"]}
        self.assertEqual(sorted(view), ["t-a", "t-d"])  # Beta stays deleted, Gamma stays gone
        self.assertEqual((view["t-a"]["status"], view["t-a"]["done_at"]), ("done", TS))
        self.assertEqual((view["t-d"]["title"], view["t-d"]["priority"]), ("Delta (kiosk)", "high"))
        # another restart queues nothing twice
        self.assertEqual(len(self.gh_store().pending()), 3)

    def test_remote_delete_during_local_only_spell_is_not_undone(self):
        g = self.gh_store()
        self.seed(g, *self.ABCD)
        self.local_store()
        g2 = self.gh_store()
        self.assertEqual(g2.pending(), [])
        self.seed(g2, *self.ABCD[:3], sha="s2")  # Delta deleted on the web meanwhile
        self.assertEqual(titles(g2.view()), ["Alpha", "Beta", "Gamma"])

    def test_other_target_gets_the_board_as_new_items(self):
        g = self.gh_store()
        self.seed(g, self.ABCD[0])
        self.local_store()
        with self.assertLogs("labhub.store", level="WARNING") as logs:
            g2 = self.gh_store(repo="richard-0421/another-board")
        self.assertEqual([(op["op"], op["item"]["id"]) for op in g2.pending()], [("add", "t-a")])
        self.assertEqual(g2.base(), B.empty_board())
        self.assertTrue(any("not where this board was last synced" in m for m in logs.output), logs.output)

    def test_requeue_writes_the_queue_before_emptying_the_board(self):
        s = self.local_store()
        s.submit([add_task("t-%d" % i, "T%d" % i, i) for i in range(5)])
        # first GitHub start: the queue can't be saved (full disk / power cut)
        with failing_writes("pending.json"):
            g = self.gh_store()
            self.assertEqual(len(g.view()["tasks"]), 5)
            # ... and a fetch must not overwrite the only copy of the board
            g.on_remote_fetched(board_of({"id": "t-web", "title": "Web"}), "s1", '"s1"')
        g = self.gh_store()
        self.assertEqual(len(g.pending()), 5)
        self.assertEqual(len(g.view()["tasks"]), 5)

    def test_requeue_crash_between_files_keeps_every_item(self):
        s = self.local_store()
        s.submit([add_task("t-%d" % i, "T%d" % i, i) for i in range(5)])
        # dies after pending.json, before remote.json / sync.json
        with failing_writes("remote.json", "sync.json"):
            self.gh_store()
        self.assertEqual(len(self.gh_store().view()["tasks"]), 5)
        shutil.rmtree(self.state)
        s = self.local_store()
        s.submit([add_task("t-%d" % i, "T%d" % i, i) for i in range(5)])
        # dies after remote.json, before sync.json
        with failing_writes("sync.json"):
            self.gh_store()
        g = self.gh_store()
        self.assertEqual(len(g.view()["tasks"]), 5)
        self.assertEqual(len(g.pending()), 5)

    def test_fold_crash_does_not_replay_old_ops_over_newer_edits(self):
        g = self.gh_store()
        self.seed(g, self.ABCD[0])
        g.submit([update("t-a", title="Alpha 2")])
        with failing_writes("pending.json"):
            s = self.local_store()  # folded, but the stale queue file stays
        s.submit([update("t-a", title="Alpha 3")])
        self.assertEqual(titles(self.local_store().view()), ["Alpha 3"])


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
        self.cfg = {
            "github_repo": repo, "github_branch": "data", "github_path": "board.json",
            "github_token": token, "github_api": self.mock.url, "client_name": "lab-pi",
            "sync_interval": interval,
        }
        self.worker = SyncWorker(self.store, self.cfg)
        return self.store, self.worker

    def restart(self):
        """A new process: store and worker rebuilt from state/."""
        self.store = self.gh_store(api=self.mock.url, repo=self.cfg["github_repo"])
        self.worker = SyncWorker(self.store, self.cfg)
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

    def history(self, branch):
        """Every commit reachable from ``branch`` (newest first)."""
        out, sha = [], self.mock.head(branch)["sha"]
        while sha:
            c = self.mock.commit(sha)
            out.append(c)
            self.assertLessEqual(len(c["parents"]), 1)
            sha = c["parents"][0] if c["parents"] else None
        return out

    def posted(self, path_end):
        return [json.loads(r["body"]) for r in self.mock.requests if r["method"] == "POST" and r["path"].endswith(path_end)]

    def test_missing_branch_is_created_as_an_orphan(self):
        store, worker = self.start(create_data_branch=False)
        self.assertNotIn("data", self.mock.branches)
        main_head = self.mock.head("main")
        store.submit([add_task("t-1", "A")])
        self.mock.clear_log()
        status = worker.sync_once()
        self.assertEqual(status["state"], "ok", status)
        self.assertEqual(status["pending"], 0)
        self.assertIsNone(status["last_error"])
        calls = [(r["method"], r["path"].split("/lab-hub", 1)[1] or "/", r["status"]) for r in self.mock.requests]
        self.assertEqual(calls, [
            ("GET", "/contents/board.json", 404),
            ("GET", "/", 200),
            ("PUT", "/contents/board.json", 404),      # Branch data not found
            ("POST", "/git/trees", 201),
            ("POST", "/git/commits", 201),
            ("POST", "/git/refs", 201),
            ("GET", "/contents/board.json", 200),      # the normal cycle on the new branch
            ("PUT", "/contents/board.json", 200),
        ])
        # the tree holds only board.json (no base_tree), the commit has no parents
        (tree_req,) = self.posted("/git/trees")
        self.assertEqual(set(tree_req), {"tree"})
        self.assertEqual([{k: v for k, v in e.items() if k != "content"} for e in tree_req["tree"]],
                         [{"path": "board.json", "mode": "100644", "type": "blob"}])
        (commit_req,) = self.posted("/git/commits")
        self.assertEqual(commit_req["parents"], [])
        (ref_req,) = self.posted("/git/refs")
        self.assertEqual(ref_req["ref"], "refs/heads/data")

        history = self.history("data")
        self.assertEqual(len(history), 2)
        head, root = history
        self.assertEqual(ref_req["sha"], root["sha"])
        self.assertEqual(commit_req["tree"], root["tree"])
        self.assertEqual(root["parents"], [])
        self.assertEqual(sorted(root["files"]), ["board.json"])   # no README.md, no code
        self.assertEqual(root["message"].split("\n")[0], "lab-pi: create board.json")
        first = B.parse_json_strict(root["files"]["board.json"].decode("utf-8"))
        self.assertEqual(first, B.normalize_board(first))           # canonical, needs no clean-up commit
        self.assertEqual([first[c] for c in B.COLLECTIONS], [[], [], []])
        self.assertEqual(first["updated_by"], "lab-pi")
        # then the queued op went in the normal way: PUT with the root's blob sha
        put = json.loads(self.puts()[-1]["body"])
        self.assertEqual(put["sha"], git_blob_sha(root["files"]["board.json"]))
        self.assertEqual(head["parents"], [root["sha"]])
        self.assertEqual(sorted(head["files"]), ["board.json"])
        self.assertEqual(titles(self.remote()), ["A"])
        self.assertEqual(store.view(), B.normalize_board(self.remote()))
        # main is untouched and shares no history with data
        self.assertEqual(self.mock.head("main")["sha"], main_head["sha"])
        self.assertIsNone(self.mock.get_file_text("main", "board.json"))
        self.assertNotIn(main_head["sha"], [c["sha"] for c in history])

        # from now on it is a plain sync
        store.submit([add_task("t-2", "B", 1)])
        self.mock.clear_log()
        self.assertEqual(worker.sync_once()["state"], "ok")
        self.assertEqual(titles(self.remote()), ["A", "B"])
        self.assertEqual(self.mock.count("POST"), 0)
        self.assertEqual(len(self.history("data")), 3)
        self.assertEqual(worker.sync_once()["pending"], 0)

    def test_missing_branch_without_queued_ops_is_one_orphan_commit(self):
        store, worker = self.start(create_data_branch=False)
        status = worker.sync_once()
        self.assertEqual(status["state"], "ok", status)
        (root,) = self.history("data")
        self.assertEqual(root["parents"], [])
        self.assertEqual(sorted(root["files"]), ["board.json"])
        self.assertEqual(B.normalize_board(self.remote()), store.view())
        self.assertEqual(self.mock.count("PUT", status=200) + self.mock.count("PUT", status=201), 0)
        self.assertEqual(worker.sync_once()["state"], "ok")
        self.assertEqual(len(self.history("data")), 1)

    def test_empty_repo_asks_for_the_code_first(self):
        store, worker = self.start(empty=True)
        store.submit([add_task("t-1", "A")])
        status = worker.sync_once()
        self.assertEqual(status["state"], "error")
        self.assertEqual(status["last_error"], "the GitHub repo has no commits yet - push the Lab Hub code to "
                                               "it first, then the 'data' branch is created on the next sync")
        self.assertEqual(status["pending"], 1)
        self.assertEqual(self.mock.count("POST", "/git/trees", 409), 1)
        self.assertEqual(self.mock.count("POST", "/git/refs"), 0)
        self.assertEqual(self.mock.branches, {})
        # the owner pushes the code: the next sync creates the orphan branch
        self.mock.set_file_text("main", "README.md", "# lab-hub\n", "Initial commit")
        status = worker.sync_once()
        self.assertEqual(status["state"], "ok", status)
        self.assertEqual(titles(self.remote()), ["A"])
        root = self.history("data")[-1]
        self.assertEqual((root["parents"], sorted(root["files"])), ([], ["board.json"]))
        self.assertEqual(sorted(self.mock.branches["main"]["files"]), ["README.md"])

    def test_branch_created_by_someone_else_meanwhile(self):
        store, worker = self.start(create_data_branch=False)
        web = json.dumps({"tasks": [{"id": "t-w", "title": "Web"}]})
        # a browser creates the branch between our 404 and our POST git/refs
        self.mock.on_next("POST", lambda: self.mock.set_file_text("data", "board.json", web), "/git/refs")
        store.submit([add_task("t-l", "Local")])
        status = worker.sync_once()
        self.assertEqual(status["state"], "ok", status)
        self.assertEqual(self.mock.count("POST", "/git/refs", 422), 1)
        self.assertEqual(titles(self.remote()), ["Local", "Web"])

    def test_lost_ref_answer_is_picked_up_next_cycle(self):
        store, worker = self.start(create_data_branch=False)
        self.mock.drop_response_next("POST", "/git/refs")
        store.submit([add_task("t-1", "A")])
        status = worker.sync_once()
        self.assertEqual(status["state"], "offline")
        self.assertIn("data", self.mock.branches)  # it was created; only the answer was lost
        status = worker.sync_once()
        self.assertEqual(status["state"], "ok", status)
        self.assertEqual(self.mock.count("POST", "/git/refs"), 1)
        self.assertEqual(titles(self.remote()), ["A"])
        self.assertEqual(len(self.history("data")), 2)

    def test_new_branch_not_visible_yet_is_retried(self):
        store, worker = self.start(create_data_branch=False)
        store.submit([add_task("t-1", "A")])
        # GitHub's replicas lag: the PUT right after creating the branch still misses it
        self.mock.on_next("POST", lambda: self.mock.fail_next(404, "Branch data not found", method="PUT"),
                          "/git/refs")
        status = worker.sync_once()
        self.assertEqual(status["state"], "error")
        self.assertEqual(status["last_error"], "the new 'data' branch is not visible on GitHub yet; will retry shortly")
        self.assertEqual(status["pending"], 1)
        status = worker.sync_once()
        self.assertEqual(status["state"], "ok", status)
        self.assertEqual(self.mock.count("POST", "/git/refs"), 1)
        self.assertEqual(titles(self.remote()), ["A"])

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
        store, worker = self.start(repo="richard-0421/does-not-exist")
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

    # ---- pushes whose answer is lost ------------------------------------ #
    def web_edit_after(self):
        """The web deletes "Order tips" and renames Beta."""
        web = self.remote()
        web["tasks"] = [t for t in web["tasks"] if t["id"] != "t-a"]
        web["tasks"][0]["title"] = "Beta (web)"
        self.mock.set_file_text("data", "board.json", json.dumps(web))

    def lab_pi_pushes(self, text):
        return [c for c in self.mock.commits("data") if c["message"].startswith("lab-pi") and text in c["message"]]

    def test_lost_put_response_is_recognised_at_once(self):
        store, worker = self.start()
        store.submit([add_task("t-b", "Beta", 2)])
        worker.sync_once()
        store.submit([add_task("t-a", "Order tips", 1), update("t-b", title="Beta v2")])
        self.mock.drop_response_next("PUT", "/contents/")
        status = worker.sync_once()
        self.assertEqual(status["state"], "ok", status)
        self.assertEqual(status["pending"], 0)
        self.assertIsNone(store.inflight())
        self.assertEqual(titles(store.view()), ["Beta v2", "Order tips"])
        self.web_edit_after()
        self.mock.clear_log()
        self.assertEqual(worker.sync_once()["state"], "ok")
        self.assertEqual(self.mock.count("PUT"), 0)
        self.assertEqual(titles(self.remote()), ["Beta (web)"])
        self.assertEqual(titles(store.view()), ["Beta (web)"])
        self.assertEqual(len(self.lab_pi_pushes("Order tips")), 1)

    def test_lost_put_response_is_found_in_history_after_a_restart(self):
        store, worker = self.start()
        store.submit([add_task("t-b", "Beta", 2)])
        worker.sync_once()
        store.submit([add_task("t-a", "Order tips", 1), update("t-b", title="Beta v2")])
        self.mock.drop_response_next("PUT", "/contents/")
        # the check right after the lost answer fails too
        self.mock.on_next("PUT", lambda: self.mock.fail_next(502, "Server Error", method="GET"), "/contents/")
        status = worker.sync_once()
        self.assertEqual(status["state"], "offline", status)
        self.assertEqual(status["pending"], 2)
        self.assertIsNotNone(store.inflight())
        self.web_edit_after()  # others edit on top of the committed push
        store, worker = self.restart()
        self.mock.clear_log()
        status = worker.sync_once()
        self.assertEqual(status["state"], "ok", status)
        self.assertEqual(status["pending"], 0)
        self.assertEqual(self.mock.count("PUT"), 0)
        self.assertEqual(self.mock.count("GET", "/commits"), 1)
        self.assertEqual(titles(self.remote()), ["Beta (web)"])
        self.assertEqual(titles(store.view()), ["Beta (web)"])
        self.assertEqual(len(self.lab_pi_pushes("Order tips")), 1)

    def test_put_that_did_not_land_is_sent_again(self):
        store, worker = self.start()
        worker.sync_once()
        store.submit([add_task("t-1", "A")])
        self.mock.fail_next(502, "Server Error", method="PUT")  # answered before committing
        status = worker.sync_once()
        self.assertEqual(status["state"], "error")
        self.assertEqual(status["pending"], 1)
        self.assertIsNone(store.inflight())
        self.assertEqual(worker.sync_once()["state"], "ok")
        self.assertEqual(titles(self.remote()), ["A"])
        self.assertEqual(len(self.lab_pi_pushes("“A”")), 1)

    def test_lost_create_put_is_recognised(self):
        store, worker = self.start()
        store.submit([add_task("t-1", "First")])
        self.mock.drop_response_next("PUT", "/contents/")
        self.mock.on_next("PUT", lambda: self.mock.fail_next(502, "Server Error", method="GET"), "/contents/")
        self.assertEqual(worker.sync_once()["state"], "offline")
        self.assertIsNone(store.inflight()["parent"])
        store, worker = self.restart()
        self.mock.clear_log()
        self.assertEqual(worker.sync_once()["pending"], 0)
        self.assertEqual(self.mock.count("PUT"), 0)
        self.assertEqual(titles(self.remote()), ["First"])

    def test_inflight_record_matches_the_bytes_sent(self):
        store, worker = self.start()
        store.submit([add_task("t-1", "A")])
        seen = {}
        self.mock.on_next("PUT", lambda: seen.update(store.inflight()), "/contents/")
        worker.sync_once()
        text = self.mock.get_file_text("data", "board.json").encode("utf-8")
        self.assertEqual(seen["expected"], git_blob_sha(text))
        self.assertEqual(seen["k"], 1)
        self.assertIsNone(store.inflight())

    # ---- state files ------------------------------------------------------ #
    def test_board_write_failure_cannot_leave_a_stale_base_behind(self):
        store, worker = self.start()
        store.submit([add_task("t-a", "Alpha")])
        worker.sync_once()
        worker.sync_once()  # GET 200: etag stored
        web = self.remote()
        web["tasks"].append({"id": "t-web", "title": "Web", "rank": 5})
        self.mock.set_file_text("data", "board.json", json.dumps(web))
        with failing_writes("remote.json"):
            worker.sync_once()
        store, worker = self.restart()
        self.mock.clear_log()
        worker.sync_once()
        self.assertEqual([(r["method"], r["status"]) for r in self.mock.requests], [("GET", 200)])
        self.assertEqual(titles(store.view()), ["Alpha", "Web"])
        store.submit([add_task("t-pi", "Pi", 6)])
        worker.sync_once()
        self.assertEqual(titles(self.remote()), ["Alpha", "Pi", "Web"])

    def test_github_local_github_round_trip_keeps_every_edit(self):
        store, worker = self.start()
        store.submit([add_task("t-a", "Alpha", 1), add_task("t-b", "Beta", 2), add_task("t-c", "Gamma", 3)])
        worker.sync_once()
        worker.sync_once()
        self.mock.set_offline(True)
        store.submit([update("t-a", status="done", done_at=TS), delete("t-b")])
        self.assertEqual(worker.sync_once()["state"], "offline")
        self.mock.set_offline(False)
        web = self.remote()
        web["tasks"] = [t for t in web["tasks"] if t["id"] != "t-c"]
        self.mock.set_file_text("data", "board.json", json.dumps(web))
        local = self.local_store()  # e.g. a typo in config.json
        local.submit([add_task("t-k", "Kiosk", 9)])
        store, worker = self.restart()  # config fixed
        self.assertEqual(worker.sync_once()["state"], "ok")
        remote = {t["id"]: t for t in self.remote()["tasks"]}
        self.assertEqual(sorted(remote), ["t-a", "t-k"])
        self.assertEqual(remote["t-a"]["status"], "done")
        self.assertEqual(store.view(), B.normalize_board(self.remote()))

    def test_over_cap_remote_is_reported(self):
        store, worker = self.start()
        doc = {"tasks": [{"id": "t%04d" % i, "title": "x", "rank": i} for i in range(B.MAX_ITEMS + 1)]}
        self.mock.set_file_text("data", "board.json", json.dumps(doc))
        with self.assertLogs("labhub.sync", level="WARNING") as logs:
            worker.sync_once()
        self.assertTrue(any("more than 2000 items in tasks" in m for m in logs.output), logs.output)
        self.assertEqual(len(store.view()["tasks"]), B.MAX_ITEMS)


# --------------------------------------------------------------------------- #
# the mock's Git database API (the orphan-branch path depends on its fidelity)
# --------------------------------------------------------------------------- #
class MockGitDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.mock = None
        self.tmp = tempfile.mkdtemp(prefix="labhub-git-")

    def tearDown(self):
        if self.mock is not None:
            self.mock.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def start(self, **kw):
        self.mock = MockGitHub(repo=REPO, token=TOKEN, **kw).start()
        self.client = GitHubClient(self.mock.url, REPO, TOKEN)
        return self.mock

    def call(self, method, path, body=None):
        status, _, data = self.client.request(method, self.client._repo_path(path), body=body)
        return status, json.loads(data.decode("utf-8"))

    def git_tree_sha(self, files):
        """The tree id real git computes for {path: bytes} (skipped without git)."""
        if shutil.which("git") is None:
            self.skipTest("git is not installed")
        repo = os.path.join(self.tmp, "repo-%d" % len(os.listdir(self.tmp)))
        os.makedirs(repo)
        env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
        subprocess.run(["git", "init", "-q", repo], check=True, env=env)
        for path, data in files.items():
            full = os.path.join(repo, *path.split("/"))
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "wb") as f:
                f.write(data)
        subprocess.run(["git", "-C", repo, "add", "-A"], check=True, env=env)
        out = subprocess.run(["git", "-C", repo, "write-tree"], check=True, env=env, stdout=subprocess.PIPE)
        return out.stdout.decode("ascii").strip()

    def test_orphan_commit_and_ref(self):
        mock = self.start(create_data_branch=False)
        text = B.serialize_board(B.empty_board())
        status, tree = self.call("POST", "/git/trees", {"tree": [
            {"path": "board.json", "mode": "100644", "type": "blob", "content": text}]})
        self.assertEqual(status, 201)
        self.assertEqual(set(tree), {"sha", "url", "tree", "truncated"})
        self.assertEqual(tree["sha"], self.git_tree_sha({"board.json": text.encode("utf-8")}))
        (entry,) = tree["tree"]
        self.assertEqual({k: entry[k] for k in ("path", "mode", "type", "sha", "size")},
                         {"path": "board.json", "mode": "100644", "type": "blob",
                          "sha": git_blob_sha(text.encode("utf-8")), "size": len(text.encode("utf-8"))})

        status, commit = self.call("POST", "/git/commits", {"message": "lab-pi: create board.json",
                                                            "tree": tree["sha"], "parents": []})
        self.assertEqual(status, 201)
        self.assertEqual(commit["parents"], [])
        self.assertEqual(commit["tree"]["sha"], tree["sha"])
        self.assertEqual(commit["message"], "lab-pi: create board.json")
        for key in ("sha", "node_id", "url", "html_url", "author", "committer", "verification"):
            self.assertIn(key, commit)
        self.assertNotIn("data", mock.branches)  # a commit alone is not a branch

        status, ref = self.call("POST", "/git/refs", {"ref": "refs/heads/data", "sha": commit["sha"]})
        self.assertEqual(status, 201)
        self.assertEqual((ref["ref"], ref["object"]["sha"], ref["object"]["type"]),
                         ("refs/heads/data", commit["sha"], "commit"))
        self.assertEqual(self.client.get_file("board.json", "data").data, text.encode("utf-8"))
        self.assertEqual(self.client.list_commits("data", "board.json"), [commit["sha"]])
        self.assertEqual(mock.commits("data")[0]["sha"], commit["sha"])
        status, err = self.call("POST", "/git/refs", {"ref": "refs/heads/data", "sha": commit["sha"]})
        self.assertEqual((status, err["message"]), (422, "Reference already exists"))
        # a child commit through the Contents API keeps the history linear
        res = self.client.put_file("board.json", "data", b"{}\n", "edit", git_blob_sha(text.encode("utf-8")))
        self.assertEqual(mock.head("data")["parents"], [commit["sha"]])
        self.assertEqual(self.client.list_commits("data", "board.json"), [res["commit"]["sha"], commit["sha"]])

    def test_blobs_trees_and_errors(self):
        mock = self.start()
        status, blob = self.call("POST", "/git/blobs", {"content": "lab-hub write-access check\n", "encoding": "utf-8"})
        self.assertEqual(status, 201)
        self.assertEqual(blob["sha"], git_blob_sha(b"lab-hub write-access check\n"))
        status, blob64 = self.call("POST", "/git/blobs", {"content": "aGk=", "encoding": "base64"})
        self.assertEqual((status, blob64["sha"]), (201, git_blob_sha(b"hi")))
        self.assertEqual(self.client.get_blob(blob64["sha"]), b"hi")

        # nested paths, sha entries, base_tree with a deletion: real git tree ids
        status, t1 = self.call("POST", "/git/trees", {"tree": [
            {"path": "b/x.json", "mode": "100644", "type": "blob", "content": "1"},
            {"path": "b.txt", "mode": "100644", "type": "blob", "sha": blob64["sha"]},
            {"path": "a", "mode": "100644", "type": "blob", "content": "2"}]})
        self.assertEqual(status, 201)
        self.assertEqual(t1["sha"], self.git_tree_sha({"b/x.json": b"1", "b.txt": b"hi", "a": b"2"}))
        self.assertEqual([(e["path"], e["type"]) for e in t1["tree"]], [("a", "blob"), ("b.txt", "blob"), ("b", "tree")])
        status, t2 = self.call("POST", "/git/trees", {"base_tree": t1["sha"], "tree": [
            {"path": "a", "mode": "100644", "type": "blob", "sha": None}]})
        self.assertEqual(status, 201)
        self.assertEqual(t2["sha"], self.git_tree_sha({"b/x.json": b"1", "b.txt": b"hi"}))

        for body in ({"tree": [{"path": "../x", "mode": "100644", "type": "blob", "content": "x"}]},
                     {"tree": [{"path": "x", "mode": "100644", "type": "blob", "sha": "0" * 40}]},
                     {"tree": [{"path": "x", "mode": "100644", "type": "tree", "content": "x"}]},
                     {"tree": [{"path": "x", "mode": "100644", "type": "blob"}]},
                     {"tree": "nope"}, {"base_tree": "0" * 40, "tree": []}):
            self.assertEqual(self.call("POST", "/git/trees", body)[0], 422, body)
        status, err = self.call("POST", "/git/commits", {"message": "m", "tree": t1["sha"], "parents": ["0" * 40]})
        self.assertEqual((status, err["message"]), (422, "Parent SHA does not exist or is not a commit object"))
        self.assertEqual(self.call("POST", "/git/commits", {"message": "m", "tree": "0" * 40})[0], 422)
        self.assertEqual(self.call("POST", "/git/refs", {"ref": "refs/heads/x", "sha": "0" * 40})[0], 422)
        # writes need the token
        anon = GitHubClient(mock.url, REPO, "")
        status, _, _ = anon.request("POST", anon._repo_path("/git/trees"), body={"tree": []})
        self.assertEqual(status, 401)

    def test_empty_repo(self):
        mock = self.start(empty=True)
        self.assertEqual(self.call("GET", "")[0], 200)
        status, err = self.call("GET", "/contents/board.json?ref=data")
        self.assertEqual((status, err["message"]), (404, "This repository is empty."))
        for path, body in (("/git/blobs", {"content": "x"}), ("/git/refs", {"ref": "refs/heads/data", "sha": "0" * 40}),
                           ("/git/trees", {"tree": []}),
                           ("/git/commits", {"message": "m", "tree": "4b825dc642cb6eb9a060e54bf8d69288fbee4904"})):
            status, err = self.call("POST", path, body)
            self.assertEqual((status, err["message"]), (409, "Git Repository is empty."), path)
        self.assertEqual(self.call("GET", "/commits?sha=data")[0], 409)
        self.assertEqual(mock.branches, {})


if __name__ == "__main__":
    unittest.main()
