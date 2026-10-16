// Tests for static/js/board.js — shared vectors + JS-only helpers.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as B from "../../static/js/board.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(fs.readFileSync(path.join(here, "..", "ops_vectors.json"), "utf8"));

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const clone = (x) => JSON.parse(JSON.stringify(x));

// ------------------------------------------------------------ shared vectors

describe("ops_vectors.json: normalize", () => {
  for (const c of vectors.normalize) {
    test(c.name, () => {
      assert.deepEqual(B.normalizeBoard(clone(c.input)), c.output);
    });
  }
});

describe("ops_vectors.json: apply", () => {
  for (const c of vectors.apply) {
    test(c.name, () => {
      const board = deepFreeze(clone(c.board));
      const ops = deepFreeze(clone(c.ops));
      assert.deepEqual(B.applyOps(board, ops), c.expect);
      assert.deepEqual(board, c.board, "input board must not change");
    });
  }
});

describe("ops_vectors.json: valid_ops", () => {
  for (const c of vectors.valid_ops) {
    test(c.name, () => assert.equal(B.validateOp(c.op), null));
  }
});

describe("ops_vectors.json: invalid_ops", () => {
  for (const c of vectors.invalid_ops) {
    test(c.name, () => {
      const err = B.validateOp(c.op);
      assert.equal(typeof err, "string");
      assert.ok(err.length > 0);
    });
  }
});

describe("ops_vectors.json: serialize", () => {
  for (const c of vectors.serialize) {
    test(c.name, () => {
      assert.equal(B.serializeBoard(B.normalizeBoard(JSON.parse(c.input_text))), c.output_text);
    });
  }
});

test("every vector category is present and non-empty", () => {
  for (const k of ["normalize", "apply", "valid_ops", "invalid_ops", "serialize"]) {
    assert.ok(Array.isArray(vectors[k]) && vectors[k].length > 0, k);
  }
});

// ---------------------------------------------------------------- idempotence

// Deterministic PRNG so failures are reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NASTY = [
  "", " ", "  x  ", "#", "##tag", "# # spaced", "\t#Tab", "a\nb", "a\r\nb\rc", "\u0000\u0007bell", "\u007f",
  " nbsp ", " em ", "﻿bom", "\u0085nel", "😀", "Café ✓", "日本語", "x".repeat(70),
  "y ".repeat(200), "  #MiXeD  ", "HIGH", " low ", "Done", "pink", "true", "false", "1", "https://x.y", "ftp://z",
  "2026-10-16", "2026-02-30", "2026-10-16T10:00:00-04:00", "2026-10-16 09:15", "1969-12-31T23:59:59Z",
  "1970-01-01T00:30:00+01:00", "9999-12-31T23:00:00-05:00", "2026-10-16t10:00:00z", "0000-01-01",
];

function randomValue(r, depth = 0) {
  const k = Math.floor(r() * 12);
  switch (k) {
    case 0: return NASTY[Math.floor(r() * NASTY.length)];
    case 1: return NASTY[Math.floor(r() * NASTY.length)] + NASTY[Math.floor(r() * NASTY.length)];
    case 2: return Math.floor(r() * 10) - 3;
    case 3: return (r() - 0.5) * 1e6;
    case 4: return r() < 0.5;
    case 5: return null;
    case 6: return depth < 2 ? Array.from({ length: Math.floor(r() * 10) }, () => randomValue(r, depth + 1)) : [];
    case 7: return depth < 1 ? { title: randomValue(r, depth + 1) } : {};
    case 8: return [1e-7, 2 ** 60, -0, 0.1 + 0.2, 1e21, 123456.789][Math.floor(r() * 6)];
    default: return "w" + Math.floor(r() * 1000);
  }
}

const ALL_FIELDS = Array.from(new Set(Object.values(B.FIELD_ORDER).flat()));

