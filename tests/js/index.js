// Entry point for `node --test tests/js/` (npm test).
//
// Node >= 21 treats each `--test` argument as a file or glob, not a directory,
// so "tests/js/" resolves to this index file, which loads every *.test.mjs
// here into one test run. `node --test` with no arguments (auto-discovery) and
// `node --test "tests/js/*.test.mjs"` also work and do not load this file.
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
for (const name of readdirSync(dir).filter((n) => n.endsWith(".test.mjs")).sort()) {
  await import(new URL(name, import.meta.url).href);
}
