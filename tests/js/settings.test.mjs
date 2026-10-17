// GitHub settings helpers + detectMode.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  defaultGitHubSettings,
  loadGitHubSettings,
  saveGitHubSettings,
  clearGitHubSettings,
  testGitHubSettings,
  normalizeGitHubSettings,
  detectMode,
  githubCacheKey,
  githubSettingsError,
  customApiAllowed,
  pagesCodeRepo,
  SETTINGS_KEY,
  DEFAULT_REPO,
  DEFAULT_BRANCH,
  DEFAULT_PATH,
} from "../../static/js/sources.js";

const json = (status, obj, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: Object.assign({ "content-type": "application/json" }, headers) });

function memStorage() {
  const m = new Map();
  return { map: m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

const loc = (hostname, pathname = "/", search = "") => ({ hostname, pathname, search });

describe("defaultGitHubSettings", () => {
  test("project site <owner>.github.io/<repo>/", () => {
    const s = defaultGitHubSettings(loc("richard-0417.github.io", "/lab-hub/"));
    assert.deepEqual(s, { apiBase: "https://api.github.com", repo: "richard-0417/lab-hub", branch: "data", path: "board.json", token: "", clientName: "" });
    assert.equal(defaultGitHubSettings(loc("richard-0417.github.io", "/lab-hub")).repo, "richard-0417/lab-hub");
    assert.equal(defaultGitHubSettings(loc("richard-0417.github.io", "/lab-hub/index.html")).repo, "richard-0417/lab-hub");
    assert.equal(defaultGitHubSettings(loc("Someone.GitHub.io", "/other-repo/x/")).repo, "someone/other-repo");
  });

  test("user site at the root", () => {
    assert.equal(defaultGitHubSettings(loc("richard-0417.github.io", "/")).repo, "richard-0417/richard-0417.github.io");
    assert.equal(defaultGitHubSettings(loc("richard-0417.github.io", "/index.html")).repo, "richard-0417/richard-0417.github.io");
  });

  test("anywhere else -> richard-0417/lab-hub; no location in node", () => {
    assert.equal(defaultGitHubSettings(loc("localhost", "/")).repo, "richard-0417/lab-hub");
    assert.equal(defaultGitHubSettings(null).repo, "richard-0417/lab-hub");
    assert.equal(defaultGitHubSettings().repo, "richard-0417/lab-hub");
  });

  test("one-repo default: code on main, board.json on the data branch of the same repo", () => {
    assert.equal(DEFAULT_REPO, "richard-0417/lab-hub");
    assert.equal(DEFAULT_BRANCH, "data");
    assert.equal(DEFAULT_PATH, "board.json");
    // the Pages site of lab-hub defaults to lab-hub itself — no ?repo= needed
    const s = defaultGitHubSettings(loc("richard-0417.github.io", "/lab-hub/"));
    assert.equal(s.repo, pagesCodeRepo(loc("richard-0417.github.io", "/lab-hub/")));
    assert.equal(s.branch, "data");
    assert.equal(s.path, "board.json");
    // a separate data repo is still one ?repo= (or a Settings change) away
    assert.equal(defaultGitHubSettings(loc("richard-0417.github.io", "/lab-hub/", "?repo=richard-0417/lab-hub-data")).repo, "richard-0417/lab-hub-data");
  });

  test("pagesCodeRepo", () => {
    assert.equal(pagesCodeRepo(loc("richard-0417.github.io", "/lab-hub/")), "richard-0417/lab-hub");
    assert.equal(pagesCodeRepo(loc("Richard-0417.GitHub.io", "/lab-hub/index.html")), "richard-0417/lab-hub");
    assert.equal(pagesCodeRepo(loc("richard-0417.github.io", "/")), "richard-0417/richard-0417.github.io");
    assert.equal(pagesCodeRepo(loc("richard-0417.github.io", "/index.html")), "richard-0417/richard-0417.github.io");
    assert.equal(pagesCodeRepo(loc("localhost", "/lab-hub/")), null);
    assert.equal(pagesCodeRepo(loc(".github.io", "/x/")), null);
    assert.equal(pagesCodeRepo(null), null);
  });

  test("query params prefill the defaults", () => {
    const s = defaultGitHubSettings(loc("127.0.0.1", "/", "?repo=me/test&branch=data2&path=x/board.json&api=http://127.0.0.1:9010/"));
    assert.deepEqual(s, { apiBase: "http://127.0.0.1:9010", repo: "me/test", branch: "data2", path: "x/board.json", token: "", clientName: "" });
  });

  test("?api= only counts on a local development page", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "lab.localhost"]) {
      assert.equal(defaultGitHubSettings(loc(host, "/", "?api=http://127.0.0.1:9010")).apiBase, "http://127.0.0.1:9010", host);
    }
    for (const host of ["richard-0417.github.io", "evil.example", "localhost.evil.example", ""]) {
      assert.equal(defaultGitHubSettings(loc(host, "/lab-hub/", "?api=https://evil.example")).apiBase, "https://api.github.com", host);
    }
  });

  test("unusable ?branch= / ?path= are ignored", () => {
    const s = defaultGitHubSettings(loc("richard-0417.github.io", "/lab-hub/", "?path=../pulls/5/merge&branch=../main"));
    assert.equal(s.path, "board.json");
    assert.equal(s.branch, "data");
    assert.equal(defaultGitHubSettings(loc("x.github.io", "/y/", "?path=a/%2e%2e/b")).path, "board.json");
    assert.equal(defaultGitHubSettings(loc("x.github.io", "/y/", "?path=/data/board.json&branch=feature/x")).path, "data/board.json");
    assert.equal(defaultGitHubSettings(loc("x.github.io", "/y/", "?branch=feature/x")).branch, "feature/x");
  });
});

