// Page-lifecycle decisions that app.js wires to the DOM: which host is the
// shared kiosk, tearing a source down before its storage is cleared, and when
// the kiosk may reload itself for a code update. Pure functions (no DOM at
// import time) so tests/js can exercise them directly.

/** localhost, 127.x.x.x, [::1] and *.localhost. */
export function isLoopbackHost(host) {
  const h = String(host || "").toLowerCase();
  return /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)$/.test(h) || /\.localhost$/.test(h);
}

/**
 * The shared lab display: local mode served on the Pi's own loopback address
 * (the Chromium kiosk). Laptops on the LAN and GitHub Pages are personal
 * browsers and keep remembering who is using them.
 */
export function isKioskHost(mode, host) {
  return mode === "local" && isLoopbackHost(host);
}

/**
 * Who this browser acts as (created_by, op `by`, form defaults). A shared
 * kiosk never guesses: one person typing their name must not attribute every
 * later edit to them.
 */
export function personName({ kiosk = false, stored = "", clientName = "" } = {}) {
  if (kiosk) return "";
  return stored || clientName || "";
}

/**
 * "Forget token": halt the live source BEFORE clearing its storage, so an
 * in-flight GET/PUT can't finish afterwards and write the dropped pending ops
 * back into localStorage. Then reload.
 */
export function forgetGitHub({ source = null, unsubscribe = null, clear, reload }) {
  if (typeof unsubscribe === "function") unsubscribe();
  if (source && typeof source.stop === "function") source.stop();
  if (typeof clear === "function") clear();
  if (typeof reload === "function") reload();
}

/**
 * Ops this page holds only in memory (LocalSource's outbox): a reload would
 * lose them. GitHubSource persists its queue, so it reports 0 here. Prefers
 * LocalSource's public `unsent` count and falls back to the outbox length
 * (older sources).
 */
export function unsentOps(source) {
  if (!source || source.mode !== "local") return 0;
  if (Number.isFinite(source.unsent)) return source.unsent;
  return Array.isArray(source._outbox) ? source._outbox.length : 0;
}

export const RECENT_INPUT_MS = 45 * 1000;
export const ABANDONED_MS = 10 * 60 * 1000;

/**
 * Why the kiosk must not reload for a new /api/version right now ("" = go).
 *   unsent      edits still only in this page's memory (never overridden)
 *   drag        a drag is in progress
 *   dialog      an editor/dialog is open
 *   draft       the focused field holds unsent text
 *   active      someone touched / typed in the last RECENT_INPUT_MS
 * An empty but focused field (e.g. quick-add right after Enter) does not
 * block. Once the update has waited ABANDONED_MS with no input in that time,
 * an open dialog or a stale draft no longer blocks either: nobody is there.
 */
export function versionReloadBlocker({
  now = Date.now(),
  pendingSince = now,
  lastInputAt = 0,
  unsent = 0,
  dragging = false,
  dialogOpen = false,
  focusedDraft = false,
} = {}) {
  if (unsent > 0) return "unsent";
  if (dragging) return "drag";
  const idle = now - (lastInputAt || 0);
  const abandoned = now - pendingSince >= ABANDONED_MS && idle >= ABANDONED_MS;
  if (abandoned) return "";
  if (dialogOpen) return "dialog";
  if (focusedDraft) return "draft";
  if (idle < RECENT_INPUT_MS) return "active";
  return "";
}

/**
 * The kiosk's go / no-go for a version reload, with a last push first.
 *   state() -> the versionReloadBlocker() fields except `unsent`; it is read
 *              again after the push, so `now` and input times are fresh.
 * When nothing but (possibly) unsent edits stands in the way and the source
 * can push on demand (LocalSource.flush(), which never rejects), the outbox is
 * pushed now and the blocker checked again — instead of waiting for the next
 * 3 s poll, and so nothing typed during the push is lost. Resolves to the
 * blocker ("" = reload now).
 */
export async function versionReloadCheck(source, state) {
  const look = () => versionReloadBlocker(Object.assign({}, typeof state === "function" ? state() : state, { unsent: unsentOps(source) }));
  const why = look();
  if ((why !== "" && why !== "unsent") || !source || typeof source.flush !== "function") return why;
  try {
    await source.flush();
  } catch (_) {
    // flush() never rejects; if a source's does, the re-check still decides
  }
  return look();
}

/** True when `el` is a text field / textarea / contenteditable with text in it. */
export function hasDraft(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable) return (el.textContent || "").trim() !== "";
  const tag = el.tagName;
  if (tag === "TEXTAREA") return (el.value || "").trim() !== "";
  if (tag !== "INPUT") return false;
  const type = (el.getAttribute("type") || "text").toLowerCase();
  if (["checkbox", "radio", "button", "submit", "reset", "range", "color", "hidden", "file"].includes(type)) return false;
  return (el.value || "").trim() !== "";
}
