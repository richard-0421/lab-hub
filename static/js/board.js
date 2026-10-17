// Lab Hub board model — pure ES module, no DOM, no I/O.
//
// Mirrors app/board.py exactly (docs/ARCHITECTURE.md §2–3). Both sides must
// pass every case in tests/ops_vectors.json. Boards are treated as immutable:
// nothing here mutates its arguments, and functions may share unchanged items
// between the input and the output board.

// ---------------------------------------------------------------- constants

export const COLLECTIONS = Object.freeze(["tasks", "requests", "notes"]);
export const TASK_STATUSES = Object.freeze(["todo", "doing", "done"]);
export const PRIORITIES = Object.freeze(["high", "normal", "low"]);
export const REQUEST_STATUSES = Object.freeze(["new", "ordered", "received"]);
export const NOTE_COLORS = Object.freeze(["yellow", "blue", "green", "pink", "purple"]);
export const ID_PREFIX = Object.freeze({ tasks: "t", requests: "r", notes: "n" });
export const OP_TYPES = Object.freeze(["add", "update", "delete"]);

/** Fields an `update` op may set, per collection. */
export const EDITABLE = Object.freeze({
  tasks: Object.freeze(["title", "notes", "status", "priority", "assignee", "due", "tags", "rank", "done_at"]),
  requests: Object.freeze(["item", "qty", "requested_by", "status", "notes", "link", "rank"]),
  notes: Object.freeze(["body", "author", "pinned", "color", "rank"]),
});

/** The required (non-empty) text field of each collection. */
export const REQUIRED_FIELD = Object.freeze({ tasks: "title", requests: "item", notes: "body" });

/** Size limits. Lengths are in Unicode code points. */
export const LIMITS = Object.freeze({
  maxItems: 2000, // per collection
  maxTags: 8,
  tagLength: 24,
  by: 60, // op.by and the top-level updated_by
  maxOpsPerPost: 500, // POST /api/ops
  idLength: 64,
  fields: Object.freeze({
    tasks: Object.freeze({ title: 300, notes: 4000, assignee: 60, created_by: 60 }),
    requests: Object.freeze({ item: 300, qty: 40, requested_by: 60, notes: 2000, link: 500 }),
    notes: Object.freeze({ body: 2000, author: 60 }),
  }),
});

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const EPOCH = "1970-01-01T00:00:00Z";

// Field specs, in serialization order.
const FIELD_SPECS = {
  tasks: {
    id: { type: "id" },
    title: { type: "str", max: 300 },
    notes: { type: "str", max: 4000, multiline: true },
    status: { type: "enum", values: TASK_STATUSES, def: "todo" },
    priority: { type: "enum", values: PRIORITIES, def: "normal" },
    assignee: { type: "str", max: 60 },
    due: { type: "date" },
    tags: { type: "tags" },
    rank: { type: "rank" },
    created_at: { type: "ts" },
    updated_at: { type: "ts" },
    done_at: { type: "tsopt" },
    created_by: { type: "str", max: 60 },
  },
  requests: {
    id: { type: "id" },
    item: { type: "str", max: 300 },
    qty: { type: "str", max: 40 },
    requested_by: { type: "str", max: 60 },
    status: { type: "enum", values: REQUEST_STATUSES, def: "new" },
    notes: { type: "str", max: 2000, multiline: true },
    link: { type: "link", max: 500 },
    rank: { type: "rank" },
    created_at: { type: "ts" },
    updated_at: { type: "ts" },
  },
  notes: {
    id: { type: "id" },
    body: { type: "str", max: 2000, multiline: true },
    author: { type: "str", max: 60 },
    pinned: { type: "bool" },
    color: { type: "enum", values: NOTE_COLORS, def: "yellow" },
    rank: { type: "rank" },
    created_at: { type: "ts" },
    updated_at: { type: "ts" },
  },
};

/** Item key order per collection (as serialized). */
export const FIELD_ORDER = Object.freeze({
  tasks: Object.freeze(Object.keys(FIELD_SPECS.tasks)),
  requests: Object.freeze(Object.keys(FIELD_SPECS.requests)),
  notes: Object.freeze(Object.keys(FIELD_SPECS.notes)),
});

const TOP_KEYS = ["schema", "updated_at", "updated_by", "tasks", "requests", "notes"];

