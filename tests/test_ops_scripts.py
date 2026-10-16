"""Tests for the deployment scripts (scripts/, systemd/, kiosk.sh, workflow).

* scripts/install_helper.py: the token check (read AND write access, and a
  warning when a board token can also write the code repo) against a small
  fake GitHub, plus the pages_url it stores for a separate data repo.
* scripts/update.sh: run the way lab-hub-update.service runs it (a copy
  outside the checkout, "as root" through PATH shims) against a real git
  origin, and check it never installs pulled systemd units or runs a pulled
  update.sh.
* kiosk.sh picks the port like the server does; the workflow and unit files
  have the expected shape.

Only stdlib; runs on Python 3.9+. Needs git and bash.
"""
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HELPER = os.path.join(ROOT, "scripts", "install_helper.py")
UPDATE_SH = os.path.join(ROOT, "scripts", "update.sh")
INSTALL_SH = os.path.join(ROOT, "scripts", "install-pi.sh")
TOKEN = "github_pat_TESTSECRET0123456789"

sys.path.insert(0, ROOT)
from app.config import load_config  # noqa: E402  (stdlib-only module)


def _clean_env(**extra):
    env = dict(os.environ)
    for k in list(env):
        if k.startswith(("LABHUB_", "LH_")):
            del env[k]
    env.update(extra)
    return env


# --------------------------------------------------------------------------- #
# a tiny fake GitHub API
# --------------------------------------------------------------------------- #
class FakeGitHub(object):
    """Answers (method, path) from ``routes``; everything else is a 404."""

    def __init__(self):
        self.routes = {}
        self.requests = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _answer(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n) if n else b""
                fake.requests.append({
                    "method": self.command, "path": self.path,
                    "auth": self.headers.get("Authorization"),
                    "body": json.loads(body.decode("utf-8")) if body else None,
                })
                status, payload, headers = fake.routes.get(
                    (self.command, self.path), (404, {"message": "Not Found"}, {}))
                raw = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                for k, v in headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(raw)

            do_GET = do_POST = _answer

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d" % self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def repo(self, name, private=False):
        self.routes[("GET", "/repos/" + name)] = (200, {"full_name": name, "private": private}, {})

    def blobs(self, name, status, message="", headers=None):
        payload = {"sha": "abc", "url": "x"} if status == 201 else {"message": message}
        self.routes[("POST", "/repos/%s/git/blobs" % name)] = (status, payload, headers or {})


