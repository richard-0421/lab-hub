#!/usr/bin/env python3
"""JSON and GitHub helper for scripts/install-pi.sh (stdlib only, Python 3.9+).

    python3 scripts/install_helper.py MODE

Inputs come from LH_* environment variables, so the token never appears on a
command line. Nothing here ever prints the token.

  show    print name, board repo, calendar and "1"/"0" (token saved?), one per line
  write   merge LH_NAME, LH_REPO, LH_ICS, LH_TOKEN (+ LH_TOKEN_ACTION keep|set|clear)
          into config.json (mode 600). Also manages "pages_url" from LH_ORIGIN
          (see pages_urls below).
  olddb   copy the old install's labhub.db (LH_OLD_DIR) next to this one
  port    "port" from config.json (8000 if unset)
  pages   the GitHub Pages address to print for LH_ORIGIN + the saved board repo
  check   test the saved token against GitHub: can it read AND write the board
          repo, does the board branch exist yet, and (only when the board is in
          a separate data repo) can it also write the code repo LH_ORIGIN names?

The normal setup keeps code and board in ONE repo (richard-0417/lab-hub: main
= code, data = board.json); a separate data repo is an optional alternative.

Other inputs: LH_APP_DIR (the install folder, default: this file's parent's
parent), LH_OLD_DIR (for olddb / defaults), LABHUB_GITHUB_TOKEN (overrides
the saved token for check, like the server does).
"""
import json
import os
import re
import sys
import tempfile

DEFAULT_REPO = "richard-0417/lab-hub"
DEFAULT_BRANCH = "data"
# keys of the old pFLARES-tracker dashboard that no longer mean anything
OBSOLETE = ("data_dir", "csv_glob", "monitor_points", "stale_seconds",
            "tracker_cmd", "tracker_display", "tracker_log")
# Content of the blob that "check" creates to prove write access. Blobs are
# content-addressed, so every run creates the same unreferenced blob: no
# branch, file or commit changes.
PROBE_BLOB = "lab-hub install-pi.sh write-access check\n"
_ORIGIN_RE = re.compile(r"github\.com[:/]+([A-Za-z0-9-]+)/([A-Za-z0-9._-]+?)(?:\.git)?/*$", re.I)
# a pages_url this helper wrote earlier (so it may replace or clear it)
_GENERATED_PAGES_RE = re.compile(r"^https://[A-Za-z0-9-]+\.github\.io/[^?#\s]*\?repo=[^&#\s]+$")


def app_dir():
    return os.environ.get("LH_APP_DIR") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(path, required=False):
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:  # noqa: BLE001
        if required:
            sys.stderr.write("%s is not valid JSON (%s). Fix or delete it, then re-run.\n" % (path, exc))
            sys.exit(2)
        sys.stderr.write("note: ignoring unreadable %s (%s)\n" % (path, exc))
        return {}
    if not isinstance(data, dict):
        if required:
            sys.stderr.write("%s must contain a JSON object. Fix or delete it, then re-run.\n" % path)
            sys.exit(2)
        return {}
    return data


def one_line(v):
    return " ".join(str(v).split()) if v is not None else ""


def s(d, k):
    v = d.get(k)
    return v.strip() if isinstance(v, str) else ""


def code_repo_from_origin(origin):
    """'owner/name' of a github.com remote URL (https, ssh or scp form), else ''."""
    m = _ORIGIN_RE.search((origin or "").strip())
    return "%s/%s" % (m.group(1), m.group(2)) if m else ""


def pages_base(repo):
    """GitHub Pages address of a repo's project site (or the user site)."""
    owner, name = repo.split("/", 1)
    host = "%s.github.io" % owner.lower()
    if name.lower() == host:
        return "https://%s/" % host
    return "https://%s/%s/" % (host, name)


