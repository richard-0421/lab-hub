#!/usr/bin/env bash
# One-shot Raspberry Pi setup for Lab Hub. Safe to re-run any time (e.g. to
# change the token or calendar, or after moving the folder).
#
# Run as your normal desktop user (NOT with sudo) from inside the cloned repo
# (public, so no login; --single-branch skips the board's history on "data"):
#   git clone --single-branch https://github.com/richard-0417/lab-hub.git ~/lab-hub
#   cd ~/lab-hub && ./scripts/install-pi.sh
#
# Options:
#   --repo OWNER/NAME   GitHub repo whose "data" branch holds board.json
#                       (default richard-0417/lab-hub, the same repo as the
#                       code; "none" = local-only, no sync). A separate data
#                       repo is an optional alternative (README).
#   --name TEXT         dashboard title (default "Lab Hub")
#   --ics URL           published Outlook calendar .ics URL ("none" clears it)
#   --token-file FILE   read the GitHub token from FILE instead of prompting
#   --from DIR          migrate an old install: copy its labhub.db (old tasks,
#                       requests and notes are imported on first start) and its
#                       name + calendar settings
#   --yes, -y           don't ask anything; keep existing values / defaults
#   --no-kiosk          don't set up the fullscreen browser at login
#   --no-service        don't install/start the systemd services
#   -h, --help          show this help
#
# What it does: checks prerequisites, makes .venv and installs requirements,
# writes config.json (mode 600) and checks the token can write the board repo,
# installs + starts lab-hub.service and the lab-hub-update.timer auto-updater
# (a root-owned copy of scripts/update.sh in /usr/local/lib/lab-hub), sets up
# kiosk autostart (X11, wayfire, labwc), then waits for http://localhost:<port>
# and prints the URLs. Re-run it after changes to systemd/ or scripts/update.sh:
# the auto-updater never installs those by itself.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$APP_DIR"

# Root-owned copy of the updater that lab-hub-update.service runs (as root).
# The copy in the checkout is NOT run as root: the checkout follows GitHub.
UPDATER_DIR="/usr/local/lib/lab-hub"

if [ -t 1 ]; then B=$'\033[1m'; Y=$'\033[33m'; R=$'\033[31m'; G=$'\033[32m'; N=$'\033[0m'
else B=""; Y=""; R=""; G=""; N=""; fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    %s%s%s\n' "$G" "$*" "$N"; }
warn() { printf '    %sWARNING:%s %s\n' "$Y" "$N" "$*" >&2; }
die()  { printf '\n%sERROR:%s %s\n' "$R" "$N" "$*" >&2; exit 1; }

# the comment block at the top of this file, without the "# "
usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"; }

# --- options ------------------------------------------------------------------
OPT_REPO=""; OPT_REPO_SET=0
OPT_NAME=""; OPT_NAME_SET=0
OPT_ICS="";  OPT_ICS_SET=0
TOKEN_FILE=""
FROM=""
YES=0
NO_KIOSK=0
NO_SERVICE=0

need_val() { [ "$2" -ge 2 ] || die "$1 needs a value (see --help)"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --repo)         need_val "$1" $#; OPT_REPO="$2"; OPT_REPO_SET=1; shift ;;
    --repo=*)       OPT_REPO="${1#*=}"; OPT_REPO_SET=1 ;;
    --name)         need_val "$1" $#; OPT_NAME="$2"; OPT_NAME_SET=1; shift ;;
    --name=*)       OPT_NAME="${1#*=}"; OPT_NAME_SET=1 ;;
    --ics)          need_val "$1" $#; OPT_ICS="$2"; OPT_ICS_SET=1; shift ;;
    --ics=*)        OPT_ICS="${1#*=}"; OPT_ICS_SET=1 ;;
    --token-file)   need_val "$1" $#; TOKEN_FILE="$2"; shift ;;
    --token-file=*) TOKEN_FILE="${1#*=}" ;;
    --from)         need_val "$1" $#; FROM="$2"; shift ;;
    --from=*)       FROM="${1#*=}" ;;
    -y|--yes)       YES=1 ;;
    --no-kiosk)     NO_KIOSK=1 ;;
    --no-service)   NO_SERVICE=1 ;;
    -h|--help)      usage; exit 0 ;;
    *)              die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

INTERACTIVE=0
if [ "$YES" = 0 ] && [ -t 0 ]; then INTERACTIVE=1; fi

