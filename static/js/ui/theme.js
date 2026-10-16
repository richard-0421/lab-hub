// Theme: ?theme= URL param -> localStorage "labhub:theme" -> config.theme
// (local mode) -> "auto" (github mode). The header toggle flips dark/light and
// remembers the choice. index.html applies the same rules before first paint.

import { THEME_KEY, pget, pset } from "./prefs.js";

const VALID = ["dark", "light", "auto"];
let pref = "dark";
let mql = null;

function urlTheme() {
  try {
    const t = new URLSearchParams(location.search).get("theme");
    return VALID.includes(t) ? t : null;
  } catch (_) {
    return null;
  }
}

function storedTheme() {
  const t = pget(THEME_KEY, null);
  return VALID.includes(t) ? t : null;
}

function resolve(p) {
  if (p === "auto") return mql && mql.matches ? "light" : "dark";
  return p === "light" ? "light" : "dark";
}

function apply() {
  const t = resolve(pref);
  document.documentElement.setAttribute("data-theme", t);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", t === "light" ? "#f5f6f8" : "#0a0c10");
}

/** Start with the URL/stored preference (fallback until the config is known). */
export function initTheme(fallback = "dark") {
  try {
    mql = window.matchMedia ? window.matchMedia("(prefers-color-scheme: light)") : null;
    if (mql && mql.addEventListener) mql.addEventListener("change", () => pref === "auto" && apply());
  } catch (_) {
    mql = null;
  }
  pref = urlTheme() || storedTheme() || fallback;
  apply();
}

/** Mode is known: use config.theme (local) or "auto" (github) unless the viewer chose. */
export function setDefaultTheme(theme) {
  if (urlTheme() || storedTheme()) return;
  pref = VALID.includes(theme) ? theme : "dark";
  apply();
}

export function currentTheme() {
  return resolve(pref);
}

/** Flip dark <-> light and remember it in this browser. */
export function toggleTheme() {
  pref = resolve(pref) === "dark" ? "light" : "dark";
  pset(THEME_KEY, pref);
  apply();
  return pref;
}
