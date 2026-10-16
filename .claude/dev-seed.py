"""Seed a running Lab Hub test server with demo data and write a demo .ics (dev only)."""
import json, sys, urllib.request
from datetime import datetime, timedelta, timezone

base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765"
ics_path = sys.argv[2] if len(sys.argv) > 2 else None
now = datetime.now(timezone.utc)
local_now = datetime.now()

def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def day(n):
    return (local_now + timedelta(days=n)).strftime("%Y-%m-%d")

ops = []
def add(coll, item, ago_h=0, by="seed"):
    item = dict(item)
    item.setdefault("created_at", iso(now - timedelta(hours=ago_h)))
    ops.append({"op": "add", "coll": coll, "item": item, "ts": iso(now), "by": by})

tasks = [
    # todo
    dict(id="t-tips", title="Order 200 µL filtered pipette tips", status="todo", priority="high", assignee="Mei", due=day(0), tags=["order"], rank=1, created_by="Mei"),
    dict(id="t-confocal", title="Image sample batch C under the confocal", status="todo", priority="high", assignee="Priya", due=day(-2), tags=["imaging"], rank=2, notes="Use the 40x oil objective. Batch C is in the 4 °C fridge, top shelf.", created_by="Priya"),
    dict(id="t-calib", title="Calibrate syringe pump flow rate (0.1–5 mL/min sweep)", status="todo", priority="normal", assignee="Jordan", due=day(1), tags=["pump"], rank=3, notes="Log results to the shared calibration sheet.", created_by="Richard"),
    dict(id="t-book", title="Book confocal time for next week", status="todo", priority="normal", due=day(4), tags=["imaging"], rank=4, created_by="Priya"),
    dict(id="t-tubing", title="Replace tubing on the peristaltic pump", status="todo", priority="normal", assignee="Richard", due=day(9), tags=["pump"], rank=5, created_by="Richard"),
    dict(id="t-binder", title="Update the lab safety binder with new SDS sheets", status="todo", priority="low", rank=6, created_by="Mei"),
    # doing
    dict(id="t-videos", title="Analyze Hele-Shaw viscous fingering videos (runs 12–18)", status="doing", priority="high", assignee="Richard", due=day(3), tags=["imaging", "analysis"], rank=1, notes="Aperture pipeline, mode C. Compare transmittance vs. time.", created_by="Richard"),
    dict(id="t-methods", title="Write methods section draft", status="doing", priority="normal", assignee="Mei", due=day(7), tags=["paper"], rank=2, created_by="Mei"),
    dict(id="t-drive", title="Clean up shared drive folders", status="doing", priority="low", assignee="Jordan", rank=3, created_by="Jordan"),
    # done
    dict(id="t-gloves", title="Restock nitrile gloves (M, L)", status="done", priority="normal", assignee="Priya", tags=["order"], rank=7, done_at=iso(now - timedelta(hours=2)), created_by="Priya"),
    dict(id="t-valve", title="Fix leaking valve on rig 2", status="done", priority="high", assignee="Jordan", tags=["pump"], rank=8, done_at=iso(now - timedelta(hours=26)), created_by="Jordan"),
    dict(id="t-abstract", title="Submit abstract to APS DFD", status="done", priority="normal", assignee="Richard", rank=9, done_at=iso(now - timedelta(days=3)), created_by="Richard"),
]
for i, t in enumerate(tasks):
    add("tasks", t, ago_h=30 + i * 5)

requests = [
    dict(id="r-gloves", item="Nitrile gloves, size M", qty="4 boxes", requested_by="Priya", status="new", rank=1),
    dict(id="r-glycerol", item="Glycerol 99%", qty="2 L", requested_by="Richard", status="new", rank=2, link="https://www.sigmaaldrich.com/", notes="For the viscosity-ratio runs."),
    dict(id="r-filters", item="Syringe filters 0.22 µm", qty="1 pack", requested_by="Mei", status="ordered", rank=3),
    dict(id="r-tubing", item='Silicone tubing 1/8" ID', qty="10 ft", requested_by="Jordan", status="ordered", rank=4),
    dict(id="r-kimwipes", item="Kimwipes", qty="1 case", requested_by="Mei", status="received", rank=5),
]
for i, r in enumerate(requests):
    add("requests", r, ago_h=4 + i * 20)

notes = [
    dict(id="n-rig2", body="Rig 2 is reserved Thu–Fri for Priya's imaging run. Please don't move the camera!", author="Priya", pinned=True, color="yellow"),
    dict(id="n-room", body="Group meeting is in Room 304 this week.", author="Richard", color="blue"),
    dict(id="n-pump", body="Pump calibration data lives in /shared/pump/2026-10 — use the new CSV template.", author="Jordan", color="green"),
    dict(id="n-pizza", body="Leftover pizza in the kitchen, help yourselves 🍕", author="Mei", color="pink"),
]
for i, n in enumerate(notes):
    add("notes", n, ago_h=1 + i * 18)

req = urllib.request.Request(base + "/api/ops", data=json.dumps({"ops": ops}).encode(), headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req) as r:
    out = json.load(r)
print("rev", out["rev"], "tasks", len(out["board"]["tasks"]), "requests", len(out["board"]["requests"]), "notes", len(out["board"]["notes"]))

if ics_path:
    def f(dt):
        return dt.strftime("%Y%m%dT%H%M%S")
    t0 = local_now.replace(minute=0, second=0, microsecond=0)
    evs = [
        ("Group meeting", "Room 304", t0, t0 + timedelta(hours=1), False),
        ("Confocal training", "Imaging core, B12", t0 + timedelta(hours=1, minutes=30), t0 + timedelta(hours=2, minutes=30), False),
        ("Lab cleanup day", "", local_now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1), None, True),
        ("Journal club: Saffman–Taylor revisited", "Room 210", (t0 + timedelta(days=1)).replace(hour=10), (t0 + timedelta(days=1)).replace(hour=11), False),
        ("1:1 with Richard", "", (t0 + timedelta(days=3)).replace(hour=14), (t0 + timedelta(days=3)).replace(hour=14, minute=30), False),
    ]
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//labhub demo//EN"]
    for i, (s, loc, st, en, allday) in enumerate(evs):
        lines += ["BEGIN:VEVENT", "UID:demo-%d" % i, "SUMMARY:" + s.replace(",", "\\,")]
        if loc:
            lines.append("LOCATION:" + loc.replace(",", "\\,"))
        if allday:
            lines.append("DTSTART;VALUE=DATE:" + st.strftime("%Y%m%d"))
            lines.append("DTEND;VALUE=DATE:" + (st + timedelta(days=1)).strftime("%Y%m%d"))
        else:
            lines.append("DTSTART:" + f(st))
            lines.append("DTEND:" + f(en))
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    with open(ics_path, "w") as fh:
        fh.write("\r\n".join(lines) + "\r\n")
    print("wrote", ics_path)