function randomItem(r, coll) {
  const item = {};
  for (const f of ALL_FIELDS) if (r() < 0.6) item[f] = randomValue(r);
  if (r() < 0.8) item[B.REQUIRED_FIELD[coll]] = NASTY[Math.floor(r() * NASTY.length)] + "t";
  if (r() < 0.7) item.id = r() < 0.8 ? "i" + Math.floor(r() * 30) : randomValue(r);
  if (r() < 0.2) item.extra = randomValue(r);
  return item;
}

function randomDoc(r) {
  const doc = {};
  if (r() < 0.9) doc.schema = randomValue(r);
  if (r() < 0.8) doc.updated_at = randomValue(r);
  if (r() < 0.8) doc.updated_by = randomValue(r);
  for (const coll of B.COLLECTIONS) {
    if (r() < 0.1) doc[coll] = randomValue(r);
    else doc[coll] = Array.from({ length: Math.floor(r() * 12) }, () => (r() < 0.9 ? randomItem(r, coll) : randomValue(r)));
  }
  return doc;
}

describe("normalization properties", () => {
  test("idempotent on every vector input", () => {
    for (const c of vectors.normalize) {
      const once = B.normalizeBoard(clone(c.input));
      assert.deepEqual(B.normalizeBoard(clone(once)), once, c.name);
    }
  });

  test("idempotent and serialize-stable on 500 random hand-edited documents", () => {
    const r = rng(12345);
    for (let i = 0; i < 500; i++) {
      const doc = randomDoc(r);
      const once = B.normalizeBoard(doc);
      assert.deepEqual(B.normalizeBoard(clone(once)), once, `doc #${i}: ${JSON.stringify(doc).slice(0, 300)}`);
      const text = B.serializeBoard(once);
      assert.deepEqual(B.normalizeBoard(JSON.parse(text)), once, `serialize round trip #${i}`);
      assert.equal(B.serializeBoard(B.normalizeBoard(JSON.parse(text))), text);
    }
  });

  test("normalizeBoard does not mutate its input", () => {
    const doc = deepFreeze({ tasks: [{ id: "a", title: " A ", tags: ["#X"] }], notes: "x" });
    B.normalizeBoard(doc);
  });

  test("normalizeItem returns null for non-objects and empty required text", () => {
    assert.equal(B.normalizeItem("tasks", null, 0), null);
    assert.equal(B.normalizeItem("tasks", [], 0), null);
    assert.equal(B.normalizeItem("tasks", { title: " \n " }, 0), null);
    assert.equal(B.normalizeItem("nope", { title: "x" }, 0), null);
    const it = B.normalizeItem("requests", { item: "Tips" }, 7, "2026-10-16T14:00:00Z");
    assert.equal(it.id, "r-auto-7");
    assert.equal(it.created_at, "2026-10-16T14:00:00Z");
    assert.deepEqual(Object.keys(it), B.FIELD_ORDER.requests);
  });

  test("tags: leading # and spaces are stripped as one run (idempotent)", () => {
    const b = B.normalizeBoard({ tasks: [{ id: "a", title: "A", tags: ["# # x", "  ##Y z ", "#", "ü".repeat(30)] }] });
    assert.deepEqual(b.tasks[0].tags, ["x", "y z", "ü".repeat(24)]);
  });

  test("clamping never leaves trailing whitespace", () => {
    const title = "a".repeat(299) + " b";
    const b = B.normalizeBoard({ tasks: [{ id: "a", title }] });
    assert.equal(b.tasks[0].title, "a".repeat(299));
  });

  test("at most 2000 items per collection, extras dropped after sorting", () => {
    const tasks = Array.from({ length: 2005 }, (_, i) => ({ id: `t${i}`, title: "x", rank: 2005 - i }));
    const b = B.normalizeBoard({ tasks });
    assert.equal(b.tasks.length, 2000);
    assert.equal(b.tasks[0].rank, 1);
    assert.equal(b.tasks[1999].rank, 2000);
  });
});

// ------------------------------------------------------------- timestamps etc

