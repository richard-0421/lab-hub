#!/usr/bin/env bash
# Open the dashboard fullscreen in Chromium on the Pi's display.
# Waits for the web server to answer, then launches the browser in kiosk mode.
set -u
URL="${LABHUB_URL:-http://localhost:8000}"

# wait until the server is up (max ~30s)
for _ in $(seq 1 30); do
  if command -v curl >/dev/null 2>&1 && curl -sf "$URL/api/config" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# pick whichever Chromium binary this Pi OS ships
BROWSER=""
for cand in chromium-browser chromium chromium-browser-v7; do
  command -v "$cand" >/dev/null 2>&1 && { BROWSER="$cand"; break; }
done
[ -n "$BROWSER" ] || { echo "Chromium not found. Install with: sudo apt install chromium-browser"; exit 1; }

# stop the display from blanking while the kiosk is up
command -v xset >/dev/null 2>&1 && { xset s off; xset -dpms; xset s noblank; }

exec "$BROWSER" \
  --kiosk \
  --incognito \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --check-for-update-interval=31536000 \
  --app="$URL"
