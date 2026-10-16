// Quick-add parser: "Order tips @mei !high #bio due:fri" -> task fields.
// Pure ES module, no DOM. Dates are LOCAL calendar dates (YYYY-MM-DD).

const MAX_TAGS = 8;
const TAG_LEN = 24;

const PRIORITY_TOKENS = {
  "!high": "high",
  "!h": "high",
  "!!": "high",
  "!!!": "high",
  "!urgent": "high",
  "!low": "low",
  "!l": "low",
  "!normal": "normal",
  "!n": "normal",
};

const WEEKDAYS = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const pad2 = (n) => String(n).padStart(2, "0");

function ymd(d) {
  return `${String(d.getFullYear()).padStart(4, "0")}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function startOfDay(today) {
  const t = today instanceof Date && !isNaN(today) ? today : new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
}

function addDays(day, n) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + n);
}

function realDate(y, m, d) {
  const dt = new Date(y, m - 1, d);
  // new Date(y, ...) maps years 0–99 to 1900+; setFullYear fixes that.
  dt.setFullYear(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
}

/**
 * Parse a due-date expression relative to `today` (local). Returns
 * "YYYY-MM-DD" or "" when it can't be parsed.
 * Accepts: YYYY-MM-DD | today | tod | tomorrow | tmr | tom | mon..sun |
 * monday..sunday (next occurrence, today counts) | +Nd | Nd | +Nw | Nw | M/D.
 */
export function parseDue(expr, today = new Date()) {
  if (typeof expr !== "string") return "";
  const s = expr.trim().toLowerCase();
  if (!s) return "";
  const day0 = startOfDay(today);
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const y = +m[1];
    if (y < 1) return "";
    const dt = realDate(y, +m[2], +m[3]);
    return dt ? ymd(dt) : "";
  }
  if (s === "today" || s === "tod") return ymd(day0);
  if (s === "tomorrow" || s === "tmr" || s === "tom") return ymd(addDays(day0, 1));
  if (Object.prototype.hasOwnProperty.call(WEEKDAYS, s)) {
    const delta = (WEEKDAYS[s] - day0.getDay() + 7) % 7;
    return ymd(addDays(day0, delta));
  }
  m = /^\+?(\d{1,3})([dw])$/.exec(s);
  if (m) return ymd(addDays(day0, +m[1] * (m[2] === "w" ? 7 : 1)));
  m = /^(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (m) {
    const mo = +m[1];
    const d = +m[2];
    let dt = realDate(day0.getFullYear(), mo, d);
    if (dt && dt < day0) dt = realDate(day0.getFullYear() + 1, mo, d);
    if (!dt) {
      // e.g. 2/29 when this year isn't a leap year: try next year.
      const next = realDate(day0.getFullYear() + 1, mo, d);
      dt = next && next >= day0 ? next : null;
    }
    return dt ? ymd(dt) : "";
  }
  return "";
}

/**
 * Parse quick-add text. Tokens are removed from the title:
 *   @name            -> assignee ("_" becomes a space; last one wins)
 *   !high !h !! !urgent / !low !l / !normal !n -> priority (null if absent)
 *   #tag             -> tags (lower-case, de-duplicated; must contain a letter)
 *   due:X  ^X        -> due "YYYY-MM-DD" (local); unparseable tokens stay in the title
 * Returns {title, assignee, priority, tags, due}.
 */
export function parseQuickAdd(text, today = new Date()) {
  const words = String(text == null ? "" : text).split(/\s+/).filter(Boolean);
  const keep = [];
  let assignee = "";
  let priority = null;
  let due = "";
  const tags = [];
  for (const w of words) {
    let m = /^@([\p{L}\p{N}._-]+)$/u.exec(w);
    if (m) {
      const name = m[1].replace(/\.+$/, "").replace(/_/g, " ").trim();
      if (name) {
        assignee = name;
        continue;
      }
    }
    const lower = w.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(PRIORITY_TOKENS, lower)) {
      priority = PRIORITY_TOKENS[lower];
      continue;
    }
    m = /^#([^\s#]\S*)$/u.exec(w);
    if (m && /\p{L}/u.test(m[1])) {
      const tag = Array.from(m[1].toLowerCase()).slice(0, TAG_LEN).join("");
      if (!tags.includes(tag) && tags.length < MAX_TAGS) tags.push(tag);
      continue;
    }
    m = /^(?:due:|\^)(.+)$/i.exec(w);
    if (m) {
      const d = parseDue(m[1], today);
      if (d) {
        due = d;
        continue;
      }
    }
    keep.push(w);
  }
  return { title: keep.join(" ").trim(), assignee, priority, tags, due };
}

/**
 * Human label + tone for a due date relative to `today` (local).
 *   past      -> {label: "Overdue · Oct 12", tone: "overdue"}
 *   today     -> {label: "Today",            tone: "today"}
 *   +1 day    -> {label: "Tomorrow",         tone: "soon"}
 *   +2..6     -> {label: "Fri",              tone: "soon"}
 *   later     -> {label: "Oct 30",           tone: "later"}
 * Dates in another year get the year appended ("Jan 3, 2027").
 * Empty or invalid `due` -> {label: "", tone: ""}.
 */
export function formatDueLabel(due, today = new Date()) {
  const m = typeof due === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(due) : null;
  const dt = m ? realDate(+m[1], +m[2], +m[3]) : null;
  if (!dt) return { label: "", tone: "" };
  const day0 = startOfDay(today);
  const diff = Math.round(
    (Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()) -
      Date.UTC(day0.getFullYear(), day0.getMonth(), day0.getDate())) / 86400000,
  );
  const monthDay = () => {
    const opts = { month: "short", day: "numeric" };
    if (dt.getFullYear() !== day0.getFullYear()) opts.year = "numeric";
    return dt.toLocaleDateString(undefined, opts);
  };
  if (diff < 0) return { label: `Overdue · ${monthDay()}`, tone: "overdue" };
  if (diff === 0) return { label: "Today", tone: "today" };
  if (diff === 1) return { label: "Tomorrow", tone: "soon" };
  if (diff <= 6) return { label: dt.toLocaleDateString(undefined, { weekday: "short" }), tone: "soon" };
  return { label: monthDay(), tone: "later" };
}
