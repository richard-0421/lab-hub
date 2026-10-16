# Lab Hub — architecture & contracts

This is the source of truth for how the pieces fit. If code and this file
disagree, fix one of them in the same change.

## 1. The big picture

```
                    GitHub repo  richard-0417/lab-hub
          ┌─────────────────────────────────────────────────────┐
          │ branch main   code (app/, static/, scripts/ …)      │──► GitHub Actions ──► GitHub Pages
          │ branch data   board.json  (tasks, requests, notes)  │     (static/ only)    richard-0417.github.io/lab-hub
          └─────────────────────────────────────────────────────┘
               ▲  git pull every 5 min          ▲  Contents API (GET/PUT, sha-checked)
               │  (scripts/update.sh)           │
   ┌───────────┴──────────────┐                 │                  ┌──────────────────────────┐
   │ Raspberry Pi (lab)       │                 │                  │ Any browser, anywhere    │
   │ FastAPI  app/            │─────────────────┘                  │ GitHub Pages copy of     │
   │  • local state/ (cache + │   sync thread: pull ~15 s,         │ static/ in "github" mode │
   │    pending op queue)     │   push ~1 s after a local edit     │ • token in localStorage  │
   │  • calendar (.ics)       │                                    │ • same op queue, in JS   │
   │ Chromium kiosk ──► http://localhost:8000 ("local" mode)       │   talks to GitHub API    │
   └──────────────────────────┘                                    └──────────────────────────┘
```

