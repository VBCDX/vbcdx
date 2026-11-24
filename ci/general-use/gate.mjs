#!/usr/bin/env node
// The pull-request step of the general-use gate. The CI step takes this file from the base
// branch and starts it from outside the tree. What it does, in this order:
//
//   1. Resolves the base to a commit and lists that commit's ci/general-use/.
//   2. If the base has no ci/general-use/scan.mjs: says so, and runs only step 7.
//   3. Copies the base's ci/general-use/ into a temporary directory and starts the copy's
//      verify-dir.mjs on the copy. If that does not exit 0, nothing else runs: status 2.
//   4. Prints each file of ci/general-use/ that differs between the merge base and HEAD.
//   5. If the base has ci/general-use/gate.mjs, two comparisons, each a status 1 when it
//      fails: (a) the copy's verify-dir.mjs is started on the tree's own ci/general-use/;
//      (b) the workflow directories at HEAD against the base's (below).
//      If the base has no gate.mjs, neither is made and step 6 gets no --lists; the log
//      says so.
//   6. Starts the copy's scan.mjs on the tree with --base, and with --lists pointing at the
//      copy, so that run reads the base's allow.txt and first-party.txt.
//   7. Starts the tree's own scan.mjs on the tree with --base (the tree's own lists).
//   8. Removes the temporary directory.
// Both scans are given the base as the commit id of step 1.
//
// The workflow directories are the three the forge reads, the first that exists winning:
// .forgejo/workflows, .gitea/workflows, .github/workflows. Their entries are what
// `git ls-tree -r` lists under them: for each path its mode, its type and its object id.
//
// A pull request from a trusted author runs the workflows of its own head, its changes
// included (https://forgejo.org/docs/latest/user/actions/security-pull-request/#which-workflow-files-are-used).
// So this file cannot vouch for a workflow the pull request edits: the forge's protection of
// the workflow path reviews that. Step (b) is a tripwire for an honest edit, not a control:
//   - an entry that only one side has, or whose mode or type differs, is refused;
//   - a file whose bytes differ is refused unless it keeps, byte for byte, what the base's
//     own bytes protect: the text up to its one `jobs:` line (the name and the triggers),
//     no other key at the start of a line after it, and, in the file that names gate.mjs,
//     the whole job that names it, once, with nothing added to its end. The head's text is
//     only searched for those bytes, never parsed. A base file that cannot be cut that way
//     passes only unchanged;
//   - the number of times the workflows name ci/general-use/gate.mjs, and the gate's job by
//     its id and by its own `name:` (as the base has them), on lines that are not whole-line
//     comments, must be the base's: a second
//     job that reports as the gate is a difference. A base file that names gate.mjs and
//     cannot be cut leaves those unknown, and then no edit passes;
//   - any other edit is printed as a notice, and passes.
// Paths are named; no object id and no text of a file is printed.
//
// It does not run when the workflow does not start it: a pull request that removes,
// disables or reorders the step, or the job, is not seen by this file.
//
// Usage: node gate.mjs --base <ref|commit> [--root <dir>]
// Exit status: the highest of the parts: 0 clean, 1 a scan found hits or a comparison
// failed, 2 a part could not be completed. It prints what the scanners print, and its own
// lines; a path, a ref or a git message in its own lines has its control characters escaped.
//
// Node built-ins only. No network.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const DIR = "ci/general-use";
// Where the forge looks for workflows: it reads the first of these that exists.
const WORKFLOW_DIRS = [".forgejo/workflows", ".gitea/workflows", ".github/workflows"];
const USAGE = "usage: node gate.mjs --base <ref|commit> [--root <dir>]\n";

class GateError extends Error {}

function git(root, args, encoding = "utf8") {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const why = String(err.stderr || err.message || "").trim().split("\n")[0];
    throw new GateError(`git ${args[0]} failed (status ${err.status ?? "none"}): ${why}`);
  }
}

function parseArgs(argv) {
  const o = { base: null, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a !== "--base" && a !== "--root") || i + 1 >= argv.length) throw new GateError(`bad argument ${JSON.stringify(a)}`);
    o[a.slice(2)] = argv[++i];
  }
  if (!o.base) throw new GateError("--base <ref|commit> is needed");
  return o;
}

