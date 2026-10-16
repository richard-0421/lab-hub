#!/usr/bin/env bash
# Local test server for Lab Hub (dev only — nothing here touches real GitHub).
#   :8000  the dashboard as the Pi runs it, syncing to a mock GitHub
#   :9010  mock GitHub API (tests/mock_github.py, token "dev-token")
#   :8001  static/ served plainly = the GitHub Pages copy
# Every start is fresh: new state dir, freshly seeded demo board.
set -uo pipefail
cd "$(dirname "$0")/.."
PY=.venv/bin/python
DEV=.claude/dev
rm -rf "$DEV"; mkdir -p "$DEV"

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null; wait 2>/dev/null; }
trap cleanup EXIT INT TERM

"$PY" tests/mock_github.py --host 127.0.0.1 --port 9010 \
  --repo richard-0417/lab-hub --token dev-token > "$DEV/mock.log" 2>&1 &
pids+=($!)
"$PY" -m http.server --bind 127.0.0.1 --directory static 8001 > "$DEV/pages.log" 2>&1 &
pids+=($!)

env LABHUB_CONFIG=/nonexistent-config.json \
    LABHUB_STATE_DIR="$DEV/state" \
    LABHUB_DB_PATH=/nonexistent.db \
    LABHUB_NAME="Lab Hub (test)" \
    LABHUB_CALENDAR_ICS="$PWD/$DEV/cal.ics" \
    LABHUB_GITHUB_REPO=richard-0417/lab-hub \
    LABHUB_GITHUB_TOKEN=dev-token \
    LABHUB_GITHUB_API=http://127.0.0.1:9010 \
    LABHUB_SYNC_INTERVAL=5 \
  "$PY" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 &
pids+=($!)

for _ in $(seq 1 60); do
  curl -sf http://127.0.0.1:8000/api/config >/dev/null 2>&1 && break
  sleep 0.25
done
"$PY" .claude/dev-seed.py http://127.0.0.1:8000 "$PWD/$DEV/cal.ics"
echo
echo "Dashboard (Pi mode):     http://127.0.0.1:8000/"
echo "GitHub Pages mode:       http://127.0.0.1:8001/?api=http://127.0.0.1:9010&repo=richard-0417/lab-hub   (token: dev-token)"
echo "Mock GitHub board.json:  http://127.0.0.1:9010/_mock/file?branch=data&path=board.json"
wait
