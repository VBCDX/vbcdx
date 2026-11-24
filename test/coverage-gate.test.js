// scripts/check-coverage.mjs decides whether a coverage summary passes. Every decision is
// pinned here with its reason: the three floors (under, at, over, and exactly at), each
// malformed floor file, each malformed exclusion, an excluded file, and a file that is
// neither measured nor excluded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.js";
import { checkCoverage, main, meets, parseExclusions, parseFloor } from "../scripts/check-coverage.mjs";
import { measuredFiles } from "../scripts/coverage.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const METRICS = ["lines", "branches", "functions"];
const FLOOR = "lines 98\nbranches 90\nfunctions 95\n";

const entry = (path, lines, branches, functions) => ({
  path,
  lines: { covered: lines[0], count: lines[1] },
  branches: { covered: branches[0], count: branches[1] },
  functions: { covered: functions[0], count: functions[1] },
});
// Two files that together sit exactly on FLOOR: 980/1000 lines, 90/100 branches, 19/20 functions.
const atFloor = () => ({ files: [entry("src/a.js", [500, 500], [50, 50], [10, 10]), entry("bin/cli.js", [480, 500], [40, 50], [9, 10])] });
const DISK = ["bin/cli.js", "src/a.js"];
const gate = (over = {}) => checkCoverage({ summary: atFloor(), floorText: FLOOR, exclusionsText: "", diskFiles: DISK, ...over });

test("a summary exactly at every floor passes, with the totals it was judged on", () => {
  const r = gate();
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.totals, { lines: { covered: 980, count: 1000 }, branches: { covered: 90, count: 100 }, functions: { covered: 19, count: 20 } });
  assert.deepEqual(r.floors, { lines: "98", branches: "90", functions: "95" });
});

test("each metric fails one unit under its floor, passes at it and over it, and names itself", () => {
  const cases = {
    lines: { under: [479, 500], over: [481, 500], reason: "lines 97.90% (979/1000) is under the floor of 98%" },
    branches: { under: [39, 50], over: [41, 50], reason: "branches 89.00% (89/100) is under the floor of 90%" },
    functions: { under: [8, 10], over: [10, 10], reason: "functions 90.00% (18/20) is under the floor of 95%" },
  };
  for (const metric of METRICS) {
    const withCli = (value) => {
      const summary = atFloor();
      summary.files[1][metric] = { covered: value[0], count: value[1] };
      return gate({ summary });
    };
    const under = withCli(cases[metric].under);
    assert.equal(under.ok, false, metric);
    assert.deepEqual(under.errors, [cases[metric].reason], "only the metric that is under fails");
    const over = withCli(cases[metric].over);
    assert.equal(over.ok, true, metric);
    assert.deepEqual(over.errors, []);
  }
});