describe("normalizeGitHubSettings / githubSettingsError", () => {
  const pages = loc("richard-0417.github.io", "/lab-hub/");

  test("a custom apiBase is dropped on a non-local page (the token only goes to api.github.com)", () => {
    assert.equal(normalizeGitHubSettings({ apiBase: "https://evil.example" }, pages).apiBase, "https://api.github.com");
    assert.equal(normalizeGitHubSettings({ apiBase: "https://evil.example/" }, loc("localhost")).apiBase, "https://evil.example");
    assert.equal(normalizeGitHubSettings({ apiBase: "javascript:alert(1)" }, loc("localhost")).apiBase, "https://api.github.com");
    assert.equal(normalizeGitHubSettings({ apiBase: "https://user@evil.example" }, loc("localhost")).apiBase, "https://api.github.com");
    assert.equal(customApiAllowed(pages), false);
    assert.equal(customApiAllowed(loc("127.0.0.1")), true);
    assert.equal(customApiAllowed(null), true, "no browser location (node)");
  });

  test("branch / path / repo checks", () => {
    const ok = (extra) => githubSettingsError(Object.assign({ repo: "a/b" }, extra));
    assert.equal(ok({}), null);
    assert.equal(ok({ path: "data/board.json", branch: "feature/x-1.2" }), null);
    assert.equal(ok({ path: ".github/board.json" }), null);
    for (const path of ["../pulls/5/merge", "a/../b", "./x", "a/./b", "a//b", "a\\b", "%2e%2e/x", "my board.json", "a/..", "x?y", "x#y"]) {
      assert.match(ok({ path }), /file path/, path);
    }
    for (const branch of ["../main", "a..b", ".hidden", "x.lock", "x.", "a//b", "a b", "x~1", "a/"]) {
      assert.match(ok({ branch }), /branch name/, branch);
    }
    for (const repo of ["../..", "a/..", "./b", "nope", "a/b/c"]) assert.match(githubSettingsError({ repo }), /owner\/name/, repo);
    assert.match(ok({ token: "ghp_ab cd" }), /invalid characters/);
  });
});

