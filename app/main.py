"""Lab Hub dashboard — FastAPI backend.

Serves the single-page UI and a small JSON API:
  /api/config                     dashboard title etc.
  /api/tasks       GET POST       task list; PATCH/DELETE /api/tasks/{id}
  /api/requests    GET POST       item requests; PATCH/DELETE /api/requests/{id}
  /api/notes       GET POST       notes board; PATCH/DELETE /api/notes/{id}
  /api/monitor     GET            live pFLARES level/temps + sparkline series
  /api/health      GET            camera/meter/logging status
  /api/calendar    GET            upcoming Outlook/M365 events
  /api/tracker/... POST/GET       launch / stop / status the tracker
"""
import os

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import calendar_feed, db, monitor
from .config import CONFIG

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(BASE_DIR, "static")

app = FastAPI(title="Lab Hub Dashboard")
db.init_db()


# --------------------------------------------------------------------------- #
# config
# --------------------------------------------------------------------------- #
@app.get("/api/config")
def api_config():
    return {"subgroup_name": CONFIG["subgroup_name"]}


# --------------------------------------------------------------------------- #
# tasks
# --------------------------------------------------------------------------- #
@app.get("/api/tasks")
def get_tasks():
    return db.query("SELECT * FROM tasks ORDER BY done ASC, id DESC")


@app.post("/api/tasks")
async def add_task(req: Request):
    body = await req.json()
    text = (body.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "text required"}, status_code=400)
    tid = db.execute(
        "INSERT INTO tasks(text, done, created_at) VALUES(?,0,?)",
        (text, db.now_iso()),
    )
    return {"id": tid}


@app.patch("/api/tasks/{tid}")
async def update_task(tid: int, req: Request):
    body = await req.json()
    if "done" in body:
        db.execute("UPDATE tasks SET done=? WHERE id=?", (1 if body["done"] else 0, tid))
    if "text" in body:
        db.execute("UPDATE tasks SET text=? WHERE id=?", ((body["text"] or "").strip(), tid))
    return {"ok": True}


@app.delete("/api/tasks/{tid}")
def delete_task(tid: int):
    db.execute("DELETE FROM tasks WHERE id=?", (tid,))
    return {"ok": True}


# --------------------------------------------------------------------------- #
# item requests
# --------------------------------------------------------------------------- #
@app.get("/api/requests")
def get_requests():
    return db.query(
        """
        SELECT * FROM requests
        ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'ordered' THEN 1 ELSE 2 END, id DESC
        """
    )


@app.post("/api/requests")
async def add_request(req: Request):
    body = await req.json()
    item = (body.get("item") or "").strip()
    if not item:
        return JSONResponse({"error": "item required"}, status_code=400)
    rid = db.execute(
        "INSERT INTO requests(item, requested_by, status, notes, created_at) VALUES(?,?,?,?,?)",
        (
            item,
            (body.get("requested_by") or "").strip(),
            "new",
            (body.get("notes") or "").strip(),
            db.now_iso(),
        ),
    )
    return {"id": rid}


@app.patch("/api/requests/{rid}")
async def update_request(rid: int, req: Request):
    body = await req.json()
    if "status" in body and body["status"] in ("new", "ordered", "done"):
        db.execute("UPDATE requests SET status=? WHERE id=?", (body["status"], rid))
    if "notes" in body:
        db.execute("UPDATE requests SET notes=? WHERE id=?", ((body["notes"] or "").strip(), rid))
    return {"ok": True}


@app.delete("/api/requests/{rid}")
def delete_request(rid: int):
    db.execute("DELETE FROM requests WHERE id=?", (rid,))
    return {"ok": True}


# --------------------------------------------------------------------------- #
# notes board
# --------------------------------------------------------------------------- #
@app.get("/api/notes")
def get_notes():
    return db.query("SELECT * FROM notes ORDER BY pinned DESC, id DESC")


@app.post("/api/notes")
async def add_note(req: Request):
    body = await req.json()
    text = (body.get("body") or "").strip()
    if not text:
        return JSONResponse({"error": "body required"}, status_code=400)
    nid = db.execute(
        "INSERT INTO notes(author, body, pinned, created_at) VALUES(?,?,?,?)",
        ((body.get("author") or "").strip(), text, 1 if body.get("pinned") else 0, db.now_iso()),
    )
    return {"id": nid}


@app.patch("/api/notes/{nid}")
async def update_note(nid: int, req: Request):
    body = await req.json()
    if "pinned" in body:
        db.execute("UPDATE notes SET pinned=? WHERE id=?", (1 if body["pinned"] else 0, nid))
    if "body" in body:
        db.execute("UPDATE notes SET body=? WHERE id=?", ((body["body"] or "").strip(), nid))
    return {"ok": True}


@app.delete("/api/notes/{nid}")
def delete_note(nid: int):
    db.execute("DELETE FROM notes WHERE id=?", (nid,))
    return {"ok": True}


# --------------------------------------------------------------------------- #
# pFLARES monitor + tracker control
# --------------------------------------------------------------------------- #
@app.get("/api/monitor")
def api_monitor():
    return monitor.read_monitor()


@app.get("/api/health")
def api_health():
    return monitor.health()


@app.get("/api/tracker/status")
def api_tracker_status():
    return monitor.tracker_status()


@app.post("/api/tracker/launch")
def api_tracker_launch():
    return monitor.launch_tracker()


@app.post("/api/tracker/stop")
def api_tracker_stop():
    return monitor.stop_tracker()


@app.get("/api/tracker/log")
def api_tracker_log():
    return {"log": monitor.read_tracker_log()}


# --------------------------------------------------------------------------- #
# calendar
# --------------------------------------------------------------------------- #
@app.get("/api/calendar")
def api_calendar():
    return calendar_feed.get_events()


# --------------------------------------------------------------------------- #
# static / SPA
# --------------------------------------------------------------------------- #
@app.get("/")
def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
