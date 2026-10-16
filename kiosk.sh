#!/usr/bin/env bash
# Opens Lab Hub fullscreen in Chromium on the Pi's own screen (X11 or Wayland).
#
# Started at login by ~/.config/autostart/lab-hub-kiosk.desktop and, on labwc /
# wayfire desktops, by their autostart files (scripts/install-pi.sh sets these
# up). Several of those may fire at once, so only one copy ever runs.
#
#   LABHUB_URL          page to open (default http://localhost:<port>; the port
#                       comes from the app's config loader like run.sh: config.json
#                       or $LABHUB_CONFIG, LABHUB_PORT in this session, else 8000.
#                       /etc/default/lab-hub is NOT seen here: keep the port in
#                       config.json)
#   LABHUB_KIOSK_FLAGS  extra Chromium flags, space-separated
#                       (e.g. "--force-device-scale-factor=1.25")
#   ~/.config/lab-hub-kiosk.flags   the same, kept in a file (one or more flags
#                       per line, # comments allowed) — easier for autostart
#
# Leave the kiosk: Alt+F4 closes it (or Ctrl+Alt+T for a terminal, then
# `pkill -f lab-hub-kiosk`). Bring it back from a terminal with
#   setsid -f ~/lab-hub/kiosk.sh >/dev/null 2>&1
# (setsid, not "&": a background job dies when its terminal window closes).
# Don't edit this file on the Pi: local changes pause the auto-updater.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

# --- one copy only ----------------------------------------------------------
LOCK="${XDG_RUNTIME_DIR:-/tmp}/lab-hub-kiosk.lock"
if command -v flock >/dev/null 2>&1 && { exec 9>"$LOCK"; } 2>/dev/null; then
  if ! flock -n 9; then
    echo "lab-hub kiosk is already running"
    exit 0
  fi
fi

# --- which URL --------------------------------------------------------------
URL="${LABHUB_URL:-}"
if [ -z "$URL" ]; then
  PORT=""
  if [ -x .venv/bin/python ]; then
    PORT="$(.venv/bin/python -m app.config port 2>/dev/null || true)"
    case "$PORT" in *[!0-9]*) PORT="" ;; esac
  fi
  [ -n "$PORT" ] || PORT="${LABHUB_PORT:-}"
  if [ -z "$PORT" ] && command -v python3 >/dev/null 2>&1; then
    PORT="$(python3 -c '
import json
try:
    print(int(json.load(open("config.json", encoding="utf-8")).get("port") or 8000))
except Exception:
    print(8000)
' 2>/dev/null)"
  fi
  URL="http://localhost:${PORT:-8000}"
fi

# --- wait for the server (up to ~2 min; the Pi may still be booting) ---------
server_up() {
  if command -v curl >/dev/null 2>&1; then
    curl -sf -o /dev/null --max-time 3 "$URL/api/config"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=3)' \
      "$URL/api/config" >/dev/null 2>&1
  else
    sleep 20   # no way to check; give the service a head start
  fi
}
for _ in $(seq 1 120); do
  server_up && break
  sleep 1
done

# --- find Chromium (Raspberry Pi OS ships one of these names) ----------------
BROWSER=""
for cand in chromium-browser chromium; do
  command -v "$cand" >/dev/null 2>&1 && { BROWSER="$cand"; break; }
done
if [ -z "$BROWSER" ]; then
  echo "Chromium not found. Install it with: sudo apt install chromium-browser   (or: chromium)" >&2
  exit 1
fi

# --- keep the screen on -------------------------------------------------------
# X11 (Bullseye / "X11" option in raspi-config): xset works directly.
# Wayland (Bookworm wayfire / labwc): xset has no effect. Turn blanking off with
#   sudo raspi-config  ->  Display Options  ->  Screen Blanking  ->  No
# (wayfire: or set  [idle] dpms_timeout = -1  in ~/.config/wayfire.ini).
if command -v xset >/dev/null 2>&1 && [ -n "${DISPLAY:-}" ]; then
  xset s off 2>/dev/null || true
  xset -dpms 2>/dev/null || true
  xset s noblank 2>/dev/null || true
fi

# --- launch -----------------------------------------------------------------
# A dedicated profile dir makes this a separate Chromium instance, so the flags
# below apply even if someone already has a normal Chromium window open.
PROFILE="${XDG_CONFIG_HOME:-$HOME/.config}/lab-hub-kiosk"
mkdir -p "$PROFILE" 2>/dev/null || true

FLAGS=(
  --kiosk
  --app="$URL"
  --incognito
  --user-data-dir="$PROFILE"
  --no-first-run
  --noerrdialogs
  --disable-infobars
  --disable-session-crashed-bubble
  --password-store=basic
  --check-for-update-interval=31536000
  --ozone-platform-hint=auto
  # touch screen: no swipe-to-go-back, no pinch zoom, no translate popups
  --overscroll-history-navigation=0
  --disable-pinch
  --disable-features=Translate
)
FLAGS_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/lab-hub-kiosk.flags"
EXTRA="${LABHUB_KIOSK_FLAGS:-}"
if [ -f "$FLAGS_FILE" ]; then
  EXTRA="$EXTRA $(sed -e 's/#.*//' "$FLAGS_FILE" | tr '\n' ' ')"
fi
if [ -n "${EXTRA// /}" ]; then
  # Intentionally split on whitespace (globbing off so '*' stays literal).
  set -f
  # shellcheck disable=SC2206
  FLAGS+=( $EXTRA )
  set +f
fi

echo "lab-hub kiosk: opening $URL with $BROWSER"
exec "$BROWSER" "${FLAGS[@]}"
