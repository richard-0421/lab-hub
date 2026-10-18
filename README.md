# Lab Hub

A shared lab dashboard: a **task board** first, plus item requests, team notes,
the Outlook calendar and a big clock. It runs on the lab Raspberry Pi
(fullscreen on its touch screen) and the exact same page is published on
**GitHub Pages**, so anyone on the team can see and edit the board from a
phone or laptop, anywhere. The board itself is one JSON file, `board.json`,
on the `data` branch of the same GitHub repo; both sides read and write it.

- **Kiosk**: the Pi's screen shows `http://localhost:8000` fullscreen in Chromium.
- **Lab network**: any laptop/phone on the lab LAN can open `http://<pi-ip>:8000` (no login).
- **Anywhere**: <https://richard-0417.github.io/lab-hub/>. Paste a GitHub token once per browser to edit.

What's on the board:

- **Tasks**: a kanban board (To do / In progress / Done). Drag cards to reorder or move
  them between columns; set a priority, due date, assignee and tags; **Undo** for
  mistakes. Quick-add understands a short syntax (see [Quick-add](#quick-add)).
- **Item requests**: what to order, how many, who asked, and new / ordered / received.
- **Notes**: a pin-board of short colored notes.
- **Calendar**: upcoming events from a published Outlook calendar (read-only).
- **Clock** and a **sync pill** that shows whether the board is in sync with GitHub.

The old pFLARES water-level tracker monitor has been removed. The tracker
itself (its own folder and GUI) is unaffected.

---

## How sync works

```
                 richard-0417/lab-hub  (public)
 ┌─────────────────────────────────────────────────────────────┐
 │ branch main  code ──► Actions ──► GitHub Pages ─────────────┼──┐
 │ branch data  board.json  (tasks, requests, notes)           │  │
 └──────┬──────────────────────────▲───────────────────▲───────┘  │
        │ git pull main every      │ sync every ~15 s, │ read/write │
        │ 5 min (anonymous)        │ push ~1 s after   │ via the    │
        ▼                          │ an edit           │ GitHub API │
 ┌─────────────────────────────────┴──┐     ┌──────────┴──────────┐ │
 │ Raspberry Pi: FastAPI + local copy │     │ browsers anywhere   │◄┘
 │ kiosk screen, lab LAN browsers     │     │ (token per browser) │  the page
 └────────────────────────────────────┘     └─────────────────────┘
```

One public repo holds everything. `main` is the code: the Pi runs it and
GitHub Pages publishes it. `data` is a separate *orphan* branch (no shared
history with `main`) that holds only `board.json`. Board commits land on
`data`, so they never trigger a Pages deploy and never show up in the code
history the Pi pulls. Read [Security & privacy](#security--privacy) once:
the board is public, and every board token can also change the code.

Every edit (add, change or delete) is a small **operation**. Each client (the Pi,
or a browser on Pages) keeps the last `board.json` it saw plus a queue of its own
unsent operations. To sync, it fetches the latest file, replays its queued
operations on top and writes the result back. If someone else wrote first,
GitHub refuses the write, so the client fetches again and replays.
Two people editing different tasks never conflict. If both change the same
field, the last write wins. The Pi keeps working offline and catches up when
the network returns.

The full contract (data model, operations, sync algorithm, HTTP API) is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## One-time GitHub setup

You only do this once. Steps 1 to 3 publish the code, the site and the empty
board. Steps 4 and 5 give the Pi and each browser permission to write the board.

### 1. Create the empty repo

Go to <https://github.com/new>:

| field | value |
|---|---|
| Owner / name | **richard-0417 / lab-hub** |
| Visibility | **Public** (GitHub Pages is free for public repos) |
| README, .gitignore, license | **none**: the repo must be empty |

### 2. Push from the Mac

The local repo has two branches. `main` is the code. `data` is an **orphan**
branch that holds only `board.json` (an empty board) and a short README.
Push both, and push `data` **before** you install the Pi:

```bash
cd ~/Desktop/"All the Programs/Ras Dashboard/lab-hub-new"
git remote add origin https://github.com/richard-0417/lab-hub.git
#   (if it says "remote origin already exists":
#    git remote set-url origin https://github.com/richard-0417/lab-hub.git)
git push -u origin main          # code: main becomes the default branch
git push origin data             # the board
```

If Lab Hub ever syncs before `data` was pushed, it creates the branch itself
(as an empty board, never a copy of the code). Your prepared branch could then
only be pushed with `--force`, which is harmless while the board is still
empty.

**Which login to push with.** This push includes `.github/workflows/pages.yml`,
and GitHub only accepts changes to workflow files from a credential that is
allowed to update workflows. Any of these works:

- the GitHub CLI: `brew install gh && gh auth login` (GitHub.com, HTTPS, log in
  with a browser). It includes the workflow permission.
- GitHub Desktop, signed in as richard-0417.
- a *classic* personal access token with the `repo` and `workflow` scopes.

The fine-grained board tokens from step 4 never need the workflow permission.

### 3. Turn on GitHub Pages

In **lab-hub**: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

The workflow `.github/workflows/pages.yml` deploys the `static/` folder on every
push to `main` that touches `static/`. Its first run (from step 2) happened
before Pages was switched on, so open the **Actions** tab → **Deploy to GitHub
Pages** → **Run workflow** (or **Re-run all jobs** on the failed run). After
about a minute the site is live at:

**<https://richard-0417.github.io/lab-hub/>**

### 4. Create tokens (fine-grained personal access tokens)

Open <https://github.com/settings/personal-access-tokens/new> and set:

| field | value |
|---|---|
| Token name | something you'll recognise later, e.g. `lab-hub pi`, `lab-hub mei-laptop` |
| Expiration | about 1 year. Put a reminder in your calendar for the Pi's token |
| Resource owner | **richard-0417** |
| Repository access | **Only select repositories → lab-hub** |
| Permissions → Repository permissions | **Contents: Read and write**. "Metadata: Read-only" is added automatically. Nothing else. |

Click **Generate token** and copy it (`github_pat_…`). GitHub shows it only once.

Make **one token for the Pi and one per trusted person or browser**. That way
you can revoke a single token (Settings → Developer settings → Fine-grained
tokens) without breaking everyone else. Only give tokens to people you trust:
see [Security & privacy](#security--privacy).

When a token expires or is revoked, that client's sync pill turns red with
*"GitHub token rejected (expired or revoked?)"*. Edits keep queuing on that
device and are pushed once it has a new token:

- **Pi:** `cd ~/lab-hub && ./scripts/install-pi.sh`. Press Enter to keep each
  existing answer and paste the new token when asked. The script restarts the
  service.
- **Browser:** click the sync pill → **Settings** and paste the new token.

### 5. Connect a browser

Open **<https://richard-0417.github.io/lab-hub/>**. The first time, a connect
dialog asks for:

- **Your name**: shown on tasks you create and in the board's commit messages
- **Repository** (`richard-0417/lab-hub`), **Branch** (`data`) and **File**
  (`board.json`): already filled in
- **Token**: from step 4

**Connect** checks the token against GitHub before saving it: it reads the
repo, then proves it can write by creating one small unreferenced git object
(always the same one; no branch, file or history changes). If the token can
read but not write, the dialog explains why and asks you to confirm with
**Connect anyway**. If GitHub can't say either way, it connects and shows a
note. **View read-only** opens the board without a token: because the repo is
public, anyone can look, reading GitHub's cached copy of `board.json`, which
can be up to 5 minutes old.

The token is saved in this browser's storage for `richard-0417.github.io` and
sent only to `api.github.com`. Any page served from `richard-0417.github.io`
could read it, so only publish trusted Pages sites under that account, use
**Forget token** (sync pill) on shared computers, and revoke the token on
GitHub if a device is lost.

---

## Security & privacy

Read this once; it's the price of the free, one-repo setup.

- **The board is public.** Anyone can read every task, request and note, and
  their history, on GitHub. Don't put passwords, door codes or anything
  private in the board.
- **Every board token can also change the code.** GitHub tokens can be limited
  to a repo but not to a branch, so a token that can write `data` can also
  push to `main`. Pages publishes `main` within a minute, and the Pi installs it
  within 5 minutes and runs it as a user that can use `sudo`. So **only give
  tokens to people you trust**. Everyone else can still edit on the kiosk or
  from the lab network (`http://<pi-ip>:8000`, no token needed).
- **Revoking**: GitHub → Settings → Developer settings → Fine-grained tokens →
  the token → **Revoke**. Do this for a lost laptop or someone leaving.

Optional hardening, if you want it later:

- **Protect `main` with a ruleset.** In lab-hub: **Settings → Rules →
  Rulesets → New ruleset → New branch ruleset**. Enforcement **Active**,
  target the **default branch**, turn on **Require a pull request before
  merging**, and add **Repository admin** to the bypass list set to **For pull
  requests only**. Board tokens (Contents only) then can't push to `main`,
  because merging a pull request needs the *Pull requests* permission they
  don't have. The `data` branch isn't covered, so syncing keeps working. The
  cost: you land code changes by pushing a branch and merging its pull request
  on GitHub instead of pushing to `main`. (Checked against GitHub's
  documentation, not yet tried on this repo.)
- **Move the board to a separate private repo.** Create an empty private repo
  (e.g. `richard-0417/lab-hub-data`), push the board there
  (`git remote add board https://github.com/richard-0417/lab-hub-data.git &&
  git push -u board data`), make tokens for **that repo only**, run
  `./scripts/install-pi.sh --repo richard-0417/lab-hub-data` on the Pi, and set
  **Repository** to it in each browser's settings (or share
  `https://richard-0417.github.io/lab-hub/?repo=richard-0417/lab-hub-data`,
  which pre-fills a browser's first connect). Then the board is private and a
  board token can't touch the code. The connect dialog and `install-pi.sh`
  warn if such a token can still write `lab-hub`.

---

## Raspberry Pi setup

You need Raspberry Pi OS with a desktop (Bullseye or Bookworm), a network
connection, and these packages (most are preinstalled):
`sudo apt install git python3-venv chromium-browser`. On newer releases the
Chromium package is called `chromium`.

### Fresh install

```bash
git clone --single-branch https://github.com/richard-0417/lab-hub.git ~/lab-hub
cd ~/lab-hub && ./scripts/install-pi.sh
```

The clone is anonymous (the repo is public), and `--single-branch` skips the
board's history on `data`; the Pi reads the board through the API instead.
Don't put a token in the clone's `origin` URL (`install-pi.sh` warns if you
do).

Run the script as your normal desktop user, **not** with `sudo`; it asks for
sudo when it needs it. It asks for the dashboard title, the GitHub repo that
holds the board (default `richard-0417/lab-hub`), the Pi's token (input hidden; leave
it blank to keep the board on the Pi only) and an Outlook `.ics` URL. It is
safe to re-run at any time, for example to change the token or calendar.

It then tests the token against GitHub and prints one of:

- *OK: the token can read and write richard-0417/lab-hub*. To prove the token
  can write, it creates one small unreferenced git blob in the repo (always the
  same one). This changes no branch, file or history.
- a problem: the token was rejected, can't see the repo, or can read but not
  write it. A fine-grained token can always read a public repo, so reading
  alone proves nothing.
- one *NOTE* that this token can also push code to the repo (the trust model
  above), and a *PROBLEM* if the repo has no `data` branch yet (push it first,
  see step 2).
- with the optional separate data repo: a *WARNING* if the token can also
  write the code repo `lab-hub`.

Options: `--repo OWNER/NAME` (or `none`), `--name TEXT`, `--ics URL`,
`--token-file FILE`, `--yes` (no questions), `--no-kiosk`, `--no-service`,
`--from OLD_DIR`. See `./scripts/install-pi.sh --help`.

What it sets up:

| what | where |
|---|---|
| Python virtualenv + fastapi/uvicorn | `~/lab-hub/.venv` |
| settings incl. token (mode 600) | `~/lab-hub/config.json` |
| web server + GitHub sync, starts at boot, restarts on crash | `lab-hub.service` |
| code auto-updater, every 5 min | `lab-hub-update.timer` → `lab-hub-update.service` → `/usr/local/lib/lab-hub/update.sh` (a root-owned copy of `scripts/update.sh`) |
| fullscreen browser at login | `~/.config/autostart/lab-hub-kiosk.desktop` (+ labwc / wayfire autostart entries) |

At the end it runs one sync and prints the LAN address(es) and the Pages link
(the kiosk footer shows the same link). Reboot
(or log out and back in) to start the kiosk.

### Migrating the existing install (the old tarball copy)

The Pi currently runs an old copy in `~/lab-hub` that is not a git clone.
Replace it with a clone and import its data:

```bash
sudo systemctl stop lab-hub
mv ~/lab-hub ~/lab-hub-old
git clone --single-branch https://github.com/richard-0417/lab-hub.git ~/lab-hub
cd ~/lab-hub && ./scripts/install-pi.sh --from ~/lab-hub-old
```

`--from` copies the old `labhub.db`. The first time the new server starts, it
imports the old tasks, requests and notes and pushes them to GitHub. Imported
items have fixed ids such as `t-legacy-12`, and `state/migrated` records that
the import ran, so restarts don't import again. If the Pi is ever set up again
with a fresh `state/` folder, it sees that the board on GitHub already holds
imported items and skips the import, so items deleted since don't come back.
(Only if every imported item has been deleted would it import them again; to
rule that out, delete `~/lab-hub/labhub.db` once the board looks right.) The
script also carries over the old title (`subgroup_name` → `name`) and calendar
URL, and replaces the old service and kiosk autostart entry. Once the board
looks right, you can delete `~/lab-hub-old`. (If the old copy lived somewhere
other than `~/lab-hub`, adjust the paths.)

### Kiosk notes

- `kiosk.sh` waits for the server, then starts Chromium in kiosk mode with a
  dedicated profile (`~/.config/lab-hub-kiosk`), touch-friendly flags (no
  swipe-to-go-back, no pinch-zoom, no translate bar) and incognito, so there is
  no "restore pages" prompt after a power cut. Only one copy runs, even if
  several autostart mechanisms fire. If the server is restarting, the page
  shows *Waiting for the Lab Hub server…* and reconnects by itself.
- **X11** (Bullseye, or Bookworm switched to X11): started via
  `~/.config/autostart`. Screen blanking is turned off with `xset`.
- **Wayland** (Bookworm: wayfire or labwc): started via `~/.config/autostart` and
  also via `~/.config/wayfire.ini` `[autostart]` or `~/.config/labwc/autostart`.
  `xset` does nothing on Wayland. To turn blanking off, run
  `sudo raspi-config` → *Display Options* → *Screen Blanking* → *No*.
- **Bigger or smaller UI** on a high-resolution screen: put
  `--force-device-scale-factor=1.25` in `~/.config/lab-hub-kiosk.flags`.
- **Leave the kiosk**: `Alt+F4`. For a terminal: `Ctrl+Alt+T`, then
  `pkill -f lab-hub-kiosk`. Start it again with
  `setsid -f ~/lab-hub/kiosk.sh >/dev/null 2>&1`, or by logging out and in.
  (Use `setsid -f`: a job started with a plain `&` is killed when you close
  that terminal window.)
- **Stop autostarting**: delete `~/.config/autostart/lab-hub-kiosk.desktop`, the
  line marked `# lab-hub kiosk` in `~/.config/labwc/autostart`, and the
  `lab_hub_kiosk = …` line in `~/.config/wayfire.ini`.
- The kiosk is a shared screen, so it never remembers a person's name. Edits
  made on it are recorded as `lab-pi` (the `client_name` setting).
- Don't edit files from the repo on the Pi itself. Local edits pause the
  auto-updater (see [Troubleshooting](#troubleshooting)).

---

## Day-to-day

- **On the Pi's screen**: tap to add or edit, drag cards to reorder or move them
  between columns. Edits go to GitHub about a second later.
- **On a laptop or phone in the lab**: `http://<pi-ip>:8000` (the kiosk footer
  shows the address), or `http://<pi-hostname>.local:8000`. This talks to the
  Pi directly, so no token is needed. Anyone on the lab network can edit, just
  like the old dashboard. Other web sites can't: the Pi only answers to its IP
  address, `localhost` and its own host name (add other names to
  `allowed_hosts`), and refuses edits that a browser marks as coming from
  another site.
- **From anywhere**: <https://richard-0417.github.io/lab-hub/> with your
  token. Changes reach the Pi within about 15 s. A read-only view (no token)
  can lag up to 5 minutes, because it reads GitHub's cached copy of the file.
- **Small screens** (the 7" 800×480 touchscreen, 1024×600): the task board
  fills the screen and **Calendar**, **Requests** and **Notes** open as a
  slide-over panel from buttons in the header (tap again, tap outside, or Esc
  to close). On phones everything stacks into one column with To do / In
  progress / Done tabs.
- **Card menu**: the **⋯** button on a card (always visible on touch screens,
  on hover with a mouse) has Open, Move to…, Move to top and Delete.
- **The Done column** is sorted by completion time, newest first. Moving a card
  out of Done clears its completion time.

### Quick-add

Type a task and add any of these words anywhere in it:

| you type | meaning |
|---|---|
| `@mei`, `@mei_lin` | assignee (`_` becomes a space) |
| `!high` `!h` `!!` `!urgent` / `!low` `!l` / `!normal` | priority |
| `#bio` `#orders` | tags (up to 8) |
| `^fri`, `due:fri` | due date: `today`, `tomorrow`/`tmr`, `mon`…`sun` (next one, today counts), `+3d`, `2w`, `5/14`, `2026-11-02` |

Example: `Order pipette tips @mei !high #orders ^fri`. Punctuation right after
one of these words is ignored (`#orders,` and `@mei:` work). New tasks go to
the top of **To do**.

### Keyboard

| key | on a focused card |
|---|---|
| `n` or `/` | jump to quick-add (anywhere, when you're not typing) |
| `Enter` | open the editor |
| `Space` | mark done / reopen |
| `Alt+↑` / `Alt+↓` | move up / down in its column |
| `Alt+←` / `Alt+→` | move to the previous / next column |
| `↑` `↓` `←` `→` | move focus between cards |
| `Delete` twice | delete (the first press arms the card and says so); **Undo** in the toast |

`Backspace` never deletes, and `Enter`, `Space` and `Delete` are ignored for
a moment right after a dialog closes, so a key meant for the dialog can't hit
the card behind it. In the editor, `Cmd/Ctrl+Enter` saves and `Esc` cancels.

### Editing `board.json` by hand

You can edit `board.json` on GitHub directly (branch **data** →
`board.json` → pencil icon). Every client normalizes what it reads:
unknown fields are dropped and bad values are fixed or reset to defaults. If
the file is no longer valid JSON, sync pills show *"board.json on GitHub is not
valid JSON: …"* and **nobody pushes** until it's fixed. Local edits keep
queuing. To fix it, correct the file or revert the commit (**History** → the
bad commit). Every board change is a commit there, so the file's history
doubles as an audit log.

---

## Updating the code

1. Change and test on the Mac (see [Running locally](#running-locally-on-the-mac)).
2. `git push` to `main` of `lab-hub`.
3. If `static/` changed, GitHub Pages redeploys in about a minute.
4. Within 5 minutes the Pi's updater fast-forwards to `main`, reinstalls Python
   packages if `requirements.txt` changed, and restarts `lab-hub`. The kiosk
   page notices the new version and reloads itself once nobody is using it
   (it first pushes any unsent edits, and waits while a dialog is open,
   someone is typing, or a card is being dragged).
5. If the push changed anything in `systemd/` or `scripts/update.sh`, the Pi
   does **not** pick that up by itself; its log says so. Log in to the Pi and
   run `cd ~/lab-hub && ./scripts/install-pi.sh` (Enter keeps every answer).

To update the Pi right now: `sudo systemctl start lab-hub-update`, then
`journalctl -u lab-hub-update -n 20` to see what it did. The timer runs 2
minutes after boot, 2 minutes after `install-pi.sh` restarts it, and then
every 5 minutes.

The updater only fast-forwards. It never merges and never discards changes. It
does nothing (and exits cleanly) when the checkout isn't on `main`, when
GitHub can't be reached, when tracked files were edited on the Pi, or when the
Pi has commits that aren't on GitHub, and logs why.

It runs as root only so it can restart the service; the git and pip work runs
as the install user. Root only ever runs the copy that `install-pi.sh`
installed in `/usr/local/lib/lab-hub/`, never a script it has just pulled, and
it never installs systemd units. The server itself does run the code pulled
from `main`, as the install user, who on Raspberry Pi OS can use sudo. So
whoever can push to `main` controls the Pi, which includes everyone holding a
board token (see [Security & privacy](#security--privacy)).

---

## Configuration

`config.json` sits next to `run.sh`. `install-pi.sh` writes it, and you can
also copy `config.example.json`. Every key is optional. An environment variable
`LABHUB_<KEY>` overrides the file (e.g. `LABHUB_SYNC_INTERVAL=30`), and
`LABHUB_CONFIG=/path/to/file.json` reads a different file instead of
`config.json`. `LABHUB_LOG_LEVEL` (`DEBUG`, `INFO`, `WARNING`…) sets how much
the server logs.

For the systemd service, you can put such variables in `/etc/default/lab-hub`
(root-owned, `chmod 600`), e.g. `LABHUB_GITHUB_TOKEN=github_pat_…`. Only the
service reads that file. Keep **`host` and `port` in `config.json`**:
`run.sh`, `kiosk.sh`, `install-pi.sh` and `Start Lab Hub.command` all read them
from there, and a port set only in `/etc/default/lab-hub` would leave the kiosk
and the installer looking at port 8000. For a one-off run on another port, use
`./run.sh --port 8001`.

| key | default | meaning |
|---|---|---|
| `name` | `"Lab Hub"` | title in the header (old key `subgroup_name` still works) |
| `host` / `port` | `"0.0.0.0"` / `8000` | web server address. Set them here, not in `/etc/default/lab-hub` |
| `theme` | `"dark"` | `dark`, `light` or `auto`. The kiosk default; each browser can override it |
| `calendar_ics` | `""` | published Outlook `.ics` URL (or a local `.ics` path). In Outlook on the web: Settings → Calendar → Shared calendars → Publish a calendar → copy the ICS link |
| `calendar_max_events` | `8` | events shown |
| `github_repo` | `""` | `owner/name` of the repo holding the board, normally `richard-0417/lab-hub` (the installer's default). Empty = Pi-only (no sync) |
| `github_branch` | `"data"` | branch with the board file |
| `github_path` | `"board.json"` | board file path on that branch |
| `github_token` | `""` | fine-grained token with Contents: read & write on that repo. Prefer env `LABHUB_GITHUB_TOKEN`. Never sent to browsers |
| `github_api` | `"https://api.github.com"` | override for tests (mock server) |
| `sync_interval` | `15` | seconds between pulls from GitHub |
| `client_name` | `"lab-pi"` | name used in commit messages and for edits made on the kiosk |
| `pages_url` | `""` | the "Edit from anywhere" link in the kiosk footer. When empty, the server uses the Pages site of the repo this folder was cloned from (git `origin`), i.e. `https://richard-0417.github.io/lab-hub/`; with a separate data repo it adds `?repo=<github_repo>`. Set it by hand for anything else (the installer keeps a hand-set value) |
| `state_dir` | `"state"` | local sync state (cached board + unsent edits) |
| `db_path` | `"labhub.db"` | old SQLite file to import once |
| `allowed_hosts` | `""` | extra host names people use to open the Pi in a browser, e.g. `["labpi.example.edu"]` or `"labpi.example.edu, .lab.example.edu"` (a leading `.` allows all subdomains; `"*"` turns the check off). IP addresses, `localhost` and the Pi's own host name (also `<name>.local`) always work |

Sync is on only when both `github_repo` and a token are set. Otherwise the sync
pill says *GitHub sync off* and the board lives in `state/` on the Pi.
`github_repo`, `github_branch` and `github_path` are checked at startup
(letters, digits, `.`, `_`, `-` and `/`, no `..`); an invalid value turns sync
off and the reason shows in the sync pill's details instead of crashing.

---

## Running locally on the Mac

```bash
./run.sh                     # http://localhost:8000, also reachable from the LAN
./run.sh --port 8001         # another port (also --host 127.0.0.1)
```

Or double-click **Start Lab Hub.command**. It serves on this Mac only
(127.0.0.1) and opens the browser. Both create `.venv` and install packages on
first run, and both work from folders with spaces in their names.

Without a `config.json`, the board is local-only (stored in `state/`). If you
give the Mac the repo and a token, it becomes one more sync client of the real
board. Use the test server below for experiments.

### Test server (fake GitHub, demo data)

```bash
bash .claude/dev-server.sh
```

It starts three things, all on this Mac and none touching the real GitHub, with
a fresh demo board every time:

| address | what |
|---|---|
| <http://127.0.0.1:8000/> | the dashboard as the Pi runs it, syncing to the fake GitHub |
| <http://127.0.0.1:8001/?api=http://127.0.0.1:9010&repo=richard-0417/lab-hub> | the Pages copy; connect with token `dev-token` |
| <http://127.0.0.1:9010/_mock/file?branch=data&path=board.json> | the board file on the fake GitHub |

Edit in one tab and watch the change appear in the other. In the Claude
desktop app it's also the `lab-hub-test` entry in `.claude/launch.json`.

### Tests

```bash
.venv/bin/python -m unittest discover -s tests -v     # Python model, sync, API, install/update scripts
npm test                                              # or: node --test tests/js/
```

`tests/ops_vectors.json` holds shared cases that the Python model
(`app/board.py`) and the JS model (`static/js/board.js`) must both pass.
`tests/test_ops_scripts.py` runs `scripts/update.sh` against a throwaway git
repo and the installer's token check against a fake GitHub.

### End-to-end against a mock GitHub, by hand

```bash
# terminal 1: a fake GitHub API with an in-memory repo (see --help for
#             --private, --no-data-branch, --empty)
.venv/bin/python tests/mock_github.py --port 9010 --repo richard-0417/lab-hub --token test-token

# terminal 2: the Pi server, syncing to the mock
LABHUB_GITHUB_API=http://127.0.0.1:9010 LABHUB_GITHUB_REPO=richard-0417/lab-hub \
LABHUB_GITHUB_TOKEN=test-token LABHUB_STATE_DIR=/tmp/lab-hub-mock-state ./run.sh --port 8001

# terminal 3 (optional): the Pages copy in "github" mode, against the same mock
python3 -m http.server 8080 --directory static
open "http://localhost:8080/?api=http://127.0.0.1:9010&repo=richard-0417/lab-hub"   # token: test-token
```

Edit on <http://localhost:8001> and on <http://localhost:8080> and watch the
changes cross over. `curl http://127.0.0.1:9010/_mock/state` shows the mock's
branches and commits. The separate `LABHUB_STATE_DIR` keeps the mock board out
of your real `state/`. (`?api=` only works on a `localhost` page; on the real
Pages site the token only ever goes to `api.github.com`.)

---

## Troubleshooting

### Sync pill

The pill in the header shows the sync state; click it for details, **Sync
now**, and (on Pages) **Settings** and **Forget token**. The state names in the
first column also appear in `/api/sync` on the Pi.

| state (pill text) | meaning | what to do |
|---|---|---|
| `ok` (*Synced*) | the board matches GitHub | nothing |
| `pending` / `syncing` (*N changes waiting* / *Syncing…*) | edits are waiting or being pushed | wait a few seconds |
| `offline` (*Offline — saved locally*) | can't reach GitHub (or, on the LAN, the Pi); edits are queued on this device | they push automatically when the network returns |
| `off` (*GitHub sync off*) | Pi: no repo or no token configured | `./scripts/install-pi.sh` |
| `readonly` (*Read-only*) | Pages site without a token: you can look but not edit | connect with a token (Settings) |
| `error`: *GitHub token rejected (expired or revoked?)* | token expired, revoked or mistyped | new token: see [step 4](#4-create-tokens-fine-grained-personal-access-tokens) |
| `error`: *repo not found, or the token can't see it* | wrong repo name (normally `richard-0417/lab-hub`), or the token wasn't given that repo | check the name in Settings; edit the token's repository access |
| `error`: *GitHub refused access - check the token has Contents: read & write…* | token lacks write permission on the repo | edit the token → Contents: Read and write |
| `error`: *the GitHub repo has no commits yet - push the Lab Hub code to it first…* | the repo on GitHub is still empty | do [step 2](#2-push-from-the-mac) |
| `off` with a reason starting *config:* | `github_repo`, `github_branch` or `github_path` in `config.json` is malformed | fix it and `sudo systemctl restart lab-hub` |
| `error`: *GitHub rate limit reached* | **With a token**: over 5,000 API calls/hour. All tokens act as richard-0417, so they share that limit; "board unchanged" checks don't count. **Without a token**: GitHub's API allows only 60 calls/hour per IP address, shared by everyone on that network (a whole lab or campus can share one address), and every call counts. Read-only tabs normally read GitHub's cached file copy instead, which doesn't use that limit, so this shows up only when that copy can't be reached (the tab then falls back to the API, about 40 calls an hour per tab) | wait until the reset time shown. Read-only viewers: connect with a token, or close extra read-only tabs. With tokens: look for a runaway script or dozens of open tabs |
| `error`: *board.json on GitHub is not valid JSON* | someone broke `board.json` by hand; nobody pushes until it's fixed | fix or revert it on the `data` branch |

### On the Pi

```bash
systemctl status lab-hub                 # is the server running?
journalctl -u lab-hub -f                 # server + sync log (live)
journalctl -u lab-hub-update -n 50       # what the updater did
systemctl list-timers lab-hub-update     # when it runs next
sudo systemctl restart lab-hub           # restart the server
curl -s localhost:8000/api/sync          # sync status as JSON (never shows the token)
```

- **Updater says "systemd/ or scripts/update.sh changed"**: run
  `cd ~/lab-hub && ./scripts/install-pi.sh` to install them. Until then the Pi
  keeps using the old units and updater (the rest of the code is already
  updated).
- **Updater says "tracked files were edited locally"**: something in `~/lab-hub`
  was changed on the Pi. `git -C ~/lab-hub status` shows what changed.
  `git -C ~/lab-hub checkout -- .` throws those changes away. Settings belong in
  `config.json`, which git ignores.
- **Updater says "diverged" / "has commits that aren't on GitHub"**: someone
  committed on the Pi. Push those commits from somewhere else, or
  `git -C ~/lab-hub reset --hard origin/main` to drop them.
- **Updater says "running the checkout's own update.sh as root"**: the service
  was installed by an older `install-pi.sh`. Re-run `./scripts/install-pi.sh`.
- **Token problems**: `./scripts/install-pi.sh` tests the saved token (reading
  and writing the repo) and prints *OK* or what is wrong. Fine-grained tokens
  need **resource owner richard-0417**, `lab-hub` selected, and **Contents:
  Read and write**.
- **Kiosk doesn't start on Wayland**: check
  `ls ~/.config/autostart/lab-hub-kiosk.desktop`. Run
  `~/lab-hub/kiosk.sh` from a terminal on the Pi's desktop to see its messages.
  If Chromium is missing, run `sudo apt install chromium-browser` (or
  `chromium`). As a last resort, switch to X11 (`sudo raspi-config` → *Advanced
  Options* → *Wayland* → *X11*) and reboot.
- **Kiosk shows "Waiting for the Lab Hub server…"**: the server isn't answering
  yet. It retries every few seconds by itself. If it stays, check
  `systemctl status lab-hub` and `journalctl -u lab-hub -n 50`.
- **Kiosk shows "can't reach this page"**: Chromium started before the server
  (or on the wrong port: set `port` in `config.json`, see
  [Configuration](#configuration)). Check `systemctl status lab-hub`, then
  press `F5` or log out and in.
- **"Edit from anywhere" link in the kiosk footer is wrong**: re-run
  `./scripts/install-pi.sh` (it stores the Pages link of the code repo it was
  cloned from), or set `pages_url` in `config.json`.
- **Browser shows "this Lab Hub does not answer to the host name …"**: you
  opened the Pi by a name it doesn't know (protection against DNS rebinding).
  Use its IP address, or add the name to `allowed_hosts` in `config.json` and
  `sudo systemctl restart lab-hub`.
- **Screen goes black after 10 minutes**: turn off screen blanking (see
  [Kiosk notes](#kiosk-notes)).

---

## Layout

```
lab-hub/
├── app/                      Pi backend (FastAPI, stdlib + fastapi/uvicorn only)
│   ├── main.py               routes; serves static/ at /
│   ├── config.py             DEFAULTS ← config.json ← LABHUB_* env
│   ├── board.py              pure board model: normalize, validate, apply ops
│   ├── store.py              local state/ (cached board + pending ops)
│   ├── github_sync.py        GitHub Contents API client + sync thread
│   ├── migrate.py            one-time import of the old labhub.db
│   └── calendar_feed.py      Outlook .ics → upcoming events
├── static/                   the frontend: served by the Pi AND deployed to Pages
│   ├── index.html  style.css
│   └── js/                   app.js, board.js, sources.js, quickadd.js, ui/…
├── tests/                    unittest + node tests, ops_vectors.json, mock_github.py
├── .claude/                  dev-server.sh test server + launch.json (desktop app)
├── docs/ARCHITECTURE.md      the contract between all the pieces
├── scripts/
│   ├── install-pi.sh         one-shot Pi setup (safe to re-run)
│   ├── install_helper.py     its config.json + GitHub token check helper
│   └── update.sh             auto-updater (installed as a root-owned copy, run by lab-hub-update.timer)
├── systemd/                  templates: lab-hub.service, lab-hub-update.{service,timer},
│                             lab-hub-kiosk.desktop
├── .github/workflows/pages.yml   deploys static/ to GitHub Pages
├── run.sh                    start the server (any machine)
├── kiosk.sh                  fullscreen Chromium on the Pi
├── Start Lab Hub.command     double-click launcher for the Mac
├── config.example.json       every setting (repo filled in)
└── requirements.txt          fastapi, uvicorn
```

Not in git: `config.json`, `.venv/`, `state/`, `labhub.db*`, `.claude/dev/`.
The board itself is on the `data` branch.
