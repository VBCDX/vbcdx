#!/usr/bin/env node
// `npm run coverage`: line, branch and function coverage of bin/ and src/, measured from
// the whole test suite, with no dependency.
//
// Each test file runs in its own `node --test` process with NODE_V8_COVERAGE pointing at
// a directory of its own. Node hands that variable to every child process, including one
// started with a replaced environment, so the CLI and server processes the tests start
// are measured too. Every raw V8 report is then merged here, by script and by source
// offsets, which are the same in every process:
//
//   - a function is the range V8 reports first for it. It is covered when any process
//     called it. The module body itself is not counted as a function;
//   - a branch is any range V8 reports inside a function, the function's own range
//     included. The universe is every range seen in any process. V8 leaves out a block
//     that ran as often as the code around it, so a process that doesn't list a range
//     ran it exactly when it ran the narrowest range it does list around that range's
//     first offset. A branch is covered when any process ran it;
//   - a line takes the state of the narrowest range that spans all of it, so a covered
//     function's line is covered unless an uncovered block spans it. This is the rule
//     Node's own test coverage uses.
//
// Offsets only mean the same thing where every process loaded the same text. A process that
// loaded a module as some other text (a test's loader hook that rewrites it, say) reports
// offsets into that text: its report of that one module is left out, and the run says so.
//
// Two limits follow from what V8 reports. A function no process called is one range with
// no blocks inside, so its inner branches are not in the universe: below 100% the branch
// total is therefore a lower bound of the real one, and at 100% there is no such function.
// And a file no process loaded has no ranges at all: it is counted as every line, one
// function and one branch, none covered, so it can never be left out by not testing it.
//
// Usage: node scripts/coverage.mjs [options] [test file ...]
//   --out <dir>             where summary.json is written (default: coverage)
//   --jobs <n>              test files run at once (default: CPUs - 1, at most 8)
//   --allow-test-failures   report and exit 0 even when a test file fails. Without it a
//                           failing test file fails the run, because a measurement from
//                           a red suite misses whatever the failing tests would have run
//   --keep-raw              keep the raw V8 reports under <out>/raw
//   --root <dir>            the repository to measure (default: this script's)
// With no test file named, every test/**/*.test.js runs.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const METRICS = ["lines", "branches", "functions"];
const MEASURED = /^(?:bin|src)\/(?:.+\/)?[^/]+\.js$/;

function walk(dir, keep, out) {
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, keep, out);
    else if (keep.test(name)) out.push(p);
  }
  return out;
}

