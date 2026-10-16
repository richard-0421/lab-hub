"""Configuration for the Lab Hub backend.

Order of precedence (low -> high):
  1. DEFAULTS below
  2. config.json in the project folder (optional; copy config.example.json).
     Another file can be named with the env var LABHUB_CONFIG.
  3. Environment variables LABHUB_<KEY> (e.g. LABHUB_PORT, LABHUB_GITHUB_TOKEN)

See docs/ARCHITECTURE.md section 6. The GitHub token is only ever read here
and handed to the sync client; it is never logged or sent to browsers.

Command line helper (prints values, never the token):
    python -m app.config host port
"""
import json
import logging
import os
import re
import urllib.parse

log = logging.getLogger("labhub.config")

# Project folder (parent of the app package). Relative paths resolve here.
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DEFAULTS = {
    "name": "Lab Hub",
    "host": "0.0.0.0",
    "port": 8000,
    "theme": "dark",
    "calendar_ics": "",
    "calendar_max_events": 8,
    "github_repo": "",
    "github_branch": "data",
    "github_path": "board.json",
    "github_token": "",
    "github_api": "https://api.github.com",
    "sync_interval": 15,
    "client_name": "lab-pi",
    "pages_url": "",
    "state_dir": "state",
    "db_path": "labhub.db",
    # extra host names browsers may use to reach this server (besides
    # localhost, IP addresses and this machine's own hostname / <hostname>.local);
    # a list, or a comma-separated string in LABHUB_ALLOWED_HOSTS. A name
    # starting with "." allows every subdomain; "*" turns the check off.
    "allowed_hosts": "",
}

# keys holding a list of strings
LIST_KEYS = ("allowed_hosts",)

# legacy key -> current key
ALIASES = {"subgroup_name": "name"}

# key -> (min, max)
INT_KEYS = {
    "port": (1, 65535),
    "sync_interval": (2, 86400),
    "calendar_max_events": (0, 100),
}

THEMES = ("dark", "light", "auto")
_REPO_RE = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}")
_SECRET_KEYS = ("github_token",)


def _resolve_path(p, base_dir):
    if not p:
        return p
    p = os.path.expanduser(p)
    return p if os.path.isabs(p) else os.path.abspath(os.path.join(base_dir, p))


def _normalize_repo(value):
    """Accept 'owner/name', 'https://github.com/owner/name(.git)', 'git@github.com:owner/name.git'."""
    s = (value or "").strip()
    if not s:
        return ""
    for prefix in ("https://github.com/", "http://github.com/", "git@github.com:", "github.com/"):
        if s.lower().startswith(prefix):
            s = s[len(prefix):]
            break
    s = s.strip("/")
    if s.endswith(".git"):
        s = s[:-4]
    if not _REPO_RE.fullmatch(s):
        log.warning("github_repo %r is not 'owner/name'; GitHub sync is off", value)
        return ""
    return s


def _derive_pages_url(repo, code_repo=""):
    """GitHub Pages address for the board in ``repo``. The site is published
    from the code repo (the one this folder was cloned from); when the board
    lives in another repo, e.g. a private data repo, the site is pointed at it
    with ``?repo=``."""
    site = code_repo or repo
    owner, name = site.split("/", 1)
    host = "%s.github.io" % owner.lower()
    if name.lower() == host:
        url = "https://%s/" % host
    else:
        url = "https://%s/%s/" % (host, name)
    if code_repo and code_repo.lower() != repo.lower():
        url += "?repo=" + repo
    return url


def _git_common_dir(repo_dir):
    """The git directory holding ``config`` for a checkout (handles a ``.git``
    file pointing elsewhere and worktrees). None when there is none."""
    git = os.path.join(repo_dir, ".git")
    try:
        if os.path.isfile(git):
            with open(git, encoding="utf-8") as f:
                text = f.read()
            if not text.startswith("gitdir:"):
                return None
            git = text[len("gitdir:"):].strip()
            if not os.path.isabs(git):
                git = os.path.normpath(os.path.join(repo_dir, git))
        if not os.path.isdir(git):
            return None
        common = os.path.join(git, "commondir")
        if os.path.isfile(common):
            with open(common, encoding="utf-8") as f:
                ref = f.read().strip()
            if ref:
                git = ref if os.path.isabs(ref) else os.path.normpath(os.path.join(git, ref))
    except (OSError, UnicodeDecodeError):
        return None
    return git


def _github_slug(url):
    """'owner/name' for a github.com remote URL (https, ssh or scp-like), else ''."""
    u = url.strip().strip('"').strip()
    m = re.match(r"^[A-Za-z0-9_.-]+@github\.com:(.+)$", u, re.IGNORECASE)
    if m:
        path = m.group(1)
    else:
        try:
            parts = urllib.parse.urlsplit(u)
        except ValueError:
            return ""
        if parts.scheme not in ("https", "http", "ssh", "git") or (parts.hostname or "").lower() != "github.com":
            return ""
        path = parts.path
    path = path.strip("/")
    if path.endswith(".git"):
        path = path[:-4]
    return path if _REPO_RE.fullmatch(path) else ""