def pages_urls(origin, board_repo):
    """-> (address to print, value for config.json "pages_url").

    The Pages site is published from the CODE repo (the git origin). In the
    normal single-repo setup the board is in that same repo, so the stored
    value is "" (the server derives https://<owner>.github.io/<repo>/). Only
    when the board lives in a separate data repo is the address stored
    explicitly, with ?repo=<board repo> so a new browser's connect dialog is
    pre-filled with the right repo.
    """
    code = code_repo_from_origin(origin)
    if code:
        base = pages_base(code)
        if board_repo and board_repo.lower() != code.lower():
            url = base + "?repo=" + board_repo
            return url, url
        return base, ""
    return (pages_base(board_repo) if board_repo else ""), ""


def write_config(cfg_path, cfg):
    data = json.dumps(cfg, indent=2, ensure_ascii=False) + "\n"
    folder = os.path.dirname(cfg_path) or "."
    fd, tmp = tempfile.mkstemp(prefix="config.json.tmp-", dir=folder)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(data)
        os.replace(tmp, cfg_path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    os.chmod(cfg_path, 0o600)


# --------------------------------------------------------------------------- #
# GitHub
# --------------------------------------------------------------------------- #
def _gh(api, token, method, path, body=None):
    """-> (status, parsed JSON or {}, headers). Raises on network errors."""
    import urllib.error
    import urllib.request

    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(api + path, data=data, method=method, headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "lab-hub-install",
    })
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            status, raw, headers = r.status, r.read(), r.headers
    except urllib.error.HTTPError as e:
        status, raw, headers = e.code, e.read(), e.headers
    try:
        parsed = json.loads(raw.decode("utf-8")) if raw else {}
    except ValueError:
        parsed = {}
    return status, (parsed if isinstance(parsed, dict) else {}), headers


def _message(body):
    return one_line(body.get("message") or "")[:200]


def _rate_limited(status, body, headers):
    if status == 429:
        return True
    if status != 403:
        return False
    return str(headers.get("x-ratelimit-remaining", "")) == "0" or "rate limit" in _message(body).lower()


def probe_write(api, token, repo):
    """Can the token write to ``repo``? -> "yes" | "no" | "empty" | "unknown: <why>".

    POST /git/blobs needs Contents: write and only creates an unreferenced
    blob (always the same one), so it changes no branch, file or history. It
    cannot succeed for a read-only token, so "yes" is never a false positive.
    """
    status, body, headers = _gh(api, token, "POST", "/repos/%s/git/blobs" % repo,
                                {"content": PROBE_BLOB, "encoding": "utf-8"})
    if status in (200, 201):
        return "yes"
    if _rate_limited(status, body, headers):
        return "unknown: GitHub rate limit reached"
    if status in (403, 404):
        return "no"
    if status == 409 and "empty" in _message(body).lower():
        return "empty"
    return "unknown: GitHub answered HTTP %d %s" % (status, _message(body))


