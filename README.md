# Lab Hub

A shared lab dashboard: a **task board** first, plus item requests, team notes,
the Outlook calendar and a big clock. It runs on the lab Raspberry Pi
(fullscreen on its touch screen) and the exact same page is published on
**GitHub Pages**, so anyone on the team can see and edit the board from a
phone or laptop, anywhere. The board itself is one JSON file in this GitHub
repo, which both sides read and write.

- **Kiosk**: the Pi's screen shows `http://localhost:8000` fullscreen in Chromium.
- **Lab network**: any laptop/phone on the lab LAN can open `http://<pi-ip>:8000` (no login).
- **Anywhere**: <https://richard-0417.github.io/lab-hub/>. Paste a GitHub token once per browser to edit.

What's on the board:

- **Tasks**: a kanban board (To do / Doing / Done). Drag cards to reorder or move
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
             GitHub: richard-0417/lab-hub
   ┌───────────────────────────────────────────────┐
   │ main  branch: code ──► Actions ──► GitHub Pages ─────► browsers anywhere
   │ data  branch: board.json  ◄──── read/write via GitHub API ────┘   (token)
   └───────────────────────────────────────────────┘
        ▲ git pull every 5 min          ▲ sync every ~15 s, push ~1 s after an edit
        │ (code updates)                │ (board data)
   ┌────┴───────────────────────────────┴─────┐
   │ Raspberry Pi: FastAPI server + local copy │ ◄── kiosk screen, lab LAN browsers
   └──────────────────────────────────────────┘
```

Every edit (add, change or delete) is a small **operation**. Each client (the Pi,
or a browser on Pages) keeps the last `board.json` it saw plus a queue of its own
unsent operations. To sync, it fetches the latest file, replays its queued
operations on top and writes the result back. If someone else wrote first,
GitHub refuses the write, so the client fetches again and replays.
Two people editing different tasks never conflict. If both change the same
field, the last write wins. The Pi keeps working offline and catches up when
the network returns. Board commits go to the `data` branch, so they never
trigger a Pages deploy or get mixed into the code history.

The full contract (data model, operations, sync algorithm, HTTP API) is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## One-time GitHub setup

You only do this once. Steps 1 to 3 publish the code and the site. Steps 4 and 5
give the Pi and each browser permission to write the board.

### 1. Create the empty repo

Go to <https://github.com/new>:

- Owner **richard-0417**, repository name **lab-hub**
- **Public** (GitHub Pages is free for public repos; see [Privacy](#privacy) below)
- Do **not** add a README, .gitignore or license. The repo must be empty so the first push is clean.

### 2. Push from the Mac

The local repo already has two branches: `main` (code) and `data` (`board.json`).

```bash
cd ~/Desktop/"All the Programs/Ras Dashboard/lab-hub-new"
git remote add origin https://github.com/richard-0417/lab-hub.git
#   (if it says "remote origin already exists":
#    git remote set-url origin https://github.com/richard-0417/lab-hub.git)
git push -u origin main      # first push: main becomes the default branch
git push -u origin data
```

If git asks you to log in, the easiest option is the GitHub CLI:
`brew install gh && gh auth login` (choose GitHub.com, HTTPS, log in with a browser).
Then push again. Pushing `.github/workflows/` needs the **workflow** permission.
`gh auth login` includes it. A personal token without "Workflows: write" is refused
for that file.

### 3. Turn on GitHub Pages

Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.

The workflow `.github/workflows/pages.yml` deploys the `static/` folder on every
push to `main` that touches `static/`. If its first run failed (because Pages
wasn't switched on yet), open the **Actions** tab → **Deploy to GitHub Pages** →
**Run workflow** (or **Re-run all jobs** on the failed run). After about a minute
the site is live at:

**<https://richard-0417.github.io/lab-hub/>**

### 4. Create tokens (fine-grained personal access tokens)

Open <https://github.com/settings/personal-access-tokens/new> and set:

| field | value |
|---|---|
| Token name | something you'll recognise later, e.g. `lab-hub pi`, `lab-hub richard-laptop` |
| Expiration | about 1 year. Put a reminder in your calendar for the Pi's token |
| Resource owner | **richard-0417** |
| Repository access | **Only select repositories → lab-hub** (plus `lab-hub-data` if you use a [private data repo](#privacy)) |
| Permissions → Repository permissions | **Contents: Read and write**. "Metadata: Read-only" is added automatically. Nothing else. |

Click **Generate token** and copy it (`github_pat_…`). GitHub shows it only once.

Make **one token for the Pi and one per person or browser**. That way you can
revoke a single token (Settings → Developer settings → Fine-grained tokens)
without breaking everyone else.

When a token expires or is revoked, that client's sync pill turns red with
*"GitHub token rejected (expired or revoked?)"*. Edits keep queuing on that
device and are pushed once it has a new token:

- **Pi:** `cd ~/lab-hub && ./scripts/install-pi.sh`. Press Enter to keep each
  existing answer and paste the new token when asked. The script restarts the
  service.
- **Browser:** open the connect / settings dialog on the Pages site and paste the new token.

### 5. Connect a browser

Open <https://richard-0417.github.io/lab-hub/>. The connect dialog asks for:

- **Repository**: `richard-0417/lab-hub`
- **Token**: from step 4
- **Your name**: shown in the board's commit messages

The token is stored only in that browser (localStorage) and is sent only to
`api.github.com`. Without a token, the Pages site shows a public board
read-only.

> ### Privacy
>
> In a **public** repo, anyone can read `board.json`: every task, request and
> note, plus its history. If that's not OK:
>
> 1. Create a second, **private** repo, e.g. `richard-0417/lab-hub-data`. Here, *do*
>    tick **"Add a README file"**: the repo must not be empty, because the Pi
>    creates the `data` branch from its default branch.
> 2. Give the tokens access to `lab-hub-data` (step 4).
> 3. Point everything at it: on the Pi, `./scripts/install-pi.sh --repo richard-0417/lab-hub-data`.
>    In each browser, set the dialog's **Repository** field to `richard-0417/lab-hub-data`
>    (or share the link `https://richard-0417.github.io/lab-hub/?repo=richard-0417/lab-hub-data`,
>    which pre-fills it).
>
> The Pages site itself stays in the public code repo; only the data moves.
> Decide before the team starts using the board. To carry existing data over,
> first create a `data` branch in the new repo (branch menu → type `data` →
> *Create branch*), then upload `board.json` from the `lab-hub` repo's `data`
> branch into it (*Add file → Upload files*). Then switch the Pi and browsers.

