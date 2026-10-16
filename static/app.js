"use strict";

const $ = (id) => document.getElementById(id);
let lastSeries = [];

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(path + " -> " + res.status);
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}
const jpost = (p, b) =>
  api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
const jpatch = (p, b) =>
  api(p, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
const jdelete = (p) => api(p, { method: "DELETE" });

function esc(s) {
  return (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
function fmtNum(v, d) {
  return v == null || isNaN(v) ? "--" : Number(v).toFixed(d);
}

/* ---------------- clock + config ---------------- */
function tickClock() {
  const n = new Date();
  $("clock").textContent =
    String(n.getHours()).padStart(2, "0") + ":" + String(n.getMinutes()).padStart(2, "0");
  $("date").textContent = n.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
}
async function loadConfig() {
  try {
    const c = await api("/api/config");
    if (c.subgroup_name) $("subgroup").textContent = c.subgroup_name;
  } catch (e) {}
  $("s-url").textContent = location.origin;
}

/* ---------------- tasks ---------------- */
async function loadTasks() {
  let tasks;
  try { tasks = await api("/api/tasks"); } catch (e) { return; }
  const box = $("tasks");
  box.innerHTML = "";
  if (!tasks.length) { box.innerHTML = '<p class="empty">No tasks yet.</p>'; return; }
  for (const t of tasks) {
    const el = document.createElement("div");
    el.className = "task" + (t.done ? " done" : "");
    el.innerHTML =
      `<div class="box" data-id="${t.id}" data-done="${t.done}">${t.done ? "✓" : ""}</div>` +
      `<span class="txt">${esc(t.text)}</span>` +
      `<span class="del" data-id="${t.id}">×</span>`;
    box.appendChild(el);
  }
  box.querySelectorAll(".box").forEach((b) => (b.onclick = async () => {
    await jpatch("/api/tasks/" + b.dataset.id, { done: b.dataset.done !== "1" });
    loadTasks();
  }));
  box.querySelectorAll(".del").forEach((d) => (d.onclick = async () => {
    await jdelete("/api/tasks/" + d.dataset.id);
    loadTasks();
  }));
}

/* ---------------- requests ---------------- */
const STATUS_NEXT = { new: "ordered", ordered: "done", done: "new" };
async function loadRequests() {
  let reqs;
  try { reqs = await api("/api/requests"); } catch (e) { return; }
  const box = $("requests");
  box.innerHTML = "";
  if (!reqs.length) { box.innerHTML = '<p class="empty">No requests.</p>'; return; }
  for (const r of reqs) {
    const el = document.createElement("div");
    el.className = "req";
    el.innerHTML =
      `<div class="req-main"><div class="req-item">${esc(r.item)}</div>` +
      (r.requested_by ? `<div class="req-by">${esc(r.requested_by)}</div>` : "") +
      `</div>` +
      `<span class="pill ${r.status}" data-id="${r.id}" data-status="${r.status}">${r.status}</span>` +
      `<span class="del" data-id="${r.id}">×</span>`;
    box.appendChild(el);
  }
  box.querySelectorAll(".pill").forEach((p) => (p.onclick = async () => {
    await jpatch("/api/requests/" + p.dataset.id, { status: STATUS_NEXT[p.dataset.status] });
    loadRequests();
  }));
  box.querySelectorAll(".del").forEach((d) => (d.onclick = async () => {
    await jdelete("/api/requests/" + d.dataset.id);
    loadRequests();
  }));
}

/* ---------------- notes ---------------- */
async function loadNotes() {
  let notes;
  try { notes = await api("/api/notes"); } catch (e) { return; }
  const box = $("notes");
  box.innerHTML = "";
  if (!notes.length) { box.innerHTML = '<p class="empty">No notes.</p>'; return; }
  for (const n of notes) {
    const el = document.createElement("div");
    el.className = "note" + (n.pinned ? " pinned" : "");
    el.innerHTML =
      `<div class="note-body">${esc(n.body)}</div>` +
      `<div class="note-foot"><span class="note-author">${n.author ? "— " + esc(n.author) : ""}</span>` +
      `<span class="note-actions">` +
      `<span class="act pin" data-id="${n.id}" data-pinned="${n.pinned}">${n.pinned ? "unpin" : "pin"}</span>` +
      `<span class="act del" data-id="${n.id}">delete</span></span></div>`;
    box.appendChild(el);
  }
  box.querySelectorAll(".pin").forEach((p) => (p.onclick = async () => {
    await jpatch("/api/notes/" + p.dataset.id, { pinned: p.dataset.pinned !== "1" });
    loadNotes();
  }));
  box.querySelectorAll(".del").forEach((d) => (d.onclick = async () => {
    await jdelete("/api/notes/" + d.dataset.id);
    loadNotes();
  }));
}

/* ---------------- calendar ---------------- */
function fmtEvent(iso, allDay) {
  const d = new Date(iso);
  const now = new Date();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  let day;
  if (d.toDateString() === now.toDateString()) day = "Today";
  else if (d.toDateString() === tomorrow.toDateString()) day = "Tomorrow";
  else day = d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  if (allDay) return day + " · all day";
  return day + " · " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
async function loadCalendar() {
  const box = $("calendar");
  try {
    const data = await api("/api/calendar");
    box.innerHTML = "";
    if (!data.configured) {
      box.innerHTML = '<p class="empty">Add your Outlook .ics link to config.json (calendar_ics).</p>';
      return;
    }
    if (!data.events.length) { box.innerHTML = '<p class="empty">No upcoming events.</p>'; return; }
    for (const e of data.events) {
      const el = document.createElement("div");
      el.className = "cal-item";
      el.innerHTML =
        `<div class="cal-sum">${esc(e.summary)}</div>` +
        `<div class="cal-meta">${fmtEvent(e.start, e.all_day)}${e.location ? " · " + esc(e.location) : ""}</div>`;
      box.appendChild(el);
    }
  } catch (e) {
    box.innerHTML = '<p class="empty">Calendar unavailable.</p>';
  }
}

/* ---------------- monitor ---------------- */
function drawSpark(canvas, series) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = canvas.clientHeight || 90;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const clean = series.filter((v) => v != null && !isNaN(v));
  if (clean.length < 2) return;
  let mn = Math.min(...clean), mx = Math.max(...clean);
  if (mn === mx) { mn -= 1; mx += 1; }
  const pad = 6, n = series.length;
  const X = (i) => pad + (w - 2 * pad) * (i / (n - 1));
  const Y = (v) => h - pad - (h - 2 * pad) * ((v - mn) / (mx - mn));
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < n; i++) {
    const v = series[i];
    if (v == null || isNaN(v)) continue;
    const px = X(i), py = Y(v);
    if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = "#4a9dff";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(X(n - 1), h - pad);
  ctx.lineTo(X(0), h - pad);
  ctx.closePath();
  ctx.fillStyle = "rgba(74,157,255,0.12)";
  ctx.fill();
}

async function loadMonitor() {
  let m;
  try { m = await api("/api/monitor"); } catch (e) { return; }
  const rb = $("rec-badge");
  if (!m.available) {
    $("level").textContent = "--";
    ["T1", "T2", "T3", "T4"].forEach((t) => ($(t).textContent = "--"));
    $("monitor-file").textContent = m.reason ? "No data — " + m.reason : "No CSV detected";
    rb.className = "rec idle";
    rb.removeAttribute("style");
    rb.textContent = "idle";
    lastSeries = [];
    drawSpark($("spark"), []);
    return;
  }
  $("level").textContent = fmtNum(m.level_mm, 1);
  ["T1", "T2", "T3", "T4"].forEach((t) => {
    const v = m.temps[t];
    $(t).textContent = v == null ? "--" : fmtNum(v, 1) + "°";
  });
  $("monitor-file").textContent = m.file + " · " + m.sample_count + " samples";
  if (m.recording) {
    rb.className = "rec";
    rb.style.background = "rgba(226,86,74,0.16)";
    rb.style.color = "#e2564a";
    rb.textContent = "● recording";
  } else {
    rb.className = "rec idle";
    rb.removeAttribute("style");
    rb.textContent = "idle";
  }
  lastSeries = m.level_series || [];
  drawSpark($("spark"), lastSeries);
  $("s-sample").textContent = "last sample " + (m.age_seconds != null ? Math.round(m.age_seconds) + "s ago" : "—");
  $("s-updated").textContent = "updated " + (m.updated_at ? m.updated_at.replace("T", " ") : "—");
}

async function loadHealth() {
  let h;
  try { h = await api("/api/health"); } catch (e) { return; }
  const set = (id, on) => ($(id).className = "badge" + (on ? " on" : ""));
  set("h-camera", h.camera);
  set("h-meter", h.meter);
  set("h-logging", h.logging);
}

/* ---------------- tracker buttons ---------------- */
function trackerMsg(text, cls, withLog) {
  const el = $("tracker-msg");
  el.className = "tracker-msg" + (cls ? " " + cls : "");
  el.textContent = text || "";
  if (withLog) {
    const a = document.createElement("span");
    a.className = "log-link";
    a.textContent = "view log";
    a.onclick = async () => {
      try {
        const r = await api("/api/tracker/log");
        alert(r.log && r.log.trim() ? r.log : "(launch log is empty)");
      } catch (e) { alert("Could not read log."); }
    };
    el.appendChild(a);
  }
}
function wireTracker() {
  $("btn-launch").onclick = async () => {
    const btn = $("btn-launch");
    btn.disabled = true;
    btn.textContent = "Launching…";
    trackerMsg("Starting tracker… (first run installs dependencies and can take a few minutes)");
    let r = null;
    try { r = await jpost("/api/tracker/launch"); } catch (e) { r = { error: String(e) }; }
    btn.disabled = false;
    btn.textContent = "Launch tracker";
    if (r && r.error) {
      trackerMsg("Launch failed: " + r.error + ".", "err", true);
    } else if (r && r.message) {
      trackerMsg(r.message + ".", "ok");
    } else {
      trackerMsg("Tracker running (pid " + r.pid + ") on display " + (r.display || "?") +
        ". Its window opens on the Pi's screen — if you're in kiosk mode it may be behind the browser.", "ok");
    }
    loadMonitor();
    loadHealth();
  };
  $("btn-stop").onclick = async () => {
    try { await jpost("/api/tracker/stop"); } catch (e) {}
    trackerMsg("Tracker stopped.", "");
    loadMonitor();
    loadHealth();
  };
}

/* ---------------- forms ---------------- */
function wireForms() {
  $("task-form").onsubmit = async (e) => {
    e.preventDefault();
    const v = $("task-input").value.trim();
    if (!v) return;
    await jpost("/api/tasks", { text: v });
    $("task-input").value = "";
    loadTasks();
  };
  $("req-form").onsubmit = async (e) => {
    e.preventDefault();
    const item = $("req-item").value.trim();
    if (!item) return;
    await jpost("/api/requests", { item, requested_by: $("req-by").value.trim() });
    $("req-item").value = "";
    loadRequests();
  };
  $("note-form").onsubmit = async (e) => {
    e.preventDefault();
    const body = $("note-body").value.trim();
    if (!body) return;
    await jpost("/api/notes", { body, author: $("note-author").value.trim() });
    $("note-body").value = "";
    loadNotes();
  };
}

/* ---------------- init ---------------- */
function init() {
  tickClock();
  setInterval(tickClock, 1000);
  loadConfig();
  wireForms();
  wireTracker();
  loadTasks();
  loadRequests();
  loadNotes();
  loadCalendar();
  loadMonitor();
  loadHealth();
  setInterval(loadMonitor, 3000);
  setInterval(loadHealth, 5000);
  setInterval(loadCalendar, 5 * 60 * 1000);
  setInterval(() => { loadTasks(); loadRequests(); loadNotes(); }, 15000);
  window.addEventListener("resize", () => drawSpark($("spark"), lastSeries));
}
document.addEventListener("DOMContentLoaded", init);
