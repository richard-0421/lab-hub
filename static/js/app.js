// Lab Hub — UI entry point.
//
// Boot: detect the mode (local = served by the Pi's API, github = anywhere
// else, e.g. GitHub Pages), create the matching data source, subscribe, and
// render everything from one requestAnimationFrame-batched pipeline.

import { emptyBoard } from "./board.js";
import {
  GitHubSource,
  LocalSource,
  SETTINGS_KEY,
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
import { NAME_KEY, SORT_KEY, getName, pget, pset, setName } from "./ui/prefs.js";
import { forgetGitHub, hasDraft, isKioskHost, isLoopbackHost, personName, versionReloadCheck } from "./ui/lifecycle.js";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const phoneMql = window.matchMedia("(max-width: 699px)");
// Keep in sync with the "slide-over rail" block in style.css.
const drawerMql = window.matchMedia("(min-width: 700px) and (max-width: 1099px) and (max-height: 820px)");
const isGithubHost = /\.github\.io$/i.test(location.hostname);
const isLoopback = isLoopbackHost;

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
  /** The shared Pi display (local mode on loopback): never remembers a person. */
  kiosk: false,
  changedAt: 0,
  ui: { search: "", assignee: "", sort: ["priority", "due"].includes(savedSort) ? savedSort : "manual", tab: "todo" },
  /** The person using this browser (remembered), or "" — always "" on the shared kiosk. */
  name() {
    return personName({ kiosk: ctx.kiosk, stored: getName(), clientName: ctx.settings && ctx.settings.clientName });
  },
  /** Remember a name typed into a form (personal browsers only, never the kiosk). */
  rememberName(n) {
    if (!ctx.kiosk) setName(n);
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
  renderRailTabs();
  renderFooter();
  markOverflow();
}

// --------------------------------------------------------------- side rail
function setCount(id, n) {
  const el = $(id);
  const text = n > 0 ? String(n) : "";
  if (el.textContent !== text) el.textContent = text;
  el.hidden = !text;
}

/** Badges on the compact-layout rail tabs. */
function renderRailTabs() {
  setCount("rt-requests", ctx.board.requests.filter((r) => r.status !== "received").length);
  setCount("rt-notes", ctx.board.notes.length);
  setCount("rt-calendar", calendar ? calendar.todayCount() : 0);
}

/**
 * Mark rail lists that continue below the visible part, so CSS can fade that
 * edge instead of cutting a row in half with no hint to scroll.
 */
function markOverflow(el) {
  const list = el ? [el] : document.querySelectorAll(".rail-card .card-body");
  for (const b of list) {
    const below = b.scrollTop + b.clientHeight < b.scrollHeight - 2;
    if (b.classList.contains("more-below") !== below) b.classList.toggle("more-below", below);
  }
}

function initRail() {
  for (const b of document.querySelectorAll(".rail-card .card-body")) {
    b.addEventListener("scroll", () => markOverflow(b), { passive: true });
  }
  window.addEventListener("resize", () => markOverflow());
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => markOverflow());
    for (const b of document.querySelectorAll(".rail-card .card-body")) ro.observe(b);
  }

  // Slide-over on short landscape screens: the board stays the hero and the
  // header tabs open one side card at a time.
  const tabs = Array.from(document.querySelectorAll(".rail-tab"));
  let opener = null;
  const show = (name) => {
    if ((root.dataset.rail || "") === name) return;
    if (name) root.dataset.rail = name;
    else delete root.dataset.rail;
    for (const t of tabs) t.setAttribute("aria-expanded", t.dataset.card === name ? "true" : "false");
    if (name) {
      const card = $(`card-${name}`);
      requestAnimationFrame(() => {
        try {
          card.focus({ preventScroll: true });
        } catch (_) {
          card.focus();
        }
        markOverflow();
      });
    }
  };
  for (const t of tabs) {
    t.addEventListener("click", () => {
      opener = t;
      show(root.dataset.rail === t.dataset.card ? "" : t.dataset.card);
    });
  }
  $("rail-scrim").addEventListener("click", () => show(""));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !root.dataset.rail || e.defaultPrevented || dialogOpen()) return;
    show("");
    if (opener && opener.isConnected) opener.focus();
  });
  const onLayout = () => {
    if (!drawerMql.matches) show("");
  };
  if (drawerMql.addEventListener) drawerMql.addEventListener("change", onLayout);
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

// What to tell the user after connecting (from the setup dialog): a note when
// write access couldn't be confirmed, and warnings (two-repo setup only).
// Neither blocks. A Settings change reloads the page, so they wait in
// sessionStorage and are shown after the reload.
const NOTICE_KEY = "labhub:connect-notice";