test("the comparison is the exact fraction: nothing is rounded up to the floor", () => {
  assert.equal(meets({ covered: 2, count: 3 }, "66.66"), true);
  assert.equal(meets({ covered: 2, count: 3 }, "66.67"), false);
  assert.equal(meets({ covered: 1, count: 8 }, "12.5"), true, "exactly at a floor with decimals");
  assert.equal(meets({ covered: 1, count: 8 }, "12.50"), true);
  assert.equal(meets({ covered: 1, count: 8 }, "12.51"), false);
  // Half is under 50.00000000000000000001 percent. A double can't tell that floor from 50,
  // whichever way the comparison is written.
  const tight = "50.00000000000000000001";
  assert.equal(1 * 100 >= Number(tight) * 2 && (1 * 100) / 2 >= Number(tight) && (1 / 2) * 100 >= Number(tight), true, "floating point would let this pass");
  assert.equal(meets({ covered: 1, count: 2 }, tight), false);
  assert.equal(meets({ covered: 1, count: 2 }, "50.00000000000000000000"), true);
  assert.equal(meets({ covered: 1, count: 3 }, "33.33333333333333333334"), false);
  assert.equal(meets({ covered: 1, count: 3 }, "33.33333333333333333333"), true);
  assert.equal(meets({ covered: 0, count: 5 }, "0"), true);
  assert.equal(meets({ covered: 5, count: 5 }, "100"), true);
  assert.equal(meets({ covered: 5, count: 5 }, "100.0"), true);

  // A floor of 100 is not met by 99999 of 100000, and the message doesn't show it as 100.
  const summary = { files: [entry("src/a.js", [99999, 100000], [1, 1], [1, 1]), entry("bin/cli.js", [0, 0], [0, 0], [0, 0])] };
  const r = gate({ summary, floorText: "lines 100\nbranches 100\nfunctions 100\n" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ["lines 99.99% (99999/100000) is under the floor of 100%"]);
  summary.files[0].lines.covered = 100000;
  assert.deepEqual(gate({ summary, floorText: "lines 100\nbranches 100\nfunctions 100\n" }).errors, []);
});

test("a metric with nothing measured fails, even at a floor of 0", () => {
  const summary = { files: [entry("src/a.js", [1, 1], [0, 0], [1, 1]), entry("bin/cli.js", [1, 1], [0, 0], [1, 1])] };
  const r = gate({ summary, floorText: "lines 0\nbranches 0\nfunctions 0\n" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ["branches: nothing was measured"]);
});

test("the floor file: comments, blank lines and decimals are read; every malformed form fails with its reason", () => {
  const good = parseFloor("# the floors\n\n  lines   98.05   # measured 98.07\nbranches 0\nfunctions 100\n");
  assert.deepEqual(good, { floors: { lines: "98.05", branches: "0", functions: "100" }, errors: [] });

  const bad = [
    ["lines 98\nbranches 90\n", ["coverage-floor: no floor for functions"]],
    ["", ["coverage-floor: no floor for lines", "coverage-floor: no floor for branches", "coverage-floor: no floor for functions"]],
    ["# lines 98\nbranches 90\nfunctions 95\n", ["coverage-floor: no floor for lines"]],
    ["lines 98\nlines 99\nbranches 90\nfunctions 95\n", ["coverage-floor line 2: lines is set more than once"]],
    ["lines 98\nbranches 90\nfunctions 95\nlines 98\n", ["coverage-floor line 4: lines is set more than once"]],
    ["lines 98\nbranches 90\nfunctions 95\nstatements 90\n", ['coverage-floor line 4: unknown metric "statements" (one of lines, branches, functions)']],
    ["Lines 98\nbranches 90\nfunctions 95\n", ['coverage-floor line 1: unknown metric "Lines" (one of lines, branches, functions)', "coverage-floor: no floor for lines"]],
    ["lines\nbranches 90\nfunctions 95\n", ['coverage-floor line 1: expected "<metric> <percent>", got "lines"', "coverage-floor: no floor for lines"]],
    ["lines 98 99\nbranches 90\nfunctions 95\n", ['coverage-floor line 1: expected "<metric> <percent>", got "lines 98 99"', "coverage-floor: no floor for lines"]],
    ["lines=98\nbranches 90\nfunctions 95\n", ['coverage-floor line 1: expected "<metric> <percent>", got "lines=98"', "coverage-floor: no floor for lines"]],
  ];
  for (const value of ["abc", "-1", "100.1", "101", "100.0000001", "1e2", ".5", "5.", "98%", "9,8", "0x10", "Infinity", "NaN", "+5"]) {
    bad.push([`lines 98\nbranches ${value}\nfunctions 95\n`, [`coverage-floor line 2: branches must be a percentage from 0 to 100, got "${value}"`]]);
  }
  for (const [text, errors] of bad) {
    assert.deepEqual(parseFloor(text).errors, errors, JSON.stringify(text));
    const r = gate({ floorText: text });
    assert.equal(r.ok, false, JSON.stringify(text));
    for (const e of errors) assert.ok(r.errors.includes(e), `${JSON.stringify(text)}: ${e}`);
  }
  // A malformed floor fails even when the summary is perfect, and a floor that was read is still applied.
  const perfect = { files: [entry("src/a.js", [5, 5], [5, 5], [5, 5]), entry("bin/cli.js", [5, 5], [5, 5], [5, 5])] };
  assert.deepEqual(gate({ summary: perfect, floorText: "lines 98\nbranches 90\n" }).errors, ["coverage-floor: no floor for functions"]);
  const summary = atFloor();
  summary.files[1].lines.covered = 0;
  assert.deepEqual(gate({ summary, floorText: "lines 98\nbranches 90\n" }).errors, ["coverage-floor: no floor for functions", "lines 50.00% (500/1000) is under the floor of 98%"]);
  for (const edge of ["0", "100", "100.000", "0.0", "99.999"]) assert.deepEqual(parseFloor(`lines ${edge}\nbranches 1\nfunctions 1\n`).errors, [], edge);
});

test("an excluded file is not counted, and need not be measured", () => {
  // bin/cli.js drags every metric under its floor; excluded with a reason, the rest passes.
  const summary = { files: [entry("src/a.js", [500, 500], [50, 50], [10, 10]), entry("bin/cli.js", [0, 500], [0, 50], [0, 10])] };
  const counted = gate({ summary });
  assert.equal(counted.ok, false);
  assert.deepEqual(counted.errors, [
    "lines 50.00% (500/1000) is under the floor of 98%", "branches 50.00% (50/100) is under the floor of 90%", "functions 50.00% (10/20) is under the floor of 95%",
  ]);
  const exclusionsText = "# reviewed exclusions\n\nbin/cli.js   generated by the build, never edited by hand\n";
  const excluded = gate({ summary, exclusionsText });
  assert.deepEqual(excluded.errors, []);
  assert.equal(excluded.ok, true);
  assert.deepEqual(excluded.totals, { lines: { covered: 500, count: 500 }, branches: { covered: 50, count: 50 }, functions: { covered: 10, count: 10 } });
  assert.deepEqual([...excluded.excluded], ["bin/cli.js"]);
  // The summary may leave an excluded file out altogether.
  assert.deepEqual(gate({ summary: { files: [summary.files[0]] }, exclusionsText }).errors, []);
});

test("the exclusions file: every malformed form fails with its reason", () => {
  const disk = ["bin/cli.js", "src/a.js", "src/deep/b.js"];
  const good = parseExclusions("# why\n\nsrc/deep/b.js\tvendored parser\n  bin/cli.js a reason # with a hash in it\n", disk);
  assert.deepEqual(good.errors, []);
  assert.deepEqual([...good.excluded], ["src/deep/b.js", "bin/cli.js"]);

  const bad = [
    ["bin/cli.js\n", "coverage-exclusions line 1: bin/cli.js has no reason"],
    ["bin/cli.js   \n", "coverage-exclusions line 1: bin/cli.js has no reason"],
    ["bin/cli.js one\n\nbin/cli.js two\n", "coverage-exclusions line 3: bin/cli.js is listed more than once"],
    ["src/gone.js removed last year\n", "coverage-exclusions line 1: src/gone.js does not exist (stale exclusion)"],
    ["test/a.test.js a test\n", "coverage-exclusions line 1: test/a.test.js is not a .js file under bin/ or src/"],
    ["scripts/lint.mjs tooling\n", "coverage-exclusions line 1: scripts/lint.mjs is not a .js file under bin/ or src/"],
    ["src/a.mjs wrong kind\n", "coverage-exclusions line 1: src/a.mjs is not a .js file under bin/ or src/"],
    ["src whole tree\n", "coverage-exclusions line 1: src is not a .js file under bin/ or src/"],
    ["src/ whole tree\n", "coverage-exclusions line 1: src/ is not a .js file under bin/ or src/"],
    ["src/*.js a glob\n", "coverage-exclusions line 1: src/*.js does not exist (stale exclusion)"],
    ["./src/a.js dotted\n", "coverage-exclusions line 1: ./src/a.js is not a .js file under bin/ or src/"],
    ["/repo/src/a.js absolute\n", "coverage-exclusions line 1: /repo/src/a.js is not a .js file under bin/ or src/"],
    ["src/../test/a.js climbs out\n", "coverage-exclusions line 1: src/../test/a.js is not a .js file under bin/ or src/"],
    ["src/deep/../a.js climbs\n", "coverage-exclusions line 1: src/deep/../a.js is not a .js file under bin/ or src/"],
  ];
  for (const [text, error] of bad) {
    assert.deepEqual(parseExclusions(text, disk).errors, [error], JSON.stringify(text));
    // The gate fails on it even when every floor is met.
    const perfect = { files: disk.map((p) => entry(p, [5, 5], [5, 5], [5, 5])) };
    const r = checkCoverage({ summary: perfect, floorText: FLOOR, exclusionsText: text, diskFiles: disk });
    assert.equal(r.ok, false, JSON.stringify(text));
    assert.deepEqual(r.errors, [error], JSON.stringify(text));
  }
  // Several problems are all reported, each on its line.
  assert.deepEqual(parseExclusions("bin/cli.js\nsrc/gone.js x\ntest/x.js y\n", disk).errors, [
    "coverage-exclusions line 1: bin/cli.js has no reason",
    "coverage-exclusions line 2: src/gone.js does not exist (stale exclusion)",
    "coverage-exclusions line 3: test/x.js is not a .js file under bin/ or src/",
  ]);
});

test("every file on disk must be measured or excluded, and the summary must match the disk", () => {
  const missing = gate({ diskFiles: [...DISK, "src/new.js"] });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.errors, ["src/new.js is neither measured nor excluded"]);

  const stale = gate({ diskFiles: ["src/a.js"] });
  assert.equal(stale.ok, false);
  assert.deepEqual(stale.errors, ["summary: bin/cli.js is measured but does not exist (stale summary)"]);

  const twice = atFloor();
  twice.files.push(entry("src/a.js", [500, 500], [50, 50], [10, 10]));
  assert.deepEqual(gate({ summary: twice }).errors, ["summary: src/a.js is measured more than once"]);

  for (const summary of [null, {}, { files: "src/a.js" }, []]) {
    const r = gate({ summary });
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors.slice(0, 3), ["summary: no list of measured files", "bin/cli.js is neither measured nor excluded", "src/a.js is neither measured nor excluded"]);
  }

  // An entry whose numbers can't be counts is not trusted: the file is then not measured.
  const malformed = [
    entry("src/a.js", [501, 500], [50, 50], [10, 10]), entry("src/a.js", [-1, 500], [50, 50], [10, 10]), entry("src/a.js", [1.5, 500], [50, 50], [10, 10]),
    entry("src/a.js", ["500", 500], [50, 50], [10, 10]), entry("src/a.js", [500, 500], [51, 50], [10, 10]), entry("src/a.js", [500, 500], [50, 50], [11, 10]),
    { path: "src/a.js", lines: { covered: 1, count: 1 } },
  ];
  for (const first of malformed) {
    const r = gate({ summary: { files: [first, atFloor().files[1]] } });
    assert.equal(r.ok, false, JSON.stringify(first));
    assert.deepEqual(r.errors.slice(0, 2), ['summary: malformed entry "src/a.js"', "src/a.js is neither measured nor excluded"], JSON.stringify(first));
  }
  assert.deepEqual(gate({ summary: { files: [null, ...atFloor().files] } }).errors, ["summary: malformed entry null"]);
});

