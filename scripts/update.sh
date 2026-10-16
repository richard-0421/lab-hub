#!/usr/bin/env bash
# Lab Hub auto-updater: fast-forwards this checkout to GitHub's main branch.
#
# Normally run as root by lab-hub-update.service, every 5 minutes via
# lab-hub-update.timer:
#   sudo systemctl start lab-hub-update     # check for an update right now
#   journalctl -u lab-hub-update            # what it did
# It can also be run by hand as the install user: ./scripts/update.sh
#
# The service runs a ROOT-OWNED COPY of this file (/usr/local/lib/lab-hub/
# update.sh, installed by scripts/install-pi.sh) with LABHUB_APP_DIR pointing at
# the checkout. Root never runs code it has just pulled: a new version of this
# script, or of the systemd/ units, takes effect only when someone re-runs
# ./scripts/install-pi.sh on the Pi.
#
# What it does (never discards local changes, never creates merge commits):
#   * as root, all git/pip work runs as LABHUB_USER (default: owner of the repo)
#   * git fetch origin main
#   * not on main, fetch failed, ahead of GitHub -> nothing to do, exit 0
#   * HEAD already == origin/main          -> nothing to do, exit 0
#   * tracked files modified locally        -> refuse (log), exit 0
#   * history diverged                      -> log, exit 1
#   * git merge --ff-only origin/main
#   * requirements.txt changed              -> pip install -r into .venv
#   * systemd/ or this script changed       -> log that install-pi.sh must be
#                                              re-run (never installed from here)
#   * restart lab-hub.service (root only; otherwise prints the command)
# The open kiosk page notices the new version and reloads itself.
set -euo pipefail

log() { printf '[lab-hub-update] %s\n' "$*"; }

if [ -n "${LABHUB_APP_DIR:-}" ]; then
  APP_DIR="$(cd "$LABHUB_APP_DIR" && pwd -P)" || { log "LABHUB_APP_DIR=$LABHUB_APP_DIR: no such folder"; exit 1; }
else
  APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
fi
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/$(basename "${BASH_SOURCE[0]}")"
VENV_PY="$APP_DIR/.venv/bin/python"
DEPS_STAMP="$APP_DIR/.venv/.labhub-requirements"
IS_ROOT=0
[ "$(id -u)" -eq 0 ] && IS_ROOT=1

RUN_USER=""
RUN_HOME=""

pick_user() {
  if [ "$IS_ROOT" = 1 ]; then
    RUN_USER="${LABHUB_USER:-}"
    if [ -z "$RUN_USER" ]; then
      RUN_USER="$(stat -c %U "$APP_DIR" 2>/dev/null || stat -f %Su "$APP_DIR")"
    fi
    if ! id "$RUN_USER" >/dev/null 2>&1; then
      log "user '$RUN_USER' does not exist (set LABHUB_USER)"
      exit 1
    fi
    RUN_HOME="$(getent passwd "$RUN_USER" 2>/dev/null | cut -d: -f6 || true)"
    [ -n "$RUN_HOME" ] || RUN_HOME="/home/$RUN_USER"
  else
    RUN_USER="$(id -un)"
    RUN_HOME="${HOME:-}"
  fi
}

# Run a command as the install user (directly if we already are that user).
as_user() {
  if [ "$IS_ROOT" = 1 ] && [ "$RUN_USER" != "root" ]; then
    if command -v runuser >/dev/null 2>&1; then
      runuser -u "$RUN_USER" -- env HOME="$RUN_HOME" USER="$RUN_USER" LOGNAME="$RUN_USER" \
        GIT_TERMINAL_PROMPT=0 "$@"
    else
      sudo -u "$RUN_USER" -H -- env GIT_TERMINAL_PROMPT=0 "$@"
    fi
  else
    GIT_TERMINAL_PROMPT=0 "$@"
  fi
}

git_u() { as_user git -C "$APP_DIR" "$@"; }

# Hash of requirements.txt as installed into .venv last time (or "").
deps_stamp() { cat "$DEPS_STAMP" 2>/dev/null || true; }
req_hash() { git_u hash-object requirements.txt; }

# pip install -r requirements.txt if it changed since the last install.
# Returns 1 if an install was needed and failed.
ensure_deps() {
  local want
  want="$(req_hash)"
  [ "$want" = "$(deps_stamp)" ] && return 0
  if [ ! -x "$VENV_PY" ]; then
    log "no .venv in $APP_DIR; run ./scripts/install-pi.sh as $RUN_USER"
    return 1
  fi
  log "requirements.txt changed; installing into .venv ..."
  if as_user "$VENV_PY" -m pip install --quiet --disable-pip-version-check \
       -r "$APP_DIR/requirements.txt"; then
    printf '%s\n' "$want" | as_user tee "$DEPS_STAMP" >/dev/null
    log "dependencies installed"
    return 0
  fi
  log "pip install failed (offline?); will retry on the next run"
  return 1
}

