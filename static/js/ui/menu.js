// A small anchored action menu (card "⋯" button).
// items: [{label, icon, dot, danger, run}] or "sep".

import { h } from "./dom.js";
import { icon } from "./icons.js";

let current = null;

export function closeMenu() {
  if (current) current();
}

export function openMenu(anchor, items, { label = "Actions" } = {}) {
  closeMenu();
  const buttons = [];
  const menu = h(
    "div",
    { class: "menu", role: "menu", "aria-label": label },
    items.map((it) => {
      if (it === "sep") return h("div", { class: "menu-sep", role: "separator" });
      const b = h(
        "button",
        { type: "button", role: "menuitem", class: `menu-item${it.danger ? " danger" : ""}`, tabindex: -1 },
        it.dot ? h("span", { class: `dot st-${it.dot}` }) : it.icon ? icon(it.icon) : h("span", { class: "menu-gap" }),
        h("span", { text: it.label }),
      );
      b.addEventListener("click", () => {
        close(false);
        it.run();
      });
      buttons.push(b);
      return b;
    }),
  );
  document.body.appendChild(menu);

  // Position: below the anchor, right-aligned, kept inside the viewport.
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = Math.min(window.innerWidth - mw - 8, Math.max(8, r.right - mw));
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  anchor.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => menu.classList.add("in"));

  const onDown = (e) => {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) close(false);
  };
  const onKey = (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      buttons[(i + 1) % buttons.length].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      buttons[(i - 1 + buttons.length) % buttons.length].focus();
    } else if (e.key === "Tab") {
      close(false);
    }
  };
  const onScroll = () => close(false);
  function close(refocus) {
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onScroll);
    document.removeEventListener("scroll", onScroll, true);
    anchor.removeAttribute("aria-expanded");
    menu.remove();
    current = null;
    if (refocus && anchor.isConnected) anchor.focus();
  }
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onScroll);
  document.addEventListener("scroll", onScroll, true);
  current = () => close(false);
  if (buttons[0]) buttons[0].focus({ preventScroll: true });
}
