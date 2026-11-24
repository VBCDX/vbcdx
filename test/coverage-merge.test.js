// scripts/coverage.mjs merges the raw V8 coverage of many processes. These tests pin the
// merge against hand-built V8 reports (the shape of a coverage-*.json file), then run the
// whole runner over a small repository built in a temp directory.
//
// The V8 behaviour the merge has to undo: a process lists a block only when its count differs
// from the code around it. So one process lists a block it skipped (count 0) while a process
// that ran it lists nothing for it. Adding up listed counts alone would leave it uncovered.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir } from "./helpers/temp-dir.js";
import {
  addProcessCoverage, createMerge, lineRanges, main, measuredFiles, measuredPath, percent, sourceLines, summarize, summarizeFile, table, testFiles, totalsOf,
} from "../scripts/coverage.mjs";

const ROOT = "/repo";
const url = (rel) => pathToFileURL(join(ROOT, rel)).href;

const SOURCE = [
  "export function used(flag) {", // 1
  "  if (flag) {", //                2
  "    return 1;", //                3
  "  }", //                          4
  "", //                             5
  "  return 2;", //                  6
  "}", //                            7
  "", //                             8
  "export function unused() {", //   9
  "", //                            10
  "  return 3;", //                 11
  "}", //                           12
  "",
].join("\n");

const lines = sourceLines(SOURCE);
const startOf = (text) => {
  const at = SOURCE.indexOf(text);
  assert.notEqual(at, -1, `the fixture has no ${text}`);
  return at;
};
// The ranges V8 would report: a function starts at its `function` keyword, so the line it
// starts on is not wholly inside it.
const MODULE = [0, SOURCE.length];
const USED = [startOf("function used"), lines[6].endOffset];
const IF_BLOCK = [startOf("{\n    return 1;"), lines[3].endOffset];
const AFTER_IF = [lines[3].endOffset, lines[6].endOffset];
const UNUSED = [startOf("function unused"), lines[11].endOffset];

const range = ([startOffset, endOffset], count) => ({ startOffset, endOffset, count });
const fn = (functionName, ranges, isBlockCoverage = true) => ({ functionName, isBlockCoverage, ranges });
const report = (...scripts) => ({ result: scripts.map(([scriptUrl, functions], i) => ({ scriptId: String(i), url: scriptUrl, functions })) });
const moduleBody = (count = 1) => fn("", [range(MODULE, count)]);
const uncalled = (name, where) => fn(name, [range(where, 0)], false);

function merged(reports, sources = { "src/a.js": SOURCE }) {
  const merge = createMerge(ROOT, new Map(Object.entries(sources)));
  for (const r of reports) addProcessCoverage(merge, r);
  return summarize(merge);
}

test("a function one process called and another didn't is covered, and its skipped block is not", () => {
  const ran = report([url("src/a.js"), [moduleBody(), fn("used", [range(USED, 2), range(IF_BLOCK, 0)]), uncalled("unused", UNUSED)]]);
  const idle = report([url("src/a.js"), [moduleBody(), uncalled("used", USED), uncalled("unused", UNUSED)]]);
  for (const order of [[ran, idle], [idle, ran]]) {
    const [file] = merged(order).files;
    assert.deepEqual(file.functions, { covered: 1, count: 2 }, "used is covered, unused is not; the module body is not a function");
    // The universe: the module body, used, its if block, unused.
    assert.deepEqual(file.branches, { covered: 2, count: 4 });
    // Line 3 and 4 are wholly inside the skipped block (the inner range wins over the covered
    // function around it); 10 to 12 are inside the uncalled function, its blank line included.
    // Lines 1 and 9 start outside their function, and 2 only starts the block: all three stand.
    assert.deepEqual(file.uncoveredLines, [3, 4, 10, 11, 12]);
    assert.deepEqual(file.lines, { covered: 7, count: 12 });
    assert.equal(file.loaded, true);
  }
});

