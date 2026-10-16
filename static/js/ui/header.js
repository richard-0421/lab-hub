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

  // The popover is built once per open (and again only if its set of buttons
  // changes); later renders — every sync emission and the 10 s refresh —
  // update text and attributes in place, so a focused button or a click in
  // progress is never swept away.
  let pop = null;

  function row(label) {
    const dd = h("dd", {});
    return { el: h("div", { class: "pop-row" }, h("dt", { text: label }), dd), dd };
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function buildPop(local, hasToken) {
    const p = { key: `${local}|${hasToken}` };
    p.ico = h("span", { class: "pop-ico" });
    p.title = h("div", { class: "pop-title" });
    p.sub = h("div", { class: "pop-sub", hidden: true });
    p.head = h("div", { class: "pop-head" }, p.ico, h("div", {}, p.title, p.sub));
    p.mode = row("Mode");
    p.file = row("Board file");
    p.lastSync = row("Last sync");
    p.lastPush = row("Last push");
    p.waiting = row("Waiting");
    p.errText = h("span");
    p.err = h("div", { class: "pop-error", role: "note", hidden: true }, icon("alert"), p.errText);
    p.syncIco = h("span", { class: "btn-ico" });
    p.syncLabel = h("span");
    p.syncBtn = h("button", { type: "button", class: "btn btn-primary sm", "data-act": "sync" }, p.syncIco, p.syncLabel);
    p.syncBtn.addEventListener("click", async () => {
      // aria-disabled (not disabled) while busy: disabling the focused button
      // would drop keyboard focus to <body>.
      if (busy || p.syncBtn.disabled) return;
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
    const buttons = [p.syncBtn];
    if (!local) {
      buttons.push(h("button", { type: "button", class: "btn btn-ghost sm", "data-act": "settings", onClick: () => { closePop(); onSettings(); } }, icon("settings"), "Settings"));
      if (hasToken) {
        buttons.push(h("button", { type: "button", class: "btn btn-ghost sm danger-text", "data-act": "forget", onClick: () => { closePop(); onForget(); } }, icon("key"), "Forget token"));
      }
    }
    p.nodes = [
      p.head,
      h("dl", { class: "pop-rows" }, p.mode.el, p.file.el, p.lastSync.el, p.lastPush.el, p.waiting.el),
      p.err,
      h("div", { class: "pop-actions" }, buttons),
    ];
    p.icoKey = "";
    p.fileKey = null;
    p.busyKey = null;
    return p;
  }

  function renderPop() {
    if (els.pop.hidden) return;
    const s = ctx.sync || {};
    const info = pillInfo(s);
    const local = ctx.mode === "local";
    const hasToken = !local && !!(ctx.settings && ctx.settings.token);
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

    const key = `${local}|${hasToken}`;
    if (!pop || pop.key !== key) {
      const a = document.activeElement;
      const act = a && els.pop.contains(a) && a.closest ? (a.closest("[data-act]") || {}).dataset : null;
      pop = buildPop(local, hasToken);
      els.pop.replaceChildren(...pop.nodes);
      const again = act && act.act ? els.pop.querySelector(`[data-act="${act.act}"]`) : null;
      if (again) again.focus();
    }
    const p = pop;

    p.head.className = `pop-head tone-${info.tone}`;
    const icoKey = info.tone === "busy" ? "busy" : info.icon || "cloud";
    if (p.icoKey !== icoKey) {
      p.icoKey = icoKey;
      p.ico.replaceChildren(info.tone === "busy" ? spinner() : icon(icoKey));
    }
    setText(p.title, headline);
    setText(p.sub, explain);
    p.sub.hidden = !explain;

    setText(p.mode.dd, local ? "Lab display (Raspberry Pi)" : ctx.canEdit ? "This browser ↔ GitHub" : "This browser (read-only)");
    const fileKey = `${fileUrl}|${repo}|${branch}|${path}`;
    if (p.fileKey !== fileKey) {
      p.fileKey = fileKey;
      const where = h("span", { class: "pop-faint pop-block", text: `${branch} · ${path}` });
      p.file.dd.replaceChildren(
        ...(fileUrl
          ? [h("a", { href: fileUrl, target: "_blank", rel: "noopener noreferrer", class: "pop-link", "data-act": "file" }, icon("github"), h("span", { text: repo })), where]
          : repo
            ? [h("span", { class: "pop-block", text: repo }), where]
            : ["—"]),
      );
    }
    setText(p.lastSync.dd, s.last_sync ? relTime(s.last_sync) : "—");
    setText(p.lastPush.dd, s.last_push ? relTime(s.last_push) : "—");
    setText(p.waiting.dd, s.pending ? plural(s.pending, "change") : "Nothing");
    setText(p.errText, s.last_error || "");
    p.err.hidden = !s.last_error;

    p.syncBtn.disabled = s.state === "off";
    if (busy) p.syncBtn.setAttribute("aria-disabled", "true");
    else p.syncBtn.removeAttribute("aria-disabled");
    if (p.busyKey !== busy) {
      p.busyKey = busy;
      p.syncIco.replaceChildren(busy ? spinner() : icon("refresh"));
      setText(p.syncLabel, busy ? "Syncing…" : "Sync now");
    }
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
    pop = null;
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
