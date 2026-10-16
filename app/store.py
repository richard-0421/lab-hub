"""Persisted local state of the Pi: the last remote board, the pending op
queue and sync metadata. See docs/ARCHITECTURE.md sections 1 and 4.

Files in ``state_dir`` (all written atomically: temp file + os.replace):

    remote.json   ``base``: the last board seen on GitHub (normalized). In
                  local-only mode this *is* the board.
    pending.json  list of ops not yet on GitHub (always [] in local-only mode)
    sync.json     {sha, etag, remote_exists, last_sync, last_push, last_error,
                   state, rev, target, base_origin, inflight}
    snapshot.json {target, board}: only while GitHub sync is switched off
                  after having been on. It is the last board seen on GitHub,
                  so switching sync back on replays exactly what changed
                  locally (add / update / delete) instead of re-adding
                  everything on top of a stale board.

The visible board is ``view = apply_ops(base, pending)``. ``rev`` bumps
whenever the view changes; it starts from a time-based value and is persisted,
so a restarted server never hands out a rev a browser already holds.

When several files change together they are written queue first, board
second, sync.json last: a crash in between then leaves duplicate ops (harmless:
``add``/``delete`` are idempotent and ``update`` sets absolute values) or a
board that is downloaded again, never lost ops. sync.json never records an
etag for a board that could not be saved, so a restart re-downloads it
instead of trusting a 304.

Thread-safe (one RLock). No method does network I/O.
"""
import copy
import hashlib
import json
import logging
import os
import shutil
import threading
import time

from .board import (
    COLLECTIONS,
    EDITABLE,
    MAX_BY_LEN,
    MAX_ITEMS,
    apply_ops,
    canonical_timestamp,
    clean_text,
    coerce_field,
    empty_board,
    normalize_board,
    normalize_item,
    now_iso,
    serialize_board_bytes,
    validate_op,
)
from .migrate import BY as LEGACY_BY
from .migrate import LEGACY_ID_RE

log = logging.getLogger("labhub.store")

REMOTE_FILE = "remote.json"
PENDING_FILE = "pending.json"
SYNC_FILE = "sync.json"
SNAPSHOT_FILE = "snapshot.json"

# Ops waiting for GitHub. Past this, POST /api/ops answers 503 until the queue
# drains (it only grows while GitHub is unreachable or refusing writes).
MAX_PENDING = 5000

SAVE_FAILED = "the Pi could not save the change (is its disk full?)"


class OpError(ValueError):
    """An op failed validation. ``index`` is its position in the submitted
    list (None when the request itself was malformed)."""

    def __init__(self, index, message):
        ValueError.__init__(self, message)
        self.index = index
        self.message = message


class StoreUnavailable(Exception):
    """The ops are fine but can't be accepted right now (state could not be
    saved, or too many are already queued). The API answers 503, so the
    client keeps them and retries."""

    def __init__(self, message):
        Exception.__init__(self, message)
        self.message = message


def _now_ms():
    return int(time.time() * 1000)


def clean_op(op):
    """Compact copy of a *validated* op: only the keys its kind uses, the
    ``add`` item normalized (unknown keys dropped, strings clamped, defaults
    filled in), ``update`` values coerced, ``ts`` canonical and ``by``
    clamped. Applying it gives the same board as applying ``op``, and its size
    is bounded by the field limits whatever the client sent."""
    kind, coll = op["op"], op["coll"]
    ts = canonical_timestamp(op["ts"])
    out = {"op": kind, "coll": coll}
    if kind == "add":
        out["item"] = normalize_item(coll, op["item"], 0, default_ts=ts)
    else:
        out["id"] = op["id"]
        if kind == "update":
            out["set"] = {key: coerce_field(coll, key, value) for key, value in op["set"].items()}
    out["ts"] = ts
    if isinstance(op.get("by"), str):
        out["by"] = clean_text(op["by"], MAX_BY_LEN)
    return out


