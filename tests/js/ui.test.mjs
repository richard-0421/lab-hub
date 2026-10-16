// UI logic (static/js/ui/*): the pure decisions the page wires to the DOM,
// plus a few DOM-level checks on a small fake document (tests/js/fake-dom.mjs).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as B from "../../static/js/board.js";
import { GitHubSource, saveGitHubSettings, loadGitHubSettings, clearGitHubSettings, githubCacheKey, utf8ToBase64 } from "../../static/js/sources.js";
import {
  ABANDONED_MS,
  RECENT_INPUT_MS,
  forgetGitHub,
  hasDraft,
  isKioskHost,
  isLoopbackHost,
  personName,
  unsentOps,
  versionReloadBlocker,
} from "../../static/js/ui/lifecycle.js";
import { DIALOG_KEY_GUARD_MS, cardKeyAction, keyArm, leaveStatusSet } from "../../static/js/ui/tasks.js";
import { resolveDropIndex } from "../../static/js/ui/dnd.js";
import { taskUpdateSet } from "../../static/js/ui/task-editor.js";
import { calendarEntries } from "../../static/js/ui/calendar.js";
import { readOnlyConfirm, openSetup } from "../../static/js/ui/setup.js";
import { initRequests } from "../../static/js/ui/requests.js";
import { initNotes } from "../../static/js/ui/notes.js";
import { initHeader } from "../../static/js/ui/header.js";
import { installDom } from "./fake-dom.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TS = "2026-10-16T14:00:00Z";
const tick = () => new Promise((r) => setTimeout(r, 0));

