"""app/board.py against the shared vectors (tests/ops_vectors.json) + extras."""
import copy
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from app import board as B  # noqa: E402

with open(os.path.join(ROOT, "tests", "ops_vectors.json"), encoding="utf-8") as _f:
    VECTORS = json.load(_f)

TS = "2026-10-16T14:00:00Z"


def strict(obj):
    """JSON text that keeps key order and distinguishes true from 1."""
    return json.dumps(obj, ensure_ascii=False)


class VectorTests(unittest.TestCase):
    def assertSameDoc(self, actual, expected):
        self.assertEqual(actual, expected)
        self.assertEqual(strict(actual), strict(expected))

    def test_vector_counts(self):
        # guard against an accidentally emptied vectors file
        for key in ("normalize", "apply", "valid_ops", "invalid_ops", "serialize"):
            self.assertTrue(VECTORS[key], key)

    def test_normalize(self):
        for v in VECTORS["normalize"]:
            with self.subTest(v["name"]):
                inp = copy.deepcopy(v["input"])
                self.assertSameDoc(B.normalize_board(inp), v["output"])
                self.assertEqual(inp, v["input"], "normalize mutated its input")

    def test_normalize_idempotent(self):
        for v in VECTORS["normalize"]:
            with self.subTest(v["name"]):
                once = B.normalize_board(v["input"])
                self.assertSameDoc(B.normalize_board(once), once)
                self.assertSameDoc(B.normalize_board(v["output"]), v["output"])
        for v in VECTORS["apply"]:
            with self.subTest("apply: " + v["name"]):
                self.assertSameDoc(B.normalize_board(v["board"]), v["board"])
                self.assertSameDoc(B.normalize_board(v["expect"]), v["expect"])

    def test_apply(self):
        for v in VECTORS["apply"]:
            with self.subTest(v["name"]):
                board = copy.deepcopy(v["board"])
                ops = copy.deepcopy(v["ops"])
                self.assertSameDoc(B.apply_ops(board, ops), v["expect"])
                self.assertEqual(board, v["board"], "apply_ops mutated the board")
                self.assertEqual(ops, v["ops"], "apply_ops mutated the ops")
                # folding apply_op one at a time gives the same result
                folded = board
                for op in ops:
                    before = copy.deepcopy(folded)
                    nxt = B.apply_op(folded, op)
                    self.assertEqual(folded, before, "apply_op mutated its input")
                    folded = nxt
                self.assertSameDoc(folded, v["expect"])

    def test_valid_ops(self):
        for v in VECTORS["valid_ops"]:
            with self.subTest(v["name"]):
                self.assertIsNone(B.validate_op(v["op"]))

    def test_invalid_ops(self):
        for v in VECTORS["invalid_ops"]:
            with self.subTest(v["name"]):
                err = B.validate_op(v["op"])
                self.assertIsInstance(err, str)
                self.assertTrue(err)

    def test_invalid_ops_are_noops(self):
        board = B.normalize_board({"tasks": [{"id": "t-1", "title": "x"}], "notes": [{"id": "n-1", "body": "y"}]})
        for v in VECTORS["invalid_ops"]:
            with self.subTest(v["name"]):
                self.assertEqual(B.apply_op(board, v["op"]), board)

    def test_serialize(self):
        for v in VECTORS["serialize"]:
            with self.subTest(v["name"]):
                text = B.serialize_board(B.normalize_board(json.loads(v["input_text"])))
                self.assertEqual(text, v["output_text"])