CFG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
RUN_USER="$(id -un)"
VENV_PY="$APP_DIR/.venv/bin/python"

# --- 1. sanity checks -------------------------------------------------------------
step "Checking prerequisites"

[ "$(id -u)" -ne 0 ] ||
  die "run this as your normal desktop user, without sudo (it asks for sudo itself when needed)."

command -v git >/dev/null 2>&1 || die "git is not installed: sudo apt install git"
command -v python3 >/dev/null 2>&1 || die "python3 is not installed: sudo apt install python3 python3-venv"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' ||
  die "Python 3.9 or newer is needed (found $(python3 --version 2>&1))."
info "user $RUN_USER, $(python3 --version 2>&1), folder $APP_DIR"

case "$APP_DIR" in
  *[\"\\\$\`]*) die "the folder path contains a quote, backslash, \$ or backtick; move it (e.g. to ~/lab-hub) and re-run." ;;
  *" "*) warn "the folder path contains spaces. It should work, but a path like ~/lab-hub is less fragile." ;;
esac

ORIGIN=""
if git -C "$APP_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if ORIGIN="$(git -C "$APP_DIR" remote get-url origin 2>/dev/null)"; then
    case "$ORIGIN" in
      http://*@*|https://*@*)
        # The Pi pulls the public repo anonymously; a credential saved in the
        # remote URL is never needed and sits in .git/config in clear text.
        warn "the 'origin' URL contains a login or token. The Pi only needs to pull, anonymously:"
        warn "  git -C \"$APP_DIR\" remote set-url origin https://github.com/richard-0417/lab-hub.git" ;;
    esac
  else
    ORIGIN=""
    warn "this clone has no 'origin' remote, so automatic code updates can't work."
  fi
  if [ -n "$(git -C "$APP_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    warn "files tracked by git were edited here; automatic updates pause until you undo that (git status)."
  fi
else
  warn "$APP_DIR is not a git clone, so automatic code updates won't work."
  warn "Clone it instead: git clone https://github.com/richard-0417/lab-hub.git ~/lab-hub"
fi

OLD_DIR=""
if [ -n "$FROM" ]; then
  [ -d "$FROM" ] || die "--from: no such folder: $FROM"
  OLD_DIR="$(cd "$FROM" && pwd -P)"
  [ "$OLD_DIR" != "$APP_DIR" ] || die "--from must point at the OLD install (e.g. ~/lab-hub-old), not this folder."
  info "migrating from $OLD_DIR"
fi

if [ -n "$TOKEN_FILE" ] && [ ! -r "$TOKEN_FILE" ]; then
  die "--token-file: can't read $TOKEN_FILE"
fi

# --- 2. Python environment ----------------------------------------------------------
step "Python environment (.venv)"

venv_ok() { [ -x "$VENV_PY" ] && "$VENV_PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; }
if venv_ok; then
  info "reusing .venv"
else
  if ! python3 -c 'import venv, ensurepip' >/dev/null 2>&1; then
    die "Python's venv module is missing. Install it with:  sudo apt install python3-venv   then re-run."
  fi
  info "creating .venv ..."
  rm -rf "$APP_DIR/.venv"
  if ! python3 -m venv "$APP_DIR/.venv"; then
    rm -rf "$APP_DIR/.venv"
    die "python3 -m venv failed. Try:  sudo apt install python3-venv   then re-run."
  fi
  # The pip bundled with older Raspberry Pi OS releases can't pick some newer wheels.
  "$VENV_PY" -m pip install --quiet --disable-pip-version-check --upgrade pip >/dev/null 2>&1 || true
fi
info "installing requirements (fastapi, uvicorn) ..."
"$VENV_PY" -m pip install --quiet --disable-pip-version-check -r requirements.txt ||
  die "pip install failed (is the Pi online?). Re-run this script when it is."
git hash-object requirements.txt > "$APP_DIR/.venv/.labhub-requirements" 2>/dev/null || true
ok "Python packages ready"

# --- 3. config.json -----------------------------------------------------------------
step "Configuration (config.json)"

# JSON + GitHub helper (scripts/install_helper.py). Inputs go in LH_* env
# vars, so the token never appears on a command line.
cfg_py() {
  LH_APP_DIR="$APP_DIR" LH_OLD_DIR="$OLD_DIR" LH_ORIGIN="$ORIGIN" \
    python3 "$APP_DIR/scripts/install_helper.py" "$1"
}

SHOW="$(cfg_py show)" || die "could not read config.json (see the message above)."
CUR_NAME="$(printf '%s\n' "$SHOW" | sed -n 1p)"
CUR_REPO="$(printf '%s\n' "$SHOW" | sed -n 2p)"
CUR_ICS="$(printf '%s\n' "$SHOW" | sed -n 3p)"
HAS_TOKEN="$(printf '%s\n' "$SHOW" | sed -n 4p)"

# ask VAR "question" "default" — Enter keeps the default
ask() {
  local __ans=""
  if [ "$INTERACTIVE" = 1 ]; then
    read -r -p "    $2 [${3:-none}]: " __ans || __ans=""
  fi
  [ -n "$__ans" ] || __ans="$3"
  printf -v "$1" '%s' "$__ans"
}

if [ "$OPT_NAME_SET" = 1 ]; then NAME="$OPT_NAME"; else ask NAME "Dashboard title" "$CUR_NAME"; fi
NAME="$(printf '%s' "$NAME" | tr -d '\r\n')"
[ -n "$NAME" ] || NAME="Lab Hub"

if [ "$OPT_REPO_SET" = 1 ]; then REPO="$OPT_REPO"
else
  if [ "$INTERACTIVE" = 1 ]; then
    info "GitHub repo whose 'data' branch holds board.json: normally this code repo,"
    info "richard-0417/lab-hub. ('none' = keep the board on this Pi only)"
  fi
  ask REPO "GitHub repo for the board (owner/name)" "$CUR_REPO"
fi
case "$REPO" in none|NONE|-|"") REPO="" ;; esac
REPO="${REPO#https://github.com/}"; REPO="${REPO%.git}"; REPO="${REPO%/}"
if [ -n "$REPO" ] && ! printf '%s' "$REPO" | grep -Eq '^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$'; then
  die "'$REPO' doesn't look like owner/name (e.g. richard-0417/lab-hub)."
fi

if [ "$OPT_ICS_SET" = 1 ]; then ICS="$OPT_ICS"
else
  [ "$INTERACTIVE" = 1 ] && info "Outlook: Settings > Calendar > Shared calendars > Publish a calendar > copy the ICS link ('none' = no calendar)"
  ask ICS "Calendar .ics URL" "$CUR_ICS"
fi
case "$ICS" in none|NONE|-) ICS="" ;; esac

