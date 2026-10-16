// Tests for static/js/quickadd.js. "Today" is fixed to Wednesday 2026-10-14 (local).
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseQuickAdd, parseDue, formatDueLabel } from "../../static/js/quickadd.js";

const TODAY = new Date(2026, 9, 14, 15, 30); // Wed Oct 14 2026, mid-afternoon local
assert.equal(TODAY.getDay(), 3, "fixture must be a Wednesday");

const q = (text) => parseQuickAdd(text, TODAY);

describe("parseQuickAdd", () => {
  test("all token kinds at once", () => {
    assert.deepEqual(q("Order tips @mei !high #Bio due:fri"), {
      title: "Order tips",
      assignee: "mei",
      priority: "high",
      tags: ["bio"],
      due: "2026-10-16",
    });
  });

  test("plain text has no extras; priority null when absent", () => {
    assert.deepEqual(q("  Calibrate   the  pump "), { title: "Calibrate the pump", assignee: "", priority: null, tags: [], due: "" });
    assert.deepEqual(q(""), { title: "", assignee: "", priority: null, tags: [], due: "" });
  });

  test("assignee: underscores become spaces, last wins, trailing dot dropped", () => {
    assert.equal(q("x @Mei_Ling").assignee, "Mei Ling");
    assert.equal(q("x @ann @bob").assignee, "bob");
    assert.equal(q("ask @j.doe.").assignee, "j.doe");
    assert.equal(q("x @Zoë").assignee, "Zoë");
    assert.equal(q("mail bob@example.com").title, "mail bob@example.com");
    assert.equal(q("lone @ sign").title, "lone @ sign");
  });

  test("priority tokens", () => {
    for (const t of ["!high", "!h", "!!", "!urgent", "!HIGH"]) assert.equal(q(`x ${t}`).priority, "high", t);
    for (const t of ["!low", "!l"]) assert.equal(q(`x ${t}`).priority, "low", t);
    for (const t of ["!normal", "!n"]) assert.equal(q(`x ${t}`).priority, "normal", t);
    assert.equal(q("x !low !high").priority, "high");
    assert.equal(q("wow! great").title, "wow! great");
    assert.equal(q("wow! great").priority, null);
  });

  test("tags: lower-cased, de-duplicated, need a letter", () => {
    assert.deepEqual(q("x #A #a #b-2 #Bio").tags, ["a", "b-2", "bio"]);
    assert.equal(q("sample #2 done").title, "sample #2 done");
    assert.deepEqual(q("sample #2 done").tags, []);
    assert.equal(q("C# is fine").title, "C# is fine");
    assert.deepEqual(q("x #").tags, []);
  });

  test("due keywords", () => {
    const cases = {
      "due:today": "2026-10-14",
      "^tod": "2026-10-14",
      "^tomorrow": "2026-10-15",
      "^tmr": "2026-10-15",
      "due:tom": "2026-10-15",
      "^wed": "2026-10-14", // today counts
      "^thu": "2026-10-15",
      "^fri": "2026-10-16",
      "^friday": "2026-10-16",
      "^SUN": "2026-10-18",
      "^mon": "2026-10-19",
      "^tue": "2026-10-20",
      "^tuesday": "2026-10-20",
      "^+3d": "2026-10-17",
      "^3d": "2026-10-17",
      "due:+0d": "2026-10-14",
      "^+20d": "2026-11-03",
      "^1w": "2026-10-21",
      "^10/30": "2026-10-30",
      "^10/14": "2026-10-14",
      "^10/13": "2027-10-13", // already past -> next year
      "^1/5": "2027-01-05",
      "due:2026-11-02": "2026-11-02",
      "DUE:Fri": "2026-10-16",
    };
    for (const [token, due] of Object.entries(cases)) {
      const r = q(`Run gel ${token}`);
      assert.equal(r.due, due, token);
      assert.equal(r.title, "Run gel", token);
    }
  });

  test("unparseable due tokens stay in the title", () => {
    for (const token of ["due:someday", "^2026-02-30", "^13/40", "^2/30", "due:"]) {
      const r = q(`Run gel ${token}`);
      assert.equal(r.due, "", token);
      assert.equal(r.title, `Run gel ${token}`, token);
    }
  });

  test("month/day across years and leap days", () => {
    assert.equal(parseDue("2/29", new Date(2027, 2, 1)), "2028-02-29"); // 2027 has none
    assert.equal(parseDue("2/29", new Date(2028, 0, 10)), "2028-02-29");
    assert.equal(parseDue("12/31", new Date(2026, 11, 31)), "2026-12-31");
  });

  test("month boundaries in local time", () => {
    assert.equal(parseDue("tomorrow", new Date(2026, 9, 31, 23, 59)), "2026-11-01");
    assert.equal(parseDue("+1d", new Date(2026, 11, 31)), "2027-01-01");
  });
});

describe("formatDueLabel", () => {
  const md = (y, m, d, withYear = false) =>
    new Date(y, m - 1, d).toLocaleDateString(undefined, withYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" });
  const wd = (y, m, d) => new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short" });

  test("tones and labels", () => {
    assert.deepEqual(formatDueLabel("2026-10-12", TODAY), { label: `Overdue · ${md(2026, 10, 12)}`, tone: "overdue" });
    assert.deepEqual(formatDueLabel("2026-10-14", TODAY), { label: "Today", tone: "today" });
    assert.deepEqual(formatDueLabel("2026-10-15", TODAY), { label: "Tomorrow", tone: "soon" });
    assert.deepEqual(formatDueLabel("2026-10-16", TODAY), { label: wd(2026, 10, 16), tone: "soon" });
    assert.deepEqual(formatDueLabel("2026-10-20", TODAY), { label: wd(2026, 10, 20), tone: "soon" });
    assert.deepEqual(formatDueLabel("2026-10-21", TODAY), { label: md(2026, 10, 21), tone: "later" });
    assert.deepEqual(formatDueLabel("2027-01-05", TODAY), { label: md(2027, 1, 5, true), tone: "later" });
    assert.deepEqual(formatDueLabel("2025-12-30", TODAY), { label: `Overdue · ${md(2025, 12, 30, true)}`, tone: "overdue" });
  });

  test("empty or invalid due", () => {
    assert.deepEqual(formatDueLabel("", TODAY), { label: "", tone: "" });
    assert.deepEqual(formatDueLabel("2026-02-30", TODAY), { label: "", tone: "" });
    assert.deepEqual(formatDueLabel(null, TODAY), { label: "", tone: "" });
  });

  test("weekday label matches the en-US short name when the locale is English", () => {
    const label = formatDueLabel("2026-10-16", TODAY).label;
    if (/^en/i.test(Intl.DateTimeFormat().resolvedOptions().locale)) assert.equal(label, "Fri");
  });
});
