// LocalSource against a fake Pi API (GET api/board?rev, POST api/ops, POST api/sync).
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import * as B from "../../static/js/board.js";
import { LocalSource } from "../../static/js/sources.js";

const TS = "2026-10-16T14:00:00Z";
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const addTask = (id, title, extra = {}) => ({ op: "add", coll: "tasks", item: Object.assign({ id, title }, extra), ts: TS });
const titles = (board) => board.tasks.map((t) => t.title);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class FakePi {
  constructor(doc = {}) {
    this.board = B.normalizeBoard(doc);
    this.rev = 1;
    this.down = false;
    this.log = [];
    this.gate = null; // a promise POST api/ops waits on (to observe optimistic state)
    this.rejectIf = null; // op => error string (server-side validation the client doesn't know)
    this.syncCalls = 0;
    this.sync = {
      enabled: true, state: "ok", pending: 0, last_sync: TS, last_push: TS, last_error: null,
      repo: "richard-0417/lab-hub", branch: "data", path: "board.json",
    };
    this.fetch = this.fetch.bind(this);
  }

  async fetch(url, init = {}) {
    const method = init.method || "GET";
    this.log.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined });
    if (this.down) throw new TypeError("fetch failed");
    const u = new URL(url, "http://pi.local/");
    if (u.pathname === "/api/board" && method === "GET") {
      const rev = u.searchParams.get("rev");
      if (rev !== null && Number(rev) === this.rev) return json(200, { rev: this.rev, unchanged: true, sync: this.sync });
      return json(200, { rev: this.rev, board: this.board, sync: this.sync });
    }
    if (u.pathname === "/api/ops" && method === "POST") {
      if (this.gate) await this.gate;
      if (this.down) throw new TypeError("fetch failed");
      const { ops } = JSON.parse(init.body);
      for (let i = 0; i < ops.length; i++) {
        const err = B.validateOp(ops[i]) || (this.rejectIf && this.rejectIf(ops[i]));
        if (err) return json(400, { error: err, index: i });
      }
      this.board = B.applyOps(this.board, ops);
      this.rev++;
      return json(200, { rev: this.rev, board: this.board, sync: this.sync });
    }
    if (u.pathname === "/api/sync" && method === "POST") {
      this.syncCalls++;
      this.sync = Object.assign({}, this.sync, { last_sync: "2026-10-16T15:00:00Z" });
      return json(200, this.sync);
    }
    return json(404, { detail: "Not Found" });
  }

  externalEdit(ops) {
    this.board = B.applyOps(this.board, ops);
    this.rev++;
  }
}

function makeSource(pi, opts = {}) {
  return new LocalSource(Object.assign({ fetchImpl: pi.fetch, pollMs: 1e9, clientName: "lab-pi" }, opts));
}

