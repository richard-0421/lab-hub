"""Lab Hub - FastAPI backend (local mode). See docs/ARCHITECTURE.md section 4.

    GET  /api/config          dashboard settings for the page (never the token)
    GET  /api/board?rev=N     the board (or {"unchanged": true} if rev matches)
    POST /api/ops             {"ops": [...]} -> apply / queue for GitHub
    GET  /api/sync            sync status
    POST /api/sync            run a sync cycle now
    GET  /api/calendar        upcoming events from the published .ics
    GET  /api/version         git sha (or static-files hash); the page reloads on change
    /                         static/ (index.html, js/, style.css)

Run:  python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
Tests build their own app with create_app(load_config(...)).
"""
import hashlib
import json
import logging
import os
import re
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import calendar_feed, migrate
from .config import BASE_DIR, github_enabled, load_config
from .github_sync import SyncWorker
from .store import OpError, Store

log = logging.getLogger("labhub")

STATIC_DIR = os.path.join(BASE_DIR, "static")
MAX_OPS_PER_REQUEST = 500


class SafeJSONResponse(JSONResponse):
    """JSONResponse that never fails on a lone surrogate in user text."""

    def render(self, content):
        return json.dumps(
            content, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8", "backslashreplace")


# --------------------------------------------------------------------------- #
# version (git HEAD without subprocess, else a hash of static/)
# --------------------------------------------------------------------------- #
_SHA_RE = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")


def _read_text(path):
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None


def git_head_sha(repo_dir):
    """The commit sha HEAD points at, read straight from .git (handles a
    ``.git`` file pointing elsewhere, worktrees, detached HEAD, loose refs and
    packed-refs). None if unavailable."""
    git = os.path.join(repo_dir, ".git")
    if os.path.isfile(git):
        text = _read_text(git) or ""
        if not text.startswith("gitdir:"):
            return None
        git = text[len("gitdir:"):].strip()
        if not os.path.isabs(git):
            git = os.path.normpath(os.path.join(repo_dir, git))
    if not os.path.isdir(git):
        return None
    common = git
    common_ref = _read_text(os.path.join(git, "commondir"))
    if common_ref:
        common_ref = common_ref.strip()
        common = common_ref if os.path.isabs(common_ref) else os.path.normpath(os.path.join(git, common_ref))

    head = (_read_text(os.path.join(git, "HEAD")) or "").strip()
    seen = 0
    while head.startswith("ref:") and seen < 5:
        seen += 1
        ref = head[4:].strip()
        value = None
        for d in (git, common):
            value = _read_text(os.path.join(d, *ref.split("/")))
            if value is not None:
                break
        if value is None:
            value = _packed_ref(common, ref) or _packed_ref(git, ref)
        if value is None:
            return None
        head = value.strip()
    return head if _SHA_RE.fullmatch(head) else None


def _packed_ref(git_dir, ref):
    text = _read_text(os.path.join(git_dir, "packed-refs"))
    if not text:
        return None
    for line in text.splitlines():
        if not line or line[0] in "#^":
            continue
        sha, _, name = line.partition(" ")
        if name.strip() == ref:
            return sha.strip()
    return None


def static_files_hash(static_dir):
    h = hashlib.sha1()
    for root, dirs, files in os.walk(static_dir):
        dirs.sort()
        for name in sorted(files):
            p = os.path.join(root, name)
            try:
                st = os.stat(p)
            except OSError:
                continue
            rel = os.path.relpath(p, static_dir).replace(os.sep, "/")
            h.update(("%s\0%d\0%d\n" % (rel, st.st_mtime_ns, st.st_size)).encode("utf-8"))
    return "static-" + h.hexdigest()[:16]


def compute_version(repo_dir, static_dir):
    return git_head_sha(repo_dir) or static_files_hash(static_dir)


# --------------------------------------------------------------------------- #
# app factory
# --------------------------------------------------------------------------- #
def _setup_logging():
    root = logging.getLogger()
    if not log.handlers and not root.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("[labhub] %(levelname)s %(name)s: %(message)s"))
        log.addHandler(handler)
        log.setLevel(os.environ.get("LABHUB_LOG_LEVEL", "INFO").upper())
        log.propagate = False


def _file_url(cfg):
    repo = cfg.get("github_repo")
    if not repo:
        return ""
    return "https://github.com/%s/blob/%s/%s" % (repo, cfg.get("github_branch"), cfg.get("github_path"))