describe("timestamps and dates", () => {
  const cases = [
    ["2026-10-16T14:03:22Z", "2026-10-16T14:03:22Z"],
    ["2026-10-16T10:03:22-04:00", "2026-10-16T14:03:22Z"],
    ["2026-10-16T22:30:00-0300", "2026-10-17T01:30:00Z"],
    ["2026-10-16 09:15", "2026-10-16T09:15:00Z"],
    ["2026-10-16", "2026-10-16T00:00:00Z"],
    ["2024-02-29T12:00:00.987654Z", "2024-02-29T12:00:00Z"],
    ["2026-10-16T10:00:00z", "2026-10-16T10:00:00Z"],
    ["2026-01-01T00:30:00+01:00", "2025-12-31T23:30:00Z"],
    ["2026-10-16t10:00:00Z", null],
    ["2026-02-29T00:00:00Z", null],
    ["2026-10-16T24:00:00Z", null],
    ["2026-10-16T12:60:00Z", null],
    ["2026-10-16T12:00:60Z", null],
    ["2026-10-16T12:00:00+24:00", null],
    ["2026-10-16T12:00:00+05:60", null],
    ["1969-12-31T23:59:59Z", null],
    ["1970-01-01T00:30:00+01:00", null], // 1969 after conversion
    ["9999-12-31T23:00:00-05:00", null], // year 10000 after conversion
    ["2026-10-16T12:00.5Z", null],
    ["2026-10-16Z", null],
    ["yesterday", null],
    ["", null],
    [1234, null],
    [null, null],
  ];
  for (const [input, expected] of cases) {
    test(`canonicalTimestamp(${JSON.stringify(input)})`, () => assert.equal(B.canonicalTimestamp(input), expected));
  }

  test("isValidDate", () => {
    assert.equal(B.isValidDate("2026-10-31"), true);
    assert.equal(B.isValidDate("2024-02-29"), true);
    assert.equal(B.isValidDate("2026-02-29"), false);
    assert.equal(B.isValidDate("2026-13-01"), false);
    assert.equal(B.isValidDate("2026-1-5"), false);
    assert.equal(B.isValidDate("2026-10-16T00:00:00Z"), false);
    assert.equal(B.isValidDate(""), false);
    assert.equal(B.isValidDate(20261016), false);
  });

  test("nowIso is canonical UTC", () => {
    const t = B.nowIso();
    assert.match(t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(B.canonicalTimestamp(t), t);
  });
});

// ---------------------------------------------------------------- serialize

describe("serializeBoard", () => {
  const rankText = (rank) => {
    const text = B.serializeBoard(B.normalizeBoard({ tasks: [{ id: "a", title: "A", rank }] }));
    return /"rank": ([^,\n]+)/.exec(text)[1];
  };

  test("numbers are written like Python's json.dumps", () => {
    assert.equal(rankText(3), "3");
    assert.equal(rankText(-0), "0");
    assert.equal(rankText(0.5), "0.5");
    assert.equal(rankText(-2.25), "-2.25");
    assert.equal(rankText(0.1 + 0.2), "0.30000000000000004");
    assert.equal(rankText(0.0001), "0.0001");
    assert.equal(rankText(0.00001), "1e-05");
    assert.equal(rankText(1.5e-7), "1.5e-07");
    assert.equal(rankText(123456.789), "123456.789");
    assert.equal(rankText(2 ** 53), "9007199254740992");
    assert.equal(rankText(2 ** 53 + 2), "9007199254740994.0");
    assert.equal(rankText(2 ** 60), "1.152921504606847e+18");
    assert.equal(rankText(1e21), "1e+21");
  });

  test("key order, unicode, trailing newline", () => {
    const b = B.normalizeBoard({ notes: [{ body: "Ünïcode ✓ 😀\n\tline", id: "n1", pinned: true }] });
    const text = B.serializeBoard(b);
    assert.ok(text.endsWith("}\n"));
    assert.ok(text.includes('"body": "Ünïcode ✓ 😀\\n\\tline"'));
    assert.deepEqual(Object.keys(JSON.parse(text)), ["schema", "updated_at", "updated_by", "tasks", "requests", "notes"]);
    assert.deepEqual(Object.keys(JSON.parse(text).notes[0]), B.FIELD_ORDER.notes);
  });
});

// ---------------------------------------------------------------------- ops

describe("ops", () => {
  test("newId format and uniqueness", () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const id = B.newId("t");
      assert.match(id, /^t-[a-z0-9]{10}$/);
      seen.add(id);
    }
    assert.equal(seen.size, 2000);
  });

  test("opAdd / opUpdate / opDelete shapes", () => {
    const a = B.opAdd("tasks", { title: "X" }, "Richard");
    assert.equal(a.op, "add");
    assert.equal(a.coll, "tasks");
    assert.match(a.item.id, /^t-[a-z0-9]{10}$/);
    assert.equal(a.by, "Richard");
    assert.equal(B.canonicalTimestamp(a.ts), a.ts);
    assert.equal(B.validateOp(a), null);
    assert.deepEqual(Object.keys(a), ["op", "coll", "item", "ts", "by"]);

    const kept = B.opAdd("notes", { id: "n-fixed", body: "hi" });
    assert.equal(kept.item.id, "n-fixed");
    assert.equal("by" in kept, false);

    const u = B.opUpdate("tasks", "t-1", { status: "done" }, "");
    assert.deepEqual(Object.keys(u), ["op", "coll", "id", "set", "ts"]);
    assert.equal(B.validateOp(u), null);

    const d = B.opDelete("requests", "r-1", "pi");
    assert.deepEqual(Object.keys(d), ["op", "coll", "id", "ts", "by"]);
    assert.equal(B.validateOp(d), null);
  });

  test("applyOp is pure and returns the same board for no-ops", () => {
    const board = deepFreeze(B.normalizeBoard({ tasks: [{ id: "a", title: "A", rank: 1 }] }));
    const op = deepFreeze({ op: "update", coll: "tasks", id: "a", ts: "2026-10-16T14:00:00Z", set: { title: "B" } });
    const next = B.applyOp(board, op);
    assert.notEqual(next, board);
    assert.equal(next.tasks[0].title, "B");
    assert.equal(board.tasks[0].title, "A");
    const noop = { op: "update", coll: "tasks", id: "zzz", ts: "2026-10-16T14:00:00Z", set: { title: "B" } };
    assert.equal(B.applyOp(board, noop), board);
    assert.equal(B.applyOp(board, { op: "nope" }), board);
  });

  test("validateOp rejects lone values that would empty required text", () => {
    assert.match(B.validateOp({ op: "update", coll: "notes", id: "n", ts: "2026-10-16", set: { body: "\n\t\n" } }), /empty/);
    assert.equal(B.validateOp({ op: "update", coll: "notes", id: "n", ts: "2026-10-16", set: { body: "\n x \n" } }), null);
  });
});

