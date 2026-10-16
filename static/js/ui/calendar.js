// "Today & upcoming" calendar card (local mode only; GET api/calendar every 5 min).

import { h } from "./dom.js";
import { icon } from "./icons.js";
import { addDays, dayKey, dayLabel, timeText, untilText } from "./format.js";

const REFRESH_MS = 5 * 60 * 1000;
const $ = (id) => document.getElementById(id);

function parseLocal(s) {
  // Naive local ISO from the Pi ("2026-10-16T14:00:00"): Date() treats it as local time.
  if (typeof s !== "string" || !s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Feed events -> [{e, start, end, isNow}] that haven't ended at `now`.
 * A missing end follows RFC 5545: an all-day event lasts one day, a timed one
 * has no duration — so it is never "Now" and leaves the list once it starts.
 */
export function calendarEntries(events, now = new Date()) {
  return (Array.isArray(events) ? events : [])
    .filter((e) => e && typeof e === "object")
    .map((e) => {
      const start = parseLocal(e.start);
      let end = parseLocal(e.end);
      if (start && (!end || end < start)) end = e.all_day ? addDays(start, 1) : start;
      return { e, start, end };
    })
    .filter((x) => x.start && x.end > now)
    .map((x) => Object.assign(x, { isNow: !x.e.all_day && x.start <= now && x.end > now }));
}

export function initCalendar(ctx, { onRender = null } = {}) {
  const body = $("cal-body");
  const side = $("cal-side");
  let data = null; // {configured, events}
  let failed = false;
  let timer = null;
  let today = 0;

  async function load() {
    try {
      const res = await fetch("api/calendar", { cache: "no-store", headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      failed = false;
    } catch (_) {
      failed = true;
    }
    render();
  }

  function hint() {
    return h(
      "div",
      { class: "cal-hint" },
      h("div", { class: "cal-hint-title" }, icon("calendar"), "Connect a calendar"),
      h(
        "ol",
        {},
        h("li", { text: "In Outlook on the web: Settings → Calendar → Shared calendars → Publish a calendar." }),
        h("li", { text: "Copy the ICS link." }),
        h("li", {}, "Put it in the Pi's config.json as ", h("code", { text: "calendar_ics" }), " and restart Lab Hub."),
      ),
    );
  }

  function render() {
    paint();
    if (onRender) onRender();
  }

  function paint() {
    today = 0;
    if (!data) {
      if (failed) body.replaceChildren(h("div", { class: "card-empty" }, icon("cloud-off"), h("span", { text: "Couldn't load the calendar." })));
      return;
    }
    if (!data.configured) {
      side.textContent = "";
      body.replaceChildren(hint());
      return;
    }
    const now = new Date();
    const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const events = calendarEntries(data.events, now);

    if (!events.length) {
      side.textContent = "";
      body.replaceChildren(h("div", { class: "card-empty" }, icon("calendar"), h("span", { text: "Nothing on the calendar. Enjoy the quiet." })));
      return;
    }

    let nextTimed = null;
    for (const x of events) {
      if (!x.e.all_day && x.start > now && (!nextTimed || x.start < nextTimed.start)) nextTimed = x;
    }

    const groups = new Map();
    for (const x of events) {
      const day = x.start < today0 ? today0 : new Date(x.start.getFullYear(), x.start.getMonth(), x.start.getDate());
      const k = dayKey(day);
      if (!groups.has(k)) groups.set(k, { day, items: [] });
      groups.get(k).items.push(x);
    }

    const nodes = [];
    let todayCount = 0;
    for (const { day, items } of groups.values()) {
      if (dayKey(day) === dayKey(now)) todayCount = items.length;
      nodes.push(h("div", { class: "cal-day" }, h("span", { text: dayLabel(day, now) })));
      for (const x of items) {
        const isNow = x.isNow;
        const isNext = x === nextTimed;
        const sameDayEnd = x.end && dayKey(x.end) === dayKey(x.start) && x.end > x.start;
        const time = x.e.all_day
          ? h("div", { class: "cal-time" }, h("span", { class: "cal-start", text: "All day" }))
          : h(
              "div",
              { class: "cal-time", "aria-label": sameDayEnd ? `${timeText(x.start)} to ${timeText(x.end)}` : timeText(x.start) },
              h("span", { class: "cal-start", text: timeText(x.start) }),
              sameDayEnd ? h("span", { class: "cal-end", text: timeText(x.end) }) : null,
            );
        nodes.push(
          h(
            "div",
            { class: `cal-ev${isNow ? " now" : ""}${isNext ? " next" : ""}${x.e.all_day ? " allday" : ""}` },
            time,
            h(
              "div",
              { class: "cal-main" },
              h("div", { class: "cal-sum" }, h("span", { class: "cal-sum-text", text: x.e.summary || "(untitled)" }), isNow ? h("span", { class: "badge badge-now", text: "Now" }) : isNext ? h("span", { class: "badge badge-next", text: untilText(x.start, now.getTime()) }) : null),
              x.e.location ? h("div", { class: "cal-loc" }, icon("location"), h("span", { text: x.e.location })) : null,
            ),
          ),
        );
      }
    }
    today = todayCount;
    side.textContent = todayCount ? `${todayCount} today` : "";
    body.replaceChildren(...nodes);
  }

  return {
    start() {
      load();
      clearInterval(timer);
      timer = setInterval(load, REFRESH_MS);
    },
    render,
    /** Events left today (for the compact-layout tab badge). */
    todayCount: () => today,
  };
}
