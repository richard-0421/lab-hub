#!/usr/bin/env bash
# Lab Hub dashboard launcher (macOS / Linux / Raspberry Pi). Creates a local
# .venv on first run, installs dependencies, then starts the web server.
# Calls the venv's python directly, so it never depends on a working 'activate'
# or on a bare 'python' being on PATH. Re-run any time to start the hub.
set -uo pipefail
cd "$(dirname "$0")"
VENV=".venv"

die() { echo "ERROR: $1" >&2; exit 1; }

PY=""
for cand in python3.12 python3.11 python3.13 python3.10 python3.9 python3 python3.14 python; do
  command -v "$cand" >/dev/null 2>&1 && { PY="$cand"; break; }
done
[ -n "$PY" ] || die "Python 3 not found. Install 3.9+ and retry."
echo "Using $PY"

find_venv_py() {
  for b in "$VENV/bin/python" "$VENV/bin/python3"; do
    [ -x "$b" ] && "$b" -c "import sys" >/dev/null 2>&1 && { echo "$b"; return 0; }
  done
  return 1
}
if ! find_venv_py >/dev/null 2>&1; then
  echo "Creating virtual environment ..."
  rm -rf "$VENV"
  "$PY" -m venv "$VENV" || die "could not create .venv"
fi
VPY="$(find_venv_py)" || die "the .venv is broken — delete the .venv folder and retry"

if ! "$VPY" -c "import fastapi, uvicorn" >/dev/null 2>&1; then
  echo "Installing dependencies (first run only) ..."
  "$VPY" -m ensurepip --upgrade >/dev/null 2>&1 || true
  "$VPY" -m pip install --upgrade pip >/dev/null 2>&1 || true
  "$VPY" -m pip install -r requirements.txt || die "dependency install failed"
fi

PORT="${LABHUB_PORT:-8000}"
echo "Starting Lab Hub on http://0.0.0.0:${PORT}  (Ctrl+C to stop)"
exec "$VPY" -m uvicorn app.main:app --host 0.0.0.0 --port "$PORT"