test("a block only one process listed is in the universe, and a process that folded it into its surroundings ran it", () => {
  // One process skipped the if block, so it lists it with count 0. The other took it every time:
  // V8 lists no range for the block there (same count as the function) but lists the rest of the
  // function, which it never reached.
  const skipped = report([url("src/a.js"), [moduleBody(), fn("used", [range(USED, 1), range(IF_BLOCK, 0)]), uncalled("unused", UNUSED)]]);
  const taken = report([url("src/a.js"), [moduleBody(), fn("used", [range(USED, 1), range(AFTER_IF, 0)]), uncalled("unused", UNUSED)]]);
  for (const order of [[skipped, taken], [taken, skipped]]) {
    const [file] = merged(order).files;
    // module body, used, the if block, the rest after it, unused: only unused never ran.
    assert.deepEqual(file.branches, { covered: 4, count: 5 });
    assert.deepEqual(file.uncoveredLines, [10, 11, 12]);
  }
  // Each process alone leaves its own listed block uncovered.
  assert.deepEqual(merged([skipped]).files[0].uncoveredLines, [3, 4, 10, 11, 12]);
  assert.deepEqual(merged([skipped]).files[0].branches, { covered: 2, count: 4 });
  assert.deepEqual(merged([taken]).files[0].uncoveredLines, [5, 6, 7, 10, 11, 12]);
});

test("a block no process ran stays uncovered however many processes list it", () => {
  const skipped = report([url("src/a.js"), [moduleBody(), fn("used", [range(USED, 3), range(IF_BLOCK, 0)]), uncalled("unused", UNUSED)]]);
  const [file] = merged([skipped, skipped, skipped]).files;
  assert.deepEqual(file.branches, { covered: 2, count: 4 });
  assert.deepEqual(file.uncoveredLines, [3, 4, 10, 11, 12]);
});

test("a listed block that starts where a wider unlisted one does says nothing about the wider one", () => {
  // Offsets only: a function [10,100) with a block [20,60) that holds a block [20,40).
  const source = `${"x".repeat(100)}\n`;
  const wide = report([url("src/a.js"), [fn("", [range([0, 101], 1)]), fn("f", [range([10, 100], 1), range([20, 60], 0)])]]);
  const narrow = report([url("src/a.js"), [fn("", [range([0, 101], 1)]), fn("f", [range([10, 100], 1), range([20, 40], 0)])]]);
  const [file] = merged([wide, narrow], { "src/a.js": source }).files;
  // [20,60) ran in the second process (it is folded into f there; [20,40) is a block inside it).
  // [20,40) ran in neither: the first process skipped all of [20,60).
  assert.deepEqual(file.branches, { covered: 3, count: 4 });

  // A range the process lists is judged by its own count, even next to a listed range that
  // straddles its start (V8 can join two neighbours into one range).
  const straddled = report([url("src/a.js"), [fn("", [range([0, 101], 1)]), fn("f", [range([10, 100], 1), range([15, 30], 0), range([20, 60], 1)])]]);
  assert.deepEqual(merged([straddled], { "src/a.js": source }).files[0].branches, { covered: 3, count: 4 });
});

test("nested ranges: the innermost range decides a line, whatever order the functions arrive in", () => {
  const source = [
    "export function outer() {", //   1
    "  function inner() {", //        2
    "    return 1;", //               3
    "  }", //                         4
    "  return inner;", //             5
    "}", //                           6
    "",
  ].join("\n");
  const at = sourceLines(source);
  const outer = [source.indexOf("function outer"), at[5].endOffset];
  const inner = [source.indexOf("function inner"), at[3].endOffset];
  const body = fn("", [range([0, source.length], 1)]);
  // The first process reports inner before outer exists in the merge.
  const first = report([url("src/n.js"), [body, uncalled("inner", inner)]]);
  const second = report([url("src/n.js"), [body, fn("outer", [range(outer, 1)]), uncalled("inner", inner)]]);
  const [file] = merged([first, second], { "src/n.js": source }).files;
  assert.deepEqual(file.uncoveredLines, [3, 4], "inner's lines stay uncovered inside the covered outer");
  assert.deepEqual(file.functions, { covered: 1, count: 2 });

  // And the other way round: a covered inner range inside a range that some process skipped.
  const calledBoth = report([url("src/n.js"), [body, fn("outer", [range(outer, 1)]), fn("inner", [range(inner, 4)])]]);
  const all = merged([first, second, calledBoth], { "src/n.js": source }).files[0];
  assert.deepEqual(all.uncoveredLines, []);
  assert.deepEqual(all.functions, { covered: 2, count: 2 });

  // Two ranges that start at the same offset: the shorter one is the inner one.
  const flush = "function idle() {\n  return 1;\n}\nidle.name;\n";
  const idle = [0, flush.indexOf("}") + 1];
  const [same] = merged([report([url("src/n.js"), [fn("", [range([0, flush.length], 1)]), uncalled("idle", idle)]])], { "src/n.js": flush }).files;
  assert.deepEqual(same.uncoveredLines, [1, 2, 3]);
  assert.deepEqual(same.lines, { covered: 1, count: 4 });
});

