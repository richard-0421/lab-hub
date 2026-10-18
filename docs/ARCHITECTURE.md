# Lab Hub — architecture & contracts

This is the source of truth for how the pieces fit. If code and this file
disagree, fix one of them in the same change.

## 1. The big picture

```
                    richard-0417/lab-hub  (public)
 ┌───────────────────────────────────────────────────────────────────┐
 │ branch main   code (app/ static/ scripts/ …) ──► Actions ──► Pages │
 │ branch data   board.json  (orphan: no shared history with main)    │
 └──┬─────────────────────────────▲─────────────────────────▲─────────┘
    │ git pull main every 5 min   │ Contents API            │ Contents API
    │ (scripts/update.sh,         │ GET/PUT, sha-checked    │ (browser's token)
    │  anonymous HTTPS)           │ (Pi's token)            │
    ▼                             │                         │
 ┌────────────────────────────────┴─┐       ┌───────────────┴──────────┐
 │ Raspberry Pi (lab)               │       │ Any browser, anywhere    │
 │ FastAPI app/ + local state/      │       │ GitHub Pages copy of     │
 │ (cache + pending op queue),      │       │ static/ in "github" mode │
 │ sync thread: pull ~15 s, push    │       │ • token in localStorage  │
 │ ~1 s after an edit; calendar     │       │ • same op queue, in JS   │
 │ Chromium kiosk ──► "local" mode  │       └──────────────────────────┘
 └──────────────────────────────────┘
```

* **One repo, two branches.** `richard-0417/lab-hub` is public (free Pages).
  `main` holds the code; the board lives on the orphan branch `data` as
  `board.json`. Every token given to the Pi or a browser is a fine-grained PAT
  with Contents: read & write on `lab-hub`. Fine-grained PATs can be limited
  by repo but not by branch, so **every board token can also push to `main`**,
  which Pages publishes and the Pi runs (§7). The owner accepted this: tokens
  go only to trusted people; the setup dialog and README say so once. The Pi
  pulls `main` anonymously.
* **Optional: a separate data repo.** Everything that names the board's repo
  (`github_repo` on the Pi, **Repository** in a browser) can point at another
  repo, e.g. a private `richard-0417/lab-hub-data`, with tokens scoped to it
  only. Then the board is private and board tokens can't touch the code. Both
  `install-pi.sh` and the browser's connect check warn (in this setup only) if
  such a token can also write the code repo.
* **One frontend, two modes.** `static/` is served by the Pi (local mode) and
  deployed unchanged to GitHub Pages (github mode). Mode detection:
  * On a `*.github.io` host the page goes straight to **github mode** without
    fetching anything.
  * Elsewhere it fetches `api/config` (relative URL; network errors and 5xx
    are retried a few times). JSON with `"labhub": true` → **local mode**,
    talking to the Pi's API. A 404 or any other non-Lab-Hub answer → github
    mode.
  * If the server is unreachable or keeps answering 5xx, the page shows a
    *Waiting for the Lab Hub server…* overlay and retries every 3 s. It never
    falls back to github mode, so a kiosk that starts before its server (or
    during a restart) doesn't land on the GitHub setup screen.
* In github mode the page talks to the GitHub REST API directly with a
  fine-grained token the user pastes once. It is stored in `localStorage` for
  the origin `https://<owner>.github.io`, which **every** Pages site of that
  account shares, and sent only to `https://api.github.com`.