describe("saved settings", () => {
  test("save / load / clear (clear also drops the cached board)", () => {
    const storage = memStorage();
    assert.equal(loadGitHubSettings(storage), null);
    const saved = saveGitHubSettings({ repo: " richard-0417/lab-hub ", token: " ghp_x ", clientName: "Richard" }, storage);
    assert.deepEqual(saved, { apiBase: "https://api.github.com", repo: "richard-0417/lab-hub", branch: "data", path: "board.json", token: "ghp_x", clientName: "Richard" });
    assert.deepEqual(loadGitHubSettings(storage), saved);
    const cacheKey = githubCacheKey(saved);
    storage.setItem(cacheKey, "{}");
    storage.setItem("labhub:gh:other/repo:data:board.json", "{}");
    clearGitHubSettings(storage);
    assert.equal(loadGitHubSettings(storage), null);
    assert.equal(storage.getItem(cacheKey), null);
    assert.equal(storage.getItem("labhub:gh:other/repo:data:board.json"), "{}");
  });

  test("saved settings are not overridden by query params (caller picks saved first)", () => {
    const storage = memStorage();
    saveGitHubSettings({ repo: "a/b", token: "t" }, storage);
    const s = loadGitHubSettings(storage) || defaultGitHubSettings(loc("x.github.io", "/y/", "?repo=evil/repo"));
    assert.equal(s.repo, "a/b");
  });

  test("corrupt or throwing storage is tolerated", () => {
    const storage = memStorage();
    storage.setItem(SETTINGS_KEY, "{not json");
    assert.equal(loadGitHubSettings(storage), null);
    const throwing = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
    assert.equal(loadGitHubSettings(throwing), null);
    saveGitHubSettings({ repo: "a/b" }, throwing);
    clearGitHubSettings(throwing);
  });

  test("normalizeGitHubSettings accepts a pasted GitHub URL", () => {
    assert.equal(normalizeGitHubSettings({ repo: "https://github.com/richard-0417/lab-hub.git" }).repo, "richard-0417/lab-hub");
    assert.equal(normalizeGitHubSettings({ repo: "https://github.com/richard-0417/lab-hub/" }).repo, "richard-0417/lab-hub");
  });
});

