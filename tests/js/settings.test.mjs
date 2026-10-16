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
  SETTINGS_KEY,
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

  test("query params prefill the defaults", () => {
    const s = defaultGitHubSettings(loc("127.0.0.1", "/", "?repo=me/test&branch=data2&path=x/board.json&api=http://127.0.0.1:9010/"));
    assert.deepEqual(s, { apiBase: "http://127.0.0.1:9010", repo: "me/test", branch: "data2", path: "x/board.json", token: "", clientName: "" });
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
      calls.push({ url, headers: init.headers });
      return handler(url, init);
    };
    f.calls = calls;
    return f;
  };

  test("token with push permission", async () => {
    const f = repoFetch(() => json(200, { private: true, permissions: { push: true, pull: true } }));
    const r = await testGitHubSettings({ repo: "a/b", token: "tok" }, f);
    assert.deepEqual(r, { ok: true, error: null, canWrite: true, private: true });
    assert.equal(f.calls[0].url, "https://api.github.com/repos/a/b");
    assert.equal(f.calls[0].headers.Authorization, "Bearer tok");
  });

  test("token without push permission", async () => {
    const f = repoFetch(() => json(200, { private: false, permissions: { push: false, pull: true } }));
    const r = await testGitHubSettings({ repo: "a/b", token: "tok" }, f);
    assert.equal(r.ok, true);
    assert.equal(r.canWrite, false);
    assert.match(r.error, /can't write/);
  });

  test("no token, public repo -> ok but read-only", async () => {
    const f = repoFetch(() => json(200, { private: false }));
    const r = await testGitHubSettings({ repo: "a/b" }, f);
    assert.deepEqual(r, { ok: true, error: null, canWrite: false, private: false });
    assert.equal("Authorization" in f.calls[0].headers, false);
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
});
