"""Read a published Outlook / Microsoft 365 calendar (.ics) with zero deps.

In Outlook: Calendar -> Sharing & permissions -> publish the calendar and copy
the ICS link. Put that URL in config.json as "calendar_ics". A local .ics file
path also works (handy for testing / offline). This is read-only; upgrading to
the Microsoft Graph API (for auth'd or write access) can slot in behind the same
get_events() interface later.
"""
import os
import ssl
import urllib.request
from datetime import datetime, timedelta, timezone

from .config import CONFIG


def _fetch(source):
    if not source:
        return None
    if source.startswith("http://") or source.startswith("https://"):
        try:
            ctx = ssl.create_default_context()
            req = urllib.request.Request(source, headers={"User-Agent": "lab-hub/1.0"})
            with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:
                return resp.read().decode("utf-8", "replace")
        except Exception as exc:  # noqa: BLE001
            print(f"[calendar] fetch failed: {exc}")
            return None
    if os.path.exists(source):
        try:
            with open(source, encoding="utf-8", errors="replace") as f:
                return f.read()
        except Exception as exc:  # noqa: BLE001
            print(f"[calendar] read failed: {exc}")
    return None


def _unfold(text):
    """ICS folds long lines; continuations start with a space or tab."""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out = []
    for line in lines:
        if line[:1] in (" ", "\t") and out:
            out[-1] += line[1:]
        else:
            out.append(line)
    return out


def _parse_dt(value, params):
    v = value.strip()
    is_date = "VALUE=DATE" in params.upper() or (len(v) == 8 and "T" not in v)
    try:
        if v.endswith("Z"):
            dt = datetime.strptime(v, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
            return dt.astimezone().replace(tzinfo=None), False
        if "T" in v:
            return datetime.strptime(v, "%Y%m%dT%H%M%S"), False
        if len(v) == 8:
            return datetime.strptime(v, "%Y%m%d"), True
    except ValueError:
        return None, is_date
    return None, is_date


def get_events():
    source = CONFIG.get("calendar_ics")
    text = _fetch(source)
    if not text:
        return {"configured": bool(source), "events": []}

    events = []
    cur = None
    for line in _unfold(text):
        if line == "BEGIN:VEVENT":
            cur = {}
        elif line == "END:VEVENT":
            if cur is not None:
                events.append(cur)
            cur = None
        elif cur is not None and ":" in line:
            name, _, value = line.partition(":")
            key = name.split(";")[0].upper()
            params = name[len(key):]
            if key == "SUMMARY":
                cur["summary"] = value.replace("\\,", ",").replace("\\n", " ").strip()
            elif key == "LOCATION":
                cur["location"] = value.replace("\\,", ",").strip()
            elif key == "DTSTART":
                dt, all_day = _parse_dt(value, params)
                cur["start"] = dt
                cur["all_day"] = all_day

    now = datetime.now()
    horizon = now - timedelta(hours=3)
    upcoming = [e for e in events if e.get("start") and e["start"] >= horizon]
    upcoming.sort(key=lambda e: e["start"])

    out = []
    for e in upcoming[: CONFIG["calendar_max_events"]]:
        out.append(
            {
                "summary": e.get("summary", "(untitled)"),
                "location": e.get("location", ""),
                "start": e["start"].isoformat(),
                "all_day": bool(e.get("all_day")),
            }
        )
    return {"configured": True, "events": out}