* **GitHub is the meeting point.** The board lives in one JSON file
  (`board.json`) on the `data` branch. The Pages workflow only runs for `main`,
  so data commits never trigger a Pages build, and the Pi only fetches `main`,
  so they never touch the code history it pulls.
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
A `rank` that is an integral float with `|x| ≤ 2^53` is written as an int (`3`
not `3.0`; `-0` becomes `0`). Larger integral values keep the float form, in
Python's `repr` spelling (`1e+21`), and JS writes them the same way.

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
| `status`     | enum            | `todo` \| `doing` \| `done`, default `todo` (the UI labels them To do / In progress / Done) |
| `priority`   | enum            | `high` \| `normal` \| `low`, default `normal` |
| `assignee`   | string          | 0–60, default `""` |
| `due`        | string          | `""` or `YYYY-MM-DD` (valid calendar date), default `""` |
| `tags`       | list of strings | ≤ 8 tags, each 1–24 chars, leading `#`s stripped, lower-cased, de-duplicated (keep first), default `[]` |
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
  then clamp to the max length; then, if clamping cut the string, trim trailing
  whitespace again (so `"x"*299 + " y"` becomes the 299 `x`s, not 300 chars
  ending in a space; this keeps normalization idempotent). "Trim" removes
  exactly the characters JavaScript's `String.prototype.trim()` removes (Python
  uses that same set, not `str.strip()`). Lengths count **Unicode code points**
  (JS must use `Array.from(s)`, not `s.length`).
* Enums are matched leniently here (`trim().toLowerCase()`); unknown → default.
  (Op validation is strict — see §3.)
* `rank`: a JSON number (not a bool) that is finite, else `0`.
* Bools: `true`, any JSON number equal to `1`, or the string `"true"` → `true`;
  anything else (including `"TRUE"`) → `false`.
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
  1970–9999). The year must also be 1970–9999 **after** converting to UTC
  (`1970-01-01T00:30+01:00` is invalid). Valid values are converted to
  canonical UTC `YYYY-MM-DDTHH:MM:SSZ` (fraction dropped). Invalid or missing:
  `created_at`/`updated_at` → `"1970-01-01T00:00:00Z"`; `done_at` and top-level
  `updated_at` → `""`.
* `due`: exactly `YYYY-MM-DD` and a real calendar date (any 4-digit year, with
  the Gregorian leap-year rule), else `""`.
* `link`: kept only if it starts with `http://` or `https://`, else `""`.
* `tags`: non-list → `[]`; non-string entries skipped; each entry gets
  single-line cleanup and trim, then the whole leading run of `#` **and
  whitespace** is stripped in one pass (`"# # x"` → `"x"`, which a separate
  "strip `#`s, then trim" would leave as `"# x"`); then lower-cased, clamped to
  24, trimmed again; empty ones skipped; duplicates removed (first wins); at
  most 8.
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
  used only for commit messages. A client fills a missing `by` with its own
  client name; the shared kiosk never remembers a person, so its ops carry the
  Pi's `client_name`.
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
* The op's `ts` is canonicalized with the timestamp grammar; `add` uses it for
  `created_at`/`updated_at` when the item's own value is missing **or
  invalid**; `update` writes it to `updated_at`.
* **Editable fields** (anything else is rejected in `set`):
  * tasks: title, notes, status, priority, assignee, due, tags, rank, done_at
  * requests: item, qty, requested_by, status, notes, link, rank
  * notes: body, author, pinned, color, rank
* **Apply** (`applyOp` / `apply_op`, pure — returns a new board, never mutates
  its input):
  * `add`: normalize the item (fill defaults; timestamps as above). If an item
    with that id already exists → no change (idempotent). If the collection
    already holds 2000 items → no change (appending would only push a file that
    normalization truncates, silently dropping whichever item sorts last).
    Else append.
  * `update`: if the id does not exist → no change (the item was deleted
    elsewhere — delete wins). Else set each field (coerced exactly like
    normalization does) and set `updated_at = ts`.
  * `delete`: remove the item if present, else no change.
  * After applying, the touched collection is re-sorted by `(rank, id)`.
  * Replaying an op that fails validation (should not happen) is a no-op.
* `applyOps(board, ops)` folds `applyOp` left to right.
* The top-level `updated_at`/`updated_by` are only set when a client writes the
  file, never by `applyOp`: `updated_at` = the `ts` of the last op in that push
  (or now), `updated_by` = the writing client's name (the Pi's `client_name`,
  or the browser's client name, else `"web"`).

### Ids, ranks, ordering

* New ids: `"<prefix>-" + 10 random [a-z0-9] chars` (`t-`, `r-`, `n-`).
* Ranks are floats. Order inside a task column is ascending rank.
* Placing an item between neighbours `a` and `b`: `(a + b) / 2`; at the top:
  `first - 1`; at the bottom: `last + 1`; into an empty list: `0`.
