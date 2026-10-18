"""A stdlib mock of the GitHub REST subset Lab Hub uses.

Good enough for the Python tests and for a browser (manual end-to-end runs of
the GitHub Pages frontend against it):

    GET  /repos/{o}/{r}                         default_branch, private, permissions
    GET  /repos/{o}/{r}/contents/{path}?ref=b   base64 (wrapped at 60 chars), ETag, 304;
                                                ref may also be a commit sha
    PUT  /repos/{o}/{r}/contents/{path}         sha checks: 422 missing sha, 409 wrong sha,
                                                404 unknown branch
    GET  /repos/{o}/{r}/git/ref/heads/{b}
    POST /repos/{o}/{r}/git/refs                {ref, sha}; 422 "Reference already exists"
    GET  /repos/{o}/{r}/git/blobs/{sha}
    POST /repos/{o}/{r}/git/blobs               {content, encoding: utf-8|base64}
    POST /repos/{o}/{r}/git/trees               {tree: [{path, mode, type, content|sha}], base_tree?}
    POST /repos/{o}/{r}/git/commits             {message, tree, parents: []} ([] = root commit)
    GET  /repos/{o}/{r}/commits?sha=b&path=p&per_page=n   newest first (walks the parents)
    GET  /user

Blob and tree shas are real git object ids; commit shas are made up. An
``empty=True`` repo has no commits at all: contents answer 404 "This
repository is empty." and the git database API 409 "Git Repository is
empty." (like GitHub).

Auth: "Authorization: Bearer <token>" or "token <token>"; a wrong token -> 401;
no token on a private repo -> 404 (like GitHub). CORS headers on every
response; OPTIONS preflight answered.

Python test hooks (methods on MockGitHub): fail_next(), on_next(),
drop_response_next() (handle a request, then hang up without answering),
set_file_text(), get_file_text(), set_offline(), requests (log), commits(),
commit(sha), head(branch).

HTTP control endpoints (handy from curl during manual tests; no auth):
    GET  /_mock/state                       branches, files, commit counts
    GET  /_mock/file?branch=data&path=board.json
    POST /_mock/file?branch=data&path=board.json      (body = new file text)
    POST /_mock/offline?on=1|0
    POST /_mock/fail?status=500&message=boom[&method=PUT&path=contents]
    GET  /_mock/log

Run:
    python tests/mock_github.py --port 9010 --repo richard-0421/lab-hub \\
        --token test-token [--private] [--no-data-branch | --empty] [--seed board.json]
"""
import argparse
import base64
import hashlib
import io
import json
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

CORS_ALLOW_HEADERS = (
    "Authorization, Content-Type, If-Match, If-Modified-Since, If-None-Match, "
    "If-Unmodified-Since, Accept, Accept-Encoding, X-GitHub-OTP, X-Requested-With, "
    "User-Agent, X-GitHub-Api-Version"
)
CORS_EXPOSE_HEADERS = (
    "ETag, Link, Location, Retry-After, X-GitHub-OTP, X-RateLimit-Limit, "
    "X-RateLimit-Remaining, X-RateLimit-Used, X-RateLimit-Resource, X-RateLimit-Reset, "
    "X-OAuth-Scopes, X-Accepted-OAuth-Scopes, X-Poll-Interval, X-GitHub-Media-Type, "
    "X-GitHub-Request-Id, Deprecation, Sunset"
)