// ------------------------------------------------------------ small helpers

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Whitespace = exactly what String.prototype.trim() removes (app/board.py's
// js_trim uses the same set).
function strip(s) {
  return s.trim();
}

/** Length in Unicode code points. */
export function codePointLength(s) {
  let n = 0;
  for (const _ of s) n++; // eslint-disable-line no-unused-vars
  return n;
}

function clampCodePoints(s, max) {
  if (s.length <= max) return s; // UTF-16 length >= code point count
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  return cps.slice(0, max).join("");
}

// Control-character cleanup (§2): CRLF/CR -> LF; single-line fields turn LF and
// TAB into spaces; then remaining C0 controls and DEL are deleted (multi-line
// fields keep LF and TAB).
function cleanControls(s, multiline) {
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (multiline) return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  return s.replace(/[\n\t]/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * Full string coercion used by normalization and update ops:
 * non-string -> ""; control cleanup; trim; clamp to `max` code points.
 * (Trailing whitespace exposed by the clamp is trimmed too, which keeps
 * normalization idempotent.)
 */
export function cleanString(value, max, multiline = false) {
  if (typeof value !== "string") return "";
  let s = strip(cleanControls(value, multiline));
  if (max != null && s.length > max) {
    s = clampCodePoints(s, max).trimEnd();
  }
  return s;
}

function cleanTags(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    // cleanup + trim, then drop any leading run of '#' and whitespace (the
    // idempotent form of "trim, strip leading #s, trim again"), lower-case,
    // clamp, trim.
    let t = cleanString(raw, null, false).replace(/^[#\s]+/, "").toLowerCase();
    t = clampCodePoints(t, LIMITS.tagLength).trim();
    if (!t || out.includes(t)) continue;
    out.push(t);
    if (out.length >= LIMITS.maxTags) break;
  }
  return out;
}

function coerceBool(v) {
  return v === true || v === 1 || v === "true";
}

function coerceRank(v) {
  // -0 becomes 0 (Python writes int(-0.0) == 0; keeps normalize idempotent).
  return typeof v === "number" && Number.isFinite(v) && v !== 0 ? v : 0;
}

function coerceEnum(v, values, def) {
  if (typeof v !== "string") return def;
  const s = strip(v).toLowerCase();
  return values.includes(s) ? s : def;
}

// ---------------------------------------------------------- dates and times

const pad2 = (n) => String(n).padStart(2, "0");
const pad4 = (n) => String(n).padStart(4, "0");

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function validYMD(y, m, d) {
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for exactly `YYYY-MM-DD` naming a real calendar date. */
export function isValidDate(value) {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value);
  return !!m && validYMD(+m[1], +m[2], +m[3]);
}

// YYYY-MM-DD, optionally [T ]HH:MM, optional :SS, optional .fraction, optional
// zone Z/z/±HH:MM/±HHMM. A missing zone means UTC.
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:([Zz])|([+-])(\d{2}):?(\d{2}))?)?$/;

/**
 * Parse a timestamp with the contract grammar (NOT Date.parse) and return the
 * canonical UTC form `YYYY-MM-DDTHH:MM:SSZ`, or null when invalid/missing.
 */
export function canonicalTimestamp(value) {
  if (typeof value !== "string") return null;
  const m = TS_RE.exec(value);
  if (!m) return null;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  const hh = m[4] === undefined ? 0 : +m[4];
  const mi = m[5] === undefined ? 0 : +m[5];
  const ss = m[6] === undefined ? 0 : +m[6];
  if (y < 1970 || y > 9999 || !validYMD(y, mo, d)) return null;
  if (hh > 23 || mi > 59 || ss > 59) return null;
  let offsetMin = 0;
  if (m[9] !== undefined) {
    const oh = +m[10];
    const om = +m[11];
    if (oh > 23 || om > 59) return null;
    offsetMin = (m[9] === "-" ? -1 : 1) * (oh * 60 + om);
  }
  const ms = Date.UTC(y, mo - 1, d, hh, mi, ss) - offsetMin * 60000;
  const t = new Date(ms);
  const uy = t.getUTCFullYear();
  if (uy < 1970 || uy > 9999) return null;
  return (
    `${pad4(uy)}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}` +
    `T${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}:${pad2(t.getUTCSeconds())}Z`
  );
}

/** Current time as canonical UTC `YYYY-MM-DDTHH:MM:SSZ`. */
export function nowIso() {
  return new Date().toISOString().slice(0, 19) + "Z";
}

// ---------------------------------------------------------------------- ids

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/** `prefix + "-" + 10 random [a-z0-9]` using crypto.getRandomValues. */
export function newId(prefix) {
  const out = [];
  const buf = new Uint8Array(16);
  while (out.length < 10) {
    globalThis.crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < 252 && out.length < 10) out.push(ID_CHARS[b % 36]); // 252 = 36*7, unbiased
    }
  }
  return `${prefix}-${out.join("")}`;
}

