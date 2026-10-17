// Lab Hub data sources (docs/ARCHITECTURE.md §4–5).
//
//   LocalSource   — the page is served by the Pi; talks to its API with
//                   relative URLs (api/board, api/ops, api/sync).
//   GitHubSource  — the page runs anywhere (GitHub Pages); reads/writes
//                   board.json on the `data` branch through the GitHub REST
//                   API, mirroring the Pi's sync cycle in the browser.
//                   Without a token it only reads, from
//                   raw.githubusercontent.com (no API rate limit per IP).
//
// Default layout: ONE public repo, richard-0417/lab-hub — branch `main` holds
// the code (and is published to Pages), branch `data` holds board.json. So the
// page's own repo is also the board repo. Repo, branch and path are all
// settings, so a separate (e.g. private) data repo works too; it is optional.
//
// Both implement the same interface:
//   src.mode, src.canEdit, src.board, src.sync
//   src.subscribe(fn) -> unsubscribe     fn({board, sync})
//   await src.start(); await src.submit(ops); await src.syncNow(); src.stop()
//
// No work happens at import time and every browser global (document,
// location, localStorage, window) is guarded, so node tests can import this.

import {
  LIMITS,
  applyOps,
  canonicalTimestamp,
  checkRoom,
  cleanString,
  emptyBoard,
  normalizeBoard,
  nowIso,
  serializeBoard,
  summarizeOps,
  validateOp,
} from "./board.js";

export const DEFAULT_REPO = "richard-0417/lab-hub"; // code on `main`, board on `data`
export const DEFAULT_BRANCH = "data";
export const DEFAULT_PATH = "board.json";
export const DEFAULT_API = "https://api.github.com";
export const DEFAULT_RAW = "https://raw.githubusercontent.com";
export const SETTINGS_KEY = "labhub:github";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/; // one part of a branch name or file path
const TOKEN_RE = /^[\x21-\x7e]*$/; // printable ASCII (or empty); anything else can't go in a header
const BAD_TOKEN_MSG = "The GitHub token contains invalid characters — paste it again";
const LOCAL_OFFLINE_MSG = "Can't reach the dashboard server";
const GH_OFFLINE_MSG = "Can't reach GitHub";
const STALE_WINDOW_MS = 15000;
const MAX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 300000; // like the Pi's MAX_BACKOFF
const DONE_CAP = 1000; // ids of pushed ops remembered for other tabs (see GitHubSource._mergeStored)
// POST api/ops answers that retrying the same batch can't fix: 400 invalid op
// or board full, 403 cross-site write refused, 413 body too large, 415 not
// JSON. (503 — the Pi couldn't save, or its queue is full — is retried.)
const PERMANENT_POST_STATUS = new Set([400, 403, 413, 415]);
// Bytes of op JSON per POST api/ops. The Pi refuses bodies over 2 MiB (413),
// so a long outbox goes in several requests instead of one that is refused.
const POST_BUDGET_BYTES = 1024 * 1024;
const WRITE_PROBE = { content: "lab-hub write-access check\n", encoding: "utf-8" };

// ------------------------------------------------------------------ helpers

const defaultFetch = (...args) => globalThis.fetch(...args);

function hasDocument() {
  return typeof document !== "undefined" && document !== null && typeof document.addEventListener === "function";
}

function hasWindow() {
  return typeof window !== "undefined" && window !== null && typeof window.addEventListener === "function";
}

function isVisible() {
  return !hasDocument() || document.visibilityState !== "hidden";
}

function listen(target, type, fn) {
  target.addEventListener(type, fn);
  return () => target.removeEventListener(type, fn);
}

let memStore = null;
function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
  };
}

function defaultStorage() {
  try {
    if (typeof localStorage !== "undefined" && localStorage) return localStorage;
  } catch (_) {
    // access can throw (blocked site data, sandboxed frames)
  }
  if (!memStore) memStore = memoryStorage();
  return memStore;
}

function sget(storage, key) {
  try {
    return storage.getItem(key);
  } catch (_) {
    return null;
  }
}

function sset(storage, key, value) {
  try {
    storage.setItem(key, value);
    return true;
  } catch (_) {
    return false;
  }
}

function sdel(storage, key) {
  try {
    storage.removeItem(key);
  } catch (_) {
    // ignore
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

/**
 * fetch + read the body under ONE deadline (`ms`), so a reply whose headers
 * arrive but whose body stalls can't hang a sync cycle. Resolves
 * {res, data, text}: data is the parsed JSON body, or null when the body is
 * empty or not JSON. Rejects on a network error, on the deadline, or when the
 * request's controller (registered in `controllers`) is aborted by stop() —
 * while waiting for the headers or for the body.
 */
async function fetchWithTimeout(fetchImpl, url, init, ms, controllers) {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  let expire = () => {};
  const deadline = new Promise((_, reject) => {
    expire = () => reject(new Error("The request timed out or was cancelled"));
  });
  deadline.catch(() => {});
  const timer = setTimeout(() => {
    if (ctrl) ctrl.abort();
    expire();
  }, ms);
  if (ctrl) {
    ctrl.signal.addEventListener("abort", () => expire(), { once: true });
    if (controllers) controllers.add(ctrl);
  }
  try {
    const res = await Promise.race([fetchImpl(url, ctrl ? Object.assign({}, init, { signal: ctrl.signal }) : init), deadline]);
    let text = "";
    if (res.status !== 204 && res.status !== 304 && typeof res.text === "function") {
      text = await Promise.race([res.text(), deadline]);
    }
    return { res, data: parseJson(text), text: typeof text === "string" ? text : "" };
  } finally {
    clearTimeout(timer);
    if (ctrl && controllers) controllers.delete(ctrl);
  }
}

function header(res, name) {
  try {
    return res.headers && typeof res.headers.get === "function" ? res.headers.get(name) : null;
  } catch (_) {
    return null;
  }
}

function emitTo(subs, payload) {
  for (const fn of Array.from(subs)) {
    try {
      fn(payload);
    } catch (e) {
      if (typeof console !== "undefined") console.error("Lab Hub subscriber failed:", e);
    }
  }
}

function prepOp(op, clientName) {
  const copy = Object.assign({}, op);
  if (clientName && (typeof copy.by !== "string" || copy.by === "")) copy.by = clientName;
  return copy;
}

// Queue ids: every op queued by a GitHubSource gets one, so tabs sharing a
// localStorage key can merge their queues (see GitHubSource._mergeStored).
function newQid() {
  let r = "";
  try {
    const a = new Uint32Array(2);
    globalThis.crypto.getRandomValues(a);
    r = a[0].toString(36) + a[1].toString(36);
  } catch (_) {
    r = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  }
  return `${Date.now().toString(36)}-${r}`;
}

// Deterministic id for an op stored by the old format (no queue ids), so two
// tabs migrating the same record agree on it. FNV-1a, two seeds.
function legacyQid(op) {
  const s = JSON.stringify(op);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return `v1-${a.toString(16)}${b.toString(16)}`;
}

function validateAll(ops) {
  const list = Array.isArray(ops) ? ops : [ops];
  for (const op of list) {
    const err = validateOp(op);
    if (err) throw new Error(err);
  }
  return list;
}

// Refuse a batch whose adds would go past LIMITS.maxItems in a collection of
// `view` (the board the user sees, queued ops included) — the same check and
// message as the Pi's 400 (app/store.py _check_room). Nothing is queued.
function assertRoom(view, list) {
  const full = checkRoom(view, list);
  if (full) {
    const err = new Error(full.error);
    err.index = full.index;
    throw err;
  }
}

const utf8Length = (s) => (typeof TextEncoder === "function" ? new TextEncoder().encode(s).length : s.length * 3);

function jsonEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]));
}