def git_origin_repo(repo_dir):
    """'owner/name' of the checkout's ``origin`` remote on github.com, or ''."""
    git = _git_common_dir(repo_dir)
    if not git:
        return ""
    try:
        with open(os.path.join(git, "config"), encoding="utf-8") as f:
            text = f.read()
    except (OSError, UnicodeDecodeError):
        return ""
    section = None
    for line in text.splitlines():
        line = line.strip()
        if not line or line[0] in "#;":
            continue
        if line.startswith("["):
            section = " ".join(line[1:line.find("]")].split()) if "]" in line else None
            continue
        key, sep, value = line.partition("=")
        if sep and section == 'remote "origin"' and key.strip().lower() == "url":
            return _github_slug(value)
    return ""


def _read_config_file(path):
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:  # noqa: BLE001
        log.warning("could not parse %s (%s); using defaults", path, exc)
        return {}
    if not isinstance(data, dict):
        log.warning("%s must contain a JSON object; using defaults", path)
        return {}
    return data


def load_config(base_dir=None, config_path=None, environ=None):
    """Build the config dict. All arguments exist for tests:

    base_dir     folder relative paths resolve against (default: project dir)
    config_path  config file (default: $LABHUB_CONFIG or <base_dir>/config.json)
    environ      mapping used instead of os.environ
    """
    base_dir = base_dir or BASE_DIR
    environ = os.environ if environ is None else environ
    if config_path is None:
        config_path = environ.get("LABHUB_CONFIG") or os.path.join(base_dir, "config.json")

    cfg = dict(DEFAULTS)

    user = _read_config_file(config_path)
    for old, new in ALIASES.items():
        if old in user and new not in user:
            user[new] = user[old]
    for key in DEFAULTS:
        if key in user and user[key] is not None:
            cfg[key] = user[key]

    for old, new in ALIASES.items():
        env_old = environ.get("LABHUB_" + old.upper())
        if env_old is not None and environ.get("LABHUB_" + new.upper()) is None:
            cfg[new] = env_old
    for key in DEFAULTS:
        env = environ.get("LABHUB_" + key.upper())
        if env is not None:
            cfg[key] = env

    # ---- coercion ----------------------------------------------------------
    for key, (lo, hi) in INT_KEYS.items():
        try:
            val = int(str(cfg[key]).strip())
        except (TypeError, ValueError):
            log.warning("config %s=%r is not an integer; using %s", key, cfg[key], DEFAULTS[key])
            val = DEFAULTS[key]
        cfg[key] = min(hi, max(lo, val))

    for key in LIST_KEYS:
        val = cfg[key]
        if isinstance(val, str):
            parts = re.split(r"[\s,]+", val)
        elif isinstance(val, list):
            parts = [v for v in val if isinstance(v, str)]
        else:
            parts = []
        cfg[key] = [p.strip().lower().rstrip(".") for p in parts if p.strip().rstrip(".")]

    for key, default in DEFAULTS.items():
        if key in INT_KEYS or key in LIST_KEYS:
            continue
        val = cfg[key]
        if not isinstance(val, str):
            val = "" if isinstance(val, (dict, list, bool)) else str(val)
        cfg[key] = val.strip()

    # tokens are pasted from web pages; drop every whitespace character
    cfg["github_token"] = "".join(cfg["github_token"].split())
    cfg["name"] = " ".join(cfg["name"].split()) or DEFAULTS["name"]
    cfg["client_name"] = " ".join(cfg["client_name"].split())[:60] or DEFAULTS["client_name"]
    cfg["host"] = cfg["host"] or DEFAULTS["host"]
    cfg["theme"] = cfg["theme"].lower() if cfg["theme"].lower() in THEMES else DEFAULTS["theme"]
    cfg["github_repo"] = _normalize_repo(cfg["github_repo"])
    cfg["github_branch"] = cfg["github_branch"] or DEFAULTS["github_branch"]
    cfg["github_path"] = cfg["github_path"].strip("/") or DEFAULTS["github_path"]
    cfg["github_api"] = (cfg["github_api"] or DEFAULTS["github_api"]).rstrip("/")
    if not cfg["pages_url"] and cfg["github_repo"]:
        cfg["pages_url"] = _derive_pages_url(cfg["github_repo"], git_origin_repo(base_dir))

    cfg["state_dir"] = _resolve_path(cfg["state_dir"] or DEFAULTS["state_dir"], base_dir)
    cfg["db_path"] = _resolve_path(cfg["db_path"], base_dir)
    ics = cfg["calendar_ics"]
    if ics and not (ics.startswith("http://") or ics.startswith("https://")):
        # a non-URL calendar source is a (possibly relative) local .ics file
        cfg["calendar_ics"] = _resolve_path(ics, base_dir)
    return cfg


def github_enabled(cfg):
    """GitHub sync runs only when both a repo and a token are configured."""
    return bool(cfg.get("github_repo")) and bool(cfg.get("github_token"))


def redacted(cfg):
    """Copy of ``cfg`` that is safe to print or log."""
    out = dict(cfg)
    for key in _SECRET_KEYS:
        if out.get(key):
            out[key] = "<set>"
    return out


_CACHED = None


def get_config():
    """Process-wide config (loaded on first use)."""
    global _CACHED
    if _CACHED is None:
        _CACHED = load_config()
    return _CACHED


def __getattr__(name):  # PEP 562: keeps the old ``from .config import CONFIG``
    if name == "CONFIG":
        return get_config()
    raise AttributeError(name)


if __name__ == "__main__":
    import sys

    conf = redacted(load_config())
    keys = sys.argv[1:]
    if not keys:
        print(json.dumps(conf, indent=2))
    for k in keys:
        print(conf.get(k, ""))
