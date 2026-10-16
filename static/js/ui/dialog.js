// Shared <dialog> shell and form widgets (segmented radios, colour dots, tag chips).

import { h } from "./dom.js";
import { icon } from "./icons.js";

let openCount = 0;

/** True while any Lab Hub dialog is open. */
export function dialogOpen() {
  return openCount > 0;
}

/**
 * Build and show a modal dialog.
 *   {title, body: Node[], footer: Node[], className, onClose, label}
 * Returns {dialog, close()}. Phones get it as a bottom sheet (CSS).
 * Cmd/Ctrl+Enter triggers the element marked data-default="true".
 */
export function openDialog({ title, subtitle = "", body = [], footer = [], className = "", onClose = null, initialFocus = null }) {
  const titleId = `dlg-${Math.random().toString(36).slice(2, 9)}`;
  const closeBtn = h("button", { type: "button", class: "icon-btn sm dlg-x", "aria-label": "Close" }, icon("x"));
  const dialog = h(
    "dialog",
    { class: `dlg ${className}`.trim(), "aria-labelledby": titleId },
    h(
      "form",
      { method: "dialog", class: "dlg-form", novalidate: true },
      h("div", { class: "dlg-grab", "aria-hidden": "true" }),
      h(
        "header",
        { class: "dlg-head" },
        h("div", { class: "dlg-titles" }, h("h2", { id: titleId, class: "dlg-title", text: title }), subtitle ? h("div", { class: "dlg-sub", text: subtitle }) : null),
        closeBtn,
      ),
      h("div", { class: "dlg-body" }, body),
      footer.length ? h("footer", { class: "dlg-foot" }, footer) : null,
    ),
  );
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      dialog.close();
    } catch (_) {
      // already closed
    }
  };
  closeBtn.addEventListener("click", (e) => {
    e.preventDefault();
    close();
  });
  // A submit (Enter in a single-line field) must not close the dialog silently.
  dialog.querySelector("form").addEventListener("submit", (e) => e.preventDefault());
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      const def = dialog.querySelector('[data-default="true"]:not([disabled])');
      if (def) {
        e.preventDefault();
        def.click();
      }
    }
  });
  // Click on the backdrop closes (but not a drag that ends outside).
  let downOnBackdrop = false;
  dialog.addEventListener("pointerdown", (e) => {
    downOnBackdrop = e.target === dialog;
  });
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog && downOnBackdrop) close();
    downOnBackdrop = false;
  });
  dialog.addEventListener("close", () => {
    closed = true;
    openCount = Math.max(0, openCount - 1);
    dialog.remove();
    if (onClose) onClose();
  });
  document.body.appendChild(dialog);
  openCount++;
  dialog.showModal();
  if (initialFocus) {
    requestAnimationFrame(() => {
      try {
        initialFocus.focus({ preventScroll: true });
      } catch (_) {
        initialFocus.focus();
      }
    });
  }
  return { dialog, close };
}

/** A labelled field wrapper. */
export function field(label, control, { hint = "", cls = "" } = {}) {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  return h("div", { class: `fld ${cls}`.trim() }, h("label", { class: "fld-label", for: id, text: label }), control, hint ? h("div", { class: "fld-hint", text: hint }) : null);
}

/** A label + arbitrary control group (no `for`). */
export function group(label, control, cls = "") {
  return h("div", { class: `fld ${cls}`.trim(), role: "group", "aria-label": label }, h("div", { class: "fld-label", text: label }), control);
}

/**
 * Segmented control built from native radios (arrow keys work for free).
 * options: [{value, label, cls}] -> {el, get(), set(v)}
 */
export function segmented(name, options, value, { disabled = false, onChange = null, cls = "" } = {}) {
  const group = `${name}-${Math.random().toString(36).slice(2, 8)}`;
  const inputs = [];
  const el = h(
    "div",
    { class: `seg ${cls}`.trim(), role: "radiogroup" },
    options.map((o) => {
      const input = h("input", { type: "radio", name: group, value: o.value, checked: o.value === value, disabled });
      input.addEventListener("change", () => onChange && onChange(o.value));
      inputs.push(input);
      return h("label", { class: `seg-opt ${o.cls || ""}`.trim() }, input, h("span", { class: "seg-face" }, o.dot ? h("span", { class: "seg-dot" }) : null, o.icon ? icon(o.icon) : null, o.label));
    }),
  );
  return {
    el,
    get: () => {
      const c = inputs.find((i) => i.checked);
      return c ? c.value : value;
    },
    set: (v) => inputs.forEach((i) => (i.checked = i.value === v)),
  };
}

/** Colour dot picker (note colours). -> {el, get(), set(v)} */
export function colorDots(colors, value, { disabled = false, onChange = null, label = "Colour" } = {}) {
  const group = `color-${Math.random().toString(36).slice(2, 8)}`;
  const inputs = [];
  const el = h(
    "div",
    { class: "color-dots", role: "radiogroup", "aria-label": label },
    colors.map((c) => {
      const input = h("input", { type: "radio", name: group, value: c, checked: c === value, disabled, "aria-label": c });
      input.addEventListener("change", () => onChange && onChange(c));
      inputs.push(input);
      return h("label", { class: `cdot c-${c}`, title: c[0].toUpperCase() + c.slice(1) }, input, h("span", { class: "cdot-face" }));
    }),
  );
  return {
    el,
    get: () => {
      const c = inputs.find((i) => i.checked);
      return c ? c.value : value;
    },
    set: (v) => inputs.forEach((i) => (i.checked = i.value === v)),
  };
}

/**
 * Tag chip input: type and press Enter/comma/space to add, Backspace on an
 * empty input removes the last chip. -> {el, input, values()}
 */
export function tagInput(initial = [], { disabled = false, max = 8 } = {}) {
  let tags = initial.slice();
  const list = h("span", { class: "chips-list" });
  const input = h("input", { type: "text", class: "chips-input", placeholder: "Add tag…", disabled, autocomplete: "off", spellcheck: "false" });
  const el = h("div", { class: `chips-field${disabled ? " disabled" : ""}`, onClick: (e) => { if (e.target === el || e.target === list) input.focus(); } }, list, input);

  const clean = (s) =>
    String(s || "")
      .replace(/^[#\s]+/, "")
      .trim()
      .toLowerCase()
      .slice(0, 24);
  const draw = () => {
    list.replaceChildren(
      ...tags.map((t, i) =>
        h(
          "span",
          { class: "chip tag" },
          `#${t}`,
          disabled
            ? null
            : h("button", { type: "button", class: "chip-x", "aria-label": `Remove tag ${t}`, onClick: () => { tags.splice(i, 1); draw(); input.focus(); } }, icon("x")),
        ),
      ),
    );
    input.placeholder = tags.length ? "" : "Add tag…";
  };
  const commit = () => {
    const parts = input.value.split(/[,\s]+/).map(clean).filter(Boolean);
    for (const p of parts) if (!tags.includes(p) && tags.length < max) tags.push(p);
    input.value = "";
    draw();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "," || (e.key === " " && input.value.trim())) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        commit();
        return; // let the dialog's save shortcut run
      }
      if (input.value.trim()) {
        e.preventDefault();
        commit();
      } else if (e.key === "Enter") e.preventDefault();
    } else if (e.key === "Backspace" && !input.value && tags.length) {
      tags.pop();
      draw();
    }
  });
  input.addEventListener("blur", commit);
  draw();
  return {
    el,
    input,
    values: () => {
      commit();
      return tags.slice();
    },
  };
}
