"""Configuration loading for the Lab Hub dashboard.

Order of precedence (low -> high):
  1. DEFAULTS below
  2. config.json next to the lab-hub folder (optional; copy config.example.json)
  3. Environment variables named LABHUB_<KEY> (e.g. LABHUB_PORT, LABHUB_CALENDAR_ICS)
"""
import json
import os

# lab-hub/ (parent of the app package)
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DEFAULTS = {
    "subgroup_name": "pFLARES subgroup",
    "host": "0.0.0.0",
    "port": 8000,

    # Where the pFLARES tracker writes its CSVs. Relative paths resolve against BASE_DIR.
    "data_dir": os.path.join("..", "pFLARE data collector"),
    "csv_glob": "water_level_*.csv",
    "monitor_points": 60,          # points kept for the live sparkline
    "stale_seconds": 12,           # CSV newer than this => treated as "recording"

    # Published Outlook / M365 calendar as an .ics URL, or a local .ics path. Empty => off.
    "calendar_ics": "",
    "calendar_max_events": 6,

    # Optional override for how to launch the tracker. Empty => auto (run.sh, else GUI).
    "tracker_cmd": "",
    # X display the tracker window should open on (Pi kiosk is almost always :0).
    "tracker_display": ":0",
    # Where the tracker's launch output is captured so failures aren't silent.
    "tracker_log": os.path.join(BASE_DIR, "tracker_launch.log"),

    "db_path": os.path.join(BASE_DIR, "labhub.db"),
}


def _resolve_path(p):
    if not p:
        return p
    return p if os.path.isabs(p) else os.path.abspath(os.path.join(BASE_DIR, p))


def load_config():
    cfg = dict(DEFAULTS)

    path = os.path.join(BASE_DIR, "config.json")
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                user = json.load(f)
            cfg.update({k: v for k, v in user.items() if v is not None})
        except Exception as exc:  # noqa: BLE001
            print(f"[config] could not parse config.json: {exc}")

    for key in list(cfg.keys()):
        env = os.environ.get("LABHUB_" + key.upper())
        if env is not None:
            if isinstance(DEFAULTS.get(key), int):
                try:
                    env = int(env)
                except ValueError:
                    pass
            cfg[key] = env

    # normalise paths
    cfg["data_dir"] = _resolve_path(cfg["data_dir"])
    cfg["db_path"] = _resolve_path(cfg["db_path"])
    cfg["tracker_log"] = _resolve_path(cfg["tracker_log"])
    if cfg.get("calendar_ics") and not (
        cfg["calendar_ics"].startswith("http://") or cfg["calendar_ics"].startswith("https://")
    ):
        # treat a non-URL calendar source as a (possibly relative) local file
        cfg["calendar_ics"] = _resolve_path(cfg["calendar_ics"])

    return cfg


CONFIG = load_config()
