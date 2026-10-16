// Notes card: sticky notes in a 2-column grid, pinned first then newest.

import { h, reconcile, NodeCache, captureFocus, restoreFocus, autoGrow, armButton } from "./dom.js";
import { icon } from "./icons.js";
import { openDialog, field, colorDots } from "./dialog.js";
import { NOTE_COLORS, cleanString, opAdd, opDelete, opUpdate } from "../board.js";
import { perform } from "./actions.js";
import { quote, relTime } from "./format.js";
import { getName, setName } from "./prefs.js";

const $ = (id) => document.getElementById(id);

export function initNotes(ctx) {
  const body = $("notes-body");
  const count = $("notes-count");
  const form = $("note-form");
  const bodyIn = form.elements.body;
  const byIn = form.elements.by;
  const cache = new NodeCache();
  let newColor = "yellow";

  const picker = colorDots(NOTE_COLORS, newColor, { onChange: (c) => (newColor = c), label: "Note colour" });
  $("note-colors").replaceWith(picker.el);
  autoGrow(bodyIn);

  const find = (id) => ctx.board.notes.find((n) => n.id === id) || null;

  function ordered() {
    return ctx.board.notes.slice().sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
      return a.id < b.id ? -1 : 1;
    });
  }

  function buildNote(n) {
    const who = n.author ? `${n.author} · ` : "";
    // A div (not a <button>): Chrome lays buttons out as flexboxes, which
    // breaks the line-clamped body's intrinsic height inside the grid.
    return h(
      "div",
      {
        class: `note c-${n.color}${n.pinned ? " pinned" : ""}`,
        role: "button",
        tabindex: 0,
        dataset: { key: `note:${n.id}`, id: n.id },
        "aria-label": `${n.pinned ? "Pinned note" : "Note"}${n.author ? ` from ${n.author}` : ""}: ${n.body}`,
      },
      n.pinned ? h("span", { class: "note-pin", title: "Pinned" }, icon("pin")) : null,
      h("span", { class: "note-body", text: n.body }),
      h("span", { class: "note-foot", dataset: { rel: n.created_at, relPrefix: who }, text: `${who}${relTime(n.created_at)}` }),
    );
  }

  function render() {
    const saved = captureFocus();
    const list = ordered();
    cache.begin();
    const nodes = list.map((n) => cache.get(`note:${n.id}`, JSON.stringify(n), () => buildNote(n)));
    if (!nodes.length) {
      nodes.push(
        cache.get(`empty:${ctx.loaded}`, "", () =>
          ctx.loaded
            ? h("div", { class: "card-empty span-all" }, icon("note"), h("span", { text: "No notes yet. Leave one for the team below." }))
            : h("div", { class: "skeleton-list span-all" }, h("div", { class: "sk tall" })),
        ),
      );
    }
    cache.end();
    reconcile(body, nodes);
    count.hidden = !list.length;
    count.textContent = String(list.length);
    restoreFocus(saved);
  }

  function refreshRelative() {
    for (const el of body.querySelectorAll("[data-rel]")) el.textContent = `${el.dataset.relPrefix || ""}${relTime(el.dataset.rel)}`;
  }

  body.addEventListener("click", (e) => {
    const el = e.target.closest(".note");
    if (!el) return;
    const n = find(el.dataset.id);
    if (n) openEditor(n);
  });
  body.addEventListener("keydown", (e) => {
    const el = e.target;
    if (!el.classList || !el.classList.contains("note") || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    const n = find(el.dataset.id);
    if (n) openEditor(n);
  });

  const expand = () => form.classList.add("open");
  form.addEventListener("focusin", expand);
  form.addEventListener("focusout", () =>
    setTimeout(() => {
      if (!form.contains(document.activeElement) && !bodyIn.value.trim()) form.classList.remove("open");
    }, 150),
  );
  bodyIn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = cleanString(bodyIn.value, 2000, true);
    if (!text) {
      bodyIn.focus();
      return;
    }
    const name = setName(byIn.value) || getName();
    const op = opAdd("notes", { body: text, author: name, color: newColor, pinned: false, rank: 0 }, ctx.by());
    perform(ctx, [op]).then((ok) => {
      if (ok) {
        bodyIn.value = "";
        bodyIn.style.height = "";
        bodyIn.blur();
        form.classList.remove("open");
      }
    });
  });

  function openEditor(n) {
    const ro = !ctx.canEdit;
    const snap = JSON.parse(JSON.stringify(n));
    const text = h("textarea", { rows: 5, value: snap.body, maxlength: 2000, disabled: ro, class: "note-text" });
    autoGrow(text);
    const author = h("input", { type: "text", value: snap.author, maxlength: 60, disabled: ro });
    const color = colorDots(NOTE_COLORS, snap.color, { disabled: ro });
    const pinned = h("input", { type: "checkbox", checked: snap.pinned, disabled: ro, class: "switch-input" });
    const pinRow = h("label", { class: "switch" }, pinned, h("span", { class: "switch-track", "aria-hidden": "true" }), icon("pin"), "Pin to the top");
    const err = h("div", { class: "fld-error", role: "alert", hidden: true }, icon("alert"), "A note can't be empty");
    const saveBtn = h("button", { type: "button", class: "btn btn-primary", "data-default": "true" }, icon("check"), "Save");
    const cancel = h("button", { type: "button", class: "btn btn-ghost", text: ro ? "Close" : "Cancel" });
    const footer = [];
    if (!ro) {
      const del = h("button", { type: "button", class: "btn btn-danger-ghost" }, icon("trash"), "Delete");
      armButton(del, "Confirm delete", () => {
        perform(ctx, [opDelete("notes", snap.id, ctx.by())], { undo: `Deleted note ${quote(snap.body, 28)}` });
        dlg.close();
      });
      footer.push(del);
    }
    footer.push(h("span", { class: "spacer" }), cancel);
    if (!ro) footer.push(saveBtn);
    const dlg = openDialog({
      title: ro ? "Note" : "Edit note",
      subtitle: `Posted ${relTime(snap.created_at)}${snap.author ? ` by ${snap.author}` : ""}`,
      className: `small-editor note-editor c-${snap.color}`,
      body: [
        h("div", { class: "fld" }, text, err),
        h("div", { class: "ed-grid" }, field("Author", author), h("div", { class: "fld" }, h("div", { class: "fld-label", text: "Colour" }), color.el)),
        ro ? null : pinRow,
      ],
      footer,
    });
    cancel.addEventListener("click", () => dlg.close());
    saveBtn.addEventListener("click", () => {
      const vals = { body: cleanString(text.value, 2000, true), author: cleanString(author.value, 60), color: color.get(), pinned: pinned.checked };
      if (!vals.body) {
        err.hidden = false;
        text.focus();
        return;
      }
      const set = {};
      for (const k of Object.keys(vals)) if (vals[k] !== snap[k]) set[k] = vals[k];
      if (Object.keys(set).length) perform(ctx, [opUpdate("notes", snap.id, set, ctx.by())]);
      dlg.close();
    });
  }

  return {
    render,
    refreshRelative,
    setDefaults() {
      if (!byIn.value) byIn.value = getName();
    },
  };
}