---

## Raspberry Pi setup

You need Raspberry Pi OS with a desktop (Bullseye or Bookworm), a network
connection, and these packages (most are preinstalled):
`sudo apt install git python3-venv chromium-browser`. On newer releases the
Chromium package is called `chromium`.

### Fresh install

```bash
git clone https://github.com/richard-0417/lab-hub.git ~/lab-hub
cd ~/lab-hub && ./scripts/install-pi.sh
```

Run it as your normal desktop user, **not** with `sudo`; it asks for sudo when it
needs it. It asks for the dashboard title, the GitHub repo (default
`richard-0417/lab-hub`), the Pi's token (input hidden; leave it blank to keep
the board on the Pi only) and an Outlook `.ics` URL. It is safe to re-run at
any time, for example to change the token or calendar.

Options: `--repo OWNER/NAME` (or `none`), `--name TEXT`, `--ics URL`,
`--token-file FILE`, `--yes` (no questions), `--no-kiosk`, `--no-service`,
`--from OLD_DIR`. See `./scripts/install-pi.sh --help`.

What it sets up:

| what | where |
|---|---|
| Python virtualenv + fastapi/uvicorn | `~/lab-hub/.venv` |
| settings incl. token (mode 600) | `~/lab-hub/config.json` |
| web server + GitHub sync, starts at boot, restarts on crash | `lab-hub.service` |
| code auto-updater, every 5 min | `lab-hub-update.timer` → `lab-hub-update.service` |
| fullscreen browser at login | `~/.config/autostart/lab-hub-kiosk.desktop` (+ labwc / wayfire autostart entries) |

At the end it prints the LAN address(es) and the Pages URL. Reboot (or log out
and back in) to start the kiosk.

### Migrating the existing install (the old tarball copy)

The Pi currently runs an old copy in `~/lab-hub` that is not a git clone.
Replace it with a clone and import its data:

```bash
sudo systemctl stop lab-hub
mv ~/lab-hub ~/lab-hub-old
git clone https://github.com/richard-0417/lab-hub.git ~/lab-hub
cd ~/lab-hub && ./scripts/install-pi.sh --from ~/lab-hub-old
```

`--from` copies the old `labhub.db`. The first time the new server starts, it
imports the old tasks, requests and notes and pushes them to GitHub. This is
safe to repeat: imported items have fixed ids such as `t-legacy-12`. It also
carries over the old title (`subgroup_name` → `name`) and calendar URL, and
replaces the old service and kiosk autostart entry. Once the board looks right,
you can delete `~/lab-hub-old`. (If the old copy lived somewhere other than
`~/lab-hub`, adjust the paths.)

### Kiosk notes