describe("testGitHubSettings", () => {
  const repoFetch = (handler) => {
    const calls = [];
    const f = async (url, init) => {
      calls.push({ url, headers: init.headers, init });
      return handler(url, init);
    };
    f.calls = calls;
    return f;
  };

  // A fake GitHub: GET /repos/<r> answers `repos[r]` (default 200), POST
  // /repos/<r>/git/blobs answers `blobs[r]` (a status, "offline", or a Response).
  const ghFake = ({ repos = {}, blobs = {} } = {}) =>
    repoFetch((url, init) => {
      const u = new URL(url);
      const m = /^\/repos\/([^/]+\/[^/]+)(\/git\/blobs)?$/.exec(u.pathname);
      if (!m) return json(404, { message: "Not Found" });
      const repo = m[1];
      if (!m[2]) return repos[repo] instanceof Response ? repos[repo] : json(200, { private: false, permissions: { push: true } });
      const b = blobs[repo] === undefined ? 403 : blobs[repo];
      if (b === "offline") throw new TypeError("fetch failed");
      if (b instanceof Response) return b;
      return b === 201 ? json(201, { sha: "abc", url: "x" }) : json(b, { message: b === 404 ? "Not Found" : "Resource not accessible by personal access token" });
    });
  const probes = (f) => f.calls.filter((c) => c.init.method === "POST");
  const pagesLoc = loc("richard-0417.github.io", "/lab-hub/");

  test("token that can write: the blob probe gets 201 -> canWrite true", async () => {
    const f = ghFake({ repos: { "a/b": json(200, { private: true }) }, blobs: { "a/b": 201 } });
    const r = await testGitHubSettings({ repo: "a/b", token: "tok" }, f, null);
    assert.deepEqual(r, { ok: true, error: null, canWrite: true, private: true, warnings: [] });
    assert.equal(f.calls[0].url, "https://api.github.com/repos/a/b");
    assert.equal(f.calls[0].headers.Authorization, "Bearer tok");
    const [p] = probes(f);
    assert.equal(p.url, "https://api.github.com/repos/a/b/git/blobs");
    assert.equal(p.headers.Authorization, "Bearer tok");
    assert.equal(p.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(p.init.body), { content: "lab-hub write-access check\n", encoding: "utf-8" });
  });

  test("permissions.push is ignored (it describes the account, not a fine-grained token)", async () => {
    const f = ghFake({ repos: { "a/b": json(200, { private: false, permissions: { push: true, admin: true } }) }, blobs: { "a/b": 403 } });
    const r = await testGitHubSettings({ repo: "a/b", token: "tok" }, f, null);
    assert.equal(r.ok, true);
    assert.equal(r.canWrite, false);
    assert.equal(r.error, "This token can read a/b but not write it — give it Contents: Read and write");
    const g = ghFake({ repos: { "a/b": json(200, { permissions: { push: false } }) }, blobs: { "a/b": 201 } });
    assert.equal((await testGitHubSettings({ repo: "a/b", token: "tok" }, g, null)).canWrite, true);
  });

  test("read-only token: 403 or 404 on the probe -> canWrite false with the hint", async () => {
    for (const status of [403, 404]) {
      const r = await testGitHubSettings({ repo: "a/b", token: "tok" }, ghFake({ blobs: { "a/b": status } }), null);
      assert.equal(r.ok, true, String(status));
      assert.equal(r.canWrite, false, String(status));
      assert.match(r.error, /can read a\/b but not write it — give it Contents: Read and write/);
      assert.deepEqual(r.warnings, []);
    }
  });

  test("write access that can't be confirmed -> canWrite null with a note; never blocks (ok stays true)", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 60);
    const cases = [
      [json(500, { message: "Server Error" }), /HTTP 500: Server Error/],
      [json(409, { message: "Git Repository is empty." }), /HTTP 409: Git Repository is empty/],
      [json(422, { message: "Validation Failed" }), /HTTP 422/],
      [json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }), /rate limit/],
      [json(429, { message: "slow down" }), /rate limit/],
      ["offline", /no answer from GitHub/],
    ];
    for (const [answer, why] of cases) {
      const r = await testGitHubSettings({ repo: "a/b", token: "tok" }, ghFake({ blobs: { "a/b": answer } }), null);
      assert.equal(r.ok, true, String(why));
      assert.equal(r.canWrite, null, String(why));
      assert.match(r.error, /Couldn't confirm that this token can write to a\/b/);
      assert.match(r.error, why);
      assert.deepEqual(r.warnings, []);
    }
  });

  test("no token, public repo -> ok but read-only, and no probe", async () => {
    const f = ghFake({ repos: { "a/b": json(200, { private: false }) }, blobs: { "a/b": 201 } });
    const r = await testGitHubSettings({ repo: "a/b" }, f, pagesLoc);
    assert.deepEqual(r, { ok: true, error: null, canWrite: false, private: false, warnings: [] });
    assert.equal("Authorization" in f.calls[0].headers, false);
    assert.equal(f.calls.length, 1, "nothing is probed without a token");
  });

  test("default one-repo setup (board on lab-hub's data branch): one probe, no warning", async () => {
    const f = ghFake({ blobs: { "richard-0417/lab-hub": 201 } });
    const r = await testGitHubSettings({ repo: "richard-0417/lab-hub", token: "tok" }, f, pagesLoc);
    assert.deepEqual(r, { ok: true, error: null, canWrite: true, private: false, warnings: [] });
    assert.deepEqual(probes(f).map((c) => c.url), ["https://api.github.com/repos/richard-0417/lab-hub/git/blobs"]);
    // owner/name compare ignores case, like GitHub
    const g = ghFake({ blobs: { "Richard-0417/Lab-Hub": 201 } });
    assert.deepEqual((await testGitHubSettings({ repo: "Richard-0417/Lab-Hub", token: "tok" }, g, pagesLoc)).warnings, []);
    assert.equal(probes(g).length, 1);
  });

  test("two-repo setup: a token that can also write the code repo gets a warning", async () => {
    const f = ghFake({ blobs: { "richard-0417/lab-hub-data": 201, "richard-0417/lab-hub": 201 } });
    const r = await testGitHubSettings({ repo: "richard-0417/lab-hub-data", token: "tok" }, f, pagesLoc);
    assert.equal(r.ok, true);
    assert.equal(r.canWrite, true);
    assert.equal(r.error, null);
    assert.deepEqual(r.warnings, [
      "This token can also change the dashboard's code (richard-0417/lab-hub). For the separate-data-repo setup, give it access to richard-0417/lab-hub-data only.",
    ]);
    assert.deepEqual(probes(f).map((c) => c.url).sort(), [
      "https://api.github.com/repos/richard-0417/lab-hub-data/git/blobs",
      "https://api.github.com/repos/richard-0417/lab-hub/git/blobs",
    ]);
  });

  test("two-repo setup: no warning when the code repo is refused or can't be checked", async () => {
    for (const code of [403, 404, 500, "offline"]) {
      const f = ghFake({ blobs: { "richard-0417/lab-hub-data": 201, "richard-0417/lab-hub": code } });
      const r = await testGitHubSettings({ repo: "richard-0417/lab-hub-data", token: "tok" }, f, pagesLoc);
      assert.equal(r.ok, true, String(code));
      assert.equal(r.canWrite, true, String(code));
      assert.deepEqual(r.warnings, [], String(code));
    }
  });

  test("two-repo case on a root user site and off Pages", async () => {
    const f = ghFake({ blobs: { "x/data": 201, "x/x.github.io": 201 } });
    const r = await testGitHubSettings({ repo: "x/data", token: "tok" }, f, loc("x.github.io", "/"));
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /\(x\/x\.github\.io\)/);
    // not on *.github.io (the Pi's LAN page, a dev server, node): no code-repo probe
    for (const l of [loc("192.168.1.20", "/"), loc("localhost", "/"), null]) {
      const g = ghFake({ blobs: { "x/data": 201, "x/x.github.io": 201 } });
      assert.deepEqual((await testGitHubSettings({ repo: "x/data", token: "tok" }, g, l)).warnings, []);
      assert.equal(probes(g).length, 1);
    }
  });

  test("failures", async () => {
    assert.equal((await testGitHubSettings({ repo: "a/b", token: "x" }, async () => json(401, { message: "Bad credentials" }))).ok, false);
    assert.match((await testGitHubSettings({ repo: "a/b", token: "x" }, async () => json(401, {}))).error, /token/);
    assert.match((await testGitHubSettings({ repo: "a/b" }, async () => json(404, {}))).error, /not found/i);
    assert.match((await testGitHubSettings({ repo: "a/b" }, async () => { throw new TypeError("fetch failed"); })).error, /Can't reach GitHub/);
    assert.match((await testGitHubSettings({ repo: "nope" }, async () => json(200, {}))).error, /owner\/name/);
    assert.match((await testGitHubSettings({ repo: "a/b", token: "ghp_ab cd" }, async () => json(200, {}))).error, /invalid characters/);
    const limited = await testGitHubSettings({ repo: "a/b" }, async () =>
      json(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60) }),
    );
    assert.equal(limited.ok, false);
    assert.match(limited.error, /rate limit/);
  });

  test("unsafe branch / path: refused before the token is sent anywhere", async () => {
    const f = repoFetch(() => json(200, { permissions: { push: true } }));
    const r = await testGitHubSettings({ repo: "richard-0417/lab-hub", path: "../pulls/5/merge", token: "tok" }, f);
    assert.equal(r.ok, false);
    assert.match(r.error, /file path/);
    assert.equal((await testGitHubSettings({ repo: "a/b", branch: "../x", token: "tok" }, f)).ok, false);
    assert.equal(f.calls.length, 0);
  });
});