TOKEN_ACTION="keep"
NEW_TOKEN=""
if [ -n "$TOKEN_FILE" ]; then
  NEW_TOKEN="$(head -n 1 "$TOKEN_FILE" | tr -d '[:space:]')"
  [ -n "$NEW_TOKEN" ] || die "--token-file $TOKEN_FILE is empty."
  TOKEN_ACTION="set"
elif [ "$INTERACTIVE" = 1 ] && [ -n "$REPO" ]; then
  info "A fine-grained GitHub token with Contents: Read and write on $REPO only"
  info "lets this Pi sync. Create one at"
  info "https://github.com/settings/personal-access-tokens/new (see the README)."
  if [ "$HAS_TOKEN" = 1 ]; then
    prompt="    GitHub token (hidden; Enter = keep the saved one, '-' = remove): "
  else
    prompt="    GitHub token (hidden; Enter = skip, board stays on this Pi only): "
  fi
  read -r -s -p "$prompt" NEW_TOKEN || NEW_TOKEN=""
  echo
  NEW_TOKEN="$(printf '%s' "$NEW_TOKEN" | tr -d '[:space:]')"
  if [ "$NEW_TOKEN" = "-" ]; then TOKEN_ACTION="clear"; NEW_TOKEN=""
  elif [ -n "$NEW_TOKEN" ]; then TOKEN_ACTION="set"; fi
fi
if [ "$TOKEN_ACTION" = "set" ]; then
  case "$NEW_TOKEN" in
    github_pat_*|ghp_*) ;;
    *) warn "that doesn't look like a GitHub token (they start with github_pat_ or ghp_); saving it anyway." ;;
  esac
fi

LH_NAME="$NAME" LH_REPO="$REPO" LH_ICS="$ICS" LH_TOKEN="$NEW_TOKEN" LH_TOKEN_ACTION="$TOKEN_ACTION" \
  cfg_py write || die "could not write config.json"
unset NEW_TOKEN
ok "saved $APP_DIR/config.json (readable only by $RUN_USER)"
info "title: $NAME"
if [ -z "$REPO" ]; then
  info "GitHub sync: off (board stays on this Pi)"