- `kiosk.sh` waits for the server, then starts Chromium in kiosk mode with a
  dedicated profile (`~/.config/lab-hub-kiosk`), touch-friendly flags (no
  swipe-to-go-back, no pinch-zoom, no translate bar) and incognito, so there is
  no "restore pages" prompt after a power cut. Only one copy runs, even if
  several autostart mechanisms fire.
- **X11** (Bullseye, or Bookworm switched to X11): started via
  `~/.config/autostart`. Screen blanking is turned off with `xset`.
- **Wayland** (Bookworm: wayfire or labwc): started via `~/.config/autostart` and
  also via `~/.config/wayfire.ini` `[autostart]` or `~/.config/labwc/autostart`.
  `xset` does nothing on Wayland. To turn blanking off, run
  `sudo raspi-config` → *Display Options* → *Screen Blanking* → *No*.
- **Bigger or smaller UI** on a high-resolution screen: put
  `--force-device-scale-factor=1.25` in `~/.config/lab-hub-kiosk.flags`.
- **Leave the kiosk**: `Alt+F4`. For a terminal: `Ctrl+Alt+T`, then
  `pkill -f lab-hub-kiosk`. Start it again with `~/lab-hub/kiosk.sh &` or by
  logging out and in.
- **Stop autostarting**: delete `~/.config/autostart/lab-hub-kiosk.desktop`, the
  line marked `# lab-hub kiosk` in `~/.config/labwc/autostart`, and the
  `lab_hub_kiosk = …` line in `~/.config/wayfire.ini`.
