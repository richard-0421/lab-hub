// GitHubSource against an in-memory fake of the GitHub REST subset Lab Hub uses.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import * as B from "../../static/js/board.js";
import { GitHubSource, utf8ToBase64, base64ToUtf8, githubCacheKey } from "../../static/js/sources.js";

const API = "https://api.test";
const REPO = "richard-0417/lab-hub";
const TOKEN = "test-token";
const TS = "2026-10-16T14:00:00Z";

// --------------------------------------------------------------- fake GitHub

function blobSha(text) {
  const data = Buffer.from(text, "utf8");
  return crypto.createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data])).digest("hex");
}

function wrapB64(text) {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  return b64.replace(/.{1,60}/g, "$&\n");
}

const jsonRes = (status, obj, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: Object.assign({ "content-type": "application/json" }, headers) });

class FakeGitHub {
  constructor({ repo = REPO, token = TOKEN, isPrivate = false, dataBranch = true, defaultBranch = "main", push = true } = {}) {
    this.repo = repo;
    this.token = token;
    this.isPrivate = isPrivate;
    this.push = push;
    this.defaultBranch = defaultBranch;
    this.branches = new Map(); // name -> Map(path -> text)
    this.heads = new Map(); // name -> commit sha
    this.commits = []; // {branch, message, path}
    this.log = []; // {method, path, status, headers, body}
    this.hooks = []; // {method, contains, fn}
    this.offline = false;
    this._mkBranch(defaultBranch, new Map([["README.md", "# Lab Hub\n"]]));
    if (dataBranch) this._mkBranch("data", new Map([["README.md", "# Lab Hub\n"]]));
    this.fetch = this.fetch.bind(this);
  }

  _mkBranch(name, files) {
    this.branches.set(name, files);
    this.heads.set(name, crypto.randomBytes(20).toString("hex"));
  }

  setFile(branch, path, text, message = "edit via web") {
    if (!this.branches.has(branch)) this._mkBranch(branch, new Map());
    this.branches.get(branch).set(path, text);
    this.heads.set(branch, crypto.randomBytes(20).toString("hex"));
    this.commits.push({ branch, message, path });
    return blobSha(text);
  }

  getFile(branch = "data", path = "board.json") {
    const files = this.branches.get(branch);
    return files ? files.get(path) : undefined;
  }

  getBoard(branch = "data", path = "board.json") {
    const text = this.getFile(branch, path);
    return text === undefined ? undefined : JSON.parse(text);
  }

  onNext(method, contains, fn) {
    this.hooks.push({ method, contains, fn });
  }

  count(method, contains, status) {
    return this.log.filter((r) => (!method || r.method === method) && (!contains || r.path.includes(contains)) && (status === undefined || r.status === status)).length;
  }

  contentsResponse(text, extraHeaders = {}) {
    const sha = blobSha(text);
    return jsonRes(200, { type: "file", encoding: "base64", size: Buffer.byteLength(text), name: "board.json", path: "board.json", content: wrapB64(text), sha }, Object.assign({ etag: `"${sha}"` }, extraHeaders));
  }

  async fetch(url, init = {}) {
    const method = (init.method || "GET").toUpperCase();
    const u = new URL(url);
    const headers = Object.assign({}, init.headers || {});
    const entry = { method, path: u.pathname + u.search, status: null, headers, body: init.body };
    this.log.push(entry);
    if (this.offline) {
      entry.status = "offline";
      throw new TypeError("fetch failed");
    }
    for (let i = 0; i < this.hooks.length; i++) {
      const h = this.hooks[i];
      if (h.method === method && entry.path.includes(h.contains)) {
        this.hooks.splice(i, 1);
        const r = await h.fn(entry);
        if (r instanceof Response) {
          entry.status = r.status;
          return r;
        }
        if (r === "offline") {
          entry.status = "offline";
          throw new TypeError("fetch failed");
        }
        break;
      }
    }
    const res = this._route(method, u, headers, init.body);
    entry.status = res.status;
    return res;
  }

  _auth(headers) {
    const h = headers.Authorization || headers.authorization;
    if (!h) return "anon";
    return h === `Bearer ${this.token}` ? "ok" : "bad";
  }