def public_config(cfg):
    """Body of GET /api/config. Must never contain the token."""
    return {
        "labhub": True,
        "name": cfg["name"],
        "client": cfg["client_name"],
        "theme": cfg["theme"],
        "github": {
            "enabled": github_enabled(cfg),
            "repo": cfg["github_repo"],
            "branch": cfg["github_branch"],
            "path": cfg["github_path"],
            "pages_url": cfg["pages_url"],
            "file_url": _file_url(cfg),
        },
        "calendar": {"configured": bool(cfg["calendar_ics"])},
    }


def _bad_request(message, index=None):
    return SafeJSONResponse({"error": message, "index": index}, status_code=400)


def create_app(cfg=None, static_dir=None, repo_dir=None):
    """Build the FastAPI app. ``cfg`` defaults to load_config()."""
    _setup_logging()
    cfg = cfg if cfg is not None else load_config()
    static_dir = static_dir or STATIC_DIR
    version = compute_version(repo_dir or BASE_DIR, static_dir)
    config_body = public_config(cfg)

    @asynccontextmanager
    async def lifespan(app):
        enabled = github_enabled(cfg)
        store = Store(
            cfg["state_dir"],
            github_enabled=enabled,
            repo=cfg["github_repo"],
            branch=cfg["github_branch"],
            path=cfg["github_path"],
            api=cfg["github_api"],
            client_name=cfg["client_name"],
        )
        try:
            migrate.run_migration(cfg, store)
        except Exception:  # noqa: BLE001 - a bad legacy db must not stop the hub
            log.exception("legacy import failed")
        worker = SyncWorker(store, cfg) if enabled else None
        app.state.store = store
        app.state.worker = worker
        if worker is not None:
            worker.start()
            log.info("GitHub sync on: %s (%s:%s)", cfg["github_repo"], cfg["github_branch"], cfg["github_path"])
        else:
            log.info("GitHub sync off (local-only board in %s)", cfg["state_dir"])
        try:
            yield
        finally:
            if worker is not None:
                worker.stop()

    app = FastAPI(
        title="Lab Hub",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        default_response_class=SafeJSONResponse,
    )
    app.state.config = cfg
    app.state.version = version

    @app.middleware("http")
    async def cache_headers(request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path == "/api" or path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        else:
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/api/config")
    def api_config():
        return SafeJSONResponse(config_body)

    @app.get("/api/board")
    def api_board(request: Request, rev: Optional[str] = None):
        client_rev = None
        if rev is not None:
            try:
                client_rev = int(rev)
            except ValueError:
                client_rev = None
        return SafeJSONResponse(request.app.state.store.board_response(client_rev))

    @app.post("/api/ops")
    async def api_ops(request: Request):
        raw = await request.body()
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return _bad_request("request body must be JSON")
        ops = body.get("ops") if isinstance(body, dict) else None
        if not isinstance(ops, list):
            return _bad_request('body must be {"ops": [...]}')
        if not ops:
            return _bad_request("ops must not be empty")
        if len(ops) > MAX_OPS_PER_REQUEST:
            return _bad_request("at most %d ops per request" % MAX_OPS_PER_REQUEST)
        store = request.app.state.store
        try:
            result = await run_in_threadpool(store.submit, ops)
        except OpError as exc:
            return _bad_request(exc.message, exc.index)
        worker = request.app.state.worker
        if worker is not None:
            worker.kick()
        return SafeJSONResponse(result)

    @app.get("/api/sync")
    def api_sync_status(request: Request):
        return SafeJSONResponse(request.app.state.store.sync_status())

    @app.post("/api/sync")
    def api_sync_now(request: Request):
        worker = request.app.state.worker
        if worker is None:
            return SafeJSONResponse(request.app.state.store.sync_status())
        return SafeJSONResponse(worker.sync_now())

    @app.get("/api/calendar")
    def api_calendar():
        return SafeJSONResponse(calendar_feed.get_events(cfg))

    @app.get("/api/version")
    def api_version():
        return SafeJSONResponse({"version": version})

    @app.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
    def api_not_found(rest: str):
        return SafeJSONResponse({"error": "not found"}, status_code=404)

    # static/ last, so /api/* always wins
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
    return app


app = create_app()