test("only .js files under bin/ and src/ of this repository are merged", () => {
  const everything = [fn("", [range(MODULE, 1)]), fn("used", [range(USED, 1)]), fn("unused", [range(UNUSED, 1)])];
  const outside = [
    url("test/a.test.js"), url("scripts/coverage.mjs"), url("node_modules/yaml/index.js"), url("src/node_modules/x/index.js"),
    url("src/a.mjs"), url("src/a.json"), url("srcs/a.js"), url("a.js"), pathToFileURL("/elsewhere/src/a.js").href,
    "node:internal/modules/esm/loader", "evalmachine.<anonymous>", "", "file://%zz", "https://example.org/src/a.js",
  ];
  for (const u of outside) assert.equal(measuredPath(u, ROOT), null, `${u} is not measured`);
  assert.equal(measuredPath(undefined, ROOT), null);
  const merge = createMerge(ROOT, new Map([["src/a.js", SOURCE]]));
  addProcessCoverage(merge, report(...outside.map((u) => [u, everything])));
  assert.equal(merge.files.size, 0);
  // None of them covers src/a.js either: it stays a file no test loaded.
  const summary = summarize(merge);
  assert.equal(summary.files[0].loaded, false);
  assert.deepEqual(summary.skipped, [], "they are not this repository's files, so nothing was left out either");

  assert.equal(measuredPath(url("src/a.js"), ROOT), "src/a.js");
  assert.equal(measuredPath(url("bin/cli.js"), ROOT), "bin/cli.js");
  assert.equal(measuredPath(url("src/deep/er/a.js"), ROOT), "src/deep/er/a.js");
  // The same file imported with a query string is the same file.
  assert.equal(measuredPath(`${url("src/a.js")}?v=2`, ROOT), "src/a.js");
  const again = merged([report([`${url("src/a.js")}?v=2`, [moduleBody(), fn("used", [range(USED, 1)]), fn("unused", [range(UNUSED, 1)])]])]);
  assert.deepEqual(again.files[0].functions, { covered: 2, count: 2 });
});

test("a file no process loaded is counted, wholly uncovered", () => {
  const summary = merged(
    [report([url("src/a.js"), [moduleBody(), fn("used", [range(USED, 1)]), fn("unused", [range(UNUSED, 1)])]])],
    { "src/a.js": SOURCE, "src/never.js": "export const a = 1;\n\nexport const b = 2;\n" },
  );
  const never = summary.files.find((f) => f.path === "src/never.js");
  assert.deepEqual(never, {
    path: "src/never.js", loaded: false, lines: { covered: 0, count: 3 }, branches: { covered: 0, count: 1 }, functions: { covered: 0, count: 1 }, uncoveredLines: [1, 2, 3],
  });
  // It pulls the totals down: 12 covered lines of 15, 2 functions of 3, 3 branches of 4.
  assert.deepEqual(summary.totals, { lines: { covered: 12, count: 15 }, branches: { covered: 3, count: 4 }, functions: { covered: 2, count: 3 } });
  assert.deepEqual(summary.files.map((f) => f.path), ["src/a.js", "src/never.js"]);
  assert.deepEqual(totalsOf(summary.files), summary.totals);
});

test("a report with no functions, no ranges or no result adds nothing and breaks nothing", () => {
  const merge = createMerge(ROOT, new Map([["src/a.js", SOURCE]]));
  addProcessCoverage(merge, {});
  addProcessCoverage(merge, null);
  addProcessCoverage(merge, { result: [{ url: url("src/a.js") }, { url: url("src/a.js"), functions: [{ functionName: "x" }, { functionName: "y", ranges: [] }] }] });
  const summary = summarize(merge);
  assert.equal(summary.files[0].loaded, false);
  assert.deepEqual(summary.files[0].lines, { covered: 0, count: 12 });
  assert.deepEqual(summary.skipped, []);
});