def blob_sha(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def wrap_b64(data):
    b64 = base64.b64encode(data).decode("ascii")
    return "".join(b64[i:i + 60] + "\n" for i in range(0, len(b64), 60))


EMPTY_REPO = "Git Repository is empty."
TREE_MODES = {"100644": "blob", "100755": "blob", "120000": "blob", "040000": "tree", "160000": "commit"}


def _tree_path_ok(path):
    return (isinstance(path, str) and path and not path.startswith("/") and not path.endswith("/")
            and all(p not in ("", ".", "..", ".git") for p in path.split("/")))


class MockGitHub(object):
    def __init__(
        self,
        repo="richard-0421/lab-hub",
        token="test-token",
        private=False,
        data_branch="data",
        create_data_branch=True,
        default_branch="main",
        host="127.0.0.1",
        port=0,
        empty=False,
    ):
        self.owner, self.name = repo.split("/", 1)
        self.token = token
        self.private = private
        self.default_branch = default_branch
        self.lock = threading.RLock()
        self._counter = 0
        # branch -> {"commit": sha, "files": {path: bytes}}
        self.branches = {}
        # [{"sha", "branch", "message", "paths", "files", "date", "tree", "parents"}], oldest first;
        # "branch" is None for a commit made through git/commits until a ref points at it
        self._commits = []
        self._by_sha = {}
        self.blobs = {}   # git object id -> bytes
        self.trees = {}   # git object id -> {"files": {path: bytes}, "entries": [(name, mode, type, sha)]}
        if not empty:
            self._new_commit(default_branch, {"README.md": b"# lab-hub\n"}, "Initial commit")
            if create_data_branch:
                self._new_commit(data_branch, dict(self.branches[default_branch]["files"]), "create %s" % data_branch,
                                 parents=[self.branches[default_branch]["commit"]])
        self.requests = []
        self._fails = []
        self._hooks = []
        self._drops = []
        self.offline = False
        self.rate_remaining = 4999
        self.server = ThreadingHTTPServer((host, port), _Handler)
        self.server.daemon_threads = True
        self.server.mock = self
        self._thread = None

    # ---- lifecycle ------------------------------------------------------ #
    @property
    def port(self):
        return self.server.server_address[1]

    @property
    def url(self):
        return "http://%s:%d" % (self.server.server_address[0], self.port)

    def start(self):
        self._thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05},
                                        name="mock-github", daemon=True)
        self._thread.start()
        return self

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        if self._thread:
            self._thread.join(5)

    # ---- state helpers -------------------------------------------------- #
    @property
    def is_empty(self):
        """No commits at all (GitHub's "This repository is empty.")."""
        return not self._commits

    def _store_blob(self, data):
        sha = blob_sha(data)
        self.blobs[sha] = data
        return sha

    def _store_tree(self, files):
        """Store the git tree (and its subtrees and blobs) for {path: bytes};
        return its object id. ValueError when a path is both a file and a
        directory."""
        with self.lock:
            top = {}
            for path, data in files.items():
                head, sep, rest = path.partition("/")
                kind, value = top.setdefault(head, ("tree", {}) if sep else ("blob", data))
                if (kind == "tree") != bool(sep):
                    raise ValueError("%s is both a file and a directory" % head)
                if sep:
                    value[rest] = data
            entries = []
            for name, (kind, value) in top.items():
                if kind == "blob":
                    entries.append((name, "100644", "blob", self._store_blob(value)))
                else:
                    entries.append((name, "040000", "tree", self._store_tree(value)))
            # git's order: by name, a directory compared as "name/"
            entries.sort(key=lambda e: e[0].encode("utf-8") + (b"/" if e[2] == "tree" else b""))
            raw = b"".join(b"%s %s\0" % (mode.lstrip("0").encode(), name.encode("utf-8")) + bytes.fromhex(sha)
                           for name, mode, _kind, sha in entries)
            sha = hashlib.sha1(b"tree %d\0" % len(raw) + raw).hexdigest()
            self.trees[sha] = {"files": dict(files), "entries": entries}
            return sha

    def _new_commit(self, branch, files, message, paths=None, parents=None):
        """Record a commit of ``files``. ``branch`` None: no ref points at it
        yet (git/commits). ``parents`` defaults to the branch's head; ``paths``
        (the files it touched) defaults to what differs from the first parent."""
        with self.lock:
            self._counter += 1
            sha = hashlib.sha1(("commit-%d-%s-%f" % (self._counter, branch, time.time())).encode()).hexdigest()
            if parents is None:
                parents = [self.branches[branch]["commit"]] if branch in self.branches else []
            if paths is None:
                before = self._by_sha[parents[0]]["files"] if parents else {}
                paths = sorted(p for p in set(before) | set(files) if before.get(p) != files.get(p))
            tree = self._store_tree(files)
            if branch is not None:
                self.branches[branch] = {"commit": sha, "files": files}
            commit = {"sha": sha, "branch": branch, "message": message, "paths": list(paths), "files": files,
                      "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "tree": tree,
                      "parents": list(parents)}
            self._commits.append(commit)
            self._by_sha[sha] = commit
            return sha

    def commit(self, sha):
        """The recorded commit (a copy), or None."""
        with self.lock:
            c = self._by_sha.get(sha)
            return dict(c) if c else None

    def head(self, branch):
        """The commit a branch points at (a copy), or None."""
        with self.lock:
            b = self.branches.get(branch)
            return self.commit(b["commit"]) if b else None

    def set_file_text(self, branch, path, text, message="edit via web"):
        """Simulate a hand edit / another client. Creates the branch (from the
        default branch) if needed. Returns the new blob sha."""
        data = text.encode("utf-8") if isinstance(text, str) else bytes(text)
        with self.lock:
            if branch not in self.branches:
                base = self.branches.get(self.default_branch)
                self._new_commit(branch, dict(base["files"]) if base else {}, "create " + branch,
                                 parents=[base["commit"]] if base else [])
            files = dict(self.branches[branch]["files"])
            files[path] = data
            self._new_commit(branch, files, message, [path])
            return blob_sha(data)

    def get_file_text(self, branch, path):
        with self.lock:
            b = self.branches.get(branch)
            if not b or path not in b["files"]:
                return None
            return b["files"][path].decode("utf-8")

    def get_file_json(self, branch, path):
        text = self.get_file_text(branch, path)
        return None if text is None else json.loads(text)

    def delete_file(self, branch, path):
        with self.lock:
            files = dict(self.branches[branch]["files"])
            files.pop(path, None)
            self._new_commit(branch, files, "delete " + path)

    def commits(self, branch=None):
        with self.lock:
            return [dict(c) for c in self._commits if branch is None or c["branch"] == branch]

    def fail_next(self, status, message="mock failure", method=None, path_contains=None, headers=None):
        """The next request matching method/path gets this error response."""
        with self.lock:
            self._fails.append((status, message, method, path_contains, headers or {}))

    def drop_response_next(self, method, path_contains=None):
        """Handle the next matching request normally (a PUT is committed) but
        close the connection instead of answering - a lost response."""
        with self.lock:
            self._drops.append((method, path_contains, None))

    def on_next(self, method, fn, path_contains=None):
        """Call ``fn()`` once, right before handling the next matching request
        (e.g. change the file between our GET and PUT to force a 409)."""
        with self.lock:
            self._hooks.append((method, path_contains, fn))

    def set_offline(self, on=True):
        """While offline every API connection is closed without a response."""
        self.offline = bool(on)

    def clear_log(self):
        with self.lock:
            del self.requests[:]

    def count(self, method=None, path_contains=None, status=None):
        with self.lock:
            return sum(
                1
                for r in self.requests
                if (method is None or r["method"] == method)
                and (path_contains is None or path_contains in r["path"])
                and (status is None or r["status"] == status)
            )

    def _pop_matching(self, items, method, path):
        with self.lock:
            for i, entry in enumerate(items):
                if len(entry) == 3:  # hook: (method, path_contains, fn)
                    m, p = entry[0], entry[1]
                else:  # failure: (status, message, method, path_contains, headers)
                    m, p = entry[2], entry[3]
                if (m is None or m == method) and (p is None or p in path):
                    return items.pop(i)
        return None


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MockGitHub/1.0"

    def log_message(self, fmt, *args):  # keep test output quiet
        pass

    @property
    def mock(self):
        return self.server.mock

    # ---- response helpers ---------------------------------------------- #
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS)

    def _send(self, status, body=b"", content_type="application/json; charset=utf-8", headers=None):
        mock = self.mock
        self.send_response(status)
        self._cors()
        self.send_header("X-RateLimit-Limit", "5000")
        self.send_header("X-RateLimit-Remaining", str(mock.rate_remaining))
        self.send_header("X-RateLimit-Reset", str(int(time.time()) + 3600))
        self.send_header("X-GitHub-Api-Version-Selected", "2022-11-28")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        if status != 304:
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
        else:
            self.send_header("Content-Length", "0")
        self.end_headers()
        if status != 304 and self.command != "HEAD":
            self.wfile.write(body)
        self._status = status

    def _json(self, status, obj, headers=None):
        self._send(status, json.dumps(obj).encode("utf-8"), headers=headers)

    def _error(self, status, message, headers=None):
        self._json(status, {"message": message, "documentation_url": "https://docs.github.com/rest",
                            "status": str(status)}, headers=headers)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n > 0 else b""

    # ---- dispatch ------------------------------------------------------- #
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS)
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self._dispatch("GET")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_POST(self):
        self._dispatch("POST")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method):
        mock = self.mock
        split = urlsplit(self.path)
        path = split.path
        query = {k: v[-1] for k, v in parse_qs(split.query).items()}
        body = self._body()
        self._status = None

        if path.startswith("/_mock/"):
            return self._control(method, path, query, body)

        if mock.offline:
            # drop the connection without any response
            self.close_connection = True
            try:
                self.connection.shutdown(2)
            except OSError:
                pass
            with mock.lock:
                mock.requests.append({"method": method, "path": path, "query": query, "status": "offline",
                                      "if_none_match": self.headers.get("If-None-Match"),
                                      "auth": bool(self.headers.get("Authorization"))})
            return

        hook = mock._pop_matching(mock._hooks, method, path)
        if hook is not None:
            hook[2]()
        if mock._pop_matching(mock._drops, method, path) is not None:
            real = self.wfile
            self.wfile = io.BytesIO()  # the answer goes nowhere
            try:
                self._route(method, path, query, body)
            finally:
                self.wfile = real
                self.close_connection = True
                try:
                    self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                with mock.lock:
                    mock.requests.append({"method": method, "path": path, "query": query, "status": "dropped",
                                          "if_none_match": self.headers.get("If-None-Match"),
                                          "auth": bool(self.headers.get("Authorization")),
                                          "body": body.decode("utf-8", "replace") if method in ("PUT", "POST") else None})
            return
        try:
            fail = mock._pop_matching(mock._fails, method, path)
            if fail is not None:
                self._error(fail[0], fail[1], headers=fail[4])
            else:
                self._route(method, path, query, body)
        finally:
            with mock.lock:
                mock.requests.append({
                    "method": method,
                    "path": path,
                    "query": query,
                    "status": self._status,
                    "if_none_match": self.headers.get("If-None-Match"),
                    "auth": bool(self.headers.get("Authorization")),
                    "body": body.decode("utf-8", "replace") if method in ("PUT", "POST") else None,
                })

    def _auth(self):
        """Returns (authed, error_sent)."""
        mock = self.mock
        auth = self.headers.get("Authorization")
        if not auth:
            return False, False
        scheme, _, tok = auth.strip().partition(" ")
        if scheme.lower() not in ("bearer", "token") or tok.strip() != mock.token:
            self._error(401, "Bad credentials")
            return False, True
        return True, False

    def _route(self, method, path, query, body):
        mock = self.mock
        parts = [unquote(p) for p in path.strip("/").split("/")] if path.strip("/") else []
        authed, sent = self._auth()
        if sent:
            return
        if parts == ["user"] and method == "GET":
            if not authed:
                return self._error(401, "Requires authentication")
            return self._json(200, {"login": mock.owner, "id": 1, "type": "User"})
        if len(parts) < 3 or parts[0] != "repos":
            return self._error(404, "Not Found")
        if parts[1].lower() != mock.owner.lower() or parts[2].lower() != mock.name.lower():
            return self._error(404, "Not Found")
        if mock.private and not authed:
            return self._error(404, "Not Found")
        if method in ("PUT", "POST", "PATCH", "DELETE") and not authed:
            return self._error(401, "Requires authentication")
        rest = parts[3:]
        with mock.lock:
            if not rest and method == "GET":
                return self._repo()
            if rest[:1] == ["contents"] and len(rest) >= 2:
                fpath = "/".join(rest[1:])
                if method == "GET":
                    return self._get_contents(fpath, query)
                if method == "PUT":
                    return self._put_contents(fpath, body)
            if rest[:1] == ["git"] and mock.is_empty:
                return self._error(409, EMPTY_REPO)
            if rest[:3] == ["git", "ref", "heads"] and len(rest) >= 4 and method == "GET":
                return self._get_ref("/".join(rest[3:]))
            if rest == ["git", "refs"] and method == "POST":
                return self._create_ref(body)
            if rest[:2] == ["git", "blobs"] and len(rest) == 3 and method == "GET":
                return self._get_blob(rest[2])
            if rest == ["git", "blobs"] and method == "POST":
                return self._create_blob(body)
            if rest == ["git", "trees"] and method == "POST":
                return self._create_tree(body)
            if rest == ["git", "commits"] and method == "POST":
                return self._create_commit(body)
            if rest == ["commits"] and method == "GET":
                return self._list_commits(query)
        return self._error(404, "Not Found")

    def _json_body(self, body):
        """The request's JSON object, or None after answering 400."""
        try:
            req = json.loads(body.decode("utf-8"))
        except Exception:  # noqa: BLE001
            req = None
        if not isinstance(req, dict):
            self._error(400, "Problems parsing JSON")
            return None
        return req

    def _api_url(self, suffix):
        mock = self.mock
        return "%s/repos/%s/%s%s" % (mock.url, mock.owner, mock.name, suffix)

    # ---- endpoints ------------------------------------------------------ #
    def _repo(self):
        mock = self.mock
        full = "%s/%s" % (mock.owner, mock.name)
        self._json(200, {
            "id": 1,
            "name": mock.name,
            "full_name": full,
            "private": mock.private,
            "default_branch": mock.default_branch,
            "html_url": "https://github.com/" + full,
            "permissions": {"admin": True, "maintain": True, "push": True, "triage": True, "pull": True},
        })

    def _file_info(self, fpath, data):
        mock = self.mock
        sha = blob_sha(data)
        full = "%s/%s" % (mock.owner, mock.name)
        return {
            "type": "file",
            "encoding": "base64",
            "size": len(data),
            "name": fpath.rsplit("/", 1)[-1],
            "path": fpath,
            "sha": sha,
            "url": "%s/repos/%s/contents/%s" % (mock.url, full, fpath),
            "git_url": "%s/repos/%s/git/blobs/%s" % (mock.url, full, sha),
            "html_url": "https://github.com/%s/blob/main/%s" % (full, fpath),
            "download_url": None,
        }

    def _get_contents(self, fpath, query):
        mock = self.mock
        if mock.is_empty:
            return self._error(404, "This repository is empty.")
        ref = query.get("ref") or mock.default_branch
        branch = mock.branches.get(ref)
        if branch is None:
            branch = next((c for c in mock._commits if c["sha"] == ref), None)
        if branch is None:
            return self._error(404, "No commit found for the ref %s" % ref)
        data = branch["files"].get(fpath)
        if data is None:
            return self._error(404, "Not Found")
        sha = blob_sha(data)
        etag = '"%s"' % sha
        headers = {"ETag": etag, "Cache-Control": "private, max-age=60, s-maxage=60",
                   "Vary": "Accept, Authorization, Cookie, X-GitHub-OTP"}
        inm = self.headers.get("If-None-Match")
        if inm and inm.strip() in (etag, "W/" + etag):
            return self._send(304, headers=headers)
        accept = self.headers.get("Accept") or ""
        if "application/vnd.github.raw" in accept:
            return self._send(200, data, content_type="application/vnd.github.raw; charset=utf-8", headers=headers)
        info = self._file_info(fpath, data)
        info["content"] = wrap_b64(data)
        return self._json(200, info, headers=headers)

    def _put_contents(self, fpath, body):
        mock = self.mock
        try:
            req = json.loads(body.decode("utf-8"))
            assert isinstance(req, dict)
        except Exception:  # noqa: BLE001
            return self._error(400, "Problems parsing JSON")
        if not isinstance(req.get("message"), str) or not req.get("message"):
            return self._error(422, "Invalid request.\n\n\"message\" wasn't supplied.")
        content = req.get("content")
        if not isinstance(content, str):
            return self._error(422, "Invalid request.\n\n\"content\" wasn't supplied.")
        try:
            data = base64.b64decode(content, validate=True)
        except Exception:  # noqa: BLE001
            return self._error(422, "content is not valid Base64")
        ref = req.get("branch") or mock.default_branch
        branch = mock.branches.get(ref)
        if branch is None:
            return self._error(404, "Branch %s not found" % ref)
        current = branch["files"].get(fpath)
        sha = req.get("sha")
        if current is not None:
            if not sha:
                return self._error(422, "Invalid request.\n\n\"sha\" wasn't supplied.")
            if sha != blob_sha(current):
                return self._error(409, "%s does not match %s" % (fpath, sha))
        files = dict(branch["files"])
        files[fpath] = data
        commit = mock._new_commit(ref, files, req["message"], [fpath])
        info = self._file_info(fpath, data)
        return self._json(200 if current is not None else 201, {
            "content": info,
            "commit": {
                "sha": commit,
                "message": req["message"],
                "author": {"name": "mock", "email": "mock@example.com", "date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
            },
        })

    def _list_commits(self, query):
        mock = self.mock
        if mock.is_empty:
            return self._error(409, EMPTY_REPO)
        start = query.get("sha") or mock.default_branch
        if start in mock.branches:
            sha = mock.branches[start]["commit"]
        elif start in mock._by_sha:
            sha = start
        else:
            return self._error(404, "No commit found for SHA: %s" % start)
        fpath = query.get("path")
        try:
            per_page = max(1, min(100, int(query.get("per_page") or 30)))
        except ValueError:
            per_page = 30
        out = []
        while sha and len(out) < per_page:  # histories here are linear: follow the first parent
            c = mock._by_sha[sha]
            if not fpath or fpath in c["paths"]:
                out.append({"sha": c["sha"], "commit": {"message": c["message"],
                                                        "committer": {"name": "mock", "date": c["date"]}},
                            "parents": [{"sha": p} for p in c["parents"]]})
            sha = c["parents"][0] if c["parents"] else None
        return self._json(200, out)

    def _ref_body(self, name, sha):
        return {"ref": "refs/heads/" + name, "node_id": "REF_" + sha[:12],
                "url": self._api_url("/git/refs/heads/" + name),
                "object": {"sha": sha, "type": "commit", "url": self._api_url("/git/commits/" + sha)}}

    def _get_ref(self, name):
        mock = self.mock
        branch = mock.branches.get(name)
        if branch is None:
            return self._error(404, "Not Found")
        return self._json(200, self._ref_body(name, branch["commit"]))

    def _create_ref(self, body):
        mock = self.mock
        req = self._json_body(body)
        if req is None:
            return
        ref, sha = req.get("ref"), req.get("sha")
        if not isinstance(ref, str) or not isinstance(sha, str):
            return self._error(422, "Invalid request.\n\n\"ref\" and \"sha\" are required.")
        if not ref.startswith("refs/heads/") or len(ref) <= len("refs/heads/"):
            return self._error(422, "Reference name must start with 'refs/' and have at least two slashes.")
        name = ref[len("refs/heads/"):]
        if name in mock.branches:
            return self._error(422, "Reference already exists")
        commit = mock._by_sha.get(sha)
        if commit is None:
            return self._error(422, "Object does not exist")
        mock.branches[name] = {"commit": sha, "files": dict(commit["files"])}
        if commit["branch"] is None:
            commit["branch"] = name
        return self._json(201, self._ref_body(name, sha))

    def _get_blob(self, sha):
        data = self.mock.blobs.get(sha)
        if data is None:
            return self._error(404, "Not Found")
        return self._json(200, {"sha": sha, "node_id": "BLOB_" + sha[:12], "size": len(data),
                                "url": self._api_url("/git/blobs/" + sha), "encoding": "base64",
                                "content": wrap_b64(data)})

    def _create_blob(self, body):
        req = self._json_body(body)
        if req is None:
            return
        content, encoding = req.get("content"), req.get("encoding", "utf-8")
        if not isinstance(content, str):
            return self._error(422, "Invalid request.\n\n\"content\" wasn't supplied.")
        if encoding == "utf-8":
            data = content.encode("utf-8", "surrogatepass")
        elif encoding == "base64":
            try:
                data = base64.b64decode("".join(content.split()), validate=True)
            except Exception:  # noqa: BLE001
                return self._error(422, "Invalid Base64 content")
        else:
            return self._error(422, "encoding must be utf-8 or base64")
        sha = self.mock._store_blob(data)
        return self._json(201, {"url": self._api_url("/git/blobs/" + sha), "sha": sha})

    def _create_tree(self, body):
        """Like GitHub: entries with ``content`` (utf-8 text) or ``sha`` (an
        existing blob; null deletes the path from ``base_tree``); without
        ``base_tree`` the tree holds exactly the given entries."""
        mock = self.mock
        req = self._json_body(body)
        if req is None:
            return
        entries = req.get("tree")
        if not isinstance(entries, list):
            return self._error(422, "Invalid request.\n\n\"tree\" wasn't supplied.")
        files = {}
        base = req.get("base_tree")
        if base is not None:
            if base not in mock.trees:
                return self._error(422, "base_tree is not a valid tree oid")
            files = dict(mock.trees[base]["files"])
        for e in entries:
            if not isinstance(e, dict):
                return self._error(422, "Invalid tree info")
            path, mode, kind = e.get("path"), e.get("mode"), e.get("type")
            if not _tree_path_ok(path):
                return self._error(422, "tree.path contains a malformed path component")
            if mode not in TREE_MODES or kind != TREE_MODES[mode]:
                return self._error(422, "Invalid tree info")
            if kind != "blob":
                return self._error(422, "mock: only blob entries are supported")
            if ("content" in e) == ("sha" in e):
                return self._error(422, "Must supply either tree.sha or tree.content")
            if "content" in e:
                if not isinstance(e["content"], str):
                    return self._error(422, "Invalid tree info")
                files[path] = e["content"].encode("utf-8", "surrogatepass")
            elif e["sha"] is None:
                files.pop(path, None)
            elif e["sha"] in mock.blobs:
                files[path] = mock.blobs[e["sha"]]
            else:
                return self._error(422, "tree.sha %s is not a valid blob" % e["sha"])
        try:
            sha = mock._store_tree(files)
        except ValueError:
            return self._error(422, "Invalid tree info")
        listing = []
        for name, mode, kind, obj in mock.trees[sha]["entries"]:
            item = {"path": name, "mode": mode, "type": kind, "sha": obj}
            if kind == "blob":
                item["size"] = len(mock.blobs[obj])
                item["url"] = self._api_url("/git/blobs/" + obj)
            else:
                item["url"] = self._api_url("/git/trees/" + obj)
            listing.append(item)
        return self._json(201, {"sha": sha, "url": self._api_url("/git/trees/" + sha), "tree": listing,
                                "truncated": False})

    def _create_commit(self, body):
        mock = self.mock
        req = self._json_body(body)
        if req is None:
            return
        message, tree, parents = req.get("message"), req.get("tree"), req.get("parents", [])
        if not isinstance(message, str):
            return self._error(422, "Invalid request.\n\n\"message\" wasn't supplied.")
        if not isinstance(tree, str):
            return self._error(422, "Invalid request.\n\n\"tree\" wasn't supplied.")
        if tree not in mock.trees:
            return self._error(422, "Tree SHA does not exist")
        if not isinstance(parents, list) or not all(isinstance(p, str) and p in mock._by_sha for p in parents):
            return self._error(422, "Parent SHA does not exist or is not a commit object")
        sha = mock._new_commit(None, dict(mock.trees[tree]["files"]), message, parents=parents)
        c = mock._by_sha[sha]
        person = {"name": "mock", "email": "mock@example.com", "date": c["date"]}
        return self._json(201, {
            "sha": sha,
            "node_id": "C_" + sha[:12],
            "url": self._api_url("/git/commits/" + sha),
            "html_url": "https://github.com/%s/%s/commit/%s" % (mock.owner, mock.name, sha),
            "author": person,
            "committer": person,
            "tree": {"sha": c["tree"], "url": self._api_url("/git/trees/" + c["tree"])},
            "message": message,
            "parents": [{"sha": p, "url": self._api_url("/git/commits/" + p),
                         "html_url": "https://github.com/%s/%s/commit/%s" % (mock.owner, mock.name, p)}
                        for p in parents],
            "verification": {"verified": False, "reason": "unsigned", "signature": None, "payload": None},
        })

    # ---- control endpoints --------------------------------------------- #
    def _control(self, method, path, query, body):
        mock = self.mock
        name = path[len("/_mock/"):]
        if name == "state" and method == "GET":
            with mock.lock:
                state = {b: {"commit": v["commit"], "files": sorted(v["files"])} for b, v in mock.branches.items()}
                return self._json(200, {"branches": state, "offline": mock.offline,
                                        "commits": len(mock._commits)})
        if name == "file":
            branch = query.get("branch") or "data"
            fpath = query.get("path") or "board.json"
            if method == "GET":
                text = mock.get_file_text(branch, fpath)
                if text is None:
                    return self._error(404, "Not Found")
                return self._send(200, text.encode("utf-8"), content_type="text/plain; charset=utf-8")
            if method in ("POST", "PUT"):
                sha = mock.set_file_text(branch, fpath, body.decode("utf-8"), query.get("message") or "edit via web")
                return self._json(200, {"sha": sha})
        if name == "offline" and method == "POST":
            mock.set_offline(query.get("on", "1") not in ("0", "false", "off"))
            return self._json(200, {"offline": mock.offline})
        if name == "fail" and method == "POST":
            try:
                status = int(query.get("status", "500"))
            except ValueError:
                return self._error(400, "bad status")
            mock.fail_next(status, query.get("message") or "mock failure", query.get("method"), query.get("path"))
            return self._json(200, {"queued": status})
        if name == "log" and method == "GET":
            with mock.lock:
                return self._json(200, mock.requests[-200:])
        return self._error(404, "Not Found")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Mock GitHub API for Lab Hub tests")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=9010)
    ap.add_argument("--repo", default="richard-0421/lab-hub")
    ap.add_argument("--token", default="test-token")
    ap.add_argument("--branch", default="data", help="data branch name")
    ap.add_argument("--path", default="board.json")
    ap.add_argument("--private", action="store_true")
    ap.add_argument("--no-data-branch", action="store_true", help="start without the data branch")
    ap.add_argument("--empty", action="store_true", help="start as an empty repo (no commits at all)")
    ap.add_argument("--seed", help="file whose text becomes <branch>/<path> at start")
    args = ap.parse_args(argv)
    mock = MockGitHub(repo=args.repo, token=args.token, private=args.private, data_branch=args.branch,
                      create_data_branch=not args.no_data_branch, host=args.host, port=args.port,
                      empty=args.empty)
    if args.seed:
        with open(os.path.expanduser(args.seed), encoding="utf-8") as f:
            mock.set_file_text(args.branch, args.path, f.read(), "seed")
    print("Mock GitHub API for %s on %s (token required for writes%s)"
          % (args.repo, mock.url, ", private repo" if args.private else ""), flush=True)
    try:
        mock.server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        mock.server.server_close()


if __name__ == "__main__":
    main()