class TimestampTests(unittest.TestCase):
    def test_grammar(self):
        cases = {
            "2026-10-16T14:03:22Z": "2026-10-16T14:03:22Z",
            "2026-10-16T14:03:22z": "2026-10-16T14:03:22Z",
            "2026-10-16 14:03": "2026-10-16T14:03:00Z",
            "2026-10-16": "2026-10-16T00:00:00Z",
            "2026-10-16T14:03:22.123456Z": "2026-10-16T14:03:22Z",
            "2026-10-16T10:03:22-04:00": "2026-10-16T14:03:22Z",
            "2026-10-16T23:30:00+0530": "2026-10-16T18:00:00Z",
            "2024-02-29T00:00:00Z": "2024-02-29T00:00:00Z",
            "2026-12-31T23:30:00-01:00": "2027-01-01T00:30:00Z",
        }
        for raw, want in cases.items():
            with self.subTest(raw):
                self.assertEqual(B.canonical_timestamp(raw), want)

    def test_invalid(self):
        for raw in (
            "", "2026-10-16t10:00:00Z", "2026-02-29", "2026-13-01", "2026-10-16T24:00:00Z",
            "2026-10-16T10:60:00Z", "2026-10-16T10:00:60Z", "1969-12-31T23:59:59Z",
            "2026-10-16T10:00:00+24:00", "2026-10-16T10:00:00+01:60", "2026-10-16T10",
            "2026-10-16T10:00.5Z", " 2026-10-16", "2026-10-16\n", "٢026-10-16",
            "1970-01-01T00:30:00+01:00", "9999-12-31T23:00:00-05:00", 1234, None, True,
        ):
            with self.subTest(repr(raw)):
                self.assertIsNone(B.canonical_timestamp(raw))

    def test_due(self):
        self.assertTrue(B.is_valid_date("2024-02-29"))
        self.assertFalse(B.is_valid_date("2100-02-29"))
        self.assertTrue(B.is_valid_date("2000-02-29"))
        self.assertFalse(B.is_valid_date("2026-1-01"))
        self.assertFalse(B.is_valid_date("2026-10-16\n"))


class NormalizeExtraTests(unittest.TestCase):
    def test_idempotent_on_tricky_inputs(self):
        doc = {
            "updated_by": "x" * 59 + " y",
            "tasks": [
                {"id": "a", "title": "a" * 299 + " bcd", "tags": ["# #Hash", "y" * 23 + " z", "İx"]},
                {"id": "b", "title": "﻿  b 　", "notes": " \n x \n "},
                {"id": "c", "title": "c", "rank": 10 ** 400},
                {"id": "d", "title": "d", "rank": 2.0},
                {"id": "e", "title": "e", "rank": -0.0},
            ],
            "requests": [{"id": "r", "item": "i", "link": "https://" + "x" * 600}],
        }
        once = B.normalize_board(doc)
        self.assertEqual(strict(B.normalize_board(once)), strict(once))
        self.assertEqual(once["updated_by"], "x" * 59)
        t = {it["id"]: it for it in once["tasks"]}
        self.assertEqual(t["a"]["title"], "a" * 299)
        self.assertEqual(t["a"]["tags"][0], "hash")
        self.assertEqual(t["a"]["tags"][1], "y" * 23)
        self.assertEqual(t["b"]["title"], "b")
        self.assertEqual(t["b"]["notes"], "x")
        self.assertEqual(t["c"]["rank"], 0)
        self.assertIsInstance(t["d"]["rank"], int)
        self.assertEqual(B.serialize_board(once).count('"rank": 2,'), 1)

    def test_max_items(self):
        doc = {"notes": [{"id": "n%04d" % i, "body": "x", "rank": -i} for i in range(2100)]}
        out = B.normalize_board(doc)
        self.assertEqual(len(out["notes"]), B.MAX_ITEMS)
        self.assertEqual(out["notes"][0]["id"], "n2099")  # lowest rank kept

    def test_add_into_full_collection_is_a_noop(self):
        full = B.normalize_board({"tasks": [{"id": "t%04d" % i, "title": "x", "rank": i} for i in range(B.MAX_ITEMS)]})
        add = {"op": "add", "coll": "tasks", "item": {"id": "t-new", "title": "new", "rank": -1}, "ts": TS}
        # no push of a 2001-item file whose normalization would drop t1999
        self.assertEqual(B.apply_op(full, add), full)
        deleted = B.apply_op(full, {"op": "delete", "coll": "tasks", "id": "t0005", "ts": TS})
        after = B.apply_ops(deleted, [add])
        self.assertEqual(len(after["tasks"]), B.MAX_ITEMS)
        self.assertEqual(after["tasks"][0]["id"], "t-new")
        self.assertEqual(B.normalize_board(after), after)

    def test_strict_json(self):
        with self.assertRaises(ValueError):
            B.parse_json_strict('{"rank": NaN}')
        self.assertEqual(B.parse_json_strict('{"a": 1}'), {"a": 1})

    def test_same_json(self):
        self.assertTrue(B.same_json({"a": 3, "b": [1]}, {"b": [1], "a": 3.0}))
        self.assertFalse(B.same_json({"a": True}, {"a": 1}))
        self.assertFalse(B.same_json([1, 2], [2, 1]))

    def test_lone_surrogate_serializes(self):
        board = B.normalize_board(json.loads('{"tasks": [{"id": "a", "title": "x\\ud800y"}]}'))
        data = B.serialize_board_bytes(board)
        self.assertIn(b"x\\ud800y", data)
        self.assertEqual(B.normalize_board(json.loads(data.decode("utf-8"))), board)


