// The task board: toolbar (quick-add, search, filters, sort), three columns,
// cards, keyboard control and drag & drop.

import { h, reconcile, NodeCache, captureFocus, restoreFocus, focusKey, armButton } from "./dom.js";
import { icon } from "./icons.js";
import { parseQuickAdd, formatDueLabel } from "../quickadd.js";
import { opAdd, opDelete, opUpdate, planMove, rankBetween, nowIso } from "../board.js";
import { relTime, initials, hueOf, dayKey, dueDateText, plural, quote } from "./format.js";
import { perform } from "./actions.js";
import { openTaskEditor } from "./task-editor.js";
import { initDnD } from "./dnd.js";
import { openMenu, closeMenu } from "./menu.js";
import { toast } from "./toast.js";
import { pset, SORT_KEY } from "./prefs.js";

export const STATUSES = ["todo", "doing", "done"];
export const STATUS_LABEL = { todo: "To do", doing: "In progress", done: "Done" };
const PRIO_RANK = { high: 0, normal: 1, low: 2 };
const PRIO_LABEL = { high: "High", normal: "Normal", low: "Low" };

const EMPTY = {
  todo: { icon: "sparkle", title: "Nothing to do", sub: "Add a task above — it lands right here." },
  doing: { icon: "play", title: "Nothing in progress", sub: "Drag a task here when you start on it." },
  done: { icon: "check", title: "No finished tasks yet", sub: "Tick a task to complete it." },
};

const $ = (id) => document.getElementById(id);