function listed(root, dirs, keep) {
  const out = [];
  for (const dir of dirs) {
    try {
      walk(join(root, dir), keep, out);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  return out.map((p) => relative(root, p).split(sep).join("/")).sort();
}

/** Every .js file under bin/ and src/, as sorted paths relative to `root`. */
export function measuredFiles(root) {
  return listed(root, ["bin", "src"], /\.js$/);
}

/** Every test file under test/, as sorted paths relative to `root`. */
export function testFiles(root) {
  return listed(root, ["test"], /\.test\.js$/);
}

/** The path, relative to `root`, of a script V8 reported, or null when it is not a .js file under bin/ or src/. */
export function measuredPath(url, root) {
  let path;
  try {
    path = fileURLToPath(new URL(url));
  } catch {
    // Not a file: a Node built-in, an evaluated script, a URL that doesn't parse.
    return null;
  }
  const rel = relative(root, path).split(sep).join("/");
  return MEASURED.test(rel) && !rel.split("/").includes("node_modules") ? rel : null;
}

/**
 * An empty merge for the repository at `root`, whose measured files are `sources`
 * (path → source text). `files` maps a path to its functions (by their offsets), each with
 * the distinct range lists processes reported for it. `skipped` counts, per path, the
 * reports that could not be merged.
 */
export function createMerge(root, sources) {
  return { root, sources, files: new Map(), skipped: new Map() };
}

/** Adds one process's raw V8 report (the parsed coverage-*.json) to the merge. */
export function addProcessCoverage(merge, report) {
  for (const script of report?.result ?? []) {
    const file = measuredPath(script.url, merge.root);
    if (file === null) continue;
    const listed = (script.functions ?? []).filter((fn) => fn.ranges?.length);
    if (listed.length === 0) continue;
    // Offsets mean the same thing in every process only when every process loaded the same
    // text. V8 lists the module body first, as the whole text: when that is not the file on
    // disk from end to end (a loader hook rewrote the module, or the file is gone), the
    // report's offsets point somewhere else and the report is left out, and counted.
    const source = merge.sources.get(file);
    const body = listed[0].ranges[0];
    if (source === undefined || body.startOffset !== 0 || body.endOffset !== source.length) {
      merge.skipped.set(file, (merge.skipped.get(file) ?? 0) + 1);
      continue;
    }
    if (!merge.files.has(file)) merge.files.set(file, new Map());
    const functions = merge.files.get(file);
    listed.forEach((fn, index) => {
      const ranges = fn.ranges.map((r) => ({ startOffset: r.startOffset, endOffset: r.endOffset, ran: r.count > 0 }));
      const key = `${ranges[0].startOffset}:${ranges[0].endOffset}`;
      if (!functions.has(key)) functions.set(key, { moduleBody: index === 0, variants: new Map() });
      // Most processes report a function the same way: one copy of each distinct report is enough.
      functions.get(key).variants.set(ranges.map((r) => `${r.startOffset}:${r.endOffset}:${r.ran ? 1 : 0}`).join(","), ranges);
    });
  }
}

// Did the process that reported `ranges` for a function run `target`? Its own entry says so
// when it lists the range. When it doesn't, V8 folded the range into the code around it, so the
// answer is that of the narrowest listed range around the target's first offset. A listed range
// that starts with the target but ends sooner is a block inside it, and says nothing about it.
function ranIn(ranges, target) {
  let around = null;
  for (const r of ranges) {
    if (r.startOffset === target.startOffset && r.endOffset === target.endOffset) return r.ran;
    if (r.startOffset > target.startOffset || r.endOffset <= target.startOffset) continue;
    if (r.startOffset === target.startOffset && r.endOffset < target.endOffset) continue;
    if (around === null || r.endOffset - r.startOffset < around.endOffset - around.startOffset) around = r;
  }
  return around !== null && around.ran;
}

/** The lines of a source text as offsets, the line ending left out (Node's coverage splits the same way). */
export function sourceLines(source) {
  const lines = [];
  let offset = 0;
  for (const text of source.split(/(?<=\r?\n)/u)) {
    const ending = /\r?\n$/u.exec(text)?.[0].length ?? 0;
    lines.push({ startOffset: offset, endOffset: offset + text.length - ending });
    offset += text.length;
  }
  return lines;
}

/**
 * One file's coverage from its source text and its merged functions (undefined when no
 * process loaded the file).
 */
export function summarizeFile(path, source, functions) {
  const lines = sourceLines(source);
  const covered = new Array(lines.length).fill(false);
  if (functions === undefined) {
    return {
      path,
      loaded: false,
      lines: { covered: 0, count: lines.length },
      branches: { covered: 0, count: 1 },
      functions: { covered: 0, count: 1 },
      uncoveredLines: lines.map((_, i) => i + 1),
    };
  }
  const all = [];
  const totals = { branches: { covered: 0, count: 0 }, functions: { covered: 0, count: 0 } };
  for (const fn of functions.values()) {
    const universe = new Map();
    for (const ranges of fn.variants.values()) {
      for (const r of ranges) {
        universe.set(`${r.startOffset}:${r.endOffset}`, { startOffset: r.startOffset, endOffset: r.endOffset, ran: false });
      }
    }
    for (const target of universe.values()) {
      for (const ranges of fn.variants.values()) {
        if (ranIn(ranges, target)) {
          target.ran = true;
          break;
        }
      }
      totals.branches.count++;
      if (target.ran) totals.branches.covered++;
      all.push(target);
    }
    if (!fn.moduleBody) {
      totals.functions.count++;
      // The function's own range is the first one inserted: every report lists it first.
      if (universe.values().next().value.ran) totals.functions.covered++;
    }
  }
  // Outer ranges first, so a narrower range decides the lines it spans.
  all.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const r of all) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startOffset >= r.startOffset && lines[i].endOffset <= r.endOffset) covered[i] = r.ran;
    }
  }
  const uncoveredLines = [];
  covered.forEach((yes, i) => {
    if (!yes) uncoveredLines.push(i + 1);
  });
  return {
    path,
    loaded: true,
    lines: { covered: lines.length - uncoveredLines.length, count: lines.length },
    branches: totals.branches,
    functions: totals.functions,
    uncoveredLines,
  };
}

