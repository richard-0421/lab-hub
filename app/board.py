"""Pure board model: the board document, normalization, operations.

This module mirrors ``static/js/board.js``; both must pass
``tests/ops_vectors.json`` exactly. See docs/ARCHITECTURE.md sections 2-3.

Nothing in here does I/O, and no function mutates its arguments.
"""
import copy
import json
import math
import random
import re
from datetime import datetime, timedelta, timezone

# --------------------------------------------------------------------------- #
# constants
# --------------------------------------------------------------------------- #
SCHEMA = 1
COLLECTIONS = ("tasks", "requests", "notes")
OP_KINDS = ("add", "update", "delete")
ID_PREFIX = {"tasks": "t", "requests": "r", "notes": "n"}
ID_PATTERN = r"[A-Za-z0-9_-]{1,64}"
ID_RE = re.compile(ID_PATTERN)  # always used with fullmatch()

TASK_STATUSES = ("todo", "doing", "done")
PRIORITIES = ("high", "normal", "low")
REQUEST_STATUSES = ("new", "ordered", "received")
NOTE_COLORS = ("yellow", "blue", "green", "pink", "purple")

MAX_ITEMS = 2000
MAX_TAGS = 8
MAX_TAG_LEN = 24
MAX_BY_LEN = 60
EPOCH = "1970-01-01T00:00:00Z"
_SAFE_INT = 2 ** 53

# Field specs, in the on-disk key order.
#   ("text", max)          single-line string
#   ("mtext", max)         multi-line string (keeps \n and \t)
#   ("enum", allowed, default)
#   ("date",)              "" or YYYY-MM-DD
#   ("tags",)
#   ("rank",)
#   ("ts", required)       canonical UTC timestamp; required -> EPOCH default, else ""
#   ("bool",)
#   ("link", max)
FIELD_SPECS = {
    "tasks": (
        ("id", ("id",)),
        ("title", ("text", 300)),
        ("notes", ("mtext", 4000)),
        ("status", ("enum", TASK_STATUSES, "todo")),
        ("priority", ("enum", PRIORITIES, "normal")),
        ("assignee", ("text", 60)),
        ("due", ("date",)),
        ("tags", ("tags",)),
        ("rank", ("rank",)),
        ("created_at", ("ts", True)),
        ("updated_at", ("ts", True)),
        ("done_at", ("ts", False)),
        ("created_by", ("text", 60)),
    ),
    "requests": (
        ("id", ("id",)),
        ("item", ("text", 300)),
        ("qty", ("text", 40)),
        ("requested_by", ("text", 60)),
        ("status", ("enum", REQUEST_STATUSES, "new")),
        ("notes", ("mtext", 2000)),
        ("link", ("link", 500)),
        ("rank", ("rank",)),
        ("created_at", ("ts", True)),
        ("updated_at", ("ts", True)),
    ),
    "notes": (
        ("id", ("id",)),
        ("body", ("mtext", 2000)),
        ("author", ("text", 60)),
        ("pinned", ("bool",)),
        ("color", ("enum", NOTE_COLORS, "yellow")),
        ("rank", ("rank",)),
        ("created_at", ("ts", True)),
        ("updated_at", ("ts", True)),
    ),
}
FIELD_ORDER = {c: tuple(name for name, _ in specs) for c, specs in FIELD_SPECS.items()}
_SPEC = {c: dict(specs) for c, specs in FIELD_SPECS.items()}

REQUIRED_TEXT = {"tasks": "title", "requests": "item", "notes": "body"}

EDITABLE = {
    "tasks": ("title", "notes", "status", "priority", "assignee", "due", "tags", "rank", "done_at"),
    "requests": ("item", "qty", "requested_by", "status", "notes", "link", "rank"),
    "notes": ("body", "author", "pinned", "color", "rank"),
}