test("a single file's own line floor: under, at, over, not measured, excluded and malformed", () => {
  // bin/cli.js is at 480/500 = 96%.
  assert.deepEqual(gate({ minLines: [["bin/cli.js", "96"]] }).errors, []);
  assert.deepEqual(gate({ minLines: [["bin/cli.js", "95.9"], ["src/a.js", "100"]] }).errors, []);
  assert.deepEqual(gate({ minLines: [["bin/cli.js", "96.01"]] }).errors, ["bin/cli.js: lines 96.00% (480/500) is under its floor of 96.01%"]);
  assert.deepEqual(gate({ minLines: [["src/none.js", "50"]] }).errors, ["--min-lines src/none.js: the file is not measured"]);
  assert.deepEqual(gate({ minLines: [["bin/cli.js", "high"]] }).errors, ['--min-lines bin/cli.js: must be a percentage from 0 to 100, got "high"']);
  assert.deepEqual(gate({ minLines: [["bin/cli.js", "101"]] }).errors, ['--min-lines bin/cli.js: must be a percentage from 0 to 100, got "101"']);
  // An excluded file has no measurement to hold to a floor (the totals then fail without it too).
  const excluded = gate({ minLines: [["bin/cli.js", "10"]], exclusionsText: "bin/cli.js a reason\n", floorText: "lines 0\nbranches 0\nfunctions 0\n" });
  assert.deepEqual(excluded.errors, ["--min-lines bin/cli.js: the file is not measured"]);
  // A file with no lines can't meet a line floor.
  const empty = { files: [entry("src/a.js", [0, 0], [1, 1], [1, 1]), entry("bin/cli.js", [1, 1], [1, 1], [1, 1])] };
  assert.deepEqual(gate({ summary: empty, minLines: [["src/a.js", "0"]] }).errors, ["--min-lines src/a.js: the file has no lines"]);
});