class OpExtraTests(unittest.TestCase):
    def setUp(self):
        self.board = B.normalize_board({
            "tasks": [
                {"id": "t-a", "title": "Calibrate pump", "rank": 1},
                {"id": "t-b", "title": "Done thing", "status": "done", "rank": 2, "done_at": "2026-10-01T00:00:00Z"},
            ]
        })

    def test_add_invalid_created_at_uses_ts(self):
        op = {"op": "add", "coll": "tasks", "ts": "2026-10-16T14:00:00Z",
              "item": {"id": "t-n", "title": "New", "created_at": "garbage"}}
        out = B.apply_op(self.board, op)
        item = [t for t in out["tasks"] if t["id"] == "t-n"][0]
        self.assertEqual(item["created_at"], "2026-10-16T14:00:00Z")
        self.assertEqual(item["updated_at"], "2026-10-16T14:00:00Z")

    def test_add_control_char_title_rejected(self):
        op = {"op": "add", "coll": "tasks", "ts": "2026-10-16T14:00:00Z", "item": {"id": "t-n", "title": "\u0007"}}
        self.assertIsNotNone(B.validate_op(op))

    def test_rank_huge_int_rejected(self):
        op = {"op": "update", "coll": "tasks", "id": "t-a", "ts": "2026-10-16T14:00:00Z", "set": {"rank": 10 ** 400}}
        self.assertIsNotNone(B.validate_op(op))

    def test_apply_does_not_share_items(self):
        op = {"op": "update", "coll": "tasks", "id": "t-a", "ts": "2026-10-16T14:00:00Z", "set": {"title": "X"}}
        out = B.apply_op(self.board, op)
        out["tasks"][0]["title"] = "mutated"
        self.assertEqual(self.board["tasks"][0]["title"], "Calibrate pump")

    def test_summarize(self):
        ts = "2026-10-16T14:00:00Z"
        ops = [
            {"op": "add", "coll": "tasks", "ts": ts, "item": {"id": "t-1", "title": "Order tips"}, "by": "Richard"},
            {"op": "update", "coll": "tasks", "id": "t-a", "ts": ts, "set": {"status": "done", "done_at": ts}},
            {"op": "update", "coll": "tasks", "id": "t-b", "ts": ts, "set": {"status": "todo", "done_at": ""}},
            {"op": "update", "coll": "tasks", "id": "t-a", "ts": ts, "set": {"rank": 5}},
            {"op": "update", "coll": "tasks", "id": "t-1", "ts": ts, "set": {"priority": "high"}},
            {"op": "delete", "coll": "tasks", "id": "t-gone", "ts": ts},
        ]
        subject, body = B.summarize_ops(ops, self.board, client="lab-pi")
        self.assertEqual(subject, "lab-pi: add “Order tips”, complete “Calibrate pump” (+4 more)")
        lines = body.split("\n")
        self.assertEqual(len(lines), 6)
        self.assertTrue(lines[0].startswith("- add task t-1"))
        self.assertIn("(by Richard)", lines[0])
        self.assertTrue(lines[2].startswith("- reopen task t-b"))
        self.assertTrue(lines[3].startswith("- move task t-a"))
        self.assertTrue(lines[4].startswith("- edit task t-1 “Order tips”"))
        self.assertTrue(lines[5].startswith("- delete task t-gone"))

    def test_summarize_length_and_reorder(self):
        ts = "2026-10-16T14:00:00Z"
        long_title = "A very long task title " * 10
        ops = [{"op": "add", "coll": "notes", "ts": ts, "item": {"id": "n-%d" % i, "body": long_title}} for i in range(5)]
        subject, _ = B.summarize_ops(ops, B.empty_board(), client="lab-pi")
        self.assertLessEqual(len(subject), 72)
        self.assertTrue(subject.startswith("lab-pi: add note “"))
        self.assertTrue(subject.endswith("(+4 more)") or "more)" in subject)
        moves = [{"op": "update", "coll": "tasks", "id": "t-a", "ts": ts, "set": {"rank": i}} for i in range(3)]
        self.assertEqual(B.summarize_ops(moves, self.board, client="pi")[0], "pi: reorder 3 tasks")
        single = B.summarize_ops([ops[0]], B.empty_board(), client="x" * 70)[0]
        self.assertLessEqual(len(single), 72)


if __name__ == "__main__":
    unittest.main()
