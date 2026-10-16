// A deliberately small DOM for exercising static/js/ui modules under Node
// (no dependencies). It models what those modules use, including two browser
// behaviours that matter for the bugs these tests guard against:
//   * form.elements is an HTMLFormControlsCollection: its own members
//     (item, namedItem, length) shadow controls with those names, so
//     `form.elements.item` is a function, not the <input name="item">.
//   * document.activeElement falls back to <body> once the focused element
//     leaves the document (a re-render that replaces a focused button).
// Not a test file itself (no ".test." in the name); imported by ui tests.

class FakeEvent {
  constructor(type, { bubbles = false, cancelable = false, key, altKey = false, ctrlKey = false, metaKey = false, shiftKey = false } = {}) {
    this.type = type;
    this.bubbles = bubbles;
    this.cancelable = cancelable;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this._stop = false;
    Object.assign(this, { key, altKey, ctrlKey, metaKey, shiftKey });
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopPropagation() {
    this._stop = true;
  }
}

class Node {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
    this._listeners = new Map();
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const s = this.parentNode.childNodes;
    return s[s.indexOf(this) + 1] || null;
  }
  get previousSibling() {
    if (!this.parentNode) return null;
    const s = this.parentNode.childNodes;
    return s[s.indexOf(this) - 1] || null;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument;
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this.replaceChildren();
    const s = String(v ?? "");
    if (s) this.appendChild(this.ownerDocument.createTextNode(s));
  }
  appendChild(n) {
    return this.insertBefore(n, null);
  }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i < 0) this.childNodes.push(n);
    else this.childNodes.splice(i, 0, n);
    n.parentNode = this;
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  replaceChildren(...nodes) {
    for (const c of this.childNodes.slice()) this.removeChild(c);
    for (const n of nodes) this.appendChild(typeof n === "string" ? this.ownerDocument.createTextNode(n) : n);
  }
  replaceWith(n) {
    const p = this.parentNode;
    if (!p) return;
    p.insertBefore(n, this);
    p.removeChild(this);
  }
  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  addEventListener(type, fn, opts) {
    const capture = opts === true || !!(opts && opts.capture);
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push({ fn, capture });
  }
  removeEventListener(type, fn, opts) {
    const capture = opts === true || !!(opts && opts.capture);
    const list = this._listeners.get(type) || [];
    const i = list.findIndex((l) => l.fn === fn && l.capture === capture);
    if (i >= 0) list.splice(i, 1);
  }
  _fire(ev, capture) {
    ev.currentTarget = this;
    for (const l of (this._listeners.get(ev.type) || []).slice()) {
      if (l.capture === capture || this === ev.target) l.fn.call(this, ev);
    }
  }
  dispatchEvent(ev) {
    ev.target = this;
    const path = [];
    for (let n = this.parentNode; n; n = n.parentNode) path.push(n);
    for (const n of path.slice().reverse()) {
      n._fire(ev, true);
      if (ev._stop) return !ev.defaultPrevented;
    }
    this._fire(ev, false);
    if (ev.bubbles) {
      for (const n of path) {
        if (ev._stop) break;
        n._fire(ev, false);
      }
    }
    return !ev.defaultPrevented;
  }
}

class Text extends Node {
  constructor(doc, data) {
    super(doc);
    this.nodeType = 3;
    this.data = data;
  }
  get textContent() {
    return this.data;
  }
  set textContent(v) {
    this.data = String(v);
  }
}

const BOOL_ATTRS = ["disabled", "hidden", "checked", "open", "readOnly", "required", "selected", "novalidate"];

// ------------------------------------------------------------------ selectors
function parseCompound(sel) {
  const parts = { tag: null, classes: [], ids: [], attrs: [], nots: [] };
  let s = sel.trim();
  const take = (re) => {
    const m = s.match(re);
    if (m) s = s.slice(m[0].length);
    return m;
  };
  let m = take(/^[a-zA-Z][\w-]*/);
  if (m) parts.tag = m[0].toUpperCase();
  while (s) {
    if ((m = take(/^\.([\w-]+)/))) parts.classes.push(m[1]);
    else if ((m = take(/^#([\w-]+)/))) parts.ids.push(m[1]);
    else if ((m = take(/^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([\w-]+)))?\]/))) parts.attrs.push([m[1], m[2] ?? m[3] ?? m[4] ?? null]);
    else if ((m = take(/^:not\(([^)]*\)?)\)/))) parts.nots.push(parseCompound(m[1]));
    else throw new Error(`fake-dom: unsupported selector "${sel}"`);
  }
  return parts;
}

