#!/usr/bin/env bash
# Double-click (macOS) to set up and start Lab Hub on this Mac, then open it
# in your browser. Close this Terminal window or press Ctrl+C to stop.
#
# It listens on 127.0.0.1 only (this Mac). Sync with GitHub works the same as
# on the Pi if config.json has github_repo + a token (see README.md).
#
# First time, macOS may block it: right-click the file -> Open -> Open. If it
# opens in a text editor instead of running, run this once in Terminal:
#   chmod +x "Start Lab Hub.command"
set -uo pipefail
cd "$(dirname "$0")" || exit 1

echo "===================================="
echo "  Lab Hub"
echo "===================================="
echo

VENV=".venv"

die() { echo; echo "ERROR: $*"; echo;
        read -r -p "Press Return to close..." _; exit 1; }

py_ok() { "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; }

# 1) find a usable Python 3.9+ ------------------------------------------------
PY=""
for cand in python3.12 python3.11 python3.13 python3.10 python3.9 python3 python3.14 python; do
  command -v "$cand" >/dev/null 2>&1 || continue
  if py_ok "$cand"; then
    PY="$cand"
    echo "Using $cand ($("$cand" -c 'import sys; print("Python %d.%d" % sys.version_info[:2])'))"
    break
  fi
done

# 2) virtual environment -- call its python by path; never rely on 'activate' -
# (activate + the bare name 'python' is fragile: paths with spaces, set -u, and
#  stale symlinks all break it. Calling .venv/bin/python directly does not.)
find_venv_py() {
  for b in "$VENV/bin/python" "$VENV/bin/python3"; do
    [ -x "$b" ] && py_ok "$b" && { echo "$b"; return 0; }
  done
  return 1
}
if ! find_venv_py >/dev/null 2>&1; then
  [ -n "$PY" ] || die "No Python 3.9+ found. Install it from https://www.python.org/downloads/ and try again."
  echo "Creating virtual environment ..."
  rm -rf "$VENV"
  "$PY" -m venv "$VENV" || die "Could not create the virtual environment."
fi
VPY="$(find_venv_py)" || die "The .venv is broken. Delete the '.venv' folder next to this file and run again."

# 3) dependencies (first run only) -------------------------------------------
if ! "$VPY" -c "import fastapi, uvicorn" >/dev/null 2>&1; then
  echo "Installing dependencies (first run only) ..."
  "$VPY" -m ensurepip --upgrade >/dev/null 2>&1 || true
  "$VPY" -m pip install --upgrade pip >/dev/null 2>&1 || true
  "$VPY" -m pip install -r requirements.txt || die "Dependency install failed (see the messages above)."
  git hash-object requirements.txt > "$VENV/.labhub-requirements" 2>/dev/null || true
fi

# 4) port: LABHUB_PORT, else config.json "port", else 8000 --------------------
PORT="${LABHUB_PORT:-$("$VPY" -c '
import json
try:
    print(int(json.load(open("config.json", encoding="utf-8")).get("port") or 8000))
except Exception:
    print(8000)
' 2>/dev/null)}"
PORT="${PORT:-8000}"
URL="http://localhost:${PORT}"

# Already running (e.g. a second double-click)? Just open it.
if curl -sf "${URL}/api/config" 2>/dev/null | grep -q '"labhub"'; then
  echo "Lab Hub is already running at ${URL} -- opening it."
  open "$URL" 2>/dev/null || true
  sleep 2
  exit 0
fi

# 5) start the server, open the browser, then wait ---------------------------
echo
echo "Starting Lab Hub on ${URL} ..."
"$VPY" -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT" --no-access-log &
SERVER_PID=$!
trap 'echo; echo "Stopping ..."; kill "$SERVER_PID" 2>/dev/null; exit 0' INT TERM HUP

# wait until it answers, then open the default browser
up=0
for _ in $(seq 1 60); do
  if curl -sf "${URL}/api/config" >/dev/null 2>&1; then up=1; break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 0.5
done
if [ "$up" = 1 ]; then
  open "$URL" 2>/dev/null || true
  echo
  echo "Lab Hub is running at ${URL}. Leave this window open."
  echo "Press Ctrl+C (or close this window) to stop."
else
  echo
  echo "The server did not answer on ${URL} -- see the messages above."
  echo "(Is port ${PORT} used by another program? Set a different \"port\" in config.json.)"
fi
wait "$SERVER_PID"
