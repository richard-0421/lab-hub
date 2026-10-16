// Drag & drop for task cards with Pointer Events (the HTML5 DnD API does not
// work on touchscreens).
//
//   mouse / pen : drag starts after 5 px of movement
//   touch       : ~300 ms long-press first (so normal touch scrolling of a
//                 column still works); moving > 10 px before that = scroll
//
// While dragging, the real card element stays in the DOM as the dashed drop
// slot ("placeholder") and a fixed-position clone (the ghost) follows the
// pointer. Lists auto-scroll near their edges; Esc cancels. The caller's
// onDrop(id, status, index, {prevId, nextId}) receives the destination status,
// the index in that column's manual (rank) order EXCLUDING the moving card —
// exactly what planMove() expects — and the ids of the cards just above and
// below the drop slot. The board is not re-rendered mid-drag, so the index is
// a position in the DOM as it was when the drag started; resolve it against
// the current board with resolveDropIndex() so a task added or removed
// elsewhere meanwhile doesn't shift the drop. When the destination column
// can't be re-ordered (Done, a sort or filter is active) the drop goes to the
// top (index 0) and a drop back into the source column is a no-op.

const LONG_PRESS_MS = 300;
const MOUSE_SLOP = 5;
const TOUCH_SLOP = 10;
const EDGE = 64;
const MAX_SPEED = 16;

/**
 * Where to insert in `list` (the destination column in rank order, without
 * the moving card): right after `prevId`, else right before `nextId`, else at
 * `index` (clamped) when neither neighbour is on the board any more.
 */
export function resolveDropIndex(list, index, { prevId = null, nextId = null } = {}) {
  const items = Array.isArray(list) ? list : [];
  if (prevId) {
    const i = items.findIndex((x) => x && x.id === prevId);
    if (i >= 0) return i + 1;
  }
  if (nextId) {
    const i = items.findIndex((x) => x && x.id === nextId);
    if (i >= 0) return i;
  }
  const n = Number.isFinite(index) ? Math.trunc(index) : items.length;
  return Math.max(0, Math.min(n, items.length));
}