  _route(method, u, headers, body) {
    const auth = this._auth(headers);
    if (auth === "bad") return jsonRes(401, { message: "Bad credentials" });
    const prefix = `/repos/${this.repo}`;
    if (!u.pathname.startsWith(prefix) || (this.isPrivate && auth !== "ok")) return jsonRes(404, { message: "Not Found" });
    const rest = decodeURIComponent(u.pathname.slice(prefix.length));
    if (rest === "" && method === "GET") {
      const out = { full_name: this.repo, default_branch: this.defaultBranch, private: this.isPrivate };
      if (auth === "ok") out.permissions = { admin: false, push: this.push, pull: true };
      return jsonRes(200, out);
    }
    if (rest.startsWith("/contents/")) {
      const path = rest.slice("/contents/".length);
      if (method === "GET") {
        const ref = u.searchParams.get("ref") || this.defaultBranch;
        const files = this.branches.get(ref);
        if (!files) return jsonRes(404, { message: `No commit found for the ref ${ref}` });
        if (!files.has(path)) return jsonRes(404, { message: "Not Found" });
        const text = files.get(path);
        const sha = blobSha(text);
        const inm = headers["If-None-Match"];
        if (inm && inm === `"${sha}"`) return new Response(null, { status: 304, headers: { etag: `"${sha}"` } });
        return this.contentsResponse(text);
      }
      if (method === "PUT") {
        if (auth !== "ok" || !this.push) return jsonRes(403, { message: "Resource not accessible by personal access token" });
        const req = JSON.parse(body);
        if (!req.message) return jsonRes(422, { message: 'Invalid request.\n\n"message" wasn\'t supplied.' });
        const branch = req.branch || this.defaultBranch;
        const files = this.branches.get(branch);
        if (!files) return jsonRes(404, { message: `Branch ${branch} not found` });
        const existing = files.get(path);
        if (existing !== undefined) {
          if (!req.sha) return jsonRes(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
          if (req.sha !== blobSha(existing)) return jsonRes(409, { message: `${path} does not match ${req.sha}` });
        }
        const text = Buffer.from(req.content, "base64").toString("utf8");
        const sha = this.setFile(branch, path, text, req.message);
        return jsonRes(existing === undefined ? 201 : 200, { content: { sha, path }, commit: { sha: this.heads.get(branch), message: req.message } });
      }
    }
    if (rest.startsWith("/git/ref/heads/") && method === "GET") {
      const name = rest.slice("/git/ref/heads/".length);
      if (!this.heads.has(name)) return jsonRes(404, { message: "Not Found" });
      return jsonRes(200, { ref: `refs/heads/${name}`, object: { sha: this.heads.get(name), type: "commit" } });
    }
    if (rest === "/git/refs" && method === "POST") {
      const req = JSON.parse(body);
      const name = String(req.ref || "").replace(/^refs\/heads\//, "");
      if (this.branches.has(name)) return jsonRes(422, { message: "Reference already exists" });
      const from = [...this.heads.entries()].find(([, sha]) => sha === req.sha);
      if (!from) return jsonRes(422, { message: "Object does not exist" });
      this.branches.set(name, new Map(this.branches.get(from[0])));
      this.heads.set(name, req.sha);
      return jsonRes(201, { ref: req.ref, object: { sha: req.sha } });
    }
    return jsonRes(404, { message: "Not Found" });
  }
}

function memStorage() {
  const m = new Map();
  return {
    map: m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

const settings = (extra = {}) => Object.assign({ apiBase: API, repo: REPO, branch: "data", path: "board.json", token: TOKEN, clientName: "test" }, extra);

function makeSource(fake, { storage = memStorage(), token = TOKEN, ...opts } = {}) {
  return new GitHubSource(settings({ token }), Object.assign({ fetchImpl: fake.fetch, storage, pollMs: 1e9, readonlyPollMs: 1e9, pushDelayMs: 1e9 }, opts));
}

function seedBoard(fake, doc, branch = "data") {
  fake.setFile(branch, "board.json", B.serializeBoard(B.normalizeBoard(doc)), "seed");
}

const task = (id, title, extra = {}) => Object.assign({ id, title }, extra);
const addTask = (id, title, extra = {}) => ({ op: "add", coll: "tasks", item: task(id, title, extra), ts: TS });
const titles = (board) => board.tasks.map((t) => t.title);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------- tests

describe("GitHubSource", () => {
  test("initial create when board.json is missing (404 -> repo check -> PUT without sha)", async () => {
    const fake = new FakeGitHub();
    const src = makeSource(fake);
    const sync = await src.syncNow();
    assert.equal(sync.state, "ok");
    assert.equal(sync.loaded, true);
    assert.equal(sync.pending, 0);
    assert.ok(sync.last_push);
    const put = fake.log.find((r) => r.method === "PUT");
    assert.equal("sha" in JSON.parse(put.body), false);
    const doc = fake.getBoard();
    assert.equal(doc.updated_by, "test");
    assert.deepEqual(doc.tasks, []);
    assert.equal(fake.commits.at(-1).message, "test: create board.json");
    assert.equal(fake.getFile(), B.serializeBoard(B.normalizeBoard(doc)));
  });

  test("request headers: token, API version, accept, no-store", async () => {
    const fake = new FakeGitHub();
    seedBoard(fake, { tasks: [task("t-a", "A")] });
    const src = makeSource(fake);
    await src.syncNow();
    const get = fake.log.find((r) => r.method === "GET");
    assert.equal(get.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(get.headers.Accept, "application/vnd.github+json");
    assert.equal(get.headers["X-GitHub-Api-Version"], "2022-11-28");
    assert.equal(get.path, `/repos/${REPO}/contents/board.json?ref=data`);
    assert.deepEqual(titles(src.board), ["A"]);
  });

  test("branch auto-create from the default branch", async () => {
    const fake = new FakeGitHub({ dataBranch: false });
    const src = makeSource(fake);
    await src.submit(addTask("t-1", "First task"));
    const sync = await src.syncNow();
    assert.equal(sync.state, "ok", sync.last_error);
    assert.ok(fake.branches.has("data"));
    assert.equal(fake.getFile("data", "README.md"), "# Lab Hub\n", "branch starts from main");
    assert.equal(fake.count("POST", "/git/refs", 201), 1);
    assert.equal(fake.count("GET", "/git/ref/heads/main", 200), 1);
    assert.deepEqual(titles(fake.getBoard()), ["First task"]);
    assert.equal(fake.getFile("main", "board.json"), undefined, "main is untouched");
    assert.equal(sync.pending, 0);
  });

  test("two-way merge with a concurrent writer (the Pi)", async () => {
    const fake = new FakeGitHub();
    seedBoard(fake, { tasks: [task("t-a", "Alpha", { rank: 1 })] });
    const src = makeSource(fake);
    await src.syncNow();
    // The Pi edits Alpha's title and adds Gamma...
    const pi = B.applyOps(B.normalizeBoard(fake.getBoard()), [
      { op: "update", coll: "tasks", id: "t-a", set: { title: "Alpha (pi)" }, ts: TS },
      addTask("t-c", "Gamma", { rank: 3 }),
    ]);
    fake.setFile("data", "board.json", B.serializeBoard(pi), "lab-pi: edit");
    // ...while the browser bumps Alpha's priority and adds Beta.
    await src.submit([
      { op: "update", coll: "tasks", id: "t-a", set: { priority: "high" }, ts: TS },
      addTask("t-b", "Beta", { rank: 2 }),
    ]);
    assert.deepEqual(titles(src.board), ["Alpha", "Beta"], "optimistic view before sync");
    await src.syncNow();
    const remote = B.normalizeBoard(fake.getBoard());
    assert.deepEqual(titles(remote), ["Alpha (pi)", "Beta", "Gamma"]);
    assert.equal(remote.tasks[0].priority, "high");
    assert.deepEqual(src.board.tasks, remote.tasks);
    assert.equal(src.sync.pending, 0);
    assert.match(fake.commits.at(-1).message, /^test: edit “Alpha \(pi\)”, add “Beta”/);
  });

  test("409 race: someone writes between our GET and PUT -> refetch, replay, retry", async () => {
    const fake = new FakeGitHub();
    seedBoard(fake, { tasks: [task("t-a", "A", { rank: 1 })] });
    const src = makeSource(fake);
    await src.syncNow();
    await src.submit(addTask("t-b", "B", { rank: 2 }));
    fake.onNext("PUT", "/contents/", () => {
      const other = B.applyOps(B.normalizeBoard(fake.getBoard()), [addTask("t-d", "D", { rank: 4 })]);
      fake.setFile("data", "board.json", B.serializeBoard(other), "someone else");
    });
    const sync = await src.syncNow();
    assert.equal(sync.state, "ok", sync.last_error);
    assert.equal(fake.count("PUT", "/contents/", 409), 1);
    assert.equal(fake.count("PUT", "/contents/", 200), 1);
    assert.deepEqual(titles(fake.getBoard()), ["A", "B", "D"]);
    assert.deepEqual(titles(src.board), ["A", "B", "D"]);
  });

  test("422 'sha wasn't supplied' (file created by someone else meanwhile) is retried", async () => {
    const fake = new FakeGitHub();
    const src = makeSource(fake);
    await src.submit(addTask("t-b", "Mine"));
    fake.onNext("PUT", "/contents/", () => seedBoard(fake, { tasks: [task("t-x", "Theirs", { rank: -1 })] }));
    const sync = await src.syncNow();
    assert.equal(sync.state, "ok", sync.last_error);
    assert.equal(fake.count("PUT", "/contents/", 422), 1);
    assert.deepEqual(titles(fake.getBoard()), ["Theirs", "Mine"]);
  });

  test("gives up after 3 lost races, keeps the ops, succeeds next time", async () => {
    const fake = new FakeGitHub();
    seedBoard(fake, { tasks: [task("t-a", "A")] });
    const src = makeSource(fake);
    await src.syncNow();
    await src.submit(addTask("t-b", "B", { rank: 1 }));
    for (let i = 0; i < 3; i++) {
      fake.onNext("PUT", "/contents/", () => {
        const b = B.normalizeBoard(fake.getBoard());
        fake.setFile("data", "board.json", B.serializeBoard(B.applyOps(b, [addTask(`t-r${i}`, `R${i}`, { rank: 10 + i })])), "race");
      });
    }
    let sync = await src.syncNow();
    assert.equal(fake.count("PUT", "/contents/", 409), 3);
    assert.equal(sync.pending, 1);
    assert.ok(sync.last_error);
    sync = await src.syncNow();
    assert.equal(sync.pending, 0);
    assert.equal(sync.last_error, null);
    assert.deepEqual(titles(fake.getBoard()), ["A", "B", "R0", "R1", "R2"]);
  });

  test("304 Not Modified: conditional GET, no PUT, board unchanged", async () => {
    const fake = new FakeGitHub();
    seedBoard(fake, { tasks: [task("t-a", "A")] });
    const src = makeSource(fake);
    let calls = 0;
    src.subscribe(() => calls++);
    await src.syncNow();
    const before = src.board;
    await src.syncNow();
    const last = fake.log.at(-1);
    assert.equal(last.status, 304);
    assert.ok(last.headers["If-None-Match"]);
    assert.equal(fake.count("PUT"), 0);
    assert.equal(src.board, before, "same board object when nothing changed");
    assert.ok(calls >= 1);
  });

  test("invalid JSON on GitHub -> state error, no PUT, ops kept", async () => {
    const fake = new FakeGitHub();
    fake.setFile("data", "board.json", "{ this is not json", "oops");
    const src = makeSource(fake);
    await src.submit(addTask("t-a", "Keep me"));
    const sync = await src.syncNow();
    assert.equal(sync.state, "error");
    assert.match(sync.last_error, /^board\.json on GitHub is not valid JSON: /);
    assert.equal(fake.count("PUT"), 0);
    assert.equal(sync.pending, 1);
    assert.deepEqual(titles(src.board), ["Keep me"]);
    // fixing the file by hand recovers
    seedBoard(fake, { tasks: [task("t-z", "Fixed", { rank: 5 })] });
    const ok = await src.syncNow();
    assert.equal(ok.state, "ok", ok.last_error);
    assert.deepEqual(titles(fake.getBoard()), ["Keep me", "Fixed"]);
  });

  test("401 -> token rejected", async () => {
    const fake = new FakeGitHub({ token: "the-real-one" });
    const src = makeSource(fake);
    const sync = await src.syncNow();
    assert.equal(sync.state, "error");
    assert.equal(sync.last_error, "GitHub token rejected (expired or revoked?)");
    assert.equal(sync.link, "up");
  });

  test("a token with invalid characters is reported, not sent", async () => {
    const fake = new FakeGitHub();
    const src = makeSource(fake, { token: "ghp_abc\u2028def" });
    const sync = await src.syncNow();
    assert.equal(sync.state, "error");
    assert.match(sync.last_error, /invalid characters/);
    assert.equal(fake.log.length, 0);
  });

  test("404 repo -> repo not found", async () => {
    const fake = new FakeGitHub({ repo: "someone/else" });
    const src = makeSource(fake);
    const sync = await src.syncNow();
    assert.equal(sync.state, "error");
    assert.equal(sync.last_error, "repo not found, or the token can't see it");
  });

  test("403 rate limit mentions the reset time and backs off", async () => {
    const fake = new FakeGitHub();
    const reset = Math.floor(Date.now() / 1000) + 600;
    fake.onNext("GET", "/contents/", () =>
      jsonRes(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }),
    );
    const src = makeSource(fake);
    const sync = await src.syncNow();
    assert.equal(sync.state, "error");
    assert.match(sync.last_error, /rate limit/i);
    assert.match(sync.last_error, /resets at/);
    const n = fake.log.length;
    await src.syncNow(); // still inside the back-off window: no request
    assert.equal(fake.log.length, n);
  });

  test("403 without rate limit -> permissions message", async () => {
    const fake = new FakeGitHub({ push: false });
    seedBoard(fake, { tasks: [task("t-a", "A")] });
    const src = makeSource(fake);
    await src.submit(addTask("t-b", "B"));
    const sync = await src.syncNow();
    assert.equal(sync.state, "error");
    assert.match(sync.last_error, /403/);
    assert.match(sync.last_error, /Contents: read & write/);
    assert.equal(sync.pending, 1);
  });

  test("offline: ops kept and persisted, pushed on recovery", async () => {
    const fake = new FakeGitHub();
    seedBoard(fake, { tasks: [task("t-a", "A")] });
    const storage = memStorage();
    const src = makeSource(fake, { storage });
    await src.syncNow();
    fake.offline = true;
    await src.submit(addTask("t-b", "B", { rank: 1 }));
    let sync = await src.syncNow();
    assert.equal(sync.state, "offline");
    assert.equal(sync.link, "down");
    assert.equal(sync.last_error, "Can't reach GitHub");
    assert.equal(sync.pending, 1);
    assert.deepEqual(titles(src.board), ["A", "B"]);
    const saved = JSON.parse(storage.getItem("labhub:gh:richard-0417/lab-hub:data:board.json"));
    assert.equal(saved.pending.length, 1);
    fake.offline = false;
    sync = await src.syncNow();
    assert.equal(sync.state, "ok");
    assert.equal(sync.link, "up");
    assert.equal(sync.pending, 0);
    assert.deepEqual(titles(fake.getBoard()), ["A", "B"]);
  });

  test("read-only without a token: canEdit false, submit throws, no writes", async () => {
    const fake = new FakeGitHub();
    seedBoard(fake, { tasks: [task("t-a", "A")] });
    const src = makeSource(fake, { token: "" });
    assert.equal(src.canEdit, false);
    const sync = await src.syncNow();
    assert.equal(sync.state, "readonly");
    assert.equal(sync.canEdit, false);
    assert.deepEqual(titles(src.board), ["A"]);
    await assert.rejects(src.submit(addTask("t-b", "B")), { message: "read-only" });
    assert.equal(fake.count("PUT"), 0);
    assert.equal(fake.log.some((r) => "Authorization" in r.headers), false);
  });

  test("read-only polls at readonlyPollMs", async () => {
    const fake = new FakeGitHub();
    seedBoard(fake, { tasks: [task("t-a", "A")] });
    const src = new GitHubSource(settings({ token: "" }), { fetchImpl: fake.fetch, storage: memStorage(), pollMs: 1e9, readonlyPollMs: 25 });
    try {
      await src.start();
      await sleep(140);
      assert.ok(fake.count("GET", "/contents/") >= 3, `polled ${fake.count("GET", "/contents/")} times`);
    } finally {
      src.stop();
    }
    const n = fake.log.length;
    await sleep(60);
    assert.equal(fake.log.length, n, "stop() clears the timer");
  });

  test("private repo without a token -> error", async () => {
    const fake = new FakeGitHub({ isPrivate: true });
    seedBoard(fake, { tasks: [task("t-a", "A")] });
    const src = makeSource(fake, { token: "" });
    const sync = await src.syncNow();
    assert.equal(sync.state, "error");
    assert.equal(sync.last_error, "repo not found, or the token can't see it");
  });

  test("persistence across instances via storage (pending + cached base + etag)", async () => {
    const fake = new FakeGitHub();
    seedBoard(fake, { tasks: [task("t-a", "A")] });
    const storage = memStorage();
    const s1 = makeSource(fake, { storage });
    await s1.syncNow();
    fake.offline = true;
    await s1.submit(addTask("t-b", "B", { rank: 1 }));
    await s1.syncNow();
    s1.stop();

    const s2 = makeSource(fake, { storage });
    assert.deepEqual(titles(s2.board), ["A", "B"], "cached base + pending ops, before any request");
    assert.equal(s2.sync.pending, 1);
    assert.equal(s2.sync.loaded, true);
    let first = null;
    s2.subscribe((p) => (first = first || p));
    assert.ok(first, "subscribe fires at once when a cached board exists");
    fake.offline = false;
    await s2.syncNow();
    assert.equal(s2.sync.pending, 0);
    assert.deepEqual(titles(fake.getBoard()), ["A", "B"]);

    const s3 = makeSource(fake, { storage });
    await s3.syncNow();
    const get = fake.log.filter((r) => r.method === "GET" && r.path.includes("/contents/")).at(-1);
    assert.equal(get.status, 200, "etag was cleared after our own write");
    await s3.syncNow();
    assert.equal(fake.log.at(-1).status, 304);
    const s4 = makeSource(fake, { storage });
    await s4.syncNow();
    assert.equal(fake.log.at(-1).status, 304, "etag survives a reload");
    assert.deepEqual(titles(s4.board), ["A", "B"]);
  });

  test("UTF-8 round trip (emoji, accents, CJK) through base64", async () => {
    const fake = new FakeGitHub();
    const title = "Café ✓ naïve — 日本語 😀🧪 Zoë";
    const src = makeSource(fake);
    await src.submit([addTask("t-u", title, { notes: "línea 1\nlínea 2 🚀", tags: ["#Química"] })]);
    await src.syncNow();
    const raw = fake.getFile();
    assert.ok(raw.includes(title), "stored as raw UTF-8, not escaped");
    const fresh = makeSource(fake, { storage: memStorage() });
    await fresh.syncNow();
    assert.equal(fresh.board.tasks[0].title, title);
    assert.equal(fresh.board.tasks[0].notes, "línea 1\nlínea 2 🚀");
    assert.deepEqual(fresh.board.tasks[0].tags, ["química"]);
  });

  test("utf8ToBase64 / base64ToUtf8 match Buffer, including large inputs", () => {
    const samples = ["", "a", "Café ✓ 😀", "日本語".repeat(20000), "\u0000\u007f\u0080߿ࠀ￿", "😀".repeat(30000)];
    for (const s of samples) {
      const b64 = utf8ToBase64(s);
      assert.equal(b64, Buffer.from(s, "utf8").toString("base64"));
      assert.equal(base64ToUtf8(b64), s);
      assert.equal(base64ToUtf8(b64.replace(/.{1,60}/g, "$&\n")), s);
    }
  });

  test("hand-edited file is normalized and written back once", async () => {
    const fake = new FakeGitHub();
    fake.setFile("data", "board.json", JSON.stringify({ tasks: [{ id: "a", title: "  Messy  ", priority: "HIGH", extra: 1 }] }), "hand edit");
    const src = makeSource(fake);
    await src.syncNow();
    assert.equal(fake.count("PUT"), 1);
    assert.equal(fake.commits.at(-1).message, "test: tidy board.json (normalize hand edits)");
    const doc = fake.getBoard();
    assert.equal(doc.tasks[0].title, "Messy");
    assert.equal(doc.tasks[0].priority, "high");
    await src.syncNow();
    assert.equal(fake.count("PUT"), 1, "no second write");
  });

  test("ops that change nothing make no commit", async () => {
    const fake = new FakeGitHub();
    seedBoard(fake, { tasks: [task("t-a", "A")] });
    const src = makeSource(fake);
    await src.syncNow();
    await src.submit({ op: "update", coll: "tasks", id: "t-gone", set: { title: "x" }, ts: TS });
    const sync = await src.syncNow();
    assert.equal(fake.count("PUT"), 0);
    assert.equal(sync.pending, 0);
  });

  test("stale read right after our own write does not roll the view back", async () => {
    const fake = new FakeGitHub();
    seedBoard(fake, { tasks: [task("t-a", "A")] });
    const src = makeSource(fake);
    await src.syncNow();
    const oldText = fake.getFile();
    await src.submit(addTask("t-b", "B", { rank: 1 }));
    await src.syncNow();
    fake.onNext("GET", "/contents/", () => fake.contentsResponse(oldText)); // replica lag
    await src.syncNow();
    assert.deepEqual(titles(src.board), ["A", "B"]);
    await src.syncNow();
    assert.deepEqual(titles(src.board), ["A", "B"]);
  });

  test("debounced push: a burst of submits becomes one commit; subscribers fire synchronously", async () => {
    const fake = new FakeGitHub();
    seedBoard(fake, { tasks: [task("t-a", "A", { rank: 0 })] });
    const src = new GitHubSource(settings(), { fetchImpl: fake.fetch, storage: memStorage(), pollMs: 1e9, pushDelayMs: 30 });
    const seen = [];
    src.subscribe(({ board, sync }) => seen.push({ n: board.tasks.length, state: sync.state }));
    try {
      await src.start();
      const p = src.submit(addTask("t-1", "One", { rank: 1 }));
      assert.equal(seen.at(-1).n, 2, "optimistic emit happened before submit's promise settled");
      assert.equal(seen.at(-1).state, "pending");
      await p;
      await src.submit(addTask("t-2", "Two", { rank: 2 }));
      await src.submit({ op: "update", coll: "tasks", id: "t-1", set: { status: "done", done_at: TS }, ts: TS });
      await sleep(200);
      assert.equal(fake.count("PUT"), 1);
      assert.deepEqual(titles(fake.getBoard()), ["A", "One", "Two"]);
      assert.equal(fake.commits.at(-1).message.split("\n")[0], "test: add “One”, add “Two”, complete “One”");
      assert.equal(src.sync.state, "ok");
    } finally {
      src.stop();
    }
  });

  test("invalid ops are rejected before anything is queued", async () => {
    const fake = new FakeGitHub();
    const src = makeSource(fake);
    await assert.rejects(src.submit({ op: "update", coll: "tasks", id: "t-1", set: { status: "blocked" }, ts: TS }), /status/);
    assert.equal(src.sync.pending, 0);
  });

  test("sync object shape and file_url", async () => {
    const fake = new FakeGitHub();
    const src = makeSource(fake);
    await src.syncNow();
    const s = src.sync;
    for (const k of ["enabled", "state", "pending", "last_sync", "last_push", "last_error", "repo", "branch", "path", "mode", "canEdit", "link", "file_url"]) {
      assert.ok(k in s, k);
    }
    assert.equal(s.enabled, true);
    assert.equal(s.mode, "github");
    assert.equal(s.file_url, "https://github.com/richard-0417/lab-hub/blob/data/board.json");
    assert.equal(githubCacheKey(settings()), "labhub:gh:richard-0417/lab-hub:data:board.json");
  });

  test("files over 1 MB are read through the blobs API", async () => {
    const fake = new FakeGitHub();
    seedBoard(fake, { tasks: [task("t-big", "Big")] });
    const text = fake.getFile();
    const sha = blobSha(text);
    fake.onNext("GET", "/contents/", () => jsonRes(200, { type: "file", encoding: "none", size: 2e6, content: "", sha }, { etag: `"${sha}"` }));
    fake.onNext("GET", `/git/blobs/${sha}`, () => jsonRes(200, { sha, encoding: "base64", content: wrapB64(text) }));
    const src = makeSource(fake);
    const sync = await src.syncNow();
    assert.equal(sync.state, "ok", sync.last_error);
    assert.deepEqual(titles(src.board), ["Big"]);
  });
});
