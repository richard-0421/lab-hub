// Toasts (aria-live region in index.html). Undo toasts stay ~6 s, pause on hover/focus.

import { h } from "./dom.js";
import { icon } from "./icons.js";

const MAX = 3;
let region = null;

export function initToasts(el) {
  region = el;
}

/**
 * toast({message, kind: "info"|"success"|"error", action: {label, run}, timeout})
 * -> {dismiss()}
 */
export function toast({ message, kind = "info", action = null, timeout } = {}) {
  if (!region) return { dismiss() {} };
  const ms = timeout != null ? timeout : kind === "error" ? 9000 : 6000;
  let timer = null;
  let left = ms;
  let started = 0;
  let gone = false;

  const dismiss = () => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    el.classList.remove("in");
    el.classList.add("out");
    setTimeout(() => el.remove(), 200);
  };
  const run = () => {
    if (gone) return;
    started = Date.now();
    timer = setTimeout(dismiss, left);
  };
  const pause = () => {
    if (gone || !timer) return;
    clearTimeout(timer);
    timer = null;
    left = Math.max(1500, left - (Date.now() - started));
  };

  const ico = kind === "error" ? "alert" : kind === "success" ? "check" : "sparkle";
  const el = h(
    "div",
    { class: `toast toast-${kind}`, role: kind === "error" ? "alert" : "status" },
    h("span", { class: "toast-ico" }, icon(ico)),
    h("span", { class: "toast-msg", text: message }),
    action
      ? h(
          "button",
          {
            type: "button",
            class: "toast-action",
            onClick: () => {
              dismiss();
              action.run();
            },
          },
          action.icon ? icon(action.icon) : null,
          action.label,
        )
      : null,
    h("button", { type: "button", class: "toast-close", "aria-label": "Dismiss", onClick: dismiss }, icon("x")),
  );
  el.addEventListener("pointerenter", pause);
  el.addEventListener("pointerleave", run);
  el.addEventListener("focusin", pause);
  el.addEventListener("focusout", run);

  region.appendChild(el);
  const all = region.querySelectorAll(".toast:not(.out)");
  if (all.length > MAX) for (let i = 0; i < all.length - MAX; i++) all[i].remove();
  requestAnimationFrame(() => el.classList.add("in"));
  run();
  return { dismiss };
}

export function toastError(message) {
  return toast({ message, kind: "error" });
}