else
  info "GitHub repo: $REPO"
  token_state="$TOKEN_ACTION"
  if [ "$token_state" = "keep" ]; then
    if [ "$HAS_TOKEN" = 1 ]; then token_state="saved"; else token_state="none"; fi
  fi
  case "$token_state" in
    set|saved) info "token: $token_state"
               # Tests read AND write access (a read-only token, or one without
               # this repo, can still read a public repo) and that the board
               # branch exists. Single repo: one NOTE on the trust model. A
               # separate data repo: warns if the token can also write the code.
               cfg_py check 2>&1 | while IFS= read -r line; do
                 case "$line" in
                   OK:*)               ok "$line" ;;
                   PROBLEM:*|WARNING:*) warn "${line#*: }" ;;
                   *)                  info "$line" ;;
                 esac
               done || true ;;
    *) info "token: none -> sync stays off until you add one (re-run this script)" ;;
  esac
fi
info "calendar: ${ICS:-not set}"

# --- 4. migrate the old install's data ------------------------------------------------
if [ -n "$OLD_DIR" ]; then
  step "Importing data from $OLD_DIR"
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet lab-hub.service 2>/dev/null; then
    if [ "$NO_SERVICE" = 0 ]; then
      # It is restarted with the new code in the next step anyway.
      info "stopping lab-hub.service so nothing changes while copying (sudo) ..."
      sudo systemctl stop lab-hub.service || warn "could not stop lab-hub.service"
    else
      warn "lab-hub.service is still running; edits made from now on won't be copied."
    fi
  fi
  if MIGRATE_OUT="$(cfg_py olddb 2>&1)"; then
    printf '%s\n' "$MIGRATE_OUT" | while IFS= read -r line; do info "$line"; done
  else
    printf '%s\n' "$MIGRATE_OUT" | while IFS= read -r line; do info "$line"; done
    warn "copying the old database failed; old tasks/requests/notes were NOT imported."
  fi
fi