def check(cur, origin):
    """Print OK / PROBLEM / WARNING / NOTE lines about the saved token.

    WARNING is only for the optional two-repo setup (a data-repo token that can
    also write the code repo). In the normal single-repo setup a token that can
    write the board can push code too; that gets one plain NOTE."""
    repo = s(cur, "github_repo")
    token = os.environ.get("LABHUB_GITHUB_TOKEN") or s(cur, "github_token")
    token = "".join(token.split())
    api = (s(cur, "github_api") or "https://api.github.com").rstrip("/")
    if not repo or not token:
        return
    try:
        status, body, headers = _gh(api, token, "GET", "/repos/" + repo)
    except Exception as e:  # noqa: BLE001
        print("NOTE: could not reach GitHub to check the token (%s); skipping" % e.__class__.__name__)
        return
    if status == 401:
        print("PROBLEM: GitHub rejected the token (typo, expired or revoked?)")
        return
    if status == 404:
        print("PROBLEM: %s not found, or the token wasn't given access to it" % repo)
        return
    if status != 200:
        if _rate_limited(status, body, headers):
            print("NOTE: GitHub rate limit reached; could not check the token. Re-run later.")
        else:
            print("PROBLEM: GitHub answered HTTP %d for %s %s" % (status, repo, _message(body)))
        return
    vis = "private" if body.get("private") else "public"

    # Reading proves little: every fine-grained token can read every public
    # repo, and Contents: Read-only can read a private one too. Test writing.
    try:
        can = probe_write(api, token, repo)
    except Exception as e:  # noqa: BLE001
        can = "unknown: %s" % e.__class__.__name__
    if can == "yes":
        print("OK: the token can read and write %s (%s repo)" % (repo, vis))
    elif can == "no":
        print("PROBLEM: the token can read %s but can't write to it. Edit the token: "
              "'Only select repositories' must include %s, and Repository permissions "
              "-> Contents must be 'Read and write'." % (repo, repo.split("/", 1)[1]))
    elif can == "empty":
        print("PROBLEM: %s has no commits yet. Push the code and the data branch to it "
              "first (README: One-time GitHub setup)." % repo)
        return
    else:
        print("NOTE: the token can read %s (%s repo), but write access could not be "
              "confirmed (%s). If the sync pill turns red later, check the token has "
              "Contents: Read and write." % (repo, vis, can.split(": ", 1)[-1]))

    code = code_repo_from_origin(origin)
    single = bool(code) and code.lower() == repo.lower()
    check_branch(api, token, repo, s(cur, "github_branch") or DEFAULT_BRANCH, single)

    if not code:
        return
    if single:
        # The normal setup: one repo, main = code, data = board.json. GitHub
        # can't limit a token to one branch, so a board token can push to main
        # too, and the updater installs main. That is the accepted trust
        # model; say it once, plainly (README: optional hardening).
        if can == "yes":
            print("NOTE: Single-repo setup: this token can also push code to %s, which this Pi "
                  "installs automatically. Only give tokens to people you trust." % repo)
        return
    # Optional two-repo setup: the point of a separate data repo is that board
    # tokens can't change the code this Pi runs or the Pages site, so a token
    # that can still write the code repo defeats it.
    try:
        can_code = probe_write(api, token, code)
    except Exception:  # noqa: BLE001
        return
    if can_code == "yes":
        print("WARNING: this token can also write to the code repo %s. Anyone who has it can "
              "change the code this Pi runs and the Pages site, which defeats the separate "
              "data repo. Edit the token so 'Only select repositories' lists only %s."
              % (code, repo))
    elif can_code == "no":
        print("OK: the token can't change the code repo %s (good)" % code)


def check_branch(api, token, repo, branch, single):
    """Say so when the board branch doesn't exist yet. The first sync (Pi or
    browser) then creates it by itself as an orphan branch holding only an
    empty board.json, so nothing breaks; but in the single-repo setup the
    owner normally prepared that branch locally, and once Lab Hub has created
    its own, the prepared one can only be pushed with --force."""
    from urllib.parse import quote

    try:
        status, _body, _headers = _gh(api, token, "GET",
                                      "/repos/%s/git/ref/heads/%s" % (repo, quote(branch, safe="/")))
    except Exception:  # noqa: BLE001
        return
    if status != 404:
        return
    if single:
        print("PROBLEM: %s has no '%s' branch yet. Lab Hub's first sync creates it "
              "automatically as an empty board (no code in it). If you prepared the "
              "'%s' branch on your computer, push it first (git push origin %s); once "
              "Lab Hub has created its own, yours can only be pushed with --force."
              % (repo, branch, branch, branch))
    else:
        print("NOTE: %s has no '%s' branch yet; the first sync creates it as an empty "
              "board." % (repo, branch))


