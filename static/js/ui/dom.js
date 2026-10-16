// Tiny DOM helpers. Everything user-provided goes in through textContent /
// attributes / properties — never innerHTML.

const PROPS = new Set(["value", "checked", "disabled", "hidden", "selected", "tabIndex", "open", "readOnly", "required", "defaultValue"]);

/**
 * h("div", {class: "x", text: "hi", onClick: fn, dataset: {id}, style: {"--h": 20}}, ...children)
 * Children: Nodes, strings/numbers (as text), arrays, or null/false (skipped).
 */
export function h(tag, props, ...children) {
  const el = typeof tag === "string" ? document.createElement(tag) : tag;
  if (props) setProps(el, props);
  append(el, children);
  return el;
}

function setProps(el, props) {
  for (const key of Object.keys(props)) {
    const v = props[key];
    if (v === undefined || v === null || v === false) continue;
    if (key === "class") el.className = Array.isArray(v) ? v.filter(Boolean).join(" ") : String(v);
    else if (key === "text") el.textContent = String(v);
    else if (key === "dataset") {
      for (const k of Object.keys(v)) if (v[k] !== undefined && v[k] !== null) el.dataset[k] = String(v[k]);
    } else if (key === "style") {
      for (const k of Object.keys(v)) el.style.setProperty(k, String(v[k]));
    } else if (key.length > 2 && key.startsWith("on") && typeof v === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), v);
    } else if (PROPS.has(key)) el[key] = v;
    else el.setAttribute(key, v === true ? "" : String(v));
  }
}

export function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === "") continue;
    if (Array.isArray(c)) append(el, c);
    else if (typeof c === "object" && typeof c.nodeType === "number") el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
  return el;
}

/**
 * Make `container`'s children exactly `nodes`, moving only nodes that are out
 * of place (so unchanged elements keep hover state, focus and scroll).
 */
export function reconcile(container, nodes) {
  let cur = container.firstChild;
  for (const n of nodes) {
    if (n === cur) {
      cur = cur.nextSibling;
      continue;
    }
    container.insertBefore(n, cur);
  }
  while (cur) {
    const next = cur.nextSibling;
    container.removeChild(cur);
    cur = next;
  }
}

/** Element cache keyed by id with a content signature; rebuilds only on change. */
export class NodeCache {
  constructor() {
    this.map = new Map();
    this.gen = 0;
  }
  begin() {
    this.gen++;
  }
  get(key, sig, build) {
    const c = this.map.get(key);
    if (c && c.sig === sig) {
      c.gen = this.gen;
      return c.el;
    }
    const el = build();
    this.map.set(key, { sig, el, gen: this.gen, fresh: !c });
    return el;
  }
  /** True when `key`'s element was created for the first time in this pass. */
  isNew(key) {
    const c = this.map.get(key);
    return !!c && c.fresh && c.gen === this.gen;
  }
  end() {
    for (const [k, c] of this.map) {
      if (c.gen !== this.gen) this.map.delete(k);
      else c.fresh = false;
    }
  }
  clear() {
    this.map.clear();
  }
}

/** True when keyboard input should go to the event target (typing in a field). */
export function isTypingTarget(t) {
  if (!t || t.nodeType !== 1) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (t.getAttribute("type") || "text").toLowerCase();
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color"].includes(type);
  }
  return false;
}

/** The focus key of the focused element ([data-key] ancestor + optional data-role). */
export function captureFocus() {
  const a = document.activeElement;
  if (!a || a === document.body) return null;
  const host = a.closest && a.closest("[data-key]");
  if (!host) return null;
  return { key: host.getAttribute("data-key"), role: a.getAttribute("data-role") || "", self: a === host };
}

/** Restore focus captured by captureFocus() if the render dropped it. */
export function restoreFocus(saved) {
  if (!saved) return;
  const a = document.activeElement;
  if (a && a !== document.body && a.isConnected) return;
  const host = document.querySelector(`[data-key="${cssEscape(saved.key)}"]`);
  if (!host) return;
  const target = saved.self || !saved.role ? host : host.querySelector(`[data-role="${cssEscape(saved.role)}"]`) || host;
  try {
    target.focus({ preventScroll: true });
  } catch (_) {
    target.focus();
  }
}

export function cssEscape(s) {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c}`);
}

/** Focus an element by its data-key (used after keyboard moves). */
export function focusKey(key) {
  const el = document.querySelector(`[data-key="${cssEscape(key)}"]`);
  if (el) {
    try {
      el.focus({ preventScroll: false });
    } catch (_) {
      el.focus();
    }
  }
  return el;
}

/** Auto-grow a textarea to fit its content (bounded by CSS max-height). */
export function autoGrow(ta) {
  const fit = () => {
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight + 2}px`;
  };
  ta.addEventListener("input", fit);
  requestAnimationFrame(fit);
  return fit;
}

/**
 * Two-step confirm for a destructive button: first click arms it (label
 * changes for 3.5 s), second click runs `fn`.
 */
export function armButton(btn, armedLabel, fn) {
  let timer = null;
  let saved = null;
  const disarm = () => {
    clearTimeout(timer);
    timer = null;
    if (saved !== null) {
      btn.replaceChildren(...saved);
      saved = null;
    }
    btn.classList.remove("armed");
  };
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    if (timer) {
      disarm();
      fn();
      return;
    }
    saved = Array.from(btn.childNodes);
    btn.textContent = typeof armedLabel === "function" ? armedLabel() : armedLabel;
    btn.classList.add("armed");
    timer = setTimeout(disarm, 3500);
  });
  btn.addEventListener("blur", () =>
    setTimeout(() => {
      if (document.activeElement !== btn) disarm();
    }, 200),
  );
  return disarm;
}
