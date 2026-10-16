"""Read a published Outlook / Microsoft 365 calendar (.ics) with zero deps.

In Outlook: Calendar -> Sharing & permissions -> publish the calendar and copy
the ICS link. Put that URL in config.json as "calendar_ics". A local .ics file
path also works (handy for testing / offline). Read-only.

Times are returned as naive *local* ISO strings (what the kiosk shows).
Recurring events (RRULE) are not expanded - only their first occurrence is
seen.
"""
import logging
import os
import ssl
import threading
import time
import urllib.request
from datetime import datetime, timedelta, timezone

log = logging.getLogger("labhub.calendar")

CACHE_SECONDS = 60          # don't refetch the feed more often than this
STALE_OK_SECONDS = 24 * 3600  # serve the last good copy this long when offline

_cache_lock = threading.Lock()
_cache = {"source": None, "at": 0.0, "text": None}


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
            log.warning("calendar fetch failed: %s", exc)
            return None
    if os.path.exists(source):
        try:
            with open(source, encoding="utf-8", errors="replace") as f:
                return f.read()
        except Exception as exc:  # noqa: BLE001
            log.warning("calendar read failed: %s", exc)
    return None


def _fetch_cached(source):
    now = time.time()
    with _cache_lock:
        if _cache["source"] == source and _cache["text"] is not None and now - _cache["at"] < CACHE_SECONDS:
            return _cache["text"]
    text = _fetch(source)
    with _cache_lock:
        if text is not None:
            _cache.update(source=source, at=now, text=text)
            return text
        if _cache["source"] == source and _cache["text"] is not None and now - _cache["at"] < STALE_OK_SECONDS:
            return _cache["text"]
    return None


def clear_cache():
    with _cache_lock:
        _cache.update(source=None, at=0.0, text=None)


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


def _unescape(value):
    return (
        value.replace("\\n", " ").replace("\\N", " ")
        .replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")
        .strip()
    )


def _parse_dt(value, params):
    """-> (naive local datetime or None, is_all_day)"""
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


def parse_events(text):
    """All VEVENTs in ``text`` as dicts {summary, location, start, end, all_day}
    (start/end are naive local datetimes; end may be None)."""
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
                cur["summary"] = _unescape(value)
            elif key == "LOCATION":
                cur["location"] = _unescape(value)
            elif key == "DTSTART":
                dt, all_day = _parse_dt(value, params)
                cur["start"] = dt
                cur["all_day"] = all_day
            elif key == "DTEND":
                dt, _ = _parse_dt(value, params)
                cur["end"] = dt
    return events


def get_events(cfg, now=None):
    """Body of GET /api/calendar:
    {"configured", "events": [{"summary", "location", "start", "end", "all_day"}]}"""
    source = cfg.get("calendar_ics") or ""
    max_events = cfg.get("calendar_max_events", 8)
    if not source:
        return {"configured": False, "events": []}
    text = _fetch_cached(source)
    if not text:
        return {"configured": True, "events": []}

    now = now or datetime.now()
    horizon = now - timedelta(hours=3)

    def keep(e):
        start = e.get("start")
        if not start:
            return False
        end = e.get("end")
        # upcoming, recently started, or still going on (e.g. an all-day event today)
        return start >= horizon or (end is not None and end > now)

    upcoming = [e for e in parse_events(text) if keep(e)]
    upcoming.sort(key=lambda e: e["start"])

    out = []
    for e in upcoming[: max(0, int(max_events))]:
        end = e.get("end")
        out.append(
            {
                "summary": e.get("summary") or "(untitled)",
                "location": e.get("location", ""),
                "start": e["start"].isoformat(),
                "end": end.isoformat() if end else None,
                "all_day": bool(e.get("all_day")),
            }
        )
    return {"configured": True, "events": out}
