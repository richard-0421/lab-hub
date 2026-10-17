"""GitHub Contents API client (stdlib only) + the background sync thread.

The sync cycle is described in docs/ARCHITECTURE.md section 4:
fetch board.json (If-None-Match) -> rebase pending ops on it -> PUT with the
old sha -> on 409 refetch and retry.

A PUT can be committed by GitHub even though its answer never arrives
(timeout, dropped connection, 5xx, the service restarting mid-request). Every
PUT is therefore recorded first (Store.begin_push: the parent sha and the git
blob sha of the bytes sent). When the answer is lost the worker looks at
GitHub right away and again at the start of the next cycle: the remote blob is
ours -> the push landed; it is still the parent -> it did not; otherwise the
file's recent history tells. Only a push that did not land is sent again, so
an old push is never replayed over edits other people made since.

A missing board branch is created as an orphan (git/trees + git/commits with
no parents + git/refs): a root commit holding only the board file, never a
copy of the default branch, so the code on main never ends up in "data".

The token lives only in this module's
request headers; it is never logged, never put in an error message and never
returned to browsers.
"""
import base64
import hashlib
import http.client
import json
import logging
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from .board import (
    COLLECTIONS,
    MAX_ITEMS,
    apply_ops,
    canonical_timestamp,
    clean_text,
    empty_board,
    normalize_board,
    now_iso,
    parse_json_strict,
    same_json,
    serialize_board_bytes,
    summarize_ops,
)

log = logging.getLogger("labhub.sync")

API_VERSION = "2022-11-28"
REQUEST_TIMEOUT = 15
DEBOUNCE = 1.0          # seconds of quiet after a local edit before pushing
MAX_DEBOUNCE = 5.0      # ... but never wait longer than this after the first edit
MAX_BACKOFF = 300.0
MAX_CONFLICT_RETRIES = 3
MANUAL_SYNC_WAIT = 20.0
HISTORY_LOOKUP = 10     # commits checked when settling an unanswered push


class OfflineError(Exception):
    """Network error / timeout: GitHub could not be reached."""


class GitHubError(Exception):
    """GitHub answered with an error status."""

    def __init__(self, status, message, headers=None):
        Exception.__init__(self, "GitHub %s: %s" % (status, message))
        self.status = status
        self.message = message or ""
        self.headers = headers or {}


class SyncError(Exception):
    """A sync problem with a ready-to-show message."""


class FileResult(object):
    """``data`` holds the raw file bytes (status 200 only)."""

    __slots__ = ("status", "data", "sha", "etag")

    def __init__(self, status, data=None, sha=None, etag=None):
        self.status = status
        self.data = data
        self.sha = sha
        self.etag = etag


def _error_message(data, fallback):
    try:
        obj = json.loads(data.decode("utf-8", "replace"))
        msg = obj.get("message") if isinstance(obj, dict) else None
        if isinstance(msg, str) and msg.strip():
            return " ".join(msg.split())[:300]
    except Exception:  # noqa: BLE001
        pass
    return fallback


def git_blob_sha(data):
    """The sha GitHub reports (``content.sha``) for a file with these bytes."""
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def _decode_b64(content):
    # GitHub wraps base64 at 60 chars with "\n"; drop all whitespace first.
    return base64.b64decode("".join(content.split()), validate=False)