/** Copies ci/general-use/ of the commit into a new temporary directory; returns that directory. */
function checkerOf(root, commit, paths) {
  const copy = mkdtempSync(join(tmpdir(), "general-use-base-"));
  for (const rel of paths) {
    const dest = join(copy, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, git(root, ["cat-file", "blob", `${commit}:${rel}`], "buffer"));
  }
  return copy;
}

// Text from outside (a path, a ref, a message of git) is printed on one line: control
// characters and the Unicode line separators are written as escapes, so it cannot start a
// line of its own in a log.
const printable = (text) => String(text).replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, (c) => {
  const n = c.codePointAt(0);
  return n < 0x100 ? `\\x${n.toString(16).padStart(2, "0")}` : `\\u{${n.toString(16)}}`;
});

/**
 * The entries of the workflow directories of a commit, as git lists them: path → its mode,
 * type and object id. A directory that is a file or a link is one entry; one that is not
 * there has none. Nothing is read but the listing.
 */
function workflowEntries(root, commit) {
  const records = git(root, ["ls-tree", "-r", "-z", commit, "--", ...WORKFLOW_DIRS]).split("\0").filter(Boolean);
  return new Map(records.map((record) => [record.slice(record.indexOf("\t") + 1), record.slice(0, record.indexOf("\t"))]));
}

// What a workflow file of the base keeps in a pull request that edits it, derived from the
// base's bytes only: the head's text is never parsed, only searched for these bytes.
const GATE_REF = `${DIR}/gate.mjs`;
const JOBS_LINE = /^jobs:[ \t]*$/gm;