* `planMove` (`static/js/board.js`) re-ranks the whole target list to
  `1, 2, 3, …` in its new order, emitting one `update {rank}` op per item whose
  rank changed, when the computed rank doesn't fit: the gap is too small
  (`b - a < 1e-6`), or the result is not strictly between its neighbours or not
  finite (e.g. float precision ran out, so `first - 1 == first`).
* New tasks from quick-add go to the **top** of To do (`min rank - 1`).
* The Done column is displayed by `done_at` descending (most recent first); it is
  not manually re-orderable. Moving a task into `done` sets `done_at = ts`;
  moving it out clears `done_at` to `""` and puts it at the top of its new
  column (one `update` op with `status`, `done_at` and `rank`).

## 4. Pi backend (`app/`)

| module | role |
|--------|------|
| `config.py` | DEFAULTS ← `config.json` (or `$LABHUB_CONFIG`) ← `LABHUB_*` env vars (see §6) |
| `board.py` | pure model: constants, `normalize_board`, `normalize_item`, `validate_op`, `apply_op(s)`, `serialize_board`, `summarize_ops` (commit message) |
| `store.py` | the persisted local state under `state/` (below), a lock, a `rev` counter that bumps whenever the visible board changes (persisted, so a restart never reuses a rev) |
| `github_sync.py` | stdlib-only GitHub Contents API client + the background sync thread |
| `migrate.py` | one-time import of a legacy `labhub.db` (SQLite from the old dashboard) |
| `calendar_feed.py` | published Outlook `.ics` → upcoming events |
| `main.py` | FastAPI routes; serves `static/` at `/`; the request guard |

`state/` files (each written atomically, temp file + `os.replace`; when several
change together: queue first, board second, `sync.json` last, so a crash can
only leave duplicate ops, which are harmless, never lost ones):
`remote.json` (`base`, the last board seen on GitHub; in local-only mode the
board itself), `pending.json` (queued ops, at most 5000), `sync.json` (sha,
etag, timestamps, state, rev, a record of an unanswered push…), `snapshot.json`
(only while sync is switched off after having been on: the last GitHub board,
so switching back on replays exactly the local changes) and `migrated`.

**Request guard.** Anyone on the LAN may use the API without logging in, but
other web sites may not: a request whose `Host` is not `localhost`/`*.localhost`,
an IP address, this machine's hostname (or `<hostname>.local`) or an
`allowed_hosts` entry gets 400 (stops DNS rebinding); a `POST`/`PUT`/`PATCH`/
`DELETE` to `/api/*` that the browser marks as cross-site (`Sec-Fetch-Site:
cross-site|same-site`, or an `Origin` other than this server) gets 403.

### HTTP API (local mode)

| method & path | body / query | response |
|---|---|---|
| `GET /api/config` | | `{"labhub": true, "name", "client", "theme", "github": {"enabled", "repo", "branch", "path", "pages_url", "file_url", "last_error"}, "calendar": {"configured": bool}, "lan_url"}`. **Never includes the token.** `github.enabled` is true only when repo and token are set and `github_repo`/`github_branch`/`github_path` are valid (§6); `github.last_error` explains an invalid one (e.g. `config: github_branch 'x..y' is not a valid branch name`), else `null`; `file_url` = `https://github.com/<repo>/blob/<branch>/<path>`, or `""` when that config error is set; `lan_url` = `http://<LAN IPv4>:<port>` for teammates (the kiosk itself runs on localhost and shows it in its footer), or `null` when the server is bound to loopback or has no LAN address |
| `GET /api/board?rev=N` | `rev` optional | `{"rev", "unchanged": true, "sync"}` if `N` equals the current rev, else `{"rev", "board", "sync"}` |
| `POST /api/ops` | `{"ops": [op, …]}` (1–500 ops), `Content-Type: application/json`, body ≤ 2 MiB | `200 {"rev", "board", "sync"}`; `400 {"error", "index"}` if any op fails validation or an `add` would go past 2000 items (none are applied; `index` is `null` for request-level errors); `413` body too large; `415` not JSON; `503` the change couldn't be saved or 5000 ops are already queued. All errors are `{"error", "index"}` |
| `GET /api/sync` | | `sync` object |
| `POST /api/sync` | | runs a sync cycle now and returns `sync`: it waits ≤ 20 s for a cycle that is already running, then runs its own, which is bounded only by the per-request timeouts (15 s each, up to 3 PUT attempts plus branch creation). Clients should allow ≥ 2 min (`install-pi.sh` does) |
| `GET /api/calendar` | | `{"configured", "events": [{"summary", "location", "start", "end", "all_day"}]}`. Times are naive local ISO strings. `end` is always set: `DTEND`, else `DTSTART + DURATION`, else start + 1 day for an all-day (`DATE`) event, else the start (an end before the start, or equal to it for an all-day event, counts as missing). An event is listed while `start ≥ now − 3 h` or `end > now` |
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