class InstallHelperCheckTest(unittest.TestCase):
    DATA = "o/lab-hub-data"
    CODE = "o/lab-hub"

    def setUp(self):
        self.gh = FakeGitHub()
        self.addCleanup(self.gh.close)
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)

    def run_check(self, repo=None, origin="https://github.com/o/lab-hub.git"):
        with open(os.path.join(self.dir, "config.json"), "w", encoding="utf-8") as f:
            json.dump({"github_repo": repo or self.DATA, "github_token": TOKEN,
                       "github_api": self.gh.url}, f)
        p = subprocess.run([sys.executable, HELPER, "check"], capture_output=True, text=True, timeout=60,
                           env=_clean_env(LH_APP_DIR=self.dir, LH_ORIGIN=origin))
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertNotIn(TOKEN, p.stdout + p.stderr)
        return p.stdout

    def test_read_and_write_ok_and_code_repo_not_writable(self):
        self.gh.repo(self.DATA, private=True)
        self.gh.blobs(self.DATA, 201)
        self.gh.blobs(self.CODE, 403, "Resource not accessible by personal access token")
        out = self.run_check()
        self.assertIn("OK: the token can read and write o/lab-hub-data (private repo)", out)
        self.assertIn("OK: the token can't change the code repo o/lab-hub", out)
        self.assertNotIn("PROBLEM", out)
        self.assertNotIn("WARNING", out)
        probes = [r for r in self.gh.requests if r["method"] == "POST"]
        self.assertTrue(probes)
        for r in probes:
            self.assertEqual(r["auth"], "Bearer " + TOKEN)
            self.assertEqual(r["body"]["encoding"], "utf-8")
            self.assertTrue(r["body"]["content"])

    def test_read_only_token_is_a_problem_not_ok(self):
        # A public repo is readable by any token, and Contents: Read-only can
        # read a private one too: GET alone must not be reported as OK.
        self.gh.repo(self.DATA)
        self.gh.blobs(self.DATA, 403, "Resource not accessible by personal access token")
        out = self.run_check()
        self.assertIn("PROBLEM: the token can read o/lab-hub-data but can't write to it", out)
        self.assertIn("Read and write", out)
        self.assertNotIn("OK: the token can read and write", out)

    def test_repo_not_selected_404_on_write(self):
        self.gh.repo(self.DATA)
        self.gh.blobs(self.DATA, 404, "Not Found")
        out = self.run_check()
        self.assertIn("PROBLEM: the token can read o/lab-hub-data but can't write", out)

    def test_unclear_answers_are_never_ok(self):
        for status, message, headers in (
                (403, "API rate limit exceeded", {"x-ratelimit-remaining": "0"}),
                (500, "boom", {}),
                (422, "Invalid request", {})):
            self.gh.repo(self.DATA)
            self.gh.blobs(self.DATA, status, message, headers)
            out = self.run_check()
            self.assertIn("NOTE: the token can read o/lab-hub-data", out, status)
            self.assertIn("could not be confirmed", out, status)
            self.assertNotIn("OK: the token can read and write", out, status)
            self.assertNotIn("PROBLEM", out, status)

    def test_empty_data_repo(self):
        self.gh.repo(self.DATA)
        self.gh.blobs(self.DATA, 409, "Git Repository is empty.")
        out = self.run_check()
        self.assertIn("PROBLEM: o/lab-hub-data has no commits yet", out)

    def test_token_that_can_write_the_code_repo_is_flagged(self):
        self.gh.repo(self.DATA)
        self.gh.blobs(self.DATA, 201)
        self.gh.blobs(self.CODE, 201)
        out = self.run_check()
        self.assertIn("OK: the token can read and write o/lab-hub-data", out)
        self.assertIn("WARNING: this token can also write to the code repo o/lab-hub", out)

    def test_board_in_the_code_repo_is_flagged(self):
        self.gh.repo(self.CODE)
        self.gh.blobs(self.CODE, 201)
        out = self.run_check(repo=self.CODE)
        self.assertIn("WARNING: the board lives in the code repo o/lab-hub itself", out)

    def test_rejected_and_not_found(self):
        self.gh.routes[("GET", "/repos/" + self.DATA)] = (401, {"message": "Bad credentials"}, {})
        self.assertIn("PROBLEM: GitHub rejected the token", self.run_check())
        del self.gh.routes[("GET", "/repos/" + self.DATA)]
        out = self.run_check()
        self.assertIn("PROBLEM: o/lab-hub-data not found", out)
        self.assertFalse([r for r in self.gh.requests if r["method"] == "POST"])

    def test_unreachable_github(self):
        self.gh.close()
        out = self.run_check()
        self.assertIn("could not reach GitHub", out)


class InstallHelperPagesTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.cfg = os.path.join(self.dir, "config.json")

    def helper(self, mode, **env):
        base = {"LH_APP_DIR": self.dir, "LH_NAME": "Lab", "LH_ICS": "", "LH_TOKEN_ACTION": "keep"}
        base.update(env)
        p = subprocess.run([sys.executable, HELPER, mode], capture_output=True, text=True, timeout=30,
                           env=_clean_env(**base))
        self.assertEqual(p.returncode, 0, p.stderr)
        return p.stdout

    def saved(self):
        with open(self.cfg, encoding="utf-8") as f:
            return json.load(f)

    def test_separate_data_repo_stores_the_code_repos_pages_url(self):
        origin = "https://github.com/richard-0417/lab-hub.git"
        self.helper("write", LH_REPO="richard-0417/lab-hub-data", LH_ORIGIN=origin,
                    LH_TOKEN_ACTION="set", LH_TOKEN=TOKEN)
        want = "https://richard-0417.github.io/lab-hub/?repo=richard-0417/lab-hub-data"
        self.assertEqual(self.saved()["pages_url"], want)
        self.assertEqual(stat.S_IMODE(os.stat(self.cfg).st_mode), 0o600)
        # the server (kiosk footer) uses it as is, not github.io/lab-hub-data/
        cfg = load_config(base_dir=self.dir, config_path=self.cfg, environ={})
        self.assertEqual(cfg["pages_url"], want)
        self.assertEqual(self.helper("pages", LH_ORIGIN=origin).strip(), want)
        show = self.helper("show")
        self.assertNotIn(TOKEN, show)
        self.assertEqual(show.splitlines()[1:], ["richard-0417/lab-hub-data", "", "1"])

        # switching the board back to the code repo clears the stored URL,
        # so the server derives https://<owner>.github.io/<repo>/ again
        self.helper("write", LH_REPO="richard-0417/lab-hub", LH_ORIGIN=origin)
        self.assertEqual(self.saved()["pages_url"], "")
        self.assertEqual(load_config(base_dir=self.dir, config_path=self.cfg, environ={})["pages_url"],
                         "https://richard-0417.github.io/lab-hub/")
        self.assertEqual(self.helper("pages", LH_ORIGIN=origin).strip(), "https://richard-0417.github.io/lab-hub/")

    def test_ssh_origin_and_owner_case(self):
        self.helper("write", LH_REPO="Richard-0417/lab-hub-data", LH_ORIGIN="git@github.com:Richard-0417/lab-hub.git")
        self.assertEqual(self.saved()["pages_url"],
                         "https://richard-0417.github.io/lab-hub/?repo=Richard-0417/lab-hub-data")

    def test_hand_set_pages_url_is_kept(self):
        with open(self.cfg, "w", encoding="utf-8") as f:
            json.dump({"pages_url": "https://lab.example.org/board/"}, f)
        self.helper("write", LH_REPO="richard-0417/lab-hub-data", LH_ORIGIN="https://github.com/richard-0417/lab-hub")
        self.assertEqual(self.saved()["pages_url"], "https://lab.example.org/board/")

    def test_no_origin_writes_no_pages_url(self):
        self.helper("write", LH_REPO="richard-0417/lab-hub-data", LH_ORIGIN="")
        self.assertNotIn("pages_url", self.saved())

    def test_default_repo_is_the_data_repo(self):
        self.assertEqual(self.helper("show").splitlines()[1], "richard-0417/lab-hub-data")


# --------------------------------------------------------------------------- #
# scripts/update.sh against a real git origin
# --------------------------------------------------------------------------- #
def _git(cwd, *args):
    p = subprocess.run(["git"] + list(args), cwd=cwd, capture_output=True, text=True, timeout=60)
    if p.returncode != 0:
        raise AssertionError("git %s failed: %s" % (" ".join(args), p.stderr))
    return p.stdout.strip()