main() {
  pick_user
  cd /

  if [ "$IS_ROOT" = 1 ] && [ "$SELF" = "$APP_DIR/scripts/update.sh" ]; then
    log "running the checkout's own update.sh as root; re-run ./scripts/install-pi.sh so the"
    log "  service uses the root-owned copy in /usr/local/lib/lab-hub instead"
  fi

  if ! git_u rev-parse --git-dir >/dev/null 2>&1; then
    log "$APP_DIR is not a git checkout (or $RUN_USER can't read it); cannot update"
    exit 1
  fi

  local branch
  branch="$(git_u symbolic-ref --quiet --short HEAD || true)"
  if [ "$branch" != "main" ]; then
    log "checkout is on '${branch:-a detached HEAD}', not main; not updating"
    exit 0
  fi

  local fetch_ok=1
  if command -v timeout >/dev/null 2>&1; then
    as_user timeout 300 git -C "$APP_DIR" fetch --quiet origin \
      "+refs/heads/main:refs/remotes/origin/main" || fetch_ok=0
  else
    git_u fetch --quiet origin "+refs/heads/main:refs/remotes/origin/main" || fetch_ok=0
  fi
  if [ "$fetch_ok" = 0 ]; then
    log "git fetch failed (offline, or GitHub unreachable); will retry on the next run"
    exit 0
  fi

  local head remote
  head="$(git_u rev-parse HEAD)"
  remote="$(git_u rev-parse refs/remotes/origin/main)"

  if [ "$head" = "$remote" ]; then
    # Up to date. Still finish a dependency install that failed last time.
    ensure_deps || true
    exit 0
  fi

  if [ -n "$(git_u status --porcelain --untracked-files=no)" ]; then
    log "tracked files were edited locally; not updating. Inspect with:"
    log "  git -C \"$APP_DIR\" status    (discard with: git -C \"$APP_DIR\" checkout -- .)"
    exit 0
  fi

  if git_u merge-base --is-ancestor "$remote" "$head"; then
    log "local main has commits that aren't on GitHub; nothing to pull"
    exit 0
  fi
  if ! git_u merge-base --is-ancestor "$head" "$remote"; then
    log "local main and GitHub's main have diverged (local commits?); not merging. Fix by hand:"
    log "  git -C \"$APP_DIR\" status"
    exit 1
  fi

  local req_changed=0 units_changed=0 updater_changed=0
  git_u diff --quiet "$head" "$remote" -- requirements.txt || req_changed=1
  git_u diff --quiet "$head" "$remote" -- systemd || units_changed=1
  git_u diff --quiet "$head" "$remote" -- scripts/update.sh || updater_changed=1

  log "updating ${head:0:7} -> ${remote:0:7}:"
  git_u log --oneline --no-decorate -n 20 "$head..$remote" | sed 's/^/[lab-hub-update]   /' || true

  if ! git_u merge --ff-only --quiet refs/remotes/origin/main; then
    log "git merge --ff-only failed (see git's message above); fix by hand:"
    log "  git -C \"$APP_DIR\" status"
    exit 1
  fi
  log "now at $(git_u rev-parse --short HEAD)"

  local rc=0
  if [ "$req_changed" = 1 ] || [ "$(req_hash)" != "$(deps_stamp)" ]; then
    ensure_deps || rc=1
  fi

  # Root-run pieces are deliberately NOT installed from the pulled code: a push
  # to main must not be able to run anything as root on this Pi.
  if [ "$units_changed" = 1 ] || [ "$updater_changed" = 1 ]; then
    log "systemd/ or scripts/update.sh changed; they take effect only after you run"
    log "  cd \"$APP_DIR\" && ./scripts/install-pi.sh     (as $RUN_USER, on the Pi)"
  fi

  if [ "$IS_ROOT" = 1 ]; then
    if systemctl restart lab-hub.service; then
      log "restarted lab-hub.service"
    else
      log "could not restart lab-hub.service (is it installed? run ./scripts/install-pi.sh)"
      rc=1
    fi
  else
    log "code updated. Load it with: sudo systemctl restart lab-hub"
  fi
  return "$rc"
}

# Everything runs from main(), so bash has parsed the whole file before the
# merge above replaces it on disk (when it is run from the checkout by hand).
main "$@"
exit $?