`syncing` is also reported before the first cycle has finished. While `state`
is `off`, `last_error` is the config error from §6 (or `null`); it is kept in
memory only, never in `state/sync.json`.

### Sync cycle (Pi `github_sync.py`; the browser's `GitHubSource` mirrors it)

1. `GET /repos/{repo}/contents/{path}?ref={branch}` with `If-None-Match: <etag>`.
   * `304` → remote unchanged.
   * `200` → decode base64 → parse JSON → `normalize_board` → becomes `base`
     (store `sha`, `etag`). Invalid JSON → `state=error`,
     `last_error="board.json on GitHub is not valid JSON: …"`, **do not push**.
     Files over 1 MB come back without content and are read through
     `GET /repos/{repo}/git/blobs/{sha}`.
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
   remote differs from its raw parse (hand-edit needed fixing; key order and
   `3` vs `3.0` don't count as differences): snapshot `k = len(pending)`, build
   `doc = apply_ops(base, pending[:k])` with `updated_at`/`updated_by`. If that
   would not change the file, drop the `k` ops without a commit. Otherwise
   `PUT /repos/{repo}/contents/{path}` with
   `{"message", "content": base64(serialize(doc)), "branch", "sha"?}`.
   * `200`/`201` → `base = doc`, `sha = response.content.sha`, `etag = None`,
     drop exactly the first `k` pending ops (new ones may have arrived during the
     request), `last_push = now`.
   * `409` or `422` with a sha mismatch → drop the etag, refetch, replay, retry
     (≤ 3 attempts per cycle).
   * No usable answer (timeout, dropped connection, 5xx): GitHub may have
     committed it anyway. Before each PUT the Pi records the parent sha and the
     git blob sha of the bytes it sends; it then refetches (now, and again at
     the start of the next cycle): remote sha = our blob → it landed (drop the
     `k` ops); remote sha = the parent → it didn't (send again); otherwise the
     file's last 10 commits decide. So an old push is never replayed over
     edits other people made since.
   * `404`/`422` whose message says the branch was not found → create it as an
     **orphan** (both clients, at most once per cycle):
     `POST /repos/{repo}/git/trees {"tree": [{"path", "mode": "100644", "type": "blob", "content": <empty board>}]}`
     (no `base_tree`) → `POST /repos/{repo}/git/commits {"message": "<client>: create <path>…", "tree", "parents": []}`
     → `POST /repos/{repo}/git/refs {"ref": "refs/heads/{branch}", "sha"}`;
     then refetch, replay and PUT with the new file's sha. A `422 Reference
     already exists` means someone else just created it: carry on with theirs.
     The Git database API answers `409` on a repo with no commits at all →
     `error: "the GitHub repo has no commits yet - push the Lab Hub code to it
     first, then the '<branch>' branch is created on the next sync"`. The setup
     pushes a prepared orphan `data` branch first, so this is only a fallback.
     Any other `404` on PUT is a token-permission error; any other `422` is
     reported as GitHub's message.
4. Persist `state/` atomically (write temp file, `os.replace`).

Timing: the thread wakes every `sync_interval` s (default 15) or ~1 s after a
local edit (debounced so a drag-reorder burst is one commit). After failures it
backs off (doubling, at most 5 min); a local edit or `POST /api/sync` cuts the
wait short. Requests use headers `Authorization: Bearer <token>`,
`Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`,
`User-Agent: lab-hub`, timeout 15 s.

Commit messages come from `summarize_ops` / `summarizeOps` (identical output):

* Subject ≤ 72 chars: `<client>: ` then as many op descriptions as fit, then
  `(+N more)`, e.g. `lab-pi: add “Order pipettes”, complete “Calibrate pump” (+2 more)`.
  Verbs: `add`, `complete` (task status → done), `reopen` (task out of done),
  `move` (only `rank` changed), `edit`, `delete`. Requests and notes get a noun:
  `add request “…”`, `delete note “…”`. A batch of only moves becomes
  `<client>: reorder N tasks` (or `requests` / `notes` / `items`).
* Body: one line per op (`- <verb> <task|request|note> <id> “<title>” [fields] (by <name>)`),
  at most 200 lines, then `- … and N more`.

### Legacy migration (`migrate.py`)

On startup, if `db_path` (default `labhub.db`) exists and `state/migrated`
doesn't: read the old `tasks`, `requests`, `notes` tables and enqueue `add` ops
with deterministic ids (`t-legacy-<id>`, `r-legacy-<id>`, `n-legacy-<id>`).
Fixed ids make a repeat a no-op only for items that still exist; an `add`
would bring back an item deleted since. So in GitHub mode the sync worker
drops these queued adds when the board on GitHub already holds any legacy
item (a fresh `state/` with the same `labhub.db` then imports nothing). Only
if every legacy item has been deleted on GitHub would they be imported again.
Mapping: task `text→title`, `done→status done/todo`;
request status `done→received`; note fields map 1:1. Old naive `created_at`
values are local time → convert to UTC. Ranks follow the old display order.
Then write `state/migrated`. The `.db` file is opened read-only.

## 5. Frontend (`static/`)

| file | role |
|---|---|
| `index.html` | markup shell; loads `js/app.js` as an ES module; all asset URLs **relative** (works at `/` on the Pi and at `/lab-hub/` on Pages) |
| `style.css` | design tokens + layout; dark default, light theme via `html[data-theme="light"]` |
| `js/board.js` | pure model mirroring `app/board.py` (+ `planMove`, `newId`, `nowIso`) |
| `js/sources.js` | `LocalSource` (Pi API) and `GitHubSource` (GitHub API) — same interface — plus `detectMode` and the GitHub settings helpers |
| `js/quickadd.js` | parses quick-add text: `@name`, `!high`/`!low`, `#tag`, `due:…`/`^fri` |
| `js/app.js` + `js/ui/*.js` | UI: header, task board, side panels, editor, drag-and-drop, toasts, settings, the waiting overlay; `ui/lifecycle.js` decides when a version reload is safe |

### Source interface (both sources implement it)

```js
const src = new LocalSource()            // or new GitHubSource(settings)
src.mode           // "local" | "github"
src.canEdit        // false in github mode without a token
src.board, src.sync  // current snapshot
src.subscribe(fn)  // fn({board, sync}) on every visible change (at once if a board is known); returns unsubscribe
await src.start()  // first load (never throws on network errors); then polls (local: every 3 s; github: 20 s visible, 90 s hidden or without a token)
await src.submit(ops)   // validate, apply optimistically (subscribers fire at once), then persist/push
await src.syncNow()
src.stop()
```

Both sources refuse (reject `submit`, queue nothing) a batch whose `add`s would
push a collection past 2000 items, with the Pi's exact message `board full:
<coll> already has 2000 items - delete some first (e.g. clear done tasks)`
(`checkRoom` in `board.js`); `applyOp` treats an `add` into a full collection
as a no-op on both sides.

`LocalSource` also has `unsent` (ops only in this page's outbox) and `flush()`
(push the outbox without `api/sync`; never rejects). It posts the outbox in
batches of ≤ 500 ops and ≈ 1 MiB. Answers `400`, `403`, `413` and `415` from
`POST api/ops` are permanent: the op named by `index` (else the batch) is
dropped, the board reloaded and `submit` rejects with the server's text. `503`
and network errors keep the ops and retry. Before a version reload the kiosk
page flushes and re-checks (`ui/lifecycle.js`), and it waits while a dialog is
open, a card is being dragged, a field holds unsent text, or someone touched
the page in the last 45 s (after 10 idle minutes a dialog or draft no longer
blocks).

Both sources' `sync` objects add `mode`, `canEdit`, `link` and `loaded` (a
real board has been received or restored from cache) to the fields of §4.
`LocalSource` passes the Pi's object through (its `pending` also counts the
page's own unsent outbox; it reports `offline` with *Can't reach the dashboard
server* when the Pi is unreachable). `GitHubSource` adds `file_url` and uses
the states `syncing`, `ok`, `pending`, `offline`, `error` and **`readonly`**
(no token: the board is shown, nothing can be queued).

`GitHubSource` settings: `{apiBase: "https://api.github.com", repo, branch: "data", path: "board.json", token, clientName}`.

* Saved settings (`localStorage["labhub:github"]`) always win. Without them,
  defaults come from the page URL: `?repo=`, `?branch=`, `?path=` pre-fill a
  first connect only; an unusable branch or path is ignored. Without `?repo=`
  the default repo is `<owner>/<first path segment>` of the page URL (root site:
  `<owner>/<owner>.github.io`; elsewhere `richard-0417/lab-hub`), i.e. the same
  repo as the code, branch `data`, file `board.json`. Only the optional
  separate-data-repo setup needs `?repo=` in shared links. `?api=` (a mock server) is honoured only
  on a local development page (`localhost`, `127.0.0.1`, `[::1]`,
  `*.localhost`); on any other host the token only ever goes to
  `https://api.github.com`.
* It persists `pending` (and `base`/`sha` as a cache) in `localStorage` under
  `labhub:gh:<repo>:<branch>:<path>`, so edits survive a reload while offline.
  Tabs of one browser share that key and merge their queues instead of
  overwriting each other's.
* Without a token it is read-only and reads the file from
  `https://raw.githubusercontent.com/<repo>/<branch>/<path>` (falling back to
  the API if that fails). That doesn't use the API's 60 requests/hour per-IP
  quota, but GitHub's CDN caches it for up to 5 minutes, and it only works for
  a public repo.
* `testGitHubSettings(settings, fetchImpl, loc)` (the connect dialog's check)
  returns `{ok, error, canWrite, private, warnings}`. With a token it proves
  write access with `POST /repos/<repo>/git/blobs` of one constant blob (no
  ref, file or history changes): `201` → `canWrite: true`; `403`/`404` →
  `false` (the dialog then asks for *Connect anyway*); anything else → `null`
  (connects, with a note). `warnings` is non-empty only in the two-repo setup,
  when the token can also write the code repo the page is served from.
* The connect dialog shows the trust note once (one-repo setup only), says the
  token is stored for `<owner>.github.io` and readable by any page there,
  validates repo/branch/path inline (`githubSettingsError`), and shows the
  **API base** field only on local development pages (`customApiAllowed`).
* Extras over the Pi's cycle: for 15 s after its own write it ignores a GET
  that still returns the old sha; a batch that wouldn't change the file makes
  no commit; on a rate limit it waits until `x-ratelimit-reset` /
  `retry-after`; repeated failures back off (at most 5 min); queued edits are
  pushed at once when the page is hidden or closed.

## 6. Configuration (`config.json`, all optional; env `LABHUB_<KEY>` overrides)

| key | default | meaning |
|---|---|---|
| `name` | `"Lab Hub"` | title in the header (legacy key `subgroup_name` is accepted as an alias) |
| `host` / `port` | `"0.0.0.0"` / `8000` | web server bind. Keep these in `config.json`: `run.sh`, `kiosk.sh`, `install-pi.sh` and `Start Lab Hub.command` all read them through `python -m app.config host port`; `/etc/default/lab-hub` is read only by the service |
| `theme` | `"dark"` | `dark` \| `light` \| `auto` — kiosk default theme (a viewer can override in their browser) |
| `calendar_ics` | `""` | published Outlook `.ics` URL or local path; empty = calendar panel shows setup hint |
| `calendar_max_events` | `8` | |
| `github_repo` | `""` | `owner/name` of the repo holding the board, normally `richard-0417/lab-hub` (the installer's default and `config.example.json`); empty = local-only |
| `github_branch` | `"data"` | branch that holds the board file |
| `github_path` | `"board.json"` | file path on that branch |
| `github_token` | `""` | fine-grained PAT with **Contents: read & write** on that repo (prefer env `LABHUB_GITHUB_TOKEN`); never sent to browsers |
| `github_api` | `"https://api.github.com"` | override for tests (mock server) |
| `sync_interval` | `15` | seconds between pulls |
| `client_name` | `"lab-pi"` | shown in commit messages and as `by` of kiosk edits |
| `pages_url` | `""` | the "Edit from anywhere" link. If empty it is derived: the Pages site of the code repo (`https://<owner>.github.io/<name>/` of the checkout's git `origin`, or of `github_repo` when there is no GitHub origin), plus `?repo=<github_repo>` when the board lives in another repo. `install-pi.sh` stores that same value explicitly (and keeps a hand-set one) |
| `state_dir` | `"state"` | local sync state (relative to the app folder) |
| `db_path` | `"labhub.db"` | legacy SQLite file to import once |
| `allowed_hosts` | `""` | extra host names browsers may use to reach the server (besides localhost, IP addresses and this machine's hostname / `<hostname>.local`): a JSON list, or a comma-separated string (`LABHUB_ALLOWED_HOSTS`). A leading `.` allows every subdomain; `"*"` turns the Host check off |

`github_repo` must be `owner/name` of `[A-Za-z0-9._-]` with no `.`/`..`
part; `github_branch` and `github_path` must be `/`-joined parts of
`[A-Za-z0-9._-]` with no empty, `.` or `..` part, and a branch also may not
contain `..`, have a part starting with `.`, or end with `.lock` or `.`. An
invalid value turns GitHub sync off (one WARNING in the log, the reason in
`github.last_error` / `last_error`); the server still starts.

Environment-only settings: `LABHUB_CONFIG` (path of the config file to read
instead of `config.json`) and `LABHUB_LOG_LEVEL` (level of the `labhub`
logger, e.g. `DEBUG`).

## 7. Code updates on the Pi

`systemd/lab-hub-update.timer` starts `lab-hub-update.service` 2 min after
boot, 2 min after the timer is (re)started (e.g. by `install-pi.sh`), and then
every 5 min. The service runs **as root** a root-owned copy of the updater,
`/usr/local/lib/lab-hub/update.sh`, which `scripts/install-pi.sh` installs from
`scripts/update.sh`; `LABHUB_APP_DIR` names the checkout and `LABHUB_USER` the
install user. It never runs the checkout's own copy.

`update.sh` does all git and pip work as the install user:

* `git fetch origin main` (anonymous HTTPS; the Pi needs no GitHub login).
* Exits 0 without changing anything when: the checkout isn't on `main`; the
  fetch fails (offline); `HEAD` already equals `origin/main` (it still retries
  a failed dependency install); tracked files were edited locally; local `main`
  is ahead of GitHub. Exits 1 when the histories have diverged or the merge
  fails.
* `git merge --ff-only`; reinstall deps into `.venv` if `requirements.txt`
  changed (tracked with a `.venv/.labhub-requirements` stamp so a failed
  install is retried); restart `lab-hub.service`.
* If the merge changed `systemd/` or `scripts/update.sh`, it only logs that
  `./scripts/install-pi.sh` must be re-run. It never installs units into
  `/etc/systemd/system` and never runs pulled code as root.

The server itself runs the pulled code as the install user (who on Raspberry
Pi OS has sudo). In the one-repo setup every board token can push to `main`
(§1), so the protection is giving tokens only to trusted people; the optional
separate data repo, or a ruleset that requires pull requests on `main`
(README › Security & privacy), removes that. The open kiosk page notices the new `/api/version`
within a minute and reloads itself. Pages redeploys automatically on every push
to `main` that touches `static/` (the workflow uses Node 24 action majors:
`checkout@v5`, `configure-pages@v6`, `upload-pages-artifact@v5`,
`deploy-pages@v5`).
