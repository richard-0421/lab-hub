#!/usr/bin/env bash
# Double-click (macOS) to install dependencies, start the Lab Hub dashboard,
# and open it in your browser. Close this Terminal window or press Ctrl+C to stop.
#
# First time, macOS may block it: right-click the file -> Open -> Open. If it
# opens in a text editor instead of running, run this once in Terminal:
#   chmod +x "Start Lab Hub.command"
set -uo pipefail
cd "$(dirname "$0")"

echo "===================================="
echo "  Lab Hub dashboard"
echo "===================================="
echo

PORT="${LABHUB_PORT:-8000}"
URL="http://localhost:${PORT}"
VENV=".venv"

die() { echo; echo "ERROR: $1"; echo;
        read -r -p "Press Return to close..." _; exit 1; }

# 1) find a usable Python 3 ---------------------------------------------------
PY=""
for cand in python3.12 python3.11 python3.13 python3.10 python3.9 python3 python3.14 python; do
  command -v "$cand" >/dev/null 2>&1 || continue
  ver=$("$cand" -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null) || continue
  [ "${ver%%.*}" = "3" ] && { PY="$cand"; echo "Using $cand (Python $ver)"; break; }
done
[ -n "$PY" ] || die "No Python 3 found. Install 3.9+ from https://www.python.org/downloads/ and try again."

# 2) virtual environment -- call its python by path; never rely on 'activate' -
# (activate + the bare name 'python' is fragile: paths with spaces, set -u, and
#  stale symlinks all break it. Calling .venv/bin/python directly does not.)
find_venv_py() {
  for b in "$VENV/bin/python" "$VENV/bin/python3"; do
    [ -x "$b" ] && "$b" -c "import sys" >/dev/null 2>&1 && { echo "$b"; return 0; }
  done
  return 1
}
if ! find_venv_py >/dev/null 2>&1; then
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
fi

# 4) start the server, open the browser, then wait ---------------------------
echo
echo "Starting Lab Hub on ${URL} ..."
"$VPY" -m uvicorn app.main:app --host 127.0.0.1 --port "$PORT" &
SERVER_PID=$!
trap 'echo; echo "Stopping ..."; kill "$SERVER_PID" 2>/dev/null; exit 0' INT TERM

# wait until it answers, then open the default browser
for _ in $(seq 1 40); do
  curl -sf "${URL}/api/config" >/dev/null 2>&1 && break
  sleep 0.5
done
open "$URL" 2>/dev/null || true

echo
echo "Dashboard is running. Leave this window open."
echo "Press Ctrl+C (or close this window) to stop."
wait "$SERVER_PID"