class _SameHostRedirect(urllib.request.HTTPRedirectHandler):
    """Follow redirects only on the same host (keeps the token on GitHub)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old = urllib.parse.urlsplit(req.full_url)
        new = urllib.parse.urlsplit(newurl)
        if (old.scheme, old.netloc) != (new.scheme, new.netloc):
            return None
        return urllib.request.HTTPRedirectHandler.redirect_request(self, req, fp, code, msg, headers, newurl)


class GitHubClient(object):
    def __init__(self, api_base, repo, token, timeout=REQUEST_TIMEOUT, user_agent="lab-hub"):
        self.api_base = (api_base or "https://api.github.com").rstrip("/")
        self.repo = repo
        self._token = token or ""
        self.timeout = timeout
        self.user_agent = user_agent
        self._opener = urllib.request.build_opener(_SameHostRedirect())

    def __repr__(self):  # never include the token
        return "GitHubClient(%r, %r)" % (self.api_base, self.repo)

    # ------------------------------------------------------------------ #
    def _url(self, path, query=None):
        url = self.api_base + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        return url

    def _repo_path(self, suffix=""):
        owner, name = self.repo.split("/", 1)
        return "/repos/%s/%s%s" % (urllib.parse.quote(owner, safe=""), urllib.parse.quote(name, safe=""), suffix)

    def request(self, method, path, query=None, body=None, headers=None):
        """Returns (status, headers_lowercase, body_bytes). Raises OfflineError
        when no HTTP response was received."""
        h = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": self.user_agent,
        }
        if self._token:
            h["Authorization"] = "Bearer " + self._token
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            h["Content-Type"] = "application/json"
        if headers:
            h.update(headers)
        req = urllib.request.Request(self._url(path, query), data=data, method=method, headers=h)
        try:
            with self._opener.open(req, timeout=self.timeout) as resp:
                return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
        except urllib.error.HTTPError as exc:
            try:
                payload = exc.read()
            except Exception:  # noqa: BLE001
                payload = b""
            finally:
                exc.close()
            hdrs = {k.lower(): v for k, v in (exc.headers.items() if exc.headers else [])}
            return exc.code, hdrs, payload
        except urllib.error.URLError as exc:
            raise OfflineError(str(getattr(exc, "reason", exc)))
        except (socket.timeout, TimeoutError):
            raise OfflineError("timed out")
        except (OSError, http.client.HTTPException) as exc:
            raise OfflineError(str(exc) or type(exc).__name__)

    def _raise(self, status, headers, data):
        raise GitHubError(status, _error_message(data, "HTTP %s" % status), headers)

    def _json(self, data):
        try:
            return json.loads(data.decode("utf-8"))
        except Exception:  # noqa: BLE001
            raise GitHubError(0, "GitHub sent a response that is not JSON")

    # ------------------------------------------------------------------ #
    def get_file(self, path, branch, etag=None):
        """FileResult with status 200 (data, sha, etag), 304 or 404.
        Other statuses raise GitHubError."""
        extra = {"If-None-Match": etag} if etag else None
        status, headers, data = self.request(
            "GET", self._repo_path("/contents/" + urllib.parse.quote(path, safe="/")), {"ref": branch}, headers=extra
        )
        if status == 304:
            return FileResult(304, etag=etag)
        if status == 404:
            return FileResult(404)
        if status != 200:
            self._raise(status, headers, data)
        info = self._json(data)
        if not isinstance(info, dict) or info.get("type", "file") != "file":
            raise GitHubError(status, "%s on GitHub is not a file" % path)
        sha = info.get("sha")
        content = info.get("content")
        if info.get("encoding") == "base64" and isinstance(content, str) and (content.strip() or not info.get("size")):
            raw = _decode_b64(content)
        elif isinstance(sha, str):
            raw = self.get_blob(sha)  # files > 1 MB come without inline content
        else:
            raise GitHubError(status, "GitHub returned %s without content" % path)
        return FileResult(200, raw, sha, headers.get("etag"))

    def get_blob(self, sha):
        status, headers, data = self.request("GET", self._repo_path("/git/blobs/" + urllib.parse.quote(sha, safe="")))
        if status != 200:
            self._raise(status, headers, data)
        info = self._json(data)
        return _decode_b64(info.get("content") or "")

    def put_file(self, path, branch, content_bytes, message, sha=None):
        body = {
            "message": message,
            "content": base64.b64encode(content_bytes).decode("ascii"),
            "branch": branch,
        }
        if sha:
            body["sha"] = sha
        status, headers, data = self.request(
            "PUT", self._repo_path("/contents/" + urllib.parse.quote(path, safe="/")), body=body
        )
        if status not in (200, 201):
            self._raise(status, headers, data)
        return self._json(data)

    def list_commits(self, branch, path, per_page=HISTORY_LOOKUP):
        """Shas of the newest commits on ``branch`` that touched ``path``."""
        status, headers, data = self.request(
            "GET", self._repo_path("/commits"), {"sha": branch, "path": path, "per_page": per_page}
        )
        if status != 200:
            self._raise(status, headers, data)
        info = self._json(data)
        if not isinstance(info, list):
            raise GitHubError(status, "unexpected commit list response")
        return [c["sha"] for c in info if isinstance(c, dict) and isinstance(c.get("sha"), str)]

    def get_repo(self):
        status, headers, data = self.request("GET", self._repo_path())
        if status != 200:
            self._raise(status, headers, data)
        return self._json(data)

    def create_ref(self, branch, sha):
        status, headers, data = self.request(
            "POST", self._repo_path("/git/refs"), body={"ref": "refs/heads/" + branch, "sha": sha}
        )
        if status not in (200, 201):
            self._raise(status, headers, data)
        return self._json(data)

    def _created_sha(self, what, path, body):
        """POST a git object and return its sha (GitHub answers 201)."""
        status, headers, data = self.request("POST", self._repo_path(path), body=body)
        if status not in (200, 201):
            self._raise(status, headers, data)
        info = self._json(data)
        sha = info.get("sha") if isinstance(info, dict) else None
        if not isinstance(sha, str) or not sha:
            raise GitHubError(status, "unexpected %s response" % what)
        return sha

    def create_tree(self, files):
        """A tree holding exactly ``files`` ({path: bytes}, valid UTF-8): no
        ``base_tree``, so nothing else is in it. Returns the tree sha."""
        entries = [
            {"path": path, "mode": "100644", "type": "blob", "content": data.decode("utf-8")}
            for path, data in sorted(files.items())
        ]
        return self._created_sha("tree", "/git/trees", {"tree": entries})

    def create_commit(self, message, tree, parents=()):
        """A commit of ``tree``; ``parents=()`` makes a root (orphan) commit.
        Returns the commit sha."""
        return self._created_sha(
            "commit", "/git/commits", {"message": message, "tree": tree, "parents": list(parents)}
        )


# --------------------------------------------------------------------------- #
# error wording
# --------------------------------------------------------------------------- #
def describe_error(exc):
    """Human-readable text for a GitHubError (never contains the token)."""
    status, msg = exc.status, exc.message
    if status == 401:
        return "GitHub token rejected (expired or revoked?)"
    if status in (403, 429):
        remaining = str(exc.headers.get("x-ratelimit-remaining", ""))
        if status == 429 or remaining == "0" or "rate limit" in msg.lower():
            reset = exc.headers.get("x-ratelimit-reset")
            when = ""
            try:
                when = " (resets %s)" % time.strftime("%H:%M", time.localtime(int(reset)))
            except (TypeError, ValueError):
                pass
            return "GitHub rate limit reached%s: %s" % (when, msg)
        return "GitHub refused access - check the token has Contents: read & write on this repo: %s" % msg
    if status == 404:
        return "repo not found, or the token can't see it"
    if status == 0:
        return msg
    return "GitHub error %s: %s" % (status, msg)


def _is_branch_missing(exc):
    m = exc.message.lower()
    return exc.status in (404, 422) and "branch" in m and "not found" in m


def _is_sha_conflict(exc):
    if exc.status == 409:
        return True
    return exc.status == 422 and "sha" in exc.message.lower()


def _is_unanswered(exc):
    """A failed PUT that GitHub may have committed anyway: 5xx (the front end
    gave up, the commit may not have) or a 2xx we could not read (status 0)."""
    return exc.status == 0 or exc.status >= 500


# --------------------------------------------------------------------------- #
# the worker
# --------------------------------------------------------------------------- #
class SyncWorker(object):
    def __init__(self, store, cfg, client=None):
        self.store = store
        self.branch = cfg.get("github_branch") or "data"
        self.path = cfg.get("github_path") or "board.json"
        self.client_name = cfg.get("client_name") or "lab-pi"
        self.interval = float(cfg.get("sync_interval") or 15)
        self.client = client or GitHubClient(cfg.get("github_api"), cfg.get("github_repo"), cfg.get("github_token"))
        self._cycle_lock = threading.Lock()
        self._cond = threading.Condition()
        self._next_at = 0.0
        self._kick_at = None
        self._first_kick = None
        self._failures = 0
        self._stopping = False
        self._thread = None

    # ---- thread control ------------------------------------------------ #
    def start(self):
        if self._thread is not None:
            return
        self._stopping = False
        self._thread = threading.Thread(target=self._run, name="labhub-sync", daemon=True)
        self._thread.start()

    def stop(self, timeout=3.0):
        with self._cond:
            self._stopping = True
            self._cond.notify_all()
        t = self._thread
        if t is not None:
            t.join(timeout)
        self._thread = None

    def kick(self, delay=DEBOUNCE):
        """Ask for a sync soon (debounced). Overrides any backoff."""
        with self._cond:
            now = time.monotonic()
            if self._first_kick is None:
                self._first_kick = now
            self._kick_at = min(now + delay, self._first_kick + MAX_DEBOUNCE)
            self._cond.notify_all()

    def _run(self):
        while True:
            with self._cond:
                while not self._stopping:
                    now = time.monotonic()
                    due = self._next_at
                    if self._kick_at is not None:
                        due = min(due, self._kick_at)
                    if now >= due:
                        break
                    self._cond.wait(min(due - now, 60.0))
                if self._stopping:
                    return
                self._kick_at = None
                self._first_kick = None
            try:
                self.sync_once()
            except Exception:  # noqa: BLE001 - the thread must never die
                log.exception("sync cycle crashed")
                self._schedule(False)

    def _schedule(self, ok):
        with self._cond:
            if ok:
                self._failures = 0
                delay = self.interval
            else:
                self._failures += 1
                delay = min(MAX_BACKOFF, self.interval * (2 ** min(self._failures - 1, 16)))
            self._next_at = time.monotonic() + delay

    # ---- one cycle ------------------------------------------------------ #
    def sync_once(self, wait=None):
        """Run one sync cycle now and return the store's sync object.
        ``wait`` (seconds) bounds how long to wait for a cycle that is already
        running in the background thread; None waits indefinitely."""
        acquired = self._cycle_lock.acquire() if wait is None else self._cycle_lock.acquire(timeout=wait)
        if not acquired:
            return self.store.sync_status()
        try:
            outcome = self._cycle_guarded()
        finally:
            self._cycle_lock.release()
        self._schedule(outcome == "ok")
        return self.store.sync_status()

    def sync_now(self):
        """Manual sync (POST /api/sync)."""
        return self.sync_once(wait=MANUAL_SYNC_WAIT)

    def _cycle_guarded(self):
        store = self.store
        try:
            return self._cycle()
        except OfflineError as exc:
            log.info("GitHub unreachable: %s", exc)
            store.set_offline("Can't reach GitHub (%s)" % exc)
            return "offline"
        except GitHubError as exc:
            msg = describe_error(exc)
            log.warning("sync failed: %s", msg)
            store.set_error(msg)
            return "error"
        except SyncError as exc:
            log.warning("sync failed: %s", exc)
            store.set_error(str(exc))
            return "error"
        except Exception as exc:  # noqa: BLE001
            log.exception("unexpected sync failure")
            store.set_error("sync failed unexpectedly (%s)" % type(exc).__name__)
            return "error"

    def _fetch(self):
        """Step 1. Returns True when the normalized remote differs from its
        raw parse (a hand edit that needs to be written back cleaned)."""
        store, client = self.store, self.client
        params = store.fetch_params()
        res = client.get_file(self.path, self.branch, params["etag"])
        if res.status == 304:
            store.on_remote_unchanged()
            return False
        if res.status == 200:
            try:
                text = res.data.decode("utf-8-sig")
                raw = parse_json_strict(text)
            except (UnicodeDecodeError, ValueError) as exc:
                store.clear_etag()
                raise SyncError("%s on GitHub is not valid JSON: %s" % (self.path, exc))
            board = normalize_board(raw)
            needs_fix = not same_json(board, raw)
            over = [c for c in COLLECTIONS if isinstance(raw, dict) and isinstance(raw.get(c), list)
                    and len(raw[c]) > MAX_ITEMS]
            if over:
                log.warning("%s on GitHub has more than %d items in %s; only the first %d (by rank) are kept",
                            self.path, MAX_ITEMS, ", ".join(over), MAX_ITEMS)
            # Without the etag the next cycle re-downloads, so a failed fix
            # push is retried.
            store.on_remote_fetched(board, res.sha, None if needs_fix else res.etag)
            return needs_fix
        # 404: the file or branch is missing - or the whole repo is invisible
        try:
            client.get_repo()
        except GitHubError as exc:
            if exc.status == 404:
                raise SyncError("repo not found, or the token can't see it")
            raise
        store.on_remote_missing()
        return False

    def _create_branch(self):
        """Create the missing board branch as an ORPHAN: one root commit
        whose tree holds only the board file (an empty board). The branch
        shares no history with the code on main, so the Pi never copies the
        code into it, and the board's commits stay out of the code history.
        The caller then runs the normal cycle on it (fetch, replay, PUT)."""
        client = self.client
        doc = empty_board()
        doc["updated_at"] = now_iso()
        doc["updated_by"] = clean_text(self.client_name, 60)
        message = "%s: create %s\n\nNew orphan branch '%s' holding only %s (no code history)." % (
            self.client_name, self.path, self.branch, self.path)
        try:
            tree = client.create_tree({self.path: serialize_board_bytes(doc)})
            commit = client.create_commit(message, tree, parents=())
            client.create_ref(self.branch, commit)
            log.info("created orphan branch %s holding only %s", self.branch, self.path)
        except GitHubError as exc:
            if exc.status == 422 and "already exists" in exc.message.lower():
                return  # someone else created it meanwhile: sync with theirs
            if exc.status == 409:
                # the Git database API answers 409 "Git Repository is empty."
                raise SyncError(
                    "the GitHub repo has no commits yet - push the Lab Hub code to it first, "
                    "then the '%s' branch is created on the next sync" % self.branch
                )
            raise

    def _cycle(self):
        store = self.store
        conflicts = 0
        branch_created = False
        while True:
            needs_fix = self._fetch()
            self._settle_inflight()
            dropped = store.drop_reimported_legacy_adds()
            if dropped:
                log.warning("GitHub already has items from a legacy import; not importing %d legacy item(s) "
                            "again (that would bring back the ones deleted since)", dropped)
            base, ops, k, sha, remote_exists = store.snapshot_for_push()
            if not ops and remote_exists and not needs_fix:
                store.mark_ok()
                return "ok"
            doc = apply_ops(base, ops)
            if remote_exists and not needs_fix and doc == base:
                # every queued op was a no-op against the remote (e.g. edits
                # to an item someone deleted) - nothing to commit
                store.drop_pending(k)
                store.mark_ok()
                return "ok"
            last_ts = canonical_timestamp(ops[-1].get("ts")) if ops else None
            doc["updated_at"] = last_ts or now_iso()
            doc["updated_by"] = clean_text(self.client_name, 60)
            message = self._commit_message(ops, base, remote_exists, needs_fix)
            body = serialize_board_bytes(doc)
            parent = sha if remote_exists else None
            store.begin_push(k, parent, git_blob_sha(body))
            store.set_syncing()
            try:
                result = self.client.put_file(self.path, self.branch, body, message, parent)
            except OfflineError:
                if self._landed_after_all():
                    return "ok"
                raise
            except GitHubError as exc:
                if _is_unanswered(exc):
                    if self._landed_after_all():
                        return "ok"
                    raise
                store.clear_inflight()  # a definite "no": nothing was written
                if _is_branch_missing(exc) and not branch_created:
                    self._create_branch()
                    branch_created = True
                    continue  # the file exists now: fetch it, replay, PUT with its sha
                if _is_branch_missing(exc):
                    raise SyncError("the new '%s' branch is not visible on GitHub yet; will retry shortly"
                                    % self.branch)
                if _is_sha_conflict(exc) and conflicts < MAX_CONFLICT_RETRIES - 1:
                    conflicts += 1
                    log.info("board.json changed on GitHub during the push; rebasing (retry %d)", conflicts)
                    store.clear_etag()
                    continue
                if _is_sha_conflict(exc):
                    raise SyncError("board.json kept changing on GitHub; will retry shortly")
                raise
            content = result.get("content") if isinstance(result, dict) else None
            new_sha = content.get("sha") if isinstance(content, dict) else None
            store.on_push_succeeded(doc, new_sha, k)
            log.info("pushed %d op(s) to %s:%s", k, self.branch, self.path)
            return "ok"

    # ---- pushes whose answer was lost ------------------------------------ #
    def _settle_inflight(self):
        """Right after a fetch: decide whether the recorded PUT (if any)
        reached GitHub. Returns True when it did; its ops are then dropped
        instead of being sent again."""
        store = self.store
        rec = store.inflight()
        if rec is None:
            return False
        params = store.fetch_params()
        remote = params["sha"] if params["remote_exists"] else None
        if remote is not None and remote == rec["expected"]:
            landed = True
        elif remote == rec["parent"]:
            landed = False
        else:
            landed = self._push_in_history(rec)
        if not landed:
            store.clear_inflight()
            return False
        if store.on_push_landed():
            log.info("a push whose answer was lost did reach GitHub; its %d op(s) are not sent again", rec["k"])
        return True

    def _push_in_history(self, rec):
        """Walk the newest commits that touched the file: our blob before the
        parent's -> the push landed. OfflineError propagates (keep the record
        and look again next cycle)."""
        try:
            for commit in self.client.list_commits(self.branch, self.path, HISTORY_LOOKUP):
                res = self.client.get_file(self.path, commit)
                if res.status != 200:
                    continue
                if res.sha == rec["expected"]:
                    return True
                if res.sha == rec["parent"]:
                    return False
        except GitHubError as exc:
            log.warning("could not read the history of %s (%s)", self.path, describe_error(exc))
        log.warning("could not tell whether an unanswered push reached GitHub; sending its ops again")
        return False

    def _landed_after_all(self):
        """The PUT failed without a definite answer: look at GitHub now."""
        try:
            self.store.clear_etag()
            self._fetch()
            return self._settle_inflight()
        except Exception:  # noqa: BLE001 - still unknown; the next cycle looks again
            return False

    def _commit_message(self, ops, base, remote_exists, needs_fix):
        if ops:
            subject, body = summarize_ops(ops, base, client=self.client_name)
        elif not remote_exists:
            subject, body = "%s: create %s" % (self.client_name, self.path), ""
        else:
            subject, body = "%s: clean up %s (normalize hand edit)" % (self.client_name, self.path), ""
        subject = subject[:72]
        return subject + ("\n\n" + body if body else "")