export function initDnD({ ctx, columnsEl, tabsEl, canReorder, onDrop, onEnd }) {
  let pending = null;
  let drag = null;
  let suppressClickUntil = 0;

  // Must be registered up-front and non-passive so preventDefault() can stop
  // the page from scrolling once a touch drag is under way.
  columnsEl.addEventListener(
    "touchmove",
    (e) => {
      if (drag) e.preventDefault();
    },
    { passive: false },
  );
  columnsEl.addEventListener("contextmenu", (e) => {
    if (pending || drag) e.preventDefault();
  });
  columnsEl.addEventListener("pointerdown", onDown);

  function listen(on) {
    const fn = on ? window.addEventListener : window.removeEventListener;
    fn.call(window, "pointermove", onMove, true);
    fn.call(window, "pointerup", onUp, true);
    fn.call(window, "pointercancel", onCancel, true);
  }

  function onDown(e) {
    if (!ctx.canEdit || drag || pending || !e.isPrimary) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const card = e.target.closest(".task");
    if (!card || !columnsEl.contains(card)) return;
    if (e.target.closest("button, a, input, textarea, select")) return;
    pending = { pid: e.pointerId, key: card.dataset.key, card, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, type: e.pointerType, timer: 0 };
    if (e.pointerType === "touch") {
      card.classList.add("pressing");
      pending.timer = setTimeout(() => {
        if (pending) start();
      }, LONG_PRESS_MS);
    }
    listen(true);
  }

  function abortPending() {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.card.classList.remove("pressing");
    pending = null;
    if (!drag) listen(false);
  }

  function onMove(e) {
    if (pending && e.pointerId === pending.pid) {
      pending.x = e.clientX;
      pending.y = e.clientY;
      const d = Math.hypot(pending.x - pending.x0, pending.y - pending.y0);
      if (pending.type === "touch") {
        if (d > TOUCH_SLOP) abortPending(); // it's a scroll
      } else if (d >= MOUSE_SLOP) start();
      return;
    }
    if (drag && e.pointerId === drag.pid) {
      drag.x = e.clientX;
      drag.y = e.clientY;
      placeGhost();
      update();
    }
  }

  function onUp(e) {
    if (pending && e.pointerId === pending.pid) {
      abortPending(); // no drag happened: the click that follows opens the card
      return;
    }
    if (drag && e.pointerId === drag.pid) finish(true);
  }

  function onCancel(e) {
    if (pending && e.pointerId === pending.pid) abortPending();
    if (drag && e.pointerId === drag.pid) finish(false);
  }

  function onKey(e) {
    if (drag && e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  }

  function tasksIn(list, except) {
    return Array.from(list.children).filter((c) => c !== except && c.classList.contains("task"));
  }

  function start() {
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    p.card.classList.remove("pressing");
    // A render may have replaced the element during the long-press.
    let card = p.card;
    if (!card.isConnected) card = columnsEl.querySelector(`[data-key="${CSS.escape(p.key)}"]`);
    const sec = card && card.closest(".column");
    if (!card || !sec) {
      listen(false);
      return;
    }
    const list = sec.querySelector(".col-list");
    const rect = card.getBoundingClientRect();
    const ghost = card.cloneNode(true);
    ghost.classList.add("drag-ghost");
    ghost.classList.remove("enter", "pressing");
    ghost.removeAttribute("data-key");
    ghost.removeAttribute("tabindex");
    ghost.removeAttribute("role");
    ghost.setAttribute("aria-hidden", "true");
    ghost.style.width = `${rect.width}px`;
    document.body.appendChild(ghost);

    const fromStatus = sec.dataset.status;
    drag = {
      pid: p.pid,
      id: card.dataset.id,
      card,
      ghost,
      fromStatus,
      origList: list,
      origNext: card.nextSibling,
      ox: p.x - rect.left,
      oy: p.y - rect.top,
      x: p.x,
      y: p.y,
      over: null,
      overEl: null,
      overList: list,
      raf: 0,
    };
    card.style.height = `${rect.height}px`;
    card.classList.add("drag-source");
    if (card === document.activeElement) card.blur();
    document.documentElement.classList.add("is-dragging");
    ctx.dragging = true;
    placeGhost();
    requestAnimationFrame(() => ghost.classList.add("lifted"));
    if (p.type === "touch" && navigator.vibrate) {
      try {
        navigator.vibrate(8);
      } catch (_) {
        // not allowed
      }
    }
    window.addEventListener("keydown", onKey, true);
    update();
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function placeGhost() {
    drag.ghost.style.transform = `translate3d(${Math.round(drag.x - drag.ox)}px, ${Math.round(drag.y - drag.oy)}px, 0)`;
  }

  function setOver(el) {
    if (drag.overEl === el) return;
    if (drag.overEl) drag.overEl.classList.remove("drop-target");
    drag.overEl = el;
    if (el) el.classList.add("drop-target");
    // Over a phone status tab: shrink/fade the ghost so the highlighted tab shows.
    drag.ghost.classList.toggle("over-tab", !!el && el.classList.contains("status-tab"));
  }

  function hit(x, y) {
    if (tabsEl && tabsEl.offsetParent !== null) {
      for (const b of tabsEl.querySelectorAll("[data-status]")) {
        const r = b.getBoundingClientRect();
        if (b.dataset.status !== drag.fromStatus && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          return { status: b.dataset.status, tab: b };
        }
      }
    }
    let best = null;
    let bestDist = Infinity;
    for (const sec of columnsEl.querySelectorAll(".column")) {
      const r = sec.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      if (dx < bestDist) {
        bestDist = dx;
        best = sec;
      }
    }
    return best ? { status: best.dataset.status, sec: best, list: best.querySelector(".col-list") } : null;
  }

  function backToOrigin() {
    const { card, origList, origNext } = drag;
    const next = origNext && origNext.parentNode === origList ? origNext : null;
    if (card.parentNode !== origList || card.nextSibling !== next) origList.insertBefore(card, next);
  }

  function update() {
    const t = hit(drag.x, drag.y);
    if (!t) return;
    if (t.tab) {
      setOver(t.tab);
      backToOrigin();
      drag.over = { status: t.status, index: 0 };
      return;
    }
    setOver(t.sec);
    drag.overList = t.list;
    const { card } = drag;
    if (!canReorder(t.status)) {
      if (t.status === drag.fromStatus) {
        backToOrigin();
        drag.over = null; // no-op
      } else {
        const first = tasksIn(t.list, card)[0] || null;
        if (card.parentNode !== t.list || card.nextSibling !== first) t.list.insertBefore(card, first);
        drag.over = { status: t.status, index: 0 };
      }
      return;
    }
    const cards = tasksIn(t.list, card);
    let idx = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (drag.y < r.top + r.height / 2) {
        idx = i;
        break;
      }
    }
    const ref = idx < cards.length ? cards[idx] : null;
    if (ref) {
      if (card.parentNode !== t.list || card.nextSibling !== ref) t.list.insertBefore(card, ref);
    } else {
      const last = cards[cards.length - 1];
      const after = last ? last.nextSibling : t.list.firstChild;
      if (card.parentNode !== t.list || (last ? card.previousSibling !== last : t.list.firstChild !== card)) t.list.insertBefore(card, after);
    }
    const prev = idx > 0 ? cards[idx - 1] : null;
    drag.over = { status: t.status, index: idx, prevId: prev ? prev.dataset.id : null, nextId: ref ? ref.dataset.id : null };
  }

  function scrollStep(pos, lo, hi) {
    if (pos < lo + EDGE) return -Math.ceil(MAX_SPEED * Math.min(1, (lo + EDGE - pos) / EDGE));
    if (pos > hi - EDGE) return Math.ceil(MAX_SPEED * Math.min(1, (pos - (hi - EDGE)) / EDGE));
    return 0;
  }

  function autoScroll() {
    if (!drag) return;
    let moved = false;
    const list = drag.overList;
    if (list && list.scrollHeight > list.clientHeight + 2) {
      const r = list.getBoundingClientRect();
      if (drag.y >= r.top - EDGE && drag.y <= r.bottom + EDGE) {
        const v = scrollStep(drag.y, r.top, r.bottom);
        if (v) {
          const before = list.scrollTop;
          list.scrollTop += v;
          moved = list.scrollTop !== before;
        }
      }
    }
    if (!moved) {
      const se = document.scrollingElement || document.documentElement;
      if (se.scrollHeight > window.innerHeight + 2) {
        const v = scrollStep(drag.y, 0, window.innerHeight);
        if (v) {
          const before = se.scrollTop;
          se.scrollTop += v;
          moved = se.scrollTop !== before;
        }
      }
    }
    if (moved) update();
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function finish(commit) {
    const d = drag;
    drag = null;
    cancelAnimationFrame(d.raf);
    window.removeEventListener("keydown", onKey, true);
    listen(false);
    if (d.overEl) d.overEl.classList.remove("drop-target");
    d.ghost.remove();
    d.card.classList.remove("drag-source");
    d.card.style.height = "";
    document.documentElement.classList.remove("is-dragging");
    suppressClickUntil = Date.now() + 400;
    ctx.dragging = false;
    if (commit && d.over) onDrop(d.id, d.over.status, d.over.index, { prevId: d.over.prevId || null, nextId: d.over.nextId || null });
    onEnd();
  }

  return {
    /** True right after a drag ended (swallow the click that follows). */
    justDragged: () => Date.now() < suppressClickUntil,
    isDragging: () => !!drag,
    cancel: () => {
      if (drag) finish(false);
      abortPending();
    },
  };
}