/** Sums the three metrics over file entries. */
export function totalsOf(files) {
  const totals = {};
  for (const metric of METRICS) {
    totals[metric] = { covered: 0, count: 0 };
    for (const f of files) {
      totals[metric].covered += f[metric].covered;
      totals[metric].count += f[metric].count;
    }
  }
  return totals;
}

/**
 * The merged summary of every measured file: a file the merge has no report for is counted
 * as not covered at all.
 */
export function summarize(merge) {
  const files = [...merge.sources.keys()].sort().map((path) => summarizeFile(path, merge.sources.get(path), merge.files.get(path)));
  const skipped = [...merge.skipped.keys()].sort().map((path) => ({ path, reports: merge.skipped.get(path) }));
  return { files, totals: totalsOf(files), skipped };
}

/** A percentage cut (never rounded up) to `digits` decimals, as text. Nothing to cover reads as 100. */
export function percent({ covered, count }, digits = 2) {
  if (count === 0) return (100).toFixed(digits);
  const scale = 10 ** digits;
  return (Math.floor((covered * 100 * scale) / count) / scale).toFixed(digits);
}

/** Line numbers as ranges: [1, 2, 3, 7] → "1-3 7". */
export function lineRanges(numbers) {
  const out = [];
  for (let i = 0; i < numbers.length; i++) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
    out.push(i === j ? `${numbers[i]}` : `${numbers[i]}-${numbers[j]}`);
    i = j;
  }
  return out.join(" ");
}

/** The per-file table with a total row. */
export function table(summary) {
  const cell = (m) => `${percent(m).padStart(6)} ${`${m.covered}/${m.count}`.padStart(11)}`;
  const width = Math.max(4, ...summary.files.map((f) => f.path.length));
  const head = `${"file".padEnd(width)}  ${"lines".padStart(18)}  ${"branches".padStart(18)}  ${"functions".padStart(18)}  uncovered lines`;
  const rows = summary.files.map((f) => {
    const note = f.loaded ? lineRanges(f.uncoveredLines) : "never loaded by a test";
    return `${f.path.padEnd(width)}  ${cell(f.lines)}  ${cell(f.branches)}  ${cell(f.functions)}  ${note}`.trimEnd();
  });
  const total = `${"total".padEnd(width)}  ${cell(summary.totals.lines)}  ${cell(summary.totals.branches)}  ${cell(summary.totals.functions)}`;
  return [head, ...rows, total].join("\n");
}

function parseArgs(argv) {
  const opts = { out: "coverage", jobs: Math.max(1, Math.min(availableParallelism() - 1, 8)), allowTestFailures: false, keepRaw: false, root: null, tests: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--out") opts.out = value();
    else if (a === "--root") opts.root = value();
    else if (a === "--jobs") {
      const n = value();
      if (!/^[1-9]\d*$/.test(n)) throw new Error(`--jobs must be a whole number of at least 1, got ${n}`);
      opts.jobs = Number(n);
    } else if (a === "--allow-test-failures") opts.allowTestFailures = true;
    else if (a === "--keep-raw") opts.keepRaw = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else opts.tests.push(a);
  }
  return opts;
}