function connectNotices(info) {
  const { note = null, warnings = [] } = info || {};
  const out = [];
  if (note) out.push({ message: note, kind: "info", timeout: 12000 });
  for (const w of warnings || []) out.push({ message: w, kind: "warn", timeout: 15000 });
  return out;
}

function showNotices(list) {
  for (const n of list) toast(n);
}

function stashNotices(list) {
  try {
    if (list.length) sessionStorage.setItem(NOTICE_KEY, JSON.stringify(list));
  } catch (_) {
    // storage blocked: the notes are lost, the connection isn't
  }
}

function showStashedNotices() {
  let list = [];
  try {
    const raw = sessionStorage.getItem(NOTICE_KEY);
    sessionStorage.removeItem(NOTICE_KEY);
    list = raw ? JSON.parse(raw) : [];
  } catch (_) {
    list = [];
  }
  if (!Array.isArray(list)) return;
  const kinds = ["info", "warn"];
  showNotices(
    list
      .filter((n) => n && typeof n.message === "string" && n.message)
      .slice(0, 3)
      .map((n) => ({ message: n.message.slice(0, 400), kind: kinds.includes(n.kind) ? n.kind : "info", timeout: 15000 })),
  );
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
    onConnect: (s, info) => {
      decided = true;
      const saved = saveGitHubSettings(s);
      if (saved.clientName) setName(saved.clientName);
      const notices = connectNotices(info);
      if (firstRun) {
        startGitHub(saved);
        toast({ message: `Connected to ${saved.repo}`, kind: "success", timeout: 3500 });
        showNotices(notices);
      } else {
        stashNotices(notices);
        location.reload();
      }
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
  // Halt the source first: an in-flight GET/PUT finishing after the clear
  // would otherwise write the dropped pending ops back into localStorage.
  const unsub = unsubscribe;
  unsubscribe = null;
  forgetGitHub({ source: ctx.source, unsubscribe: unsub, clear: () => clearGitHubSettings(), reload: () => location.reload() });
}

/** Another tab forgot the token: stop syncing here too (it would re-create the cache) and show setup. */
function watchOtherTabs() {
  window.addEventListener("storage", (e) => {
    if (ctx.mode !== "github" || !ctx.settings || !ctx.settings.token) return;
    if (e.key !== null && e.key !== SETTINGS_KEY) return;
    if (e.key === SETTINGS_KEY && e.newValue !== null) return;
    if (loadGitHubSettings()) return; // cleared and re-saved already
    const unsub = unsubscribe;
    unsubscribe = null;
    forgetGitHub({ source: ctx.source, unsubscribe: unsub, reload: () => location.reload() });
  });
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

// Last pointer / key / text input anywhere on the page (for the version reload).
let lastInputAt = 0;
function trackInput() {
  const mark = () => {
    lastInputAt = Date.now();
  };
  for (const type of ["pointerdown", "keydown", "input"]) document.addEventListener(type, mark, { capture: true, passive: true });
}

function watchVersion() {
  let base = null;
  let pendingSince = 0; // when a new version was first seen
  let retry = 0;
  let busy = false; // a check (and its flush) is still running
  const check = async () => {
    clearTimeout(retry);
    if (busy) return;
    busy = true;
    try {
      const r = await fetch("api/version", { cache: "no-store", headers: { Accept: "application/json" } });
      if (!r.ok) return;
      const v = (await r.json()).version;
      if (!v) return;
      if (base === null) {
        base = v;
        return;
      }
      if (v === base) {
        pendingSince = 0;
        return;
      }
      if (!pendingSince) pendingSince = Date.now();
      // Unsent kiosk edits are pushed first (source.flush) and the page looked
      // at again, so a reload never drops them.
      const why = await versionReloadCheck(ctx.source, () => ({
        now: Date.now(),
        pendingSince,
        lastInputAt,
        dragging: ctx.dragging,
        dialogOpen: dialogOpen(),
        focusedDraft: hasDraft(document.activeElement),
      }));
      if (!why) location.reload();
      // Still unsent (the Pi is busy or unreachable): look again soon.
      else if (why === "unsent") retry = setTimeout(check, 5000);
    } catch (_) {
      // server restarting — try again next minute
    } finally {
      busy = false;
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
  calendar = initCalendar(ctx, { onRender: () => { renderRailTabs(); markOverflow(); } });
  initRail();
  bindGlobalKeys();
  trackInput();
  watchOtherTabs();
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
  ctx.kiosk = isKioskHost(m.mode, location.hostname);
  if (ctx.kiosk) pset(NAME_KEY, ""); // drop a name remembered by an older version of this page
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
    if (saved) {
      startGitHub(saved);
      showStashedNotices();
    }
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
