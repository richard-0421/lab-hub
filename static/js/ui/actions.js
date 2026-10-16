// Submitting ops with undo. Undo emits inverse ops computed against the board
// as it was just before the action:
//   add    -> delete
//   update -> update with the previous values of exactly the fields set
//   delete -> add the old item snapshot (same id, created_at, ...)

import { opAdd, opDelete, opUpdate } from "../board.js";
import { toast } from "./toast.js";

function findItem(board, coll, id) {
  const list = board && Array.isArray(board[coll]) ? board[coll] : [];
  return list.find((it) => it.id === id) || null;
}

/** Inverse ops for `ops` (applied on `before`), newest first. Fresh timestamps. */
export function invertOps(ops, before, by) {
  const out = [];
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    if (op.op === "add") {
      if (!findItem(before, op.coll, op.item.id)) out.push(opDelete(op.coll, op.item.id, by));
    } else if (op.op === "update") {
      const prev = findItem(before, op.coll, op.id);
      if (!prev) continue;
      const set = {};
      for (const k of Object.keys(op.set)) set[k] = Array.isArray(prev[k]) ? prev[k].slice() : prev[k];
      out.push(opUpdate(op.coll, op.id, set, by));
    } else if (op.op === "delete") {
      const prev = findItem(before, op.coll, op.id);
      if (prev) out.push(opAdd(op.coll, Object.assign({}, prev), by));
    }
  }
  return out;
}

export function errorText(e) {
  const msg = (e && e.message) || String(e || "Something went wrong");
  if (msg === "read-only") return "This browser is read-only. Add a GitHub token in Settings to make changes.";
  return msg;
}

/**
 * Submit `ops` through the active source. The source applies them
 * optimistically and notifies subscribers before this returns.
 *   undo: toast message (string) -> an Undo toast that submits the inverse
 * Resolves true on success, false on failure (an error toast is shown).
 */
export async function perform(ctx, ops, { undo = null, success = null } = {}) {
  if (!ops || !ops.length) return true;
  if (!ctx.source) {
    toast({ message: "Still connecting — try again in a moment.", kind: "error" });
    return false;
  }
  if (!ctx.canEdit) {
    toast({ message: errorText(new Error("read-only")), kind: "error" });
    return false;
  }
  const before = ctx.board;
  let t = null;
  let promise;
  try {
    promise = ctx.source.submit(ops);
  } catch (e) {
    promise = Promise.reject(e);
  }
  if (undo) {
    t = toast({
      message: undo,
      kind: "success",
      action: {
        label: "Undo",
        icon: "undo",
        run: () => perform(ctx, invertOps(ops, before, ctx.by())),
      },
    });
  } else if (success) {
    t = toast({ message: success, kind: "success", timeout: 3000 });
  }
  try {
    await promise;
    return true;
  } catch (e) {
    if (t) t.dismiss();
    toast({ message: errorText(e), kind: "error" });
    return false;
  }
}
