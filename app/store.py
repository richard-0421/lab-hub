"""Persisted local state of the Pi: the last remote board, the pending op
queue and sync metadata. See docs/ARCHITECTURE.md sections 1 and 4.

Files in ``state_dir`` (all written atomically: temp file + os.replace):

    remote.json   ``base``: the last board seen on GitHub (normalized). In
                  local-only mode this *is* the board.
    pending.json  list of ops not yet on GitHub (always [] in local-only mode)
    sync.json     {sha, etag, remote_exists, last_sync, last_push, last_error,
                   state, rev, target, base_origin}

The visible board is ``view = apply_ops(base, pending)``. ``rev`` bumps
whenever the view changes; it starts from a time-based value and is persisted,
so a restarted server never hands out a rev a browser already holds.

Thread-safe (one RLock). No method does network I/O.
"""
import copy
import json
import logging
import os
import shutil
import threading
import time

from .board import (
    COLLECTIONS,
    MAX_BY_LEN,
    apply_ops,
    canonical_timestamp,
    clean_text,
    empty_board,
    normalize_board,
    now_iso,
    serialize_board_bytes,
    validate_op,
)

log = logging.getLogger("labhub.store")

REMOTE_FILE = "remote.json"
PENDING_FILE = "pending.json"
SYNC_FILE = "sync.json"

_OP_KEYS = ("op", "coll", "id", "item", "set", "ts", "by")


class OpError(ValueError):
    """An op failed validation. ``index`` is its position in the submitted
    list (None when the request itself was malformed)."""

    def __init__(self, index, message):
        ValueError.__init__(self, message)
        self.index = index
        self.message = message


def _now_ms():
    return int(time.time() * 1000)


def clean_op(op):
    """Copy of a *validated* op with only the known keys."""
    out = {}
    for key in _OP_KEYS:
        if key in op:
            out[key] = copy.deepcopy(op[key])
    if "by" in out:
        if isinstance(out["by"], str):
            out["by"] = clean_text(out["by"], MAX_BY_LEN)
        else:
            del out["by"]
    return out


