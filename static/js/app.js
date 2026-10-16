// Lab Hub — UI entry point.
//
// Boot: detect the mode (local = served by the Pi's API, github = anywhere
// else, e.g. GitHub Pages), create the matching data source, subscribe, and
// render everything from one requestAnimationFrame-batched pipeline.

import { emptyBoard } from "./board.js";
import {
  GitHubSource,
  LocalSource,
  clearGitHubSettings,
  defaultGitHubSettings,
  detectMode,
  loadGitHubSettings,
  saveGitHubSettings,
} from "./sources.js";
import { h, isTypingTarget } from "./ui/dom.js";
import { hydrateIcons, icon, spinner } from "./ui/icons.js";
import { initTheme, setDefaultTheme, toggleTheme } from "./ui/theme.js";
import { initHeader } from "./ui/header.js";
import { initTasks } from "./ui/tasks.js";
import { initRequests } from "./ui/requests.js";
import { initNotes } from "./ui/notes.js";
import { initCalendar } from "./ui/calendar.js";
import { initToasts, toast } from "./ui/toast.js";
import { openSetup } from "./ui/setup.js";
import { dialogOpen, openDialog } from "./ui/dialog.js";
import { dayKey, displayUrl, plural, relTime } from "./ui/format.js";
import { SORT_KEY, getName, pget, setName } from "./ui/prefs.js";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const phoneMql = window.matchMedia("(max-width: 699px)");
const isGithubHost = /\.github\.io$/i.test(location.hostname);
const isLoopback = (host) => /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/i.test(host) || /\.localhost$/i.test(host);

// ------------------------------------------------------------------ context
const savedSort = pget(SORT_KEY, "manual");
const ctx = {
  mode: null,
  config: null,
  settings: null,
  source: null,
  board: emptyBoard(),
  sync: null,
  loaded: false,
  canEdit: false,
  dragging: false,
  changedAt: 0,
  ui: { search: "", assignee: "", sort: ["priority", "due"].includes(savedSort) ? savedSort : "manual", tab: "todo" },
  /** The person using this browser (remembered), or "". */
  name() {
    return getName() || (ctx.settings && ctx.settings.clientName) || "";
  },
  /** `by` for ops; undefined lets the source fill in its client name. */
  by() {
    return ctx.name() || undefined;
  },
  isPhone: () => phoneMql.matches,
  knownNames() {
    const seen = new Map();
    const add = (n) => {
      const s = typeof n === "string" ? n.trim() : "";
      if (s && !seen.has(s.toLowerCase())) seen.set(s.toLowerCase(), s);
    };
    add(ctx.name());
    for (const t of ctx.board.tasks) {
      add(t.assignee);
      add(t.created_by);
    }
    for (const r of ctx.board.requests) add(r.requested_by);
    for (const n of ctx.board.notes) add(n.author);
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  },
  requestRender,
};

let header;
let tasks;
let requests;
let notes;
let calendar;
let unsubscribe = null;

// ------------------------------------------------------------------- render
let raf = 0;
function requestRender() {
  if (!raf) raf = requestAnimationFrame(renderAll);
}

function renderAll() {
  raf = 0;
  root.dataset.canEdit = ctx.canEdit ? "true" : "false";
  root.dataset.loaded = ctx.loaded ? "true" : "false";
  const qa = $("qa-input");
  qa.disabled = !ctx.canEdit;
  qa.placeholder = ctx.canEdit
    ? "Add a task…  @name  !high  #tag  ^fri"
    : ctx.mode === "github"
      ? "Read-only · tap to add a GitHub token"
      : "Connecting…";
  header.render();
  if (!ctx.dragging) tasks.render(); // never re-render the board mid-drag (dnd re-requests on drop)
  requests.render();
  notes.render();
  renderFooter();
}