* **One frontend, two modes.** `static/` is served by the Pi (local mode) and
  deployed unchanged to GitHub Pages (github mode). On load the page fetches
  `api/config` (relative URL). If that returns JSON with `"labhub": true` it is
  in **local mode** and talks to the Pi's API. Otherwise (404 on github.io) it is
  in **github mode** and talks to the GitHub REST API directly with a
  fine-grained personal access token the user pastes once (stored in that
  browser's `localStorage`).
* **GitHub is the meeting point.** The board lives in one JSON file
  (`board.json`) on a dedicated `data` branch so data commits never trigger a
  Pages build and never touch the code history the Pi pulls.
* **Edits are operations, not snapshots.** Every change (add / update / delete)
  is an *op*. Each client keeps `base` (the last remote file it saw, plus its
  sha) and a queue of `pending` ops. What the user sees is
  `view = applyOps(base, pending)`. Syncing = fetch latest remote → replay
  pending ops on top of it → PUT with the old sha. A 409 (someone else wrote
  first) just means refetch and replay again. This is a rebase, so two people
  editing different tasks never conflict, and the same field edited on both
  sides resolves to whoever pushed last.
* **Offline-safe.** The Pi persists `base` + `pending` to `state/`. If the
  network or GitHub is down the dashboard keeps working; queued ops push when it
  comes back.
* **No GitHub configured → local-only.** If `github_repo` or the token is
  missing, the Pi applies ops straight into its local board file and the sync
  pill says "GitHub sync off".

## 2. The board document (`board.json`)

```json
{
  "schema": 1,
  "updated_at": "2026-10-16T14:03:22Z",
  "updated_by": "lab-pi",
  "tasks":    [ /* task items */ ],
  "requests": [ /* request items */ ],
  "notes":    [ /* note items */ ]
}
```

Items inside each collection are stored **sorted by `(rank, id)`** and with keys
in the field order listed below, so diffs on GitHub stay small and readable.
Serialization: UTF-8, 2-space indent, no ASCII-escaping, trailing newline.
A `rank` that is an integral float is written as an int (`3` not `3.0`).

### Common fields (every collection)

| field        | type   | rules |
|--------------|--------|-------|
| `id`         | string | `^[A-Za-z0-9_-]{1,64}$`, unique within the collection, never edited |
| `rank`       | number | finite float; sort key (ascending). Default `0` |
| `created_at` | string | ISO-8601 UTC `YYYY-MM-DDTHH:MM:SSZ`; never edited |
| `updated_at` | string | ISO-8601 UTC; set from the op's `ts` on every update |

### `tasks` — field order: id, title, notes, status, priority, assignee, due, tags, rank, created_at, updated_at, done_at, created_by

| field        | type            | rules / default |
|--------------|-----------------|-----------------|
| `title`      | string          | required, 1–300 chars after trim |
| `notes`      | string          | 0–4000, default `""` (newlines allowed) |
| `status`     | enum            | `todo` \| `doing` \| `done`, default `todo` |
| `priority`   | enum            | `high` \| `normal` \| `low`, default `normal` |
| `assignee`   | string          | 0–60, default `""` |
| `due`        | string          | `""` or `YYYY-MM-DD` (valid calendar date), default `""` |
| `tags`       | list of strings | ≤ 8 tags, each 1–24 chars, trimmed, leading `#` stripped, lower-cased, de-duplicated (keep first), default `[]` |
| `done_at`    | string          | `""` or ISO UTC, default `""` |
| `created_by` | string          | 0–60, default `""` |

### `requests` (item / supply requests) — field order: id, item, qty, requested_by, status, notes, link, rank, created_at, updated_at

| field          | type   | rules / default |
|----------------|--------|-----------------|
| `item`         | string | required, 1–300 |
| `qty`          | string | 0–40, default `""` (free text, e.g. "2 boxes") |
| `requested_by` | string | 0–60, default `""` |
| `status`       | enum   | `new` \| `ordered` \| `received`, default `new` |
| `notes`        | string | 0–2000, default `""` |
| `link`         | string | 0–500, default `""`; must start with `http://` or `https://` if non-empty, otherwise coerced to `""` |

### `notes` (team notes board) — field order: id, body, author, pinned, color, rank, created_at, updated_at

| field    | type   | rules / default |
|----------|--------|-----------------|
| `body`   | string | required, 1–2000 (newlines allowed) |
| `author` | string | 0–60, default `""` |
| `pinned` | bool   | default `false` |
| `color`  | enum   | `yellow` \| `blue` \| `green` \| `pink` \| `purple`, default `yellow` |

### Normalization (`normalizeBoard` / `normalize_board`)

Used on every document read from disk or GitHub (which may have been hand-edited).
`tests/ops_vectors.json` holds shared test cases that **both** the Python and
the JS implementation must pass.

* Top level: key order `schema, updated_at, updated_by, tasks, requests, notes`.
  `schema` is forced to `1`; `updated_at` → canonical timestamp or `""`;
  `updated_by` → single-line string ≤ 60 or `""`. Missing/non-list collection →
  `[]`. Unknown top-level keys are dropped. A non-object document normalizes to
  the empty board.
* Each item: non-object entries are skipped; unknown keys dropped; every field
  coerced to its type. Strings: non-string → `""` (except numbers are NOT
  stringified — also `""`); then control-character cleanup (below); then trim;
  then clamp to the max length. Lengths count **Unicode code points** (JS must
  use `Array.from(s)`, not `s.length`).
* Enums are matched leniently here (`trim().toLowerCase()`); unknown → default.
  (Op validation is strict — see §3.)
* `rank`: a JSON number (not a bool) that is finite, else `0`.
* Bools accept `true`/`false`, `1`/`0`, `"true"`/`"false"`; anything else → `false`.
* Control characters: `\r\n` → `\n`, then lone `\r` → `\n`. Single-line fields
  (everything except tasks.`notes`, requests.`notes`, notes.`body`) replace
  `\n` and `\t` with a space. All fields then delete the remaining C0 controls
  (U+0000–U+001F) and U+007F, except `\n` and `\t` in multi-line fields.
* `id` missing or not matching the id pattern → `"<prefix>-auto-<n>"` where `n`
  is the item's index in the input list and prefix is `t`/`r`/`n`.
* An item whose required text field (`title`/`item`/`body`) is empty after
  cleanup is dropped. **Then** duplicate ids are removed (first wins).
* Timestamps (`created_at`, `updated_at`, `done_at`, top-level `updated_at`,
  and an op's `ts`) are parsed with this grammar, not with `Date.parse` /
  `fromisoformat`:
  `YYYY-MM-DD` optionally followed by `[T ]HH:MM`, optional `:SS`, optional
  `.fraction`, optional zone `Z`/`z`/`±HH:MM`/`±HHMM`. A missing zone means
  **UTC**. Fields must be in range (real calendar date incl. leap years, hour
  ≤ 23, minute/second ≤ 59, offset hours ≤ 23, offset minutes ≤ 59, year
  1970–9999). Valid values are converted to canonical UTC
  `YYYY-MM-DDTHH:MM:SSZ` (fraction dropped). Invalid or missing:
  `created_at`/`updated_at` → `"1970-01-01T00:00:00Z"`; `done_at` and top-level
  `updated_at` → `""`.
* `due`: exactly `YYYY-MM-DD` and a real calendar date, else `""`.
* `link`: kept only if it starts with `http://` or `https://`, else `""`.
* `tags`: non-list → `[]`; non-string entries skipped; each entry gets
  single-line cleanup, trim, leading `#`s stripped, trim again, lower-cased,
  clamped to 24; empty ones skipped; duplicates removed (first wins); at most 8.
* At most 2000 items per collection (extras dropped after sorting).
* Finally each collection is sorted by `(rank, id)` — ids compare as plain
  ASCII strings.
* Normalization is idempotent: `normalize(normalize(x)) == normalize(x)`.

## 3. Operations

```json
{"op": "add",    "coll": "tasks", "item": { ...full item... },        "ts": "2026-10-16T14:03:22Z", "by": "Richard"}
{"op": "update", "coll": "tasks", "id": "t-k3j9x0a1qz", "set": {...}, "ts": "...", "by": "..."}
{"op": "delete", "coll": "tasks", "id": "t-k3j9x0a1qz",               "ts": "...", "by": "..."}
```

* `ts` (required): ISO UTC string. `by` (optional, ≤ 60 chars): who/which client,
  used only for commit messages.
* **Validation** (`validateOp` / `validate_op`) happens when an op enters a
  queue (Pi `POST /api/ops`, or the browser before queueing). It rejects (throws
  / returns an error string) when: `op` not one of the three; `coll` unknown;
  `ts` missing/invalid; `add` without an object `item`, or an `item` whose `id`
  fails the id pattern, or whose required text is empty after trimming;
  `update`/`delete` without a valid `id`; `update` whose `set` is not a non-empty
  object, or contains a key that is not editable for that collection, or a value
  of the wrong JSON type (string field given a non-string, `pinned` given a
  non-bool, `rank` given a bool or non-finite or non-number, `tags` given a
  non-list or a list containing non-strings), or an enum value outside its set
  (exact, lower-case match), or a non-empty `due` that isn't a real
  `YYYY-MM-DD` date, or a non-empty `done_at` that doesn't parse with the
  timestamp grammar, or a value that would make a required text field empty
  after cleanup. Over-long strings and non-http `link`s are NOT rejected — they
  are clamped/coerced on apply. Extra unknown keys inside an `add` item are fine
  (dropped on normalize).
* The op's `ts` is canonicalized with the timestamp grammar; `add` uses it as
  the default `created_at`/`updated_at`, `update` writes it to `updated_at`.
* **Editable fields** (anything else is rejected in `set`):
  * tasks: title, notes, status, priority, assignee, due, tags, rank, done_at
  * requests: item, qty, requested_by, status, notes, link, rank
  * notes: body, author, pinned, color, rank
* **Apply** (`applyOp` / `apply_op`, pure — returns a new board, never mutates
  its input):
  * `add`: normalize the item (fill defaults; `created_at`/`updated_at` default
    to the op's `ts` when missing). If an item with that id already exists → no
    change (idempotent). Else append.
  * `update`: if the id does not exist → no change (the item was deleted
    elsewhere — delete wins). Else set each field (coerced exactly like
    normalization does) and set `updated_at = ts`.
  * `delete`: remove the item if present, else no change.
  * After applying, the touched collection is re-sorted by `(rank, id)`.
  * Replaying an op that fails validation (should not happen) is a no-op.
* `applyOps(board, ops)` folds `applyOp` left to right.
* The top-level `updated_at`/`updated_by` are only set when a client writes the
  file (to the last pushed op's `ts`/`by`), never by `applyOp`.

### Ids, ranks, ordering

* New ids: `"<prefix>-" + 10 random [a-z0-9] chars` (`t-`, `r-`, `n-`).
* Ranks are floats. Order inside a task column is ascending rank.
* Placing an item between neighbours `a` and `b`: `(a + b) / 2`; at the top:
  `first - 1`; at the bottom: `last + 1`; into an empty list: `0`.
* If the gap is too small (`b - a < 1e-6`) the client re-ranks the whole target
  list to `1, 2, 3, …` in its new order and emits one `update {rank}` op per item
  whose rank changed (`planMove` in `static/js/board.js` does this).
* New tasks from quick-add go to the **top** of To do (`min rank - 1`).
* The Done column is displayed by `done_at` descending (most recent first); it is
  not manually re-orderable. Moving a task into `done` sets `done_at = ts`;
  moving it out clears `done_at` to `""`.

## 4. Pi backend (`app/`)

| module | role |
|--------|------|
| `config.py` | DEFAULTS ← `config.json` ← `LABHUB_*` env vars (see README) |
| `board.py` | pure model: constants, `normalize_board`, `normalize_item`, `validate_op`, `apply_op(s)`, `serialize_board`, `summarize_ops` (commit message) |
| `store.py` | the persisted local state (`state/remote.json`, `state/pending.json`, `state/sync.json`), a lock, a `rev` counter that bumps whenever the visible board changes |
| `github_sync.py` | stdlib-only GitHub Contents API client + the background sync thread |
| `migrate.py` | one-time import of a legacy `labhub.db` (SQLite from the old dashboard) |
| `calendar_feed.py` | published Outlook `.ics` → upcoming events |
| `main.py` | FastAPI routes; serves `static/` at `/` |

### HTTP API (local mode)

| method & path | body / query | response |
|---|---|---|
| `GET /api/config` | | `{"labhub": true, "name", "client", "theme", "github": {"enabled", "repo", "branch", "path", "pages_url", "file_url"}, "calendar": {"configured": bool}}` — **never includes the token** |
| `GET /api/board?rev=N` | `rev` optional | `{"rev", "unchanged": true, "sync"}` if `N` equals the current rev, else `{"rev", "board", "sync"}` |
| `POST /api/ops` | `{"ops": [op, …]}` (1–500 ops) | `200 {"rev", "board", "sync"}`; `400 {"error", "index"}` if any op fails validation (none are applied) |
| `GET /api/sync` | | `sync` object |
| `POST /api/sync` | | runs a sync cycle now (blocking, ≤ 20 s), returns `sync` |
| `GET /api/calendar` | | `{"configured", "events": [{"summary", "location", "start", "end", "all_day"}]}` |
| `GET /api/version` | | `{"version": "<git sha or static-files hash>"}` — the page reloads itself when this changes |

`sync` object:

```json
{
  "enabled": true,
  "state": "ok",            // off | ok | pending | syncing | offline | error
  "pending": 0,             // queued ops not yet on GitHub
  "last_sync": "2026-10-16T14:03:22Z",   // last successful contact, or null
  "last_push": "2026-10-16T14:01:10Z",   // last successful write, or null
  "last_error": null,       // human-readable message, or null
  "repo": "richard-0417/lab-hub", "branch": "data", "path": "board.json"
}
```

### Sync cycle (Pi `github_sync.py`; the browser's `GitHubSource` mirrors it)

1. `GET /repos/{repo}/contents/{path}?ref={branch}` with `If-None-Match: <etag>`.
   * `304` → remote unchanged.
   * `200` → decode base64 → parse JSON → `normalize_board` → becomes `base`
     (store `sha`, `etag`). Invalid JSON → `state=error`,
     `last_error="board.json on GitHub is not valid JSON: …"`, **do not push**.
   * `404` → check `GET /repos/{repo}`: if that is also 404 →
     `error: "repo not found, or the token can't see it"`; otherwise the file (or
     branch) doesn't exist yet → `base = empty board`, `sha = None`, and a push
     is required to create it.
   * `401` → `error: "GitHub token rejected (expired or revoked?)"`.
   * `403`/`429` → `error` mentioning rate limit / permissions (include GitHub's
     message).
   * network error / timeout → `state=offline`, keep everything.
2. If remote changed: recompute `view = apply_ops(base, pending)`; bump `rev`
   if the view differs.
3. If `pending` is non-empty, or the file doesn't exist yet, or the normalized
   remote differs from its raw parse (hand-edit needed fixing): snapshot
   `k = len(pending)`, build `doc = apply_ops(base, pending[:k])` with
   `updated_at`/`updated_by`, `PUT /repos/{repo}/contents/{path}` with
   `{"message", "content": base64(serialize(doc)), "branch", "sha"?}`.
   * `200`/`201` → `base = doc`, `sha = response.content.sha`, `etag = None`,
     drop exactly the first `k` pending ops (new ones may have arrived during the
     request), `last_push = now`.
   * `409` or `422` with a sha mismatch → drop the etag, refetch, replay, retry
     (≤ 3 attempts per cycle).
   * `404`/`422` because the branch doesn't exist → create it:
     `GET /repos/{repo}` → `default_branch`;
     `GET /repos/{repo}/git/ref/heads/{default}` → sha;
     `POST /repos/{repo}/git/refs {"ref": "refs/heads/{branch}", "sha"}`; retry.
4. Persist `state/` atomically (write temp file, `os.replace`).

Timing: the thread wakes every `sync_interval` s (default 15) or ~1 s after a
local edit (debounced so a drag-reorder burst is one commit). Requests use
headers `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`,
`X-GitHub-Api-Version: 2022-11-28`, `User-Agent: lab-hub`, timeout 15 s.

Commit messages come from `summarize_ops`: subject ≤ 72 chars like
`lab-pi: add “Order pipettes”, complete “Calibrate pump” (+2 more)`, body lists
every op on its own line.

### Legacy migration (`migrate.py`)

On startup, if `db_path` (default `labhub.db`) exists and `state/migrated`
doesn't: read the old `tasks`, `requests`, `notes` tables and enqueue `add` ops
with deterministic ids (`t-legacy-<id>`, `r-legacy-<id>`, `n-legacy-<id>`), so a
repeated import is harmless. Mapping: task `text→title`, `done→status
done/todo`; request status `done→received`; note fields map 1:1. Old naive
`created_at` values are local time → convert to UTC. Ranks follow the old
display order. Then write `state/migrated`. The `.db` file is left in place.

## 5. Frontend (`static/`)

| file | role |
|---|---|
| `index.html` | markup shell; loads `js/app.js` as an ES module; all asset URLs **relative** (works at `/` on the Pi and at `/lab-hub/` on Pages) |
| `style.css` | design tokens + layout; dark default, light theme via `html[data-theme="light"]` |
| `js/board.js` | pure model mirroring `app/board.py` (+ `planMove`, `newId`, `nowIso`) |
| `js/sources.js` | `LocalSource` (Pi API) and `GitHubSource` (GitHub API) — same interface |
| `js/quickadd.js` | parses quick-add text: `@name`, `!high`/`!low`, `#tag`, `due:…`/`^fri` |
| `js/app.js` + `js/ui/*.js` | UI: header, task board, side panels, editor, drag-and-drop, toasts, settings |

### Source interface (both sources implement it)

```js
const src = new LocalSource()            // or new GitHubSource(settings)
src.mode           // "local" | "github"
src.canEdit        // false in github mode without a token
src.subscribe(fn)  // fn({board, sync}) on every visible change; returns unsubscribe
await src.start()  // first load; then polls (local: every 3 s; github: 20 s visible / 90 s no token)
await src.submit(ops)   // validate, apply optimistically (subscribers fire at once), then persist/push
await src.syncNow()
src.stop()
```

`GitHubSource` settings: `{apiBase: "https://api.github.com", repo, branch: "data", path: "board.json", token, clientName}`.
It persists `pending` (and `base`/`sha` as a cache) in `localStorage` under
`labhub:gh:<repo>:<branch>:<path>`, so edits survive a reload while offline.

## 6. Configuration (`config.json`, all optional; env `LABHUB_<KEY>` overrides)

| key | default | meaning |
|---|---|---|
| `name` | `"Lab Hub"` | title in the header (legacy key `subgroup_name` is accepted as an alias) |
| `host` / `port` | `"0.0.0.0"` / `8000` | web server bind |
| `theme` | `"dark"` | `dark` \| `light` \| `auto` — kiosk default theme (a viewer can override in their browser) |
| `calendar_ics` | `""` | published Outlook `.ics` URL or local path; empty = calendar panel shows setup hint |
| `calendar_max_events` | `8` | |
| `github_repo` | `""` | `owner/name`, e.g. `richard-0417/lab-hub`; empty = local-only |
| `github_branch` | `"data"` | branch that holds the board file |
| `github_path` | `"board.json"` | file path on that branch |
| `github_token` | `""` | fine-grained PAT with **Contents: read & write** on that repo (prefer env `LABHUB_GITHUB_TOKEN`); never sent to browsers |
| `github_api` | `"https://api.github.com"` | override for tests (mock server) |
| `sync_interval` | `15` | seconds between pulls |
| `client_name` | `"lab-pi"` | shown in commit messages |
| `pages_url` | `""` | defaults to `https://<owner>.github.io/<repo>/` when `github_repo` is set |
| `state_dir` | `"state"` | local sync state (relative to the app folder) |
| `db_path` | `"labhub.db"` | legacy SQLite file to import once |

## 7. Code updates on the Pi

`scripts/update.sh` (run by `systemd/lab-hub-update.timer` every 5 minutes as
root, doing git work as the install user): `git fetch origin main`; if behind,
`git merge --ff-only`; reinstall deps if `requirements.txt` changed; restart
`lab-hub.service`. The open kiosk page notices the new `/api/version` within a
minute and reloads itself. Pages redeploys automatically on every push to
`main` that touches `static/`.