// ------------------------------------------------------------ ranks & moves

function tasksBoard(ranks) {
  return B.normalizeBoard({ tasks: ranks.map((rank, i) => ({ id: `t${i}`, title: `T${i}`, rank })) });
}

describe("rankBetween", () => {
  test("cases", () => {
    assert.equal(B.rankBetween(null, null), 0);
    assert.equal(B.rankBetween(null, 5), 4);
    assert.equal(B.rankBetween(5, null), 6);
    assert.equal(B.rankBetween(1, 2), 1.5);
    assert.equal(B.rankBetween(-3, 1), -1);
    assert.ok(Number.isFinite(B.rankBetween(1.5e308, 1.7e308)));
  });
});

describe("planMove", () => {
  const TS = "2026-10-16T14:00:00Z";

  test("into an empty list -> rank 0", () => {
    const ops = B.planMove({ list: [], id: "x", toIndex: 0, ts: TS });
    assert.deepEqual(ops, [{ op: "update", coll: "tasks", id: "x", set: { rank: 0 }, ts: TS }]);
  });

  test("to the top -> first - 1", () => {
    const list = tasksBoard([1, 2, 3]).tasks;
    const ops = B.planMove({ list, id: "x", toIndex: 0, ts: TS, by: "web" });
    assert.deepEqual(ops, [{ op: "update", coll: "tasks", id: "x", set: { rank: 0 }, ts: TS, by: "web" }]);
  });

  test("to the bottom -> last + 1 (toIndex clamped)", () => {
    const list = tasksBoard([1, 2, 3]).tasks;
    assert.equal(B.planMove({ list, id: "x", toIndex: 3, ts: TS })[0].set.rank, 4);
    assert.equal(B.planMove({ list, id: "x", toIndex: 99, ts: TS })[0].set.rank, 4);
    assert.equal(B.planMove({ list, id: "x", toIndex: -5, ts: TS })[0].set.rank, 0);
  });

  test("into the middle -> midpoint", () => {
    const list = tasksBoard([1, 2, 3]).tasks;
    const ops = B.planMove({ list, id: "x", toIndex: 2, ts: TS });
    assert.equal(ops.length, 1);
    assert.equal(ops[0].set.rank, 2.5);
  });

  test("set is carried on the moving item's op (e.g. into Doing / Done)", () => {
    const list = tasksBoard([1, 2]).tasks;
    const ops = B.planMove({ list, id: "x", toIndex: 1, set: { status: "done", done_at: TS }, ts: TS });
    assert.deepEqual(ops[0].set, { rank: 1.5, status: "done", done_at: TS });
    for (const op of ops) assert.equal(B.validateOp(op), null);
  });

  test("the moving item is excluded from the list even if passed", () => {
    const list = tasksBoard([1, 2, 3]).tasks; // t0 t1 t2
    const ops = B.planMove({ list, id: "t0", toIndex: 2, ts: TS }); // after t2
    assert.deepEqual(ops.map((o) => [o.id, o.set.rank]), [["t0", 4]]);
  });

  test("tiny gap -> re-rank the destination list 1..n in the new order", () => {
    const board = tasksBoard([1, 1 + 1e-7, 3, 4]); // t0 t1 t2 t3
    const moving = B.normalizeItem("tasks", { id: "m", title: "M", rank: 10, status: "doing" }, 0);
    const withMoving = Object.assign({}, board, { tasks: board.tasks.concat([moving]) });
    const list = board.tasks;
    const ops = B.planMove({ list, id: "m", toIndex: 1, set: { status: "todo" }, ts: TS, by: "pi" });
    // new order: t0 m t1 t2 t3 -> ranks 1 2 3 4 5; t0 keeps rank 1
    assert.deepEqual(
      ops.map((o) => [o.id, o.set]),
      [["m", { rank: 2, status: "todo" }], ["t1", { rank: 3 }], ["t2", { rank: 4 }], ["t3", { rank: 5 }]],
    );
    for (const op of ops) {
      assert.equal(op.ts, TS);
      assert.equal(op.by, "pi");
      assert.equal(B.validateOp(op), null);
    }
    const after = B.applyOps(withMoving, ops);
    assert.deepEqual(after.tasks.map((t) => t.id), ["t0", "m", "t1", "t2", "t3"]);
    assert.equal(after.tasks[1].status, "todo");
  });

  test("equal neighbour ranks also trigger re-ranking", () => {
    const list = tasksBoard([5, 5]).tasks;
    const ops = B.planMove({ list, id: "x", toIndex: 1, ts: TS });
    assert.deepEqual(ops.map((o) => [o.id, o.set.rank]), [["t0", 1], ["x", 2], ["t1", 3]]);
  });

  test("ts defaults to now", () => {
    const [op] = B.planMove({ list: [], id: "x", toIndex: 0 });
    assert.equal(B.canonicalTimestamp(op.ts), op.ts);
  });
});