def diff_ops(old, new, by):
    """Ops that turn board ``old`` into board ``new`` (both normalized):
    ``add`` for new items, ``update`` with only the editable fields that
    differ, ``delete`` for items that are gone."""
    ops = []
    now = now_iso()
    for coll in COLLECTIONS:
        old_items = {it["id"]: it for it in old.get(coll) or ()}
        seen = set()
        for it in new.get(coll) or ():
            seen.add(it["id"])
            ts = canonical_timestamp(it.get("updated_at")) or now
            prev = old_items.get(it["id"])
            if prev is None:
                op = {"op": "add", "coll": coll, "item": copy.deepcopy(it), "ts": ts, "by": by}
            else:
                changes = {k: copy.deepcopy(it.get(k)) for k in EDITABLE[coll] if it.get(k) != prev.get(k)}
                if not changes:
                    continue
                op = {"op": "update", "coll": coll, "id": it["id"], "set": changes, "ts": ts, "by": by}
            if validate_op(op) is None:
                ops.append(op)
        for item_id in old_items:
            if item_id not in seen:
                ops.append({"op": "delete", "coll": coll, "id": item_id, "ts": now, "by": by})
    return ops


def ops_fingerprint(ops):
    text = json.dumps(ops, sort_keys=True, ensure_ascii=True, separators=(",", ":"))
    return hashlib.sha1(text.encode("ascii")).hexdigest()


def _is_legacy_add(op):
    return (
        op.get("op") == "add"
        and op.get("by") == LEGACY_BY
        and LEGACY_ID_RE.match(op["item"]["id"]) is not None
    )