// The command itself, over a small repository on disk.
function repo({ floor = FLOOR, exclusions = "", summary = atFloor(), extra = [] } = {}) {
  const root = tempDir("vbcdx-coverage-gate-");
  const write = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  for (const f of [...DISK, ...extra]) write(f, "export {};\n");
  write("src/notes.md", "not measured\n");
  write("test/a.test.js", "\n");
  if (floor !== null) write("coverage-floor", floor);
  if (exclusions !== null) write("coverage-exclusions", exclusions);
  if (summary !== null) write("coverage/summary.json", typeof summary === "string" ? summary : JSON.stringify(summary));
  return root;
}

function run(args) {
  const out = [];
  const err = [];
  const code = main(args, { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } });
  return { code, stdout: out.join(""), stderr: err.join("") };
}

test("the command passes a summary at the floor and prints what it judged", () => {
  const r = run(["--root", repo()]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.equal(r.stdout, [
    "coverage gate: lines 98.00% (980/1000), floor 98%",
    "coverage gate: branches 90.00% (90/100), floor 90%",
    "coverage gate: functions 95.00% (19/20), floor 95%",
    "coverage gate: passed",
    "",
  ].join("\n"));
});

test("the command fails under a floor, on an unmeasured file on disk, and names each excluded file", () => {
  const under = run(["--root", repo({ floor: "lines 98.1\nbranches 90\nfunctions 95\n" })]);
  assert.equal(under.code, 1);
  assert.equal(under.stderr, "coverage gate: FAILED: lines 98.00% (980/1000) is under the floor of 98.1%\n");
  assert.doesNotMatch(under.stdout, /passed/);

  const unmeasured = run(["--root", repo({ extra: ["src/deep/new.js"] })]);
  assert.equal(unmeasured.code, 1);
  assert.equal(unmeasured.stderr, "coverage gate: FAILED: src/deep/new.js is neither measured nor excluded\n");

  const excluded = run(["--root", repo({ extra: ["src/deep/new.js"], exclusions: "src/deep/new.js third-party code kept verbatim\n" })]);
  assert.equal(excluded.code, 0, excluded.stderr);
  assert.match(excluded.stdout, /^coverage gate: excluded src\/deep\/new\.js\n/);
  assert.match(excluded.stdout, /coverage gate: passed\n$/);

  const noReason = run(["--root", repo({ extra: ["src/deep/new.js"], exclusions: "src/deep/new.js\n" })]);
  assert.equal(noReason.code, 1);
  assert.equal(noReason.stderr, "coverage gate: FAILED: coverage-exclusions line 1: src/deep/new.js has no reason\n");
});

test("the command fails when the floor, the exclusions or the summary is missing or unreadable", () => {
  for (const [options, reason] of [
    [{ floor: null }, "coverage gate: FAILED: cannot read the floor file coverage-floor: ENOENT\n"],
    [{ exclusions: null }, "coverage gate: FAILED: cannot read the exclusions file coverage-exclusions: ENOENT\n"],
    [{ summary: null }, "coverage gate: FAILED: cannot read the summary coverage/summary.json: ENOENT\n"],
  ]) {
    const r = run(["--root", repo(options)]);
    assert.equal(r.code, 1, reason);
    assert.equal(r.stderr, reason);
    assert.equal(r.stdout, "");
  }
  const notJson = run(["--root", repo({ summary: "{ files: " })]);
  assert.equal(notJson.code, 1);
  assert.match(notJson.stderr, /^coverage gate: FAILED: the summary coverage\/summary\.json is not JSON: /);
  const empty = run(["--root", repo({ summary: "{}" })]);
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /^coverage gate: FAILED: summary: no list of measured files\n/);
});