function runTestFile(root, file, rawDir) {
  return new Promise((done) => {
    const env = { ...process.env, NODE_V8_COVERAGE: rawDir };
    // Set when this script itself runs inside a test: it would make `node --test` act as a test child.
    delete env.NODE_TEST_CONTEXT;
    const started = Date.now();
    const child = spawn(process.execPath, ["--test", file], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    child.stdout.on("data", (c) => chunks.push(c));
    child.stderr.on("data", (c) => chunks.push(c));
    const finish = (ok, how) => done({ file, ok, how, seconds: (Date.now() - started) / 1000, output: Buffer.concat(chunks).toString("utf8") });
    child.on("error", (err) => finish(false, `could not start: ${err.message}`));
    child.on("close", (code, signal) => finish(code === 0, signal ? `killed by ${signal}` : `exit ${code}`));
  });
}

async function runAll(root, tests, rawRoot, jobs, log) {
  const results = new Array(tests.length);
  let next = 0;
  const worker = async () => {
    while (next < tests.length) {
      const n = next++;
      const r = await runTestFile(root, tests[n], join(rawRoot, String(n)));
      results[n] = r;
      log(`${r.ok ? "ok  " : "FAIL"} ${r.file} (${r.seconds.toFixed(1)}s${r.ok ? "" : `, ${r.how}`})\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tests.length) }, worker));
  return results;
}

function readReports(rawRoot, merge) {
  let reports = 0;
  for (const dir of readdirSync(rawRoot)) {
    for (const name of readdirSync(join(rawRoot, dir))) {
      if (!/^coverage-.*\.json$/.test(name)) continue;
      addProcessCoverage(merge, JSON.parse(readFileSync(join(rawRoot, dir, name), "utf8")));
      reports++;
    }
  }
  return reports;
}

/** Runs the tests, merges their coverage and writes <out>/summary.json. Returns the process exit code. */
export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    stderr.write(`coverage: ${err.message}\n`);
    return 2;
  }
  // Real paths: V8 reports the URL a module was loaded from, with symlinks resolved.
  const root = realpathSync(opts.root ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const tests = opts.tests.length ? opts.tests : testFiles(root);
  if (tests.length === 0) {
    stderr.write("coverage: no test file to run\n");
    return 2;
  }
  const out = resolve(root, opts.out);
  const rawRoot = join(out, "raw");
  rmSync(rawRoot, { recursive: true, force: true });
  mkdirSync(rawRoot, { recursive: true });

  const results = await runAll(root, tests, rawRoot, opts.jobs, (line) => stdout.write(line));
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) stderr.write(`\n--- ${r.file}: ${r.how} ---\n${r.output}\n`);

  const merge = createMerge(root, new Map(measuredFiles(root).map((f) => [f, readFileSync(join(root, f), "utf8")])));
  const reports = readReports(rawRoot, merge);
  const summary = summarize(merge);
  summary.tests = results.map((r) => ({ file: r.file, ok: r.ok }));
  writeFileSync(join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  if (!opts.keepRaw) rmSync(rawRoot, { recursive: true, force: true });

  stdout.write(`\n${table(summary)}\n\n`);
  stdout.write(`coverage: ${tests.length} test files, ${reports} process reports, ${summary.files.length} files measured\n`);
  for (const metric of METRICS) {
    const m = summary.totals[metric];
    stdout.write(`coverage: ${metric} ${percent(m)}% (${m.covered}/${m.count})\n`);
  }
  for (const { path, reports: n } of summary.skipped) {
    stdout.write(`coverage: note: ${n} report(s) of ${path} left out: the process loaded a text that is not the file on disk\n`);
  }
  stdout.write(`coverage: wrote ${relative(root, join(out, "summary.json"))}\n`);
  if (failed.length) {
    const names = failed.map((r) => r.file).join(", ");
    if (!opts.allowTestFailures) {
      stderr.write(`coverage: FAILED: ${failed.length} test file(s) failed, so the measurement is not that of a passing suite: ${names}\n`);
      return 1;
    }
    stderr.write(`coverage: warning: ${failed.length} test file(s) failed (allowed by --allow-test-failures): ${names}\n`);
  }
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
