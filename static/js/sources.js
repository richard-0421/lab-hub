// Lab Hub data sources (docs/ARCHITECTURE.md §4–5).
//
//   LocalSource   — the page is served by the Pi; talks to its API with
//                   relative URLs (api/board, api/ops, api/sync).
//   GitHubSource  — the page runs anywhere (GitHub Pages); reads/writes
//                   board.json on the `data` branch through the GitHub REST
//                   API, mirroring the Pi's sync cycle in the browser.
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
  cleanString,
  emptyBoard,
  normalizeBoard,
  nowIso,
  serializeBoard,
  summarizeOps,
  validateOp,
} from "./board.js";

export const DEFAULT_REPO = "richard-0417/lab-hub";
export const DEFAULT_BRANCH = "data";
export const DEFAULT_PATH = "board.json";
export const DEFAULT_API = "https://api.github.com";
export const SETTINGS_KEY = "labhub:github";

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TOKEN_RE = /^[\x21-\x7e]*$/; // printable ASCII (or empty); anything else can't go in a header
const BAD_TOKEN_MSG = "The GitHub token contains invalid characters — paste it again";
const LOCAL_OFFLINE_MSG = "Can't reach the dashboard server";
const GH_OFFLINE_MSG = "Can't reach GitHub";
const STALE_WINDOW_MS = 15000;
const MAX_ATTEMPTS = 3;

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

async function fetchWithTimeout(fetchImpl, url, init, ms, controllers) {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  let timer = null;
  if (ctrl) {
    timer = setTimeout(() => ctrl.abort(), ms);
    if (controllers) controllers.add(ctrl);
  }
  try {
    return await fetchImpl(url, ctrl ? Object.assign({}, init, { signal: ctrl.signal }) : init);
  } finally {
    if (timer) clearTimeout(timer);
    if (ctrl && controllers) controllers.delete(ctrl);
  }
}