def _write(path, text, mode=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    if mode is not None:
        os.chmod(path, mode)


@unittest.skipUnless(shutil.which("git") and shutil.which("bash"), "needs git and bash")
class UpdateScriptTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        gitcfg = os.path.join(self.tmp, "gitconfig")
        _write(gitcfg, "")
        # a predictable git: no user hooks/signing, a fixed identity
        self.git_env = {
            "GIT_CONFIG_GLOBAL": gitcfg, "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.org",
            "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.org",
        }
        os.environ.update(self.git_env)
        self.addCleanup(self._restore_env)

        self.origin = os.path.join(self.tmp, "origin.git")
        self.dev = os.path.join(self.tmp, "dev")
        self.pi = os.path.join(self.tmp, "pi")
        _git(self.tmp, "init", "--bare", "-q", self.origin)
        _git(self.tmp, "--git-dir", self.origin, "symbolic-ref", "HEAD", "refs/heads/main")
        os.makedirs(self.dev)
        _git(self.dev, "init", "-q")
        _git(self.dev, "checkout", "-q", "-b", "main")
        os.makedirs(os.path.join(self.dev, "scripts"))
        shutil.copy(UPDATE_SH, os.path.join(self.dev, "scripts", "update.sh"))
        shutil.copytree(os.path.join(ROOT, "systemd"), os.path.join(self.dev, "systemd"))
        _write(os.path.join(self.dev, "requirements.txt"), "fastapi\n")
        _write(os.path.join(self.dev, "app.txt"), "v1\n")
        _write(os.path.join(self.dev, ".gitignore"), ".venv/\n")
        _git(self.dev, "add", "-A")
        _git(self.dev, "commit", "-q", "-m", "v1")
        _git(self.dev, "remote", "add", "origin", self.origin)
        _git(self.dev, "push", "-q", "origin", "main")
        _git(self.tmp, "clone", "-q", self.origin, self.pi)
        # deps already installed for this requirements.txt
        os.makedirs(os.path.join(self.pi, ".venv"))
        _write(os.path.join(self.pi, ".venv", ".labhub-requirements"),
               _git(self.pi, "hash-object", "requirements.txt") + "\n")

        # what install-pi.sh installs: a copy outside the checkout
        self.installed = os.path.join(self.tmp, "usr-local-lib-lab-hub", "update.sh")
        os.makedirs(os.path.dirname(self.installed))
        shutil.copy(UPDATE_SH, self.installed)

        # "root": id -u says 0; runuser/systemctl/install are recorded, not run as root
        self.shims = os.path.join(self.tmp, "shims")
        self.calls = os.path.join(self.tmp, "calls.log")
        real_id = shutil.which("id")
        _write(os.path.join(self.shims, "id"),
               '#!/bin/bash\nif [ "$#" = 1 ] && [ "$1" = "-u" ]; then echo 0; exit 0; fi\nexec %s "$@"\n' % real_id,
               0o755)
        _write(os.path.join(self.shims, "runuser"),
               '#!/bin/bash\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done; shift\nexec "$@"\n', 0o755)
        for name in ("systemctl", "install"):
            _write(os.path.join(self.shims, name),
                   '#!/bin/bash\necho "%s $*" >> "%s"\nexit 0\n' % (name, self.calls), 0o755)

    def _restore_env(self):
        for k in self.git_env:
            os.environ.pop(k, None)

    def push_change(self, files, msg):
        for rel, text in files.items():
            _write(os.path.join(self.dev, rel), text)
        _git(self.dev, "add", "-A")
        _git(self.dev, "commit", "-q", "-m", msg)
        _git(self.dev, "push", "-q", "origin", "main")
        return _git(self.dev, "rev-parse", "HEAD")

    def run_update(self, script, as_root=True, app_dir=True):
        env = _clean_env(**self.git_env)
        env.pop("DISPLAY", None)
        if as_root:
            env["PATH"] = self.shims + os.pathsep + env.get("PATH", "")
            env["LABHUB_USER"] = subprocess.run(["id", "-un"], capture_output=True, text=True).stdout.strip()
        if app_dir:
            env["LABHUB_APP_DIR"] = self.pi
        p = subprocess.run(["bash", script], capture_output=True, text=True, timeout=120, env=env, cwd=self.tmp)
        return p.returncode, p.stdout + p.stderr

    def calls_log(self):
        if not os.path.exists(self.calls):
            return ""
        with open(self.calls, encoding="utf-8") as f:
            return f.read()

    def test_root_updater_never_installs_or_runs_pulled_root_code(self):
        marker = os.path.join(self.tmp, "PWNED")
        evil_unit = "[Service]\nUser=root\nExecStartPre=/bin/sh -c 'touch %s'\nExecStart=/bin/true\n" % marker
        with open(UPDATE_SH, encoding="utf-8") as f:
            evil_updater = f.read().replace("main \"$@\"\nexit $?", "touch '%s'\nmain \"$@\"\nexit $?" % marker)
        self.assertIn(marker, evil_updater)
        new_head = self.push_change({
            "systemd/lab-hub.service": evil_unit,
            "scripts/update.sh": evil_updater,
            "app.txt": "v2\n",
        }, "v2")

        rc, out = self.run_update(self.installed)
        self.assertEqual(rc, 0, out)
        self.assertEqual(_git(self.pi, "rev-parse", "HEAD"), new_head)       # code did update
        calls = self.calls_log()
        self.assertIn("systemctl restart lab-hub.service", calls)
        self.assertNotIn("daemon-reload", calls)                            # no unit refresh
        self.assertNotIn("install ", calls)                                 # nothing installed as root
        self.assertIn("install-pi.sh", out)                                 # tells you what to do
        self.assertNotIn("running the checkout's own update.sh as root", out)

        # the next timer run still uses the root-owned copy, not the pulled one
        rc, out = self.run_update(self.installed)
        self.assertEqual(rc, 0, out)
        self.assertFalse(os.path.exists(marker), "root ran the update.sh it had pulled")

    def test_up_to_date_and_local_edits(self):
        rc, out = self.run_update(self.installed)
        self.assertEqual(rc, 0, out)
        self.assertNotIn("restart", self.calls_log())
        self.push_change({"app.txt": "v2\n"}, "v2")
        _write(os.path.join(self.pi, "app.txt"), "edited on the pi\n")
        rc, out = self.run_update(self.installed)
        self.assertEqual(rc, 0, out)
        self.assertIn("tracked files were edited locally", out)
        self.assertNotIn("restart", self.calls_log())

    def test_checkout_copy_run_as_root_still_works_but_says_so(self):
        self.push_change({"app.txt": "v2\n"}, "v2")
        rc, out = self.run_update(os.path.join(self.pi, "scripts", "update.sh"), app_dir=False)
        self.assertEqual(rc, 0, out)
        self.assertIn("running the checkout's own update.sh as root", out)
        self.assertIn("systemctl restart lab-hub.service", self.calls_log())

    def test_by_hand_as_the_install_user(self):
        head = self.push_change({"systemd/lab-hub.service": "# changed\n"}, "units")
        rc, out = self.run_update(os.path.join(self.pi, "scripts", "update.sh"), as_root=False, app_dir=False)
        self.assertEqual(rc, 0, out)
        self.assertEqual(_git(self.pi, "rev-parse", "HEAD"), head)
        self.assertIn("Load it with: sudo systemctl restart lab-hub", out)
        self.assertIn("install-pi.sh", out)
        self.assertEqual(self.calls_log(), "")


# --------------------------------------------------------------------------- #
# kiosk.sh port, unit files, workflow, shell syntax
# --------------------------------------------------------------------------- #
@unittest.skipUnless(os.path.exists(os.path.join(ROOT, ".venv", "bin", "python")) and shutil.which("bash"),
                     "needs the project's .venv")
class KioskPortTest(unittest.TestCase):
    def test_kiosk_uses_the_servers_port_resolution(self):
        class Ok(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Ok)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        port = httpd.server_address[1]

        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, True)
        cfg = os.path.join(tmp, "other-config.json")
        _write(cfg, json.dumps({"port": port}))
        bindir = os.path.join(tmp, "bin")
        _write(os.path.join(bindir, "chromium-browser"), '#!/bin/bash\necho "ARGS: $*"\n', 0o755)
        env = _clean_env(LABHUB_CONFIG=cfg, HOME=tmp, XDG_RUNTIME_DIR=tmp, XDG_CONFIG_HOME=os.path.join(tmp, "cfg"),
                         PATH=bindir + os.pathsep + os.environ.get("PATH", ""))
        env.pop("DISPLAY", None)
        p = subprocess.run(["bash", os.path.join(ROOT, "kiosk.sh")], capture_output=True, text=True,
                           timeout=60, env=env)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("--app=http://localhost:%d" % port, p.stdout)