TOP_LEVEL_ORDER = ("schema", "updated_at", "updated_by") + COLLECTIONS


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #
# Exactly the characters JavaScript's String.prototype.trim() removes, so the
# Python and JS implementations agree (str.strip() differs on U+0085/U+FEFF ...).
_JS_WS = (
    "\t\n\x0b\x0c\r \xa0        "
    "        　﻿"
)
_CTRL_SINGLE = re.compile("[\x00-\x1f\x7f]")
_CTRL_MULTI = re.compile("[\x00-\x08\x0b-\x1f\x7f]")  # keeps \t (09) and \n (0a)


def js_trim(s):
    return s.strip(_JS_WS)


def now_iso():
    """Current time as a canonical UTC timestamp."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_id(coll):
    """'<prefix>-' + 10 random [a-z0-9] chars, like newId() in board.js."""
    alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
    rnd = random.SystemRandom()
    return ID_PREFIX[coll] + "-" + "".join(rnd.choice(alphabet) for _ in range(10))


def is_valid_id(value):
    return isinstance(value, str) and ID_RE.fullmatch(value) is not None


def empty_board():
    return {
        "schema": SCHEMA,
        "updated_at": "",
        "updated_by": "",
        "tasks": [],
        "requests": [],
        "notes": [],
    }


def clean_text(value, max_len, multiline=False):
    """String coercion used by normalization and op apply.

    non-string -> "" ; CRLF/CR -> LF ; single-line fields turn LF/TAB into a
    space ; remaining C0 controls + DEL removed ; trim ; clamp to ``max_len``
    code points. After clamping, trailing whitespace is trimmed again so that
    normalization stays idempotent (see the final report / ARCHITECTURE.md).
    """
    if not isinstance(value, str):
        return ""
    s = value.replace("\r\n", "\n").replace("\r", "\n")
    if multiline:
        s = _CTRL_MULTI.sub("", s)
    else:
        s = s.replace("\n", " ").replace("\t", " ")
        s = _CTRL_SINGLE.sub("", s)
    s = js_trim(s)
    if len(s) > max_len:
        s = s[:max_len].rstrip(_JS_WS)
    return s


def _days_in_month(year, month):
    if month == 2:
        leap = (year % 4 == 0 and year % 100 != 0) or year % 400 == 0
        return 29 if leap else 28
    return 30 if month in (4, 6, 9, 11) else 31


_DATE_RE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})")


def is_valid_date(value):
    """True for an exact ``YYYY-MM-DD`` string that is a real calendar date."""
    if not isinstance(value, str):
        return False
    m = _DATE_RE.fullmatch(value)
    if not m:
        return False
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    return 1 <= mo <= 12 and 1 <= d <= _days_in_month(y, mo)


_TS_RE = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})"
    r"(?:[T ]([0-9]{2}):([0-9]{2})"
    r"(?::([0-9]{2})(?:\.([0-9]+))?)?"
    r"(?:([Zz])|([+-])([0-9]{2}):?([0-9]{2}))?"
    r")?"
)


def canonical_timestamp(value):
    """Parse with the contract's timestamp grammar.

    Returns canonical ``YYYY-MM-DDTHH:MM:SSZ`` (UTC) or None when invalid.
    A missing zone means UTC. Years outside 1970-9999 (before *or* after the
    conversion to UTC) are invalid.
    """
    if not isinstance(value, str):
        return None
    m = _TS_RE.fullmatch(value)
    if not m:
        return None
    y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not (1970 <= y <= 9999 and 1 <= mo <= 12 and 1 <= d <= _days_in_month(y, mo)):
        return None
    hh = int(m.group(4)) if m.group(4) is not None else 0
    mi = int(m.group(5)) if m.group(5) is not None else 0
    ss = int(m.group(6)) if m.group(6) is not None else 0
    if hh > 23 or mi > 59 or ss > 59:
        return None
    offset = 0
    if m.group(9) is not None:
        oh, om = int(m.group(10)), int(m.group(11))
        if oh > 23 or om > 59:
            return None
        offset = (oh * 60 + om) * (1 if m.group(9) == "+" else -1)
    try:
        dt = datetime(y, mo, d, hh, mi, ss) - timedelta(minutes=offset)
    except (OverflowError, ValueError):
        return None
    if not (1970 <= dt.year <= 9999):
        return None
    return "%04d-%02d-%02dT%02d:%02d:%02dZ" % (dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second)


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _finite_float(v):
    """float(v) if v is a finite JSON number (not bool), else None."""
    if not _is_number(v):
        return None
    try:
        f = float(v)
    except (OverflowError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _num(f):
    """Integral floats become ints (so 3.0 is written as 3)."""
    if f == int(f) and abs(f) <= _SAFE_INT:
        return int(f)
    return f


def _rank(v):
    f = _finite_float(v)
    return 0 if f is None else _num(f)


def _bool(v):
    if v is True or v is False:
        return v
    if _is_number(v):
        return v == 1
    return v == "true"


def _enum(v, allowed, default):
    if isinstance(v, str):
        s = js_trim(v).lower()
        if s in allowed:
            return s
    return default


def _tags(v):
    if not isinstance(v, list):
        return []
    out = []
    for t in v:
        if not isinstance(t, str):
            continue
        s = clean_text(t, 10 ** 9, False)
        # strip any run of leading '#' and whitespace (idempotent form of
        # "trim, strip leading #s, trim again")
        s = s.lstrip("#" + _JS_WS)
        s = s.lower()
        if len(s) > MAX_TAG_LEN:
            s = s[:MAX_TAG_LEN]
        s = js_trim(s)
        if not s or s in out:
            continue
        out.append(s)
        if len(out) >= MAX_TAGS:
            break
    return out


def _link(v, max_len):
    s = clean_text(v, max_len, False)
    if s.startswith("http://") or s.startswith("https://"):
        return s
    return ""


def _coerce(spec, value, default_ts=None):
    kind = spec[0]
    if kind == "text":
        return clean_text(value, spec[1], False)
    if kind == "mtext":
        return clean_text(value, spec[1], True)
    if kind == "enum":
        return _enum(value, spec[1], spec[2])
    if kind == "date":
        return value if is_valid_date(value) else ""
    if kind == "tags":
        return _tags(value)
    if kind == "rank":
        return _rank(value)
    if kind == "ts":
        ts = canonical_timestamp(value)
        if ts is not None:
            return ts
        if spec[1]:
            return default_ts or EPOCH
        return ""
    if kind == "bool":
        return _bool(value)
    if kind == "link":
        return _link(value, spec[1])
    raise ValueError("unknown field kind %r" % (kind,))


def _sort_key(item):
    return (item["rank"], item["id"])


# --------------------------------------------------------------------------- #
# normalization
# --------------------------------------------------------------------------- #
def normalize_item(coll, raw, index=0, default_ts=None):
    """Coerce one item of ``coll``. Returns a new dict, or None when the entry
    is dropped (not an object, or its required text is empty).

    ``index`` names auto ids (``t-auto-<index>``). ``default_ts`` replaces the
    epoch default for created_at/updated_at (used by ``add`` ops).
    """
    if coll not in FIELD_SPECS or not isinstance(raw, dict):
        return None
    out = {}
    for name, spec in FIELD_SPECS[coll]:
        if name == "id":
            v = raw.get("id")
            out["id"] = v if is_valid_id(v) else "%s-auto-%d" % (ID_PREFIX[coll], index)
        else:
            out[name] = _coerce(spec, raw.get(name), default_ts)
    if not out[REQUIRED_TEXT[coll]]:
        return None
    return out


def normalize_board(doc):
    """Normalize a board document (e.g. read from disk or GitHub). Pure."""
    if not isinstance(doc, dict):
        return empty_board()
    out = {
        "schema": SCHEMA,
        "updated_at": canonical_timestamp(doc.get("updated_at")) or "",
        "updated_by": clean_text(doc.get("updated_by"), MAX_BY_LEN, False),
    }
    for coll in COLLECTIONS:
        raw = doc.get(coll)
        items = []
        seen = set()
        if isinstance(raw, list):
            for i, entry in enumerate(raw):
                item = normalize_item(coll, entry, i)
                if item is None or item["id"] in seen:
                    continue
                seen.add(item["id"])
                items.append(item)
        items.sort(key=_sort_key)
        out[coll] = items[:MAX_ITEMS]
    return out


# --------------------------------------------------------------------------- #
# operations
# --------------------------------------------------------------------------- #
def validate_op(op):
    """Return None when ``op`` is acceptable, else a human-readable error."""
    if not isinstance(op, dict):
        return "op must be an object"
    kind = op.get("op")
    if kind not in OP_KINDS:
        return "unknown op %s (expected add, update or delete)" % _short(kind)
    coll = op.get("coll")
    if coll not in COLLECTIONS:
        return "unknown collection %s" % _short(coll)
    if canonical_timestamp(op.get("ts")) is None:
        return "missing or invalid ts"
    required = REQUIRED_TEXT[coll]
    if kind == "add":
        item = op.get("item")
        if not isinstance(item, dict):
            return "add needs an item object"
        if not is_valid_id(item.get("id")):
            return "item id must match %s" % ID_PATTERN
        if not _coerce(_SPEC[coll][required], item.get(required)):
            return "%s must not be empty" % required
        return None
    if not is_valid_id(op.get("id")):
        return "missing or invalid id"
    if kind == "delete":
        return None
    changes = op.get("set")
    if not isinstance(changes, dict) or not changes:
        return "update needs a non-empty set object"
    for key, value in changes.items():
        if key not in EDITABLE[coll]:
            return "%s is not an editable field of %s" % (_short(key), coll)
        err = _validate_value(coll, key, value)
        if err:
            return err
    return None


def _validate_value(coll, key, value):
    spec = _SPEC[coll][key]
    kind = spec[0]
    if kind in ("text", "mtext", "link"):
        if not isinstance(value, str):
            return "%s must be a string" % key
        if key == REQUIRED_TEXT[coll] and not _coerce(spec, value):
            return "%s must not be empty" % key
    elif kind == "enum":
        if not isinstance(value, str) or value not in spec[1]:
            return "%s must be one of %s" % (key, ", ".join(spec[1]))
    elif kind == "date":
        if not isinstance(value, str) or (value and not is_valid_date(value)):
            return "%s must be empty or YYYY-MM-DD" % key
    elif kind == "ts":
        if not isinstance(value, str) or (value and canonical_timestamp(value) is None):
            return "%s must be empty or an ISO timestamp" % key
    elif kind == "rank":
        if _finite_float(value) is None:
            return "%s must be a finite number" % key
    elif kind == "tags":
        if not isinstance(value, list) or not all(isinstance(t, str) for t in value):
            return "%s must be a list of strings" % key
    elif kind == "bool":
        if not isinstance(value, bool):
            return "%s must be true or false" % key
    return None


def _short(v):
    s = json.dumps(v, ensure_ascii=False) if not isinstance(v, str) else repr(v)
    return s if len(s) <= 40 else s[:37] + "..."


def _find(items, item_id):
    for i, it in enumerate(items):
        if it.get("id") == item_id:
            return i
    return None


def _apply_in_place(board, op):
    """Apply ``op`` to ``board`` (which the caller owns). Returns True if the
    board changed."""
    if validate_op(op) is not None:
        return False
    coll = op["coll"]
    ts = canonical_timestamp(op["ts"])
    items = board.get(coll)
    if not isinstance(items, list):
        items = []
        board[coll] = items
    kind = op["op"]
    if kind == "add":
        item = normalize_item(coll, op["item"], 0, default_ts=ts)
        if item is None or _find(items, item["id"]) is not None:
            return False
        items.append(item)
        items.sort(key=_sort_key)
        return True
    idx = _find(items, op["id"])
    if idx is None:
        return False
    if kind == "delete":
        del items[idx]
        return True
    item = dict(items[idx])
    for key, value in op["set"].items():
        item[key] = _coerce(_SPEC[coll][key], value)
    item["updated_at"] = ts
    items[idx] = item
    items.sort(key=_sort_key)
    return True


def apply_op(board, op):
    """Return a new board with ``op`` applied. Never mutates ``board``/``op``."""
    out = copy.deepcopy(board)
    _apply_in_place(out, op)
    return out


def apply_ops(board, ops):
    """Fold ``apply_op`` left to right (one deep copy, then in-place)."""
    out = copy.deepcopy(board)
    for op in ops or ():
        _apply_in_place(out, op)
    return out


# --------------------------------------------------------------------------- #
# serialization
# --------------------------------------------------------------------------- #
def _intify(o):
    if isinstance(o, float):
        return _num(o) if math.isfinite(o) else o
    if isinstance(o, dict):
        return {k: _intify(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_intify(v) for v in o]
    return o


def serialize_board(board):
    """UTF-8 friendly JSON text: 2-space indent, no ASCII escaping, integral
    floats as ints, trailing newline."""
    return json.dumps(_intify(board), indent=2, ensure_ascii=False, allow_nan=False) + "\n"


def serialize_board_bytes(board):
    """``serialize_board`` encoded as UTF-8. A lone surrogate (only possible
    via a JSON ``\\udXXX`` escape) is written back as that escape."""
    return serialize_board(board).encode("utf-8", "backslashreplace")


def parse_json_strict(text):
    """json.loads that, like JSON.parse, rejects NaN/Infinity tokens."""
    def _reject(token):
        raise ValueError("invalid number %s" % token)
    return json.loads(text, parse_constant=_reject)


def same_json(a, b):
    """Structural JSON equality that ignores key order and int/float spelling
    (3 == 3.0) but distinguishes bools from numbers."""
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if _is_number(a) and _is_number(b):
        return a == b
    if isinstance(a, dict) and isinstance(b, dict):
        if a.keys() != b.keys():
            return False
        return all(same_json(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(same_json(x, y) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


# --------------------------------------------------------------------------- #
# commit messages
# --------------------------------------------------------------------------- #
MAX_BODY_LINES = 200
_NOUN = {"tasks": "", "requests": "request ", "notes": "note "}
_SINGULAR = {"tasks": "task", "requests": "request", "notes": "note"}


def _label(text, limit):
    if not isinstance(text, str):
        return ""
    first_line = clean_text(text, 10 ** 9, True).split("\n", 1)[0]
    s = clean_text(first_line, 10 ** 9, False)
    if len(s) > limit:
        s = s[: max(1, limit - 1)].rstrip(_JS_WS) + "…"
    return s


def summarize_ops(ops, board_before=None, client=None, max_len=72):
    """Build a commit message for pushing ``ops`` on top of ``board_before``.

    Returns ``(subject, body)``. The subject is at most ``max_len`` chars,
    e.g. ``lab-pi: add “Order tips”, complete “Calibrate pump” (+2 more)``;
    the body has one line per op.
    """
    titles = {c: {} for c in COLLECTIONS}
    statuses = {}
    if isinstance(board_before, dict):
        for coll in COLLECTIONS:
            req = REQUIRED_TEXT[coll]
            for it in board_before.get(coll) or ():
                if isinstance(it, dict) and isinstance(it.get("id"), str):
                    titles[coll][it["id"]] = it.get(req) if isinstance(it.get(req), str) else ""
                    if coll == "tasks":
                        statuses[it["id"]] = it.get("status")

    entries = []  # (verb, coll, item_id, full_title, fields, by)
    for op in ops or ():
        if not isinstance(op, dict):
            continue
        kind, coll = op.get("op"), op.get("coll")
        if coll not in COLLECTIONS or kind not in OP_KINDS:
            continue
        req = REQUIRED_TEXT[coll]
        by = op.get("by") if isinstance(op.get("by"), str) else ""
        if kind == "add":
            item = op.get("item") if isinstance(op.get("item"), dict) else {}
            item_id = item.get("id") if isinstance(item.get("id"), str) else "?"
            title = item.get(req) if isinstance(item.get(req), str) else ""
            titles[coll][item_id] = title
            if coll == "tasks":
                statuses[item_id] = _enum(item.get("status"), TASK_STATUSES, "todo")
            entries.append(("add", coll, item_id, title, (), by))
            continue
        item_id = op.get("id") if isinstance(op.get("id"), str) else "?"
        title = titles[coll].get(item_id) or item_id
        if kind == "delete":
            entries.append(("delete", coll, item_id, title, (), by))
            titles[coll].pop(item_id, None)
            continue
        changes = op.get("set") if isinstance(op.get("set"), dict) else {}
        fields = tuple(changes.keys())
        new_status = changes.get("status")
        if coll == "tasks" and new_status == "done":
            verb = "complete"
        elif coll == "tasks" and "status" in changes and statuses.get(item_id) == "done":
            verb = "reopen"
        elif fields == ("rank",):
            verb = "move"
        else:
            verb = "edit"
        if isinstance(changes.get(req), str) and changes.get(req).strip():
            title = changes[req]
            titles[coll][item_id] = title
        if coll == "tasks" and isinstance(new_status, str):
            statuses[item_id] = new_status
        entries.append((verb, coll, item_id, title, fields, by))

    prefix = (clean_text(client, MAX_BY_LEN) + ": ") if client else ""

    if not entries:
        subject = prefix + "update board"
        return subject[:max_len], ""

    # body: one line per op
    lines = []
    for verb, coll, item_id, title, fields, by in entries:
        line = "- %s %s %s “%s”" % (verb, _SINGULAR[coll], item_id, _label(title, 80))
        if fields and verb != "move":
            line += " [%s]" % ", ".join(fields)
        if by:
            line += " (by %s)" % clean_text(by, MAX_BY_LEN)
        lines.append(line)
    if len(lines) > MAX_BODY_LINES:
        extra = len(lines) - MAX_BODY_LINES
        lines = lines[:MAX_BODY_LINES] + ["- \u2026 and %d more" % extra]
    body = "\n".join(lines)

    # subject
    if len(entries) > 1 and all(e[0] == "move" for e in entries):
        colls = {e[1] for e in entries}
        what = (_SINGULAR[colls.pop()] + "s") if len(colls) == 1 else "items"
        subject = "%sreorder %d %s" % (prefix, len(entries), what)
        return subject[:max_len], body

    def describe(entry, limit):
        verb, coll, _id, title, _f, _b = entry
        return "%s %s“%s”" % (verb, _NOUN[coll], _label(title, limit))

    descs = [describe(e, 32) for e in entries]
    parts = []
    for i, d in enumerate(descs):
        rest = len(descs) - i - 1
        cand = prefix + ", ".join(parts + [d]) + (" (+%d more)" % rest if rest else "")
        if len(cand) <= max_len:
            parts.append(d)
        else:
            break
    if not parts:
        rest = len(descs) - 1
        suffix = " (+%d more)" % rest if rest else ""
        verb, coll = entries[0][0], entries[0][1]
        overhead = len(prefix) + len(verb) + 1 + len(_NOUN[coll]) + 2 + len(suffix)
        parts = [describe(entries[0], max(1, max_len - overhead))]
    more = len(descs) - len(parts)
    subject = prefix + ", ".join(parts) + (" (+%d more)" % more if more else "")
    return subject[:max_len], body