describe("LocalSource", () => {
  test("start loads the board; subscribers get {board, sync}", async () => {
    const pi = new FakePi({ tasks: [{ id: "t-a", title: "A" }] });
    const src = makeSource(pi);
    const seen = [];
    src.subscribe((p) => seen.push(p));
    try {
      await src.start();
      assert.equal(src.mode, "local");
      assert.equal(src.canEdit, true);
      assert.deepEqual(titles(seen.at(-1).board), ["A"]);
      const s = seen.at(-1).sync;
      assert.equal(s.mode, "local");
      assert.equal(s.canEdit, true);
      assert.equal(s.link, "up");
      assert.equal(s.state, "ok");
      assert.equal(s.repo, "richard-0417/lab-hub");
      assert.equal(s.loaded, true);
      assert.equal(pi.log[0].url, "api/board", "relative URL, no rev on first load");
    } finally {
      src.stop();
    }
  });

  test("polls with ?rev= and stays quiet when unchanged; picks up external edits", async () => {
    const pi = new FakePi({ tasks: [{ id: "t-a", title: "A" }] });
    const src = makeSource(pi, { pollMs: 20 });
    let calls = 0;
    src.subscribe(() => calls++);
    try {
      await src.start();
      const after = calls;
      await sleep(80);
      assert.ok(pi.log.filter((r) => r.url === "api/board?rev=1").length >= 2);
      assert.equal(calls, after, "no emits while unchanged");
      pi.externalEdit([addTask("t-b", "B", { rank: 1 })]);
      await sleep(60);
      assert.deepEqual(titles(src.board), ["A", "B"]);
    } finally {
      src.stop();
    }
    const n = pi.log.length;
    await sleep(50);
    assert.equal(pi.log.length, n, "stop() ends polling");
  });

  test("optimistic apply: subscribers see the op before the server answers", async () => {
    const pi = new FakePi({ tasks: [{ id: "t-a", title: "A" }] });
    const src = makeSource(pi);
    let release;
    pi.gate = new Promise((r) => (release = r));
    const seen = [];
    src.subscribe((p) => seen.push(p));
    try {
      await src.start();
      const p = src.submit(addTask("t-b", "B", { rank: 1 }));
      assert.deepEqual(titles(seen.at(-1).board), ["A", "B"], "emitted synchronously");
      assert.equal(seen.at(-1).sync.pending, 1);
      release();
      await p;
      assert.deepEqual(titles(pi.board), ["A", "B"]);
      assert.deepEqual(titles(src.board), ["A", "B"]);
      assert.equal(src.sync.pending, 0);
      const post = pi.log.find((r) => r.method === "POST" && r.url === "api/ops");
      assert.equal(post.body.ops[0].by, "lab-pi", "clientName fills a missing by");
    } finally {
      src.stop();
    }
  });

  test("client-side validation throws before anything is sent", async () => {
    const pi = new FakePi();
    const src = makeSource(pi);
    try {
      await src.start();
      await assert.rejects(src.submit({ op: "add", coll: "tasks", item: { id: "t-1", title: "  " }, ts: TS }), /title/);
      assert.equal(pi.log.filter((r) => r.method === "POST").length, 0);
    } finally {
      src.stop();
    }
  });

  test("400 from the Pi: board reloaded (rollback) and submit rejects with the server's error", async () => {
    const pi = new FakePi({ tasks: [{ id: "t-a", title: "A" }] });
    pi.rejectIf = (op) => (op.op === "add" && op.item.title === "Forbidden" ? "title not allowed here" : null);
    const src = makeSource(pi);
    const seen = [];
    src.subscribe(({ board }) => seen.push(titles(board).join(",")));
    try {
      await src.start();
      await assert.rejects(src.submit(addTask("t-x", "Forbidden", { rank: 1 })), { message: "title not allowed here" });
      assert.deepEqual(titles(src.board), ["A"]);
      assert.ok(seen.includes("A,Forbidden"), "was shown optimistically");
      assert.equal(seen.at(-1), "A", "then rolled back");
      assert.equal(src.sync.pending, 0);
      // other ops in the same batch still go through
      await assert.rejects(src.submit([addTask("t-y", "Fine", { rank: 2 }), addTask("t-z", "Forbidden", { rank: 3 })]), /not allowed/);
      assert.deepEqual(titles(pi.board), ["A", "Fine"]);
      assert.deepEqual(titles(src.board), ["A", "Fine"]);
    } finally {
      src.stop();
    }
  });

  test("network failure: ops stay in an ordered outbox, state offline, flushed on the next poll", async () => {
    const pi = new FakePi({ tasks: [{ id: "t-a", title: "A" }] });
    const src = makeSource(pi, { pollMs: 25 });
    try {
      await src.start();
      pi.down = true;
      await src.submit(addTask("t-b", "B", { rank: 1 }));
      await src.submit({ op: "update", coll: "tasks", id: "t-b", set: { title: "B2", status: "doing" }, ts: TS });
      let s = src.sync;
      assert.equal(s.state, "offline");
      assert.equal(s.link, "down");
      assert.equal(s.last_error, "Can't reach the dashboard server");
      assert.equal(s.pending, 2);
      assert.deepEqual(titles(src.board), ["A", "B2"]);
      await sleep(60); // polls while down keep the outbox
      assert.equal(src.sync.pending, 2);
      pi.down = false;
      await sleep(80);
      s = src.sync;
      assert.equal(s.state, "ok");
      assert.equal(s.link, "up");
      assert.equal(s.pending, 0);
      assert.deepEqual(titles(pi.board), ["A", "B2"]);
      assert.equal(pi.board.tasks[1].status, "doing");
      const posts = pi.log.filter((r) => r.method === "POST" && r.url === "api/ops" && r.body.ops.length === 2);
      assert.ok(posts.length >= 1, "outbox flushed as one ordered batch");
      assert.deepEqual(posts.at(-1).body.ops.map((o) => o.op), ["add", "update"]);
    } finally {
      src.stop();
    }
  });

  test("first load offline -> empty board, offline state, recovers", async () => {
    const pi = new FakePi({ tasks: [{ id: "t-a", title: "A" }] });
    pi.down = true;
    const src = makeSource(pi, { pollMs: 20 });
    const seen = [];
    src.subscribe((p) => seen.push(p));
    try {
      await src.start();
      assert.equal(seen.at(-1).sync.state, "offline");
      assert.equal(seen.at(-1).sync.loaded, false);
      assert.deepEqual(seen.at(-1).board.tasks, []);
      pi.down = false;
      await sleep(60);
      assert.deepEqual(titles(src.board), ["A"]);
      assert.equal(src.sync.loaded, true);
    } finally {
      src.stop();
    }
  });

  test("HTTP 500 -> error state with message", async () => {
    const pi = new FakePi();
    const src = new LocalSource({ fetchImpl: async () => json(500, { detail: "boom" }), pollMs: 1e9 });
    try {
      await src.start();
      assert.equal(src.sync.state, "error");
      assert.match(src.sync.last_error, /HTTP 500/);
    } finally {
      src.stop();
    }
    assert.ok(pi);
  });

  test("syncNow posts api/sync then reloads the board", async () => {
    const pi = new FakePi({ tasks: [{ id: "t-a", title: "A" }] });
    const src = makeSource(pi);
    try {
      await src.start();
      pi.externalEdit([addTask("t-b", "B", { rank: 1 })]);
      const sync = await src.syncNow();
      assert.equal(pi.syncCalls, 1);
      assert.equal(sync.last_sync, "2026-10-16T15:00:00Z");
      assert.deepEqual(titles(src.board), ["A", "B"]);
    } finally {
      src.stop();
    }
  });

  test("unsubscribe stops notifications", async () => {
    const pi = new FakePi();
    const src = makeSource(pi);
    let n = 0;
    const off = src.subscribe(() => n++);
    try {
      await src.start();
      const before = n;
      off();
      await src.submit(addTask("t-a", "A"));
      assert.equal(n, before);
    } finally {
      src.stop();
    }
  });

  test("a reply whose body stalls after the headers times out: offline, ops kept, the queue keeps moving", async () => {
    const pi = new FakePi({ tasks: [{ id: "t-a", title: "A" }] });
    const realFetch = pi.fetch;
    let stall = false;
    const fetchImpl = async (url, init) => {
      if (stall && (init.method || "GET") === "POST") {
        await realFetch(url, init); // the Pi applies it, but the reply body never arrives
        return new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realFetch(url, init);
    };
    const src = makeSource(pi, { fetchImpl, timeoutMs: 60 });
    try {
      await src.start();
      stall = true;
      const r = await Promise.race([src.submit(addTask("t-b", "B", { rank: 1 })).then(() => "settled"), sleep(2000).then(() => "hung")]);
      assert.equal(r, "settled");
      assert.equal(src.sync.state, "offline");
      assert.equal(src.sync.pending, 1);
      stall = false;
      const sync = await src.syncNow();
      assert.equal(sync.pending, 0);
      assert.deepEqual(titles(src.board), ["A", "B"]);
      assert.deepEqual(titles(pi.board), ["A", "B"], "the re-sent add is a no-op on the Pi");
    } finally {
      src.stop();
    }
  });
});