class UnitAndWorkflowFilesTest(unittest.TestCase):
    def read(self, rel):
        with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
            return f.read()

    def test_update_service_runs_the_root_owned_copy(self):
        unit = self.read("systemd/lab-hub-update.service")
        execs = [l for l in unit.splitlines() if l.startswith("ExecStart=")]
        self.assertEqual(execs, ["ExecStart=/bin/bash /usr/local/lib/lab-hub/update.sh"])
        self.assertIn('Environment="LABHUB_APP_DIR=__APP_DIR__"', unit)
        install = self.read("scripts/install-pi.sh")
        self.assertIn('UPDATER_DIR="/usr/local/lib/lab-hub"', install)
        self.assertIn('sudo install -m 755 -o root -g root "$APP_DIR/scripts/update.sh" "$UPDATER_DIR/update.sh"',
                      install)

    def test_update_sh_never_installs_units(self):
        src = self.read("scripts/update.sh")
        self.assertNotIn("/etc/systemd/system", src)
        self.assertNotIn("daemon-reload", src)

    def test_kiosk_restart_hint_survives_closing_the_terminal(self):
        install = self.read("scripts/install-pi.sh")
        self.assertIn("setsid -f $KIOSK_CMD", install)
        self.assertNotIn("$KIOSK_CMD &)", install)
        readme = self.read("README.md")
        self.assertTrue("setsid -f ~/lab-hub/kiosk.sh" in readme, "README: restart the kiosk with setsid -f")
        self.assertFalse("kiosk.sh &" in readme, "README: 'kiosk.sh &' dies with its terminal")

    def test_pages_workflow_uses_node24_action_majors(self):
        wf = self.read(".github/workflows/pages.yml")
        minimum = {"actions/checkout": 5, "actions/configure-pages": 6,
                   "actions/upload-pages-artifact": 5, "actions/deploy-pages": 5}
        found = dict((m.group(1), int(m.group(2))) for m in re.finditer(r"uses:\s*([\w./-]+)@v(\d+)", wf))
        self.assertEqual(set(found), set(minimum))
        for action, major in minimum.items():
            self.assertGreaterEqual(found[action], major, action)

    def test_example_config_points_at_the_data_repo(self):
        cfg = load_config(config_path=os.path.join(ROOT, "config.example.json"), environ={})
        self.assertEqual(cfg["github_repo"], "richard-0417/lab-hub-data")
        self.assertEqual(cfg["pages_url"], "https://richard-0417.github.io/lab-hub/?repo=richard-0417/lab-hub-data")

    @unittest.skipUnless(shutil.which("bash"), "needs bash")
    def test_shell_syntax_and_help(self):
        for rel in ("run.sh", "kiosk.sh", "scripts/install-pi.sh", "scripts/update.sh", "Start Lab Hub.command"):
            p = subprocess.run(["bash", "-n", os.path.join(ROOT, rel)], capture_output=True, text=True)
            self.assertEqual(p.returncode, 0, "%s: %s" % (rel, p.stderr))
        p = subprocess.run(["bash", INSTALL_SH, "--help"], capture_output=True, text=True, timeout=30,
                           env=_clean_env())
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("richard-0417/lab-hub-data", p.stdout)
        self.assertIn("--no-service", p.stdout)
        self.assertFalse(p.stdout.startswith("!"))


if __name__ == "__main__":
    unittest.main()