function contentKey(board) {
  return serializeBoard(Object.assign({}, board, { updated_at: "", updated_by: "" }));
}

function fmtTime(ms) {
  try {
    return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  } catch (_) {
    return new Date(ms).toISOString().slice(11, 16) + " UTC";
  }
}

const encSegments = (s) => s.split("/").map(encodeURIComponent).join("/");

// ------------------------------------------------------------- UTF-8 base64

/** UTF-8 string -> base64 (chunked, safe for any size and any code point). */
export function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** base64 (whitespace/newlines allowed, as GitHub sends it) -> UTF-8 string. */
export function base64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

// ================================================================ LocalSource

function permanentPostMessage(status) {
  if (status === 413) return "The change is too large for the dashboard server (HTTP 413)";
  if (status === 403) return "The dashboard server refused the change (HTTP 403)";
  if (status === 400) return "The dashboard server rejected the change";
  return `The dashboard server rejected the change (HTTP ${status})`;
}

function defaultPiSync() {
  return {
    enabled: false,
    state: "off",
    pending: 0,
    last_sync: null,
    last_push: null,
    last_error: null,
    repo: "",
    branch: "",
    path: "",
  };
}

/** Talks to the Pi's FastAPI (relative URLs). */
export class LocalSource {
  constructor({ pollMs = 3000, fetchImpl, clientName = "", timeoutMs = 10000, syncTimeoutMs = 30000 } = {}) {
    this.mode = "local";
    this.canEdit = true;
    this.clientName = typeof clientName === "string" ? clientName.trim() : "";
    this._pollMs = pollMs;
    this._fetch = fetchImpl || defaultFetch;
    this._timeoutMs = timeoutMs;
    this._syncTimeoutMs = syncTimeoutMs;
    this._subs = new Set();
    this._rev = null;
    this._server = null; // last board the Pi sent
    this._serverSync = defaultPiSync();
    this._outbox = []; // ops not yet accepted by the Pi, in order
    this._link = "up";
    this._httpError = null;
    this._view = emptyBoard();
    this._viewFrom = { server: undefined, outbox: -1 };
    this._loaded = false;
    this._chain = Promise.resolve();
    this._timer = null;
    this._active = false;
    this._halted = false;
    this._controllers = new Set();
    this._unlisten = [];
    this._last = { board: null, key: "" };
  }

  get board() {
    return this._view;
  }

  /** Ops this page queued that the Pi hasn't accepted yet (this page's outbox). */
  get unsent() {
    return this._outbox.length;
  }

  get sync() {
    const base = Object.assign(defaultPiSync(), this._serverSync || {});
    const out = Object.assign({}, base, {
      pending: (Number.isFinite(base.pending) ? base.pending : 0) + this._outbox.length,
      mode: "local",
      canEdit: true,
      link: this._link,
      loaded: this._loaded,
    });
    if (this._link === "down") {
      out.state = "offline";
      out.last_error = LOCAL_OFFLINE_MSG;
    } else if (this._httpError) {
      out.state = "error";
      out.last_error = this._httpError;
    }
    return out;
  }

  /** fn({board, sync}) on every visible change. Called at once if already loaded. */
  subscribe(fn) {
    this._subs.add(fn);
    if (this._loaded) {
      try {
        fn({ board: this._view, sync: this.sync });
      } catch (e) {
        if (typeof console !== "undefined") console.error("Lab Hub subscriber failed:", e);
      }
    }
    return () => this._subs.delete(fn);
  }

  /** First load, then poll every pollMs (and right away when the tab becomes visible). */
  async start() {
    this._active = true;
    this._halted = false;
    this._listen();
    await this._enqueue(() => this._load(false));
    this._emit(true);
    this._schedule();
  }

  stop() {
    this._active = false;
    this._halted = true;
    clearTimeout(this._timer);
    this._timer = null;
    for (const off of this._unlisten.splice(0)) off();
    for (const c of Array.from(this._controllers)) c.abort();
  }

  /**
   * Validate (throws Error(message) on an invalid op, or on adds that would
   * go past LIMITS.maxItems — "board full: …"), apply optimistically
   * (subscribers fire before this returns its promise), then POST. Network
   * failures and 503 keep the ops in the outbox (retried on the next poll);
   * a refusal that retrying can't fix (400, 403, 413, 415) drops those ops,
   * reloads the board from the Pi and rejects with the server's error.
   */
  async submit(ops) {
    const list = validateAll(ops);
    if (!list.length) return this.sync;
    assertRoom(this._view, list);
    const prepared = list.map((op) => prepOp(op, this.clientName));
    this._outbox.push(...prepared);
    this._recompute();
    this._emit();
    const { rejected } = await this._enqueue(() => this._flush());
    const mine = rejected.filter((r) => prepared.includes(r.op));
    if (mine.length) throw new Error(mine[0].error);
    return this.sync;
  }

  /**
   * Push this page's outbox to the Pi now, without asking it to sync with
   * GitHub (no api/sync). Never rejects: ops that couldn't be sent stay
   * queued (check `unsent` afterwards); ops the Pi refuses for good are
   * dropped and logged, as on a poll. Resolves to `sync`.
   */
  async flush() {
    return this._enqueue(async () => {
      await this._flushLogged();
      return this.sync;
    });
  }

  /** Flush the outbox, ask the Pi to run a GitHub sync cycle now, reload. */
  async syncNow() {
    return this._enqueue(async () => {
      if (this._outbox.length) await this._flush();
      try {
        const { res, data } = await this._request("POST", "api/sync", undefined, this._syncTimeoutMs);
        this._link = "up";
        if (res.ok && data && typeof data === "object") this._serverSync = data;
      } catch (_) {
        if (this._halted) return this.sync;
        this._link = "down";
      }
      await this._load(true);
      this._emit();
      return this.sync;
    });
  }

  // -------------------------------------------------------------- internals

  _listen() {
    if (this._unlisten.length) return;
    if (hasDocument()) {
      this._unlisten.push(
        listen(document, "visibilitychange", () => {
          if (document.visibilityState === "visible") this._pollNow();
        }),
      );
    }
    if (hasWindow()) this._unlisten.push(listen(window, "online", () => this._pollNow()));
  }

  _enqueue(fn) {
    const p = this._chain.then(() => fn());
    this._chain = p.catch(() => {});
    return p;
  }

  // -> {res, data}; rejects on network errors / timeout / stop().
  _request(method, url, body, timeoutMs) {
    const init = { method, cache: "no-store", headers: { Accept: "application/json" } };
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetchWithTimeout(this._fetch, url, init, timeoutMs || this._timeoutMs, this._controllers);
  }

  _recompute() {
    const server = this._server;
    if (this._viewFrom.server === server && this._viewFrom.outbox === this._outbox.length) return;
    const base = server || emptyBoard();
    this._view = this._outbox.length ? applyOps(base, this._outbox) : base;
    this._viewFrom = { server, outbox: this._outbox.length };
  }

  _emit(force = false) {
    if (this._halted) return;
    const sync = this.sync;
    const key = JSON.stringify(sync);
    if (!force && this._last.board === this._view && this._last.key === key) return;
    this._last = { board: this._view, key };
    emitTo(this._subs, { board: this._view, sync });
  }

  _adopt(data) {
    if (data.sync && typeof data.sync === "object") this._serverSync = data.sync;
    if (data.board && typeof data.board === "object") {
      this._server = normalizeBoard(data.board);
      if (data.rev !== undefined && data.rev !== null) this._rev = data.rev;
      this._loaded = true;
    }
  }