test("a process that loaded a module as another text is left out for that module, and counted", () => {
  // A loader hook put 20 characters in front of the module: every offset is 20 further on, and
  // the module body is 20 longer than the file. Its counts would land on the wrong lines.
  const shift = ([a, b]) => [a + 20, b + 20];
  const rewritten = report(
    [url("src/a.js"), [fn("", [range([0, SOURCE.length + 20], 1)]), fn("used", [range(shift(USED), 1)]), fn("unused", [range(shift(UNUSED), 1)])]],
    [url("src/b.js"), [fn("", [range([0, 2], 1)])]],
  );
  const alone = merged([rewritten], { "src/a.js": SOURCE, "src/b.js": "x\n" });
  assert.equal(alone.files[0].loaded, false);
  assert.deepEqual(alone.files[0].functions, { covered: 0, count: 1 });
  assert.deepEqual(alone.skipped, [{ path: "src/a.js", reports: 1 }]);
  // The same process's report of a module it loaded unchanged is merged.
  assert.deepEqual(alone.files[1].lines, { covered: 1, count: 1 });

  // Next to a process that loaded the file itself, only that process counts.
  const real = report([url("src/a.js"), [moduleBody(), fn("used", [range(USED, 1), range(IF_BLOCK, 0)]), uncalled("unused", UNUSED)]]);
  const both = merged([rewritten, real, rewritten], { "src/a.js": SOURCE, "src/b.js": "x\n" });
  assert.deepEqual(both.files[0].functions, { covered: 1, count: 2 });
  assert.deepEqual(both.files[0].uncoveredLines, [3, 4, 10, 11, 12]);
  assert.deepEqual(both.skipped, [{ path: "src/a.js", reports: 2 }]);

  // A body that doesn't start at 0, and a file that is not among the measured ones, likewise.
  const offStart = merged([report([url("src/a.js"), [fn("", [range([1, SOURCE.length], 1)])]]), report([url("src/gone.js"), [fn("", [range([0, 5], 1)])]])]);
  assert.deepEqual(offStart.skipped, [{ path: "src/a.js", reports: 1 }, { path: "src/gone.js", reports: 1 }]);
  assert.equal(offStart.files.length, 1);
  assert.equal(offStart.files[0].loaded, false);
});

test("lines are split the way their offsets are counted", () => {
  assert.deepEqual(sourceLines("ab\n\ncd"), [{ startOffset: 0, endOffset: 2 }, { startOffset: 3, endOffset: 3 }, { startOffset: 4, endOffset: 6 }]);
  assert.deepEqual(sourceLines("ab\r\ncd\r\n"), [{ startOffset: 0, endOffset: 2 }, { startOffset: 4, endOffset: 6 }]);
  assert.equal(sourceLines(SOURCE).length, 12, "a final newline does not start another line");
  // A range covers a line only when it spans all of it.
  const source = "aaaa\nbbbb\ncccc\n";
  const whole = fn("", [range([0, source.length], 0)]);
  const partial = summarizeFile("src/p.js", source, new Map([["k", { moduleBody: false, variants: new Map([["v", [{ startOffset: 2, endOffset: 12, ran: true }]]]) }]]));
  assert.deepEqual(partial.uncoveredLines, [1, 3], "only line 2 is wholly inside [2,12)");
  assert.deepEqual(merged([report([url("src/p.js"), [whole]])], { "src/p.js": source }).files[0].uncoveredLines, [1, 2, 3]);
  // A range that none of a report's ranges is around did not run in that report's process.
  const apart = summarizeFile("src/p.js", source, new Map([["k", { moduleBody: false, variants: new Map([
    ["v", [{ startOffset: 0, endOffset: 4, ran: true }]], ["w", [{ startOffset: 5, endOffset: 9, ran: false }]],
  ]) }]]));
  assert.deepEqual(apart.branches, { covered: 1, count: 2 });
  assert.deepEqual(apart.uncoveredLines, [2, 3]);
});