test("the command's options: other paths, a single file's line floor, and what it refuses", () => {
  const root = repo({ floor: null, exclusions: null, summary: null });
  mkdirSync(join(root, "elsewhere"));
  writeFileSync(join(root, "elsewhere", "floor"), FLOOR);
  writeFileSync(join(root, "elsewhere", "exclusions"), "");
  writeFileSync(join(root, "elsewhere", "summary.json"), JSON.stringify(atFloor()));
  const paths = ["--root", root, "--floor", "elsewhere/floor", "--exclusions", "elsewhere/exclusions", "--summary", "elsewhere/summary.json"];
  assert.equal(run(paths).code, 0);
  assert.equal(run([...paths, "--min-lines", "bin/cli.js=96", "--min-lines", "src/a.js=100"]).code, 0);
  const under = run([...paths, "--min-lines", "bin/cli.js=97"]);
  assert.equal(under.code, 1);
  assert.equal(under.stderr, "coverage gate: FAILED: bin/cli.js: lines 96.00% (480/500) is under its floor of 97%\n");
  rmSync(join(root, "elsewhere", "floor"));
  assert.equal(run(paths).stderr, "coverage gate: FAILED: cannot read the floor file elsewhere/floor: ENOENT\n");

  for (const [args, reason] of [
    [["--nope"], "coverage gate: unknown option --nope\n"],
    [["extra"], "coverage gate: unknown option extra\n"],
    [["--summary"], "coverage gate: --summary needs a value\n"],
    [["--min-lines", "bin/cli.js"], "coverage gate: --min-lines needs <path>=<percent>, got bin/cli.js\n"],
    [["--min-lines", "=5"], "coverage gate: --min-lines needs <path>=<percent>, got =5\n"],
  ]) {
    const r = run(["--root", root, ...args]);
    assert.equal(r.code, 2, args.join(" "));
    assert.equal(r.stderr, reason);
  }
});

test("this repository's own floor and exclusions files are well formed", () => {
  const floor = parseFloor(readFileSync(join(ROOT, "coverage-floor"), "utf8"));
  assert.deepEqual(floor.errors, []);
  assert.deepEqual(Object.keys(floor.floors).sort(), [...METRICS].sort());
  const exclusions = parseExclusions(readFileSync(join(ROOT, "coverage-exclusions"), "utf8"), measuredFiles(ROOT));
  assert.deepEqual(exclusions.errors, []);
});