function renderFooter() {
  const pages = $("foot-pages");
  const lan = $("foot-lan");
  const updated = $("foot-updated");
  if (ctx.mode === "local") {
    // Only advertise the Pages copy when edits made there actually reach this Pi.
    const gh = (ctx.config && ctx.config.github) || {};
    const url = gh.enabled && typeof gh.pages_url === "string" && /^https?:\/\//i.test(gh.pages_url) ? gh.pages_url : "";
    pages.hidden = !url;
    if (url && !pages.dataset.url) {
      pages.dataset.url = url;
      pages.replaceChildren(
        icon("github"),
        h("span", { class: "foot-label", text: "Edit from anywhere" }),
        icon("arrowRight", "foot-arrow"),
        h("a", { href: url, target: "_blank", rel: "noopener noreferrer", class: "foot-strong", text: displayUrl(url) }),
      );
    }
    const lanUrl = (ctx.config && typeof ctx.config.lan_url === "string" && ctx.config.lan_url) || (isLoopback(location.hostname) ? "" : location.host);
    lan.hidden = !lanUrl;
    if (lanUrl && lan.dataset.url !== lanUrl) {
      lan.dataset.url = lanUrl;
      lan.replaceChildren(icon("users"), h("span", { class: "foot-label", text: "On the lab network" }), h("span", { class: "foot-strong", text: displayUrl(lanUrl) }));
    }
  } else if (ctx.mode === "github" && ctx.settings) {
    pages.hidden = true;
    const s = ctx.settings;
    const key = `${s.repo}|${s.branch}|${s.path}`;
    lan.hidden = false;
    if (lan.dataset.url !== key) {
      lan.dataset.url = key;
      const fileUrl = (ctx.sync && ctx.sync.file_url) || `https://github.com/${s.repo}`;
      lan.replaceChildren(
        icon("github"),
        h("span", { class: "foot-label", text: "Board file" }),
        h("a", { href: fileUrl, target: "_blank", rel: "noopener noreferrer", class: "foot-strong", text: `${s.repo} · ${s.branch}/${s.path}` }),
      );
    }
  }
  const stamp = Math.max(Date.parse(ctx.board.updated_at) || 0, ctx.changedAt || 0);
  const text = stamp ? `Updated ${relTime(stamp)}` : "";
  if (updated.textContent !== text) updated.replaceChildren(text ? icon("clock") : "", text);
}

// --------------------------------------------------------------- data flow
function onData({ board, sync }) {
  if (board !== ctx.board) {
    if (ctx.loaded) ctx.changedAt = Date.now();
    ctx.board = board;
  }
  ctx.sync = sync;
  ctx.loaded = !!sync && sync.loaded !== false;
  ctx.canEdit = !!ctx.source && !!ctx.source.canEdit;
  requestRender();
}

function startSource(src) {
  if (unsubscribe) unsubscribe();
  if (ctx.source) ctx.source.stop();
  ctx.source = src;
  ctx.canEdit = !!src.canEdit;
  ctx.sync = src.sync;
  unsubscribe = src.subscribe(onData);
  src.start().catch((e) => console.error("Lab Hub: source failed to start", e));
  requestRender();
}

async function syncNow() {
  if (!ctx.source) return;
  const s = await ctx.source.syncNow();
  if (s && s.state === "error" && s.last_error) toast({ message: s.last_error, kind: "error" });
  else if (s && s.state === "offline") toast({ message: s.mode === "local" ? "Can't reach the lab server right now." : "Can't reach GitHub right now — your edits are saved here." });
}

// ------------------------------------------------------------- github mode
function repoTitle(repo) {
  const [owner, name] = String(repo || "").split("/");
  return { name: name || "Lab Hub", owner: owner || "" };
}

function startGitHub(settings) {
  ctx.settings = settings;
  if (settings.clientName && !getName()) setName(settings.clientName);
  const t = repoTitle(settings.repo);
  header.setName(t.name, t.owner);
  startSource(new GitHubSource(settings));
  requests.setDefaults();
  notes.setDefaults();
}

function openSettings({ firstRun = false } = {}) {
  if (ctx.mode !== "github") return;
  let decided = false;
  const initial = ctx.settings || Object.assign(defaultGitHubSettings(), { clientName: getName() });
  const dlg = openSetup({
    initial,
    existing: !firstRun,
    hasToken: !!(ctx.settings && ctx.settings.token),
    pending: (ctx.sync && ctx.sync.pending) || 0,
    onConnect: (s) => {
      decided = true;
      const saved = saveGitHubSettings(s);
      if (saved.clientName) setName(saved.clientName);
      if (firstRun) {
        startGitHub(saved);
        toast({ message: `Connected to ${saved.repo}`, kind: "success", timeout: 3500 });
      } else location.reload();
    },
    onReadOnly: (s) => {
      decided = true;
      const saved = saveGitHubSettings(s);
      if (firstRun) startGitHub(saved);
      else location.reload();
    },
    onForget: forgetToken,
  });
  if (firstRun) {
    dlg.dialog.addEventListener("close", () => {
      // Dismissed without choosing: show the board read-only (nothing saved).
      if (!decided && !ctx.source) startGitHub(Object.assign(defaultGitHubSettings(), { token: "" }));
    });
  }
}

function forgetToken() {
  clearGitHubSettings();
  location.reload();
}

function confirmForget() {
  const pending = (ctx.sync && ctx.sync.pending) || 0;
  const go = h("button", { type: "button", class: "btn btn-danger", "data-default": "true" }, icon("key"), "Forget token");
  const cancel = h("button", { type: "button", class: "btn btn-ghost", text: "Cancel" });
  const dlg = openDialog({
    title: "Forget the token on this device?",
    className: "small-editor confirm",
    body: [
      h("p", { class: "confirm-text", text: "This browser will go back to the setup screen. The board on GitHub is not affected." }),
      pending
        ? h("div", { class: "setup-status warn" }, icon("alert"), h("span", { text: `${plural(pending, "change")} from this browser ${pending === 1 ? "hasn't" : "haven't"} synced yet and will be lost.` }))
        : null,
    ],
    footer: [h("span", { class: "spacer" }), cancel, go],
  });
  cancel.addEventListener("click", () => dlg.close());
  go.addEventListener("click", () => {
    dlg.close();
    forgetToken();
  });
}

