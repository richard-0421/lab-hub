// Per-browser preferences in localStorage (every access guarded: storage can
// be blocked or throw in private windows / kiosk profiles).

export const NAME_KEY = "labhub:name";
export const THEME_KEY = "labhub:theme";
export const SORT_KEY = "labhub:sort";

export function pget(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

export function pset(key, value) {
  try {
    if (value === null || value === undefined || value === "") localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch (_) {
    // ignore (quota / blocked)
  }
}

export function getName() {
  return (pget(NAME_KEY, "") || "").trim().slice(0, 60);
}

export function setName(name) {
  const n = String(name || "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (n) pset(NAME_KEY, n);
  return n;
}
