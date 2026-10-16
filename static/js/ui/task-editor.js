// Task editor dialog (bottom sheet on phones). Saving emits ONE op:
//   new task      -> add (created_by = remembered name, top of its column)
//   existing task -> update with ONLY the fields the user changed (diffed
//                    against the task as it was when the dialog opened, so a
//                    concurrent edit of another field elsewhere survives).
//   Status into Done sets done_at; out of Done clears it.

import { h, autoGrow, armButton } from "./dom.js";
import { icon } from "./icons.js";
import { openDialog, field, group, segmented, tagInput } from "./dialog.js";
import { cleanString, normalizeItem, nowIso, opAdd, opDelete, opUpdate, rankBetween } from "../board.js";
import { perform } from "./actions.js";
import { addDays, dayKey, quote, relTime, shortDate } from "./format.js";
import { toast } from "./toast.js";

const EDIT_FIELDS = ["title", "notes", "status", "priority", "assignee", "due", "tags"];

const same = (a, b) => (Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : a === b);

export function openTaskEditor(ctx, { task = null, status = "todo" } = {}) {
  const isNew = !task;
  const ro = !ctx.canEdit;
  const snap = task ? JSON.parse(JSON.stringify(task)) : null;
  const init = snap || { title: "", notes: "", status, priority: "normal", assignee: "", due: "", tags: [] };

  // ---------------------------------------------------------------- fields
  const title = h("textarea", {
    class: "ed-title",
    rows: 1,
    placeholder: "What needs doing?",
    maxlength: 300,
    value: init.title,
    disabled: ro,
    "aria-label": "Title",
    spellcheck: "true",
  });
  autoGrow(title);
  const titleErr = h("div", { class: "fld-error", role: "alert", hidden: true }, icon("alert"), "Give the task a title");
  title.addEventListener("input", () => (titleErr.hidden = true));
  title.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault(); // titles are single-line; Enter saves
      if (!ro) save();
    }
  });

  const st = segmented(
    "status",
    [
      { value: "todo", label: "To do", dot: true, cls: "s-todo" },
      { value: "doing", label: "In progress", dot: true, cls: "s-doing" },
      { value: "done", label: "Done", dot: true, cls: "s-done" },
    ],
    init.status,
    { disabled: ro },
  );
  const pr = segmented(
    "priority",
    [
      { value: "high", label: "High", icon: "flag", cls: "p-high" },
      { value: "normal", label: "Normal", icon: "flag", cls: "p-normal" },
      { value: "low", label: "Low", icon: "flag", cls: "p-low" },
    ],
    init.priority,
    { disabled: ro },
  );

  const listId = `names-${Math.random().toString(36).slice(2, 8)}`;
  const assignee = h("input", { type: "text", value: init.assignee, placeholder: "Unassigned", list: listId, maxlength: 60, disabled: ro, autocomplete: "off" });
  const datalist = h("datalist", { id: listId }, ctx.knownNames().map((n) => h("option", { value: n })));

  const due = h("input", { type: "date", value: init.due, disabled: ro });
  const today = new Date();
  const nextMon = addDays(today, (1 - today.getDay() + 7) % 7 || 7);
  const dueChips = ro
    ? null
    : h(
        "div",
        { class: "due-chips" },
        [
          ["Today", dayKey(today)],
          ["Tomorrow", dayKey(addDays(today, 1))],
          ["Next Mon", dayKey(nextMon)],
          ["Clear", ""],
        ].map(([label, value]) =>
          h("button", {
            type: "button",
            class: "chip-btn",
            text: label,
            onClick: () => {
              due.value = value;
            },
          }),
        ),
      );

  const tags = tagInput(init.tags, { disabled: ro });
  const notes = h("textarea", { class: "ed-notes", rows: 3, placeholder: ro ? "" : "Details, links, steps…", maxlength: 4000, value: init.notes, disabled: ro });
  autoGrow(notes);

  // ------------------------------------------------------------------ meta
  let meta = null;
  if (snap) {
    const bits = [`Created ${shortDate(new Date(snap.created_at))}`];
    if (snap.created_by) bits.push(`by ${snap.created_by}`);
    if (snap.updated_at && snap.updated_at !== snap.created_at) bits.push(`updated ${relTime(snap.updated_at)}`);
    if (snap.status === "done" && snap.done_at) bits.push(`done ${relTime(snap.done_at)}`);
    meta = h("div", { class: "ed-meta" }, icon("clock"), h("span", { text: bits.join(" · ") }));
  }

  // ---------------------------------------------------------------- footer
  const saveBtn = h("button", { type: "button", class: "btn btn-primary", "data-default": "true" }, icon("check"), isNew ? "Add task" : "Save");
  const cancelBtn = h("button", { type: "button", class: "btn btn-ghost", text: ro ? "Close" : "Cancel" });
  const footer = [];
  if (!isNew && !ro) {
    const del = h("button", { type: "button", class: "btn btn-danger-ghost" }, icon("trash"), "Delete");
    armButton(del, "Confirm delete", () => {
      perform(ctx, [opDelete("tasks", snap.id, ctx.by())], { undo: `Deleted ${quote(snap.title)}` });
      dlg.close();
    });
    footer.push(del);
  }
  footer.push(h("span", { class: "spacer" }), cancelBtn);
  if (!ro) footer.push(saveBtn);

  const dlg = openDialog({
    title: isNew ? "New task" : ro ? "Task" : "Edit task",
    className: "task-editor",
    initialFocus: isNew ? title : null,
    body: [
      h("div", { class: "fld fld-title" }, title, titleErr),
      h("div", { class: "ed-grid" }, group("Status", st.el, "span-2"), group("Priority", pr.el, "span-2")),
      h(
        "div",
        { class: "ed-grid" },
        field("Assignee", assignee),
        h("div", { class: "fld" }, h("label", { class: "fld-label", for: (due.id = `due-${listId}`), text: "Due date" }), due, dueChips),
      ),
      datalist,
      group("Tags", tags.el),
      field("Notes", notes),
      meta,
    ],
    footer,
  });
  cancelBtn.addEventListener("click", () => dlg.close());
  saveBtn.addEventListener("click", save);

  // ------------------------------------------------------------------ save
  function save() {
    if (ro) return;
    const edits = {
      title: title.value,
      notes: notes.value,
      status: st.get(),
      priority: pr.get(),
      assignee: assignee.value,
      due: due.value || "",
      tags: tags.values(),
    };
    if (!cleanString(edits.title, 300)) {
      titleErr.hidden = false;
      title.focus();
      return;
    }
    const by = ctx.by();
    const tasks = ctx.board.tasks;
    const topRank = (status, exceptId) => {
      const col = tasks.filter((t) => t.status === status && t.id !== exceptId);
      return rankBetween(null, col.length ? col[0].rank : null);
    };

    const current = snap ? tasks.find((t) => t.id === snap.id) : null;
    if (isNew || !current) {
      const item = Object.assign({}, edits, {
        rank: topRank(edits.status, null),
        done_at: edits.status === "done" ? nowIso() : "",
        created_by: ctx.name(),
      });
      perform(ctx, [opAdd("tasks", item, by)]);
      if (!isNew) toast({ message: "That task was deleted on another device — saved it again as a new task." });
      dlg.close();
      return;
    }

    const next = normalizeItem("tasks", Object.assign({}, snap, edits));
    const set = {};
    for (const f of EDIT_FIELDS) if (!same(next[f], snap[f])) set[f] = next[f];
    if ("status" in set) {
      if (set.status === "done") set.done_at = nowIso();
      else {
        if (snap.status === "done") set.done_at = "";
        set.rank = topRank(set.status, snap.id);
      }
    }
    if (Object.keys(set).length) {
      const undo = set.status === "done" ? `Completed ${quote(next.title)}` : null;
      perform(ctx, [opUpdate("tasks", snap.id, set, by)], { undo });
    }
    dlg.close();
  }

  return dlg;
}