// ------------------------------------------------------------- kiosk / names
describe("shared kiosk detection and names", () => {
  test("loopback hosts", () => {
    for (const h of ["localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "[::1]", "::1", "pi.localhost"]) assert.equal(isLoopbackHost(h), true, h);
    for (const h of ["labpi.local", "192.168.1.20", "richard-0417.github.io", "", null, "localhost.example.com"]) assert.equal(isLoopbackHost(h), false, String(h));
  });

  test("the kiosk is local mode on loopback only", () => {
    assert.equal(isKioskHost("local", "localhost"), true);
    assert.equal(isKioskHost("local", "127.0.0.1"), true);
    assert.equal(isKioskHost("local", "labpi.local"), false); // a laptop on the LAN
    assert.equal(isKioskHost("github", "localhost"), false); // Pages-style test server
  });

  test("the kiosk never attributes edits to a remembered name", () => {
    assert.equal(personName({ kiosk: true, stored: "Priya", clientName: "Priya" }), "");
    assert.equal(personName({ kiosk: false, stored: "Priya", clientName: "Richard" }), "Priya");
    assert.equal(personName({ kiosk: false, stored: "", clientName: "Richard" }), "Richard");
    assert.equal(personName({}), "");
  });
});

// ------------------------------------------------------------ version reload
describe("versionReloadBlocker (kiosk auto-update)", () => {
  const now = 10_000_000;
  const idle = now - RECENT_INPUT_MS - 1;

  test("idle page with an empty focused field reloads (quick-add keeps focus after Enter)", () => {
    assert.equal(versionReloadBlocker({ now, pendingSince: now, lastInputAt: idle, focusedDraft: false }), "");
  });

  test("unsent edits always block, even when the page looks abandoned", () => {
    assert.equal(versionReloadBlocker({ now, pendingSince: now - 2 * ABANDONED_MS, lastInputAt: 0, unsent: 1 }), "unsent");
  });

  test("someone at the screen right now blocks", () => {
    assert.equal(versionReloadBlocker({ now, pendingSince: now, lastInputAt: now - 5000 }), "active");
  });

  test("a typed draft, an open dialog or a drag block while recent", () => {
    assert.equal(versionReloadBlocker({ now, pendingSince: now, lastInputAt: idle, focusedDraft: true }), "draft");
    assert.equal(versionReloadBlocker({ now, pendingSince: now, lastInputAt: idle, dialogOpen: true }), "dialog");
    assert.equal(versionReloadBlocker({ now, pendingSince: now, lastInputAt: idle, dragging: true }), "drag");
  });

  test("an abandoned dialog or draft stops blocking after ABANDONED_MS without input", () => {
    const old = now - ABANDONED_MS;
    assert.equal(versionReloadBlocker({ now, pendingSince: old, lastInputAt: old, dialogOpen: true }), "");
    assert.equal(versionReloadBlocker({ now, pendingSince: old, lastInputAt: old, focusedDraft: true }), "");
    // ...but not while the update is still fresh, nor if someone touched it meanwhile.
    assert.equal(versionReloadBlocker({ now, pendingSince: now - 1000, lastInputAt: old, dialogOpen: true }), "dialog");
    assert.equal(versionReloadBlocker({ now, pendingSince: old, lastInputAt: now - ABANDONED_MS / 2, focusedDraft: true }), "draft");
  });

  test("unsentOps counts only LocalSource's in-memory outbox", () => {
    assert.equal(unsentOps(null), 0);
    assert.equal(unsentOps({ mode: "local", _outbox: [1, 2] }), 2);
    assert.equal(unsentOps({ mode: "local", unsent: 3, _outbox: [] }), 3);
    assert.equal(unsentOps({ mode: "github", _pending: [1], sync: { pending: 1 } }), 0); // persisted
    assert.equal(unsentOps({ mode: "local" }), 0);
  });

  test("hasDraft: only text fields with text in them", () => {
    const el = (tagName, type, value) => ({ nodeType: 1, tagName, value, isContentEditable: false, getAttribute: (n) => (n === "type" ? type : null) });
    assert.equal(hasDraft(el("INPUT", "text", "")), false);
    assert.equal(hasDraft(el("INPUT", "text", "  ")), false);
    assert.equal(hasDraft(el("INPUT", "search", "pump")), true);
    assert.equal(hasDraft(el("INPUT", null, "x")), true);
    assert.equal(hasDraft(el("TEXTAREA", null, "note")), true);
    assert.equal(hasDraft(el("SELECT", null, "manual")), false);
    assert.equal(hasDraft(el("INPUT", "checkbox", "on")), false);
    assert.equal(hasDraft(null), false);
  });
});

// --------------------------------------------------------------- forget token
function memStorage() {
  const m = new Map();
  return { map: m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

function fakeGitHub() {
  const gh = { text: "", sha: "", gate: null, putStatus: 502 };
  gh.set = (board) => {
    gh.text = B.serializeBoard(B.normalizeBoard(board));
    gh.sha = crypto.createHash("sha1").update(gh.text).digest("hex");
  };
  gh.fetch = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    if (method === "GET" && url.includes("/contents/")) {
      if (gh.gate) await gh.gate;
      return new Response(JSON.stringify({ type: "file", encoding: "base64", content: utf8ToBase64(gh.text), sha: gh.sha, size: gh.text.length }), {
        status: 200,
        headers: { "content-type": "application/json", etag: `"${gh.sha}"` },
      });
    }
    if (method === "PUT") return new Response(JSON.stringify({ message: "Bad gateway" }), { status: gh.putStatus, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ default_branch: "main", permissions: { push: true } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return gh;
}

describe("forgetGitHub", () => {
  test("stops the source before clearing, so an in-flight cycle can't restore dropped edits", async () => {
    const gh = fakeGitHub();
    gh.set({ tasks: [{ id: "t-a", title: "A" }] });
    const storage = memStorage();
    const settings = saveGitHubSettings({ apiBase: "https://api.test", repo: "richard-0417/lab-hub", token: "tok", clientName: "R" }, storage);
    const src = new GitHubSource(loadGitHubSettings(storage), { fetchImpl: gh.fetch, storage, pollMs: 1e9, pushDelayMs: 1e9, timeoutMs: 2000 });
    const seen = [];
    const unsubscribe = src.subscribe((d) => seen.push(d));
    await src.syncNow();
    await src.submit([B.opAdd("tasks", { id: "t-x", title: "unsynced" }, "R", TS)]);
    await src.syncNow(); // the PUT fails: one op stays pending (persisted)
    assert.equal(src.sync.pending, 1);
    assert.ok(storage.getItem(githubCacheKey(settings)));

    // A poll is in flight (slow network) when the user confirms "Forget token";
    // it will come back with a changed remote file.
    let release;
    gh.gate = new Promise((r) => (release = r));
    const cycle = src.syncNow().catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    let reloaded = 0;
    forgetGitHub({ source: src, unsubscribe, clear: () => clearGitHubSettings(storage), reload: () => reloaded++ });
    assert.equal(reloaded, 1);
    assert.deepEqual([...storage.map.keys()], []);
    gh.set({ tasks: [{ id: "t-a", title: "A2" }] });
    const before = seen.length;
    release();
    await cycle;
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([...storage.map.keys()], [], "nothing may be written back after forget");
    assert.equal(seen.length, before, "no emissions after unsubscribe");
  });

  test("order: unsubscribe, stop, clear, reload", () => {
    const calls = [];
    forgetGitHub({
      source: { stop: () => calls.push("stop") },
      unsubscribe: () => calls.push("unsubscribe"),
      clear: () => calls.push("clear"),
      reload: () => calls.push("reload"),
    });
    assert.deepEqual(calls, ["unsubscribe", "stop", "clear", "reload"]);
    assert.doesNotThrow(() => forgetGitHub({ clear: () => {}, reload: () => {} })); // no source yet
  });
});

// --------------------------------------------------------------- card keys
describe("task card keyboard", () => {
  const key = (k, mods = {}) => Object.assign({ key: k, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }, mods);

  test("Backspace is not a delete shortcut", () => {
    assert.equal(cardKeyAction(key("Backspace")), null);
    assert.equal(cardKeyAction(key("Backspace"), 5000), null);
    assert.equal(cardKeyAction(key("Delete")), "delete");
  });

  test("keys right after a dialog closes are swallowed (focus returned to the card)", () => {
    for (const k of ["Enter", " ", "Delete"]) assert.equal(cardKeyAction(key(k), 50), "swallow", k);
    assert.equal(cardKeyAction(key(" "), DIALOG_KEY_GUARD_MS + 1), "toggle");
    assert.equal(cardKeyAction(key("Enter"), DIALOG_KEY_GUARD_MS + 1), "open");
    assert.equal(cardKeyAction(key("ArrowDown"), 50), "focus-down"); // harmless keys still work
  });

  test("the rest of the map", () => {
    assert.equal(cardKeyAction(key("ArrowUp", { altKey: true })), "move-up");
    assert.equal(cardKeyAction(key("ArrowRight", { altKey: true })), "move-right");
    assert.equal(cardKeyAction(key("ArrowLeft")), "focus-left");
    assert.equal(cardKeyAction(key("Delete", { ctrlKey: true })), null);
    assert.equal(cardKeyAction(key("a")), null);
  });

  test("Delete needs a second press on the same card within the window", () => {
    let t = 0;
    const arm = keyArm(3000, () => t);
    assert.equal(arm.press("t-1"), false);
    t = 1000;
    assert.equal(arm.press("t-1"), true);
    assert.equal(arm.press("t-1"), false); // re-armed after confirming
    t = 5000;
    assert.equal(arm.press("t-1"), false); // expired: arms again
    assert.equal(arm.press("t-2"), false); // another card arms instead
    assert.equal(arm.press("t-2"), true);
    arm.press("t-3");
    arm.reset();
    assert.equal(arm.press("t-3"), false);
  });
});

// ------------------------------------------------------------- done_at rules
describe("leaving Done always clears done_at", () => {
  test("moveTo set", () => {
    assert.deepEqual(leaveStatusSet("doing"), { status: "doing", done_at: "" });
    assert.deepEqual(leaveStatusSet("todo"), { status: "todo", done_at: "" });
  });

  test("editor: task completed elsewhere while open, then saved as In progress", () => {
    const snap = B.normalizeItem("tasks", { id: "t-confocal", title: "Confocal", status: "todo", rank: 3, created_at: TS, updated_at: TS });
    const edits = { title: "Confocal", notes: "", status: "doing", priority: "normal", assignee: "", due: "", tags: [] };
    const { set } = taskUpdateSet(snap, edits, { now: () => TS, topRank: () => -1 });
    assert.deepEqual(set, { status: "doing", done_at: "", rank: -1 });
    // Applied on the board where another client already completed it:
    let board = B.normalizeBoard({ tasks: [Object.assign({}, snap, { status: "done", done_at: "2026-10-16T12:00:00Z" })] });
    board = B.applyOp(board, B.opUpdate("tasks", snap.id, set, "x", TS));
    assert.equal(board.tasks[0].status, "doing");
    assert.equal(board.tasks[0].done_at, "");
  });

  test("editor: into Done stamps done_at; unchanged status leaves it alone", () => {
    const snap = B.normalizeItem("tasks", { id: "t-1", title: "A", status: "doing", created_at: TS, updated_at: TS });
    const base = { title: "A", notes: "", priority: "normal", assignee: "", due: "", tags: [] };
    assert.deepEqual(taskUpdateSet(snap, Object.assign({ status: "done" }, base), { now: () => TS }).set, { status: "done", done_at: TS });
    assert.deepEqual(taskUpdateSet(snap, Object.assign({ status: "doing" }, base, { title: "B" })).set, { title: "B" });
  });
});

// ----------------------------------------------------------- drop position
describe("resolveDropIndex (drag over a stale DOM)", () => {
  const t = (id, rank) => ({ id, rank });

  test("a task added to the column mid-drag doesn't shift the drop", () => {
    // DOM at drag start: [videos, methods, drive]; placeholder between videos and methods (index 1).
    const fresh = [t("t-remote1", -5), t("t-videos", 1), t("t-methods", 2), t("t-drive", 3)];
    const at = resolveDropIndex(fresh, 1, { prevId: "t-videos", nextId: "t-methods" });
    assert.equal(at, 2);
    const [op] = B.planMove({ list: fresh, id: "t-binder", toIndex: at, set: { status: "doing" }, ts: TS });
    assert.ok(op.set.rank > 1 && op.set.rank < 2, `rank ${op.set.rank} sorts between videos and methods`);
    // The old behaviour (raw index on the fresh list) lands above t-videos:
    const [old] = B.planMove({ list: fresh, id: "t-binder", toIndex: 1, ts: TS });
    assert.ok(old.set.rank < 1);
  });

  test("falls back to the next neighbour, then to the clamped index", () => {
    const list = [t("a", 1), t("b", 2), t("c", 3)];
    assert.equal(resolveDropIndex(list, 0, { prevId: "gone", nextId: "c" }), 2);
    assert.equal(resolveDropIndex(list, 1, { prevId: "gone", nextId: "gone2" }), 1);
    assert.equal(resolveDropIndex(list, 9, {}), 3);
    assert.equal(resolveDropIndex(list, -2), 0);
    assert.equal(resolveDropIndex(list, 0, { prevId: "c" }), 3); // dropped at the bottom
    assert.equal(resolveDropIndex([], 4, { prevId: "x" }), 0);
  });
});

// ------------------------------------------------------------------ calendar
describe("calendarEntries", () => {
  const now = new Date(2026, 9, 16, 10, 0, 0);
  const iso = (h, m = 0, d = 16) => `2026-10-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;

  test("a timed event without an end is never 'Now' and drops once started", () => {
    const out = calendarEntries([{ summary: "No end event", start: iso(9, 30), end: null, all_day: false }], now);
    assert.deepEqual(out, []);
    const later = calendarEntries([{ summary: "Later", start: iso(11), end: null, all_day: false }], now);
    assert.equal(later.length, 1);
    assert.equal(later[0].isNow, false);
  });

  test("timed events with an end; all-day without an end lasts the day", () => {
    const out = calendarEntries(
      [
        { summary: "Meeting", start: iso(9, 45), end: iso(10, 30), all_day: false },
        { summary: "Done", start: iso(9), end: iso(9, 15), all_day: false },
        { summary: "Cleanup", start: "2026-10-16T00:00:00", end: null, all_day: true },
      ],
      now,
    );
    assert.deepEqual(out.map((x) => [x.e.summary, x.isNow]), [["Meeting", true], ["Cleanup", false]]);
  });

  test("junk is ignored", () => {
    assert.deepEqual(calendarEntries(null, now), []);
    assert.deepEqual(calendarEntries([null, 3, { start: "nope" }], now), []);
  });
});

// ------------------------------------------------- form controls (real DOM bug)
describe("rail add forms", () => {
  const RESERVED = new Set(["item", "namedItem", "length"]);

  test("every rail form control in index.html is looked up with formControl()", () => {
    const html = readFileSync(`${ROOT}static/index.html`, "utf8");
    const names = [...html.matchAll(/<(?:input|textarea|select)\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(names.includes("item"), "the request form's item field (shadowed by HTMLFormControlsCollection.item)");
    const ui = ["requests.js", "notes.js"].map((f) => readFileSync(`${ROOT}static/js/ui/${f}`, "utf8")).join("\n");
    for (const n of new Set(names)) assert.match(ui, new RegExp(`formControl\\(form, "${n}"\\)`), `control "${n}"`);
  });

  test("UI code never reads form controls as form.elements.<name>", () => {
    const dir = `${ROOT}static/js/`;
    const files = ["app.js", ...readdirSync(`${dir}ui`).map((f) => `ui/${f}`)];
    for (const f of files) {
      const code = readFileSync(dir + f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      assert.doesNotMatch(code, /\.elements\.(?!namedItem\b)[A-Za-z_$]/, `${f} uses form.elements.<name>`);
    }
  });

  function requestDom(el) {
    const form = el(
      "form#req-form",
      {},
      el("input", { name: "item", type: "text" }),
      el("button", { type: "submit" }),
      el("input", { name: "qty", type: "text" }),
      el("input", { name: "by", type: "text" }),
    );
    document.body.appendChild(el("div", {}, el("div#req-body"), el("span#req-count"), el("button#clear-received"), form));
    return form;
  }

  function stubCtx({ kiosk = false, stored = "" } = {}) {
    const ops = [];
    const remembered = [];
    const ctx = {
      kiosk,
      canEdit: true,
      loaded: true,
      board: B.emptyBoard(),
      source: { submit: async (list) => ops.push(...list) },
      name: () => personName({ kiosk, stored }),
      by: () => ctx.name() || undefined,
      rememberName: (n) => {
        if (!kiosk && n) remembered.push(n);
      },
    };
    return { ctx, ops, remembered };
  }

  test("submitting a request adds it (form.elements.item is HTMLCollection.item())", async () => {
    const dom = installDom();
    try {
      const form = requestDom(dom.el);
      assert.equal(typeof form.elements.item, "function", "the fake models the browser's shadowing");
      const { ctx, ops, remembered } = stubCtx();
      const req = initRequests(ctx);
      req.render();
      const [item, qty, by] = ["item", "qty", "by"].map((n) => form.elements.namedItem(n));
      item.value = "Pipette tips 10uL";
      qty.value = "2 boxes";
      by.value = "Priya";
      form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }));
      await tick();
      assert.equal(ops.length, 1);
      assert.equal(ops[0].op, "add");
      assert.deepEqual([ops[0].item.item, ops[0].item.qty, ops[0].item.requested_by], ["Pipette tips 10uL", "2 boxes", "Priya"]);
      assert.deepEqual(remembered, ["Priya"]);
      assert.equal(item.value, "");
      assert.equal(by.value, "Priya", "a personal browser keeps the name for the next request");
      // Focus leaving the emptied form collapses it without throwing.
      form.classList.add("open");
      item.focus();
      item.blur();
      await new Promise((r) => setTimeout(r, 180));
      assert.equal(form.classList.contains("open"), false);
    } finally {
      dom.restore();
    }
  });

  test("an emptied name field is anonymous, not the remembered name", async () => {
    const dom = installDom();
    try {
      const form = requestDom(dom.el);
      const { ctx, ops } = stubCtx({ stored: "Priya" });
      const req = initRequests(ctx);
      req.setDefaults();
      assert.equal(form.elements.namedItem("by").value, "Priya");
      form.elements.namedItem("by").value = "";
      form.elements.namedItem("item").value = "Kimwipes";
      form.requestSubmit();
      await tick();
      assert.equal(ops[0].item.requested_by, "");
    } finally {
      dom.restore();
    }
  });

  test("on the kiosk the name is neither prefilled, remembered nor kept for the next person", async () => {
    const dom = installDom();
    try {
      const form = requestDom(dom.el);
      const { ctx, ops, remembered } = stubCtx({ kiosk: true, stored: "Priya" });
      const req = initRequests(ctx);
      req.setDefaults();
      const by = form.elements.namedItem("by");
      assert.equal(by.value, "");
      by.value = "Jordan";
      form.elements.namedItem("item").value = "Glycerol";
      form.requestSubmit();
      await tick();
      assert.equal(ops[0].item.requested_by, "Jordan");
      assert.equal(ops[0].by, undefined, "the source fills in the kiosk's client name");
      assert.deepEqual(remembered, []);
      assert.equal(by.value, "");
    } finally {
      dom.restore();
    }
  });

  test("notes form: same name rules", async () => {
    const dom = installDom();
    try {
      const { el } = dom;
      const form = el("form#note-form", {}, el("textarea", { name: "body" }), el("div#note-colors"), el("input", { name: "by", type: "text" }));
      document.body.appendChild(el("div", {}, el("div#notes-body"), el("span#notes-count"), form));
      const { ctx, ops } = stubCtx({ kiosk: true, stored: "Priya" });
      const notes = initNotes(ctx);
      notes.setDefaults();
      assert.equal(form.elements.namedItem("by").value, "");
      form.elements.namedItem("body").value = "Fridge is defrosting";
      form.requestSubmit();
      await tick();
      assert.equal(ops.length, 1);
      assert.equal(ops[0].item.author, "");
    } finally {
      dom.restore();
    }
  });
});

// ------------------------------------------------------------ sync popover
describe("sync popover", () => {
  function headerDom(el) {
    const ids = ["clock-hm", "clock-s", "clock-ap", "greeting", "date", "sync-ico", "sync-text", "lab-name", "lab-sub"];
    document.body.appendChild(el("div", {}, ...ids.map((id) => el(`span#${id}`))));
    document.body.appendChild(el("button#sync-pill"));
    const pop = el("div#sync-pop");
    pop.hidden = true;
    document.body.appendChild(pop);
    document.body.appendChild(el("button#theme-btn"));
    document.body.appendChild(el("button#settings-btn"));
  }

  async function withHeader(ctx, handlers, fn) {
    const dom = installDom();
    const realSetInterval = globalThis.setInterval;
    try {
      headerDom(dom.el);
      globalThis.setInterval = () => 0; // the clock tick
      const header = initHeader(ctx, Object.assign({ onSyncNow: async () => {}, onSettings() {}, onForget() {}, onTheme() {} }, handlers));
      globalThis.setInterval = realSetInterval;
      return await fn(header);
    } finally {
      globalThis.setInterval = realSetInterval;
      dom.restore();
    }
  }

  const sync = (over = {}) => Object.assign({ state: "ok", pending: 0, last_sync: new Date().toISOString(), last_push: null, last_error: null, repo: "o/r", branch: "data", path: "board.json" }, over);

  test("refreshes keep the focused button (no rebuild every 10 s)", () =>
    withHeader({ mode: "github", canEdit: true, settings: { token: "t" }, sync: sync() }, {}, (header) => {
      document.getElementById("sync-pill").click();
      const pop = document.getElementById("sync-pop");
      const btn = pop.querySelector('[data-act="forget"]');
      assert.ok(btn);
      btn.focus();
      header.refresh();
      header.render();
      assert.equal(btn.isConnected, true);
      assert.equal(document.activeElement, btn);
    }));

  test("Sync now keeps focus on itself while busy and after; text updates in place", async () => {
    let finish;
    const calls = [];
    const ctx = { mode: "local", canEdit: true, config: { github: {} }, sync: sync() };
    await withHeader(ctx, { onSyncNow: () => new Promise((r) => { calls.push(1); finish = r; }) }, async (header) => {
      document.getElementById("sync-pill").click();
      const pop = document.getElementById("sync-pop");
      const btn = pop.querySelector('[data-act="sync"]');
      btn.focus();
      btn.click();
      assert.equal(calls.length, 1);
      assert.equal(document.activeElement, btn);
      assert.equal(btn.getAttribute("aria-disabled"), "true");
      assert.equal(btn.disabled, false, "not disabled: that would drop focus");
      btn.click(); // ignored while busy
      assert.equal(calls.length, 1);
      assert.equal(pop.querySelector(".pop-error").hidden, true);
      ctx.sync = sync({ state: "error", last_error: "GitHub token rejected" });
      header.render();
      assert.equal(pop.querySelector(".pop-error").hidden, false);
      assert.match(pop.querySelector(".pop-error").textContent, /token rejected/);
      assert.match(pop.querySelector(".pop-title").textContent, /Sync problem/);
      finish();
      await tick();
      assert.equal(btn.isConnected, true);
      assert.equal(btn.hasAttribute("aria-disabled"), false);
      assert.equal(document.activeElement, btn);
    });
  });

  test("a changed button set rebuilds and puts focus back on the same action", () => {
    const ctx = { mode: "github", canEdit: true, settings: { token: "t" }, sync: sync() };
    return withHeader(ctx, {}, (header) => {
      document.getElementById("sync-pill").click();
      const pop = document.getElementById("sync-pop");
      const old = pop.querySelector('[data-act="settings"]');
      old.focus();
      ctx.settings = { token: "" }; // switched to read-only: Forget token goes away
      header.render();
      assert.equal(pop.querySelector('[data-act="forget"]'), null);
      const now = pop.querySelector('[data-act="settings"]');
      assert.notEqual(now, old);
      assert.equal(document.activeElement, now);
    });
  });
});

// --------------------------------------------------------------- setup dialog
describe("GitHub settings dialog", () => {
  test("readOnlyConfirm wording", () => {
    assert.match(readOnlyConfirm(0).warn, /token will be removed/);
    assert.match(readOnlyConfirm(1).warn, /^1 unsynced change from/);
    assert.match(readOnlyConfirm(3).warn, /^3 unsynced changes/);
    assert.match(readOnlyConfirm(3).label, /Remove token/);
  });

  function setupWith(opts) {
    const dom = installDom();
    const calls = [];
    const dlg = openSetup(
      Object.assign(
        {
          initial: { apiBase: "https://api.github.com", repo: "richard-0417/lab-hub", branch: "data", path: "board.json", token: "github_pat_x", clientName: "R" },
          onConnect: (s) => calls.push(["connect", s]),
          onReadOnly: (s) => calls.push(["readonly", s]),
          onForget: () => calls.push(["forget"]),
        },
        opts,
      ),
    );
    return { dom, calls, dlg };
  }

  test("existing setup with a token: View read-only takes a second click", () => {
    const { dom, calls, dlg } = setupWith({ existing: true, hasToken: true, pending: 2 });
    try {
      const ro = dlg.dialog.querySelector('[data-act="readonly"]');
      ro.click();
      assert.deepEqual(calls, []);
      assert.match(ro.textContent, /Remove token\?/);
      assert.match(dlg.dialog.querySelector(".setup-status").textContent, /2 unsynced changes/);
      ro.click();
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], "readonly");
      assert.equal(calls[0][1].token, "");
      assert.equal(dlg.dialog.isConnected, false);
    } finally {
      dom.restore();
    }
  });

  test("first run: View read-only is one click (no token to lose); Cancel exists only for an existing setup", () => {
    const first = setupWith({ existing: false, hasToken: false });
    try {
      assert.equal(first.dlg.dialog.querySelector('[data-act="cancel"]'), null);
      first.dlg.dialog.querySelector('[data-act="readonly"]').click();
      assert.equal(first.calls.length, 1);
    } finally {
      first.dom.restore();
    }
    const existing = setupWith({ existing: true, hasToken: true });
    try {
      existing.dlg.dialog.querySelector('[data-act="cancel"]').click();
      assert.deepEqual(existing.calls, []);
      assert.equal(existing.dlg.dialog.isConnected, false);
    } finally {
      existing.dom.restore();
    }
  });
});
