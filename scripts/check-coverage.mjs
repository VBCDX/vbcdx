#!/usr/bin/env node
// `npm run coverage:check`: gates the summary scripts/coverage.mjs wrote against the
// repository's `coverage-floor`, with the reviewed `coverage-exclusions`.
//
// coverage-floor      one line per metric, each exactly once: `lines 98.0`, `branches 90`,
//                     `functions 100`. A percentage from 0 to 100, digits with an optional
//                     decimal part. `#` starts a comment. The comparison is exact, in whole
//                     numbers (covered × 100 ≥ floor × count), so nothing is rounded up to pass.
// coverage-exclusions one line per file left out of the totals: `<path> <reason>`. The path is
//                     a .js file under bin/ or src/ that exists; the reason is required. A
//                     path listed twice, a path that no longer exists and a path outside
//                     bin/ and src/ each fail the gate. `#` starts a comment line.
//
// Every .js file under bin/ and src/ must be in the summary or in the exclusions, and the
// summary must not name a file that isn't there: a stale or partial summary fails.
//
// Usage: node scripts/check-coverage.mjs [options]
//   --summary <file>           the summary to gate (default: coverage/summary.json)
//   --floor <file>             default: coverage-floor
//   --exclusions <file>        default: coverage-exclusions
//   --min-lines <path>=<pct>   also require that one measured file's own line coverage is at
//                              least <pct> (repeatable)
//   --root <dir>               the repository (default: this script's)
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { METRICS, measuredFiles, percent, totalsOf } from "./coverage.mjs";

const PERCENT = /^\d+(?:\.\d+)?$/;
const MEASURED = /^(?:bin|src)\/(?:.+\/)?[^/]+\.js$/;

// A percentage as an exact fraction: "98.05" → 9805 / 100.
function fraction(text) {
  const [whole, decimals = ""] = text.split(".");
  return { numerator: BigInt(whole + decimals), denominator: 10n ** BigInt(decimals.length) };
}

/** Is covered/count at least `floor` percent? Exact: no floating point, nothing rounded. */
export function meets({ covered, count }, floor) {
  const { numerator, denominator } = fraction(floor);
  return BigInt(covered) * 100n * denominator >= numerator * BigInt(count);
}

function validPercent(text) {
  if (!PERCENT.test(text)) return false;
  const { numerator, denominator } = fraction(text);
  return numerator <= 100n * denominator;
}

/** Parses coverage-floor. Returns { floors: { lines, branches, functions }, errors }. */
export function parseFloor(text) {
  const floors = {};
  const errors = [];
  const named = new Set();
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") return;
    const at = `coverage-floor line ${i + 1}`;
    const parts = line.split(/\s+/);
    if (parts.length !== 2) return errors.push(`${at}: expected "<metric> <percent>", got "${line}"`);
    const [metric, value] = parts;
    if (!METRICS.includes(metric)) return errors.push(`${at}: unknown metric "${metric}" (one of ${METRICS.join(", ")})`);
    if (named.has(metric)) return errors.push(`${at}: ${metric} is set more than once`);
    named.add(metric);
    if (!validPercent(value)) return errors.push(`${at}: ${metric} must be a percentage from 0 to 100, got "${value}"`);
    floors[metric] = value;
  });
  for (const metric of METRICS) {
    if (!named.has(metric)) errors.push(`coverage-floor: no floor for ${metric}`);
  }
  return { floors, errors };
}

/** Parses coverage-exclusions against the files on disk. Returns { excluded: Set, errors }. */
export function parseExclusions(text, diskFiles) {
  const excluded = new Set();
  const errors = [];
  const onDisk = new Set(diskFiles);
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const at = `coverage-exclusions line ${i + 1}`;
    const space = line.search(/\s/);
    const path = space === -1 ? line : line.slice(0, space);
    const reason = space === -1 ? "" : line.slice(space).trim();
    if (!MEASURED.test(path) || path.split("/").includes("..")) return errors.push(`${at}: ${path} is not a .js file under bin/ or src/`);
    if (excluded.has(path)) return errors.push(`${at}: ${path} is listed more than once`);
    excluded.add(path);
    if (reason === "") return errors.push(`${at}: ${path} has no reason`);
    if (!onDisk.has(path)) return errors.push(`${at}: ${path} does not exist (stale exclusion)`);
  });
  return { excluded, errors };
}

function validEntry(f) {
  return typeof f?.path === "string" && METRICS.every((m) => Number.isSafeInteger(f[m]?.covered) && Number.isSafeInteger(f[m]?.count) && f[m].covered >= 0 && f[m].covered <= f[m].count);
}