// ------------------------------------------------------------------ boot
async function resolveMode() {
  for (let attempt = 0; ; attempt++) {
    const m = await detectMode();
    if (m.mode === "local" || isGithubHost) {
      hideWaiting();
      return m;
    }
    // Not on GitHub Pages: tell "no Lab Hub API here" (a static host -> 404)
    // apart from "the Lab Hub server isn't reachable yet" (kiosk started before
    // the service, or the Pi restarting) so we don't drop into GitHub setup.
    let down = false;
    try {
      const r = await fetch("api/config", { cache: "no-store" });
      down = r.status >= 500;
    } catch (_) {
      down = true;
    }
    if (!down) {
      hideWaiting();
      return m;
    }
    showWaiting(attempt);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

function showWaiting(attempt) {
  let el = $("waiting");
  if (!el) {
    el = h(
      "div",
      { id: "waiting", class: "waiting", role: "status" },
      h("div", { class: "waiting-card" }, spinner("lg"), h("div", { class: "waiting-title", text: "Waiting for the Lab Hub server…" }), h("div", { class: "waiting-sub", id: "waiting-sub" })),
    );
    document.body.appendChild(el);
  }
  $("waiting-sub").textContent = attempt > 3 ? "Still starting up. This page will connect automatically." : "Starting up";
}

function hideWaiting() {
  const el = $("waiting");
  if (el) el.remove();
}

function watchVersion() {
  let base = null;
  const check = async () => {
    try {
      const r = await fetch("api/version", { cache: "no-store", headers: { Accept: "application/json" } });
      if (!r.ok) return;
      const v = (await r.json()).version;
      if (!v) return;
      if (base === null) base = v;
      else if (v !== base && !dialogOpen() && !ctx.dragging && !isTypingTarget(document.activeElement)) location.reload();
    } catch (_) {
      // server restarting — try again next minute
    }
  };
  check();
  setInterval(check, 60000);
}

function bindGlobalKeys() {
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (dialogOpen() || isTypingTarget(e.target)) return;
    if (e.key === "n" || e.key === "N" || e.key === "/") {
      e.preventDefault();
      tasks.focusQuickAdd();
    }
  });
}

function startTimers() {
  let day = dayKey();
  setInterval(() => {
    header.refresh();
    renderFooter();
  }, 10000);
  const slow = () => {
    if (dayKey() !== day) {
      day = dayKey();
      tasks.resetCache(); // due labels ("Today", "Overdue") change at midnight
      requestRender();
    }
    tasks.refreshRelative();
    requests.refreshRelative();
    notes.refreshRelative();
    if (ctx.mode === "local") calendar.render();
  };
  setInterval(slow, 30000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      slow();
      header.refresh();
      renderFooter();
    }
  });
}

async function boot() {
  initTheme(isGithubHost ? "auto" : "dark");
  hydrateIcons(document.body);
  initToasts($("toasts"));
  header = initHeader(ctx, {
    onSyncNow: syncNow,
    onSettings: () => openSettings(),
    onForget: confirmForget,
    onTheme: toggleTheme,
  });
  tasks = initTasks(ctx);
  requests = initRequests(ctx);
  notes = initNotes(ctx);
  calendar = initCalendar(ctx);
  bindGlobalKeys();
  startTimers();
  phoneMql.addEventListener && phoneMql.addEventListener("change", requestRender);
  $("quickadd").addEventListener("click", () => {
    if (!ctx.canEdit && ctx.mode === "github") openSettings({ firstRun: !ctx.source });
  });
  // Short kiosk screens hide the rail add forms behind a "+" in the card header.
  for (const b of document.querySelectorAll(".card-add")) {
    b.addEventListener("click", () => {
      const form = $(b.dataset.form);
      form.classList.add("open");
      const first = form.querySelector("input, textarea");
      if (first) first.focus();
    });
  }
  requestRender();

  const m = await resolveMode();
  ctx.mode = m.mode;
  root.dataset.mode = m.mode;
  if (m.mode === "local") {
    ctx.config = m.config;
    setDefaultTheme(m.config.theme);
    header.setName(m.config.name || "Lab Hub", "");
    startSource(new LocalSource({ clientName: m.config.client }));
    calendar.start();
    watchVersion();
  } else {
    setDefaultTheme("auto");
    const saved = loadGitHubSettings();
    if (saved) startGitHub(saved);
    else {
      const t = repoTitle(defaultGitHubSettings().repo);
      header.setName(t.name, t.owner);
      ctx.settings = null;
      openSettings({ firstRun: true });
    }
  }
  requests.setDefaults();
  notes.setDefaults();
}

boot();