  async _load(force) {
    const url = this._rev !== null && !force ? `api/board?rev=${encodeURIComponent(this._rev)}` : "api/board";
    let res;
    let data;
    try {
      ({ res, data } = await this._request("GET", url));
    } catch (_) {
      if (this._halted) return false;
      this._link = "down";
      this._recompute();
      this._emit();
      return false;
    }
    this._link = "up";
    if (!res.ok || !data || typeof data !== "object") {
      this._httpError = res.ok ? "The dashboard server sent an unreadable reply" : `Dashboard server error (HTTP ${res.status})`;
      this._emit();
      return false;
    }
    this._httpError = null;
    if (data.unchanged && this._server) {
      if (data.sync && typeof data.sync === "object") this._serverSync = data.sync;
    } else {
      this._adopt(data);
    }
    this._recompute();
    this._emit();
    return true;
  }

  _dropFromOutbox(ops) {
    const gone = new Set(ops);
    this._outbox = this._outbox.filter((op) => !gone.has(op));
  }

  // The next POST's ops: in order, at most maxOpsPerPost, and (unless a single
  // op is bigger) at most POST_BUDGET_BYTES of JSON.
  _nextBatch() {
    const batch = [];
    let bytes = 0;
    for (const op of this._outbox) {
      if (batch.length >= LIMITS.maxOpsPerPost) break;
      const n = utf8Length(JSON.stringify(op)) + 1;
      if (batch.length && bytes + n > POST_BUDGET_BYTES) break;
      batch.push(op);
      bytes += n;
    }
    return batch;
  }

  async _flushLogged() {
    if (!this._outbox.length) return;
    const { rejected } = await this._flush();
    if (rejected.length && typeof console !== "undefined") console.warn("Lab Hub: server rejected queued ops:", rejected);
  }

  async _flush() {
    const rejected = [];
    while (this._outbox.length && !this._halted) {
      const batch = this._nextBatch();
      let res;
      let data;
      try {
        ({ res, data } = await this._request("POST", "api/ops", { ops: batch }));
      } catch (_) {
        if (this._halted) break;
        this._link = "down";
        this._recompute();
        this._emit();
        break;
      }
      this._link = "up";
      if (res.ok && data && typeof data === "object" && data.board) {
        this._httpError = null;
        this._dropFromOutbox(batch);
        this._adopt(data);
        this._recompute();
        this._emit();
        continue;
      }
      const serverError = data && typeof data.error === "string" && data.error ? data.error : "";
      if (PERMANENT_POST_STATUS.has(res.status)) {
        // Sending these ops again can't succeed: drop them (just the op the
        // Pi names, when it names one), roll the view back below.
        this._httpError = null;
        const error = serverError || permanentPostMessage(res.status);
        const idx = data && Number.isInteger(data.index) && data.index >= 0 && data.index < batch.length ? data.index : -1;
        const bad = idx >= 0 ? [batch[idx]] : batch;
        for (const op of bad) rejected.push({ op, error });
        this._dropFromOutbox(bad);
        continue; // the remaining ops are retried
      }
      // 503 (couldn't save / queue full), other 5xx, anything unexpected: keep
      // the ops and try again on the next poll.
      this._httpError = serverError ? `${serverError} (HTTP ${res.status})` : `Dashboard server error (HTTP ${res.status})`;
      this._emit();
      break;
    }
    if (rejected.length && !this._halted) await this._load(true); // roll back to the server's truth
    return { rejected };
  }

  async _tick() {
    this._timer = null;
    if (!this._active) return;
    await this._enqueue(async () => {
      if (this._outbox.length) return this._flushLogged();
      await this._load(false);
    });
    this._schedule();
  }

  _pollNow() {
    if (!this._active) return;
    clearTimeout(this._timer);
    this._timer = null;
    this._tick();
  }

  _schedule() {
    if (!this._active) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._tick(), this._pollMs);
  }
}

// =========================================================== GitHub settings

function str(v) {
  return typeof v === "string" ? v.trim() : "";
}

function isLocalHostname(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1" || h.endsWith(".localhost");
}

/**
 * May this page use an API base other than https://api.github.com (a mock
 * server)? Only on a local development page (localhost, 127.0.0.1, [::1],
 * *.localhost) or outside a browser (no `location`, e.g. node tests).
 * Anywhere else — the GitHub Pages site — the token only ever goes to
 * api.github.com, whatever a link's ?api= or a saved setting says.
 */
export function customApiAllowed(loc) {
  if (loc === undefined) loc = typeof location !== "undefined" ? location : null;
  if (!loc || typeof loc.hostname !== "string") return true;
  return isLocalHostname(loc.hostname);
}