test("percentages are cut, never rounded up, and the table names every file", () => {
  assert.equal(percent({ covered: 9999, count: 10000 }), "99.99");
  assert.equal(percent({ covered: 99999, count: 100000 }), "99.99");
  assert.equal(percent({ covered: 1, count: 3 }), "33.33");
  assert.equal(percent({ covered: 2, count: 3 }, 1), "66.6");
  assert.equal(percent({ covered: 3, count: 3 }), "100.00");
  assert.equal(percent({ covered: 0, count: 0 }), "100.00");
  assert.equal(lineRanges([1, 2, 3, 7, 9, 10]), "1-3 7 9-10");
  assert.equal(lineRanges([]), "");

  const summary = merged(
    [report([url("src/a.js"), [moduleBody(), fn("used", [range(USED, 1), range(IF_BLOCK, 0)]), uncalled("unused", UNUSED)]])],
    { "src/a.js": SOURCE, "src/never.js": "x\n" },
  );
  const rows = table(summary).split("\n");
  assert.equal(rows.length, 4);
  assert.match(rows[0], /^file\s+lines\s+branches\s+functions\s+uncovered lines$/);
  assert.match(rows[1], /^src\/a\.js\s+58\.33\s+7\/12\s+50\.00\s+2\/4\s+50\.00\s+1\/2\s+3-4 10-12$/);
  assert.match(rows[2], /^src\/never\.js\s+0\.00\s+0\/1\s+0\.00\s+0\/1\s+0\.00\s+0\/1\s+never loaded by a test$/);
  assert.match(rows[3], /^total\s+53\.84\s+7\/13\s+40\.00\s+2\/5\s+33\.33\s+1\/3$/);
});

// A small repository: src/lib.js with a function only a child process calls, a CLI the tests
// start with a replaced environment, and a module nothing loads.
function fixtureRepo(extraTests = {}) {
  const root = tempDir("vbcdx-coverage-");
  const write = (rel, text) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  write("package.json", JSON.stringify({ type: "module" }));
  write("src/lib.js", [
    "export function inProcess() {",
    "  return 1;",
    "}",
    "export function inChild() {",
    "  return 2;",
    "}",
    "export function never() {",
    "  return 3;",
    "}",
    "",
  ].join("\n"));
  write("src/never.js", "export const nothing = 0;\n");
  write("src/data.json", "{}\n");
  write("src/node_modules/dep/index.js", "export default 1;\n");
  write("bin/cli.js", 'import { inChild } from "../src/lib.js";\nprocess.stdout.write(`${inChild()} ${Object.keys(process.env).includes("SECRET")}\\n`);\n');
  write("test/in-process.test.js", [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { inProcess } from "../src/lib.js";',
    'import { mkdirSync, writeFileSync } from "node:fs";',
    'test("in process", () => assert.equal(inProcess(), 1));',
    "// Something else that turns up next to the raw reports is not read as one.",
    "mkdirSync(process.env.NODE_V8_COVERAGE, { recursive: true });",
    'writeFileSync(`${process.env.NODE_V8_COVERAGE}/notes.json`, "not a report");',
    "",
  ].join("\n"));
  write("test/child.test.js", [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { execFileSync } from "node:child_process";',
    "// The child gets a replaced environment: nothing of the caller's but PATH.",
    'test("child", () => assert.equal(execFileSync(process.execPath, ["bin/cli.js"], { env: { PATH: process.env.PATH }, encoding: "utf8" }), "2 false\\n"));',
    "",
  ].join("\n"));
  write("test/helpers/not-a-test.js", 'throw new Error("a helper is not run as a test file");\n');
  for (const [rel, text] of Object.entries(extraTests)) write(rel, text);
  return root;
}