// ------------------------------------------------------------ normalization

/** A fresh, empty, normalized board. */
export function emptyBoard() {
  return { schema: 1, updated_at: "", updated_by: "", tasks: [], requests: [], notes: [] };
}

function compareItems(a, b) {
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function sortItems(list) {
  return list.slice().sort(compareItems);
}

// Coerce one (non-id) field value exactly like normalization does.
function coerceField(spec, v, tsDefault) {
  switch (spec.type) {
    case "str":
      return cleanString(v, spec.max, !!spec.multiline);
    case "link": {
      const s = cleanString(v, spec.max, false);
      return s.startsWith("http://") || s.startsWith("https://") ? s : "";
    }
    case "enum":
      return coerceEnum(v, spec.values, spec.def);
    case "date":
      return isValidDate(v) ? v : "";
    case "tags":
      return cleanTags(v);
    case "rank":
      return coerceRank(v);
    case "bool":
      return coerceBool(v);
    case "ts":
      return canonicalTimestamp(v) || tsDefault || EPOCH;
    case "tsopt":
      return canonicalTimestamp(v) || "";
    default:
      return v;
  }
}

/**
 * Normalize one item of `coll`. Returns a new object with every field in
 * order, or null when `raw` is not an object or its required text is empty.
 * `index` is used for the auto id; `defaultTs` (optional, canonical) replaces
 * the epoch default of created_at/updated_at (used by `add` ops).
 */
export function normalizeItem(coll, raw, index = 0, defaultTs = null) {
  const specs = FIELD_SPECS[coll];
  if (!specs || !isPlainObject(raw)) return null;
  const out = {};
  for (const field of Object.keys(specs)) {
    const v = hasOwn(raw, field) ? raw[field] : undefined;
    if (field === "id") out.id = typeof v === "string" && ID_RE.test(v) ? v : `${ID_PREFIX[coll]}-auto-${index}`;
    else out[field] = coerceField(specs[field], v, defaultTs);
  }
  if (out[REQUIRED_FIELD[coll]] === "") return null;
  return out;
}

function normalizeCollection(coll, list) {
  if (!Array.isArray(list)) return [];
  const items = [];
  const seen = new Set();
  list.forEach((raw, index) => {
    const item = normalizeItem(coll, raw, index);
    if (!item || seen.has(item.id)) return;
    seen.add(item.id);
    items.push(item);
  });
  items.sort(compareItems);
  if (items.length > LIMITS.maxItems) items.length = LIMITS.maxItems;
  return items;
}

/** Normalize any parsed JSON value into a valid board (see §2). */
export function normalizeBoard(doc) {
  if (!isPlainObject(doc)) return emptyBoard();
  return {
    schema: 1,
    updated_at: canonicalTimestamp(doc.updated_at) || "",
    updated_by: cleanString(doc.updated_by, LIMITS.by, false),
    tasks: normalizeCollection("tasks", doc.tasks),
    requests: normalizeCollection("requests", doc.requests),
    notes: normalizeCollection("notes", doc.notes),
  };
}

// --------------------------------------------------------------- operations

function requiredTextOk(coll, value) {
  return cleanString(value, null, !!FIELD_SPECS[coll][REQUIRED_FIELD[coll]].multiline) !== "";
}

function validateSetValue(coll, field, value) {
  const spec = FIELD_SPECS[coll][field];
  switch (spec.type) {
    case "str":
    case "link":
      if (typeof value !== "string") return `"${field}" must be a string`;
      if (field === REQUIRED_FIELD[coll] && !requiredTextOk(coll, value)) return `"${field}" must not be empty`;
      return null;
    case "enum":
      if (typeof value !== "string") return `"${field}" must be a string`;
      if (!spec.values.includes(value)) return `"${field}" must be one of ${spec.values.join(", ")}`;
      return null;
    case "date":
      if (typeof value !== "string") return `"${field}" must be a string`;
      if (value !== "" && !isValidDate(value)) return `"${field}" must be "" or a real YYYY-MM-DD date`;
      return null;
    case "tsopt":
      if (typeof value !== "string") return `"${field}" must be a string`;
      if (value !== "" && !canonicalTimestamp(value)) return `"${field}" must be "" or an ISO timestamp`;
      return null;
    case "tags":
      if (!Array.isArray(value) || value.some((t) => typeof t !== "string")) return `"${field}" must be a list of strings`;
      return null;
    case "rank":
      if (typeof value !== "number" || !Number.isFinite(value)) return `"${field}" must be a finite number`;
      return null;
    case "bool":
      if (typeof value !== "boolean") return `"${field}" must be true or false`;
      return null;
    default:
      return `"${field}" is not editable`;
  }
}

/** Validate an op. Returns null when valid, else a human-readable error. */
export function validateOp(op) {
  if (!isPlainObject(op)) return "op must be an object";
  if (!OP_TYPES.includes(op.op)) return `unknown op ${JSON.stringify(op.op ?? null)}`;
  if (typeof op.coll !== "string" || !COLLECTIONS.includes(op.coll)) {
    return `unknown collection ${JSON.stringify(op.coll ?? null)}`;
  }
  if (!hasOwn(op, "ts") || !canonicalTimestamp(op.ts)) return "missing or invalid ts";
  const coll = op.coll;
  if (op.op === "add") {
    if (!isPlainObject(op.item)) return "add needs an object item";
    if (typeof op.item.id !== "string" || !ID_RE.test(op.item.id)) return "add item needs a valid id";
    const req = REQUIRED_FIELD[coll];
    if (!requiredTextOk(coll, op.item[req])) return `add item needs a non-empty "${req}"`;
    return null;
  }
  if (typeof op.id !== "string" || !ID_RE.test(op.id)) return `${op.op} needs a valid id`;
  if (op.op === "delete") return null;
  if (!isPlainObject(op.set)) return "update needs a non-empty set object";
  const keys = Object.keys(op.set);
  if (keys.length === 0) return "update needs a non-empty set object";
  for (const key of keys) {
    if (!EDITABLE[coll].includes(key)) return `"${key}" is not editable in ${coll}`;
    const err = validateSetValue(coll, key, op.set[key]);
    if (err) return err;
  }
  return null;
}

/**
 * Apply one op to a board. Pure: never mutates `board`. Invalid ops and ops
 * that change nothing return `board` itself; otherwise a new board object.
 */
export function applyOp(board, op) {
  if (validateOp(op)) return board;
  const coll = op.coll;
  const ts = canonicalTimestamp(op.ts);
  const list = Array.isArray(board[coll]) ? board[coll] : [];
  const idx = op.op === "add" ? list.findIndex((it) => it.id === op.item.id) : list.findIndex((it) => it.id === op.id);
  let next;
  if (op.op === "add") {
    if (idx !== -1) return board;
    const item = normalizeItem(coll, op.item, list.length, ts);
    if (!item) return board;
    // A full collection takes no more items (app/board.py _apply_in_place):
    // appending would push a file that normalization later truncates,
    // silently deleting whichever existing item sorts last.
    if (list.length >= LIMITS.maxItems) return board;
    next = list.concat([item]);
  } else if (op.op === "update") {
    if (idx === -1) return board;
    const item = Object.assign({}, list[idx]);
    for (const key of Object.keys(op.set)) item[key] = coerceField(FIELD_SPECS[coll][key], op.set[key]);
    item.updated_at = ts;
    next = list.slice();
    next[idx] = item;
  } else {
    if (idx === -1) return board;
    next = list.slice(0, idx).concat(list.slice(idx + 1));
  }
  return Object.assign({}, board, { [coll]: sortItems(next) });
}

/** Fold applyOp over `ops`, left to right. */
export function applyOps(board, ops) {
  let b = board;
  for (const op of ops || []) b = applyOp(b, op);
  return b;
}

/** The message for an `add` into a full collection (same text as app/store.py). */
export function boardFullMessage(coll) {
  return `board full: ${coll} already has ${LIMITS.maxItems} items - delete some first (e.g. clear done tasks)`;
}

/**
 * Would applying `ops` (already validated) on top of `board` add an item to a
 * collection that already holds LIMITS.maxItems items? Mirrors app/store.py
 * Store._check_room: counts the board's items plus the adds and deletes
 * earlier in the same batch; an add whose id already exists is a no-op and
 * doesn't count. Returns null, or {index, error} for the first add that
 * doesn't fit (applyOp would silently drop it).
 */
export function checkRoom(board, ops) {
  const ids = {};
  for (const coll of COLLECTIONS) {
    const list = board && Array.isArray(board[coll]) ? board[coll] : [];
    ids[coll] = new Set(list.map((it) => it && it.id));
  }
  const list = ops || [];
  for (let i = 0; i < list.length; i++) {
    const op = list[i];
    if (!isPlainObject(op) || !hasOwn(ids, op.coll)) continue;
    const have = ids[op.coll];
    if (op.op === "add") {
      const id = isPlainObject(op.item) ? op.item.id : undefined;
      if (have.has(id)) continue;
      if (have.size >= LIMITS.maxItems) return { index: i, error: boardFullMessage(op.coll) };
      have.add(id);
    } else if (op.op === "delete") {
      have.delete(op.id);
    }
  }
  return null;
}

// ------------------------------------------------------------ serialization

// Python's float repr: shortest round-trip digits, scientific notation when
// the decimal exponent is < -4 or >= 16. Integral values up to 2**53 are
// written as ints (app/board.py's _num/_intify); larger ones as floats.
function pyNumber(n) {
  if (!Number.isFinite(n)) return "null";
  if (Number.isInteger(n) && Math.abs(n) <= 2 ** 53) return Object.is(n, -0) ? "0" : String(n);
  const [mant, expStr] = n.toExponential().split("e");
  const exp = +expStr;
  const neg = mant.startsWith("-");
  const digits = mant.replace("-", "").replace(".", "");
  let body;
  if (exp < -4 || exp >= 16) {
    const rest = digits.slice(1);
    body = digits[0] + (rest ? "." + rest : "") + "e" + (exp < 0 ? "-" : "+") + pad2(Math.abs(exp));
  } else if (exp < 0) {
    body = "0." + "0".repeat(-exp - 1) + digits;
  } else {
    const intLen = exp + 1;
    body = digits.length > intLen ? digits.slice(0, intLen) + "." + digits.slice(intLen) : digits.padEnd(intLen, "0") + ".0";
  }
  return (neg ? "-" : "") + body;
}

function pyJson(value, indent) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return pyNumber(value);
  if (typeof value === "string") return JSON.stringify(value);
  const pad = " ".repeat(indent + 2);
  const end = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return "[\n" + value.map((v) => pad + pyJson(v, indent + 2)).join(",\n") + "\n" + end + "]";
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined);
  if (keys.length === 0) return "{}";
  return "{\n" + keys.map((k) => pad + JSON.stringify(k) + ": " + pyJson(value[k], indent + 2)).join(",\n") + "\n" + end + "}";
}