function cleanApiBase(value, loc) {
  const api = (str(value) || DEFAULT_API).replace(/\/+$/, "");
  if (api === DEFAULT_API) return api;
  if (!/^https?:\/\/[^\s/?#@]+(\/[^\s?#]*)?$/i.test(api) || !customApiAllowed(loc)) return DEFAULT_API;
  return api;
}

/** "owner/name", neither part "." or "..". */
function repoOk(repo) {
  return typeof repo === "string" && REPO_RE.test(repo) && repo.split("/").every((p) => !/^\.+$/.test(p));
}

/**
 * A branch name or file path that is safe to put in an API URL: parts of
 * [A-Za-z0-9._-] separated by single "/", no "." / ".." parts (they would
 * walk the URL out of /repos/<repo>/contents/). Branches also follow git's
 * ref rules (no "..", no part starting with "." or ending with ".lock" / ".").
 */
function refOk(value, isBranch) {
  if (typeof value !== "string" || !value || value.length > (isBranch ? 255 : 1024)) return false;
  if (isBranch && value.includes("..")) return false;
  return value.split("/").every(
    (seg) =>
      SEGMENT_RE.test(seg) &&
      !/^\.+$/.test(seg) &&
      (!isBranch || (!seg.startsWith(".") && !seg.endsWith(".") && !seg.toLowerCase().endsWith(".lock"))),
  );
}

/**
 * Why these settings can't be used (a message for the user), or null.
 * Checks the repo, branch, file path and token characters.
 */
export function githubSettingsError(settings) {
  const s = normalizeGitHubSettings(settings);
  if (!repoOk(s.repo)) return "Repo must look like owner/name";
  if (!refOk(s.branch, true)) return `"${s.branch}" isn't a usable branch name (letters, digits, . _ - and /)`;
  if (!refOk(s.path, false)) return `"${s.path}" isn't a usable file path (letters, digits, . _ - and /; no "." or ".." parts)`;
  if (!TOKEN_RE.test(s.token)) return BAD_TOKEN_MSG;
  return null;
}

/**
 * Fill defaults and tidy a settings object (accepts a pasted github.com URL
 * as repo). apiBase falls back to https://api.github.com unless
 * customApiAllowed(loc). Branch and path are kept as typed — check them with
 * githubSettingsError().
 */
export function normalizeGitHubSettings(settings, loc) {
  const s = settings && typeof settings === "object" ? settings : {};
  const repo = str(s.repo)
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  return {
    apiBase: cleanApiBase(s.apiBase, loc),
    repo,
    branch: str(s.branch) || DEFAULT_BRANCH,
    path: str(s.path).replace(/^\/+/, "") || DEFAULT_PATH,
    token: str(s.token),
    clientName: str(s.clientName),
  };
}

/** localStorage key of the cached board + pending ops for these settings. */
export function githubCacheKey(settings) {
  const s = normalizeGitHubSettings(settings);
  return `labhub:gh:${s.repo}:${s.branch}:${s.path}`;
}

/**
 * The repo a GitHub Pages page is published from: "<owner>.github.io/<code>/…"
 * => "<owner>/<code>"; the root site => "<owner>/<owner>.github.io". null when
 * the page isn't on *.github.io (or outside a browser).
 */
export function pagesCodeRepo(loc) {
  if (loc === undefined) loc = typeof location !== "undefined" ? location : null;
  const host = loc && typeof loc.hostname === "string" ? loc.hostname.toLowerCase() : "";
  if (!host.endsWith(".github.io") || host.length <= ".github.io".length) return null;
  const owner = host.slice(0, -".github.io".length);
  const segs = String((loc && loc.pathname) || "/").split("/");
  const first = segs[1] || "";
  const isDir = segs.length > 2;
  let name = "";
  try {
    name = decodeURIComponent(first);
  } catch (_) {
    name = first;
  }
  return name && (isDir || !/\.html?$/i.test(name)) ? `${owner}/${name}` : `${owner}/${owner}.github.io`;
}

/**
 * Defaults for this page. The default setup is ONE repo — code on `main`,
 * board.json on the `data` branch — so the board repo is the repo the page
 * is published from: "<owner>.github.io/<repo>/…" => "<owner>/<repo>" (root
 * site => "<owner>/<owner>.github.io"); anywhere else "richard-0417/lab-hub".
 * Branch "data", path "board.json".
 * ?repo= ?branch= ?path= ?api= prefill these defaults (they never override
 * saved settings — use `loadGitHubSettings() || defaultGitHubSettings()`);
 * ?repo= is how a link points a first connect at a separate data repo.
 * A ?branch= or ?path= that isn't usable is ignored, and ?api= is honoured
 * only on a local development page (customApiAllowed).
 */
export function defaultGitHubSettings(loc) {
  if (loc === undefined) loc = typeof location !== "undefined" ? location : null;
  const repo = pagesCodeRepo(loc) || DEFAULT_REPO;
  const s = { apiBase: DEFAULT_API, repo, branch: DEFAULT_BRANCH, path: DEFAULT_PATH, token: "", clientName: "" };
  let q = null;
  try {
    q = new URLSearchParams((loc && loc.search) || "");
  } catch (_) {
    q = null;
  }
  if (q) {
    if (str(q.get("repo"))) s.repo = str(q.get("repo"));
    const branch = str(q.get("branch"));
    if (refOk(branch, true)) s.branch = branch;
    const path = str(q.get("path")).replace(/^\/+/, "");
    if (refOk(path, false)) s.path = path;
    if (str(q.get("api")) && customApiAllowed(loc)) s.apiBase = str(q.get("api"));
  }
  return normalizeGitHubSettings(s, loc);
}

/** Saved settings (key "labhub:github"), or null when none are saved. */
export function loadGitHubSettings(storage = defaultStorage()) {
  const raw = sget(storage, SETTINGS_KEY);
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return data && typeof data === "object" && !Array.isArray(data) ? normalizeGitHubSettings(data) : null;
  } catch (_) {
    return null;
  }
}

/** Save settings; returns the normalized object that was stored. */
export function saveGitHubSettings(settings, storage = defaultStorage()) {
  const s = normalizeGitHubSettings(settings);
  sset(storage, SETTINGS_KEY, JSON.stringify(s));
  return s;
}

/**
 * Forget saved settings AND the cached board/pending ops for that repo.
 * (Unpushed edits are lost — check sync.pending first.)
 */
export function clearGitHubSettings(storage = defaultStorage()) {
  const s = loadGitHubSettings(storage);
  sdel(storage, SETTINGS_KEY);
  if (s) sdel(storage, githubCacheKey(s));
}

function ghHeaders(token) {
  const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// Classify a non-2xx GitHub response. Returns {message, retryAt}.
function githubFailure(res, data, { token, repo, what = "request" } = {}) {
  const msg = data && typeof data.message === "string" ? data.message : "";
  const status = res.status;
  if (status === 401) return { message: "GitHub token rejected (expired or revoked?)", retryAt: 0 };
  if (status === 403 || status === 429) {
    const remaining = header(res, "x-ratelimit-remaining");
    const reset = Number(header(res, "x-ratelimit-reset"));
    if (remaining === "0" && reset > 0) {
      return {
        message: `GitHub rate limit reached — resets at ${fmtTime(reset * 1000)}${token ? "" : " (add a token for a higher limit)"}`,
        retryAt: reset * 1000,
      };
    }
    const retryAfter = Number(header(res, "retry-after"));
    if (status === 429 || /rate limit/i.test(msg)) {
      return {
        message: `GitHub rate limit hit${msg ? `: ${msg}` : ""}`,
        retryAt: retryAfter > 0 ? Date.now() + retryAfter * 1000 : Date.now() + 60000,
      };
    }
    return {
      message:
        `GitHub refused the ${what} (403)${msg ? `: ${msg}` : ""}` +
        (token ? ` — check the token has Contents: read & write on ${repo}` : ""),
      retryAt: 0,
    };
  }
  if (status === 404) return { message: "repo not found, or the token can't see it", retryAt: 0 };
  return { message: `GitHub returned HTTP ${status}${msg ? `: ${msg}` : ""}`, retryAt: 0 };
}

function isRateLimited(res, data) {
  const msg = data && typeof data.message === "string" ? data.message : "";
  return res.status === 429 || (res.status === 403 && (header(res, "x-ratelimit-remaining") === "0" || /rate limit/i.test(msg)));
}

/**
 * Can `token` write to `repo`? POST /repos/<repo>/git/blobs needs Contents:
 * write, and only stores an unreferenced blob (always the same bytes): no
 * branch, file or history changes. Fail-safe — only a 201 means yes:
 * -> {canWrite: true} | {canWrite: false} (403/404) | {canWrite: null, why}.
 */
async function probeWrite(fetchImpl, apiBase, repo, token) {
  let res;
  let data;
  try {
    ({ res, data } = await fetchWithTimeout(
      fetchImpl,
      `${apiBase}/repos/${repo}/git/blobs`,
      {
        method: "POST",
        headers: Object.assign(ghHeaders(token), { "Content-Type": "application/json" }),
        body: JSON.stringify(WRITE_PROBE),
        cache: "no-store",
      },
      15000,
    ));
  } catch (_) {
    return { canWrite: null, why: "no answer from GitHub" };
  }
  if (res.status === 201) return { canWrite: true };
  if (isRateLimited(res, data)) return { canWrite: null, why: "GitHub rate limit reached" };
  if (res.status === 403 || res.status === 404) return { canWrite: false };
  const msg = data && typeof data.message === "string" ? data.message : "";
  return { canWrite: null, why: `GitHub answered HTTP ${res.status}${msg ? `: ${msg}` : ""}` };
}

/**
 * Check settings: GET /repos/<repo>, then (only with a token) a write probe
 * (probeWrite). Probe trouble never makes `ok` false, so it never blocks
 * Connect.
 * -> {ok, error, canWrite, private, warnings}
 * ok: the repo is readable (and the token, if any, was accepted).
 * canWrite: true (the probe wrote) | false (no token, or the probe got
 *   403/404) | null (a token, but write access couldn't be confirmed:
 *   rate limit, 5xx, an empty repo, no answer…).
 * error: null; or why ok is false; or, when ok, the hint (canWrite false
 *   with a token) or the note (canWrite null).
 * warnings: [] — except in the two-repo setup (the page is published from
 *   "<owner>/<code>" but the board is in another repo) when the token can
 *   ALSO write the code repo. The default one-repo setup never warns.
 * `loc` (optional) is the page location (default: the global `location`).
 */
export async function testGitHubSettings(settings, fetchImpl, loc) {
  if (loc === undefined) loc = typeof location !== "undefined" ? location : null;
  const f = fetchImpl || defaultFetch;
  const s = normalizeGitHubSettings(settings, loc);
  const fail = (error) => ({ ok: false, error, canWrite: false, private: false, warnings: [] });
  const bad = githubSettingsError(s);
  if (bad) return fail(bad);
  let res;
  let data;
  try {
    ({ res, data } = await fetchWithTimeout(f, `${s.apiBase}/repos/${s.repo}`, { method: "GET", headers: ghHeaders(s.token), cache: "no-store" }, 15000));
  } catch (_) {
    return fail(GH_OFFLINE_MSG);
  }
  if (res.ok && data && typeof data === "object") {
    const out = { ok: true, error: null, canWrite: false, private: data.private === true, warnings: [] };
    if (!s.token) return out;
    const code = pagesCodeRepo(loc);
    const twoRepos = !!code && repoOk(code) && code.toLowerCase() !== s.repo.toLowerCase();
    const [mine, theirs] = await Promise.all([
      probeWrite(f, s.apiBase, s.repo, s.token),
      twoRepos ? probeWrite(f, s.apiBase, code, s.token) : null,
    ]);
    out.canWrite = mine.canWrite;
    if (mine.canWrite === false) {
      out.error = `This token can read ${s.repo} but not write it — give it Contents: Read and write`;
    } else if (mine.canWrite === null) {
      out.error = `Couldn't confirm that this token can write to ${s.repo} (${mine.why}). If the sync pill turns red later, check it has Contents: Read and write`;
    }
    if (theirs && theirs.canWrite === true) {
      out.warnings.push(`This token can also change the dashboard's code (${code}). For the separate-data-repo setup, give it access to ${s.repo} only.`);
    }
    return out;
  }
  if (res.status === 401) return fail("GitHub rejected this token (expired or revoked?)");
  if (res.status === 404) {
    return fail(s.token ? "Repo not found, or the token can't see it" : "Repo not found (a private repo needs a token)");
  }
  return fail(githubFailure(res, data, { token: s.token, repo: s.repo }).message);
}

/**
 * Decide the mode for this page: fetch "api/config" (relative). JSON with
 * labhub === true => {mode: "local", config}; 404 / non-JSON / a *.github.io
 * host => {mode: "github"}; network errors (and 5xx) are retried after 300 ms
 * and 900 ms, then => {mode: "github"}.
 */
export async function detectMode({ fetchImpl, timeoutMs = 2500, retryDelaysMs = [300, 900], loc } = {}) {
  const l = loc !== undefined ? loc : typeof location !== "undefined" ? location : null;
  if (l && typeof l.hostname === "string" && l.hostname.toLowerCase().endsWith(".github.io")) return { mode: "github" };
  const f = fetchImpl || defaultFetch;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    if (attempt > 0) await sleep(retryDelaysMs[attempt - 1]);
    let res;
    let data;
    try {
      ({ res, data } = await fetchWithTimeout(f, "api/config", { cache: "no-store", headers: { Accept: "application/json" } }, timeoutMs));
    } catch (_) {
      continue;
    }
    if (res.status >= 500) continue;
    if (!res.ok) return { mode: "github" };
    if (data && typeof data === "object" && data.labhub === true) return { mode: "local", config: data };
    return { mode: "github" };
  }
  return { mode: "github" };
}

// =============================================================== GitHubSource

/**
 * Reads/writes board.json through the GitHub Contents API (sha-checked
 * rebase of pending ops — the same cycle as the Pi). Without a token it is
 * read-only and reads the file from raw.githubusercontent.com, which doesn't
 * count against GitHub's 60 requests/hour per-IP API limit (its CDN caches
 * for up to 5 minutes, so a read-only view can lag that much).
 *
 * base/sha/etag and the pending ops persist in storage under
 * "labhub:gh:<repo>:<branch>:<path>". Every tab of a browser shares that
 * key, so the stored queue is merged, never overwritten: each queued op has
 * a queue id (qid); a tab writes the union of its own queue and the ops other
 * tabs stored, minus `done` (qids already pushed, also stored). Tabs adopt
 * each other's queued ops (on "storage" events and after every pull), so an
 * edit made in a tab that closes before pushing is pushed by another tab or
 * by the next page load.
 */
export class GitHubSource {
  constructor(
    settings,
    {
      fetchImpl,
      storage,
      pollMs = 20000,
      readonlyPollMs = 90000,
      pushDelayMs = 800,
      timeoutMs = 15000,
      maxBackoffMs = MAX_BACKOFF_MS,
      readonlyWakeMs = 60000,
      rawBase,
    } = {},
  ) {
    this._s = normalizeGitHubSettings(settings);
    this.mode = "github";
    this.canEdit = !!this._s.token;
    this._fetch = fetchImpl || defaultFetch;
    this._storage = storage || defaultStorage();
    this._pollMs = pollMs;
    this._readonlyPollMs = readonlyPollMs;
    this._pushDelayMs = pushDelayMs;
    this._timeoutMs = timeoutMs;
    this._maxBackoffMs = maxBackoffMs;
    this._readonlyWakeMs = readonlyWakeMs;
    // Read-only pulls use the raw host — only in front of the real GitHub API
    // (a mock server has none). null = always read through the API.
    this._rawBase = rawBase !== undefined ? rawBase : this._s.apiBase === DEFAULT_API ? DEFAULT_RAW : null;
    this._rawBlocked = false; // raw host unreachable but the API works: read through the API
    this._rawText = null; // last body read from the raw host (it sends no sha)
    this._key = githubCacheKey(this._s);
    this._subs = new Set();

    this._base = null; // last remote board seen (normalized)
    this._sha = null;
    this._etag = null;
    this._queue = []; // pending ops in order: {qid, op}
    this._done = new Map(); // qid -> true: ops pushed (or dropped) by any tab, oldest first
    this._remoteMissing = false; // file/branch doesn't exist yet
    this._remoteInvalid = false; // file isn't valid JSON
    this._needsFix = false; // normalized remote differs from its raw parse
    this._recentPush = null; // {oldSha, until}: ignore stale reads right after a write
    this._backoffUntil = 0; // rate limited until then
    this._failures = 0; // consecutive failed cycles (exponential backoff, like the Pi)

    this._state = this.canEdit ? "syncing" : "readonly";
    this._lastError = null;
    this._lastSync = null;
    this._lastPush = null;
    this._link = "up";

    this._view = emptyBoard();
    this._viewKey = null;
    this._last = { board: null, key: "" };
    this._dirty = false;

    this._timer = null;
    this._running = null;
    this._rerun = false;
    this._active = false;
    this._halted = false;
    this._lastCycleAt = 0;
    this._controllers = new Set();
    this._unlisten = [];

    this._restore();
    this._recompute();
  }

  get board() {
    return this._view;
  }

  get sync() {
    const s = this._s;
    const pending = this._pendingCount();
    let state = this._state;
    if (state === "ok" && pending) state = "pending";
    return {
      enabled: true,
      state,
      pending,
      last_sync: this._lastSync,
      last_push: this._lastPush,
      last_error: this._lastError,
      repo: s.repo,
      branch: s.branch,
      path: s.path,
      mode: "github",
      canEdit: this.canEdit,
      link: this._link,
      file_url: `https://github.com/${s.repo}/blob/${encSegments(s.branch)}/${encSegments(s.path)}`,
      loaded: this._base !== null,
    };
  }

  /** fn({board, sync}) on every visible change. Called at once if a board is known. */
  subscribe(fn) {
    this._subs.add(fn);
    if (this._base !== null) {
      try {
        fn({ board: this._view, sync: this.sync });
      } catch (e) {
        if (typeof console !== "undefined") console.error("Lab Hub subscriber failed:", e);
      }
    }
    return () => this._subs.delete(fn);
  }

  /** Show the cached board at once (if any), run a sync cycle, then poll. */
  async start() {
    this._active = true;
    this._halted = false;
    this._listen();
    if (this._base !== null || this._queue.length) this._emit(true);
    await this._runCycle();
  }

  stop() {
    this._active = false;
    this._halted = true;
    clearTimeout(this._timer);
    this._timer = null;
    for (const off of this._unlisten.splice(0)) off();
    for (const c of Array.from(this._controllers)) c.abort();
  }

  /**
   * Validate (throws Error(message); Error("read-only") without a token;
   * "board full: …" when adds would go past LIMITS.maxItems), queue +
   * persist, apply optimistically (subscribers fire immediately), and push
   * after a short debounce (at once if the page is hidden first).
   */
  async submit(ops) {
    if (!this.canEdit) throw new Error("read-only");
    const list = validateAll(ops);
    if (!list.length) return this.sync;
    assertRoom(this._view, list);
    for (const op of list) this._queue.push({ qid: newQid(), op: prepOp(op, this._s.clientName) });
    this._dirty = true;
    this._refresh();
    this._schedule(this._pushDelayMs); // also cuts short an error backoff, like the Pi's kick()
    return this.sync;
  }

  /** Run a full sync cycle now (pull, rebase pending ops, push). */
  async syncNow() {
    await this._runCycle();
    return this.sync;
  }

  // -------------------------------------------------------------- internals

  _listen() {
    if (this._unlisten.length) return;
    const wake = () => {
      // Without a token every read costs quota (or is CDN-cached anyway): don't
      // re-read on every tab switch.
      const gap = this.canEdit ? 2000 : this._readonlyWakeMs;
      if (Date.now() - this._lastCycleAt > gap) this._runCycle();
    };
    // Push queued edits as soon as the page is hidden or left: a phone may
    // suspend it before the debounce timer fires.
    const flush = () => {
      if (this.canEdit && this._pendingCount() && this._state !== "error") this._runCycle();
    };
    if (hasDocument()) {
      this._unlisten.push(
        listen(document, "visibilitychange", () => {
          if (document.visibilityState === "visible") wake();
          else if (document.visibilityState === "hidden") flush();
        }),
      );
    }
    if (hasWindow()) {
      this._unlisten.push(listen(window, "online", wake));
      this._unlisten.push(listen(window, "pagehide", flush));
      this._unlisten.push(
        listen(window, "storage", (e) => {
          if (!e || e.key === this._key) this._onStorage();
        }),
      );
    }
  }

  // Another tab wrote our storage key: adopt the ops it queued and note the
  // ones it pushed (they leave this tab's queue after its next pull).
  _onStorage() {
    if (this._halted) return;
    if (this._mergeStored(false)) {
      this._recompute();
      this._emit();
    }
  }

  // The stored record: {data, queue: [{qid, op}], done: [qid]}, or null.
  _readStored() {
    const raw = sget(this._storage, this._key);
    if (!raw) return null;
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      return null;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const queue = [];
    const seen = new Set();
    const add = (qid, op) => {
      if (typeof qid !== "string" || !qid || seen.has(qid) || validateOp(op)) return;
      seen.add(qid);
      queue.push({ qid, op });
    };
    if (Array.isArray(data.queue)) {
      for (const e of data.queue) if (e && typeof e === "object") add(e.qid, e.op);
    } else if (Array.isArray(data.pending)) {
      // format v1 (ops without queue ids)
      for (const op of data.pending) if (!validateOp(op)) add(legacyQid(op), op);
    }
    const done = Array.isArray(data.done) ? data.done.filter((q) => typeof q === "string" && q) : [];
    return { data, queue, done };
  }

  _restore() {
    const rec = this._readStored();
    if (!rec) return;
    const data = rec.data;
    if (data.base && typeof data.base === "object") {
      this._base = normalizeBoard(data.base);
      this._sha = typeof data.sha === "string" ? data.sha : null;
      this._etag = this._sha && typeof data.etag === "string" ? data.etag : null;
    }
    for (const q of rec.done) this._noteDone(q);
    this._queue = rec.queue.filter((e) => !this._done.has(e.qid));
    if (typeof data.last_sync === "string") this._lastSync = data.last_sync;
    if (typeof data.last_push === "string") this._lastPush = data.last_push;
  }

  // Remember a pushed op's qid. mine: pushed by this tab just now (kept as the
  // newest). Returns true when it wasn't known yet.
  _noteDone(qid, mine = false) {
    const known = this._done.has(qid);
    if (known && !mine) return false;
    if (known) this._done.delete(qid);
    this._done.set(qid, true);
    while (this._done.size > DONE_CAP) this._done.delete(this._done.keys().next().value);
    return !known;
  }

  _pendingCount() {
    let n = 0;
    for (const e of this._queue) if (!this._done.has(e.qid)) n++;
    return n;
  }

  /**
   * Fold in what other tabs stored under our key: the qids they pushed
   * (`done`) and the ops they queued but haven't pushed (appended in their
   * order). dropDone: also remove pushed ops from this tab's queue — only
   * right after a pull, so the view never loses an edit its base doesn't
   * contain yet. Returns true when the queue or the pending count changed.
   */
  _mergeStored(dropDone) {
    const rec = this._readStored();
    let changed = false;
    if (rec) {
      const have = new Set(this._queue.map((e) => e.qid));
      for (const q of rec.done) if (this._noteDone(q) && have.has(q)) changed = true;
      for (const e of rec.queue) {
        if (have.has(e.qid) || this._done.has(e.qid)) continue;
        this._queue.push(e);
        have.add(e.qid);
        changed = true;
      }
    }
    if (dropDone) {
      const n = this._queue.length;
      this._queue = this._queue.filter((e) => !this._done.has(e.qid));
      if (this._queue.length !== n) changed = true;
    }
    return changed;
  }

  // Ops pushed (or found to change nothing): drop them from the queue and
  // remember their qids, so other tabs drop their copies too.
  _settle(batch) {
    const ids = new Set();
    for (const e of batch) {
      ids.add(e.qid);
      this._noteDone(e.qid, true);
    }
    this._queue = this._queue.filter((e) => !ids.has(e.qid));
    this._dirty = true;
  }

  _persist() {
    if (!this._dirty) return;
    const data = {
      v: 2,
      base: this._base,
      sha: this._sha,
      etag: this._etag,
      queue: this._queue.filter((e) => !this._done.has(e.qid)),
      done: Array.from(this._done.keys()),
      last_sync: this._lastSync,
      last_push: this._lastPush,
    };
    let ok = sset(this._storage, this._key, JSON.stringify(data));
    if (!ok) {
      // Probably over quota: keep at least the pending ops.
      ok = sset(this._storage, this._key, JSON.stringify(Object.assign(data, { base: null, sha: null, etag: null })));
    }
    if (ok) this._dirty = false;
  }

  _recompute() {
    const view = applyOps(this._base || emptyBoard(), this._queue.map((e) => e.op));
    const key = serializeBoard(view);
    if (key !== this._viewKey) {
      this._view = view;
      this._viewKey = key;
    }
  }

  _emit(force = false) {
    if (this._halted) return;
    const sync = this.sync;
    const key = JSON.stringify(sync);
    if (!force && this._last.board === this._view && this._last.key === key) return;
    this._last = { board: this._view, key };
    emitTo(this._subs, { board: this._view, sync });
  }

  _refresh() {
    // Merge first: the stored record is shared with this browser's other tabs.
    if (this._dirty) this._mergeStored(false);
    this._recompute();
    this._persist();
    this._emit();
  }

  _fail(state, message, retryAt = 0) {
    this._state = state;
    this._lastError = message;
    this._link = state === "offline" ? "down" : "up";
    if (retryAt) this._backoffUntil = retryAt;
    if (state === "error" || state === "offline") this._failures++;
    this._refresh();
  }

  // A cycle that ended well (pulled, and pushed whatever needed pushing).
  _succeeded() {
    this._failures = 0;
  }

  _interval() {
    return !this.canEdit || !isVisible() ? this._readonlyPollMs : this._pollMs;
  }

  _schedule(delayOverride) {
    if (!this._active) return;
    clearTimeout(this._timer);
    let delay;
    if (delayOverride != null) delay = delayOverride;
    else if (this.canEdit && this._pendingCount() && (this._state === "ok" || this._state === "syncing")) delay = this._pushDelayMs;
    else if (this._failures > 0 && (this._state === "error" || this._state === "offline")) {
      // interval * 2^(failures-1), capped (never shorter than the interval)
      const base = this._interval();
      delay = Math.max(base, Math.min(this._maxBackoffMs, base * 2 ** Math.min(this._failures - 1, 16)));
    } else delay = this._interval();
    const wait = this._backoffUntil - Date.now();
    if (wait > delay) delay = Math.min(wait + 500, 3600000);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._runCycle();
    }, delay);
  }

  _runCycle() {
    if (this._running) {
      this._rerun = true;
      return this._running;
    }
    clearTimeout(this._timer);
    this._timer = null;
    this._running = (async () => {
      try {
        do {
          this._rerun = false;
          await this._cycle();
        } while (this._rerun && !this._halted);
      } catch (e) {
        if (!this._halted) this._fail("error", `Sync failed: ${(e && e.message) || e}`);
      } finally {
        this._running = null;
        this._lastCycleAt = Date.now();
        this._schedule();
      }
    })();
    return this._running;
  }

  _repoUrl() {
    return `${this._s.apiBase}/repos/${this._s.repo}`;
  }

  _contentsUrl(withRef) {
    const url = `${this._repoUrl()}/contents/${encSegments(this._s.path)}`;
    return withRef ? `${url}?ref=${encodeURIComponent(this._s.branch)}` : url;
  }

  _rawUrl() {
    return `${this._rawBase}/${this._s.repo}/refs/heads/${encSegments(this._s.branch)}/${encSegments(this._s.path)}`;
  }

  // Defence in depth on top of githubSettingsError(): every request URL must
  // stay inside /repos/<repo>/ once the URL parser has resolved it.
  _urlError() {
    try {
      const repoPath = new URL(this._repoUrl()).pathname;
      const contents = new URL(this._contentsUrl(false)).pathname;
      if (repoPath.endsWith(`/repos/${this._s.repo}`) && contents.startsWith(`${repoPath}/contents/`)) return null;
    } catch (_) {
      // fall through
    }
    return "These GitHub settings don't make a valid API address — check the repo, branch and file";
  }

  // -> {res, data, text}; rejects on network errors / timeout / stop().
  _request(method, url, body, extraHeaders) {
    const headers = Object.assign(ghHeaders(this._s.token), extraHeaders || {});
    const init = { method, headers, cache: "no-store" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetchWithTimeout(this._fetch, url, init, this._timeoutMs, this._controllers);
  }

  _failure(res, data, what) {
    return githubFailure(res, data, { token: this._s.token, repo: this._s.repo, what });
  }

  _errorOf(res, data, what) {
    const f = this._failure(res, data, what);
    return { error: f.message, retryAt: f.retryAt };
  }

  _isStale(sha) {
    const r = this._recentPush;
    return !!r && Date.now() < r.until && sha === r.oldSha;
  }

  _notFoundMessage() {
    return `${this._s.path} not found on the "${this._s.branch}" branch of ${this._s.repo} — if the repo is private, add a token to view it`;
  }

  // Step 1 of the cycle. Returns {changed} | {offline} | {error, retryAt}.
  async _pull() {
    if (!this.canEdit && this._rawBase && !this._rawBlocked) {
      const r = await this._pullRaw();
      if (!r.offline || this._halted) return r;
      // The raw host may be blocked on this network: try the API.
      const a = await this._pullApi();
      if (!a.offline) this._rawBlocked = true;
      return a;
    }
    return this._pullApi();
  }

  // Read-only pull from raw.githubusercontent.com: a plain GET (no custom
  // headers, so no CORS preflight) that doesn't use the API's per-IP quota.
  async _pullRaw() {
    let res;
    let text;
    try {
      ({ res, text } = await fetchWithTimeout(this._fetch, this._rawUrl(), { method: "GET", cache: "no-cache" }, this._timeoutMs, this._controllers));
    } catch (_) {
      return { offline: true };
    }
    if (res.status === 200) {
      if (text === this._rawText && this._base && !this._remoteInvalid) return { changed: false };
      let raw;
      try {
        raw = JSON.parse(text);
      } catch (e) {
        this._remoteInvalid = true;
        return { error: `${this._s.path} on GitHub is not valid JSON: ${(e && e.message) || e}` };
      }
      this._base = normalizeBoard(raw);
      this._sha = null; // the raw host sends no blob sha
      this._etag = null;
      this._rawText = text;
      this._remoteMissing = false;
      this._remoteInvalid = false;
      this._needsFix = false; // read-only: nothing to fix
      this._dirty = true;
      return { changed: true };
    }
    // A 404 can't tell "no such file" from "private repo": one message, no extra request.
    if (res.status === 404) return { error: this._notFoundMessage() };
    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(header(res, "retry-after"));
      return {
        error: `GitHub is limiting requests from this network (HTTP ${res.status}) — will retry`,
        retryAt: Date.now() + (retryAfter > 0 ? retryAfter * 1000 : 60000),
      };
    }
    return { error: `GitHub returned HTTP ${res.status} for ${this._s.path}` };
  }

  async _pullApi() {
    const extra = {};
    if (this._etag && this._base && this._sha) extra["If-None-Match"] = this._etag;
    let res;
    let data;
    try {
      ({ res, data } = await this._request("GET", this._contentsUrl(true), undefined, extra));
    } catch (_) {
      return { offline: true };
    }
    if (res.status === 304) return { changed: false };
    if (res.status === 200) {
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return { error: `GitHub sent an unexpected reply for ${this._s.path} (is it a folder?)` };
      }
      const sha = typeof data.sha === "string" ? data.sha : null;
      if (this._isStale(sha)) return { changed: false };
      const etag = header(res, "etag");
      if (sha && sha === this._sha && this._base && !this._remoteInvalid) {
        if (etag && etag !== this._etag) {
          this._etag = etag;
          this._dirty = true;
        }
        this._remoteMissing = false;
        return { changed: false };
      }
      let b64 = typeof data.content === "string" ? data.content : "";
      if (sha && (data.encoding === "none" || (!b64 && data.size > 0))) {
        // Files over 1 MB come without content; fetch the blob instead.
        let blobRes;
        let blob;
        try {
          ({ res: blobRes, data: blob } = await this._request("GET", `${this._repoUrl()}/git/blobs/${sha}`));
        } catch (_) {
          return { offline: true };
        }
        if (!blobRes.ok) return this._errorOf(blobRes, blob, "read");
        b64 = blob && typeof blob.content === "string" ? blob.content : "";
      }
      let raw;
      try {
        raw = JSON.parse(base64ToUtf8(b64));
      } catch (e) {
        this._remoteInvalid = true;
        return { error: `${this._s.path} on GitHub is not valid JSON: ${(e && e.message) || e}` };
      }
      const board = normalizeBoard(raw);
      this._base = board;
      this._sha = sha;
      this._etag = etag || null;
      this._remoteMissing = false;
      this._remoteInvalid = false;
      this._needsFix = !jsonEqual(raw, board);
      this._dirty = true;
      return { changed: true };
    }
    if (res.status === 404) {
      // Without a token the repo check would cost another of the 60 requests
      // an hour this IP gets — and read-only can't create the file anyway.
      if (!this.canEdit) return { error: this._notFoundMessage() };
      // The file or the branch doesn't exist yet — or the repo is invisible.
      let repoRes;
      let repo;
      try {
        ({ res: repoRes, data: repo } = await this._request("GET", this._repoUrl()));
      } catch (_) {
        return { offline: true };
      }
      if (repoRes.status === 404) return { error: "repo not found, or the token can't see it" };
      if (!repoRes.ok) return this._errorOf(repoRes, repo, "read");
      if (this._isStale(null)) return { changed: false };
      this._base = emptyBoard();
      this._sha = null;
      this._etag = null;
      this._remoteMissing = true;
      this._remoteInvalid = false;
      this._needsFix = false;
      this._dirty = true;
      return { changed: true };
    }
    return this._errorOf(res, data, "read");
  }

  // PUT the file.
  // Returns {ok, sha} | {conflict, message} | {branchMissing, status, message} | {offline} | {error, retryAt}.
  async _put(doc, message) {
    const body = { message, content: utf8ToBase64(serializeBoard(doc)), branch: this._s.branch };
    if (this._sha) body.sha = this._sha;
    let res;
    let data;
    try {
      ({ res, data } = await this._request("PUT", this._contentsUrl(false), body));
    } catch (_) {
      return { offline: true };
    }
    if (res.status === 200 || res.status === 201) {
      const sha = data && data.content && typeof data.content.sha === "string" ? data.content.sha : null;
      return { ok: true, sha };
    }
    const msg = data && typeof data.message === "string" ? data.message : "";
    // Classified like the Pi (github_sync._is_sha_conflict / _is_branch_missing).
    if (res.status === 409 || (res.status === 422 && /sha/i.test(msg))) return { conflict: true, message: msg };
    if ((res.status === 404 || res.status === 422) && /branch/i.test(msg) && /not found/i.test(msg)) {
      return { branchMissing: true, status: res.status, message: msg };
    }
    if (res.status === 422) return { error: `GitHub rejected the write (422)${msg ? `: ${msg}` : ""}` };
    if (res.status === 404) {
      return { error: `GitHub refused the write (404)${msg ? `: ${msg}` : ""} — check the token has Contents: read & write on ${this._s.repo}` };
    }
    return this._errorOf(res, data, "write");
  }

  // Create the data branch from the default branch.
  // Returns {created} | {exists} | {offline} | {error, retryAt}.
  async _createBranch() {
    const api = this._repoUrl();
    const branch = this._s.branch;
    try {
      const { res: repoRes, data: repo } = await this._request("GET", api);
      if (repoRes.status === 404) return { error: "repo not found, or the token can't see it" };
      if (!repoRes.ok) return this._errorOf(repoRes, repo, "read");
      const def = repo && typeof repo.default_branch === "string" ? repo.default_branch : "main";
      if (def === branch) return { exists: true };
      const { res: refRes, data: ref } = await this._request("GET", `${api}/git/ref/heads/${encSegments(def)}`);
      if (refRes.status === 404 || refRes.status === 409) {
        return { error: `Can't create the "${branch}" branch: "${def}" has no commits yet (push the code first)` };
      }
      if (!refRes.ok) return this._errorOf(refRes, ref, "read");
      const sha = ref && ref.object && typeof ref.object.sha === "string" ? ref.object.sha : null;
      if (!sha) return { error: `GitHub sent an unexpected reply for branch "${def}"` };
      const { res: postRes, data } = await this._request("POST", `${api}/git/refs`, { ref: `refs/heads/${branch}`, sha });
      if (postRes.ok) return { created: true };
      const msg = data && typeof data.message === "string" ? data.message : "";
      if (postRes.status === 422 && /already exists/i.test(msg)) return { exists: true };
      if (postRes.status === 422) return { error: `Couldn't create branch "${branch}": ${msg || "rejected"}` };
      return this._errorOf(postRes, data, "write");
    } catch (_) {
      return { offline: true };
    }
  }

  _commitMessage(ops) {
    const who = cleanString(this._s.clientName, LIMITS.by) || "web";
    if (ops.length) {
      const { subject, body } = summarizeOps(ops, this._base, who);
      return body ? `${subject}\n\n${body}` : subject;
    }
    if (this._remoteMissing) return `${who}: create ${this._s.path}`;
    return `${who}: tidy ${this._s.path} (normalize hand edits)`;
  }

  async _cycle() {
    if (!repoOk(this._s.repo)) {
      this._fail("error", "Set the GitHub repo (owner/name) in Settings");
      return;
    }
    const bad = githubSettingsError(this._s) || this._urlError();
    if (bad) {
      this._fail("error", bad);
      return;
    }
    if (Date.now() < this._backoffUntil) return; // rate limited: wait for the reset
    let lastConflict = "";
    let branchCreated = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // 1. pull
      const r = await this._pull();
      if (this._halted) return;
      if (r.offline) return this._fail("offline", GH_OFFLINE_MSG);
      if (r.error) return this._fail("error", r.error, r.retryAt);
      this._link = "up";
      this._lastSync = nowIso();
      this._lastError = null;
      this._backoffUntil = 0;
      this._state = this.canEdit ? "ok" : "readonly";
      // 2. new view (with ops other tabs queued; minus the ones they pushed)
      if (this._mergeStored(true)) this._dirty = true;
      this._refresh();
      if (!this.canEdit) return this._succeeded();
      // 3. push if needed
      const batch = this._queue.slice();
      if (!batch.length && !this._remoteMissing && !this._needsFix) return this._succeeded();
      const ops = batch.map((e) => e.op);
      const doc = applyOps(this._base, ops);
      if (!this._remoteMissing && !this._needsFix && contentKey(doc) === contentKey(this._base)) {
        // These ops change nothing on GitHub (e.g. edits to items deleted elsewhere).
        this._settle(batch);
        this._refresh();
        return this._succeeded();
      }
      const last = ops.length ? canonicalTimestamp(ops[ops.length - 1].ts) : null;
      const out = Object.assign({}, doc, {
        updated_at: last || nowIso(),
        updated_by: cleanString(this._s.clientName, LIMITS.by) || "web",
      });
      this._state = "syncing";
      this._emit();
      const w = await this._put(out, this._commitMessage(ops));
      if (this._halted) return;
      if (w.offline) return this._fail("offline", GH_OFFLINE_MSG);
      if (w.ok) {
        this._recentPush = { oldSha: this._sha, until: Date.now() + STALE_WINDOW_MS };
        this._base = normalizeBoard(out);
        this._sha = w.sha;
        this._etag = null;
        this._remoteMissing = false;
        this._needsFix = false;
        this._settle(batch); // exactly the ops in this PUT; newer ones stay queued
        this._lastPush = nowIso();
        this._lastSync = this._lastPush;
        this._state = "ok";
        this._refresh();
        return this._succeeded();
      }
      if (w.conflict) {
        // Someone else wrote first: refetch, replay, retry. (After the last
        // attempt keep the etag, so the next cycle's GET can be a free 304.)
        lastConflict = w.message || "";
        if (attempt < MAX_ATTEMPTS - 1) this._etag = null;
        continue;
      }
      if (w.branchMissing && !branchCreated) {
        branchCreated = true;
        const c = await this._createBranch();
        if (this._halted) return;
        if (c.offline) return this._fail("offline", GH_OFFLINE_MSG);
        if (c.error) return this._fail("error", c.error, c.retryAt);
        this._etag = null;
        continue;
      }
      if (w.branchMissing) {
        return this._fail(
          "error",
          `GitHub refused the write (${w.status})${w.message ? `: ${w.message}` : ""} — check the token has Contents: read & write on ${this._s.repo}`,
        );
      }
      return this._fail("error", w.error, w.retryAt);
    }
    // Every attempt was refused as a conflict. A real race clears up by
    // itself; one that doesn't (branch protection, a ruleset) must not become
    // a request storm: report GitHub's words and back off (see _schedule).
    this._fail("error", `${this._s.path} kept changing on GitHub while saving; will retry${lastConflict ? ` (GitHub: ${lastConflict})` : ""}`);
  }
}
