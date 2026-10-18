// Formatting helpers: relative times, dates, initials, colours.

const pad2 = (n) => String(n).padStart(2, "0");

function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  if (typeof v === "string" && v) return Date.parse(v);
  return NaN;
}

/** "just now", "12s ago", "5 min ago", "3h ago", "2d ago", "Oct 3". "" when invalid. */
export function relTime(value, now = Date.now()) {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) return "";
  const s = Math.round((now - ms) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return shortDate(new Date(ms), new Date(now));
}

/** "in 25 min", "in 2h 10m", "now" for a future time. */
export function untilText(value, now = Date.now()) {
  const ms = toMs(value);
  if (!Number.isFinite(ms)) return "";
  const m = Math.round((ms - now) / 60000);
  if (m <= 0) return "now";
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 24) return r ? `in ${h}h ${r}m` : `in ${h}h`;
  const d = Math.round(h / 24);
  return `in ${d}d`;
}

/** "Oct 3" (or "Oct 3, 2025" for another year). */
export function shortDate(d, now = new Date()) {
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

/** Local calendar key YYYY-MM-DD. */
export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** "Today" / "Tomorrow" / "Yesterday" / "Wed, Oct 21". */
export function dayLabel(d, now = new Date()) {
  const k = dayKey(d);
  if (k === dayKey(now)) return "Today";
  if (k === dayKey(addDays(now, 1))) return "Tomorrow";
  if (k === dayKey(addDays(now, -1))) return "Yesterday";
  const opts = { weekday: "short", month: "short", day: "numeric" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

/** Locale time "2:30 PM" / "14:30". */
export function timeText(d) {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** "Fri, Oct 23" for a YYYY-MM-DD string (local date). */
export function dueDateText(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || "");
  if (!m) return "";
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const opts = { weekday: "short", month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}

/** Up to two initials: "Mei" -> "M", "Jordan Lee" -> "JL". */
export function initials(name) {
  const words = String(name || "").trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return "?";
  const first = Array.from(words[0])[0] || "";
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] || "" : "";
  return (first + last).toUpperCase();
}

/** Stable hue (0-359) for a name. */
export function hueOf(name) {
  const s = String(name || "").trim().toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}

export function greeting(d = new Date()) {
  const hr = d.getHours();
  if (hr < 5) return "Working late";
  if (hr < 12) return "Good morning";
  if (hr < 17) return "Good afternoon";
  if (hr < 22) return "Good evening";
  return "Working late";
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || `${one}s`}`;
}

/** Strip the scheme and trailing slash for display: "richard-0421.github.io/lab-hub". */
export function displayUrl(url) {
  return String(url || "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

/** Short quoted label for toasts. */
export function quote(s, max = 40) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  const cps = Array.from(t);
  return `“${cps.length > max ? cps.slice(0, max - 1).join("").trimEnd() + "…" : t}”`;
}