// ------------------------------------------------------------ commit messages

describe("summarizeOps", () => {
  const before = B.normalizeBoard({
    tasks: [
      { id: "t-a", title: "Calibrate pump", rank: 1 },
      { id: "t-b", title: "Old one", status: "done", rank: 2 },
    ],
    requests: [{ id: "r-a", item: "Gloves" }],
    notes: [{ id: "n-a", body: "Line one\nline two" }],
  });
  const TS = "2026-10-16T14:00:00Z";

  test("Python style subject and body", () => {
    const ops = [
      { op: "add", coll: "tasks", item: { id: "t-n", title: "Order pipettes" }, ts: TS, by: "lab-pi" },
      { op: "update", coll: "tasks", id: "t-a", set: { status: "done", done_at: TS }, ts: TS },
      { op: "update", coll: "tasks", id: "t-b", set: { status: "todo", done_at: "" }, ts: TS },
      { op: "delete", coll: "notes", id: "n-a", ts: TS },
      { op: "update", coll: "requests", id: "r-a", set: { status: "ordered" }, ts: TS },
    ];
    const { subject, body } = B.summarizeOps(ops, before, "lab-pi");
    assert.equal(subject, "lab-pi: add “Order pipettes”, complete “Calibrate pump” (+3 more)");
    assert.equal(
      body,
      [
        "- add task t-n “Order pipettes” (by lab-pi)",
        "- complete task t-a “Calibrate pump” [status, done_at]",
        "- reopen task t-b “Old one” [status, done_at]",
        "- delete note n-a “Line one”",
        "- edit request r-a “Gloves” [status]",
      ].join("\n"),
    );
  });

  test("all moves -> reorder N tasks", () => {
    const ops = B.planMove({ list: before.tasks, id: "t-x", toIndex: 0, ts: TS }).concat([
      { op: "update", coll: "tasks", id: "t-b", set: { rank: 9 }, ts: TS },
    ]);
    assert.equal(B.summarizeOps(ops, before, "web").subject, "web: reorder 2 tasks");
  });

  test("subject is at most 72 code points; empty batch", () => {
    const long = "😀".repeat(100);
    const ops = Array.from({ length: 5 }, (_, i) => ({ op: "add", coll: "notes", item: { id: `n${i}`, body: long }, ts: TS }));
    const { subject } = B.summarizeOps(ops, before, "a-very-long-client-name-for-testing");
    assert.ok(Array.from(subject).length <= 72, subject);
    assert.ok(subject.includes("(+4 more)"), subject);
    assert.deepEqual(B.summarizeOps([], before, "web"), { subject: "web: update board", body: "" });
    assert.equal(B.summarizeOps([], null, "").subject, "update board");
  });

  test("random batches never exceed 72 code points", () => {
    const r = rng(7);
    for (let i = 0; i < 200; i++) {
      const ops = Array.from({ length: 1 + Math.floor(r() * 6) }, (_, j) => ({
        op: "add",
        coll: B.COLLECTIONS[j % 3],
        item: { id: `x${j}`, title: NASTY[Math.floor(r() * NASTY.length)] + "z", item: "q", body: "b".repeat(Math.floor(r() * 90)) },
        ts: TS,
      }));
      const { subject } = B.summarizeOps(ops, null, NASTY[Math.floor(r() * NASTY.length)]);
      assert.ok(Array.from(subject).length <= 72, subject);
    }
  });
});

describe("constants", () => {
  test("exported enums and limits", () => {
    assert.deepEqual([...B.COLLECTIONS], ["tasks", "requests", "notes"]);
    assert.deepEqual([...B.TASK_STATUSES], ["todo", "doing", "done"]);
    assert.deepEqual([...B.PRIORITIES], ["high", "normal", "low"]);
    assert.deepEqual([...B.REQUEST_STATUSES], ["new", "ordered", "received"]);
    assert.deepEqual([...B.NOTE_COLORS], ["yellow", "blue", "green", "pink", "purple"]);
    assert.deepEqual({ ...B.ID_PREFIX }, { tasks: "t", requests: "r", notes: "n" });
    assert.deepEqual([...B.EDITABLE.tasks], ["title", "notes", "status", "priority", "assignee", "due", "tags", "rank", "done_at"]);
    assert.equal(B.LIMITS.fields.tasks.title, 300);
    assert.equal(B.LIMITS.maxItems, 2000);
    assert.deepEqual(B.emptyBoard(), { schema: 1, updated_at: "", updated_by: "", tasks: [], requests: [], notes: [] });
  });
});