# --------------------------------------------------------------------------- #
# old install
# --------------------------------------------------------------------------- #
def copy_old_db(cur, old, old_dir, folder):
    """Copy the old SQLite file next to this install so the app imports it."""
    src = old_path(old_dir, s(old, "db_path")) or os.path.join(old_dir, "labhub.db")
    dst = s(cur, "db_path") or "labhub.db"
    if not os.path.isabs(dst):
        dst = os.path.join(folder, dst)
    if not os.path.exists(src):
        print("no old database found at %s; nothing to import" % src)
        return
    if os.path.exists(dst):
        print("%s already exists here; not overwriting it (delete it first to re-import)" % dst)
        return
    import shutil
    import sqlite3
    tmp = dst + "-copying"
    try:
        con = sqlite3.connect(src)
        try:
            counts = []
            for table in ("tasks", "requests", "notes"):
                try:
                    n = con.execute("SELECT COUNT(*) FROM %s" % table).fetchone()[0]
                except sqlite3.Error:
                    n = 0
                counts.append("%d %s" % (n, table))
            if os.path.exists(tmp):
                os.unlink(tmp)
            dest = sqlite3.connect(tmp)
            try:
                con.backup(dest)       # consistent copy, includes the WAL
            finally:
                dest.close()
        finally:
            con.close()
        os.replace(tmp, dst)
        print("copied %s (%s)" % (src, ", ".join(counts)))
    except Exception as exc:  # noqa: BLE001
        if os.path.exists(tmp):
            os.unlink(tmp)
        shutil.copy2(src, dst)
        if os.path.exists(src + "-wal"):
            shutil.copy2(src + "-wal", dst + "-wal")
        print("copied %s as a plain file (sqlite said: %s)" % (src, exc))
    print("its tasks, requests and notes are imported the first time Lab Hub starts")


def old_path(old_dir, value):
    """Resolve a path from the old config relative to the old install."""
    if not value or not isinstance(value, str):
        return ""
    if value.startswith(("http://", "https://")) or os.path.isabs(value):
        return value
    return os.path.normpath(os.path.join(old_dir, value))


# --------------------------------------------------------------------------- #
def main(argv):
    if len(argv) != 2:
        sys.stderr.write("usage: install_helper.py show|write|olddb|port|pages|check\n")
        return 2
    mode = argv[1]
    folder = app_dir()
    old_dir = os.environ.get("LH_OLD_DIR") or ""
    origin = os.environ.get("LH_ORIGIN") or ""
    cfg_path = os.path.join(folder, "config.json")
    cur = load(cfg_path, required=True)
    old = load(os.path.join(old_dir, "config.json")) if old_dir else {}

    if mode == "show":
        name = s(cur, "name") or s(cur, "subgroup_name") or s(old, "name") or s(old, "subgroup_name") or "Lab Hub"
        repo = cur["github_repo"] if isinstance(cur.get("github_repo"), str) else DEFAULT_REPO
        ics = s(cur, "calendar_ics") or old_path(old_dir, s(old, "calendar_ics"))
        print(one_line(name))
        print(one_line(repo))
        print(one_line(ics))
        print("1" if s(cur, "github_token") else "0")

    elif mode == "write":
        cfg = dict(cur)
        for k in OBSOLETE:
            cfg.pop(k, None)
        cfg.pop("subgroup_name", None)          # replaced by "name"
        repo = os.environ["LH_REPO"]
        out = {"name": os.environ["LH_NAME"], "github_repo": repo}
        action = os.environ.get("LH_TOKEN_ACTION", "keep")
        if action == "set":
            out["github_token"] = os.environ.get("LH_TOKEN", "")
        elif action == "clear":
            out["github_token"] = ""
        out["calendar_ics"] = os.environ["LH_ICS"]
        if "calendar_max_events" not in cfg and isinstance(old.get("calendar_max_events"), int):
            out["calendar_max_events"] = old["calendar_max_events"]
        # pages_url: only touch it when it is empty or one we generated before,
        # so an address set by hand (e.g. a custom domain) is kept.
        current = s(cur, "pages_url")
        if not current or _GENERATED_PAGES_RE.match(current):
            stored = pages_urls(origin, repo)[1]
            if stored or current:
                out["pages_url"] = stored
        # new keys first on a fresh file; existing files keep their key order
        merged = dict(out) if not cur else cfg
        merged.update(out)
        write_config(cfg_path, merged)

    elif mode == "olddb":
        copy_old_db(cur, old, old_dir, folder)

    elif mode == "port":
        try:
            print(int(cur.get("port") or 8000))
        except Exception:  # noqa: BLE001
            print(8000)

    elif mode == "pages":
        url = s(cur, "pages_url") or pages_urls(origin, s(cur, "github_repo"))[0]
        if url:
            print(url)

    elif mode == "check":
        check(cur, origin)

    else:
        sys.stderr.write("unknown mode %r\n" % mode)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