const count = (text, needle) => text.split(needle).length - 1;
const uncommented = (text) => text.split("\n").filter((l) => !/^[ \t]*#/.test(l)).join("\n");

/**
 * The protected parts of one base workflow file: the text up to and including its one
 * `jobs:` line, and, if the file names gate.mjs, the whole job that names it, from its key
 * line to the line before the next job (trailing blank and comment lines go with the next
 * job). Null when the file cannot be cut that way: then only an unchanged entry passes.
 */
function protectedParts(text) {
  const jobs = [...text.matchAll(JOBS_LINE)];
  if (jobs.length !== 1) return null;
  const headerEnd = text.indexOf("\n", jobs[0].index);
  if (headerEnd < 0) return null;
  const header = text.slice(0, headerEnd + 1);
  if (count(text, GATE_REF) === 0) return { header, job: null };
  const lines = text.slice(headerEnd + 1).split("\n");
  const content = (l) => l.trim() !== "" && !l.trimStart().startsWith("#");
  const first = lines.find(content);
  // Jobs indented by spaces only, the same for every job; a tab or anything else is not cut.
  const indent = first === undefined ? null : /^( +)[^ \t]/.exec(first)?.[1].length;
  if (!indent) return null;
  const isKey = (l) => new RegExp(`^ {${indent}}[A-Za-z0-9_-]+:[ \\t]*$`).test(l);
  const keys = lines.map((l, i) => (isKey(l) ? i : -1)).filter((i) => i >= 0);
  // Every line after `jobs:` that has content is inside a job, at more than its indent.
  for (const [i, l] of lines.entries()) {
    if (!content(l) || isKey(l)) continue;
    if (!new RegExp(`^ {${indent + 1}}`).test(l) || i < keys[0]) return null;
  }
  // The job of every line that names gate.mjs: all of them must be one job.
  const holding = new Set(lines.flatMap((l, i) => (l.includes(GATE_REF) ? [keys.filter((k) => k < i).pop()] : [])));
  if (holding.size !== 1 || holding.has(undefined)) return null;
  const start = [...holding][0];
  let end = keys.find((k) => k > start) ?? lines.length;
  while (end - 1 > start && !content(lines[end - 1])) end--;
  const body = lines.slice(start, end);
  // What the forge reports the job as: its id, and the value of its own `name:`, if any.
  const id = body[0].trim().slice(0, -1);
  const named = body.map((l) => new RegExp(`^ {${indent * 2}}name:[ \\t]*(.*?)[ \\t]*$`).exec(l)).find(Boolean);
  const names = [id, named ? named[1].replace(/^(["'])(.*)\1$/, "$2") : null].filter((n) => n);
  return { header, job: { key: body[0], text: `${body.join("\n")}\n`, isKey, names } };
}

/**
 * The gate's job is in the head once and whole, line for line where its key line is: the
 * key line once, each of the base's lines of the job right below it, in order, and the next
 * line with content after them starts another job, so nothing was put inside it or added to
 * its end. Its text found anywhere else (after a comment line, in another job) is not it.
 */
function keepsJob(head, job) {
  const lines = head.split("\n");
  const body = job.text.split("\n").slice(0, -1);
  const at = lines.indexOf(job.key);
  if (at < 0 || lines.indexOf(job.key, at + 1) >= 0) return false;
  if (body.some((l, i) => lines[at + i] !== l)) return false;
  const next = lines.slice(at + body.length).find((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
  return next === undefined || job.isKey(next);
}

/**
 * Step (b). A pull request runs the workflows of its own head, so a workflow it edits is
 * not one this file can vouch for: the forge's protection of the workflow path is what
 * reviews such a change. What is checked here is a tripwire for an honest edit, not a
 * control: an entry added, removed, renamed or changed in mode or type is refused, as is an
 * edit that does not keep a file's protected parts byte for byte, or that changes how many
 * times the workflows name gate.mjs or the gate's job. Any other edit is printed, and passes.
 */
function compareWorkflows(root, commit, base, out) {
  const before = workflowEntries(root, commit);
  const after = workflowEntries(root, "HEAD");
  const regular = (entry) => /^100(644|755) blob /.test(entry ?? "");
  const texts = (entries, rev) => new Map([...entries].filter(([, e]) => regular(e)).map(([rel]) => [rel, git(root, ["cat-file", "blob", `${rev}:${rel}`])]));
  const [was, now] = [texts(before, commit), texts(after, "HEAD")];
  const parts = new Map([...was].map(([rel, text]) => [rel, protectedParts(text)]));
  // What the forge reports the gate's job as, from the base's own files. A base file that
  // names gate.mjs and cannot be cut leaves that unknown: then no edit passes.
  const known = ![...was].some(([rel, text]) => count(text, GATE_REF) > 0 && parts.get(rel) === null);
  const names = [...new Set([...parts.values()].flatMap((p) => p?.job?.names ?? []))];
  const refused = [];
  const edited = [];
  for (const rel of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const [b, a] = [before.get(rel), after.get(rel)];
    if (b === a) continue;
    // Same path, same mode, both files: only the bytes differ.
    const p = regular(b) && regular(a) && b.split(" ")[0] === a.split(" ")[0] && known ? parts.get(rel) : null;
    const head = now.get(rel);
    // The base's text up to its one `jobs:` line starts the head, no key starts a line after
    // it (so no second `jobs:` either), and the gate's job is there whole.
    const keeps = p != null && head.startsWith(p.header)
      && !/^[^ \t\n#]/m.test(head.slice(p.header.length)) && (p.job === null || keepsJob(head, p.job));
    (keeps ? edited : refused).push(rel);
  }
  let code = 0;
  for (const rel of refused) {
    out(`general-use gate: the workflow entry ${printable(rel)} is added, removed, renamed, changed in mode or type, or edited in the gate's job or the text before \`jobs:\`: a pull request runs the workflow of its own head, so this is merged only through the forge's protection of the workflow path\n`);
    code = 1;
  }
  // A job added, removed or renamed around the gate, or one reporting under its name,
  // changes how often the workflows name it.
  // A line whose first mark is `#` is a comment, or text inside a block scalar: neither can
  // be a job's key or name, so a note about the gate in another job is not counted. A `#`
  // later on a line is not cut at: it can sit inside a quoted value before a real key.
  const total = (map, needle) => [...map.values()].reduce((n, text) => n + count(uncommented(text), needle), 0);
  for (const [i, needle] of [GATE_REF, ...names].entries()) {
    if (total(was, needle) === total(now, needle)) continue;
    out(`general-use gate: the workflows name ${i === 0 ? GATE_REF : "the gate's job"} ${total(now, needle)} times, and ${printable(base)} ${total(was, needle)} times: a job added, removed or renamed around the gate, or one that reports as it, is merged only through the forge's protection of the workflow path\n`);
    code = 1;
  }
  for (const rel of edited) out(`general-use gate: notice: the workflow file ${printable(rel)} is edited outside the gate's job and the text before \`jobs:\`: the workflow of a pull request is its own, so this gate does not vouch for it; it is reviewed through the forge's protection of the workflow path\n`);
  return code;
}

function gate(argv, out) {
  const o = parseArgs(argv);
  const root = resolve(o.root ?? git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim());
  // Every later git command, and both scans, name the base by this commit id, never by the text it was given as.
  const commit = git(root, ["rev-parse", "--verify", `${o.base}^{commit}`]).trim();
  const inBase = git(root, ["ls-tree", "-r", "-z", "--name-only", commit, "--", `${DIR}/`]).split("\0").filter(Boolean);
  const node = (args) => {
    const r = spawnSync(process.execPath, args, { encoding: "utf8", maxBuffer: 1 << 28 });
    out(r.stdout || "");
    process.stderr.write(r.stderr || "");
    return r.status;
  };

  const runs = [];
  let code = 0;
  let copy = null;
  try {
    if (inBase.includes(`${DIR}/scan.mjs`)) {
      copy = checkerOf(root, commit, inBase);
      const baseDir = join(copy, DIR);
      const base = printable(o.base);
      const from = `${base} (${commit.slice(0, 12)})`;
      // The copy that is about to decide is checked first, by its own pinned list.
      out(`general-use gate: the copy of ${DIR} from ${from}\n`);
      if (node([join(baseDir, "verify-dir.mjs"), baseDir]) !== 0) {
        out(`general-use gate: the checker of ${from} is not its own pinned copy: it was not run, and nothing was checked\n`);
        return 2;
      }
      const mergeBase = git(root, ["merge-base", commit, "HEAD"]).trim();
      const changed = git(root, ["diff", "--name-only", "-z", mergeBase, "HEAD", "--", `${DIR}/`]).split("\0").filter(Boolean);
      for (const rel of changed) out(`general-use gate: this branch changes ${printable(rel)}: a change to the gate is reviewed as one\n`);

      const lists = [];
      if (inBase.includes(`${DIR}/gate.mjs`)) {
        lists.push("--lists", baseDir);
        // (a) The tree's own directory, by the base's verify-dir.mjs: a copy that changes its
        // own check, or what SOURCE says, is still read by the one the base has.
        out(`general-use gate: this tree's ${DIR}, by the verify-dir.mjs of ${from}\n`);
        if (node([join(baseDir, "verify-dir.mjs"), join(root, DIR)]) !== 0) {
          out(`general-use gate: this tree's ${DIR} is refused by the verify-dir.mjs of ${from}\n`);
          code = 1;
        }
        // (b) The workflow directories against the base commit itself (below, at compareWorkflows).
        code = Math.max(code, compareWorkflows(root, commit, base, out));
      } else {
        out(`general-use gate: the checker of ${base} predates this step: it runs with this tree's lists, and the workflows are not compared\n`);
      }
      runs.push({ what: `the checker of ${from}${lists.length ? ", with its lists" : ""}`, args: [join(baseDir, "scan.mjs"), "--root", root, "--base", commit, ...lists] });
    } else {
      out(`general-use gate: ${printable(o.base)} has no ${DIR}/scan.mjs: nothing to compare with, so this tree's own checker decides\n`);
    }
    runs.push({ what: "this tree's own checker, with its lists", args: [join(root, DIR, "scan.mjs"), "--root", root, "--base", commit] });

    for (const run of runs) {
      out(`general-use gate: ${run.what}\n`);
      const rc = node(run.args);
      // 1 is "hits"; anything else that is not 0 (a crash, a signal, no start) is "could not look".
      const status = rc === 0 || rc === 1 ? rc : 2;
      if (status !== 0) out(`general-use gate: ${run.what} ${status === 1 ? "did not pass" : "could not complete its scan"}\n`);
      code = Math.max(code, status);
    }
    out(`general-use gate: ${runs.length} checkers: ${code === 0 ? "clean" : "NOT CLEAN"}\n`);
    return code;
  } finally {
    if (copy !== null) rmSync(copy, { recursive: true, force: true });
  }
}

let code = 2;
try {
  code = gate(process.argv.slice(2), (text) => process.stdout.write(text));
} catch (e) {
  if (e instanceof GateError) process.stderr.write(`general-use gate: could not be completed: ${printable(e.message)}\n${USAGE}`);
  // The name only: an unexpected error's message could quote something it read.
  else process.stderr.write(`general-use gate: internal error (${(e && e.name) || "unknown"}); the gate did not complete\n`);
  code = 2;
}
process.exitCode = code;
