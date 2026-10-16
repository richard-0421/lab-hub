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

Anyone on the LAN may edit (no login, by design), but other web sites may
not: every request must name this server by localhost, an IP address, this
machine's hostname or a configured ``allowed_hosts`` entry (stops DNS
rebinding), and a write to /api/* is refused when the browser says it comes
from another site (Origin / Sec-Fetch-Site). POST /api/ops also requires
``Content-Type: application/json``, which a cross-site form or no-cors fetch
cannot send without a CORS preflight.
"""
import hashlib
import ipaddress
import json
import logging
import os
import re
import socket
import threading
import time
import urllib.parse
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import calendar_feed, migrate
from .config import BASE_DIR, github_enabled, load_config
from .github_sync import SyncWorker
from .store import OpError, Store, StoreUnavailable

log = logging.getLogger("labhub")

STATIC_DIR = os.path.join(BASE_DIR, "static")
MAX_OPS_PER_REQUEST = 500
MAX_BODY_BYTES = 2 * 1024 * 1024   # POST /api/ops; 500 real ops are far smaller


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
# LAN address (shown on the kiosk, which itself runs on localhost)
# --------------------------------------------------------------------------- #
LAN_CACHE_SECONDS = 60.0
_lan_cache = {"at": None, "ip": None}
_lan_lock = threading.Lock()


def clear_lan_cache():
    with _lan_lock:
        _lan_cache["at"] = None
        _lan_cache["ip"] = None


def primary_lan_ipv4(sock_factory=None):
    """This machine's primary IPv4 address (the source address of its default
    route), or None. connect() on a UDP socket only consults the routing
    table: no packet is sent. Cached for LAN_CACHE_SECONDS."""
    now = time.monotonic()
    with _lan_lock:
        if _lan_cache["at"] is not None and now - _lan_cache["at"] < LAN_CACHE_SECONDS:
            return _lan_cache["ip"]
    ip = None
    try:
        sock = (sock_factory or socket.socket)(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.connect(("8.8.8.8", 80))
            ip = sock.getsockname()[0]
        finally:
            sock.close()
    except OSError:
        ip = None
    if not isinstance(ip, str) or not ip or ip.startswith("127.") or ip == "0.0.0.0":
        ip = None
    with _lan_lock:
        _lan_cache["at"] = now
        _lan_cache["ip"] = ip
    return ip


def lan_url(cfg, port=None):
    """``http://<LAN IPv4>:<port>`` for teammates, or None (bound to loopback
    only, or no LAN address)."""
    host = (cfg.get("host") or "").strip().strip("[]").lower()
    if host == "localhost":
        return None
    ip = None
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        addr = None  # empty, or a host name: use the default-route address
    if addr is not None:
        if addr.is_loopback:
            return None
        if addr.version == 4 and not addr.is_unspecified:
            ip = host  # bound to one specific address
    ip = ip or primary_lan_ipv4()
    if not ip:
        return None
    port = int(port or cfg.get("port") or 80)
    return "http://%s" % ip if port == 80 else "http://%s:%d" % (ip, port)


# --------------------------------------------------------------------------- #
# request guard (DNS rebinding / cross-site writes)
# --------------------------------------------------------------------------- #
_UNSAFE_METHODS = frozenset(("POST", "PUT", "PATCH", "DELETE"))
_DEFAULT_PORT = {"http": "80", "https": "443"}


def split_host(value):
    """('host', 'port') from a Host header value (lower-case, port may be '')."""
    v = (value or "").strip().lower()
    if v.startswith("["):
        end = v.find("]")
        if end < 0:
            return v, ""
        return v[1:end], v[end + 1:].lstrip(":")
    if v.count(":") == 1:
        host, _, port = v.partition(":")
        return host.rstrip("."), port
    return v.rstrip("."), ""


def local_host_names():
    """Names this machine answers to besides IP addresses."""
    names = {"localhost"}
    try:
        hn = socket.gethostname().strip().lower().rstrip(".")
    except OSError:
        hn = ""
    if hn:
        short = hn.split(".")[0]
        names.update((hn, hn + ".local", short, short + ".local"))
    return names


def host_allowed(host, names, extra=()):
    """May a browser reach us under this Host name? IP literals, localhost,
    our own names and ``allowed_hosts`` entries ("." prefix = subdomains,
    "*" = anything). A DNS-rebinding page always uses its own domain."""
    if not host or host in names or host == "localhost" or host.endswith(".localhost"):
        return True
    for entry in extra:
        if entry == "*" or entry == host or (entry.startswith(".") and host.endswith(entry)):
            return True
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def same_origin(origin, host_header, scheme="http"):
    """Does the Origin header name this very server (scheme host:port)?"""
    try:
        o = urllib.parse.urlsplit(origin)
        o_port = str(o.port) if o.port is not None else _DEFAULT_PORT.get(o.scheme)
    except ValueError:
        return False
    if o.scheme != scheme or not o.hostname or not o_port:
        return False
    host, port = split_host(host_header)
    return (o.hostname.lower().rstrip("."), o_port) == (host, port or _DEFAULT_PORT.get(scheme, "80"))


async def read_body(request, limit):
    """The request body, or None when it is longer than ``limit`` bytes."""
    length = request.headers.get("content-length")
    if length is not None:
        try:
            if int(length) > limit:
                return None
        except ValueError:
            return None
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


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


def _bad_request(message, index=None, status=400):
    return SafeJSONResponse({"error": message, "index": index}, status_code=status)


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
    host_names = local_host_names()
    extra_hosts = tuple(cfg.get("allowed_hosts") or ())

    # registered before cache_headers, so that one wraps it (Starlette runs
    # the last registered middleware first)
    @app.middleware("http")
    async def request_guard(request, call_next):
        path = request.url.path
        is_api = path == "/api" or path.startswith("/api/")
        host_header = request.headers.get("host")
        host = split_host(host_header)[0]
        if not host_allowed(host, host_names, extra_hosts):
            msg = ("this Lab Hub does not answer to the host name %r; use its IP address, or add the name "
                   "to allowed_hosts in config.json" % host[:100])
            if is_api:
                return _bad_request(msg)
            return PlainTextResponse(msg + "\n", status_code=400)
        if is_api and request.method in _UNSAFE_METHODS:
            site = (request.headers.get("sec-fetch-site") or "").lower()
            origin = request.headers.get("origin")
            if site in ("cross-site", "same-site") or (
                origin is not None and not same_origin(origin, host_header, request.url.scheme)
            ):
                return _bad_request("cross-site request refused", status=403)
        return await call_next(request)

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
    def api_config(request: Request):
        body = dict(config_body)
        try:
            server = request.scope.get("server")
            body["lan_url"] = lan_url(cfg, server[1] if server else None)
        except Exception:  # noqa: BLE001 - never let this break the page's config
            log.debug("could not work out the LAN address", exc_info=True)
            body["lan_url"] = None
        return SafeJSONResponse(body)

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
        ctype = (request.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
        if ctype != "application/json":
            return _bad_request("Content-Type must be application/json", status=415)
        raw = await read_body(request, MAX_BODY_BYTES)
        if raw is None:
            return _bad_request("request body too large (at most %d bytes)" % MAX_BODY_BYTES, status=413)
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
        except StoreUnavailable as exc:
            return _bad_request(exc.message, status=503)
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