function orderKeys(obj, order) {
  const out = {};
  for (const k of order) if (hasOwn(obj, k)) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!hasOwn(out, k)) out[k] = obj[k];
  return out;
}

/**
 * Serialize a (normalized) board exactly like app/board.py: 2-space indent,
 * contract key order, no ASCII escaping, integral ranks as ints, trailing
 * newline.
 */
export function serializeBoard(board) {
  const b = orderKeys(board, TOP_KEYS);
  for (const coll of COLLECTIONS) {
    if (Array.isArray(b[coll])) b[coll] = b[coll].map((it) => (isPlainObject(it) ? orderKeys(it, FIELD_ORDER[coll]) : it));
  }
  return pyJson(b, 0) + "\n";
}

// ------------------------------------------------------------- op builders

function withBy(op, by) {
  if (typeof by === "string" && by !== "") op.by = by;
  return op;
}

/** Build an add op (ts = now). A missing item id is generated. */
export function opAdd(coll, item, by) {
  const it = Object.assign({}, item);
  if (typeof it.id !== "string" || it.id === "") it.id = newId(ID_PREFIX[coll] || "x");
  return withBy({ op: "add", coll, item: it, ts: nowIso() }, by);
}

/** Build an update op (ts = now). */
export function opUpdate(coll, id, set, by) {
  return withBy({ op: "update", coll, id, set: Object.assign({}, set), ts: nowIso() }, by);
}

