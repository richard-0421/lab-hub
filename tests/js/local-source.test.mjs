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
    this.answer = null; // ops => Response | null: override POST api/ops (e.g. 413 / 415 / 403 / 503)
    this.syncCalls = 0;
    this.sync = {
      enabled: true, state: "ok", pending: 0, last_sync: TS, last_push: TS, last_error: null,
      repo: "richard-0421/lab-hub", branch: "data", path: "board.json",
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
      const forced = this.answer && this.answer(ops, init);
      if (forced) return forced;
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
      assert.equal(s.repo, "richard-0421/lab-hub");
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

describe("LocalSource: unsent / flush()", () => {
  test("unsent counts only this page's outbox (not the Pi's GitHub queue)", async () => {
    const pi = new FakePi({ tasks: [{ id: "t-a", title: "A" }] });
    pi.sync = Object.assign({}, pi.sync, { pending: 4, state: "pending" });
    const src = makeSource(pi);
    try {
      await src.start();
      assert.equal(src.unsent, 0);
      assert.equal(src.sync.pending, 4);
      pi.down = true;
      await src.submit(addTask("t-b", "B", { rank: 1 }));
      await src.submit(addTask("t-c", "C", { rank: 2 }));
      assert.equal(src.unsent, 2);
      assert.equal(src.sync.pending, 6, "sync.pending = the Pi's queue + this page's outbox");
    } finally {
      src.stop();
    }
  });

  test("flush() pushes the outbox without api/sync and never rejects", async () => {
    const pi = new FakePi({ tasks: [{ id: "t-a", title: "A" }] });
    const src = makeSource(pi);
    try {
      await src.start();
      pi.down = true;
      await src.submit(addTask("t-b", "B", { rank: 1 }));
      assert.equal(src.unsent, 1);
      const offline = await src.flush(); // still down: resolves, keeps the op
      assert.equal(offline.state, "offline");
      assert.equal(src.unsent, 1);
      pi.down = false;
      const sync = await src.flush();
      assert.equal(src.unsent, 0);
      assert.equal(sync.pending, 0);
      assert.deepEqual(titles(pi.board), ["A", "B"]);
      assert.equal(pi.syncCalls, 0, "flush() never asks the Pi to sync with GitHub");
      assert.equal(pi.log.filter((r) => r.url === "api/sync").length, 0);
      const posts = pi.log.filter((r) => r.method === "POST").length;
      await src.flush(); // empty outbox: nothing to send
      assert.equal(pi.log.filter((r) => r.method === "POST").length, posts);
    } finally {
      src.stop();
    }
  });

  test("flush() with an op the Pi refuses: dropped, board rolled back, still resolves", async () => {
    const pi = new FakePi({ tasks: [{ id: "t-a", title: "A" }] });
    pi.rejectIf = (op) => (op.op === "add" && op.item.title === "Bad" ? "nope" : null);
    const src = makeSource(pi);
    const warn = console.warn;
    console.warn = () => {};
    try {
      await src.start();
      pi.down = true;
      await src.submit(addTask("t-x", "Bad", { rank: 1 }));
      pi.down = false;
      await src.flush();
      assert.equal(src.unsent, 0);
      assert.deepEqual(titles(src.board), ["A"]);
    } finally {
      console.warn = warn;
      src.stop();
    }
  });
});

describe("LocalSource: POST api/ops answers", () => {
  for (const [status, error] of [
    [413, "request body too large (limit 2 MB)"],
    [415, "Content-Type must be application/json"],
    [403, "cross-site request refused"],
  ]) {
    test(`${status} is permanent like 400: batch dropped, board reloaded, submit rejects with the server's text`, async () => {
      const pi = new FakePi({ tasks: [{ id: "t-a", title: "A" }] });
      pi.answer = () => json(status, { error, index: null });
      const src = makeSource(pi, { pollMs: 20 });
      const seen = [];
      src.subscribe(({ board }) => seen.push(titles(board).join(",")));
      try {
        await src.start();
        await assert.rejects(src.submit([addTask("t-b", "B", { rank: 1 }), addTask("t-c", "C", { rank: 2 })]), { message: error });
        assert.ok(seen.includes("A,B,C"), "was shown optimistically");
        assert.deepEqual(titles(src.board), ["A"], "rolled back to the Pi's board");
        assert.equal(src.unsent, 0);
        assert.equal(src.sync.pending, 0);
        assert.notEqual(src.sync.state, "error", "the server answered; nothing is stuck");
        const posts = pi.log.filter((r) => r.method === "POST" && r.url === "api/ops").length;
        assert.equal(posts, 1);
        await sleep(80); // polls don't send the dropped ops again
        assert.equal(pi.log.filter((r) => r.method === "POST" && r.url === "api/ops").length, posts);
        assert.ok(pi.log.filter((r) => r.method === "GET" && r.url === "api/board").length >= 2, "board reloaded after the refusal");
        // the next edit goes through once the Pi accepts again
        pi.answer = null;
        await src.submit(addTask("t-d", "D", { rank: 3 }));
        assert.deepEqual(titles(pi.board), ["A", "D"]);
      } finally {
        src.stop();
      }
    });
  }

  test("a permanent refusal without an error body still rejects with a readable message", async () => {
    const pi = new FakePi();
    pi.answer = () => new Response("Payload Too Large", { status: 413 });
    const src = makeSource(pi);
    try {
      await src.start();
      await assert.rejects(src.submit(addTask("t-b", "B")), /too large.*413/);
      assert.equal(src.unsent, 0);
    } finally {
      src.stop();
    }
  });

  test("503 keeps the ops and retries (error state shows the Pi's message), then they go through", async () => {
    const pi = new FakePi({ tasks: [{ id: "t-a", title: "A" }] });
    pi.answer = () => json(503, { error: "the change couldn't be saved on the Pi", index: null });
    const src = makeSource(pi, { pollMs: 20 });
    try {
      await src.start();
      await src.submit(addTask("t-b", "B", { rank: 1 })); // resolves: queued, not refused
      assert.equal(src.unsent, 1);
      assert.equal(src.sync.state, "error");
      assert.match(src.sync.last_error, /couldn't be saved on the Pi \(HTTP 503\)/);
      assert.deepEqual(titles(src.board), ["A", "B"], "still shown");
      await sleep(70);
      assert.ok(pi.log.filter((r) => r.method === "POST" && r.url === "api/ops").length >= 2, "retried on the next polls");
      assert.equal(src.unsent, 1);
      pi.answer = null;
      await sleep(70);
      assert.equal(src.unsent, 0);
      assert.equal(src.sync.state, "ok");
      assert.deepEqual(titles(pi.board), ["A", "B"]);
    } finally {
      src.stop();
    }
  });

  test("a long outbox is sent in several POSTs that stay under the Pi's 2 MB body limit", async () => {
    const pi = new FakePi();
    const sizes = [];
    pi.answer = (ops, init) => {
      sizes.push(Buffer.byteLength(init.body));
      return Buffer.byteLength(init.body) > 2 * 1024 * 1024 ? json(413, { error: "too large", index: null }) : null;
    };
    const src = makeSource(pi);
    try {
      await src.start();
      pi.down = true;
      const big = "é".repeat(3990); // ~8 KB of UTF-8 per op
      const ops = Array.from({ length: 400 }, (_, i) => addTask(`t-${String(i).padStart(4, "0")}`, `T${i}`, { notes: big, rank: i }));
      await src.submit(ops);
      assert.equal(src.unsent, 400);
      pi.down = false;
      await src.flush();
      assert.equal(src.unsent, 0);
      assert.equal(pi.board.tasks.length, 400, "nothing refused, nothing lost");
      assert.ok(sizes.length >= 3, `several requests (${sizes.length})`);
      assert.ok(sizes.every((n) => n <= 1.1 * 1024 * 1024), `each body near the 1 MiB budget: ${sizes}`);
      assert.deepEqual(pi.board.tasks.map((t) => t.title).slice(0, 3), ["T0", "T1", "T2"], "order kept");
    } finally {
      src.stop();
    }
  });
});

describe("LocalSource: the 2000-item cap", () => {
  const fullTasks = (n) => Array.from({ length: n }, (_, i) => ({ id: `t${String(i).padStart(4, "0")}`, title: "x", rank: i }));

  test("an add into a full collection is refused with the Pi's message; nothing is queued or sent", async () => {
    const pi = new FakePi({ tasks: fullTasks(B.LIMITS.maxItems) });
    const src = makeSource(pi);
    try {
      await src.start();
      const before = src.board;
      const err = await src.submit(addTask("t-new", "New")).then(() => null, (e) => e);
      assert.ok(err, "rejected");
      assert.equal(err.message, "board full: tasks already has 2000 items - delete some first (e.g. clear done tasks)");
      assert.equal(err.index, 0);
      assert.equal(src.unsent, 0);
      assert.equal(src.board, before, "the view is untouched");
      assert.equal(pi.log.filter((r) => r.method === "POST").length, 0);
      // other collections still have room; re-adding an existing id is a no-op, not an error
      await src.submit({ op: "add", coll: "notes", item: { id: "n-1", body: "hi" }, ts: TS });
      await src.submit(addTask("t0005", "again"));
      assert.equal(pi.board.notes.length, 1);
    } finally {
      src.stop();
    }
  });

  test("the batch counts its own deletes and adds", async () => {
    const pi = new FakePi({ tasks: fullTasks(B.LIMITS.maxItems - 1) });
    const src = makeSource(pi);
    try {
      await src.start();
      // two adds into 1999: the second doesn't fit -> the whole batch is refused (index 1)
      const err = await src.submit([addTask("t-a1", "A1"), addTask("t-a2", "A2")]).then(() => null, (e) => e);
      assert.match(err.message, /^board full: tasks already has 2000 items/);
      assert.equal(err.index, 1);
      assert.equal(src.unsent, 0);
      assert.equal(src.board.tasks.length, 1999);
      // a delete earlier in the batch makes room
      await src.submit([
        { op: "delete", coll: "tasks", id: "t0000", ts: TS },
        addTask("t-a1", "A1"),
        addTask("t-a2", "A2"),
      ]);
      assert.equal(pi.board.tasks.length, 2000);
      assert.equal(src.board.tasks.length, 2000);
    } finally {
      src.stop();
    }
  });

  test("queued (unsent) adds count against the cap too", async () => {
    const pi = new FakePi({ tasks: fullTasks(B.LIMITS.maxItems - 1) });
    const src = makeSource(pi);
    try {
      await src.start();
      pi.down = true;
      await src.submit(addTask("t-q", "queued"));
      assert.equal(src.unsent, 1);
      await assert.rejects(src.submit(addTask("t-r", "one too many")), /board full/);
      assert.equal(src.unsent, 1);
    } finally {
      src.stop();
    }
  });
});