/**
 * The gate decision. `summary` is the parsed summary.json, `floorText` and `exclusionsText`
 * the two files' contents, `diskFiles` the .js files under bin/ and src/, and `minLines` a
 * list of [path, percent] line floors for single files.
 * Returns { ok, errors, totals, floors, excluded }.
 */
export function checkCoverage({ summary, floorText, exclusionsText, diskFiles, minLines = [] }) {
  const { floors, errors: floorErrors } = parseFloor(floorText);
  const { excluded, errors: exclusionErrors } = parseExclusions(exclusionsText, diskFiles);
  const errors = [...floorErrors, ...exclusionErrors];

  const entries = Array.isArray(summary?.files) ? summary.files : null;
  if (entries === null) errors.push("summary: no list of measured files");
  const measured = new Map();
  for (const f of entries ?? []) {
    if (!validEntry(f)) errors.push(`summary: malformed entry ${JSON.stringify(f?.path ?? f)}`);
    else if (measured.has(f.path)) errors.push(`summary: ${f.path} is measured more than once`);
    else measured.set(f.path, f);
  }
  const onDisk = new Set(diskFiles);
  for (const path of diskFiles) {
    if (!measured.has(path) && !excluded.has(path)) errors.push(`${path} is neither measured nor excluded`);
  }
  for (const path of measured.keys()) {
    if (!onDisk.has(path)) errors.push(`summary: ${path} is measured but does not exist (stale summary)`);
  }

  const counted = [...measured.values()].filter((f) => !excluded.has(f.path));
  const totals = totalsOf(counted);
  for (const metric of METRICS) {
    if (!(metric in floors)) continue;
    const m = totals[metric];
    if (m.count === 0) errors.push(`${metric}: nothing was measured`);
    else if (!meets(m, floors[metric])) errors.push(`${metric} ${percent(m)}% (${m.covered}/${m.count}) is under the floor of ${floors[metric]}%`);
  }
  for (const [path, floor] of minLines) {
    const f = measured.get(path);
    if (!validPercent(floor)) errors.push(`--min-lines ${path}: must be a percentage from 0 to 100, got "${floor}"`);
    else if (f === undefined || excluded.has(path)) errors.push(`--min-lines ${path}: the file is not measured`);
    else if (f.lines.count === 0) errors.push(`--min-lines ${path}: the file has no lines`);
    else if (!meets(f.lines, floor)) errors.push(`${path}: lines ${percent(f.lines)}% (${f.lines.covered}/${f.lines.count}) is under its floor of ${floor}%`);
  }
  return { ok: errors.length === 0, errors, totals, floors, excluded };
}

function parseArgs(argv) {
  const opts = { summary: "coverage/summary.json", floor: "coverage-floor", exclusions: "coverage-exclusions", root: null, minLines: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--summary") opts.summary = value();
    else if (a === "--floor") opts.floor = value();
    else if (a === "--exclusions") opts.exclusions = value();
    else if (a === "--root") opts.root = value();
    else if (a === "--min-lines") {
      const v = value();
      const eq = v.lastIndexOf("=");
      if (eq < 1) throw new Error(`--min-lines needs <path>=<percent>, got ${v}`);
      opts.minLines.push([v.slice(0, eq), v.slice(eq + 1)]);
    } else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

/** Reads the files, prints the decision and returns the process exit code. */
export function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    stderr.write(`coverage gate: ${err.message}\n`);
    return 2;
  }
  const root = realpathSync(opts.root ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const read = (what, file) => {
    try {
      return readFileSync(resolve(root, file), "utf8");
    } catch (err) {
      throw new Error(`cannot read the ${what} ${file}: ${err.code ?? err.message}`);
    }
  };
  let result;
  try {
    const floorText = read("floor file", opts.floor);
    const exclusionsText = read("exclusions file", opts.exclusions);
    const summaryText = read("summary", opts.summary);
    let summary;
    try {
      summary = JSON.parse(summaryText);
    } catch (err) {
      throw new Error(`the summary ${opts.summary} is not JSON: ${err.message}`);
    }
    result = checkCoverage({ summary, floorText, exclusionsText, diskFiles: measuredFiles(root), minLines: opts.minLines });
  } catch (err) {
    stderr.write(`coverage gate: FAILED: ${err.message}\n`);
    return 1;
  }
  for (const path of [...result.excluded].sort()) stdout.write(`coverage gate: excluded ${path}\n`);
  for (const metric of METRICS) {
    const m = result.totals[metric];
    stdout.write(`coverage gate: ${metric} ${percent(m)}% (${m.covered}/${m.count}), floor ${result.floors[metric] ?? "?"}%\n`);
  }
  if (!result.ok) {
    for (const e of result.errors) stderr.write(`coverage gate: FAILED: ${e}\n`);
    return 1;
  }
  stdout.write("coverage gate: passed\n");
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
