# Lab Hub dashboard

A single always-on dashboard for the pFLARES subgroup, built to run on the lab
Raspberry Pi and shown fullscreen in a browser. It:

- shows a **live monitor** of the pFLARES tracker (water level + T1–T4), reading
  the CSV the tracker writes, and can **launch / stop** the tracker;
- displays your **Outlook / Microsoft 365 calendar**;
- lets the team keep a **task list**, an **item-request queue**, and a shared
  **notes board** (typed at the screen, or from any device on the lab network);
- has a big **clock**, date, and hardware-health badges.

It sits next to the `pFLARE data collector` folder and reads that folder's CSVs —
no changes to the tracker are needed.

## Quick start (any machine, to try it)

```bash
cd lab-hub
./run.sh
```

First run makes a `.venv`, installs `fastapi` + `uvicorn`, and serves the
dashboard at <http://localhost:8000>. Open that in a browser. On the Pi it's
reachable from teammates' laptops/phones too, at `http://<pi-ip>:8000`.

The only dependencies are `fastapi` and `uvicorn`; everything else (SQLite,
calendar parsing, sparklines) uses the standard library / plain JavaScript, so
it works offline on a locked-down lab network.

## Configure it

Copy `config.example.json` to `config.json` and edit. All keys are optional.

| key | meaning | default |
|-----|---------|---------|
| `subgroup_name` | title shown in the header | `pFLARES subgroup` |
| `port` | web server port | `8000` |
| `data_dir` | folder the tracker writes CSVs to (relative to `lab-hub/`) | `../pFLARE data collector` |
| `csv_glob` | which CSVs to watch | `water_level_*.csv` |
| `monitor_points` | points kept in the live sparkline | `60` |
| `stale_seconds` | CSV newer than this ⇒ shown as "recording" | `12` |
| `calendar_ics` | published Outlook `.ics` URL (or a local `.ics` path) | *(empty)* |
| `calendar_max_events` | events shown | `6` |
| `tracker_cmd` | override command used to launch the tracker | *(auto)* |

Every key can also be set via an environment variable, e.g.
`LABHUB_PORT=9000` or `LABHUB_CALENDAR_ICS="https://outlook.office365.com/.../calendar.ics"`.

### Calendar (Outlook / M365)

In Outlook on the web: **Calendar → Settings → Shared calendars → Publish a
calendar**, choose the calendar, pick "Can view all details", and copy the
**ICS** link. Paste it into `config.json` as `calendar_ics`. That's read-only and
needs no login on the Pi — ideal for a shared screen. (If you later want to
create events from the dashboard, that means switching to the Microsoft Graph
API; the code isolates calendar access in `app/calendar_feed.py` so it can be
swapped without touching the rest.)

## The live monitor

The monitor reads the newest `water_level_*.csv` in `data_dir` and shows the
latest level, the four thermocouples, a rolling sparkline, and a **recording**
badge (lit when the CSV is being written to right now). This works whether the
tracker was started from its own GUI or from the dashboard.

- **Launch tracker** runs the pFLARES `run.sh` (falls back to
  `python3 water_level_gui.py`) as a subprocess on the Pi. Use the tracker's own
  window to aim the camera, set the ROI, and calibrate — that proven flow is
  unchanged. **Stop** ends that process.
- Health badges are inferred safely without grabbing the camera/serial port:
  *logging* = the CSV is fresh, *meter* = recent rows carry temperatures,
  *camera* = logging or the tracker process is running.

## Run it as a kiosk on the Pi (autostart on boot)

1. Copy the `lab-hub` folder to a path **without spaces**, e.g. `/home/pi/lab-hub`,
   and run `./run.sh` once so the `.venv` and `config.json` exist.
2. **Backend as a service** — edit the paths/user in
   `systemd/lab-hub.service`, then:
   ```bash
   sudo cp systemd/lab-hub.service /etc/systemd/system/
   sudo systemctl enable --now lab-hub
   ```
3. **Fullscreen browser on login** — make `kiosk.sh` executable and copy the
   autostart entry (edit its path first):
   ```bash
   chmod +x kiosk.sh run.sh
   mkdir -p ~/.config/autostart
   cp systemd/lab-hub-kiosk.desktop ~/.config/autostart/
   ```
   On the next desktop login Chromium opens the dashboard fullscreen. `kiosk.sh`
   waits for the server, disables screen blanking, and launches in kiosk mode.
   Install Chromium if needed: `sudo apt install chromium-browser`.

To exit kiosk mode: `Alt+F4`, or `Ctrl+Alt+F2` to a console and stop it.

## Layout / structure

```
lab-hub/
  app/
    main.py           FastAPI app + all /api routes
    config.py         config.json + env loading
    db.py             SQLite (tasks / requests / notes)
    monitor.py        CSV tailing + tracker launch/stop + health
    calendar_feed.py  Outlook .ics fetch + parse
  static/
    index.html  style.css  app.js   (dark, responsive, no external libraries)
  systemd/            service + kiosk autostart
  run.sh  kiosk.sh  requirements.txt  config.example.json
```

## API (for reference / extending)

`GET /api/config` · `GET|POST /api/tasks`, `PATCH|DELETE /api/tasks/{id}` ·
`GET|POST /api/requests`, `PATCH|DELETE /api/requests/{id}` ·
`GET|POST /api/notes`, `PATCH|DELETE /api/notes/{id}` ·
`GET /api/monitor` · `GET /api/health` · `GET /api/calendar` ·
`GET /api/tracker/status`, `POST /api/tracker/launch`, `POST /api/tracker/stop`.