/** Build a delete op (ts = now). */
export function opDelete(coll, id, by) {
  return withBy({ op: "delete", coll, id, ts: nowIso() }, by);
}

// ------------------------------------------------------------ ranks & moves

/** Rank for a slot between neighbour ranks a (above) and b (below); null = none. */
export function rankBetween(a, b) {
  const hasA = typeof a === "number" && Number.isFinite(a);
  const hasB = typeof b === "number" && Number.isFinite(b);
  if (!hasA && !hasB) return 0;
  if (!hasA) return b - 1;
  if (!hasB) return a + 1;
  return a / 2 + b / 2; // == (a + b) / 2 without overflow
}

const MIN_GAP = 1e-6;

/**
 * Plan the ops that move item `id` to position `toIndex` of a list.
 *
 * `list` is the destination list's items in current display order EXCLUDING
 * the moving item. Normally returns one update op `{rank, ...set}` for the
 * moving item. When the neighbours are too close (gap < 1e-6, or not in
 * ascending rank order) the destination list is re-ranked 1..n in its new
 * order, with one update op per item whose rank changes (the moving item's op
 * always comes along and also carries `set`). All ops share `ts`.
 */
export function planMove({ coll = "tasks", list = [], id, toIndex = 0, set = {}, ts, by } = {}) {
  const items = (list || []).filter((it) => it && it.id !== id);
  const at = Math.max(0, Math.min(Number.isFinite(toIndex) ? Math.trunc(toIndex) : items.length, items.length));
  const stamp = ts || nowIso();
  const mk = (itemId, fields) => withBy({ op: "update", coll, id: itemId, set: fields, ts: stamp }, by);
  const a = at > 0 ? items[at - 1].rank : null;
  const b = at < items.length ? items[at].rank : null;
  const rank = rankBetween(a, b);
  const fits =
    Number.isFinite(rank) &&
    (a === null || rank > a) &&
    (b === null || rank < b) &&
    (a === null || b === null || b - a >= MIN_GAP);
  if (fits) return [mk(id, Object.assign({ rank }, set))];
  // Re-rank the whole destination list 1..n in its new order.
  const order = items.slice(0, at).concat([null], items.slice(at));
  const ops = [];
  order.forEach((it, i) => {
    const r = i + 1;
    if (it === null) ops.push(mk(id, Object.assign({ rank: r }, set)));
    else if (it.rank !== r) ops.push(mk(it.id, { rank: r }));
  });
  return ops;
}

