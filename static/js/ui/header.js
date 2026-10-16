// Header: clock + greeting, lab name, sync pill with a details popover.

import { h } from "./dom.js";
import { icon, spinner } from "./icons.js";
import { greeting, plural, relTime } from "./format.js";
import { toast } from "./toast.js";

const $ = (id) => document.getElementById(id);

let clockFmt = null;
function clockParts(d) {
  if (!clockFmt) {
    try {
      clockFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
    } catch (_) {
      clockFmt = null;
    }
  }
  if (clockFmt && clockFmt.formatToParts) {
    const p = {};
    for (const part of clockFmt.formatToParts(d)) p[part.type] = part.value;
    if (p.hour && p.minute) return { hm: `${p.hour}:${p.minute}`, s: p.second || "", ap: p.dayPeriod || "" };
  }
  const pad = (n) => String(n).padStart(2, "0");
  return { hm: `${pad(d.getHours())}:${pad(d.getMinutes())}`, s: pad(d.getSeconds()), ap: "" };
}

/** What the pill shows for a sync object. */
export function pillInfo(sync) {
  const s = sync || {};
  const n = Number.isFinite(s.pending) ? s.pending : 0;
  switch (s.state) {
    case "ok":
      return { tone: "ok", icon: "check", text: s.last_sync ? `Synced · ${relTime(s.last_sync)}` : "Synced", title: "All changes synced" };
    case "syncing":
    case "starting":
      return { tone: "busy", icon: null, text: "Syncing…", title: "Syncing with GitHub" };
    case "pending":
      return { tone: "warn", icon: "clock", text: `${plural(n, "change")} waiting`, title: `${plural(n, "change")} waiting to sync` };
    case "offline":
      return { tone: "warn", icon: "cloud-off", text: "Offline — saved locally", title: s.mode === "local" ? "Can't reach the lab server" : "Can't reach GitHub" };
    case "error":
      return { tone: "error", icon: "alert", text: "Sync error", title: "Sync problem" };
    case "readonly":
      return { tone: "muted", icon: "eye", text: "Read-only", title: "Viewing read-only" };
    case "off":
      return { tone: "muted", icon: "cloud-off", text: "GitHub sync off", title: "Saved on the lab Pi only" };
    default:
      return { tone: "muted", icon: null, text: "Connecting…", title: "Connecting" };
  }
}