# --- 5. systemd services ------------------------------------------------------------
sed_escape() { printf '%s' "$1" | sed -e 's/[\\|&]/\\&/g'; }
# render TEMPLATE OUT — fill __USER__ / __APP_DIR__ (% doubled for systemd/.desktop)
render() {
  local app_esc user_esc
  app_esc="$(sed_escape "${APP_DIR//[%]/%%}")"
  user_esc="$(sed_escape "$RUN_USER")"
  sed -e "s|__USER__|${user_esc}|g" -e "s|__APP_DIR__|${app_esc}|g" "$1" > "$2"
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

SERVICE_OK=0
if [ "$NO_SERVICE" = 0 ] && ! command -v systemctl >/dev/null 2>&1; then
  warn "systemd not found; skipping the services. Start Lab Hub by hand with ./run.sh"
  NO_SERVICE=1
fi
if [ "$NO_SERVICE" = 0 ]; then
  step "Installing systemd services (asks for your password if sudo needs it)"
  # The updater runs as root, so it runs from a root-owned copy. The checkout's
  # own scripts/update.sh (and systemd/) follow GitHub automatically, and only
  # this script, run by you, installs them.
  sudo install -d -m 755 "$UPDATER_DIR"
  sudo install -m 755 -o root -g root "$APP_DIR/scripts/update.sh" "$UPDATER_DIR/update.sh"
  info "$UPDATER_DIR/update.sh (root-owned copy of scripts/update.sh)"
  for unit in lab-hub.service lab-hub-update.service lab-hub-update.timer; do
    render "systemd/$unit" "$TMP_DIR/$unit"
    sudo install -m 644 "$TMP_DIR/$unit" "/etc/systemd/system/$unit"
    info "/etc/systemd/system/$unit"
  done
  sudo systemctl daemon-reload
  sudo systemctl enable --quiet lab-hub.service lab-hub-update.timer
  # restart (not just "enable --now") so a re-run or an old install picks up the new unit
  sudo systemctl restart lab-hub.service
  sudo systemctl restart lab-hub-update.timer
  SERVICE_OK=1
  ok "lab-hub.service running; lab-hub-update.timer checks GitHub for code updates every 5 min"
fi

# --- 6. kiosk autostart -----------------------------------------------------------------
# Several mechanisms may start kiosk.sh; it only ever runs one copy.
KIOSK_CMD="/bin/bash \"$APP_DIR/kiosk.sh\""
MARK="# lab-hub kiosk (added by scripts/install-pi.sh)"

# set_line FILE MODE — idempotently add our kiosk command to an autostart file.
#   labwc:   one line "<cmd> &  <MARK>", replacing an older one of ours
#   wayfire: "lab_hub_kiosk = <cmd>" under [autostart], replacing an older one
set_line() {
  LH_FILE="$1" LH_MODE="$2" LH_CMD="$KIOSK_CMD" LH_MARK="$MARK" python3 - <<'PY'
import os, re, shutil

path, mode = os.environ["LH_FILE"], os.environ["LH_MODE"]
cmd, mark = os.environ["LH_CMD"], os.environ["LH_MARK"]
text = ""
if os.path.exists(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
lines = text.splitlines(True)
if lines and not lines[-1].endswith("\n"):
    lines[-1] += "\n"

if mode == "labwc":
    new = "%s &  %s\n" % (cmd, mark)
    if new in lines:
        print("already set"); raise SystemExit
    lines = [l for l in lines if mark not in l]
    lines.append(new)
else:  # wayfire
    new = "lab_hub_kiosk = %s\n" % cmd
    key = re.compile(r"^\s*lab_hub_kiosk\s*=")
    if new in lines:
        print("already set"); raise SystemExit
    idx = [i for i, l in enumerate(lines) if key.match(l)]
    if idx:
        lines[idx[0]] = new
    else:
        sec = [i for i, l in enumerate(lines) if l.strip().lower() == "[autostart]"]
        if sec:
            lines.insert(sec[0] + 1, new)
        else:
            if lines and lines[-1].strip():
                lines.append("\n")
            lines += ["[autostart]\n", new]

if os.path.exists(path) and not os.path.exists(path + ".lab-hub.bak"):
    shutil.copy2(path, path + ".lab-hub.bak")
os.makedirs(os.path.dirname(path), exist_ok=True)
tmp = path + ".lab-hub.tmp"
with open(tmp, "w", encoding="utf-8") as f:
    f.write("".join(lines))
if os.path.exists(path):
    shutil.copymode(path, tmp)
os.replace(tmp, path)
print("updated")
PY
}

# labwc reads ~/.config/labwc/autostart *instead of* the system one unless it
# runs with --merge-config (Raspberry Pi OS's labwc-pi does). Don't create a
# user file that would hide the panel/desktop on other setups.
labwc_merges_config() {
  local f
  for f in /usr/bin/labwc-pi /usr/local/bin/labwc-pi; do
    [ -f "$f" ] && grep -Eq -- '(^|[[:space:]])(-m|--merge-config)([[:space:]]|$)' "$f" && return 0
  done
  return 1
}

if [ "$NO_KIOSK" = 0 ]; then
  step "Kiosk: open the dashboard fullscreen at login"
  mkdir -p "$CFG_HOME/autostart"
  render "systemd/lab-hub-kiosk.desktop" "$TMP_DIR/lab-hub-kiosk.desktop"
  install -m 644 "$TMP_DIR/lab-hub-kiosk.desktop" "$CFG_HOME/autostart/lab-hub-kiosk.desktop"
  info "XDG autostart: $CFG_HOME/autostart/lab-hub-kiosk.desktop"

  if [ -d "$CFG_HOME/labwc" ] || [ -d /etc/xdg/labwc ]; then
    LABWC_AUTOSTART="$CFG_HOME/labwc/autostart"
    if [ -f "$LABWC_AUTOSTART" ] || [ ! -f /etc/xdg/labwc/autostart ] || labwc_merges_config; then
      info "labwc: $LABWC_AUTOSTART ($(set_line "$LABWC_AUTOSTART" labwc))"
    else
      info "labwc: leaving $LABWC_AUTOSTART alone (it would replace the system autostart); the XDG entry above starts the kiosk"
    fi
  fi
  if [ -f "$CFG_HOME/wayfire.ini" ]; then
    info "wayfire: $CFG_HOME/wayfire.ini [autostart] ($(set_line "$CFG_HOME/wayfire.ini" wayfire))"
  fi

  # leftovers from an older install pointing somewhere else?
  for f in "$CFG_HOME"/autostart/*.desktop "$CFG_HOME/labwc/autostart" "$CFG_HOME/wayfire.ini" \
           "$CFG_HOME/lxsession/LXDE-pi/autostart"; do
    [ -f "$f" ] || continue
    if [ -n "$(grep 'kiosk\.sh' "$f" 2>/dev/null | grep -vF "$APP_DIR/kiosk.sh" || true)" ]; then
      warn "$f also starts a kiosk.sh from another folder; remove that line if it's an old install."
    fi
  done

  if ! command -v chromium-browser >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
    warn "Chromium is not installed: sudo apt install chromium-browser   (or: chromium)"
  fi
  if [ -n "${WAYLAND_DISPLAY:-}" ] || [ -f "$CFG_HOME/wayfire.ini" ] || [ -d "$CFG_HOME/labwc" ]; then
    info "Wayland desktop: to stop the screen from blanking, run sudo raspi-config ->"
    info "Display Options -> Screen Blanking -> No."
  fi
fi

# --- 7. wait for the server and print the URLs -------------------------------------------
# Same answer as run.sh / the service: the app's own config loader (config.json,
# LABHUB_CONFIG, LABHUB_PORT in this shell). /etc/default/lab-hub is only read
# by the service, which is why the README says to keep host/port in config.json.
PORT="$("$VENV_PY" -m app.config port 2>/dev/null || true)"
case "$PORT" in ''|*[!0-9]*) PORT="$(cfg_py port 2>/dev/null || echo 8000)" ;; esac
if [ "$SERVICE_OK" = 1 ]; then
  step "Waiting for Lab Hub on http://localhost:$PORT"
  up=0
  for _ in $(seq 1 60); do
    if python3 -c 'import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=3)' \
         "http://localhost:$PORT/api/config" >/dev/null 2>&1; then
      up=1; break
    fi
    sleep 1
  done
  if [ "$up" = 1 ]; then
    ok "Lab Hub is up"
    # one sync now, so token/repo problems show up here rather than later.
    # POST /api/sync waits up to 20 s for a running cycle, then runs one, and
    # each GitHub request in it may take up to 15 s: allow for a few.
    python3 - "http://localhost:$PORT/api/sync" <<'PY' || true
import json, socket, sys, urllib.request
try:
    req = urllib.request.Request(sys.argv[1], data=b"", method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        s = json.loads(r.read().decode("utf-8"))
except (socket.timeout, TimeoutError):
    print("    (the sync is still running; see: curl -s %s)" % sys.argv[1])
    raise SystemExit
except Exception as e:
    print("    (could not ask for a sync status: %s)" % e.__class__.__name__)
    raise SystemExit
state = s.get("state")
if not s.get("enabled") or state == "off":
    print("    GitHub sync: off (no repo or no token configured)")
elif state in ("ok", "pending", "syncing"):
    note = "" if s.get("last_push") else " - nothing needed pushing yet, so only the token check above tested writing"
    print("    GitHub sync: %s with %s (branch %s, %s)%s" % (state, s.get("repo"), s.get("branch"), s.get("path"), note))
else:
    print("    GitHub sync: %s - %s" % (state, s.get("last_error") or "see journalctl -u lab-hub"))
PY
  else
    warn "no answer yet. Check the log with: journalctl -u lab-hub -n 50 --no-pager"
  fi
fi

step "Done"
if [ "$SERVICE_OK" = 1 ]; then
  info "On this Pi:        http://localhost:$PORT"
  if command -v hostname >/dev/null 2>&1; then
    for ip in $(hostname -I 2>/dev/null || true); do
      case "$ip" in *:*) continue ;; esac
      info "On the lab network: http://$ip:$PORT"
    done
  fi
else
  info "Start it by hand with: ./run.sh   (then open http://localhost:$PORT)"
fi

# Pages site: published from the code repo (origin). Normally the board is in
# that same repo, so this is the plain https://<owner>.github.io/<repo>/ the
# server derives too; only with a separate data repo did "write" above store
# it as pages_url with ?repo=<data repo>, so the kiosk footer shows the same.
if [ -n "$REPO" ]; then
  PAGES="$(cfg_py pages 2>/dev/null || true)"
  [ -z "$PAGES" ] || info "From anywhere:      $PAGES   (paste a token there once)"
fi

if [ "$NO_KIOSK" = 0 ]; then
  echo
  info "The kiosk starts at the next desktop login. To start it now: sudo reboot"
  # setsid -f: the kiosk keeps running after that terminal window is closed
  info "(or from a terminal on the Pi's desktop: setsid -f $KIOSK_CMD >/dev/null 2>&1)"
fi
info "Logs: journalctl -u lab-hub -f     Updates: journalctl -u lab-hub-update"