- Don't edit files from the repo on the Pi itself. Local edits pause the
  auto-updater (see [Troubleshooting](#troubleshooting)).

---

## Day-to-day

- **On the Pi's screen**: tap to add or edit, drag cards to reorder or move them
  between columns. Edits go to GitHub about a second later.
- **On a laptop or phone in the lab**: `http://<pi-ip>:8000`. This talks to the
  Pi directly, so no token is needed. Anyone on the lab network can edit, just
  like the old dashboard.
- **From anywhere**: <https://richard-0417.github.io/lab-hub/> with your token.
  Changes reach the Pi within about 15 s.
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

Example: `Order pipette tips @mei !high #orders ^fri`. New tasks go to the top
of **To do**.

### Editing `board.json` by hand

You can edit `board.json` on GitHub directly (switch to the **data** branch →
`board.json` → pencil icon). Every client normalizes what it reads: unknown
fields are dropped and bad values are fixed or reset to defaults. If the file
is no longer valid JSON, sync pills show *"board.json on GitHub is not valid
JSON: …"* and **nobody pushes** until it's fixed. Local edits keep queuing. To
fix it, correct the file or revert the commit (**History** → the bad commit).
Every board change is a commit on `data`, so the file's history doubles as an
audit log.

---

## Updating the code

1. Change and test on the Mac (see [Running locally](#running-locally-on-the-mac)).
2. `git push` to `main`.
3. If `static/` changed, GitHub Pages redeploys in about a minute.
4. Within 5 minutes the Pi's updater fast-forwards to `main`, reinstalls Python
   packages if `requirements.txt` changed, refreshes its systemd units if
   `systemd/` changed, and restarts `lab-hub`. The kiosk page notices the new
   version and reloads itself.

To update the Pi right now: `sudo systemctl start lab-hub-update`, then
`journalctl -u lab-hub-update -n 20` to see what it did.

The updater only fast-forwards. It never merges and never discards changes. If
it finds local edits to tracked files, or local commits, it logs that and
leaves the checkout alone. It runs as root so it can restart the service, and
does the git/pip work as the install user.

---

## Configuration

`config.json` sits next to `run.sh`. `install-pi.sh` writes it, and you can
also copy `config.example.json`. Every key is optional. An environment variable
`LABHUB_<KEY>` overrides the file (e.g. `LABHUB_PORT=9000`). For the systemd
service, you can put such variables in `/etc/default/lab-hub` (root-owned,
`chmod 600`), e.g. `LABHUB_GITHUB_TOKEN=github_pat_…`.

| key | default | meaning |
|---|---|---|
| `name` | `"Lab Hub"` | title in the header (old key `subgroup_name` still works) |
| `host` / `port` | `"0.0.0.0"` / `8000` | web server address |
| `theme` | `"dark"` | `dark`, `light` or `auto`. The kiosk default; each browser can override it |
| `calendar_ics` | `""` | published Outlook `.ics` URL (or a local `.ics` path). In Outlook on the web: Settings → Calendar → Shared calendars → Publish a calendar → copy the ICS link |
| `calendar_max_events` | `8` | events shown |
| `github_repo` | `""` | `owner/name` holding the board, e.g. `richard-0417/lab-hub`. Empty = Pi-only (no sync) |
| `github_branch` | `"data"` | branch with the board file |
| `github_path` | `"board.json"` | board file path on that branch |
| `github_token` | `""` | fine-grained token with Contents: read & write. Prefer env `LABHUB_GITHUB_TOKEN`. Never sent to browsers |
| `github_api` | `"https://api.github.com"` | override for tests (mock server) |
| `sync_interval` | `15` | seconds between pulls from GitHub |
| `client_name` | `"lab-pi"` | name used in commit messages |
| `pages_url` | `""` | defaults to `https://<owner>.github.io/<repo>/` |
| `state_dir` | `"state"` | local sync state (cached board + unsent edits) |
| `db_path` | `"labhub.db"` | old SQLite file to import once |

Sync is on only when both `github_repo` and a token are set. Otherwise the sync
pill says *GitHub sync off* and the board lives in `state/` on the Pi.

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
give the Mac the real repo and a token, it becomes one more sync client of the
real board. Use the mock server below for experiments.

### Tests

```bash
.venv/bin/python -m unittest discover -s tests -v     # Python model, sync, API
npm test                                              # or: node --test tests/js/
```

`tests/ops_vectors.json` holds shared cases that the Python model
(`app/board.py`) and the JS model (`static/js/board.js`) must both pass.

### End-to-end against a mock GitHub

```bash
# terminal 1: a fake GitHub API with an in-memory repo
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
of your real `state/`.

---

## Troubleshooting

### Sync pill

The pill in the header shows the sync `state` (the same names appear in
`/api/sync` on the Pi). In the red `error` state it also shows the message.

| state | meaning | what to do |
|---|---|---|
| `ok` | the board matches GitHub | nothing |
| `pending` / `syncing` | edits are waiting or being pushed | wait a few seconds |
| `offline` | can't reach GitHub; edits are queued on this device | they push automatically when the network returns |
| `off` | Pi: no repo or no token configured | `./scripts/install-pi.sh` |
| `readonly` | Pages site without a token: you can look but not edit | connect with a token |
| `error`: *GitHub token rejected (expired or revoked?)* | token expired, revoked or mistyped | new token: see [step 4](#4-create-tokens-fine-grained-personal-access-tokens) |
| `error`: *repo not found, or the token can't see it* | wrong repo name, or the token wasn't given that repo | check the name; edit the token's repository access |
| `error`: *GitHub refused access - check the token has Contents: read & write…* | token lacks write permission | edit the token → Contents: Read and write |
| `error`: *GitHub rate limit reached* | over 5,000 API calls/hour. The limit is per GitHub account, so all your tokens share it; "board unchanged" checks don't count | wait until the reset time shown; look for a runaway script or dozens of open tabs |
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

- **Updater says "tracked files were edited locally"**: something in `~/lab-hub`
  was changed on the Pi. `git -C ~/lab-hub status` shows what changed.
  `git -C ~/lab-hub checkout -- .` throws those changes away. Settings belong in
  `config.json`, which git ignores.
- **Updater says "diverged" / "has commits that aren't on GitHub"**: someone
  committed on the Pi. Push those commits from somewhere else, or
  `git -C ~/lab-hub reset --hard origin/main` to drop them.
- **Token problems**: `./scripts/install-pi.sh` checks the token against GitHub
  and prints *OK* or what is wrong. Fine-grained tokens must have **resource
  owner richard-0417**, the repo selected, and **Contents: Read and write**.
- **Kiosk doesn't start on Wayland**: check
  `ls ~/.config/autostart/lab-hub-kiosk.desktop`. Run
  `~/lab-hub/kiosk.sh` from a terminal on the Pi's desktop to see its messages.
  If Chromium is missing, run `sudo apt install chromium-browser` (or
  `chromium`). As a last resort, switch to X11 (`sudo raspi-config` → *Advanced
  Options* → *Wayland* → *X11*) and reboot.
- **Kiosk shows "can't reach this page"**: the server wasn't up in time. Check
  `systemctl status lab-hub`, then press `F5` or log out and in.
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
├── docs/ARCHITECTURE.md      the contract between all the pieces
├── scripts/
│   ├── install-pi.sh         one-shot Pi setup (safe to re-run)
│   └── update.sh             auto-updater (run by lab-hub-update.timer)
├── systemd/                  templates: lab-hub.service, lab-hub-update.{service,timer},
│                             lab-hub-kiosk.desktop
├── .github/workflows/pages.yml   deploys static/ to GitHub Pages
├── run.sh                    start the server (any machine)
├── kiosk.sh                  fullscreen Chromium on the Pi
├── Start Lab Hub.command     double-click launcher for the Mac
├── config.example.json       every setting with its default
└── requirements.txt          fastapi, uvicorn
```

Not in git: `config.json`, `.venv/`, `state/`, `labhub.db*`.