// ---------------------------------------------------------- commit messages
// A line-for-line port of app/board.py summarize_ops (lengths in code points).

const NOUN = { tasks: "", requests: "request ", notes: "note " };
const SINGULAR = { tasks: "task", requests: "request", notes: "note" };
// Python str.isspace() set = JS \s minus U+FEFF, plus U+001C-U+001F and U+0085.
const isPyBlank = (s) => s.replace(/[\s\x1c-\x1f\x85]/g, (c) => (c.charCodeAt(0) === 0xfeff ? c : "")) === "";

function cpSlice(s, n) {
  return codePointLength(s) <= n ? s : Array.from(s).slice(0, n).join("");
}

function commitLabel(text, limit) {
  if (typeof text !== "string") return "";
  const firstLine = cleanString(text, null, true).split("\n", 1)[0];
  let s = cleanString(firstLine, null, false);
  if (codePointLength(s) > limit) s = cpSlice(s, Math.max(1, limit - 1)).trimEnd() + "…";
  return s;
}

/**
 * Commit message for pushing `ops` on top of `boardBefore`: {subject, body}.
 * Subject (<= 72 code points), e.g.
 *   `lab-pi: add “Order tips”, complete “Calibrate pump” (+2 more)`
 * (all-moves batches: `web: reorder 5 tasks`). Body: one line per op.
 */