function matchCompound(el, p) {
  if (el.nodeType !== 1) return false;
  if (p.tag && el.tagName !== p.tag) return false;
  for (const c of p.classes) if (!el.classList.contains(c)) return false;
  for (const id of p.ids) if (el.id !== id) return false;
  for (const [name, val] of p.attrs) {
    if (!el.hasAttribute(name)) return false;
    if (val !== null && el.getAttribute(name) !== val) return false;
  }
  for (const n of p.nots) if (matchCompound(el, n)) return false;
  return true;
}

function matches(el, selector) {
  return selector.split(",").some((one) => matchCompound(el, parseCompound(one)));
}

function* descendants(node) {
  for (const c of node.childNodes) {
    if (c.nodeType === 1) {
      yield c;
      yield* descendants(c);
    }
  }
}

// --------------------------------------------------------------- form controls
class FakeFormControls {
  constructor(form) {
    Object.defineProperty(this, "_form", { value: form });
  }
  _list() {
    return Array.from(descendants(this._form)).filter((e) => ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(e.tagName));
  }
  get length() {
    return this._list().length;
  }
  item(i) {
    return this._list()[i] || null;
  }
  namedItem(name) {
    return this._list().find((e) => e.getAttribute("name") === name || e.id === name) || null;
  }
}

function controlsProxy(form) {
  const coll = new FakeFormControls(form);
  return new Proxy(coll, {
    get(target, prop, receiver) {
      // Like the real collection (no [LegacyOverrideBuiltIns]): members win.
      if (typeof prop !== "string" || prop in target) {
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      }
      if (/^\d+$/.test(prop)) return target.item(Number(prop));
      return target.namedItem(prop) || undefined;
    },
  });
}