def atomic_write(path, data):
    """Write bytes to ``path`` via a temp file + fsync + os.replace."""
    tmp = "%s.tmp-%d-%d" % (path, os.getpid(), threading.get_ident())
    try:
        with open(tmp, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


class Store:
    def __init__(
        self,
        state_dir,
        github_enabled=False,
        repo="",
        branch="data",
        path="board.json",
        api="",
        client_name="lab-pi",
    ):
        self.state_dir = state_dir
        self.github_enabled = bool(github_enabled)
        self.repo = repo or ""
        self.branch = branch or "data"
        self.path = path or "board.json"
        self.client_name = client_name or "lab-pi"
        self._target = "%s|%s|%s|%s" % (api or "", self.repo, self.branch, self.path)
        self._lock = threading.RLock()

        self._base = empty_board()
        self._pending = []
        self._view = empty_board()
        self._rev = _now_ms()
        self._sha = None
        self._etag = None
        self._remote_exists = False
        self._last_sync = None
        self._last_push = None
        self._last_error = None
        self._state = "starting"  # starting | ok | syncing | offline | error
        self._base_origin = "github" if self.github_enabled else "local"
        self.load()

    # ------------------------------------------------------------------ #
    # persistence
    # ------------------------------------------------------------------ #
    def _file(self, name):
        return os.path.join(self.state_dir, name)

    def _read_json(self, name):
        """Parsed JSON of a state file, or None if missing/corrupt (a corrupt
        file is copied to <name>.corrupt and a warning is logged)."""
        path = self._file(name)
        if not os.path.exists(path):
            return None
        try:
            with open(path, "rb") as f:
                return json.loads(f.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            self._quarantine(name, "unreadable (%s)" % exc)
            return None

    def _quarantine(self, name, why):
        path = self._file(name)
        try:
            shutil.copyfile(path, path + ".corrupt")
            kept = " (copy kept as %s.corrupt)" % name
        except OSError:
            kept = ""
        log.warning("state/%s is %s; starting it fresh%s", name, why, kept)

    def _write(self, name, data):
        try:
            os.makedirs(self.state_dir, exist_ok=True)
            atomic_write(self._file(name), data)
        except OSError as exc:
            log.error("could not write state/%s: %s", name, exc)

    def _save_remote(self):
        self._write(REMOTE_FILE, serialize_board_bytes(self._base))

    def _save_pending(self):
        self._write(PENDING_FILE, json.dumps(self._pending, ensure_ascii=True, indent=1).encode("ascii"))

    def _save_sync(self):
        meta = {
            "sha": self._sha,
            "etag": self._etag,
            "remote_exists": self._remote_exists,
            "last_sync": self._last_sync,
            "last_push": self._last_push,
            "last_error": self._last_error,
            "state": self._state,
            "rev": self._rev,
            "target": self._target,
            "base_origin": self._base_origin,
        }
        self._write(SYNC_FILE, json.dumps(meta, ensure_ascii=True, indent=1).encode("ascii"))

    def load(self):
        """(Re)load everything from ``state_dir``; tolerant of missing or
        corrupt files."""
        with self._lock:
            raw_base = self._read_json(REMOTE_FILE)
            self._base = normalize_board(raw_base) if raw_base is not None else empty_board()

            raw_pending = self._read_json(PENDING_FILE)
            pending = []
            if raw_pending is not None and not isinstance(raw_pending, list):
                self._quarantine(PENDING_FILE, "not a list")
            elif raw_pending:
                for op in raw_pending:
                    if validate_op(op) is None:
                        pending.append(clean_op(op))
                    else:
                        log.warning("dropping invalid queued op from state/pending.json: %r", op)
            self._pending = pending

            meta = self._read_json(SYNC_FILE)
            if meta is not None and not isinstance(meta, dict):
                self._quarantine(SYNC_FILE, "not an object")
                meta = None
            meta = meta or {}
            stored_rev = meta.get("rev")
            if isinstance(stored_rev, int) and not isinstance(stored_rev, bool):
                self._rev = max(_now_ms(), stored_rev + 1)
            else:
                self._rev = max(self._rev, _now_ms())
            self._last_push = meta.get("last_push") if isinstance(meta.get("last_push"), str) else None
            self._last_sync = meta.get("last_sync") if isinstance(meta.get("last_sync"), str) else None
            self._last_error = meta.get("last_error") if isinstance(meta.get("last_error"), str) else None
            st = meta.get("state")
            self._state = st if st in ("ok", "offline", "error") else "starting"
            origin = meta.get("base_origin")
            self._base_origin = origin if origin in ("local", "github") else None

            if meta.get("target") == self._target:
                self._sha = meta.get("sha") if isinstance(meta.get("sha"), str) else None
                self._etag = meta.get("etag") if isinstance(meta.get("etag"), str) else None
                self._remote_exists = meta.get("remote_exists") is True
            else:
                # different repo/branch/path (or first run): the sha/etag are
                # meaningless; the next fetch replaces ``base``.
                self._sha = None
                self._etag = None
                self._remote_exists = False
                if meta.get("target") is not None:
                    self._last_sync = None
                    self._last_push = None
                    self._last_error = None
                    self._state = "starting"

            changed = False
            if not self.github_enabled:
                # local-only: fold anything queued into the board itself
                if self._pending:
                    self._base = apply_ops(self._base, self._pending)
                    self._pending = []
                    changed = True
                if self._base_origin != "local":
                    self._base_origin = "local"
                    changed = True
            else:
                if self._base_origin == "local" and self._has_items(self._base):
                    # The board was edited while GitHub sync was off. Re-queue
                    # every item as an ``add`` (a no-op for ids GitHub already
                    # has) so nothing is lost when the remote becomes the truth.
                    adds = self._base_as_adds(self._base)
                    log.info("GitHub sync enabled: queueing %d local items for upload", len(adds))
                    self._pending = adds + self._pending
                    self._base = empty_board()
                    self._sha = None
                    self._etag = None
                    self._remote_exists = False
                    changed = True
                if self._base_origin != "github":
                    self._base_origin = "github"
                    changed = True

            self._view = apply_ops(self._base, self._pending)
            if changed:
                self._save_remote()
                self._save_pending()
            self._save_sync()

    @staticmethod
    def _has_items(board):
        return any(board.get(c) for c in COLLECTIONS)

    def _base_as_adds(self, board):
        ops = []
        for coll in COLLECTIONS:
            for item in board.get(coll) or ():
                ts = canonical_timestamp(item.get("updated_at")) or now_iso()
                op = {"op": "add", "coll": coll, "item": copy.deepcopy(item), "ts": ts, "by": self.client_name}
                if validate_op(op) is None:
                    ops.append(op)
        return ops

    # ------------------------------------------------------------------ #
    # read side
    # ------------------------------------------------------------------ #
    @property
    def rev(self):
        with self._lock:
            return self._rev

    def view(self):
        """The visible board. Treat it as read-only (it is shared)."""
        with self._lock:
            return self._view

    def base(self):
        with self._lock:
            return copy.deepcopy(self._base)

    def pending(self):
        with self._lock:
            return copy.deepcopy(self._pending)

    def sync_status(self):
        with self._lock:
            n = len(self._pending)
            if not self.github_enabled:
                state = "off"
            elif self._state == "starting":
                state = "syncing"
            elif self._state == "ok":
                state = "pending" if n else "ok"
            else:
                state = self._state
            return {
                "enabled": self.github_enabled,
                "state": state,
                "pending": n,
                "last_sync": self._last_sync,
                "last_push": self._last_push,
                "last_error": self._last_error,
                "repo": self.repo,
                "branch": self.branch,
                "path": self.path,
            }

    def board_response(self, client_rev=None):
        """Body of GET /api/board."""
        with self._lock:
            if client_rev is not None and client_rev == self._rev:
                return {"rev": self._rev, "unchanged": True, "sync": self.sync_status()}
            return {"rev": self._rev, "board": self._view, "sync": self.sync_status()}

    # ------------------------------------------------------------------ #
    # write side (API)
    # ------------------------------------------------------------------ #
    def _set_view(self, view):
        if view != self._view:
            self._rev = max(self._rev + 1, _now_ms())
            self._view = view
            return True
        self._view = view
        return False

    def submit(self, ops):
        """Validate ALL ``ops`` first (all-or-nothing), then queue them (GitHub
        mode) or apply them straight into the board (local-only mode).

        Raises OpError(index, message) on the first invalid op; nothing is
        applied in that case. Returns the POST /api/ops body
        ``{"rev", "board", "sync"}``.
        """
        if not isinstance(ops, list):
            raise OpError(None, "ops must be a list")
        for i, op in enumerate(ops):
            err = validate_op(op)
            if err:
                raise OpError(i, err)
        cleaned = [clean_op(op) for op in ops]
        with self._lock:
            if cleaned:
                if self.github_enabled:
                    self._pending.extend(cleaned)
                    self._save_pending()
                    new_view = apply_ops(self._view, cleaned)
                else:
                    self._base = apply_ops(self._base, cleaned)
                    self._save_remote()
                    new_view = self._base
                if self._set_view(new_view):
                    self._save_sync()
            return {"rev": self._rev, "board": self._view, "sync": self.sync_status()}

    # ------------------------------------------------------------------ #
    # sync worker hooks
    # ------------------------------------------------------------------ #
    def fetch_params(self):
        with self._lock:
            return {"etag": self._etag, "sha": self._sha, "remote_exists": self._remote_exists}

    def on_remote_unchanged(self):
        """GET returned 304."""
        with self._lock:
            self._last_sync = now_iso()

    def on_remote_fetched(self, board, sha, etag):
        """GET returned 200 with a valid (already normalized) board."""
        with self._lock:
            base_changed = board != self._base
            meta_changed = sha != self._sha or etag != self._etag or not self._remote_exists
            self._base = board
            self._sha = sha
            self._etag = etag
            self._remote_exists = True
            self._last_sync = now_iso()
            if base_changed:
                self._save_remote()
                self._set_view(apply_ops(self._base, self._pending))
            if base_changed or meta_changed:
                self._save_sync()

    def on_remote_missing(self):
        """The file (or branch) doesn't exist on GitHub yet."""
        with self._lock:
            empty = empty_board()
            base_changed = self._base != empty
            self._base = empty
            self._sha = None
            self._etag = None
            self._remote_exists = False
            self._last_sync = now_iso()
            if base_changed:
                self._save_remote()
                self._set_view(apply_ops(self._base, self._pending))
            self._save_sync()

    def clear_etag(self):
        with self._lock:
            if self._etag is not None:
                self._etag = None
                self._save_sync()

    def snapshot_for_push(self):
        """(base, first k pending ops, k, sha, remote_exists) - all copies."""
        with self._lock:
            k = len(self._pending)
            return (
                copy.deepcopy(self._base),
                copy.deepcopy(self._pending[:k]),
                k,
                self._sha,
                self._remote_exists,
            )

    def drop_pending(self, k):
        """Forget the first ``k`` pending ops (they changed nothing remotely)."""
        with self._lock:
            if k <= 0:
                return
            self._pending = self._pending[k:]
            self._save_pending()
            if self._set_view(apply_ops(self._base, self._pending)):
                self._save_sync()

    def on_push_succeeded(self, doc, sha, k):
        """PUT succeeded: ``doc`` is the new base; drop exactly the first ``k``
        pending ops (more may have been queued during the request)."""
        with self._lock:
            now = now_iso()
            self._base = doc
            self._sha = sha
            self._etag = None
            self._remote_exists = True
            self._pending = self._pending[k:]
            self._last_push = now
            self._last_sync = now
            self._last_error = None
            self._state = "ok"
            self._save_remote()
            self._save_pending()
            self._set_view(apply_ops(self._base, self._pending))
            self._save_sync()

    def set_syncing(self):
        with self._lock:
            self._state = "syncing"

    def mark_ok(self):
        with self._lock:
            changed = self._state != "ok" or self._last_error is not None
            self._state = "ok"
            self._last_error = None
            if self._last_sync is None:
                self._last_sync = now_iso()
            if changed:
                self._save_sync()

    def set_offline(self, message):
        self._set_problem("offline", message)

    def set_error(self, message):
        self._set_problem("error", message)

    def _set_problem(self, state, message):
        with self._lock:
            changed = self._state != state or self._last_error != message
            self._state = state
            self._last_error = message
            if changed:
                self._save_sync()