export function initTasks(ctx) {
  const columnsEl = $("columns");
  const tabsEl = $("status-tabs");
  const cols = {};
  for (const sec of columnsEl.querySelectorAll(".column")) {
    cols[sec.dataset.status] = { sec, list: sec.querySelector(".col-list"), count: sec.querySelector(".col-count") };
  }
  const tabs = {};
  for (const b of tabsEl.querySelectorAll(".status-tab")) tabs[b.dataset.status] = b;
  const qa = $("qa-input");
  const qaPreview = $("qa-preview");
  const search = $("search");
  const searchClear = $("search-clear");
  const assigneeSel = $("filter-assignee");
  const sortSel = $("sort");
  const openCount = $("open-count");
  const clearDoneBtn = $("clear-done");

  const cache = new NodeCache();
  let firstRender = true;
  let pendingFocus = null;
  let namesKey = "";

  // ------------------------------------------------------------ model views
  const find = (id) => ctx.board.tasks.find((t) => t.id === id) || null;
  const byStatus = (status) => ctx.board.tasks.filter((t) => t.status === status); // rank order
  const filterActive = () => ctx.ui.search.trim() !== "" || ctx.ui.assignee !== "";
  const canReorder = (status) => ctx.canEdit && status !== "done" && ctx.ui.sort === "manual" && !filterActive();

  function matches(t) {
    const q = ctx.ui.search.trim().toLowerCase();
    if (q) {
      const hay = `${t.title}\n${t.notes}\n${t.assignee}\n${t.tags.map((x) => `#${x}`).join(" ")}`.toLowerCase();
      if (!q.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    const who = ctx.ui.assignee;
    if (who === "__none__") return !t.assignee;
    if (who) return t.assignee.toLowerCase() === who.toLowerCase();
    return true;
  }

  function sorted(list, status) {
    if (status === "done") {
      return list.slice().sort((a, b) => (a.done_at < b.done_at ? 1 : a.done_at > b.done_at ? -1 : a.updated_at < b.updated_at ? 1 : -1));
    }
    const idx = new Map(list.map((t, i) => [t.id, i]));
    if (ctx.ui.sort === "priority") {
      return list.slice().sort((a, b) => PRIO_RANK[a.priority] - PRIO_RANK[b.priority] || idx.get(a.id) - idx.get(b.id));
    }
    if (ctx.ui.sort === "due") {
      return list.slice().sort((a, b) => {
        if (a.due !== b.due) {
          if (!a.due) return 1;
          if (!b.due) return -1;
          return a.due < b.due ? -1 : 1;
        }
        return PRIO_RANK[a.priority] - PRIO_RANK[b.priority] || idx.get(a.id) - idx.get(b.id);
      });
    }
    return list;
  }

  function columnsData() {
    const all = { todo: [], doing: [], done: [] };
    for (const t of ctx.board.tasks) (all[t.status] || all.todo).push(t);
    const shown = {};
    for (const s of STATUSES) shown[s] = sorted(all[s].filter(matches), s);
    return { all, shown };
  }

  // ------------------------------------------------------------------ cards
  function chip(cls, ico, label, title) {
    return h("span", { class: `chip ${cls}`, title }, ico ? icon(ico) : null, h("span", { text: label }));
  }

  function ariaLabel(t, due) {
    const parts = [t.title, STATUS_LABEL[t.status]];
    if (t.priority !== "normal") parts.push(`${PRIO_LABEL[t.priority]} priority`);
    if (due.label) parts.push(`due ${due.label}`);
    if (t.assignee) parts.push(`assigned to ${t.assignee}`);
    if (t.tags.length) parts.push(`tags ${t.tags.join(", ")}`);
    return parts.join(", ");
  }

  function buildCard(t) {
    const done = t.status === "done";
    const due = done ? { label: "", tone: "" } : formatDueLabel(t.due);
    const meta = [];
    if (t.priority === "high") meta.push(chip("prio prio-high", "flag", "High"));
    else if (t.priority === "low") meta.push(chip("prio prio-low", "flag", "Low"));
    if (due.label) meta.push(chip(`due due-${due.tone}`, "calendar", due.label, dueDateText(t.due)));
    for (const tag of t.tags) meta.push(h("span", { class: "chip tag", text: `#${tag}` }));
    if (done && t.done_at) meta.push(h("span", { class: "done-when", dataset: { rel: t.done_at, relPrefix: "Done " }, text: `Done ${relTime(t.done_at)}` }));

    return h(
      "article",
      {
        class: ["task", `st-${t.status}`, `prio-${t.priority}`, done && "is-done"],
        tabindex: 0,
        role: "listitem",
        dataset: { key: `task:${t.id}`, id: t.id },
        "aria-label": ariaLabel(t, due),
      },
      h(
        "button",
        {
          type: "button",
          class: "task-check",
          "data-role": "check",
          tabindex: -1,
          "aria-label": done ? "Mark as not done" : "Mark as done",
          "aria-pressed": done ? "true" : "false",
          disabled: !ctx.canEdit,
        },
        h("span", { class: "check-ring" }, icon("check")),
      ),
      h("div", { class: "task-body" }, h("div", { class: "task-title", text: t.title }), meta.length ? h("div", { class: "task-meta" }, meta) : null),
      h(
        "div",
        { class: "task-side" },
        h(
          "span",
          { class: "avatar-slot" },
          t.assignee ? h("span", { class: "avatar", style: { "--h": hueOf(t.assignee) }, title: t.assignee, "aria-hidden": "true", text: initials(t.assignee) }) : null,
          ctx.canEdit ? h("button", { type: "button", class: "task-more", "data-role": "more", tabindex: -1, "aria-label": `More actions for ${t.title}`, "aria-haspopup": "menu" }, icon("more")) : null,
        ),
        t.notes ? h("span", { class: "meta-ico", title: "Has notes" }, icon("text")) : null,
      ),
    );
  }

  function emptyState(status, total) {
    if (!ctx.loaded) {
      const st = ctx.sync && ctx.sync.state;
      if (status === "todo" && (st === "error" || st === "offline")) {
        return h(
          "div",
          { class: "col-empty is-error", role: "status" },
          h("span", { class: "col-empty-ico" }, icon(st === "offline" ? "cloud-off" : "alert")),
          h("div", { class: "col-empty-title", text: "Can't load the board yet" }),
          h("div", { class: "col-empty-sub", text: (ctx.sync && ctx.sync.last_error) || "Retrying automatically." }),
        );
      }
      return h("div", { class: "col-skeleton", "aria-hidden": "true" }, h("div", { class: "sk" }), status === "todo" ? h("div", { class: "sk" }) : null, h("div", { class: "sk short" }));
    }
    const e = EMPTY[status];
    const filtered = total > 0 && filterActive();
    return h(
      "div",
      { class: "col-empty" },
      h("span", { class: "col-empty-ico" }, icon(filtered ? "search" : e.icon)),
      h("div", { class: "col-empty-title", text: filtered ? "No matches" : e.title }),
      h("div", { class: "col-empty-sub", text: filtered ? `${plural(total, "task")} hidden by the filter` : e.sub }),
    );
  }

  // ----------------------------------------------------------------- render
  function render() {
    const saved = captureFocus();
    const { all, shown } = columnsData();
    const today = dayKey();
    const editKey = ctx.canEdit ? "e" : "r";
    cache.begin();
    for (const s of STATUSES) {
      const c = cols[s];
      const nodes = shown[s].map((t) => {
        const key = `task:${t.id}`;
        const el = cache.get(key, `${today}|${editKey}|${JSON.stringify(t)}`, () => buildCard(t));
        if (!firstRender && cache.isNew(key)) el.classList.add("enter");
        return el;
      });
      const syncKey = ctx.loaded ? "" : `${ctx.sync && ctx.sync.state}|${ctx.sync && ctx.sync.last_error}`;
      if (!nodes.length) nodes.push(cache.get(`empty:${s}`, `${ctx.loaded}|${syncKey}|${all[s].length}|${filterActive()}`, () => emptyState(s, all[s].length)));
      reconcile(c.list, nodes);
      const n = all[s].length;
      c.count.textContent = filterActive() ? `${shown[s].length}/${n}` : String(n);
      c.sec.classList.toggle("no-reorder", !canReorder(s));
      const tc = tabs[s].querySelector(".tab-count");
      tc.textContent = String(filterActive() ? shown[s].length : n);
    }
    cache.end();

    const open = all.todo.length + all.doing.length;
    openCount.textContent = `${open} open`;
    openCount.hidden = !ctx.loaded;
    const doneN = all.done.length;
    clearDoneBtn.hidden = !ctx.canEdit || doneN === 0;
    renderAssignees();
    restoreFocus(saved);
    if (pendingFocus) {
      const k = pendingFocus;
      pendingFocus = null;
      focusKey(k);
    }
    firstRender = !ctx.loaded;
  }

  function renderAssignees() {
    const seen = new Map();
    let unassigned = false;
    for (const t of ctx.board.tasks) {
      if (!t.assignee) unassigned = true;
      else if (!seen.has(t.assignee.toLowerCase())) seen.set(t.assignee.toLowerCase(), t.assignee);
    }
    const names = Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
    const cur = ctx.ui.assignee;
    if (cur && cur !== "__none__" && !seen.has(cur.toLowerCase())) names.push(cur);
    const key = `${names.join("\n")}|${unassigned}`;
    if (key === namesKey) return;
    namesKey = key;
    assigneeSel.replaceChildren(
      h("option", { value: "", text: "Everyone" }),
      ...names.map((n) => h("option", { value: n, text: n })),
      unassigned || cur === "__none__" ? h("option", { value: "__none__", text: "Unassigned" }) : null,
    );
    assigneeSel.value = cur;
  }

  /** Re-render the "Done 2h ago" labels without rebuilding cards. */
  function refreshRelative() {
    for (const el of columnsEl.querySelectorAll("[data-rel]")) {
      el.textContent = `${el.dataset.relPrefix || ""}${relTime(el.dataset.rel)}`;
    }
  }

  // ---------------------------------------------------------------- actions
  const by = () => ctx.by();

  function complete(t) {
    return perform(ctx, [opUpdate("tasks", t.id, { status: "done", done_at: nowIso() }, by())], { undo: `Completed ${quote(t.title)}` });
  }

  function toggleDone(t) {
    if (t.status !== "done") return complete(t);
    const todo = byStatus("todo");
    const set = { status: "todo", done_at: "", rank: rankBetween(null, todo.length ? todo[0].rank : null) };
    return perform(ctx, [opUpdate("tasks", t.id, set, by())], { undo: `Moved ${quote(t.title)} back to To do` });
  }

  function remove(t) {
    return perform(ctx, [opDelete("tasks", t.id, by())], { undo: `Deleted ${quote(t.title)}` });
  }

  function clearDone() {
    const done = byStatus("done");
    if (!done.length) return;
    perform(
      ctx,
      done.map((t) => opDelete("tasks", t.id, by())),
      { undo: `Cleared ${plural(done.length, "finished task")}` },
    );
  }

  /** Drop handler (drag & drop, menu, keyboard): move `id` to `status` at `index` of its manual order. */
  function moveTo(id, status, index) {
    const t = find(id);
    if (!t) return;
    if (status === "done") {
      if (t.status !== "done") complete(t);
      return;
    }
    const list = byStatus(status).filter((x) => x.id !== id);
    const set = {};
    if (t.status !== status) {
      set.status = status;
      if (t.status === "done") set.done_at = "";
    } else {
      const orig = byStatus(status).findIndex((x) => x.id === id);
      if (orig === index) return;
    }
    const ops = planMove({ list, id, toIndex: index, set, by: by() });
    perform(ctx, ops, t.status === "done" ? { undo: `Moved ${quote(t.title)} back to ${STATUS_LABEL[status]}` } : {});
  }

  function moveWithin(t, dir) {
    if (!canReorder(t.status)) {
      toast({ message: t.status === "done" ? "Done is ordered by completion time." : "Switch to Manual order and clear filters to reorder." });
      return;
    }
    const full = byStatus(t.status);
    const i = full.findIndex((x) => x.id === t.id);
    const to = i + dir;
    if (i < 0 || to < 0 || to > full.length - 1) return;
    pendingFocus = `task:${t.id}`;
    moveTo(t.id, t.status, to);
  }

  function moveAcross(t, dir) {
    const i = STATUSES.indexOf(t.status);
    const target = STATUSES[i + dir];
    if (!target) return;
    pendingFocus = `task:${t.id}`;
    if (ctx.isPhone()) setTab(target);
    moveTo(t.id, target, 0);
  }

  function openEditor(t) {
    closeMenu();
    openTaskEditor(ctx, { task: t });
  }

  function newTask(status = "todo") {
    openTaskEditor(ctx, { status });
  }

  function cardMenu(t, anchor) {
    const items = [{ label: "Open", icon: "text", run: () => openEditor(t) }, "sep"];
    for (const s of STATUSES) {
      if (s !== t.status) items.push({ label: `Move to ${STATUS_LABEL[s]}`, dot: s, run: () => moveTo(t.id, s, 0) });
    }
    const col = byStatus(t.status);
    if (canReorder(t.status) && col[0] && col[0].id !== t.id) {
      items.push({ label: "Move to top", icon: "arrowUp", run: () => moveTo(t.id, t.status, 0) });
    }
    items.push("sep", { label: "Delete", icon: "trash", danger: true, run: () => remove(t) });
    openMenu(anchor, items, { label: `Actions for ${t.title}` });
  }

  // ---------------------------------------------------------- quick add
  function previewChip(ico, text, cls = "") {
    return h("span", { class: `chip ${cls}`.trim() }, icon(ico), h("span", { text }));
  }

  function renderPreview() {
    const text = qa.value;
    if (!text.trim()) {
      qaPreview.hidden = true;
      return;
    }
    const p = parseQuickAdd(text);
    const chips = [];
    if (p.assignee) {
      const known = ctx.knownNames().find((n) => n.toLowerCase() === p.assignee.toLowerCase());
      chips.push(previewChip("user", known || p.assignee));
    }
    if (p.priority) chips.push(previewChip("flag", `${PRIO_LABEL[p.priority]} priority`, `prio prio-${p.priority}`));
    if (p.due) {
      const d = formatDueLabel(p.due);
      chips.push(previewChip("calendar", `${dueDateText(p.due)}`, `due due-${d.tone}`));
    }
    for (const tg of p.tags) chips.push(h("span", { class: "chip tag", text: `#${tg}` }));
    if (!chips.length) {
      qaPreview.hidden = true;
      return;
    }
    qaPreview.replaceChildren(
      h("span", { class: `qa-prev-title${p.title ? "" : " empty"}`, text: p.title || "Add a title" }),
      h("span", { class: "qa-prev-chips" }, chips),
    );
    qaPreview.hidden = false;
  }

  function quickAdd() {
    const text = qa.value;
    const p = parseQuickAdd(text);
    if (!p.title) {
      qa.parentElement.classList.remove("nudge");
      void qa.offsetWidth;
      qa.parentElement.classList.add("nudge");
      return;
    }
    const todo = byStatus("todo");
    const name = ctx.name();
    // "@jordan" -> "Jordan" when that person is already known.
    const known = p.assignee ? ctx.knownNames().find((n) => n.toLowerCase() === p.assignee.toLowerCase()) : "";
    const item = {
      title: p.title,
      assignee: known || p.assignee,
      priority: p.priority || "normal",
      tags: p.tags,
      due: p.due,
      status: "todo",
      rank: rankBetween(null, todo.length ? todo[0].rank : null),
      created_by: name,
    };
    const op = opAdd("tasks", item, by());
    qa.value = "";
    renderPreview();
    if (ctx.isPhone()) setTab("todo");
    perform(ctx, [op]).then((ok) => {
      if (!ok) {
        if (!qa.value) qa.value = text;
        renderPreview();
        return;
      }
      const added = find(op.item.id);
      if (added && !matches(added)) toast({ message: `Added ${quote(added.title)} — hidden by the current filter` });
    });
  }

  qa.addEventListener("input", renderPreview);
  qa.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      quickAdd();
    } else if (e.key === "Escape") {
      if (qa.value) {
        qa.value = "";
        renderPreview();
      } else qa.blur();
    }
  });
  qa.addEventListener("blur", () => setTimeout(() => (qaPreview.hidden = true), 120));
  qa.addEventListener("focus", renderPreview);

  // ------------------------------------------------------- search / filters
  search.addEventListener("input", () => {
    ctx.ui.search = search.value;
    searchClear.hidden = !search.value;
    ctx.requestRender();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) {
      e.preventDefault();
      search.value = "";
      search.dispatchEvent(new Event("input"));
    }
  });
  searchClear.addEventListener("click", () => {
    search.value = "";
    search.dispatchEvent(new Event("input"));
    search.focus();
  });
  assigneeSel.addEventListener("change", () => {
    ctx.ui.assignee = assigneeSel.value;
    assigneeSel.parentElement.classList.toggle("active", !!assigneeSel.value);
    ctx.requestRender();
  });
  sortSel.value = ctx.ui.sort;
  sortSel.parentElement.classList.toggle("active", ctx.ui.sort !== "manual");
  sortSel.addEventListener("change", () => {
    ctx.ui.sort = sortSel.value;
    pset(SORT_KEY, sortSel.value === "manual" ? "" : sortSel.value);
    sortSel.parentElement.classList.toggle("active", ctx.ui.sort !== "manual");
    ctx.requestRender();
  });

  $("new-task").addEventListener("click", () => newTask("todo"));
  $("fab").addEventListener("click", () => newTask(ctx.ui.tab === "doing" ? "doing" : "todo"));
  for (const b of columnsEl.querySelectorAll(".col-add")) b.addEventListener("click", () => newTask(b.dataset.status));
  armButton(clearDoneBtn, () => `Clear ${byStatus("done").length}?`, clearDone);

  // ----------------------------------------------------- phone status tabs
  function setTab(s) {
    ctx.ui.tab = s;
    columnsEl.dataset.tab = s;
    for (const k of STATUSES) {
      tabs[k].setAttribute("aria-selected", k === s ? "true" : "false");
      tabs[k].tabIndex = k === s ? 0 : -1;
    }
  }
  for (const s of STATUSES) tabs[s].addEventListener("click", () => setTab(s));
  tabsEl.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = STATUSES.indexOf(ctx.ui.tab) + (e.key === "ArrowRight" ? 1 : -1);
    const s = STATUSES[(i + 3) % 3];
    setTab(s);
    tabs[s].focus();
  });
  setTab(ctx.ui.tab);

  // ------------------------------------------------------ pointer & keys
  const dnd = initDnD({
    ctx,
    columnsEl,
    tabsEl,
    canReorder,
    onDrop: (id, status, index) => {
      if (ctx.isPhone() && status !== ctx.ui.tab) setTab(status);
      moveTo(id, status, index);
    },
    onEnd: () => ctx.requestRender(),
  });

  columnsEl.addEventListener("click", (e) => {
    if (dnd.justDragged()) return;
    const card = e.target.closest(".task");
    if (!card) return;
    const t = find(card.dataset.id);
    if (!t) return;
    if (e.target.closest(".task-check")) {
      if (ctx.canEdit) toggleDone(t);
      return;
    }
    const more = e.target.closest(".task-more");
    if (more) {
      cardMenu(t, more);
      return;
    }
    openEditor(t);
  });

  function neighbourCard(card, dir) {
    const list = card.parentElement;
    const cards = Array.from(list.querySelectorAll(".task"));
    return cards[cards.indexOf(card) + dir] || null;
  }

  function sideCard(card, dir) {
    const sec = card.closest(".column");
    const i = STATUSES.indexOf(sec.dataset.status);
    const index = Array.from(sec.querySelectorAll(".task")).indexOf(card);
    for (let j = i + dir; j >= 0 && j < STATUSES.length; j += dir) {
      const cards = Array.from(cols[STATUSES[j]].list.querySelectorAll(".task"));
      if (cards.length) return cards[Math.min(index, cards.length - 1)];
    }
    return null;
  }

  columnsEl.addEventListener("keydown", (e) => {
    const card = e.target;
    if (!card.classList || !card.classList.contains("task")) return;
    const t = find(card.dataset.id);
    if (!t) return;
    const k = e.key;
    if (k === "Enter") {
      e.preventDefault();
      openEditor(t);
    } else if (k === " " || k === "Spacebar") {
      e.preventDefault();
      if (!ctx.canEdit) return;
      pendingFocus = `task:${t.id}`;
      toggleDone(t);
    } else if (e.altKey && (k === "ArrowUp" || k === "ArrowDown")) {
      e.preventDefault();
      if (ctx.canEdit) moveWithin(t, k === "ArrowUp" ? -1 : 1);
    } else if (e.altKey && (k === "ArrowLeft" || k === "ArrowRight")) {
      e.preventDefault();
      if (ctx.canEdit) moveAcross(t, k === "ArrowLeft" ? -1 : 1);
    } else if (k === "Delete" || k === "Backspace") {
      e.preventDefault();
      if (!ctx.canEdit) return;
      const next = neighbourCard(card, 1) || neighbourCard(card, -1);
      if (next) pendingFocus = next.dataset.key;
      remove(t);
    } else if (!e.altKey && !e.metaKey && !e.ctrlKey && (k === "ArrowUp" || k === "ArrowDown")) {
      const n = neighbourCard(card, k === "ArrowUp" ? -1 : 1);
      if (n) {
        e.preventDefault();
        n.focus();
      }
    } else if (!e.altKey && !e.metaKey && !e.ctrlKey && (k === "ArrowLeft" || k === "ArrowRight")) {
      const n = sideCard(card, k === "ArrowLeft" ? -1 : 1);
      if (n) {
        e.preventDefault();
        n.focus();
      }
    }
  });

  return {
    render,
    refreshRelative,
    focusQuickAdd() {
      if (ctx.canEdit) {
        qa.focus();
        qa.select();
      } else search.focus();
    },
    focusSearch() {
      search.focus();
      search.select();
    },
    cancelDrag: () => dnd.cancel(),
    resetCache: () => cache.clear(),
  };
}
