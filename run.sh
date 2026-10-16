#!/usr/bin/env bash
# Lab Hub launcher (macOS / Linux / Raspberry Pi).
#
#   ./run.sh                  make .venv if needed, install deps, start the server
#   ./run.sh --port 9000      override the port (also --host 127.0.0.1)
#   ./run.sh --access-log     log every HTTP request (off by default: the
#                             kiosk polls every few seconds)
#   ./run.sh --service        what systemd runs: never creates or repairs .venv,
#                             just starts the server (fails fast if .venv is bad)
#
# Bind address: --host/--port  >  LABHUB_HOST/LABHUB_PORT  >  config.json
# "host"/"port"  >  0.0.0.0:8000.
#
# Calls the venv's python by path, so it never depends on 'activate' or on a
# bare 'python' being on PATH, and works from folders with spaces in the name.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
VENV=".venv"

die() { echo "ERROR: $*" >&2; exit 1; }

SERVICE=0
ACCESS_LOG=0
ARG_HOST=""
ARG_PORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --service)    SERVICE=1 ;;
    --access-log) ACCESS_LOG=1 ;;
    --host)       [ $# -ge 2 ] || die "--host needs a value"; ARG_HOST="$2"; shift ;;
    --host=*)     ARG_HOST="${1#*=}" ;;
    --port)       [ $# -ge 2 ] || die "--port needs a value"; ARG_PORT="$2"; shift ;;
    --port=*)     ARG_PORT="${1#*=}" ;;
    -h|--help)    sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

# A python is usable if it is Python 3.9+.
py_ok() { "$1" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; }

find_venv_py() {
  for b in "$VENV/bin/python" "$VENV/bin/python3"; do
    [ -x "$b" ] && py_ok "$b" && { echo "$b"; return 0; }
  done
  return 1
}

if [ "$SERVICE" = 1 ]; then
  VPY="$(find_venv_py)" ||
    die "no working $PWD/$VENV (Python 3.9+). Run ./scripts/install-pi.sh to create it."
  "$VPY" -c "import fastapi, uvicorn" >/dev/null 2>&1 ||
    die "fastapi/uvicorn missing from $PWD/$VENV. Run ./scripts/install-pi.sh to reinstall."
else
  PY=""
  for cand in python3.12 python3.11 python3.13 python3.10 python3.9 python3 python3.14 python; do
    command -v "$cand" >/dev/null 2>&1 && py_ok "$cand" && { PY="$cand"; break; }
  done

  if ! find_venv_py >/dev/null 2>&1; then
    [ -n "$PY" ] || die "Python 3.9+ not found. Install it (Pi: sudo apt install python3 python3-venv) and retry."
    echo "Creating virtual environment with $PY ..."
    rm -rf "$VENV"
    "$PY" -m venv "$VENV" ||
      die "could not create .venv (on Debian / Raspberry Pi OS: sudo apt install python3-venv)"
  fi
  VPY="$(find_venv_py)" || die "the .venv is broken: delete the .venv folder and retry"

  if ! "$VPY" -c "import fastapi, uvicorn" >/dev/null 2>&1; then
    echo "Installing dependencies (first run only) ..."
    "$VPY" -m ensurepip --upgrade >/dev/null 2>&1 || true
    "$VPY" -m pip install --upgrade pip >/dev/null 2>&1 || true
    "$VPY" -m pip install -r requirements.txt || die "dependency install failed"
    # Lets scripts/update.sh know these deps match requirements.txt.
    git hash-object requirements.txt > "$VENV/.labhub-requirements" 2>/dev/null || true
  fi
fi

# cfg KEY DEFAULT -> value of KEY in config.json, or DEFAULT if missing/empty.
cfg() {
  "$VPY" - "$1" "$2" <<'PY' 2>/dev/null || printf '%s\n' "$2"
import json, sys
key, default = sys.argv[1], sys.argv[2]
try:
    with open("config.json", encoding="utf-8") as f:
        value = json.load(f).get(key)
except Exception:
    value = None
print(default if value is None or value == "" else value)
PY
}

# Ask the app's own config loader first (same env/alias/LABHUB_CONFIG rules as
# the server); fall back to reading config.json directly.
CFG_HOST=""; CFG_PORT=""
if CFG_OUT="$("$VPY" -m app.config host port 2>/dev/null)"; then
  CFG_HOST="$(printf '%s\n' "$CFG_OUT" | sed -n 1p)"
  CFG_PORT="$(printf '%s\n' "$CFG_OUT" | sed -n 2p)"
fi
[ -n "$CFG_HOST" ] || CFG_HOST="${LABHUB_HOST:-$(cfg host 0.0.0.0)}"
[ -n "$CFG_PORT" ] || CFG_PORT="${LABHUB_PORT:-$(cfg port 8000)}"
HOST="${ARG_HOST:-$CFG_HOST}"
PORT="${ARG_PORT:-$CFG_PORT}"
case "$PORT" in
  ''|*[!0-9]*) die "port must be a number, got '$PORT'" ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then die "port out of range: $PORT"; fi

LOG_FLAG="--no-access-log"
[ "$ACCESS_LOG" = 1 ] && LOG_FLAG="--access-log"

if [ "$SERVICE" = 1 ]; then
  echo "Starting Lab Hub on ${HOST}:${PORT}"
else
  echo "Starting Lab Hub on http://${HOST}:${PORT}   (Ctrl+C to stop)"
  [ "$HOST" = "0.0.0.0" ] && echo "Open http://localhost:${PORT} here, or http://<this-machine's-IP>:${PORT} from another device."
fi
exec "$VPY" -m uvicorn app.main:app --host "$HOST" --port "$PORT" "$LOG_FLAG"
