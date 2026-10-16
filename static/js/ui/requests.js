// Item requests card: compact rows (status pill cycles new -> ordered ->
// received), "Clear received" with undo, an add form and a small editor.

import { h, reconcile, NodeCache, captureFocus, restoreFocus, autoGrow, armButton } from "./dom.js";
import { icon } from "./icons.js";
import { openDialog, field, group, segmented } from "./dialog.js";
import { cleanString, opAdd, opDelete, opUpdate, rankBetween } from "../board.js";
import { perform } from "./actions.js";
import { plural, quote, relTime } from "./format.js";
import { getName, setName } from "./prefs.js";

const ORDER = { new: 0, ordered: 1, received: 2 };
const NEXT = { new: "ordered", ordered: "received", received: "new" };
const LABEL = { new: "New", ordered: "Ordered", received: "Received" };

const $ = (id) => document.getElementById(id);

const safeLink = (s) => (typeof s === "string" && /^https?:\/\//i.test(s) ? s : "");

export function initRequests(ctx) {
  const body = $("req-body");
  const count = $("req-count");
  const clearBtn = $("clear-received");
  const form = $("req-form");
  const itemIn = form.elements.item;
  const qtyIn = form.elements.qty;
  const byIn = form.elements.by;
  const cache = new NodeCache();

  const find = (id) => ctx.board.requests.find((r) => r.id === id) || null;

  function ordered() {
    return ctx.board.requests
      .map((r, i) => [r, i])
      .sort((a, b) => ORDER[a[0].status] - ORDER[b[0].status] || a[1] - b[1])
      .map((x) => x[0]);
  }

  function buildRow(r) {
    const link = safeLink(r.link);
    const sub = [r.requested_by, relTime(r.created_at)].filter(Boolean).join(" · ");
    return h(
      "div",
      { class: `req st-${r.status}`, role: "listitem", dataset: { key: `req:${r.id}`, id: r.id } },
      h(
        "button",
        {
          type: "button",
          class: `req-status rs-${r.status}`,
          "data-role": "status",
          disabled: !ctx.canEdit,
          title: ctx.canEdit ? `Mark as ${LABEL[NEXT[r.status]].toLowerCase()}` : LABEL[r.status],
          "aria-label": `Status ${LABEL[r.status]}${ctx.canEdit ? `, tap to mark as ${LABEL[NEXT[r.status]].toLowerCase()}` : ""}`,
        },
        h("span", { class: "rs-dot" }),
        LABEL[r.status],
      ),
      h(
        "button",
        { type: "button", class: "req-main", "data-role": "open", "aria-label": `${r.item}${r.qty ? `, ${r.qty}` : ""}. Open` },
        h("span", { class: "req-line" }, h("span", { class: "req-item", text: r.item }), r.qty ? h("span", { class: "req-qty", text: r.qty }) : null),
        h("span", { class: "req-sub", dataset: { rel: r.created_at, relPrefix: r.requested_by ? `${r.requested_by} · ` : "" }, text: sub }),
      ),
      link
        ? h("a", { class: "icon-btn sm req-link", href: link, target: "_blank", rel: "noopener noreferrer", title: link, "aria-label": `Open link for ${r.item}` }, icon("link"))
        : null,
    );
  }

  function render() {
    const saved = captureFocus();
    const list = ordered();
    cache.begin();
    const nodes = list.map((r) => cache.get(`req:${r.id}`, `${ctx.canEdit}|${JSON.stringify(r)}`, () => buildRow(r)));
    if (!nodes.length) {
      nodes.push(
        cache.get(`empty:${ctx.loaded}`, "", () =>
          ctx.loaded
            ? h("div", { class: "card-empty" }, icon("box"), h("span", { text: "No requests. Need something ordered? Add it below." }))
            : h("div", { class: "skeleton-list" }, h("div", { class: "sk" }), h("div", { class: "sk" })),
        ),
      );
    }
    cache.end();
    reconcile(body, nodes);
    const open = list.filter((r) => r.status !== "received").length;
    count.hidden = !open;
    count.textContent = `${open} open`;
    clearBtn.hidden = !ctx.canEdit || !list.some((r) => r.status === "received");
    restoreFocus(saved);
  }

  function refreshRelative() {
    for (const el of body.querySelectorAll("[data-rel]")) el.textContent = `${el.dataset.relPrefix || ""}${relTime(el.dataset.rel)}`;
  }

  // ---------------------------------------------------------------- events
  body.addEventListener("click", (e) => {
    const row = e.target.closest(".req");
    if (!row) return;
    const r = find(row.dataset.id);
    if (!r) return;
    if (e.target.closest(".req-status")) {
      if (ctx.canEdit) perform(ctx, [opUpdate("requests", r.id, { status: NEXT[r.status] }, ctx.by())]);
      return;
    }
    if (e.target.closest(".req-main")) openEditor(r);
  });

  armButton(clearBtn, () => `Clear ${ctx.board.requests.filter((r) => r.status === "received").length}?`, () => {
    const done = ctx.board.requests.filter((r) => r.status === "received");
    perform(
      ctx,
      done.map((r) => opDelete("requests", r.id, ctx.by())),
      { undo: `Cleared ${plural(done.length, "received request")}` },
    );
  });

  const expand = () => form.classList.add("open");
  form.addEventListener("focusin", expand);
  form.addEventListener("focusout", () =>
    setTimeout(() => {
      if (!form.contains(document.activeElement) && !itemIn.value.trim() && !qtyIn.value.trim()) form.classList.remove("open");
    }, 150),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const item = cleanString(itemIn.value, 300);
    if (!item) {
      itemIn.focus();
      return;
    }
    const name = setName(byIn.value) || getName();
    const first = ctx.board.requests[0];
    const op = opAdd(
      "requests",
      { item, qty: qtyIn.value, requested_by: name, status: "new", rank: rankBetween(null, first ? first.rank : null) },
      ctx.by(),
    );
    perform(ctx, [op]).then((ok) => {
      if (ok) {
        itemIn.value = "";
        qtyIn.value = "";
        itemIn.focus();
      }
    });
  });

  // ---------------------------------------------------------------- editor
  function openEditor(r) {
    const ro = !ctx.canEdit;
    const snap = JSON.parse(JSON.stringify(r));
    const item = h("input", { type: "text", value: snap.item, maxlength: 300, disabled: ro });
    const qty = h("input", { type: "text", value: snap.qty, maxlength: 40, disabled: ro, placeholder: "e.g. 2 boxes" });
    const who = h("input", { type: "text", value: snap.requested_by, maxlength: 60, disabled: ro });
    const link = h("input", { type: "url", value: snap.link, maxlength: 500, disabled: ro, placeholder: "https://…", inputmode: "url" });
    const notes = h("textarea", { rows: 3, value: snap.notes, maxlength: 2000, disabled: ro, placeholder: ro ? "" : "Catalog number, vendor, why…" });
    autoGrow(notes);
    const st = segmented(
      "rstatus",
      ["new", "ordered", "received"].map((s) => ({ value: s, label: LABEL[s], dot: true, cls: `r-${s}` })),
      snap.status,
      { disabled: ro },
    );
    const err = h("div", { class: "fld-error", role: "alert", hidden: true }, icon("alert"), "The item needs a name");
    const saveBtn = h("button", { type: "button", class: "btn btn-primary", "data-default": "true" }, icon("check"), "Save");
    const cancel = h("button", { type: "button", class: "btn btn-ghost", text: ro ? "Close" : "Cancel" });
    const footer = [];
    if (!ro) {
      const del = h("button", { type: "button", class: "btn btn-danger-ghost" }, icon("trash"), "Delete");
      armButton(del, "Confirm delete", () => {
        perform(ctx, [opDelete("requests", snap.id, ctx.by())], { undo: `Deleted request ${quote(snap.item)}` });
        dlg.close();
      });
      footer.push(del);
    }
    footer.push(h("span", { class: "spacer" }), cancel);
    if (!ro) footer.push(saveBtn);

    const dlg = openDialog({
      title: ro ? "Request" : "Edit request",
      subtitle: `Requested ${relTime(snap.created_at)}${snap.requested_by ? ` by ${snap.requested_by}` : ""}`,
      className: "small-editor",
      body: [
        h("div", { class: "fld" }, field("Item", item), err),
        h("div", { class: "ed-grid" }, field("Quantity", qty), field("Requested by", who)),
        group("Status", st.el),
        field("Link", link, { hint: ro ? "" : "Product page or quote (http/https)" }),
        field("Notes", notes),
      ],
      footer,
    });
    cancel.addEventListener("click", () => dlg.close());
    saveBtn.addEventListener("click", () => {
      const vals = { item: item.value, qty: qty.value, requested_by: who.value, link: link.value.trim(), notes: notes.value, status: st.get() };
      if (vals.link && !/^https?:\/\//i.test(vals.link)) vals.link = `https://${vals.link}`;
      if (!cleanString(vals.item, 300)) {
        err.hidden = false;
        item.focus();
        return;
      }
      const max = { item: 300, qty: 40, requested_by: 60, link: 500 };
      const set = {};
      for (const k of Object.keys(vals)) {
        const v = k === "status" ? vals[k] : cleanString(vals[k], k === "notes" ? 2000 : max[k], k === "notes");
        if (v !== snap[k]) set[k] = v;
      }
      if (Object.keys(set).length) perform(ctx, [opUpdate("requests", snap.id, set, ctx.by())]);
      dlg.close();
    });
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveBtn.click();
      }
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