async function readJson(res) {
  try {
    return await res.json();
  } catch (_) {
    return null;
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

function validateAll(ops) {
  const list = Array.isArray(ops) ? ops : [ops];
  for (const op of list) {
    const err = validateOp(op);
    if (err) throw new Error(err);
  }
  return list;
}

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
   * Validate (throws Error(message) on an invalid op), apply optimistically
   * (subscribers fire before this returns its promise), then POST. Network
   * failures keep the ops in the outbox (retried on the next poll); a 400
   * reloads the board from the Pi and rejects with the server's error.
   */
  async submit(ops) {
    const list = validateAll(ops);
    if (!list.length) return this.sync;
    const prepared = list.map((op) => prepOp(op, this.clientName));
    this._outbox.push(...prepared);
    this._recompute();
    this._emit();
    const { rejected } = await this._enqueue(() => this._flush());
    const mine = rejected.filter((r) => prepared.includes(r.op));
    if (mine.length) throw new Error(mine[0].error);
    return this.sync;
  }

  /** Flush the outbox, ask the Pi to run a GitHub sync cycle now, reload. */
  async syncNow() {
    return this._enqueue(async () => {
      if (this._outbox.length) await this._flush();
      try {
        const res = await this._request("POST", "api/sync", undefined, this._syncTimeoutMs);
        this._link = "up";
        const data = await readJson(res);
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
    try {
      res = await this._request("GET", url);
    } catch (_) {
      if (this._halted) return false;
      this._link = "down";
      this._recompute();
      this._emit();
      return false;
    }
    this._link = "up";
    const data = await readJson(res);
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

  async _flush() {
    const rejected = [];
    while (this._outbox.length && !this._halted) {
      const batch = this._outbox.slice(0, LIMITS.maxOpsPerPost);
      let res;
      try {
        res = await this._request("POST", "api/ops", { ops: batch });
      } catch (_) {
        if (this._halted) break;
        this._link = "down";
        this._recompute();
        this._emit();
        break;
      }
      this._link = "up";
      const data = await readJson(res);
      if (res.ok && data && typeof data === "object" && data.board) {
        this._httpError = null;
        this._dropFromOutbox(batch);
        this._adopt(data);
        this._recompute();
        this._emit();
        continue;
      }
      if (res.status === 400) {
        const error = (data && typeof data.error === "string" && data.error) || "The dashboard server rejected the change";
        const idx = data && Number.isInteger(data.index) && data.index >= 0 && data.index < batch.length ? data.index : -1;
        const bad = idx >= 0 ? [batch[idx]] : batch;
        for (const op of bad) rejected.push({ op, error });
        this._dropFromOutbox(bad);
        continue; // the remaining ops are retried
      }
      this._httpError = `Dashboard server error (HTTP ${res.status})`;
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
      if (this._outbox.length) {
        const { rejected } = await this._flush();
        if (rejected.length && typeof console !== "undefined") console.warn("Lab Hub: server rejected queued ops:", rejected);
        return;
      }
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

/** Fill defaults and tidy a settings object (accepts a pasted github.com URL as repo). */
export function normalizeGitHubSettings(settings) {
  const s = settings && typeof settings === "object" ? settings : {};
  const repo = str(s.repo)
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  return {
    apiBase: (str(s.apiBase) || DEFAULT_API).replace(/\/+$/, ""),
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
 * Defaults for this page: repo inferred from "<owner>.github.io/<repo>/…"
 * (root site => "<owner>/<owner>.github.io"), else "richard-0417/lab-hub".
 * ?repo= ?branch= ?path= ?api= prefill these defaults (they never override
 * saved settings — use `loadGitHubSettings() || defaultGitHubSettings()`).
 */
export function defaultGitHubSettings(loc) {
  if (loc === undefined) loc = typeof location !== "undefined" ? location : null;
  let repo = DEFAULT_REPO;
  const host = loc && typeof loc.hostname === "string" ? loc.hostname.toLowerCase() : "";
  if (host.endsWith(".github.io") && host.length > ".github.io".length) {
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
    repo = name && (isDir || !/\.html?$/i.test(name)) ? `${owner}/${name}` : `${owner}/${owner}.github.io`;
  }
  const s = { apiBase: DEFAULT_API, repo, branch: DEFAULT_BRANCH, path: DEFAULT_PATH, token: "", clientName: "" };
  let q = null;
  try {
    q = new URLSearchParams((loc && loc.search) || "");
  } catch (_) {
    q = null;
  }
  if (q) {
    if (str(q.get("repo"))) s.repo = str(q.get("repo"));
    if (str(q.get("branch"))) s.branch = str(q.get("branch"));
    if (str(q.get("path"))) s.path = str(q.get("path"));
    if (str(q.get("api"))) s.apiBase = str(q.get("api"));
  }
  return normalizeGitHubSettings(s);
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

/**
 * Check settings against GET /repos/<repo>.
 * -> {ok, error, canWrite, private}
 * ok: the repo is readable (and the token, if any, was accepted).
 * canWrite: permissions.push === true (always false without a token).
 * error: null, or a message (also set when ok but a token can't write).
 */
export async function testGitHubSettings(settings, fetchImpl) {
  const s = normalizeGitHubSettings(settings);
  const fail = (error) => ({ ok: false, error, canWrite: false, private: false });
  if (!REPO_RE.test(s.repo)) return fail("Repo must look like owner/name");
  if (!TOKEN_RE.test(s.token)) return fail(BAD_TOKEN_MSG);
  let res;
  try {
    res = await fetchWithTimeout(
      fetchImpl || defaultFetch,
      `${s.apiBase}/repos/${s.repo}`,
      { method: "GET", headers: ghHeaders(s.token), cache: "no-store" },
      15000,
    );
  } catch (_) {
    return fail(GH_OFFLINE_MSG);
  }
  const data = await readJson(res);
  if (res.ok && data && typeof data === "object") {
    const canWrite = !!s.token && !!(data.permissions && data.permissions.push === true);
    const error = s.token && !canWrite ? "The token works, but it can't write to this repo (needs Contents: read & write)" : null;
    return { ok: true, error, canWrite, private: data.private === true };
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
    try {
      res = await fetchWithTimeout(f, "api/config", { cache: "no-store", headers: { Accept: "application/json" } }, timeoutMs);
    } catch (_) {
      continue;
    }
    if (res.status >= 500) continue;
    if (!res.ok) return { mode: "github" };
    const data = await readJson(res);
    if (data && typeof data === "object" && data.labhub === true) return { mode: "local", config: data };
    return { mode: "github" };
  }
  return { mode: "github" };
}

// =============================================================== GitHubSource

/**
 * Reads/writes board.json through the GitHub Contents API (sha-checked
 * rebase of pending ops — the same cycle as the Pi). Without a token it is
 * read-only. base/sha/etag/pending persist in storage under
 * "labhub:gh:<repo>:<branch>:<path>".
 */
export class GitHubSource {
  constructor(settings, { fetchImpl, storage, pollMs = 20000, readonlyPollMs = 90000, pushDelayMs = 800, timeoutMs = 15000 } = {}) {
    this._s = normalizeGitHubSettings(settings);
    this.mode = "github";
    this.canEdit = !!this._s.token;
    this._fetch = fetchImpl || defaultFetch;
    this._storage = storage || defaultStorage();
    this._pollMs = pollMs;
    this._readonlyPollMs = readonlyPollMs;
    this._pushDelayMs = pushDelayMs;
    this._timeoutMs = timeoutMs;
    this._key = githubCacheKey(this._s);
    this._subs = new Set();

    this._base = null; // last remote board seen (normalized)
    this._sha = null;
    this._etag = null;
    this._pending = [];
    this._remoteMissing = false; // file/branch doesn't exist yet
    this._remoteInvalid = false; // file isn't valid JSON
    this._needsFix = false; // normalized remote differs from its raw parse
    this._recentPush = null; // {oldSha, until}: ignore stale reads right after a write
    this._backoffUntil = 0;

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
    let state = this._state;
    if (state === "ok" && this._pending.length) state = "pending";
    return {
      enabled: true,
      state,
      pending: this._pending.length,
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
    if (this._base !== null || this._pending.length) this._emit(true);
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
   * Validate (throws Error(message); Error("read-only") without a token),
   * queue + persist, apply optimistically (subscribers fire immediately),
   * and push after a short debounce.
   */
  async submit(ops) {
    if (!this.canEdit) throw new Error("read-only");
    const list = validateAll(ops);
    if (!list.length) return this.sync;
    this._pending.push(...list.map((op) => prepOp(op, this._s.clientName)));
    this._dirty = true;
    this._refresh();
    this._schedule(this._pushDelayMs);
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
      if (Date.now() - this._lastCycleAt > 2000) this._runCycle();
    };
    if (hasDocument()) {
      this._unlisten.push(
        listen(document, "visibilitychange", () => {
          if (document.visibilityState === "visible") wake();
        }),
      );
    }
    if (hasWindow()) this._unlisten.push(listen(window, "online", wake));
  }

  _restore() {
    const raw = sget(this._storage, this._key);
    if (!raw) return;
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      return;
    }
    if (!data || typeof data !== "object") return;
    if (data.base && typeof data.base === "object") {
      this._base = normalizeBoard(data.base);
      this._sha = typeof data.sha === "string" ? data.sha : null;
      this._etag = this._sha && typeof data.etag === "string" ? data.etag : null;
    }
    if (Array.isArray(data.pending)) this._pending = data.pending.filter((op) => !validateOp(op));
    if (typeof data.last_sync === "string") this._lastSync = data.last_sync;
    if (typeof data.last_push === "string") this._lastPush = data.last_push;
  }

  _persist() {
    if (!this._dirty) return;
    const data = {
      v: 1,
      base: this._base,
      sha: this._sha,
      etag: this._etag,
      pending: this._pending,
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
    const view = applyOps(this._base || emptyBoard(), this._pending);
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
    this._recompute();
    this._persist();
    this._emit();
  }

  _fail(state, message, retryAt = 0) {
    this._state = state;
    this._lastError = message;
    this._link = state === "offline" ? "down" : "up";
    if (retryAt) this._backoffUntil = retryAt;
    this._refresh();
  }

  _interval() {
    return !this.canEdit || !isVisible() ? this._readonlyPollMs : this._pollMs;
  }

  _schedule(delayOverride) {
    if (!this._active) return;
    clearTimeout(this._timer);
    let delay;
    if (delayOverride != null) delay = delayOverride;
    else if (this.canEdit && this._pending.length && (this._state === "ok" || this._state === "syncing")) delay = this._pushDelayMs;
    else delay = this._interval();
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

  _request(method, url, body, extraHeaders) {
    const headers = Object.assign(ghHeaders(this._s.token), extraHeaders || {});
    const init = { method, headers, cache: "no-store" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return fetchWithTimeout(this._fetch, url, init, this._timeoutMs, this._controllers);
  }

  async _failure(res, data, what) {
    const d = data === undefined ? await readJson(res) : data;
    return githubFailure(res, d, { token: this._s.token, repo: this._s.repo, what });
  }

  _isStale(sha) {
    const r = this._recentPush;
    return !!r && Date.now() < r.until && sha === r.oldSha;
  }

  // Step 1 of the cycle. Returns {changed} | {offline} | {error, retryAt}.
  async _pull() {
    const extra = {};
    if (this._etag && this._base && this._sha) extra["If-None-Match"] = this._etag;
    let res;
    try {
      res = await this._request("GET", this._contentsUrl(true), undefined, extra);
    } catch (_) {
      return { offline: true };
    }
    if (res.status === 304) return { changed: false };
    if (res.status === 200) {
      const data = await readJson(res);
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
        try {
          blobRes = await this._request("GET", `${this._repoUrl()}/git/blobs/${sha}`);
        } catch (_) {
          return { offline: true };
        }
        if (!blobRes.ok) return this._errorOf(blobRes, "read");
        const blob = await readJson(blobRes);
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
      // The file or the branch doesn't exist yet — or the repo is invisible.
      let repoRes;
      try {
        repoRes = await this._request("GET", this._repoUrl());
      } catch (_) {
        return { offline: true };
      }
      if (repoRes.status === 404) return { error: "repo not found, or the token can't see it" };
      if (!repoRes.ok) {
        const f = await this._failure(repoRes, undefined, "read");
        return { error: f.message, retryAt: f.retryAt };
      }
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
    const f = await this._failure(res, undefined, "read");
    return { error: f.message, retryAt: f.retryAt };
  }

  // PUT the file. Returns {ok, sha} | {conflict} | {branchMissing, status, message} | {offline} | {error, retryAt}.
  async _put(doc, message) {
    const body = { message, content: utf8ToBase64(serializeBoard(doc)), branch: this._s.branch };
    if (this._sha) body.sha = this._sha;
    let res;
    try {
      res = await this._request("PUT", this._contentsUrl(false), body);
    } catch (_) {
      return { offline: true };
    }
    const data = await readJson(res);
    if (res.status === 200 || res.status === 201) {
      const sha = data && data.content && typeof data.content.sha === "string" ? data.content.sha : null;
      return { ok: true, sha };
    }
    const msg = data && typeof data.message === "string" ? data.message : "";
    if (res.status === 409) return { conflict: true };
    if (res.status === 422) {
      if (/sha/i.test(msg)) return { conflict: true };
      if (/branch|ref/i.test(msg)) return { branchMissing: true, status: 422, message: msg };
      return { error: `GitHub rejected the write (422)${msg ? `: ${msg}` : ""}` };
    }
    if (res.status === 404) return { branchMissing: true, status: 404, message: msg };
    const f = await this._failure(res, data, "write");
    return { error: f.message, retryAt: f.retryAt };
  }

  // Create the data branch from the default branch.
  // Returns {created} | {exists} | {offline} | {error, retryAt}.
  async _createBranch() {
    const api = this._repoUrl();
    const branch = this._s.branch;
    try {
      const repoRes = await this._request("GET", api);
      if (repoRes.status === 404) return { error: "repo not found, or the token can't see it" };
      if (!repoRes.ok) return this._errorOf(repoRes, "read");
      const repo = await readJson(repoRes);
      const def = repo && typeof repo.default_branch === "string" ? repo.default_branch : "main";
      if (def === branch) return { exists: true };
      const refRes = await this._request("GET", `${api}/git/ref/heads/${encSegments(def)}`);
      if (refRes.status === 404 || refRes.status === 409) {
        return { error: `Can't create the "${branch}" branch: "${def}" has no commits yet (push the code first)` };
      }
      if (!refRes.ok) return this._errorOf(refRes, "read");
      const ref = await readJson(refRes);
      const sha = ref && ref.object && typeof ref.object.sha === "string" ? ref.object.sha : null;
      if (!sha) return { error: `GitHub sent an unexpected reply for branch "${def}"` };
      const postRes = await this._request("POST", `${api}/git/refs`, { ref: `refs/heads/${branch}`, sha });
      if (postRes.ok) return { created: true };
      const data = await readJson(postRes);
      const msg = data && typeof data.message === "string" ? data.message : "";
      if (postRes.status === 422 && /already exists/i.test(msg)) return { exists: true };
      if (postRes.status === 422) return { error: `Couldn't create branch "${branch}": ${msg || "rejected"}` };
      return this._errorOf(postRes, "write", data);
    } catch (_) {
      return { offline: true };
    }
  }

  async _errorOf(res, what, data) {
    const f = await this._failure(res, data, what);
    return { error: f.message, retryAt: f.retryAt };
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
    if (!REPO_RE.test(this._s.repo)) {
      this._fail("error", "Set the GitHub repo (owner/name) in Settings");
      return;
    }
    if (!TOKEN_RE.test(this._s.token)) {
      this._fail("error", BAD_TOKEN_MSG);
      return;
    }
    if (Date.now() < this._backoffUntil) return; // rate limited: wait for the reset
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
      // 2. new view
      this._refresh();
      if (!this.canEdit) return;
      // 3. push if needed
      const k = this._pending.length;
      if (k === 0 && !this._remoteMissing && !this._needsFix) return;
      const ops = this._pending.slice(0, k);
      const doc = applyOps(this._base, ops);
      if (!this._remoteMissing && !this._needsFix && contentKey(doc) === contentKey(this._base)) {
        // These ops change nothing on GitHub (e.g. edits to items deleted elsewhere).
        this._pending.splice(0, k);
        this._dirty = true;
        this._refresh();
        return;
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
        this._pending.splice(0, k);
        this._lastPush = nowIso();
        this._lastSync = this._lastPush;
        this._state = "ok";
        this._dirty = true;
        this._refresh();
        return;
      }
      if (w.conflict) {
        this._etag = null; // someone else wrote first: refetch, replay, retry
        continue;
      }
      if (w.branchMissing) {
        const c = await this._createBranch();
        if (this._halted) return;
        if (c.offline) return this._fail("offline", GH_OFFLINE_MSG);
        if (c.error) return this._fail("error", c.error, c.retryAt);
        if (c.exists && w.status === 404) {
          return this._fail(
            "error",
            `GitHub refused the write (404)${w.message ? `: ${w.message}` : ""} — check the token has Contents: read & write on ${this._s.repo}`,
          );
        }
        this._etag = null;
        continue;
      }
      return this._fail("error", w.error, w.retryAt);
    }
    // Every attempt lost a race; keep the ops and try again shortly.
    this._state = "ok";
    this._lastError = "The board kept changing on GitHub while saving — retrying";
    this._refresh();
  }
}