def _valid_inflight(rec):
    if not isinstance(rec, dict):
        return None
    k, parent, expected, fp = rec.get("k"), rec.get("parent"), rec.get("expected"), rec.get("ops")
    if (
        isinstance(k, int) and not isinstance(k, bool) and k > 0
        and (parent is None or isinstance(parent, str))
        and isinstance(expected, str) and isinstance(fp, str)
    ):
        at = rec.get("at") if isinstance(rec.get("at"), str) else None
        return {"k": k, "parent": parent, "expected": expected, "ops": fp, "at": at}
    return None


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
        self._inflight = None  # the PUT whose answer we haven't seen (see begin_push)
        # memory holds queued ops that pending.json doesn't: don't write
        # remote.json / sync.json until it does (they would lose those ops)
        self._queue_unsaved = False
        # remote.json on disk is older than self._base: never pair it with an etag
        self._remote_file_stale = False
        # local-only: pending.json still holds ops already folded into the board
        self._folded_queue_on_disk = False
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
        """True when ``data`` is safely on disk."""
        try:
            os.makedirs(self.state_dir, exist_ok=True)
            atomic_write(self._file(name), data)
            return True
        except OSError as exc:
            log.error("could not write state/%s: %s", name, exc)
            return False

    def _remove(self, name):
        try:
            os.remove(self._file(name))
        except FileNotFoundError:
            pass
        except OSError as exc:
            log.error("could not remove state/%s: %s", name, exc)
            return False
        return True

    def _queue_saved(self):
        """remote.json and sync.json may be written (pending.json is not
        behind memory, or has just caught up)."""
        return not self._queue_unsaved or self._save_pending()

    def _save_remote(self):
        if self._queue_saved() and self._write(REMOTE_FILE, serialize_board_bytes(self._base)):
            self._remote_file_stale = False
            if self._folded_queue_on_disk and (self._save_pending() or self._remove(PENDING_FILE)):
                # local-only: the saved board includes those ops now; folding
                # them again at the next start could undo later edits
                self._folded_queue_on_disk = False
            return True
        self._remote_file_stale = True
        return False

    def _save_pending(self):
        data = json.dumps(self._pending, ensure_ascii=True, separators=(",", ":")).encode("ascii")
        if self._write(PENDING_FILE, data):
            self._queue_unsaved = False
            return True
        return False

    def _save_sync(self):
        if not self._queue_saved():
            return False
        meta = {
            "sha": self._sha,
            "etag": None if self._remote_file_stale else self._etag,
            "remote_exists": self._remote_exists,
            "last_sync": self._last_sync,
            "last_push": self._last_push,
            "last_error": self._last_error,
            "state": self._state,
            "rev": self._rev,
            "target": self._target,
            "base_origin": self._base_origin,
            "inflight": self._inflight,
        }
        return self._write(SYNC_FILE, json.dumps(meta, ensure_ascii=True, indent=1).encode("ascii"))

    def load(self):
        """(Re)load everything from ``state_dir``; tolerant of missing or
        corrupt files."""
        with self._lock:
            self._queue_unsaved = False
            self._remote_file_stale = False
            self._folded_queue_on_disk = False

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
                self._inflight = _valid_inflight(meta.get("inflight"))
            else:
                # different repo/branch/path (or first run): the sha/etag are
                # meaningless; the next fetch replaces ``base``.
                self._sha = None
                self._etag = None
                self._remote_exists = False
                self._inflight = None
                if meta.get("target") is not None:
                    self._last_sync = None
                    self._last_push = None
                    self._last_error = None
                    self._state = "starting"
            if raw_base is None:
                # the cached board is missing or unreadable: a 304 for it would
                # leave this empty board in place, so download it again
                self._etag = None

            if self.github_enabled:
                drop_snapshot = self._load_github_mode()
            else:
                self._load_local_mode(meta.get("target"))
                drop_snapshot = False

            self._view = apply_ops(self._base, self._pending)
            if self._save_sync() and drop_snapshot:
                self._remove(SNAPSHOT_FILE)

    def _load_local_mode(self, stored_target):
        had_push = self._inflight is not None
        self._inflight = None  # nothing is pushed from here
        if self._base_origin == "github":
            # GitHub sync was on and is off now. Keep the last GitHub board:
            # folding the queue into it is fine for local use, but turning sync
            # back on must replay what changed here, not re-add everything.
            snap = {"target": stored_target, "board": self._base}
            data = json.dumps(snap, ensure_ascii=True, separators=(",", ":")).encode("ascii")
            if not self._write(SNAPSHOT_FILE, data):
                self._remove(SNAPSHOT_FILE)  # never leave an older one behind
                log.warning("could not keep the last GitHub board; edits made while sync is off "
                            "will be uploaded as new items only")
            if had_push:
                log.warning("GitHub sync is off while a push was unconfirmed; its changes may be sent "
                            "again when sync is back on")
            self._base_origin = "local"
            # recorded before the board changes: after a crash the next start
            # folds the (still queued) ops again instead of snapshotting them
            self._save_sync()
        elif self._base_origin != "local":
            self._base_origin = "local"
        if self._pending:
            # local-only: fold anything queued into the board itself
            self._base = apply_ops(self._base, self._pending)
            self._pending = []
            self._folded_queue_on_disk = True
            self._save_remote()

    def _load_github_mode(self):
        """Returns True when snapshot.json is no longer needed."""
        if self._base_origin != "local":
            self._base_origin = "github"
            return os.path.exists(self._file(SNAPSHOT_FILE))
        # The board was used without GitHub sync; GitHub becomes the truth now.
        snap = self._read_snapshot()
        if snap is not None and snap[0] == self._target:
            # It came from this very repo/branch/path: replay only what changed
            # here, on top of whatever GitHub has now. Items edited or deleted
            # on GitHub meanwhile are left alone.
            ops = diff_ops(snap[1], self._base, self.client_name)
            new_base = snap[1]
            if ops:
                log.info("GitHub sync is on again: queueing %d change(s) made while it was off", len(ops))
        elif self._has_items(self._base):
            # Re-queue every item as an ``add`` (a no-op for ids GitHub
            # already has) so nothing is lost when the remote becomes the truth.
            ops = self._base_as_adds(self._base)
            new_base = empty_board()
            if snap is not None:
                log.warning("GitHub sync now points at %s (%s:%s), not where this board was last synced; "
                            "uploading its %d items as new ones - edits and deletes made while sync was off "
                            "are not replayed there", self.repo, self.branch, self.path, len(ops))
            else:
                log.info("GitHub sync enabled: queueing %d local items for upload", len(ops))
        else:
            ops, new_base = [], self._base
        self._pending = ops + self._pending
        self._base = new_base
        self._sha = None
        self._etag = None
        self._remote_exists = False
        self._inflight = None
        self._base_origin = "github"
        # Queue first. Until it is on disk, remote.json and sync.json keep the
        # old local board (see _queue_saved), so the next start re-queues it.
        self._queue_unsaved = True
        if not self._save_pending():
            log.error("could not save the upload queue; the local board stays on disk until it can be")
        self._save_remote()
        return True

    def _read_snapshot(self):
        raw = self._read_json(SNAPSHOT_FILE)
        if raw is None:
            return None
        if not isinstance(raw, dict) or not isinstance(raw.get("board"), dict):
            self._quarantine(SNAPSHOT_FILE, "not a board snapshot")
            return None
        return raw.get("target"), normalize_board(raw["board"])

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

    def _check_room(self, ops):
        """OpError for the first ``add`` that would go past MAX_ITEMS in its
        collection (such an add would be a no-op; say so instead)."""
        ids = {c: {it["id"] for it in self._view.get(c) or ()} for c in COLLECTIONS}
        for i, op in enumerate(ops):
            have = ids[op["coll"]]
            if op["op"] == "add":
                item_id = op["item"]["id"]
                if item_id in have:
                    continue
                if len(have) >= MAX_ITEMS:
                    raise OpError(i, "board full: %s already has %d items - delete some first "
                                     "(e.g. clear done tasks)" % (op["coll"], MAX_ITEMS))
                have.add(item_id)
            elif op["op"] == "delete":
                have.discard(op["id"])

    def submit(self, ops):
        """Validate ALL ``ops`` first (all-or-nothing), then queue them (GitHub
        mode) or apply them straight into the board (local-only mode).

        Raises OpError(index, message) on the first invalid op, and
        StoreUnavailable when the change can't be saved or the queue is full;
        nothing is applied in either case. Returns the POST /api/ops body
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
                self._check_room(cleaned)
                if self.github_enabled:
                    if len(self._pending) + len(cleaned) > MAX_PENDING:
                        raise StoreUnavailable(
                            "%d changes are already waiting to reach GitHub; try again once the Pi has synced"
                            % len(self._pending))
                    self._pending.extend(cleaned)
                    if not self._save_pending():
                        del self._pending[-len(cleaned):]
                        raise StoreUnavailable(SAVE_FAILED)
                    new_view = apply_ops(self._view, cleaned)
                else:
                    old_base = self._base
                    self._base = apply_ops(self._base, cleaned)
                    if not self._save_remote():
                        self._base = old_base
                        raise StoreUnavailable(SAVE_FAILED)
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
            retry = self._remote_file_stale
            self._base = board
            self._sha = sha
            self._etag = etag
            self._remote_exists = True
            self._last_sync = now_iso()
            if base_changed or retry:
                # a failed write keeps the etag out of sync.json (see _save_sync)
                self._save_remote()
            if base_changed:
                self._set_view(apply_ops(self._base, self._pending))
            if base_changed or meta_changed or retry:
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

    def drop_reimported_legacy_adds(self):
        """Drop queued legacy-import ``add`` ops when GitHub already holds
        legacy items: the import ran before (from another state/ folder), and
        re-adding the rows people have deleted since would bring them back.
        Returns the number of ops dropped."""
        with self._lock:
            if self._inflight is not None or not any(_is_legacy_add(op) for op in self._pending):
                return 0
            if not any(LEGACY_ID_RE.match(it["id"]) for c in COLLECTIONS for it in self._base.get(c) or ()):
                return 0
            keep = [op for op in self._pending if not _is_legacy_add(op)]
            dropped = len(self._pending) - len(keep)
            self._pending = keep
            self._save_pending()
            if self._set_view(apply_ops(self._base, self._pending)):
                self._save_sync()
            return dropped

    def begin_push(self, k, parent_sha, expected_sha):
        """Record (on disk, before sending) the PUT of the first ``k`` ops:
        ``parent_sha`` is the remote it replaces, ``expected_sha`` the blob sha
        of the bytes sent. If its answer is lost (timeout, reset, 5xx, a
        restart) the next fetch can tell whether it landed instead of
        replaying it over newer edits."""
        with self._lock:
            if k <= 0:
                if self._inflight is not None:
                    self._inflight = None
                    self._save_sync()
                return
            self._inflight = {
                "k": k,
                "parent": parent_sha,
                "expected": expected_sha,
                "ops": ops_fingerprint(self._pending[:k]),
                "at": now_iso(),
            }
            self._save_sync()

    def inflight(self):
        with self._lock:
            return dict(self._inflight) if self._inflight else None

    def clear_inflight(self):
        """The recorded PUT definitely did not land."""
        with self._lock:
            if self._inflight is not None:
                self._inflight = None
                self._save_sync()

    def on_push_landed(self):
        """GitHub has the recorded PUT although its answer never arrived.
        Drops its ops if they still head the queue (they may not after a crash
        between files). Returns True when they were dropped."""
        with self._lock:
            rec, self._inflight = self._inflight, None
            if rec is None:
                return False
            k = rec["k"]
            if len(self._pending) < k or ops_fingerprint(self._pending[:k]) != rec["ops"]:
                self._save_sync()
                return False
            now = now_iso()
            self._pending = self._pending[k:]
            self._last_push = now
            self._last_sync = now
            self._last_error = None
            self._state = "ok"
            if not self._save_pending():
                self._inflight = rec  # still on disk: the next start drops them
            self._set_view(apply_ops(self._base, self._pending))
            self._save_sync()
            return True

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
            # queue before board: a crash in between costs a download of the
            # board, never a replay of ops GitHub already has
            if self._save_pending():
                self._inflight = None
            self._save_remote()
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