class Element extends Node {
  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this._attrs = new Map();
    this._value = "";
    this.style = { _p: {}, setProperty(k, v) { this._p[k] = v; }, getPropertyValue(k) { return this._p[k] || ""; } };
    const self = this;
    this.dataset = new Proxy(
      {},
      {
        get: (_, k) => (typeof k === "string" ? self.getAttribute(`data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`) ?? undefined : undefined),
        set: (_, k, v) => {
          self.setAttribute(`data-${String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, String(v));
          return true;
        },
        deleteProperty: (_, k) => {
          self.removeAttribute(`data-${String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
          return true;
        },
      },
    );
    this.classList = {
      _get: () => (self.getAttribute("class") || "").split(/\s+/).filter(Boolean),
      _set: (list) => self.setAttribute("class", list.join(" ")),
      contains(c) {
        return this._get().includes(c);
      },
      add(...cs) {
        const l = this._get();
        for (const c of cs) if (!l.includes(c)) l.push(c);
        this._set(l);
      },
      remove(...cs) {
        this._set(this._get().filter((c) => !cs.includes(c)));
      },
      toggle(c, force) {
        const on = force === undefined ? !this.contains(c) : !!force;
        if (on) this.add(c);
        else this.remove(c);
        return on;
      },
    };
    if (this.tagName === "FORM") this.elements = controlsProxy(this);
  }
  getAttribute(n) {
    return this._attrs.has(n.toLowerCase()) ? this._attrs.get(n.toLowerCase()) : null;
  }
  setAttribute(n, v) {
    this._attrs.set(n.toLowerCase(), String(v));
  }
  removeAttribute(n) {
    this._attrs.delete(n.toLowerCase());
  }
  hasAttribute(n) {
    return this._attrs.has(n.toLowerCase());
  }
  get id() {
    return this.getAttribute("id") || "";
  }
  set id(v) {
    this.setAttribute("id", v);
  }
  get className() {
    return this.getAttribute("class") || "";
  }
  set className(v) {
    this.setAttribute("class", v);
  }
  get value() {
    return this._value;
  }
  set value(v) {
    this._value = String(v ?? "");
  }
  get tabIndex() {
    const t = this.getAttribute("tabindex");
    return t === null ? -1 : Number(t);
  }
  set tabIndex(v) {
    this.setAttribute("tabindex", String(v));
  }
  get children() {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }
  get lastElementChild() {
    const c = this.children;
    return c[c.length - 1] || null;
  }
  set innerHTML(v) {
    this.replaceChildren();
    this._html = String(v);
  }
  get innerHTML() {
    return this._html || "";
  }
  get isContentEditable() {
    return false;
  }
  matches(sel) {
    return matches(this, sel);
  }
  closest(sel) {
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matches(n, sel)) return n;
    return null;
  }
  querySelectorAll(sel) {
    return Array.from(descendants(this)).filter((e) => matches(e, sel));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  focus() {
    const doc = this.ownerDocument;
    const prev = doc.activeElement;
    if (prev === this) return;
    doc._active = this;
    if (prev && prev !== doc.body) prev.dispatchEvent(new FakeEvent("focusout", { bubbles: true }));
    this.dispatchEvent(new FakeEvent("focusin", { bubbles: true }));
  }
  blur() {
    const doc = this.ownerDocument;
    if (doc.activeElement !== this) return;
    doc._active = null;
    this.dispatchEvent(new FakeEvent("focusout", { bubbles: true }));
  }
  click() {
    if (this.disabled) return;
    this.dispatchEvent(new FakeEvent("click", { bubbles: true, cancelable: true }));
  }
  requestSubmit() {
    this.dispatchEvent(new FakeEvent("submit", { bubbles: true, cancelable: true }));
  }
  showModal() {
    this.setAttribute("open", "");
  }
  close() {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new FakeEvent("close"));
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
}
for (const a of BOOL_ATTRS) {
  Object.defineProperty(Element.prototype, a, {
    get() {
      return this.hasAttribute(a);
    },
    set(v) {
      if (v) this.setAttribute(a, "");
      else this.removeAttribute(a);
    },
  });
}

class Document extends Node {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.nodeType = 9;
    this._active = null;
    this.documentElement = this.createElement("html");
    this.appendChild(this.documentElement);
    this.body = this.createElement("body");
    this.documentElement.appendChild(this.body);
  }
  createElement(tag) {
    return new Element(this, tag);
  }
  createElementNS(_ns, tag) {
    return new Element(this, tag);
  }
  createTextNode(s) {
    return new Text(this, String(s));
  }
  get activeElement() {
    const a = this._active;
    return a && a.isConnected ? a : this.body;
  }
  getElementById(id) {
    return this.documentElement.querySelector(`#${id}`);
  }
  querySelector(sel) {
    return this.documentElement.matches(sel) ? this.documentElement : this.documentElement.querySelector(sel);
  }
  querySelectorAll(sel) {
    return this.documentElement.querySelectorAll(sel);
  }
}

/**
 * Install a fresh fake document as globalThis.document (plus the few window
 * globals the UI touches) and return {document, el, restore}. Always call
 * restore() (try/finally) so other test files see a DOM-less Node again.
 */
export function installDom() {
  const saved = {};
  const doc = new Document();
  const globals = {
    document: doc,
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    CSS: { escape: (s) => String(s).replace(/[^A-Za-z0-9_-]/g, (c) => `\\${c}`) },
  };
  for (const k of Object.keys(globals)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: globals[k], configurable: true, writable: true });
  }
  /** el("form#req-form", {name: "x"}, ...children) */
  const el = (spec, attrs = {}, ...children) => {
    const m = spec.match(/^([a-z][\w-]*)(?:#([\w-]+))?((?:\.[\w-]+)*)$/i);
    const e = doc.createElement(m[1]);
    if (m[2]) e.id = m[2];
    if (m[3]) e.className = m[3].slice(1).split(".").join(" ");
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    for (const c of children) e.appendChild(typeof c === "string" ? doc.createTextNode(c) : c);
    return e;
  };
  const restore = () => {
    for (const k of Object.keys(globals)) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
      else delete globalThis[k];
    }
  };
  return { document: doc, el, restore, Event: FakeEvent };
}

export { FakeEvent };
