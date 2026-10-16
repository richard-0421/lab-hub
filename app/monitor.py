"""pFLARES live monitor + tracker control.

The dashboard does not reimplement the camera/serial logic. It reads the CSV
that the existing tracker writes (columns: timestamp_iso, elapsed_s, level_mm,
surface_y_px, T1..T4) and can launch/stop the tracker as a subprocess. This is
the low-risk "Option B" from the design proposal: the proven GUI stays in charge
of aiming/calibration, and this turns its output into a glanceable live panel.
"""
import csv
import glob
import os
import subprocess
import time

from .config import CONFIG

_tracker_proc = None  # module-level handle for the launched tracker


def _to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def find_latest_csv():
    data_dir = CONFIG["data_dir"]
    if not os.path.isdir(data_dir):
        return None
    files = glob.glob(os.path.join(data_dir, CONFIG["csv_glob"]))
    if not files:
        files = glob.glob(os.path.join(data_dir, "*.csv"))
    if not files:
        return None
    return max(files, key=os.path.getmtime)


def read_monitor():
    path = find_latest_csv()
    if not path:
        return {"available": False, "reason": "no CSV found", "data_dir": CONFIG["data_dir"]}

    rows = []
    try:
        with open(path, newline="", encoding="utf-8", errors="replace") as f:
            for row in csv.DictReader(f):
                rows.append(row)
    except Exception as exc:  # noqa: BLE001
        return {"available": False, "reason": f"read error: {exc}", "file": os.path.basename(path)}

    if not rows:
        return {"available": False, "reason": "CSV empty", "file": os.path.basename(path)}

    recent = rows[-CONFIG["monitor_points"]:]
    latest = rows[-1]

    def series(key):
        return [_to_float(r.get(key)) for r in recent]

    temps = {t: _to_float(latest.get(t)) for t in ("T1", "T2", "T3", "T4")}

    mtime = os.path.getmtime(path)
    age = time.time() - mtime

    return {
        "available": True,
        "file": os.path.basename(path),
        "sample_count": len(rows),
        "level_mm": _to_float(latest.get("level_mm")),
        "elapsed_s": _to_float(latest.get("elapsed_s")),
        "temps": temps,
        "level_series": series("level_mm"),
        "recording": age <= CONFIG["stale_seconds"],
        "age_seconds": round(age, 1),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(mtime)),
    }


def tracker_status():
    running = _tracker_proc is not None and _tracker_proc.poll() is None
    return {"running": running, "pid": _tracker_proc.pid if running else None}


def read_tracker_log(limit=4000):
    try:
        with open(CONFIG["tracker_log"], encoding="utf-8", errors="replace") as f:
            return f.read()[-limit:]
    except Exception:
        return ""


def launch_tracker():
    global _tracker_proc
    if _tracker_proc is not None and _tracker_proc.poll() is None:
        return {"running": True, "pid": _tracker_proc.pid, "message": "already running"}

    data_dir = CONFIG["data_dir"]
    if not os.path.isdir(data_dir):
        return {"running": False, "error": f"data_dir not found: {data_dir}"}

    # A GUI subprocess needs an X display. When the backend runs as a service or
    # over SSH there is none, so fall back to the configured one (":0" on a Pi).
    env = dict(os.environ)
    if not env.get("DISPLAY"):
        env["DISPLAY"] = CONFIG.get("tracker_display") or ":0"

    override = CONFIG.get("tracker_cmd") or ""
    if override:
        args, shell = override, True
    else:
        run_sh = os.path.join(data_dir, "run.sh")
        if os.path.exists(run_sh):
            args, shell = ["bash", run_sh], False
        else:
            args, shell = ["python3", os.path.join(data_dir, "water_level_gui.py")], False

    try:
        logf = open(CONFIG["tracker_log"], "w", encoding="utf-8")
        logf.write(f"launching: {args}\nDISPLAY={env.get('DISPLAY')}\ncwd={data_dir}\n\n")
        logf.flush()
        _tracker_proc = subprocess.Popen(
            args, cwd=data_dir, shell=shell, env=env, stdout=logf, stderr=subprocess.STDOUT
        )
    except Exception as exc:  # noqa: BLE001
        _tracker_proc = None
        return {"running": False, "error": str(exc)}

    # Give it a moment; if it dies instantly, surface why instead of pretending it started.
    time.sleep(1.3)
    if _tracker_proc.poll() is not None:
        code = _tracker_proc.returncode
        _tracker_proc = None
        return {
            "running": False,
            "error": f"tracker exited immediately (code {code})",
            "log": read_tracker_log(),
        }

    return {"running": True, "pid": _tracker_proc.pid, "display": env["DISPLAY"]}


def stop_tracker():
    global _tracker_proc
    if _tracker_proc is None or _tracker_proc.poll() is not None:
        _tracker_proc = None
        return {"running": False, "message": "not running"}
    try:
        _tracker_proc.terminate()
        try:
            _tracker_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _tracker_proc.kill()
    except Exception as exc:  # noqa: BLE001
        return {"error": str(exc)}
    _tracker_proc = None
    return {"running": False}


def health():
    """Best-effort hardware health inferred from the CSV + tracker process.

    We can't safely open the camera/serial port from here (only one process may
    hold them), so status is derived: fresh CSV => logging; recent rows carry
    temperatures => meter; camera OK if logging or the tracker process is up.
    """
    mon = read_monitor()
    logging = bool(mon.get("available") and mon.get("recording"))
    temps = mon.get("temps") or {}
    meter = bool(mon.get("available") and any(v is not None for v in temps.values()))
    ts = tracker_status()
    camera = logging or ts["running"]
    return {
        "camera": camera,
        "meter": meter,
        "logging": logging,
        "tracker_running": ts["running"],
    }