async function run(args) {
  const out = [];
  const err = [];
  const code = await main(args, { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

test("the runner measures each test file's process and its children, a child with a replaced environment included", async () => {
  const root = fixtureRepo();
  assert.deepEqual(measuredFiles(root), ["bin/cli.js", "src/lib.js", "src/never.js"]);
  assert.deepEqual(testFiles(root), ["test/child.test.js", "test/in-process.test.js"]);
  const r = await run(["--root", root, "--jobs", "2"]);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  assert.equal(r.stderr, "");
  const summary = JSON.parse(readFileSync(join(root, "coverage", "summary.json"), "utf8"));
  const byPath = Object.fromEntries(summary.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath), ["bin/cli.js", "src/lib.js", "src/never.js"]);
  // bin/cli.js ran only in the child that was given a replaced environment.
  assert.equal(byPath["bin/cli.js"].loaded, true);
  assert.deepEqual(byPath["bin/cli.js"].lines, { covered: 2, count: 2 });
  // inProcess ran in one test file's process, inChild in the other's child; never in none.
  assert.deepEqual(byPath["src/lib.js"].functions, { covered: 2, count: 3 });
  assert.deepEqual(byPath["src/lib.js"].uncoveredLines, [8, 9]);
  assert.deepEqual(byPath["src/never.js"].lines, { covered: 0, count: 1 });
  assert.equal(byPath["src/never.js"].loaded, false);
  assert.deepEqual(summary.totals.lines, { covered: 9, count: 12 });
  assert.deepEqual(summary.tests, [{ file: "test/child.test.js", ok: true }, { file: "test/in-process.test.js", ok: true }]);
  assert.match(r.stdout, /^ok {3}test\/child\.test\.js \(/m);
  assert.match(r.stdout, /^src\/lib\.js\s+77\.77\s+7\/9\s.*\s8-9$/m);
  assert.match(r.stdout, /^coverage: 2 test files, \d+ process reports, 3 files measured$/m);
  assert.match(r.stdout, /^coverage: lines 75\.00% \(9\/12\)$/m);
  assert.match(r.stdout, /^coverage: wrote coverage\/summary\.json$/m);
  assert.equal(existsSync(join(root, "coverage", "raw")), false, "the raw reports are removed");
});

test("one named test file measures only what that file runs, and --keep-raw and --out are honoured", async () => {
  const root = fixtureRepo();
  const r = await run(["--root", root, "--out", "elsewhere", "--keep-raw", "test/in-process.test.js"]);
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const summary = JSON.parse(readFileSync(join(root, "elsewhere", "summary.json"), "utf8"));
  const byPath = Object.fromEntries(summary.files.map((f) => [f.path, f]));
  assert.equal(byPath["bin/cli.js"].loaded, false);
  assert.deepEqual(byPath["src/lib.js"].functions, { covered: 1, count: 3 });
  assert.deepEqual(summary.tests, [{ file: "test/in-process.test.js", ok: true }]);
  assert.equal(existsSync(join(root, "elsewhere", "raw", "0")), true);
  assert.equal(existsSync(join(root, "coverage")), false);
});

test("a failing test file fails the run and is named; --allow-test-failures measures anyway", async () => {
  const failing = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("red", () => assert.equal(1, 2, "marker-of-the-red-test"));\n';
  const root = fixtureRepo({ "test/red.test.js": failing });
  const strict = await run(["--root", root]);
  assert.equal(strict.code, 1);
  assert.match(strict.stderr, /^coverage: FAILED: 1 test file\(s\) failed, so the measurement is not that of a passing suite: test\/red\.test\.js$/m);
  assert.match(strict.stderr, /^--- test\/red\.test\.js: exit 1 ---$/m);
  assert.match(strict.stderr, /marker-of-the-red-test/, "the failing file's own output is shown");
  assert.match(strict.stdout, /^FAIL test\/red\.test\.js \(.*, exit 1\)$/m);
  assert.match(strict.stdout, /^ok {3}test\/child\.test\.js \(/m);
  // The summary is still written, and says which file failed.
  const summary = JSON.parse(readFileSync(join(root, "coverage", "summary.json"), "utf8"));
  assert.deepEqual(summary.tests.filter((t) => !t.ok), [{ file: "test/red.test.js", ok: false }]);

  const allowed = await run(["--root", root, "--allow-test-failures"]);
  assert.equal(allowed.code, 0);
  assert.match(allowed.stderr, /^coverage: warning: 1 test file\(s\) failed \(allowed by --allow-test-failures\): test\/red\.test\.js$/m);
  assert.doesNotMatch(allowed.stderr, /FAILED/);
});

test("the runner refuses options it doesn't know and a run with no test file", async () => {
  const root = fixtureRepo();
  for (const [args, reason] of [
    [["--root", root, "--nope"], /^coverage: unknown option --nope\n$/],
    [["--root", root, "--jobs", "0"], /^coverage: --jobs must be a whole number of at least 1, got 0\n$/],
    [["--root", root, "--jobs", "two"], /^coverage: --jobs must be a whole number of at least 1, got two\n$/],
    [["--root", root, "--jobs"], /^coverage: --jobs needs a value\n$/],
    [["--out"], /^coverage: --out needs a value\n$/],
  ]) {
    const r = await run(args);
    assert.equal(r.code, 2, args.join(" "));
    assert.match(r.stderr, reason);
    assert.equal(r.stdout, "");
  }
  assert.equal(existsSync(join(root, "coverage")), false, "nothing ran");
  const empty = tempDir("vbcdx-coverage-empty-");
  const none = await run(["--root", empty]);
  assert.equal(none.code, 2);
  assert.equal(none.stderr, "coverage: no test file to run\n");
});