export function summarizeOps(ops, boardBefore, clientName, maxLen = 72) {
  const titles = { tasks: new Map(), requests: new Map(), notes: new Map() };
  const statuses = new Map();
  if (isPlainObject(boardBefore)) {
    for (const coll of COLLECTIONS) {
      const req = REQUIRED_FIELD[coll];
      const list = Array.isArray(boardBefore[coll]) ? boardBefore[coll] : [];
      for (const it of list) {
        if (isPlainObject(it) && typeof it.id === "string") {
          titles[coll].set(it.id, typeof it[req] === "string" ? it[req] : "");
          if (coll === "tasks") statuses.set(it.id, it.status);
        }
      }
    }
  }

  const entries = []; // [verb, coll, id, title, fields, by]
  for (const op of ops || []) {
    if (!isPlainObject(op)) continue;
    const kind = op.op;
    const coll = op.coll;
    if (!COLLECTIONS.includes(coll) || !OP_TYPES.includes(kind)) continue;
    const req = REQUIRED_FIELD[coll];
    const by = typeof op.by === "string" ? op.by : "";
    if (kind === "add") {
      const item = isPlainObject(op.item) ? op.item : {};
      const id = typeof item.id === "string" ? item.id : "?";
      const title = typeof item[req] === "string" ? item[req] : "";
      titles[coll].set(id, title);
      if (coll === "tasks") statuses.set(id, coerceEnum(item.status, TASK_STATUSES, "todo"));
      entries.push(["add", coll, id, title, [], by]);
      continue;
    }
    const id = typeof op.id === "string" ? op.id : "?";
    let title = titles[coll].get(id) || id;
    if (kind === "delete") {
      entries.push(["delete", coll, id, title, [], by]);
      titles[coll].delete(id);
      continue;
    }
    const changes = isPlainObject(op.set) ? op.set : {};
    const fields = Object.keys(changes);
    const newStatus = changes.status;
    let verb;
    if (coll === "tasks" && newStatus === "done") verb = "complete";
    else if (coll === "tasks" && hasOwn(changes, "status") && statuses.get(id) === "done") verb = "reopen";
    else if (fields.length === 1 && fields[0] === "rank") verb = "move";
    else verb = "edit";
    if (typeof changes[req] === "string" && !isPyBlank(changes[req])) {
      title = changes[req];
      titles[coll].set(id, title);
    }
    if (coll === "tasks" && typeof newStatus === "string") statuses.set(id, newStatus);
    entries.push([verb, coll, id, title, fields, by]);
  }

  const prefix = clientName ? cleanString(clientName, LIMITS.by, false) + ": " : "";
  if (!entries.length) return { subject: cpSlice(prefix + "update board", maxLen), body: "" };

  const lines = entries.map(([verb, coll, id, title, fields, by]) => {
    let line = `- ${verb} ${SINGULAR[coll]} ${id} “${commitLabel(title, 80)}”`;
    if (fields.length && verb !== "move") line += ` [${fields.join(", ")}]`;
    if (by) line += ` (by ${cleanString(by, LIMITS.by, false)})`;
    return line;
  });
  const body = lines.join("\n");

  if (entries.length > 1 && entries.every((e) => e[0] === "move")) {
    const colls = new Set(entries.map((e) => e[1]));
    const what = colls.size === 1 ? SINGULAR[[...colls][0]] + "s" : "items";
    return { subject: cpSlice(`${prefix}reorder ${entries.length} ${what}`, maxLen), body };
  }

  const describe = (e, limit) => `${e[0]} ${NOUN[e[1]]}“${commitLabel(e[3], limit)}”`;
  const descs = entries.map((e) => describe(e, 32));
  let parts = [];
  for (let i = 0; i < descs.length; i++) {
    const rest = descs.length - i - 1;
    const cand = prefix + parts.concat([descs[i]]).join(", ") + (rest ? ` (+${rest} more)` : "");
    if (codePointLength(cand) <= maxLen) parts.push(descs[i]);
    else break;
  }
  if (!parts.length) {
    const rest = descs.length - 1;
    const suffix = rest ? ` (+${rest} more)` : "";
    const [verb, coll] = entries[0];
    const overhead = codePointLength(prefix) + codePointLength(verb) + 1 + NOUN[coll].length + 2 + codePointLength(suffix);
    parts = [describe(entries[0], Math.max(1, maxLen - overhead))];
  }
  const more = descs.length - parts.length;
  const subject = prefix + parts.join(", ") + (more ? ` (+${more} more)` : "");
  return { subject: cpSlice(subject, maxLen), body };
}