export function initHeader(ctx, { onSyncNow, onSettings, onForget, onTheme }) {
  const els = {
    hm: $("clock-hm"),
    s: $("clock-s"),
    ap: $("clock-ap"),
    greet: $("greeting"),
    date: $("date"),
    pill: $("sync-pill"),
    pillIco: $("sync-ico"),
    pillText: $("sync-text"),
    pop: $("sync-pop"),
    theme: $("theme-btn"),
    settings: $("settings-btn"),
    name: $("lab-name"),
    sub: $("lab-sub"),
  };
  let lastDate = "";
  let lastPillKey = "";
  let busy = false;

  function tick() {
    const now = new Date();
    const p = clockParts(now);
    if (els.hm.textContent !== p.hm) els.hm.textContent = p.hm;
    els.s.textContent = p.s;
    if (els.ap.textContent !== p.ap) els.ap.textContent = p.ap;
    const dk = now.toDateString() + now.getHours();
    if (dk !== lastDate) {
      lastDate = dk;
      els.date.replaceChildren(
        h("span", { class: "date-long", text: now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) }),
        h("span", { class: "date-short", text: now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) }),
      );
      els.greet.textContent = greeting(now);
    }
  }

  function renderPill() {
    const info = pillInfo(ctx.sync);
    const key = `${info.tone}|${info.icon}|${info.text}`;
    if (key === lastPillKey) return;
    lastPillKey = key;
    els.pill.className = `sync-pill tone-${info.tone}`;
    els.pill.title = info.title;
    els.pill.setAttribute("aria-label", `Sync status: ${info.text}. Show details`);
    els.pillIco.replaceChildren(info.tone === "busy" ? spinner() : info.icon ? icon(info.icon) : h("span", { class: "sync-dot" }));
    els.pillText.textContent = info.text;
  }

  function row(label, value) {
    return h("div", { class: "pop-row" }, h("dt", { text: label }), h("dd", {}, value));
  }

  function renderPop() {
    if (els.pop.hidden) return;
    const s = ctx.sync || {};
    const info = pillInfo(s);
    const local = ctx.mode === "local";
    const gh = local ? (ctx.config && ctx.config.github) || {} : {};
    const repo = s.repo || gh.repo || "";
    const branch = s.branch || gh.branch || "";
    const path = s.path || gh.path || "";
    const fileUrl = s.file_url || gh.file_url || "";
    const headline = {
      ok: "Everything is synced",
      busy: "Syncing…",
      warn: s.state === "offline" ? (local ? "Can't reach the lab server" : "Can't reach GitHub") : "Changes waiting to sync",
      error: "Sync problem",
      muted: s.state === "readonly" ? "Read-only view" : s.state === "off" ? "GitHub sync is off" : "Connecting…",
    }[info.tone];
    const explain =
      s.state === "off"
        ? "The board is saved on the lab Pi only. Set github_repo and a token on the Pi to edit from anywhere."
        : s.state === "readonly"
          ? "You can see the board but not change it. Add a GitHub token in Settings to edit."
          : s.state === "offline"
            ? "Edits are kept safely on this device and will sync automatically when the connection is back."
            : "";

    const where = h("span", { class: "pop-faint pop-block", text: `${branch} · ${path}` });
    const fileLink = fileUrl
      ? [h("a", { href: fileUrl, target: "_blank", rel: "noopener noreferrer", class: "pop-link" }, icon("github"), h("span", { text: repo })), where]
      : repo
        ? [h("span", { class: "pop-block", text: repo }), where]
        : "—";

    const syncBtn = h(
      "button",
      { type: "button", class: "btn btn-primary sm", disabled: busy || s.state === "off" },
      busy ? spinner() : icon("refresh"),
      busy ? "Syncing…" : "Sync now",
    );
    syncBtn.addEventListener("click", async () => {
      busy = true;
      renderPop();
      try {
        await onSyncNow();
      } catch (e) {
        toast({ message: (e && e.message) || "Sync failed", kind: "error" });
      } finally {
        busy = false;
        renderPop();
      }
    });

    const buttons = [syncBtn];
    if (!local) {
      buttons.push(
        h("button", { type: "button", class: "btn btn-ghost sm", onClick: () => { closePop(); onSettings(); } }, icon("settings"), "Settings"),
      );
      if (ctx.settings && ctx.settings.token) {
        buttons.push(h("button", { type: "button", class: "btn btn-ghost sm danger-text", onClick: () => { closePop(); onForget(); } }, icon("key"), "Forget token"));
      }
    }

    const parts = [
      h(
        "div",
        { class: `pop-head tone-${info.tone}` },
        h("span", { class: "pop-ico" }, info.tone === "busy" ? spinner() : icon(info.icon || "cloud")),
        h("div", {}, h("div", { class: "pop-title", text: headline }), explain ? h("div", { class: "pop-sub", text: explain }) : null),
      ),
      h(
        "dl",
        { class: "pop-rows" },
        row("Mode", local ? "Lab display (Raspberry Pi)" : ctx.canEdit ? "This browser ↔ GitHub" : "This browser (read-only)"),
        row("Board file", fileLink),
        row("Last sync", s.last_sync ? relTime(s.last_sync) : "—"),
        row("Last push", s.last_push ? relTime(s.last_push) : "—"),
        row("Waiting", s.pending ? plural(s.pending, "change") : "Nothing"),
      ),
      s.last_error ? h("div", { class: "pop-error", role: "note" }, icon("alert"), h("span", { text: s.last_error })) : null,
      h("div", { class: "pop-actions" }, buttons),
    ];
    els.pop.replaceChildren(...parts.filter(Boolean)); // replaceChildren(null) would render "null"
  }

  function openPop() {
    els.pop.hidden = false;
    els.pill.setAttribute("aria-expanded", "true");
    renderPop();
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", onKey, true);
  }
  function closePop() {
    if (els.pop.hidden) return;
    els.pop.hidden = true;
    els.pill.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", onKey, true);
  }
  function outside(e) {
    if (!els.pop.contains(e.target) && !els.pill.contains(e.target)) closePop();
  }
  function onKey(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      closePop();
      els.pill.focus();
    }
  }

  els.pill.addEventListener("click", () => (els.pop.hidden ? openPop() : closePop()));
  els.theme.addEventListener("click", onTheme);
  els.settings.addEventListener("click", onSettings);

  tick();
  setInterval(tick, 1000);

  return {
    render() {
      renderPill();
      renderPop();
    },
    /** Relative-time refresh (cheap: text only). */
    refresh() {
      lastPillKey = "";
      renderPill();
      renderPop();
    },
    setName(name, sub) {
      els.name.textContent = name;
      els.sub.textContent = sub || "";
      els.sub.hidden = !sub;
      document.title = name && name !== "Lab Hub" ? `${name} · Lab Hub` : "Lab Hub";
    },
    closePop,
  };
}