describe("detectMode", () => {
  test("Pi config -> local", async () => {
    const calls = [];
    const r = await detectMode({
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return json(200, { labhub: true, name: "Lab Hub", github: { enabled: true } });
      },
      loc: loc("localhost", "/"),
    });
    assert.equal(r.mode, "local");
    assert.equal(r.config.name, "Lab Hub");
    assert.equal(calls[0].url, "api/config");
    assert.equal(calls[0].init.cache, "no-store");
  });

  test("404 / non-JSON / labhub missing -> github", async () => {
    assert.deepEqual(await detectMode({ fetchImpl: async () => json(404, {}), loc: null }), { mode: "github" });
    assert.deepEqual(await detectMode({ fetchImpl: async () => new Response("<html>", { status: 200 }), loc: null }), { mode: "github" });
    assert.deepEqual(await detectMode({ fetchImpl: async () => json(200, { name: "x" }), loc: null }), { mode: "github" });
  });

  test("*.github.io -> github without fetching", async () => {
    let n = 0;
    const r = await detectMode({ fetchImpl: async () => (n++, json(200, { labhub: true })), loc: loc("richard-0417.github.io", "/lab-hub/") });
    assert.deepEqual(r, { mode: "github" });
    assert.equal(n, 0);
  });

  test("network errors retried twice, then github", async () => {
    let n = 0;
    const r = await detectMode({ fetchImpl: async () => { n++; throw new TypeError("fetch failed"); }, retryDelaysMs: [5, 10], loc: null });
    assert.deepEqual(r, { mode: "github" });
    assert.equal(n, 3);
  });

  test("recovers on a retry", async () => {
    let n = 0;
    const r = await detectMode({
      fetchImpl: async () => {
        n++;
        if (n < 2) throw new TypeError("fetch failed");
        return json(200, { labhub: true });
      },
      retryDelaysMs: [5, 10],
      loc: null,
    });
    assert.equal(r.mode, "local");
    assert.equal(n, 2);
  });

  test("a reply whose body never arrives counts as a timeout (retried), not a hang", async () => {
    let n = 0;
    const r = await detectMode({
      fetchImpl: async () => (n++, new Response(new ReadableStream({ start() {} }), { status: 200 })),
      timeoutMs: 40,
      retryDelaysMs: [5],
      loc: null,
    });
    assert.deepEqual(r, { mode: "github" });
    assert.equal(n, 2);
  });
});
