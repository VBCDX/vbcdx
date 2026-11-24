// Tests of the general-use gate. They travel with the scanner: `node --test ci/general-use/scan.test.mjs`
// runs them in any repository that carries the directory, with Node and git and nothing else.
//
// Every fixture that must hold a denied name builds it at run time from the scanner's own
// samples (which are themselves assembled from fragments), so this file matches no rule.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CI_VARIABLES as SCAN_CI_VARIABLES, ASSEMBLED, ASSEMBLED_EXEMPT, CLASSES, FIRST_PARTY, NEGATIVE, REQUIRED, SECRET_SHAPES, ScanError, assembles, classesOf, git as scannerGit, isTestPath, lineHash, parseAllow, parseFirstParty, scanRepo, scanText, selfTest, shapesOf, withoutSquashSuffix } from "./scan.mjs";
import * as scanner from "./scan.mjs";
import { CANONICAL_REPOSITORY, CI_VARIABLES, LEGACY_URL, LOCAL, SHARED, SourceError, parseSource, verifyDir } from "./verify-dir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCAN = join(HERE, "scan.mjs");
const REPO = join(HERE, "..", "..");
const j = (...p) => p.join("");

const scratch = [];
after(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "general-use-"));
  scratch.push(d);
  return d;
}
function git(dir, ...args) {
  const r = spawnSync("git", ["-C", dir, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args[0]}: ${r.stderr}`);
  return r.stdout;
}
function write(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
}
/** A git repository holding `files` plus the two lists (empty unless given), committed once. */
function repo(files = {}, { allow = "", firstParty = "", message = "first commit" } = {}) {
  const dir = tmp();
  git(dir, "init", "-q", "-b", "main");
  write(dir, { "ci/general-use/allow.txt": allow, "ci/general-use/first-party.txt": firstParty, ...files });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return dir;
}
function commit(dir, files, message) {
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}
// The tests run inside CI jobs too: what marks a CI job is taken out of the environment of
// every program they start, and put back by the one test that is about it. So is the variable
// that names the repository: a test says which repository it stands in.
const ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !CI_VARIABLES.includes(name) && name !== "GITHUB_REPOSITORY"));
function cliEnv(env, dir, ...args) {
  const r = spawnSync(process.execPath, [SCAN, "--root", dir, ...args], { encoding: "utf8", env: { ...ENV, ...env } });
  return { rc: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}
const cli = (dir, ...args) => cliEnv({}, dir, ...args);
const checkDir = (dir) => verifyDir(dir, ENV);
const hitLines = (out) => out.split("\n").filter((l) => / \[[a-z-]+\]/.test(l) && !l.startsWith("general-use:"));
const sampleOf = (id, n = 0) => CLASSES.find((c) => c.id === id).samples[n];
const CLEAN = { "src/a.js": "export const a = 1;\n", "docs/a.md": "# A page\n\nNothing here names anyone.\n" };

// ── the rule set ────────────────────────────────────────────────────────────────────────

test("the self-test passes, and this file and the scanner match no rule", () => {
  assert.deepEqual(selfTest(), []);
  for (const f of ["scan.mjs", "scan.test.mjs", "verify-dir.mjs", "gate.mjs", "README.md"]) {
    assert.deepEqual(scanText(readFileSync(join(HERE, f), "utf8")), [], f);
  }
});

for (const cls of CLASSES) {
  test(`deleting the class ${cls.id} fails the self-test, and its samples then pass unseen`, () => {
    const rest = CLASSES.filter((c) => c !== cls);
    const errors = selfTest(rest);
    assert.ok(errors.some((e) => /^required name \d+ is caught by no class$/.test(e)), JSON.stringify(errors));
    assert.ok(cls.samples.some((s) => classesOf(s, rest).length === 0), "a sample of the class is caught by no other class");
  });
}

test("every pattern of every class catches at least one of that class's samples (no dead pattern)", () => {
  for (const cls of CLASSES) {
    cls.patterns.forEach((p, i) => assert.ok(cls.samples.some((s) => p.test(s)), `${cls.id} pattern ${i + 1} catches none of its samples`));
  }
});

test("short work-item ids and section marks: what is caught and what is not", () => {
  const id = (s) => classesOf(s).includes("tracker");
  for (const s of [j("see A", "1"), j("(C", "1)"), j("B", "2b"), j("E", "2c."), j("rows F", "1–F", "4"), j("as in `D", "3`"), j("§", "7"), j("§ ", "12")]) {
    assert.equal(id(s), true, `caught: sample of length ${s.length}`);
  }
  for (const s of [
    "0xA1", "A1B2C3", "#A1B2C3", "a1", "sha256:deadbeefA1", "an A4 page", "A4 paper", "A3 size", "X25519", "P256", "SHA1", "HS256",
    "HTTP/2", "HTTP/1.1", "V1.2", "v2", "1.2.3", "V8", "S3", "K8s", "dir/A1/x", "A1.json", "x=B2", "arr[C1]", "AB1", "A12", "A1B",
  ]) assert.equal(id(s), false, `not caught: ${s}`);
});

test("short ids in code: a call, a qualified name and a list of such tokens are not work items; a sentence is", () => {
  const id = (s) => classesOf(s).includes("tracker");
  const clean = [
    j("V", "4(addr)"), j("    V", "6(Ipv6Addr),"), j("Ip::V", "6"), j("ip.V", "4"), j("[V", "4, V", "6]"),
    j("[x, V", "6, T", "1]"), j("f(V", "4, V", "6, T", "1]"), j("( V", "4,  V", "6]"),
  ];
  clean.forEach((s, i) => assert.equal(id(s), false, `not caught: code sample ${i + 1}`));
  const caught = [
    j("card A", "1"), j("(C", "1)"), j("B", "2b, then E", "2c"),
    // A comma after it does not clear a token that starts a sentence, whatever follows the comma.
    j("B", "2b, then more"), j("done: B", "2b, C", "3]"),
    // Nor one in parentheses with a word after its comma: both sides of the list rule are needed.
    j("(C", "1, pending)"),
    // The last element of a list is judged on its own; a closing parenthesis clears nothing.
    j("f(V", "4, V", "6)"), j("x (C", "1) y"),
  ];
  caught.forEach((s, i) => assert.equal(id(s), true, `caught: prose sample ${i + 1}`));
});

test("a bare reference and a colour literal: only three or four digits in a CSS declaration or alone in quotes are a colour", () => {
  const ref = (s) => classesOf(s).includes("tracker");
  const colours = [
    "color: #333;", "background:#000;", j("border: 1px solid #", "333;"), j("  border-top: 2px dashed #", "1234;"),
    j("a { color: #", "000; }"), '"#333"', "'#000'",
  ];
  colours.forEach((s, i) => assert.equal(ref(s), false, `a colour: sample ${i + 1}`));
  const refs = [
    // A capitalised word before the colon is not a CSS property.
    j("Refs: #", "12;"), j("Refs: #", "123;"), j("x; Fixes: #", "1234;"),
    // Two digits are no colour, in a declaration or in quotes.
    j("color: #", "12;"), j('"#', '12"'), j("'#", "7'"),
    // No semicolon after it, or more text inside the quotes.
    j("color: #", "333 and more"), j('"#', '333 is open"'),
  ];
  refs.forEach((s, i) => assert.equal(ref(s), true, `a reference: sample ${i + 1}`));
});

test("the negative samples are clean and the required names are caught", () => {
  for (const s of NEGATIVE) assert.deepEqual(classesOf(s), [], s);
  REQUIRED.forEach((s, i) => assert.ok(classesOf(s).length > 0, `required name ${i + 1}`));
});

// ── controls: a fixture of each class must fail, a clean fixture passes ─────────────────

test("negative control: a clean repository passes, and says how much it scanned", () => {
  const r = cli(repo(CLEAN), "--tree-only");
  assert.equal(r.rc, 0, r.all);
  assert.match(r.out, /^general-use: 4 files: clean\n$/);
});

for (const cls of CLASSES) {
  test(`positive control: a file with a ${cls.id} name fails the scan`, () => {
    const body = cls.samples.map((s) => `${s}\n`).join("");
    const r = cli(repo({ ...CLEAN, "src/b.js": body }), "--tree-only");
    assert.equal(r.rc, 1, r.all);
    const lines = hitLines(r.out).filter((l) => l.endsWith(`[${cls.id}]`));
    assert.deepEqual(lines, cls.samples.map((_, i) => `src/b.js:${i + 1} [${cls.id}]`));
    assert.match(r.out, /general-use: 5 files: NOT CLEAN/);
  });
}

test("positive control: short ids, a section mark, an internal address and a host name each fail", () => {
  const rows = [
    ["tracker", j("// done in A", "1 and C", "1")], ["tracker", j("see §", "4")],
    ["lan-ip", sampleOf("lan-ip", 2)], ["internal-host", sampleOf("internal-host", 1)],
  ];
  for (const [cls, text] of rows) {
    const r = cli(repo({ ...CLEAN, "notes.txt": `${text}\n` }), "--tree-only");
    assert.equal(r.rc, 1, cls);
    assert.ok(hitLines(r.out).includes(`notes.txt:1 [${cls}]`), `${cls}: ${r.out}`);
  }
});

// A comment does not hide a name: every sample is a hit behind `// ` too. Two shapes are read from the
// start of a line by their definition (the first line of a key file, the key word of a credentials
// file), and are left out here.
for (const cls of CLASSES) {
  test(`positive control: a ${cls.id} name inside a comment fails the scan`, () => {
    const anchored = SECRET_SHAPES.filter((shape) => shape.pattern.source.startsWith("^")).map((shape) => shape.sample);
    assert.deepEqual(SECRET_SHAPES.filter((shape) => anchored.includes(shape.sample)).map((shape) => shape.name), ["minisign_secret", "netrc_password"]);
    const samples = cls.samples.filter((s) => !anchored.includes(s));
    assert.ok(samples.length > 0);
    const r = cli(repo({ ...CLEAN, "src/b.js": samples.map((s) => `  // ${s}\n`).join("") }), "--tree-only");
    assert.equal(r.rc, 1, r.all);
    assert.deepEqual(hitLines(r.out).filter((l) => l.endsWith(`[${cls.id}]`)), samples.map((_, i) => `src/b.js:${i + 1} [${cls.id}]`));
  });
}

// ── scope: code, tests, docs, CI, paths, and the commit messages of the range ───────────

test("scope: code, tests, fixtures, docs, CI files and paths are all scanned", () => {
  const name = sampleOf("vocabulary", 2);
  const files = {
    "src/code.js": `// ${name}\n`, "test/code.test.js": `// ${name}\n`, "test/fixtures/data.json": `{"x": "${name}"}\n`,
    "docs/guide.md": `${name}\n`, ".forgejo/workflows/ci.yml": `# ${name}\n`, [`docs/${name}-notes.md`]: "clean text\n",
  };
  const r = cli(repo({ ...CLEAN, ...files }), "--tree-only");
  assert.equal(r.rc, 1);
  assert.deepEqual(hitLines(r.out).sort(), [
    ".forgejo/workflows/ci.yml:1 [vocabulary]", "docs/guide.md:1 [vocabulary]", `docs/${name}-notes.md:0 [vocabulary]`,
    "src/code.js:1 [vocabulary]", "test/code.test.js:1 [vocabulary]", "test/fixtures/data.json:1 [vocabulary]",
  ].sort());
});

test("scope: a symbolic link's target is scanned as text", () => {
  const dir = repo(CLEAN);
  symlinkSync(j("../", sampleOf("vocabulary", 2), "/x"), join(dir, "link"));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "more");
  const r = cli(dir, "--tree-only");
  assert.equal(r.rc, 1);
  assert.deepEqual(hitLines(r.out), ["link:1 [vocabulary]"]);
});

test("scope: a NUL byte does not hide a file: it is scanned as bytes, without the short prose patterns only", () => {
  const nul = Buffer.from([0, 1, 2, 0]);
  const dir = repo({
    ...CLEAN,
    "hidden.txt": Buffer.concat([Buffer.from("plain text\n"), nul, Buffer.from(`\nby the ${sampleOf("vocabulary", 2)} on ${sampleOf("lan-ip", 2)}\n`)]),
    "late.bin": Buffer.concat([Buffer.alloc(9000, 0x61), nul, Buffer.from(`\n${sampleOf("internal-host", 0)}\n`)]),
    "image.bin": Buffer.concat([nul, Buffer.from(j(" A", "1 #", "12 Q", "3 ok\n"))]),
  });
  const r = cli(dir, "--tree-only");
  assert.equal(r.rc, 1, r.all);
  assert.deepEqual(hitLines(r.out).sort(), ["hidden.txt:3 [lan-ip]", "hidden.txt:3 [vocabulary]", "late.bin:2 [forge]", "late.bin:2 [internal-host]"]);
  for (const f of ["hidden.txt", "image.bin", "late.bin"]) assert.ok(r.out.includes(`note: ${f} holds a NUL byte`), f);
  // The same bytes without the NUL are prose, and the short patterns apply.
  assert.equal(classesOf(j(" A", "1 #", "12 Q", "3 ok")).includes("tracker"), true);
});

test("scope: an option that takes a secret is refused in source, and allowed in a test, a path and a commit message", () => {
  const flag = sampleOf("secret-flag", 0);
  const dir = repo({ ...CLEAN, "test/cli.test.js": `${flag}\n`, "test/fixtures/args.txt": `${flag}\n` });
  assert.equal(cli(dir, "--tree-only").rc, 0, "a test may pass the option to show it is refused");
  git(dir, "checkout", "-q", "-b", "topic");
  commit(dir, { "docs/b.md": "more\n" }, `refuse ${flag}`);
  assert.equal(cli(dir, "--base", "main").rc, 0, "a commit message may name it");
  commit(dir, { "src/cli.js": `${flag}\n`, "docs/cli.md": `${flag}\n` }, "add the option");
  const r = cli(dir, "--tree-only");
  assert.equal(r.rc, 1);
  assert.deepEqual(hitLines(r.out), ["docs/cli.md:1 [secret-flag]", "src/cli.js:1 [secret-flag]"]);
  for (const ok of ['"--token-file"', '"--enroll-token-stdin"', '"--key-out"', 'long = "token-file"']) {
    assert.deepEqual(classesOf(ok), [], ok);
  }
});

test("scope: a test directory is exempt unless a src directory is above it, and a test file by its name", () => {
  const exempt = [
    "tests/x", "test/x", "crates/a/tests/x.rs", "xtask/tests/x.rs", "packages/p/test/x.js",
    // The other directory names follow the same rule; a src directory below the test directory changes nothing.
    "testdata/x", "pkg/testdata/x", "test/fixtures/x.json", "lib/fixtures/x.json", "pkg/__tests__/a.js", "tests/src/x.rs",
    // A file named as a test, wherever it is.
    "src/a.test.js", "src/deep/a.test.mjs", "pkg/a_test.go", "src/tests.rs",
  ];
  for (const p of exempt) assert.equal(isTestPath(p), true, p);
  const source = [
    "src/test/x.js", "crates/a/src/tests/x.rs", "lib/src/test/y",
    "src/fixtures/x.json", "src/a/__tests__/b.js", "src/testdata/x",
    // A file is not a directory, and a name that only holds the word is not the word.
    "test", "pkg/tests", "latest/a.js", "contest/a.js", "src/contest.js", "testing/a.js",
  ];
  for (const p of source) assert.equal(isTestPath(p), false, p);
  const flag = sampleOf("secret-flag", 0);
  const dir = repo({
    ...CLEAN,
    "test/ok.js": `${flag}\n`, "src/cli.test.js": `${flag}\n`, "crates/a/tests/api.rs": `${flag}\n`, "packages/p/test/x.js": "const w = 'acme.widget/1';\n",
    "src/test/cli.js": `${flag}\n`, "crates/a/src/tests/cli.rs": `${flag}\n`,
    "src/table.js": "export const W = 'acme.widget/1';\n", "lib/src/test/widget.js": "const w = 'acme.widget/1';\n",
  }, { firstParty: "name\tacme.widget/\nfile\tsrc/table.js\n" });
  const r = cli(dir, "--tree-only");
  assert.equal(r.rc, 1, r.all);
  assert.deepEqual(hitLines(r.out).sort(), ["crates/a/src/tests/cli.rs:1 [secret-flag]", "lib/src/test/widget.js:1 [first-party]", "src/test/cli.js:1 [secret-flag]"]);
});

test("scope: a file with a UTF-16 byte-order mark is scanned as that text, and the mark hides no plain text", () => {
  const mark = { le: Buffer.from([0xff, 0xfe]), be: Buffer.from([0xfe, 0xff]) };
  const le = (text) => Buffer.concat([mark.le, Buffer.from(text, "utf16le")]);
  const be = (text) => Buffer.concat([mark.be, Buffer.from(text, "utf16le").swap16()]);
  const name = sampleOf("vocabulary", 2);
  const text = j("plain text\r\nby the ", name, " for card A", "1\r\n");
  const dir = repo({
    ...CLEAN,
    "docs/le.txt": le(text), "docs/be.txt": be(text),
    // A byte too many at the end: the text before it is still read.
    "docs/odd.txt": Buffer.concat([le(text), Buffer.from([0x41])]),
    "docs/oddbe.txt": Buffer.concat([be(text), Buffer.from([0x41])]),
    // The mark, then plain bytes: decoded as the mark says they are nothing, so the bytes are scanned too.
    "docs/fake.txt": Buffer.concat([mark.le, Buffer.from(`\n${name} here\n`)]),
    // The same name in both readings of one line is one hit, not two.
    "docs/both.txt": Buffer.concat([le(name), Buffer.from(`${name}\n`)]),
  });
  const r = cli(dir, "--tree-only");
  assert.equal(r.rc, 1, r.all);
  assert.deepEqual(hitLines(r.out).sort(), [
    "docs/be.txt:2 [tracker]", "docs/be.txt:2 [vocabulary]", "docs/both.txt:1 [vocabulary]", "docs/fake.txt:2 [vocabulary]",
    "docs/le.txt:2 [tracker]", "docs/le.txt:2 [vocabulary]", "docs/odd.txt:2 [tracker]", "docs/odd.txt:2 [vocabulary]",
    "docs/oddbe.txt:2 [tracker]", "docs/oddbe.txt:2 [vocabulary]",
  ]);
  for (const f of ["be", "both", "fake", "le", "odd", "oddbe"]) {
    assert.ok(r.out.includes(`note: docs/${f}.txt starts with a UTF-16 byte-order mark: scanned as that text, and as bytes\n`), f);
    assert.equal(r.out.includes(`note: docs/${f}.txt holds a NUL byte`), false, f);
  }
});

function branched() {
  // main: one commit whose message is dirty (before the range). The branch: two commits,
  // the FIRST of them dirty, so a range of "the last commit only" would miss it.
  const dir = repo(CLEAN, { message: j("old work, Refs #", "1") });
  git(dir, "checkout", "-q", "-b", "topic");
  commit(dir, { "src/b.js": "export const b = 2;\n" }, j("feat: b\n\nasked for by the ", sampleOf("vocabulary", 0)));
  commit(dir, { "src/c.js": "export const c = 3;\n" }, "feat: c");
  return dir;
}

test("scope: the commit messages of the range since the merge base are scanned, not only the last one", () => {
  const dir = branched();
  const r = cli(dir, "--base", "main");
  assert.equal(r.rc, 1, r.all);
  const lines = hitLines(r.out);
  assert.equal(lines.length, 1, r.out);
  assert.match(lines[0], /^commit [0-9a-f]{12}:3 \[vocabulary\]$/);
  assert.match(r.out, /general-use: 6 files, 2 commit messages: NOT CLEAN/);
  // The base moved on after the branch was cut: the range still starts at the merge base.
  git(dir, "checkout", "-q", "main");
  commit(dir, { "src/z.js": "export const z = 0;\n" }, j("later on main, Refs #", "2"));
  git(dir, "checkout", "-q", "topic");
  const again = cli(dir, "--base", "main");
  assert.equal(hitLines(again.out).length, 1, again.out);
  assert.match(again.out, /2 commit messages/);
});

test("scope: commits merged in from the base are the base's, not the branch's: only its own messages are scanned", () => {
  const dir = branched();
  git(dir, "checkout", "-q", "main");
  commit(dir, { "src/z.js": "export const z = 0;\n" }, j("later on main, Refs #", "2"));
  git(dir, "checkout", "-q", "topic");
  git(dir, "merge", "-q", "--no-edit", "main");
  const r = cli(dir, "--base", "main");
  assert.equal(r.rc, 1, r.all);
  // The branch's own two commits and its merge commit; main's commit is not in the range.
  assert.equal(hitLines(r.out).length, 1, r.out);
  assert.match(r.out, /3 commit messages/);
});

test("scope: a commit message is scanned to its end, whatever bytes it holds", () => {
  const dir = repo(CLEAN);
  git(dir, "checkout", "-q", "-b", "topic");
  // A control byte that a record separator could be confused with, then a hit after it.
  commit(dir, { "src/b.js": "export const b = 2;\n" }, j("feat: b \x01 more\n\nasked for by the ", sampleOf("vocabulary", 0)));
  const r = cli(dir, "--base", "main");
  assert.equal(r.rc, 1, r.all);
  assert.equal(hitLines(r.out).length, 1, r.out);
  assert.match(r.out, /1 commit messages/);
});

test("scope: --head-commit scans the messages a push adds at its head, a root commit's own included", () => {
  const dirty = j("squashed work\n\nasked for by the ", sampleOf("vocabulary", 0));
  // A root commit: there is no parent to start the range from.
  const root = cli(repo(CLEAN, { message: dirty }), "--head-commit");
  assert.equal(root.rc, 1, root.all);
  assert.deepEqual(hitLines(root.out).map((l) => l.replace(/^commit [0-9a-f]{12}/, "commit")), ["commit:3 [vocabulary]"]);
  assert.match(root.out, /general-use: 4 files, 1 commit messages: NOT CLEAN/);
  // A later clean commit: the dirty one is before the range.
  const dir = repo(CLEAN, { message: dirty });
  commit(dir, { "src/b.js": "export const b = 2;\n" }, "feat: b");
  const clean = cli(dir, "--head-commit");
  assert.equal(clean.rc, 0, clean.all);
  assert.match(clean.out, /^general-use: 5 files, 1 commit messages: clean\n$/);
  // A squash: its one message is scanned (the tree alone is clean).
  commit(dir, { "src/c.js": "export const c = 3;\n" }, dirty);
  assert.equal(cli(dir, "--tree-only").rc, 0);
  const squash = cli(dir, "--head-commit");
  assert.equal(squash.rc, 1, squash.all);
  assert.equal(hitLines(squash.out).length, 1, squash.out);
  assert.match(squash.out, /1 commit messages/);
  // A merge: every commit it brings in is in the range, not only the merge commit.
  const merged = repo(CLEAN);
  git(merged, "checkout", "-q", "-b", "topic");
  commit(merged, { "src/b.js": "export const b = 2;\n" }, dirty);
  git(merged, "checkout", "-q", "main");
  git(merged, "merge", "-q", "--no-ff", "-m", "merge the topic", "topic");
  const merge = cli(merged, "--head-commit");
  assert.equal(merge.rc, 1, merge.all);
  assert.equal(hitLines(merge.out).length, 1, merge.out);
  assert.match(merge.out, /2 commit messages/);
});

test("scope: --head-commit takes exactly one number a squash appends off the end of the head's subject, and nothing else", () => {
  const n = (k) => j("(#", String(k), ")");
  const head = (message) => cli(repo(CLEAN, { message }), "--head-commit");
  const tracker = (r) => hitLines(r.out).map((l) => l.replace(/^commit [0-9a-f]{12}/, "commit"));
  // One number at the very end, after a space: the forge's own.
  for (const subject of [`fix: x ${n(205)}`, `fix: x ${n(205)}\n\nA body with no number.`]) {
    const r = head(subject);
    assert.equal(r.rc, 0, r.all);
  }
  const hits = [
    // A second number before it is not the forge's: a squash appends one. Only the last is taken off.
    [`fix: x ${n(177)} ${n(205)}`, 1], [`fix: x ${n(1)} ${n(2)} ${n(3)}`, 1],
    // A number elsewhere in the subject stays, with the forge's at the end or without it.
    [`fix: ${n(1)} x ${n(205)}`, 1], [`fix: ${n(12)} x`, 1], [`fix: x ${n(1)} later`, 1], [`fix: x ${n(1)}, ${n(2)}`, 1], [j("fix: see #", "181 later"), 1],
    // No space before it: not the forge's form, so not taken off.
    [`fix: x${n(205)}`, 1],
    // Another bracket, and the body: at the end of a line or of the message.
    [`fix: x [#${j("1", "2")}]`, 1], [`fix: x\n\n${n(12)}`, 3], [`fix: x\n\nsee more ${n(12)}`, 3], [`fix: x ${n(181)}\n\nsee more ${n(12)}\nand on`, 3],
  ];
  hits.forEach(([m, line], i) => {
    const r = head(m);
    assert.equal(r.rc, 1, `subject ${i + 1}: ${r.all}`);
    assert.deepEqual(tracker(r), [`commit:${line} [tracker]`], `subject ${i + 1}`);
  });
  assert.equal(withoutSquashSuffix(`a ${n(1)}`), "a");
  assert.equal(withoutSquashSuffix(`a ${n(1)} ${n(2)}`), `a ${n(1)}`, "one, not the chain");
  assert.equal(withoutSquashSuffix(`a${n(1)}`), `a${n(1)}`);
  assert.equal(withoutSquashSuffix(`a ${n(1)}\n\nb ${n(2)}`), `a\n\nb ${n(2)}`);
  assert.equal(withoutSquashSuffix(""), "");
  // A pull request's range is not a squash: the same subject on a branch commit is a hit.
  const dir = repo(CLEAN);
  git(dir, "checkout", "-q", "-b", "topic");
  commit(dir, { "src/b.js": "export const b = 2;\n" }, `fix: x ${n(181)}`);
  assert.equal(cli(dir, "--head-commit").rc, 0);
  const range = cli(dir, "--base", "main");
  assert.equal(range.rc, 1, range.all);
  assert.equal(hitLines(range.out).length, 1);
  // Only the head's own subject: a merged commit's is scanned as written.
  git(dir, "checkout", "-q", "main");
  git(dir, "merge", "-q", "--no-ff", "-m", `merge the topic ${n(7)}`, "topic");
  const merge = cli(dir, "--head-commit");
  assert.equal(merge.rc, 1, merge.all);
  assert.equal(hitLines(merge.out).length, 1, merge.out);
  assert.match(merge.out, /2 commit messages/);
});

test("both commands run when started through a symlink, to the directory or to the file", () => {
  const linkDir = join(tmp(), "gate");
  symlinkSync(HERE, linkDir);
  const linkFiles = tmp();
  for (const f of ["scan.mjs", "verify-dir.mjs"]) symlinkSync(join(HERE, f), join(linkFiles, f));
  const clean = repo(CLEAN);
  const dirty = repo({ ...CLEAN, "docs/b.md": j(sampleOf("vocabulary", 0), "\n") });
  const changed = tmp();
  cpSync(HERE, changed, { recursive: true });
  writeFileSync(join(changed, "scan.mjs"), "// changed\n");
  for (const base of [linkDir, linkFiles]) {
    const run = (script, ...args) => {
      const r = spawnSync(process.execPath, [join(base, script), ...args], { encoding: "utf8", env: ENV });
      return { rc: r.status, out: r.stdout, all: r.stdout + r.stderr };
    };
    const ok = run("scan.mjs", "--root", clean, "--tree-only");
    assert.equal(ok.rc, 0, ok.all);
    assert.match(ok.out, /^general-use: \d+ files: clean$/m, "it ran, not just exited");
    const hit = run("scan.mjs", "--root", dirty, "--tree-only");
    assert.equal(hit.rc, 1, hit.all);
    assert.match(hit.out, /NOT CLEAN/);
    assert.equal(run("scan.mjs", "--root", tmp(), "--tree-only").rc, 2, "not a git repository");
    const pinned = run("verify-dir.mjs", HERE);
    assert.equal(pinned.rc, 0, pinned.all);
    assert.match(pinned.out, /is the pinned copy/);
    assert.equal(run("verify-dir.mjs", changed).rc, 1, "a changed copy is refused");
    assert.equal(run("verify-dir.mjs", join(changed, "nowhere")).rc, 2, "a directory that is not there cannot be checked");
  }
});

test("a program path that cannot be resolved runs nothing and exits 2, with a fixed message", () => {
  for (const [script, what] of [["scan.mjs", "the scan did not run"], ["verify-dir.mjs", "the directory was not checked"]]) {
    const gone = join(tmp(), "gone.mjs");
    const code = `process.argv[1] = ${JSON.stringify(gone)}; await import(${JSON.stringify(pathToFileURL(join(HERE, script)).href)});`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: ENV });
    assert.equal(r.status, 2, script + r.stderr);
    assert.equal(r.stderr, `general-use: the program path could not be resolved; ${what}\n`);
    assert.equal(r.stdout, "");
  }
});

test("scope: --tree-only scans no commit message; --commit-messages warn reports them and passes", () => {
  const dir = branched();
  const tree = cli(dir, "--tree-only");
  assert.equal(tree.rc, 0, tree.all);
  const warn = cli(dir, "--base", "main", "--commit-messages", "warn");
  assert.equal(warn.rc, 0, warn.all);
  assert.match(warn.out, /^warning: commit [0-9a-f]{12}:3 \[vocabulary\]$/m);
});

test("scope: the command line must say which scope it wants", () => {
  const dir = repo(CLEAN);
  assert.equal(cli(dir).rc, 2);
  assert.equal(cli(dir, "--tree-only", "--base", "main").rc, 2);
  assert.equal(cli(dir, "--tree-only", "--head-commit").rc, 2);
  assert.equal(cli(dir, "--head-commit", "--base", "main").rc, 2);
});

// ── an error is never a clean result ────────────────────────────────────────────────────

const neverClean = (r) => {
  assert.equal(r.rc, 2, r.all);
  assert.doesNotMatch(r.all, /clean\n|: ok\n/);
  assert.match(r.err, /^general-use: /);
};

test("error path: a directory that is no git repository", () => {
  const dir = tmp();
  write(dir, { "ci/general-use/allow.txt": "", "ci/general-use/first-party.txt": "", "a.txt": "clean\n" });
  // A parent directory may be a repository: put a file where a .git directory would be.
  writeFileSync(join(dir, ".git"), "not a git directory\n");
  neverClean(cli(dir, "--tree-only"));
});

test("error path: a repository with no tracked file scans nothing, and says so", () => {
  const dir = tmp();
  git(dir, "init", "-q", "-b", "main");
  write(dir, { "ci/general-use/allow.txt": "", "ci/general-use/first-party.txt": "" });
  neverClean(cli(dir, "--tree-only"));
});

test("error path: a tracked file that cannot be read (gone from the work tree; unreadable)", (t) => {
  const dir = repo(CLEAN);
  unlinkSync(join(dir, "src/a.js"));
  const gone = cli(dir, "--tree-only");
  neverClean(gone);
  assert.match(gone.err, /cannot read src\/a\.js: ENOENT/);
  // A file where the tracked file's directory was: this fails for every user, root included.
  const dir3 = repo(CLEAN);
  rmSync(join(dir3, "docs"), { recursive: true });
  writeFileSync(join(dir3, "docs"), "a file where a directory was\n");
  const blocked = cli(dir3, "--tree-only");
  neverClean(blocked);
  assert.match(blocked.err, /cannot read docs\/a\.md: ENOTDIR/);
  if (process.getuid && process.getuid() === 0) return t.diagnostic("running as root: a mode-000 file is readable, that half is skipped");
  const dir2 = repo(CLEAN);
  chmodSync(join(dir2, "docs/a.md"), 0o000);
  const denied = cli(dir2, "--tree-only");
  chmodSync(join(dir2, "docs/a.md"), 0o644);
  neverClean(denied);
  assert.match(denied.err, /cannot read docs\/a\.md: EACCES/);
});

test("error path: a base git cannot resolve, a base shaped like an option, an unrelated history", () => {
  const dir = branched();
  neverClean(cli(dir, "--base", "no-such-ref"));
  neverClean(cli(dir, "--base", "--all"));
  neverClean(cli(dir, "--base", ""));
  git(dir, "checkout", "-q", "--orphan", "island");
  git(dir, "commit", "-q", "-m", "an unrelated root");
  neverClean(cli(dir, "--base", "main"));
});

test("error path: a missing list file, an unknown argument, a missing value", () => {
  const dir = repo(CLEAN);
  neverClean(cli(dir, "--tree-only", "--everything"));
  neverClean(cli(dir, "--base"));
  neverClean(cli(dir, "--base", "main", "--commit-messages", "ignore"));
  git(dir, "rm", "-q", "ci/general-use/allow.txt");
  git(dir, "commit", "-q", "-m", "no allow list");
  neverClean(cli(dir, "--tree-only"));
});

test("error path: a pattern that does not compile stops the scanner; it does not scan with one rule fewer", () => {
  const dir = tmp();
  const src = readFileSync(SCAN, "utf8");
  const broken = src.replace('re("i", "codi", "-sdm")', 're("i", "codi(", "-sdm")');
  assert.notEqual(broken, src, "the pattern to break was found");
  writeFileSync(join(dir, "scan.mjs"), broken);
  const target = repo(CLEAN);
  for (const args of [["--self-test"], ["--root", target, "--tree-only"]]) {
    const r = spawnSync(process.execPath, [join(dir, "scan.mjs"), ...args], { encoding: "utf8", env: ENV });
    assert.notEqual(r.status, 0, args[0]);
    assert.doesNotMatch(r.stdout, /clean|ok/);
  }
});

test("error path: every git failure throws, whatever the command; none is read as empty output", () => {
  const dir = repo(CLEAN);
  assert.match(scannerGit(dir, ["log", "--format=%s"]), /^first commit\n$/);
  for (const args of [["log", "no-such-rev"], ["ls-files", "--no-such-option"], ["merge-base", "HEAD", "no-such-rev"], ["no-such-command"]]) {
    assert.throws(() => scannerGit(dir, args), ScanError, args.join(" "));
  }
  assert.throws(() => scannerGit(join(dir, "nowhere"), ["ls-files"]), ScanError);
});

test("error path: the library throws ScanError, it returns no empty result", () => {
  const dir = tmp();
  writeFileSync(join(dir, ".git"), "not a git directory\n");
  assert.throws(() => scanRepo({ root: dir }), ScanError);
  assert.throws(() => scanRepo({ root: repo(CLEAN), base: "no-such-ref" }), ScanError);
});

// ── nothing of a line reaches the output ────────────────────────────────────────────────

test("a hit prints its place and class only: never the name, the line, or a secret on the line", () => {
  const secret = j("sk-", "Zq7Xw2Lm9Tn4Rb8Vc1Yd6Hf3Kj5Pg0Ss");
  const pass = j("hunter", "2-correct-horse");
  const name = sampleOf("vocabulary", 2);
  const host = sampleOf("internal-host", 1);
  const dir = repo({
    ...CLEAN,
    "conf.env": `API_KEY=${secret} # set by the ${name}\npassword=${pass} host=${host}\n`,
    "src/table.js": "export const W = 'acme.widget/1';\n",
    "src/x.js": `export const w = 'acme.widget/1'; // token=${secret}\n`,
  }, { firstParty: "name\tacme.widget/\nfile\tsrc/table.js\n" });
  commit(dir, { "src/y.js": "export const y = 1;\n" }, j("wip for the ", name, " token=", secret));
  const place = "(?:[\\w./-]+:\\d+|commit [0-9a-f]{12}:\\d+) \\[[a-z-]+\\]";
  const shapes = {
    plain: new RegExp(`^(?:${place}|general-use: [\\w ,:()-]+)$`),
    hashes: new RegExp(`^(?:${place}(?: [\\w./-]+\\t[a-z-]+\\t[0-9a-f]{64})?|general-use: [\\w ,:()-]+)$`),
  };
  for (const [mode, extra] of [["plain", []], ["hashes", ["--hashes"]]]) {
    const r = cli(dir, "--base", "HEAD~1", ...extra);
    assert.equal(r.rc, 1, r.all);
    assert.equal(r.err, "");
    for (const banned of [secret, pass, name, host, "API_KEY", "password", "token", "acme", "wip"]) {
      assert.equal(r.all.includes(banned), false, "the output holds part of a scanned line");
    }
    const lines = r.out.split("\n").filter(Boolean);
    for (const line of lines) assert.match(line, shapes[mode]);
    assert.equal(hitLines(r.out).length, 8);
    const places = hitLines(r.out).map((l) => /^(.*? \[[a-z-]+\])/.exec(l)[1].replace(/^commit [0-9a-f]{12}/, "commit"));
    // Every line that holds the key or the pass phrase is also a hit of the secrets' class: its place, and no more.
    assert.deepEqual(places.sort(), [
      "commit:1 [secret-shape]", "commit:1 [vocabulary]", "conf.env:1 [secret-shape]", "conf.env:1 [vocabulary]", "conf.env:2 [internal-host]", "conf.env:2 [secret-shape]",
      "src/x.js:1 [first-party]", "src/x.js:1 [secret-shape]",
    ]);
    if (mode === "hashes") assert.equal(lines.filter((l) => /\t[0-9a-f]{64}$/.test(l)).length, 6, "tree hits carry their allow.txt columns");
  }
});

test("--hashes is a local aid: it is refused where a CI variable is set, and prints no hash there", () => {
  const dir = repo({ ...CLEAN, "docs/b.md": j(sampleOf("vocabulary", 0), "\n") });
  const local = cli(dir, "--tree-only", "--hashes");
  assert.equal(local.rc, 1, local.all);
  assert.match(local.out, /^docs\/b\.md:1 \[vocabulary\] docs\/b\.md\tvocabulary\t[0-9a-f]{64}$/m);
  for (const name of CI_VARIABLES) {
    const r = cliEnv({ [name]: "true" }, dir, "--tree-only", "--hashes");
    neverClean(r);
    assert.doesNotMatch(r.all, /[0-9a-f]{64}/, name);
    assert.deepEqual(hitLines(r.out), [], name);
    // Without the option the same job scans as usual.
    assert.equal(cliEnv({ [name]: "true" }, dir, "--tree-only").rc, 1, name);
  }
});

// ── the allow-list ──────────────────────────────────────────────────────────────────────

const REASON = "Generic sample data for a parser test, no real name.";
const dirtyLine = () => `  const sample = "${sampleOf("vocabulary", 2)}"; `;
const allowRow = (path, cls, line, reason = REASON) => `${path}\t${cls}\t${lineHash(line)}\t${reason}\n`;

test("allow-list: an exact path + class + line-hash entry passes the line, wherever the line moves", () => {
  const line = dirtyLine();
  const dir = repo({ ...CLEAN, "test/p.test.js": `${line}\n` }, { allow: allowRow("test/p.test.js", "vocabulary", line) });
  assert.equal(cli(dir, "--tree-only").rc, 0);
  commit(dir, { "test/p.test.js": `// moved down\n\n${line}\n` }, "move the line");
  assert.equal(cli(dir, "--tree-only").rc, 0);
});

test("allow-list: another path, another class, another hash or a changed line does not pass", () => {
  const line = dirtyLine();
  const files = { ...CLEAN, "test/p.test.js": `${line}\n`, "test/q.test.js": "// clean\n" };
  const wrong = [
    allowRow("test/q.test.js", "vocabulary", line), allowRow("test/p.test.js", "lane", line),
    allowRow("test/p.test.js", "vocabulary", `${line} changed`), allowRow("test/P.test.js", "vocabulary", line),
  ];
  for (const allow of wrong) {
    const r = cli(repo(files, { allow }), "--tree-only");
    assert.equal(r.rc, 1);
    assert.ok(hitLines(r.out).includes("test/p.test.js:1 [vocabulary]"), r.out);
    assert.match(r.out, /^allow\.txt:1 stale: /m);
  }
});

test("allow-list: a wildcard, a directory, a path outside the tree or a malformed row is refused, and the hit stands", () => {
  const line = dirtyLine();
  const h = lineHash(line);
  const files = { ...CLEAN, "test/p.test.js": `${line}\n` };
  const refusedRows = [
    `test/*.test.js\tvocabulary\t${h}\t${REASON}`, `test/**\tvocabulary\t${h}\t${REASON}`, `test/\tvocabulary\t${h}\t${REASON}`,
    `test/p.test.j?\tvocabulary\t${h}\t${REASON}`, `test/[p].test.js\tvocabulary\t${h}\t${REASON}`, `test/{p,q}.test.js\tvocabulary\t${h}\t${REASON}`,
    `/test/p.test.js\tvocabulary\t${h}\t${REASON}`, `test/../test/p.test.js\tvocabulary\t${h}\t${REASON}`,
    `test/p.test.js\t*\t${h}\t${REASON}`, `test/p.test.js\tvocabulary\t*\t${REASON}`, `test/p.test.js\tvocabulary\t${h.toUpperCase()}\t${REASON}`,
    `test/p.test.js\tvocabulary\t${h}\tbecause`, `test/p.test.js\tvocabulary\t${h}`, `test/p.test.js vocabulary ${h} ${REASON}`,
    `test/p.test.js\tvocabulary\t${h}\t${REASON}\textra`,
    `test/p.test.js\tvocabulary\t${h}\texpires soon: ${REASON}`, `test/p.test.js\tvocabulary\t${h}\texpires 2001-01-01: ${REASON}`,
  ];
  for (const row of refusedRows) {
    const r = cli(repo(files, { allow: `${row}\n` }), "--tree-only");
    assert.equal(r.rc, 1, row.split("\t")[0]);
    assert.match(r.out, /^allow\.txt:1 /m);
    assert.ok(hitLines(r.out).includes("test/p.test.js:1 [vocabulary]"), "the hit is still reported");
  }
  const twice = `${allowRow("test/p.test.js", "vocabulary", line)}${allowRow("test/p.test.js", "vocabulary", line)}`;
  assert.match(cli(repo(files, { allow: twice }), "--tree-only").out, /^allow\.txt:2 duplicate entry$/m);
});

test("allow-list: a stale entry fails a tree that has no hit at all", () => {
  const line = dirtyLine();
  const r = cli(repo(CLEAN, { allow: allowRow("src/a.js", "vocabulary", line) }), "--tree-only");
  assert.equal(r.rc, 1);
  assert.deepEqual(hitLines(r.out), []);
  assert.match(r.out, /^allow\.txt:1 stale: /m);
  assert.match(r.out, /NOT CLEAN: 0 hits, 1 list problems/);
});

test("allow-list: an entry with an expiry passes until that day and fails after it", () => {
  const line = dirtyLine();
  const dir = repo({ ...CLEAN, "test/p.test.js": `${line}\n` });
  const allowText = allowRow("test/p.test.js", "vocabulary", line, `expires 2030-06-30: ${REASON}`);
  const run = (today) => scanRepo({ root: dir, allowText, today });
  assert.deepEqual([run("2030-06-30").hits.length, run("2030-06-30").refused.length], [0, 0]);
  const late = run("2030-07-01");
  assert.equal(late.hits.length, 1);
  assert.deepEqual(late.refused, ["allow.txt:1 the entry expired on 2030-06-30"]);
});

test("allow-list: the reasons are scanned like any other tracked text", () => {
  const line = dirtyLine();
  const allow = allowRow("test/p.test.js", "vocabulary", line, j("Sample data, see #", "12 for why."));
  const r = cli(repo({ ...CLEAN, "test/p.test.js": `${line}\n` }, { allow }), "--tree-only");
  assert.equal(r.rc, 1);
  assert.deepEqual(hitLines(r.out), ["ci/general-use/allow.txt:1 [tracker]"]);
});

// ── the first-party check ───────────────────────────────────────────────────────────────

const FP = "name\tacme.widget/\nname\tWIDGET_CONTRACT\nfile\tsrc/table.js\nfile\tdocs/\n";
const FP_FILES = {
  ...CLEAN,
  "src/table.js": "export const WIDGET_CONTRACT = 'acme.widget/1';\n",
  "docs/widget.md": "The acme.widget/1 contract.\n",
  "test/widget.test.js": "import { WIDGET_CONTRACT } from '../src/table.js';\n",
  "test/fixtures/pack.json": "{\"contracts\": [\"acme.widget/1\"]}\n",
};

test("first-party: a name in its declared file, its docs directory, a test or a fixture passes", () => {
  const r = cli(repo(FP_FILES, { firstParty: FP }), "--tree-only");
  assert.equal(r.rc, 0, r.all);
});

test("first-party: a name switch in any other source file fails, on the constant and on the literal", () => {
  const files = {
    ...FP_FILES,
    "src/render.js": "import { WIDGET_CONTRACT } from './table.js';\nexport const special = (b) => b.contract === WIDGET_CONTRACT;\n",
    "bin/tool.js": "if (c === 'acme.widget/1') special();\n",
    "README.md": "Uses acme.widget/1.\n",
  };
  const r = cli(repo(files, { firstParty: FP }), "--tree-only");
  assert.equal(r.rc, 1);
  assert.deepEqual(hitLines(r.out).sort(), ["README.md:1 [first-party]", "bin/tool.js:1 [first-party]", "src/render.js:1 [first-party]", "src/render.js:2 [first-party]"]);
});

test("first-party: one such line can be allow-listed by hash, and only that line", () => {
  const line = "export const special = (b) => b.contract === WIDGET_CONTRACT;";
  const files = { ...FP_FILES, "src/render.js": `${line}\nexport const other = WIDGET_CONTRACT;\n` };
  const r = cli(repo(files, { firstParty: FP, allow: allowRow("src/render.js", FIRST_PARTY, line) }), "--tree-only");
  assert.equal(r.rc, 1);
  assert.deepEqual(hitLines(r.out), ["src/render.js:2 [first-party]"]);
});

test("first-party: the list cannot rot (a declared file with no name, a name nobody uses) or be malformed", () => {
  const noName = cli(repo({ ...FP_FILES, "src/table.js": "export const nothing = 1;\n", "src/other.js": "// clean\n" }, { firstParty: `${FP}file\tsrc/other.js\n` }), "--tree-only");
  assert.equal(noName.rc, 1);
  assert.match(noName.out, /^first-party\.txt:5 stale: that file names no first-party entry$/m);
  assert.match(noName.out, /^first-party\.txt:3 stale: /m);
  assert.match(noName.out, /^first-party\.txt:2 stale: that name appears in no non-test file$/m);
  for (const bad of ["name\tacme.widget/\n", "file\tsrc/*.js\nname\tacme.widget/\n", "name\tab\nfile\tsrc/table.js\n", "names\tacme.widget/\n", "name acme.widget/\n", "file\t../x\nname\tacme.widget/\n"]) {
    assert.ok(parseFirstParty(bad).errors.length > 0, JSON.stringify(bad));
    assert.equal(cli(repo(FP_FILES, { firstParty: bad }), "--tree-only").rc, 1);
  }
});

test("first-party: with no name listed, nothing is checked and nothing is stale", () => {
  assert.equal(cli(repo({ ...CLEAN, "src/render.js": "const c = 'acme.widget/1';\n" }), "--tree-only").rc, 0);
});

// ── this repository ─────────────────────────────────────────────────────────────────────

const ownList = (name) => readFileSync(join(HERE, name), "utf8");

test("this repository passes the scan", () => {
  const r = scanRepo({ root: REPO, allowText: ownList("allow.txt"), firstPartyText: ownList("first-party.txt") });
  assert.deepEqual(r.hits.map((h) => `${h.where} [${h.cls}]`), []);
  assert.deepEqual(r.refused, []);
  assert.ok(r.files > 4);
});

test("every entry of this repository's allow.txt is needed: without it the scan fails on that file and class", () => {
  const text = ownList("allow.txt");
  const { entries, errors } = parseAllow(text);
  assert.deepEqual(errors, []);
  const lines = text.split("\n");
  for (const e of entries) {
    const without = lines.filter((_, i) => i + 1 !== e.n).join("\n");
    const r = scanRepo({ root: REPO, allowText: without, firstPartyText: ownList("first-party.txt") });
    assert.ok(r.hits.some((h) => h.path === e.path && h.cls === e.cls && h.key === e.key), `allow.txt:${e.n} allows nothing`);
    assert.deepEqual(r.refused, [], `allow.txt:${e.n}`);
  }
});

test("every file entry of this repository's first-party.txt is needed: without it that file fails", () => {
  const text = ownList("first-party.txt");
  const fp = parseFirstParty(text);
  assert.deepEqual(fp.errors, []);
  const lines = text.split("\n");
  for (const f of fp.files) {
    const without = lines.filter((_, i) => i + 1 !== f.n).join("\n");
    const r = scanRepo({ root: REPO, allowText: ownList("allow.txt"), firstPartyText: without });
    assert.ok(r.hits.some((h) => h.cls === FIRST_PARTY && (f.path.endsWith("/") ? h.path.startsWith(f.path) : h.path === f.path)), `first-party.txt:${f.n} declares nothing`);
  }
});

// ── the shapes of secrets ───────────────────────────────────────────────────────────────

// Letters and digits of a given length: what stands where a credential would.
const fill = (n) => "Zq7Xw2Lm9Tn4Rb8Vc1Yd6Hf3Kj5Pg0SsAa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8".slice(0, n);
const UPPER = "ABCDEFGHIJ234567";
const BEGIN = (what) => j("-----BEGIN ", what, "PRIV", "ATE KEY-----");
// A key word, cut so this file holds none whole, then what follows it.
const word = (w, rest) => j(w.slice(0, 3), w.slice(3), rest);
const SHAPE_NAMES = [
  "pem_private", "pgp_private", "minisign_secret", "openssh_private", "openai_like", "stripe_live", "vbcdx_token", "slack", "github", "gitlab", "npm",
  "aws_akid", "google_api", "coolify_token", "jwt", "auth_header", "x_api_key", "url_userinfo", "netrc_password", "kv_secret", "cloudflare_access_secret",
];
// For each shape: lines it must catch, and lines next to it that it must not.
const SHAPE_ROWS = {
  pem_private: [[BEGIN(""), BEGIN("RSA "), BEGIN("EC "), BEGIN("ENCRYPTED "), j("-----BEGIN PGP PRIV", "ATE KEY BLOCK-----")], ["-----BEGIN PUBLIC KEY-----", "-----BEGIN CERTIFICATE-----", j("-----BEGIN rsa PRIV", "ATE KEY-----"), j("BEGIN PRIV", "ATE KEY")]],
  pgp_private: [[j("-----BEGIN PGP PRIV", "ATE KEY BLOCK-----")], ["-----BEGIN PGP PUBLIC KEY BLOCK-----", BEGIN("PGP ")]],
  minisign_secret: [
    [j("untrusted comment: mini", "sign encrypted sec", "ret key"), j("untrusted comment: mini", "sign sec", "ret key"), j("Untrusted Comment: Mini", "sign Encrypted Sec", "ret Key")],
    ["minisign public key", j("mini", "sign key"), j("mini", "sign sec", "ret key"), j("an untrusted comment: mini", "sign encrypted sec", "ret key"), j("untrusted comment: mini", "sign encrypted sec", "ret keys")],
  ],
  openssh_private: [[BEGIN("OPENSSH ")], ["-----BEGIN OPENSSH PUBLIC KEY-----"]],
  openai_like: [[j("s", "k-", fill(20)), j("s", "k-proj-", fill(20)), j("s", "k-ant-", fill(20)), j("key s", "k-", fill(48))], [j("s", "k-", fill(19)), j("ta", "sk-", fill(24)), j("di", "sk-", fill(24)), "sk-<V len=48>"]],
  stripe_live: [[j("sk_li", "ve_", fill(16)), j("rk_li", "ve_", fill(24))], [j("sk_te", "st_", fill(24)), j("sk_li", "ve_", fill(15)), j("pk_li", "ve_", fill(24))]],
  vbcdx_token: [[j("vb", "x_ses_", fill(16)), j("vb", "x_tok_", fill(16)), j("vb", "x_enr_", fill(32))], [j("vb", "x_abc_", fill(16)), j("vb", "x_tok_", fill(15)), j("avb", "x_tok_", fill(16))]],
  slack: [[j("xo", "xb-", fill(10)), j("xo", "xp-", "12345-67890-", fill(8)), j("xo", "xa-", fill(10))], [j("xo", "xz-", fill(10)), j("xo", "xb-", fill(9))]],
  github: [["p", "o", "u", "s", "r"].map((k) => j("gh", k, "_", fill(30))).concat([j("github", "_pat_", fill(40))]), [j("gh", "x_", fill(30)), j("gh", "p_", fill(29)), j("github", "_pat_", fill(39))]],
  gitlab: [[j("gl", "pat-", fill(20))], [j("gl", "pat-", fill(19)), j("gl", "tok-", fill(20))]],
  npm: [[j("np", "m_", fill(36))], [j("np", "m_", fill(35)), j("np", "m_", fill(37))]],
  aws_akid: [[j("AK", "IA", UPPER), j("AS", "IA", UPPER)], [j("AK", "IA", UPPER.slice(1)), j("AK", "IA", UPPER, "Q"), j("ak", "ia", UPPER.toLowerCase()), j("AG", "PA", UPPER)]],
  google_api: [[j("AI", "za", fill(35))], [j("AI", "za", fill(34)), j("AI", "za", fill(36)), j("ai", "za", fill(35))]],
  coolify_token: [[j("7", "|", fill(40)), j("123456", "|", fill(48))], [fill(40), "da39a3ee5e6b4b0d3255bfef95601890afd80709", j("1234567", "|", fill(40)), j("7", "|", fill(39)), j("x", "|", fill(40))]],
  jwt: [[j("ey", "J", fill(10), ".ey", "J", fill(10), ".", fill(10))], [j("ey", "J", fill(10), ".ey", "J", fill(10)), j("ey", "J", fill(9), ".ey", "J", fill(10), ".", fill(10)), j("ey", "K", fill(10), ".ey", "J", fill(10), ".", fill(10))]],
  auth_header: [
    ["Bearer", "bearer", "Token", "Basic"].map((scheme) => j("Authori", "zation: ", scheme, " ", fill(12))).concat([j("AUTHORI", "ZATION:Bearer  ", fill(40))]),
    ["Authorization: Bearer ${TOKEN}", "Authorization: Bearer $TOKEN", "Authorization: Bearer <token>", "Authorization: Bearer [redacted]", "Authorization: Bearer ***", "Authorization: Bearer REDACTED", j("Authori", "zation: Bearer ", fill(11)), j("Authori", "zation: Digest ", fill(20)), "authorization is needed",
     // A placeholder that goes on: the word that says the value was taken out, and more after it.
     j("Authori", "zation: Bearer REDACTED", "-BY-POLICY"), j("Authori", "zation: Bearer redacted", ".by.policy")],
  ],
  x_api_key: [
    ["x-api-", "X-Api-", "x-litellm-api-", "api-"].map((name) => j(name, "key: ", fill(12))),
    ["x-api-key: ${KEY}", "x-api-key: <key>", "api-key: ***", j("x-api-", "key: ", fill(11)), j("x-api-", "key ", fill(20)), j("x-api-", "key: REDACTED", "_VALUE_HERE")],
  ],
  url_userinfo: [
    [j("postgres://u:", "pw12@", "db/x"), j("HTTPS://user:", fill(12), "@", "example.invalid/r.git")],
    ["https://user@example.invalid/", "https://example.invalid:8443/path", "https://user:${PASSWORD}@example.invalid/", "https://user:<password>@example.invalid/", "https://user:***@example.invalid/", j("https://user:", "pw1@", "example.invalid/"), "see: a note about x@y"],
  ],
  netrc_password: [
    [word("password", j(" ", fill(6))), j("  ", word("password", j("\t", fill(12)))), j("machine example.invalid login someone ", word("password", j(" ", fill(8)))), j("login someone ", word("password", j(" ", fill(8)))), j("PASS", "WORD ", fill(8))],
    ["password <redacted>", "password ***", word("password", j(" ", fill(5))), j("the ", word("password", j(" ", fill(8)))), j("# ", word("password", j(" ", fill(8))))],
  ],
  kv_secret: [
    ["password", "passwd", "secret", "client_secret", "api_key", "apikey", "access_token", "refresh_token", "private_key", "token", "kek"].map((w) => word(w, j(" = ", fill(16))))
      // The key word after a separator in a longer name: an underscore, a hyphen, a dot.
      .concat([j("DB_PASS", "WORD=", fill(16)), j("AWS_SEC", "RET_ACCESS_KEY=", fill(40)), j("GITHUB_TOK", "EN=", fill(36)), j("STRIPE_API_", "KEY=", fill(24))])
      .concat([j("db-pass", "word: ", fill(16)), j("spring.datasource.pass", "word=", fill(16)), j("export MY_APP_SEC", "RET=", fill(20)), j("x.client_sec", "ret = ", fill(20))])
      .concat([word("password", j(": ", fill(16))), word("token", j("=", fill(16))), word("TOKEN", j("='", fill(16), "'")), j('"', word("secret", j('": "', fill(24), '"'))), word("api_key", j(":", fill(40)))]),
    ["token=<R>", "token = ${TOKEN}", "token = $TOKEN", "password=REDACTED", "secret: ***", "api_key = [redacted]", "token: xxx", word("token", j(" = ", fill(15))), word("token", j(" ", fill(20))), j("key = ", fill(20)), j("my", word("token", j("s = ", fill(20)))), j("my", word("token", j(" = ", fill(20)))),
     // The key word inside a longer word is no key word, at its start or at its end.
     j("PASS", "WORDLESS=", fill(20)), j("TOK", "ENIZER_PATH=", fill(20)), j("SEC", "RETARY=", fill(20)), j("notatok", "en=", fill(20)), j("x2tok", "en=", fill(20)),
     // A name that only begins with the key word, with more of the name after it.
     j("TOK", "EN_FILE=", fill(20)), j("PASS", "WORD_HINT=", fill(20)),
     // The same names with a placeholder where the value would be.
     j("DB_PASS", "WORD=${DB_PASS", "WORD}"), j("DB_PASS", "WORD=$DB_PASS", "WORD_FROM_THE_ENVIRONMENT"), j("GITHUB_TOK", "EN=<redacted>"), j("STRIPE_API_", "KEY=[redacted-value-here]"),
     j("AWS_SEC", "RET_ACCESS_KEY=***"), j("GITHUB_TOK", "EN={env:GITHUB_TOK", "EN_FOR_THE_BUILD}"), j("DB_PASS", "WORD={file:/run/x/db}"),
     // A placeholder that goes on: a run of the letter that stands for one, and the word that says the value was taken out.
     word("token", j(" = ", "x".repeat(20))), word("password", j("=", "REDACTED", "_0123456789")), word("secret", j(': "', "redacted", '.by.policy.0"'))],
  ],
  cloudflare_access_secret: [[j("cf", "ast_", fill(48))], [j("cf", "ast_", fill(47)), j("cf", "ast_", fill(49)), j("cf", "abc_", fill(48))]],
};

test("secret shapes: the list is the twenty-one shapes, each with a sample it catches by name", () => {
  assert.deepEqual(SECRET_SHAPES.map((shape) => shape.name), SHAPE_NAMES);
  assert.deepEqual(Object.keys(SHAPE_ROWS), SHAPE_NAMES, "a row of samples for every shape");
  for (const { name, pattern, sample } of SECRET_SHAPES) {
    assert.ok(shapesOf(sample).includes(name), `${name}: its own sample`);
    assert.ok(classesOf(sample).includes("secret-shape"), name);
    // A pattern that kept its place between two tests would skip every other line.
    assert.equal(pattern.global || pattern.sticky, false, name);
  }
  // The class has one pattern for each shape, in the same order, and it is that shape's.
  const ofClass = CLASSES.find((c) => c.id === "secret-shape").patterns;
  assert.equal(ofClass.length, SECRET_SHAPES.length);
  SECRET_SHAPES.forEach((shape, i) => assert.deepEqual(SECRET_SHAPES.map((other) => ofClass[i].test(other.sample)), SECRET_SHAPES.map((other) => shapesOf(other.sample).includes(shape.name)), shape.name));
});

for (const name of SHAPE_NAMES) {
  test(`secret shapes: ${name} catches its lines, and not the lines next to it`, () => {
    const [caught, clean] = SHAPE_ROWS[name];
    caught.forEach((line, i) => assert.ok(shapesOf(line).includes(name), `caught: line ${i + 1}`));
    clean.forEach((line, i) => assert.equal(shapesOf(line).includes(name), false, `not caught: line ${i + 1}`));
    // Without this shape, at least one of its lines is caught by no other: the shape is needed.
    const others = (line) => shapesOf(line).filter((n) => n !== name);
    assert.ok(caught.some((line) => others(line).length === 0) || ["pgp_private", "openssh_private"].includes(name), "a line only this shape catches");
  });
}

test("secret shapes: a placeholder, an id and encoded text are not secrets", () => {
  const clean = [
    "token=<R>", "Authorization: Bearer ${TOKEN}", "password <redacted>", "sk-<V len=48>", "da39a3ee5e6b4b0d3255bfef95601890afd80709", "123e4567-e89b-12d3-a456-426614174000",
    "aGVsbG8gd29ybGQsIHRoaXMgaXMgcGxhaW4gdGV4dA==", "{file:/run/secrets/x}", "{env:TOKEN}", "<V len=40>", "a token, a password and a secret are named here", "sha256:" + "0".repeat(64),
  ];
  for (const line of clean) assert.deepEqual(shapesOf(line), [], line);
});

test("secret shapes: source, tests, paths and commit messages are all scanned, and nothing of the line is printed", () => {
  const key = j("gh", "p_", fill(36));
  const line = j("const ", word("token", j(' = "', key, '";')));
  const dir = repo({ ...CLEAN, "src/s.js": `${line}\n`, "test/s.test.js": `${line}\n`, "test/fixtures/s.json": `{"k": "${key}"}\n` });
  git(dir, "checkout", "-q", "-b", "topic");
  commit(dir, { "src/b.js": "export const b = 2;\n" }, `feat: b\n\nwith ${key}`);
  const r = cli(dir, "--base", "main");
  assert.equal(r.rc, 1, r.all);
  // A commit message's hit is its commit and its line; a file's is its path and its line.
  assert.match(r.out, /^commit [0-9a-f]{12}:3 \[secret-shape\]$/m);
  assert.deepEqual(hitLines(r.out).map((l) => l.replace(/^commit [0-9a-f]{12}/, "commit")).sort(), [
    "commit:3 [secret-shape]", "src/s.js:1 [secret-shape]", "test/fixtures/s.json:1 [secret-shape]", "test/s.test.js:1 [secret-shape]",
  ]);
  // The place and the class, never the shape's name and never the value.
  assert.equal(r.all.includes(key), false);
  for (const name of SHAPE_NAMES) assert.equal(r.all.includes(name), false, name);
  // One line can be allowed, by its hash, for this class; the others still fail.
  const allow = `test/s.test.js\tsecret-shape\t${lineHash(line)}\tA made-up value in a test of the parser: no credential of any service.\n`;
  commit(dir, { "ci/general-use/allow.txt": allow }, "test: allow the fixture");
  const allowed = cli(dir, "--tree-only");
  assert.equal(allowed.rc, 1);
  assert.equal(hitLines(allowed.out).includes("test/s.test.js:1 [secret-shape]"), false);
  assert.equal(hitLines(allowed.out).includes("src/s.js:1 [secret-shape]"), true);
});

test("secret shapes: a path whose own name has a secret's shape is never printed: its number among the tracked files stands for it", () => {
  const id = j("AK", "IA", UPPER);
  const name = sampleOf("vocabulary", 2);
  const secretPath = `docs/${id}.md`;
  const binaryPath = `docs/${id}.bin`;
  const widePath = `docs/${id}.txt`;
  const dir = repo({
    ...CLEAN,
    // Its own hit, and another class's hit on a line of it.
    [secretPath]: `clean text\n${name}\n`,
    // The notes about a file name the file too.
    [binaryPath]: Buffer.concat([Buffer.from([0]), Buffer.from("x\n")]),
    [widePath]: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("plain", "utf16le")]),
    "docs/plain.md": `${name}\n`,
  });
  const listed = git(dir, "ls-files").split("\n");
  const standIn = (path) => `(a path whose name has a secret's shape: number ${listed.indexOf(path) + 1} in git ls-files)`;
  for (const path of [secretPath, binaryPath, widePath]) assert.ok(listed.indexOf(path) >= 0, "the path is tracked");
  const never = (text) => {
    // Not the path, not the shaped part of it, and no part of that long enough to tell it by.
    for (const part of [secretPath, id, id.slice(0, 8), id.slice(4), id.slice(-8)]) assert.equal(text.includes(part), false, "part of the path is in the output");
  };
  for (const extra of [[], ["--hashes"]]) {
    const r = cli(dir, "--tree-only", ...extra);
    assert.equal(r.rc, 1, r.all);
    never(r.all);
    assert.deepEqual(r.out.split("\n").filter((l) => / \[[a-z-]+\]/.test(l)).map((l) => /^(.* \[[a-z-]+\])/.exec(l)[1]).sort(), [
      `${standIn(binaryPath)}:0 [secret-shape]`, `${standIn(secretPath)}:0 [secret-shape]`, `${standIn(secretPath)}:2 [vocabulary]`, `${standIn(widePath)}:0 [secret-shape]`,
      "docs/plain.md:1 [vocabulary]",
    ].sort());
    assert.ok(r.out.includes(`note: ${standIn(binaryPath)} holds a NUL byte: `), r.out);
    assert.ok(r.out.includes(`note: ${standIn(widePath)} starts with a UTF-16 byte-order mark: `), r.out);
    assert.match(r.out, /NOT CLEAN: 5 hits \(secret-shape 3, vocabulary 2\)/);
    // The columns for allow.txt carry the same stand-in and no hash: the hash of line 0 is the hash of the
    // path, which a reader could test guesses of the name against. Such a file is renamed, not allowed.
    for (const path of [secretPath, binaryPath, widePath]) {
      for (const text of [path, path.trim(), id]) {
        assert.equal(r.all.includes(lineHash(text)), false, "a hash of the path is in the output");
        assert.equal(r.all.includes(createHash("sha256").update(text).digest("hex")), false, "a hash of the path is in the output");
      }
    }
    assert.doesNotMatch(r.out.split("\n").filter((l) => l.startsWith("(a path")).join("\n"), /[0-9a-f]{64}/, "no hash at all on a line of such a file");
    if (extra.length) {
      assert.ok(r.out.includes(`${standIn(secretPath)}:0 [secret-shape] ${standIn(secretPath)}\tsecret-shape\t-\n`), r.out);
      assert.ok(r.out.includes(`${standIn(secretPath)}:2 [vocabulary] ${standIn(secretPath)}\tvocabulary\t-\n`), r.out);
      // Any other file keeps its hash.
      assert.ok(r.out.includes(`docs/plain.md:1 [vocabulary] docs/plain.md\tvocabulary\t${lineHash(name)}\n`), r.out);
    }
  }
  // Every other path is printed as before.
  assert.ok(cli(dir, "--tree-only").out.includes("docs/plain.md:1 [vocabulary]\n"));
  // A scan that cannot read the file says so without its name.
  unlinkSync(join(dir, secretPath));
  const gone = cli(dir, "--tree-only");
  assert.equal(gone.rc, 2);
  assert.equal(gone.err, `general-use: the scan could not be completed: cannot read ${standIn(secretPath)}: ENOENT\n`);
  never(gone.all);
  // A file handed to the scan that git does not list has no number.
  const extraFile = `out/${id}.log`;
  write(dir, { [secretPath]: "clean text\n", [extraFile]: "clean text\n" });
  const lib = scanRepo({ root: dir, extraFiles: [extraFile] });
  assert.ok(lib.hits.some((h) => h.where === "(a path whose name has a secret's shape: given to the scan, not in git ls-files):0" && h.cls === "secret-shape"), JSON.stringify(lib.hits.map((h) => h.where)));
  for (const h of lib.hits) never(h.where);
});

// ── narrowings: what a rule does not take for a hit, in one kind of file or one context ──

// Each narrowing has a test of what is no hit any more ("not a hit": it fails with the scanner
// as it was before the narrowing) and a test of what still is one ("still a hit": it passes
// with both). A path is the tracked file a line is in; without one every rule is at its strictest.
const shaped = (name, line, path) => shapesOf(line, { path }).includes(name);
const classed = (id, line, path) => classesOf(line, CLASSES, { path }).includes(id);
// A key word cut in two, so that no line of this file holds one next to a value.
const kw = (w) => j(w.slice(0, 3), w.slice(3));
const each = (rows, check) => rows.forEach((row, i) => check(row, `row ${i + 1}`));
const CODE_EXTENSIONS = ["js", "mjs", "cjs", "ts", "tsx", "jsx", "rs", "go", "py", "java", "kt", "rb", "php", "cs", "swift", "c", "h", "cc", "cpp"];
// No path, and files that are not code by their name: settings, scripts, data, prose, and
// code under a name that does not say so.
const NOT_CODE_PATHS = [
  undefined, ".env", "conf/app.env", ".env.example", "ci/run.sh", "ci/x.yml", "x.yaml", "x.toml", "x.ini", "x.json", "x.conf", "Dockerfile",
  "notes/code.txt", "docs/a.md", "src/a.go.txt", "src/go", "src/.go", "src/a.GO", "go/a",
];

test("narrowing, scope: the code files are one list of extensions; code under another name is not on it", () => {
  assert.equal(typeof scanner.isCodePath, "function", "the scanner says which files are code");
  for (const ext of CODE_EXTENSIONS) assert.equal(scanner.isCodePath(`src/deep/a.${ext}`), true, ext);
  for (const path of NOT_CODE_PATHS) assert.equal(scanner.isCodePath(path), false, String(path));
});

// ── a name = value pair whose value is an expression of a program ──

const EXPRESSIONS = [
  ["internal/config/config.go", j('\t\t"oidc_client_', kw("secret"), '": c.OIDC.Client', kw("Secret"), ",")],
  ["web/src/messages.tsx", j("  show({ user: name, ", kw("password"), ": res.access_", kw("token"), " })")],
  ["crates/client/src/lib.rs", j("    let ", kw("token"), " = ", kw("token"), ".unwrap_or_else(|| {")],
  ["crates/control/src/ops.rs", j('        data: json!({"', kw("token"), '": session.', kw("token"), '.clone(), "user": session.user}),')],
  ["xtask/src/release.rs", j("    let ", kw("password"), " = first.strip_suffix('\\r').unwrap_or(first);")],
  ["src/store.rs", j("    let ", kw("token"), " = SessionTokenStore::open(dir)?;")],
  ["tools/derive.py", j(kw("secret"), " = derive_session_key(seed)")],
  ["src/conf.js", j("  const ", kw("token"), " = options.session.", kw("token"))],
  // A name one character short of a long run.
  ["src/conf.go", j("\t", kw("token"), " = session.", "a".repeat(19), ".value")],
];
const TOKEN_OF_THREE_PARTS = j("ey", "J", fill(24), ".ey", "J", fill(24), ".", fill(24));

test("narrowing, an expression as a value, not a hit: in a code file, an unquoted value that is a member access, a call or a path", () => {
  each(EXPRESSIONS, ([path, line], row) => assert.equal(shaped("kv_secret", line, path), false, row));
  // In a file of every extension of the list.
  for (const ext of CODE_EXTENSIONS) assert.equal(shaped("kv_secret", EXPRESSIONS[0][1], `src/a.${ext}`), false, ext);
});

test("narrowing, an expression as a value, still a hit: the same lines in a file that is not code, and with no file", () => {
  for (const path of NOT_CODE_PATHS) each(EXPRESSIONS, ([, line], row) => assert.equal(shaped("kv_secret", line, path), true, `${String(path)} ${row}`));
});

test("narrowing, an expression as a value, still a hit: a token of three dotted parts, unquoted, in a settings file and in a code file", () => {
  const line = j("API_", kw("TOKEN"), "=", TOKEN_OF_THREE_PARTS);
  for (const path of [undefined, ".env", "conf/app.env", "ci/run.sh", "ci/x.yml", "src/a.go", "src/a.js", "src/a.rs"]) assert.equal(shaped("kv_secret", line, path), true, String(path));
});

test("narrowing, an expression as a value, still a hit: a value with a run of twenty base64 characters is never code", () => {
  const rows = [
    // A literal inside a call.
    j("\t", kw("token"), " = session.", kw("token"), '.get("', fill(24), '")'),
    // A dotted value with one long part, and a member access with a long name.
    j(kw("TOKEN"), "=abc.", fill(22)),
    j("\t", kw("token"), " = session.", "a".repeat(20), ".value"),
    j("\t", kw("token"), " = session.", fill(20), "::open()"),
    // The run stands later on the line.
    j("\t", kw("token"), " = session.cache.value, ", fill(20)),
  ];
  each(rows, (line, row) => {
    for (const path of ["src/a.go", "src/a.js"]) assert.equal(shaped("kv_secret", line, path), true, `${path} ${row}`);
  });
});

test("narrowing, an expression as a value, still a hit: in a code file, a quoted literal, and an unquoted value that is no expression", () => {
  const path = "src/a.go";
  const rows = [
    // Quoted: a literal, also one written like a member access.
    j("\t", kw("token"), ' = "', fill(24), '"'),
    j("\t", kw("token"), ' = "session.cache.value"'),
    j("\t", kw("token"), " = 'session.cache.value'"),
    j("\t", kw("token"), ' = "derive_session_key(seed)"'),
    j("\t", kw("token"), " = 'SessionTokenStore::open'"),
    j('\t"', kw("secret"), '": "', fill(16), '",'),
    // Unquoted, with no dot, no parenthesis and no `::`.
    j(kw("TOKEN"), "=", fill(16)),
    j("\t", kw("token"), " = some_identifier_x"),
    // A member access that goes on with more of a value.
    ...["-", "+", "/", "=", "~", '"', "'", "`"].map((c) => j("\t", kw("token"), " = alpha.bravo.charlie", c, "Zq7")),
    j("\t", kw("token"), " = alpha.bravo.charlie.9zz"),
    // A number first is no name.
    j("\t", kw("token"), " = 9lpha.bravo.charlie"),
  ];
  each(rows, (line, row) => assert.equal(shaped("kv_secret", line, path), true, row));
  // The unquoted value with no dot in the files where values are unquoted by habit.
  for (const p of [".env", "ci/run.sh", "ci/x.yml"]) assert.equal(shaped("kv_secret", rows[4], p), true, p);
});

test("narrowing, an expression as a value, still a hit: a line with an expression and a literal, the second also inside the first", () => {
  const path = "src/a.js";
  // One pair is an expression, the next one a literal.
  assert.equal(shaped("kv_secret", j("  go({ ", kw("password"), ": config.session.", kw("token"), ", ", kw("token"), ': "', fill(18), '" })'), path), true);
  // The literal's pair starts inside the expression's.
  assert.equal(shaped("kv_secret", j("  ", kw("password"), " = config.session.", kw("token"), ': "', fill(18), '"'), path), true);
});

// ── the placeholder of a demonstration's seed data ──

const SEED = "internal/store/seed/demo.json";
const PLACE = j("demo-place", "holder:");
const seedLine = (value, quote = '"') => j('      "csrf_', kw("secret"), '": ', quote, value, quote, ",");

test("narrowing, the seed placeholder, not a hit: the seed placeholder as a whole quoted value, in a .json file of a seed directory", () => {
  for (const path of [SEED, "seed/a.json", "x/seed/y.json"]) assert.equal(shaped("kv_secret", seedLine(j(PLACE, "csrf")), path), false, path);
  assert.equal(shaped("kv_secret", seedLine(j(PLACE, "a".repeat(24))), SEED), false, "a word of 24 letters");
});

test("narrowing, the seed placeholder, still a hit: the same value in any other file", () => {
  const paths = [undefined, "internal/store/demo.json", "seed/demo.yaml", "seed/sub/demo.json", "docs/seed.json", "xseed/demo.json", "seed/demo.json.txt", "internal/store/seed/demo.jsonl", "seed.json"];
  for (const path of paths) {
    assert.equal(shaped("kv_secret", seedLine(j(PLACE, "csrf")), path), true, String(path));
    // And the prefix before a value of the length of a secret.
    assert.equal(shaped("kv_secret", seedLine(j(PLACE, fill(32))), path), true, String(path));
  }
});

test("narrowing, the seed placeholder, still a hit: any other value in the seed file, the prefix with more than a short word after it included", () => {
  const rows = [
    seedLine(fill(24)),
    seedLine(j(PLACE, fill(32))),
    seedLine(j(PLACE, "a".repeat(25))),
    seedLine(j(PLACE, "CSRF")),
    seedLine(j(PLACE, "csrf2")),
    seedLine(j(PLACE, "csrf-", fill(12))),
    seedLine(j(PLACE, "csrf ", fill(20))),
    seedLine(PLACE),
    seedLine(j("x-", PLACE, "csrf")),
    seedLine(j(PLACE, "csrf"), "'"),
    seedLine(j(PLACE, "csrf"), ""),
    // The quote that closes the value, with another one or none before it.
    j('      "csrf_', kw("secret"), "\": '", PLACE, 'csrf",'),
    j('      "csrf_', kw("secret"), '": ', PLACE, 'csrf",'),
  ];
  each(rows, (line, row) => assert.equal(shaped("kv_secret", line, SEED), true, row));
});

// ── a field of a structure and its type ──

const GO = "internal/config/config.go";
const field = (rest) => j("\t", kw("Password"), rest);
const TYPE_NAMES = [" string", j(' string `json:"', kw("password"), '"`'), "   SecretRef", " secrets.Value", " string\r", ' string `yaml:"x"`  ', j(" ", "A".repeat(19))];
const TYPE_FORMS = [" []byte", " *string", ' []byte `json:"x"`'];

test("narrowing, a field and its type, not a hit: in a code file, a field whose type is a name, alone or behind a package's name, with a tag or without", () => {
  each(TYPE_NAMES, (rest, row) => assert.equal(shaped("netrc_password", field(rest), GO), false, row));
  for (const ext of CODE_EXTENSIONS) assert.equal(shaped("netrc_password", field(" string"), `src/a.${ext}`), false, ext);
});

test("narrowing, a field and its type, not a hit: in a code file, a field whose type is a slice of bytes or a pointer to a string", () => {
  each(TYPE_FORMS, (rest, row) => assert.equal(shaped("netrc_password", field(rest), GO), false, row));
});

test("narrowing, a field and its type, still a hit: the same fields in a file that is not code, and with no file", () => {
  for (const path of [undefined, ".netrc", "notes/code.txt", "docs/a.md", "ci/x.yml", "src/a.go.txt"]) {
    each([...TYPE_NAMES, ...TYPE_FORMS], (rest, row) => assert.equal(shaped("netrc_password", field(rest), path), true, `${String(path)} ${row}`));
  }
});

test("narrowing, a field and its type, still a hit: a line of a credentials file, in any file; a value that is no type; a literal", () => {
  const netrc = j("machine example.invalid login someone ", kw("password"), " ");
  for (const path of [undefined, ".netrc", GO, "src/a.ts"]) {
    assert.equal(shaped("netrc_password", j(netrc, fill(10)), path), true, String(path));
    // Behind a machine or a login the line is no field, whatever stands where the value does.
    assert.equal(shaped("netrc_password", j(netrc, "string"), path), true, String(path));
    assert.equal(shaped("netrc_password", j("login someone ", kw("password"), " string"), path), true, String(path));
    assert.equal(shaped("netrc_password", j("machine example.invalid login someone ", kw("Password"), " string"), path), true, String(path));
    assert.equal(shaped("netrc_password", j("login someone ", kw("Password"), " string"), path), true, String(path));
  }
  const rows = [
    // A name with a long run in it has the shape of a value.
    field(j(" ", fill(20))),
    field(j(" ", "A".repeat(20))),
    field(j(" secrets.", fill(20))),
    // Not a name: other characters, two dots, another form, more after the type or the tag.
    field(" some-thing"), field(" alpha.b.c"), field(" **string"), field(" []string"), field(" 9string"), field(" string,"),
    field(" string extra"), field(" string `tag` extra"), field(' "literal"'), field(" string `tag"),
  ];
  each(rows, (line, row) => assert.equal(shaped("netrc_password", line, GO), true, row));
  // The key word of a credentials file is written in lower case: alone on its line it is that
  // word and its value, whatever the value looks like. So is the word in capitals.
  for (const line of [j(kw("password"), " string"), j("    ", kw("password"), " String"), j("\t", kw("password"), " hunter2abc"), j("\t", kw("PASSWORD"), " string"), j("\t", kw("PassWord"), " string")]) {
    for (const path of [GO, "src/a.rs", "src/a.ts"]) assert.equal(shaped("netrc_password", line, path), true, `${path}: a line of ${line.trim().length} characters`);
  }
  // A literal after a colon is another shape's, in a code file too.
  assert.equal(shaped("kv_secret", j("\t", kw("Password"), ': "', fill(16), '",'), GO), true);
});

// ── a signing tool's secret key, not the name of its format ──

// The key as the tool writes it: three marks of two bytes (the second says how the key is
// kept), then a salt, two limits, a key id, the key and a checksum: 158 bytes.
const signingKey = (kept) => Buffer.concat([Buffer.from("Ed"), kept, Buffer.from("B2"), Buffer.alloc(32 + 8 + 8 + 8 + 64 + 32, 7)]).toString("base64");
const KEY_ENCRYPTED = signingKey(Buffer.from("Sc"));
const KEY_PLAIN = signingKey(Buffer.alloc(2));
// A public key (two marks, a key id, the key: 42 bytes) and a signature (74 bytes).
const KEY_PUBLIC = Buffer.concat([Buffer.from("Ed"), Buffer.alloc(8 + 32, 7)]).toString("base64");
const SIGNATURE = Buffer.concat([Buffer.from("Ed"), Buffer.alloc(8 + 64, 7)]).toString("base64");
const FORMAT = j("mini", "sign sec", "ret key");
const KEY_HEADER = j("untrusted comment: mini", "sign encrypted sec", "ret key");
const KEY_HEADER_PLAIN = j("untrusted comment: ", FORMAT);
const NAMES_THE_FORMAT = [
  j("the ", FORMAT, " file"),
  j("// File is the key as an unencrypted ", FORMAT, " file (what"),
  j('\t\treturn nil, fmt.Errorf("the key is not a ', FORMAT, ' file")'),
  j('\treturn []byte("', KEY_HEADER_PLAIN, ' " + id + "\\n" +'),
  j("/// The byte layout of a ", FORMAT, ": marks 2, salt 32,"),
  j("//\t    stdin: an empty line, then the unencrypted ", FORMAT),
  j('  "untrusted comment: signature from ', FORMAT, '"'),
  j("Mini", "sign Encrypted Sec", "ret Key"),
  j("# ", KEY_HEADER),
  // A literal that builds the header and ends at its line break: the key comes from elsewhere.
  j('\treturn "', KEY_HEADER_PLAIN, '\\n" + encode(raw) + "\\n"'),
  j("\tconst head = '", KEY_HEADER, "\\n';"),
  j("\tconst head = `", KEY_HEADER, "\\n` + body;"),
  j('\tw.WriteString("', KEY_HEADER, '\\n")'),
  // A literal that goes on after the line break with a place for a value.
  j('\treturn fmt.Sprintf("', KEY_HEADER_PLAIN, '\\n%s\\n", body)'),
  j('    format!("', KEY_HEADER, '\\n{}\\n", body)'),
  j("  const file = `", KEY_HEADER, "\\n${body}\\n`;"),
  j('  printf "', KEY_HEADER, '\\n$BODY\\n"'),
];

test("narrowing, a signing key: the test keys have the tool's lengths and first characters", () => {
  for (const key of [KEY_ENCRYPTED, KEY_PLAIN]) assert.deepEqual([key.length, key.endsWith("="), key.endsWith("==")], [212, true, false]);
  assert.equal(KEY_ENCRYPTED.slice(0, 8), Buffer.from("EdScB2").toString("base64"));
  assert.equal(KEY_PLAIN.slice(0, 8), Buffer.from("Ed\0\0B2").toString("base64"));
  assert.deepEqual([KEY_PUBLIC.length, KEY_PUBLIC.slice(0, 2), SIGNATURE.length], [56, "RW", 100]);
});

test("narrowing, a signing key, not a hit: prose, a comment, an error text and a format string that name the format", () => {
  each(NAMES_THE_FORMAT, (line, row) => {
    for (const path of [undefined, "internal/release/minisign.go", "docs/a.md"]) assert.equal(shaped("minisign_secret", line, path), false, `${String(path)} ${row}`);
  });
});

test("narrowing, a signing key, still a hit: the first line of a key file, and a one-line literal that holds a key", () => {
  const rows = [
    KEY_HEADER, KEY_HEADER_PLAIN, j("  ", KEY_HEADER, "\r"), j(KEY_HEADER_PLAIN, " 1A2B3C4D5E6F7A8B"), j(KEY_HEADER, "\t(kept offline)\r"), KEY_HEADER.toUpperCase(),
    j("KEY=$'", KEY_HEADER, "\\n", KEY_ENCRYPTED, "'"),
    j("KEY=$'", KEY_HEADER_PLAIN, "\\n", KEY_PLAIN, "'"),
    // A key file on one line whose body is cut short or made up: the header, its line break and more.
    j("KEY=$'", KEY_HEADER, "\\n", KEY_ENCRYPTED.slice(0, 6), "_not_a_real_key'"),
    j('  key: "', KEY_HEADER_PLAIN, '\\nx"'),
  ];
  each(rows, (line, row) => {
    for (const path of [undefined, "ci/release.sh", "src/a.go"]) assert.equal(shaped("minisign_secret", line, path), true, `${String(path)} ${row}`);
  });
});

test("narrowing, a signing key, a hit it adds: the body of a secret key at its length, encrypted or not, alone or inside a literal", () => {
  for (const key of [KEY_ENCRYPTED, KEY_PLAIN]) {
    const rows = [key, j("  ", key, "\r"), j('  "sk": "', key, '",'), j("KEY=$'untrusted comment: a key of mine\\n", key, "'"), j("key:", key), j("x", key, "'")];
    each(rows, (line, row) => assert.equal(shaped("minisign_secret", line), true, row));
  }
});

test("narrowing, a signing key, never a hit: a public key, a signature, and a body of another length or another beginning", () => {
  const rows = [
    KEY_PUBLIC, j("untrusted comment: minisign public key 1A2B3C4D5E6F7A8B"), SIGNATURE,
    // One character short and one long; a second `=`; more base64 after it.
    j(KEY_ENCRYPTED.slice(0, -2), "="), j(KEY_ENCRYPTED.slice(0, -1), "A="), j(KEY_ENCRYPTED, "="), j(KEY_PLAIN, "A"), j(KEY_PLAIN, "/"),
    // The marks of another kind of key.
    j("RWRTY0Iz", KEY_ENCRYPTED.slice(8)), j("RWQAAEIz", KEY_PLAIN.slice(8)), j("RW", "A".repeat(209), "="),
  ];
  each(rows, (line, row) => assert.equal(shaped("minisign_secret", line), false, row));
});

// ── the placeholder words where a URL's pass phrase stands ──

const PASS = j("pa", "ss");
const PASSWORD = j("pass", "word");
const dsn = (user, phrase, rest = "host:5432/app?sslmode=disable") => j("postgres:", "//", user, ":", phrase, "@", rest);

test("narrowing, a placeholder pass phrase, not a hit: the placeholder words as the whole pass phrase of a URL", () => {
  const rows = [dsn("app", PASS), dsn("app", PASSWORD), j("//\t", dsn("app", PASS), "  (or postgresql://)"), j("APP_DATABASE_URL='", dsn("app", PASSWORD), "' go test ./...")];
  each(rows, (line, row) => {
    for (const path of [undefined, ".env.example", "README.md", "internal/store/store.go"]) assert.equal(shaped("url_userinfo", line, path), false, `${String(path)} ${row}`);
  });
});

test("narrowing, a placeholder pass phrase, not a hit: the placeholder words in capitals or with a capital", () => {
  const rows = [dsn("USER", PASSWORD.toUpperCase()), dsn("USER", PASS.toUpperCase()), dsn("user", j("Pa", "ss")), dsn("user", j("Pass", "word"))];
  each(rows, (line, row) => assert.equal(shaped("url_userinfo", line), false, row));
});

test("narrowing, a placeholder pass phrase, still a hit: any other pass phrase, the user's own name as the phrase included", () => {
  const rows = [
    dsn("USER", j("Hunter", "2x")), dsn("appdb", "appdb"), dsn("u", j(PASS, "w")), dsn("u", j(PASSWORD, "s")), dsn("u", j(PASS, "1")), dsn("u", j("my", PASS)),
    dsn("u", j(PASS, "-", PASSWORD)), dsn("u", j(PASS, ":x")), dsn(PASS, j("wo", "rd1")), dsn(PASSWORD, j("wo", "rd1")),
    // One URL with a placeholder and one with a phrase.
    j(dsn("a", PASSWORD), " ", dsn("b", j("Hunter", "2x"))),
  ];
  each(rows, (line, row) => {
    for (const path of [undefined, ".forgejo/workflows/ci.yml", "README.md"]) assert.equal(shaped("url_userinfo", line, path), true, `${String(path)} ${row}`);
  });
});

// ── short ids: an identifier in code, the path data of a drawing, the control sets of Unicode ──

// Tokens of the shape of a short id, put together so that no line of this file holds one.
const ip4 = j("V", "4");
const ip6 = j("V", "6");
const cardA = j("A", "1");
const cardB = j("B", "2");
const cardC = j("C", "1");
const lineTo = j("L", "9");
const RS = "crates/sidecar/tests/forms.rs";
const VALUES_IN_CODE = [
  j("    match bind_listener(", ip6, ", names, hook).await {"),
  j("    if !got.is_empty() && got.iter().all(|ip| *ip == ", ip4, ") {"),
  j('            opens: Some((&["::1/128"], ', ip6, ")),"),
  j("            (Some((_, ", ip6, ")), Some(s)) => s,"),
  j("    let want = if to == ", ip6, " { (0, 1) } else { (1, 0) };"),
  j("    rows.push((vec![local, ", ip4, '], allow, "first", ', ip4, ", true));"),
  j("    for (first, why, ip) in [(", ip4, ', "first", "127.0.0.1".parse()), (', ip6, ', "second", "::1".parse())] {'),
  j("    let addr = SocketAddr::new(", ip6, ", port);"),
  j("    let (want, other) = if rows[0] == ", ip6, " {"),
];
const tracked = (line, path) => classed("tracker", line, path);

test("narrowing, short ids, not a hit: in a code file, a token that stands as a value in a line of code", () => {
  each(VALUES_IN_CODE, (line, row) => assert.equal(tracked(line, RS), false, row));
  for (const ext of CODE_EXTENSIONS) assert.equal(tracked(VALUES_IN_CODE[0], `src/a.${ext}`), false, ext);
  // Where `#` starts no comment, what follows it is code like the rest of the line.
  assert.equal(tracked(j("    bind(x)  # (", ip4, ")"), RS), false);
});

test("narrowing, short ids, still a hit: the same lines in a file that is not code, and with no file", () => {
  for (const path of [undefined, "notes/code.txt", "docs/a.md", "ci/x.yml", "src/a.rs.txt"]) each(VALUES_IN_CODE, (line, row) => assert.equal(tracked(line, path), true, `${String(path)} ${row}`));
});

test("narrowing, short ids, still a hit: in a code file, a token in a comment or in a string literal, where a value could stand too", () => {
  const rows = [
    [RS, j("    // ", cardC, " (", cardA, " condition 4)")],
    [RS, j("    bind(x); // done in (", cardB, ")")],
    [RS, j("    /* (", cardC, ") */ bind(x);")],
    [RS, j("    bind(x); /* (", cardC, "), see below")],
    [RS, j("     * see (", cardC, "), bind(x)")],
    [RS, j('    fail("(', cardB, ')", a == b);')],
    [RS, j('    return Err(format!("violates ', cardB, ' here", a == b));')],
    [RS, j('    fail("a \\" quote (', cardB, ')", a == b);')],
    ["src/a.js", j("    fail('(", cardB, ")', a == b);")],
    ["src/a.js", j("    fail(`(", cardB, ")`, a == b);")],
    // A literal the line does not close runs to its end.
    [RS, j('    let s = "starts here (', cardB, "), bind(x)")],
    ["src/a.js", j("    const s = `starts here (", cardB, "), bind(x)")],
    // A `#` comment, in the languages that have one.
    ["tools/x.py", j("    bind(x)  # (", cardB, ")")],
    ["tools/x.rb", j("    bind(x)  # (", cardB, ")")],
    ["tools/x.php", j("    bind(x);  # (", cardB, ")")],
  ];
  each(rows, ([path, line], row) => assert.equal(tracked(line, path), true, row));
});

test("narrowing, short ids, still a hit: in a code file, a token in a line that shows no call and no operator", () => {
  const rows = [
    j("    (", cardC, "), then"), j("  card ", cardA, " is done"), j("    ", ip4, ","), j("    (see ", cardA, ", ", cardC, ")"),
    // What is no call and no operator of two characters.
    ...["(a, b)", "a = b", "a + b", "{ a }", "a[1]", "a < b", "a: b", "a;", "a | b", "a & b", "a ! b", "9(a)"].map((code) => j("    ", code, ", ", ip4, ")")),
    // A call or an operator inside a comment or a literal is none.
    j('    "bind(x)", ', ip4, ")"), j("    /* a == b */ x, ", ip4, ")"),
  ];
  each(rows, (line, row) => assert.equal(tracked(line, RS), true, row));
});

test("narrowing, short ids, not a hit: in a code file, each kind of call and each operator of two characters makes a line code", () => {
  for (const code of ["go(1)", "mac!(1)", "vec![1]", "a == b", "a != b", "a => b", "a -> b", "a::b", "a && b", "a || b"]) {
    assert.equal(tracked(j("    ", code, ", ", ip4, ")"), RS), false, code);
  }
});

test("narrowing, short ids, not a hit: in a code file, a token after each opening bracket, comma or operator, and before each closing one", () => {
  for (const before of ["(", "[", ",", "=", "&", "|"]) assert.equal(tracked(j("    go(1) ", before, " ", ip4, " ;"), RS), false, `before: ${before}`);
  for (const after of [")", "]", ",", ";", "{", "}", "=", "&", "|", ""]) assert.equal(tracked(j("    go(1) == ", ip4, " ", after).trimEnd(), RS), false, `after: ${after}`);
});

test("narrowing, short ids, still a hit: in a code file, a token between words, or next to anything that is no bracket, comma or operator", () => {
  const rows = [
    ["src/a.tsx", j("    <b onClick={() => go()}>card ", cardA, " done</b>")],
    [RS, j("    bind(x) then ", cardB, ", next")],
    [RS, j("    bind(x), ", cardB, " next")],
    [RS, j("    go(1); return ", ip4, ";")],
    [RS, j("    ", ip4, ", go(1)")],
  ];
  each(rows, ([path, line], row) => assert.equal(tracked(line, path), true, row));
  // What may not stand before a value, and what may not stand after it.
  for (const before of [":", "!", "{", "}", ">", "<", "+", "-", "*", "/", "?", ";", ")", "]", "word", '"x"']) assert.equal(tracked(j("    go(1) ", before, " ", ip4, " ;"), RS), true, `before: ${before}`);
  for (const after of [">", "<", "+", "-", "*", "/", "?", ":", "(", "[", "!", "word", '"x"']) assert.equal(tracked(j("    go(1) == ", ip4, " ", after), RS), true, `after: ${after}`);
});

const PATH_LINE = j('      <path d="M10.4 11.4 ', lineTo, ' 19.5 H15 L13.6 11.4 Z" fill={c} />');

test("narrowing, short ids, not a hit: the path data of a drawing, in any file", () => {
  for (const path of [undefined, "web/public/favicon.svg", "web/src/icon.tsx", "docs/a.md"]) {
    assert.equal(tracked(PATH_LINE, path), false, String(path));
    assert.equal(tracked(j("<path d='M1 2 ", lineTo, " 3' />"), path), false, String(path));
    assert.equal(tracked(j('<svg><rect rx="5"/><path d="M1 2 ', lineTo, ' 3"/><path d="M4 5 ', lineTo, ' 6"/></svg>'), path), false, String(path));
  }
});

test("narrowing, short ids, still a hit: a token in a drawing that is not in its path data, and words where path data would be", () => {
  const rows = [
    j('<path d="card ', cardA, ' is done" />'),
    j('<path d="M1 2 ', lineTo, ' 3" /> see ', cardB),
    j("see ", cardB, ' <path d="M1 2 ', lineTo, ' 3" />'),
    j('<path data-d="M1 2 ', lineTo, ' 3" />'),
    j('<path id="M1 2 ', lineTo, ' 3" />'),
    j('<path d="M1 2 ', lineTo, " 3"),
    j('<path d="M1 2 ', lineTo, " 3' />"),
    j("<text> ", lineTo, " 19.5 </text>"),
    j("<!-- card ", cardA, " -->"),
    j("<title>card ", cardA, " </title>"),
  ];
  for (const path of [undefined, "web/public/favicon.svg", "docs/a.md"]) each(rows, (line, row) => assert.equal(tracked(line, path), true, `${String(path)} ${row}`));
});

const controlLow = j("C", "0");
const CONTROL_LINE = j("// strips ", controlLow, ", DEL and the ", cardC, " range U+0080–U+009F).");

test("narrowing, short ids, not a hit: the names of the two control sets of Unicode on a line that writes a code point", () => {
  for (const path of [undefined, "internal/store/tooldef.go", "docs/a.md"]) {
    assert.equal(tracked(CONTROL_LINE, path), false, String(path));
    assert.equal(tracked(j("the ", cardC, " set ends at U+009f"), path), false, String(path));
    assert.equal(tracked(j(controlLow, " is far below U+10FFFF"), path), false, String(path));
    assert.equal(tracked(j(controlLow, " is far below U+1F600"), path), false, String(path));
  }
});

test("narrowing, short ids, still a hit: those names with no code point on the line, and any other token on a line with one", () => {
  const rows = [
    j("card ", cardC, " is done"), j("the ", cardC, " range of control characters"), j(controlLow, " controls"),
    j("see ", j("C", "2"), " and U+0080"), j(j("E", "2"), " control U+0041"), j(cardC, " and ", cardB, " at U+0080"),
    // Not a code point: too few digits, no hex digits, no `U+`.
    j(cardC, " at U+00"), j(cardC, " at U+ZZZZ"), j(cardC, " at 0080"), j(cardC, " at XU+0080"), j(cardC, " at U+0080ZZ"), j(cardC, " at U+0080000"),
  ];
  for (const path of [undefined, "internal/store/tooldef.go", "docs/a.md"]) each(rows, (line, row) => assert.equal(tracked(line, path), true, `${String(path)} ${row}`));
});

test("narrowing, short ids, still a hit: the long forms of a reference, in every kind of file and where a value stands", () => {
  const rows = [
    j("    go(1) == check(vbcdx#", "7);"), j("    go(1) == c1", "23456;"), j("    go(E9", ".3) == 1;"), j('<path d="M1 core#', '12" />'), j("    go(1) == check(§", "7)"),
  ];
  for (const path of [undefined, RS, "src/a.go", "web/public/favicon.svg", "docs/a.md"]) each(rows, (line, row) => assert.equal(tracked(line, path), true, `${String(path)} ${row}`));
});

// ── the private block of the standard, in documentation ──

const BLOCK = j("192.168", ".0.0/16");
const BLOCK_LINES = [
  j("loopback or private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `", BLOCK, "`,"),
  j("The block ", BLOCK, "."), BLOCK, j("(", BLOCK, ")"), j(BLOCK, " and ", BLOCK),
];
const lan = (line, path) => classed("lan-ip", line, path);

test("narrowing, lan-ip, not a hit: the standard private block, written whole, in a .md file", () => {
  for (const path of ["docs/webhooks.md", "README.md"]) each(BLOCK_LINES, (line, row) => assert.equal(lan(line, path), false, `${path} ${row}`));
});

test("narrowing, lan-ip: the other two standard private blocks were never a hit, in any file", () => {
  for (const path of [undefined, "docs/a.md", "src/net.go"]) for (const block of ["10.0.0.0/8", "172.16.0.0/12"]) assert.equal(lan(block, path), false, `${String(path)} ${block}`);
});

test("narrowing, lan-ip, still a hit: the block in any other file, and any address or other block in a .md file", () => {
  for (const path of [undefined, "docs/a.txt", "src/net.go", "ci/x.yml", "docs/a.MD", "docs/a.mdx", "docs/md", "docs/a.md.txt"]) {
    each(BLOCK_LINES, (line, row) => assert.equal(lan(line, path), true, `${String(path)} ${row}`));
  }
  const rows = [
    j("192.168", ".40.0/24"), j("10.20", ".20.60"), j("192.168", ".0.33"), j("192.168", ".0.0/24"), j("192.168", ".0.0"), j("192.168", ".0.0/1"),
    j(BLOCK, "0"), j("1", BLOCK), j("0.", BLOCK), j("192.168", ".0.0 /16"), j("192.168", ".25.0/16"),
    // The block and an address on one line.
    j(BLOCK, " and ", "192.168", ".0.33"), j("192.168", ".40.7 inside ", BLOCK),
  ];
  each(rows, (line, row) => assert.equal(lan(line, "docs/a.md"), true, row));
});

// ── an option that takes a public key ──

const flagged = (line) => classesOf(line).includes("secret-flag");

test("narrowing, secret-flag, not a hit: an option whose name has the word public in it, in each way an option is declared", () => {
  const rows = [
    j('        ["sign", "--public-', 'key", key, files @ ..] if !files.is_empty() => {'),
    j('\tif len(args) < 3 || args[0] != "--public-', 'key" {'),
    j("'--public-", "key'"), j('"--release-public-', 'key"'), j('"--public-signing-', 'key"'),
  ];
  each(rows, (line, row) => assert.equal(flagged(line), false, row));
});

test("narrowing, secret-flag, not a hit: such an option declared with long = or long(...)", () => {
  each([j('#[arg(long = "public-', 'key")]'), j('.long("public-', 'key")'), j('#[arg(long = "release-public-', 'key")]')], (line, row) => assert.equal(flagged(line), false, row));
});

test("narrowing, secret-flag, not a hit: such an option declared with flag.String or flag.StringVar", () => {
  each([j('flag.String("public-', 'key", "", "the public key")'), j('flag.StringVar(&cfg.Pub, "public-', 'key", "", "")')], (line, row) => assert.equal(flagged(line), false, row));
});

test("narrowing, secret-flag, still a hit: every other option that takes a secret, and public as part of a longer word", () => {
  const rows = [
    j('"--', 'key"'), j('"--secret-', 'key"'), j('"--private-', 'key"'), j('"--', 'password"'), j('"--republic-', 'key"'), j('"--publicly-', 'key"'), j('"--publickey-', 'secret"'),
    j('#[arg(long = "secret-', 'key")]'), j('.long("private-', 'key")'), j('#[arg(long = "republic-', 'key")]'),
    j('flag.String("private-', 'key", "", "")'), j('flag.StringVar(&cfg.Key, "secret-', 'key", "", "")'), j('flag.String("republic-', 'key", "", "")'),
    // Both kinds on one line.
    j('["--public-', 'key", "--secret-', 'key"]'),
  ];
  each(rows, (line, row) => assert.equal(flagged(line), true, row));
});

// ── the scan gives each line its file ──

const NARROWED_FILES = {
  "internal/config/config.go": [EXPRESSIONS[0][1], field(" string"), field(TYPE_NAMES[1]), field(" []byte"), VALUES_IN_CODE[0], CONTROL_LINE, NAMES_THE_FORMAT[1], j("//\t", dsn("app", PASS))].join("\n"),
  [SEED]: `{\n${seedLine(j(PLACE, "csrf"))}\n}\n`,
  "docs/webhooks.md": `${BLOCK_LINES[0]}\n`,
  "web/public/favicon.svg": `${PATH_LINE}\n`,
  "xtask/src/main.rs": `${j('        ["sign", "--public-', 'key", key] => {')}\n`,
};

test("narrowing, the scan: each rule reads a line by the file it is in: the narrowed lines pass where they belong", () => {
  const r = cli(repo({ ...CLEAN, ...NARROWED_FILES }), "--tree-only");
  assert.deepEqual(hitLines(r.out), [], r.all);
  assert.equal(r.rc, 0, r.all);
});

test("narrowing, the scan: the same lines in files of another kind and in a commit message are hits, and so is what no narrowing covers", () => {
  const dir = repo({
    ...CLEAN,
    // The lines of a code file, in a settings file and in a text file.
    "conf/app.env": `${EXPRESSIONS[0][1]}\n${field(" string")}\n`,
    "notes/code.txt": `${VALUES_IN_CODE[0]}\n${EXPRESSIONS[2][1]}\n`,
    // The seed value outside a seed directory, the block outside a page of documentation.
    "internal/store/demo.json": `{\n${seedLine(j(PLACE, "csrf"))}\n}\n`,
    "docs/webhooks.txt": `${BLOCK_LINES[0]}\n`,
    // And lines no narrowing takes out of the file they belong in.
    "internal/config/config.go": [j("\t", kw("token"), ' = "', fill(24), '"'), j("    // ", cardC, " (", cardA, " condition 4)"), field(j(" ", fill(20))), j("//\t", dsn("app", j("Hunter", "2x")))].join("\n"),
    [SEED]: `{\n${seedLine(fill(24))}\n}\n`,
    "docs/webhooks.md": `${j("192.168", ".40.0/24")}\n`,
    "web/public/favicon.svg": `${j("<title>card ", cardA, " </title>")}\n`,
    "xtask/src/main.rs": `${j('        ["sign", "--secret-', 'key", key] => {')}\n`,
  });
  git(dir, "checkout", "-q", "-b", "topic");
  commit(dir, { "src/b.js": "export const b = 2;\n" }, `feat: b\n\n${EXPRESSIONS[0][1].trim()}\n${VALUES_IN_CODE[0].trim()}`);
  const r = cli(dir, "--base", "main");
  assert.equal(r.rc, 1, r.all);
  assert.deepEqual(hitLines(r.out).map((l) => l.replace(/^commit [0-9a-f]{12}/, "commit")).sort(), [
    "commit:3 [secret-shape]", "commit:4 [tracker]",
    "conf/app.env:1 [secret-shape]", "conf/app.env:2 [secret-shape]",
    "docs/webhooks.md:1 [lan-ip]", "docs/webhooks.txt:1 [lan-ip]",
    "internal/config/config.go:1 [secret-shape]", "internal/config/config.go:2 [tracker]", "internal/config/config.go:3 [secret-shape]", "internal/config/config.go:4 [secret-shape]",
    "internal/store/demo.json:2 [secret-shape]", `${SEED}:2 [secret-shape]`,
    "notes/code.txt:1 [tracker]", "notes/code.txt:2 [secret-shape]",
    "web/public/favicon.svg:1 [tracker]", "xtask/src/main.rs:1 [secret-flag]",
  ].sort());
});

// ── a denied name put together from pieces ──────────────────────────────────────────────

// A sample of a class, cut in two at its middle: the pieces a file would hold.
const cut = (text) => [text.slice(0, Math.ceil(text.length / 2)), text.slice(Math.ceil(text.length / 2))];
const NAME = sampleOf("vocabulary", 2);
const [HEAD_PIECE, TAIL_PIECE] = cut(NAME);
const Q = (text) => JSON.stringify(text);
// Every way a line joins the two pieces itself.
const JOINS = [
  ["a list joined with an empty string", `new RegExp([${Q(HEAD_PIECE)}, ${Q(TAIL_PIECE)}].join(""), "i")`],
  ["a list joined with an empty string in single quotes", `const n = ['${HEAD_PIECE}', '${TAIL_PIECE}'].join('');`],
  ["a list joined with an empty template", "const n = [`" + HEAD_PIECE + "`, `" + TAIL_PIECE + "`].join(``);"],
  ["a list with spaces, joined", `const n = [ ${Q(HEAD_PIECE)} ,  ${Q(TAIL_PIECE)} ].join( "" );`],
  ["a list concatenated", `let n = [${Q(HEAD_PIECE)}, ${Q(TAIL_PIECE)}].concat();`],
  ["an empty string joining a list", `n = "".join([${Q(HEAD_PIECE)}, ${Q(TAIL_PIECE)}])`],
  ["an empty string joining a tuple", `n = ''.join(('${HEAD_PIECE}', '${TAIL_PIECE}'))`],
  ["a concat macro", `let n = concat!(${Q(HEAD_PIECE)}, ${Q(TAIL_PIECE)});`],
  ["a join call with an empty separator", `n := strings.Join([]string{${Q(HEAD_PIECE)}, ${Q(TAIL_PIECE)}}, "")`],
  ["two strings and a plus", `const n = ${Q(HEAD_PIECE)} + ${Q(TAIL_PIECE)};`],
  ["three strings and two pluses", `const n = ${Q(HEAD_PIECE.slice(0, 1))} + ${Q(HEAD_PIECE.slice(1))} + '${TAIL_PIECE}';`],
  ["a list inside another list, the inner one joined", `const all = ["one", "two", [${Q(HEAD_PIECE)}, ${Q(TAIL_PIECE)}].join("")].join("|");`],
  ["three pieces in a joined list", `[${Q(HEAD_PIECE.slice(0, 1))}, ${Q(HEAD_PIECE.slice(1))}, ${Q(TAIL_PIECE)}].join("")`],
];
// Strings that stand next to each other and are not joined by the line, and joins that spell no name.
const NOT_JOINED = [
  ["the items of a list", `const parts = [${Q(HEAD_PIECE)}, ${Q(TAIL_PIECE)}];`],
  ["the arguments of a call", `(${Q("x-" + HEAD_PIECE)}, ${Q(TAIL_PIECE + "op")}),`],
  ["a list joined with something between", `[${Q(HEAD_PIECE)}, ${Q(TAIL_PIECE)}].join("-")`],
  ["a list joined with a space", `[${Q(HEAD_PIECE)}, ${Q(TAIL_PIECE)}].join(" ")`],
  ["a list joined with the default comma", `[${Q(HEAD_PIECE)}, ${Q(TAIL_PIECE)}].join()`],
  ["a join call with a separator", `strings.Join([]string{${Q(HEAD_PIECE)}, ${Q(TAIL_PIECE)}}, ", ")`],
  ["a string joining a list", `", ".join([${Q(HEAD_PIECE)}, ${Q(TAIL_PIECE)}])`],
  ["a plus with a variable between", `${Q(HEAD_PIECE)} + sep + ${Q(TAIL_PIECE)}`],
  ["a plus between other pieces", `"one" + "two"`], ["a joined list of other pieces", `["ab", "cd"].join("")`],
  ["a joined list in the other order", `[${Q(TAIL_PIECE)}, ${Q(HEAD_PIECE)}].join("")`],
  ["no string at all", "const n = a + b;"], ["one string", `const n = ${Q(HEAD_PIECE)};`],
];

test("assembled: a line that joins pieces into a denied name is caught, in each form of joining", () => {
  assert.equal(classesOf(NAME).includes("vocabulary"), true);
  for (const piece of [HEAD_PIECE, TAIL_PIECE]) assert.deepEqual(classesOf(piece), [], "a piece alone is no name");
  for (const [what, line] of JOINS) {
    assert.deepEqual(classesOf(line), [], `${what}: the line holds no literal name`);
    assert.equal(assembles(line), true, what);
  }
});

test("assembled: strings the line does not join, and joins that spell no name, are not caught", () => {
  for (const [what, line] of NOT_JOINED) assert.equal(assembles(line), false, what);
  // A name of every class that names something is found when joined; an option or a secret in pieces is not this check's.
  for (const cls of CLASSES) {
    const [head, tail] = cut(cls.samples[0]);
    const line = `x = [${Q(head)}, ${Q(tail)}].join("")`;
    const named = !cls.sourceOnly && cls.id !== "secret-shape" && classesOf(cls.samples[0], [cls], { binary: true }).length > 0;
    if (named && classesOf(line).length === 0) assert.equal(assembles(line), true, cls.id);
    if (!named) assert.equal(assembles(line), false, cls.id);
  }
  // An option that takes a secret, in pieces, is not a name: it is not this check's.
  const option = ["'", '"--api-', "', '", 'key"', "'"].join("");
  assert.equal(classesOf(option.replace("', '", ""), CLASSES).includes("secret-flag"), true, "closed up, it is the option");
  assert.equal(assembles(`x = [${option}].join('')`), false);
  // A line that already holds the name is a hit of that name's class, not of this one.
  assert.equal(assembles(`const n = ${Q(NAME)} + "s";`), false);
});

test("assembled: the scan reports it everywhere but the gate's five shared files, and one line can be allowed", () => {
  const line = JOINS[0][1];
  const files = {
    ...CLEAN, "src/n.js": `${line}\n`, "test/n.test.js": `// clean\n${line}\n`, "docs/n.md": `${NOT_JOINED[0][1]}\n`,
    // In the gate's directory: a new file, a name that only starts like a shared one, and a
    // shared file's name one directory down are read; a shared file itself is not.
    "ci/general-use/notes.mjs": `${line}\n`, "ci/general-use/scan.mjs.orig": `${line}\n`, "ci/general-use/sub/scan.mjs": `${line}\n`,
    "ci/general-use/scan.test.mjs": `${line}\n`,
  };
  const r = cli(repo(files), "--tree-only");
  assert.equal(r.rc, 1, r.all);
  assert.deepEqual(hitLines(r.out).sort(), [
    `ci/general-use/notes.mjs:1 [${ASSEMBLED}]`, `ci/general-use/scan.mjs.orig:1 [${ASSEMBLED}]`, `ci/general-use/sub/scan.mjs:1 [${ASSEMBLED}]`,
    `src/n.js:1 [${ASSEMBLED}]`, `test/n.test.js:2 [${ASSEMBLED}]`,
  ]);
  assert.equal(r.all.includes(HEAD_PIECE + TAIL_PIECE), false);
  const allow = `test/n.test.js\t${ASSEMBLED}\t${lineHash(line)}\tA test that asserts the product refuses this word, put together so the file holds no literal.\n`;
  const allowed = cli(repo(files, { allow }), "--tree-only");
  assert.deepEqual(hitLines(allowed.out).sort(), [
    `ci/general-use/notes.mjs:1 [${ASSEMBLED}]`, `ci/general-use/scan.mjs.orig:1 [${ASSEMBLED}]`, `ci/general-use/sub/scan.mjs:1 [${ASSEMBLED}]`,
    `src/n.js:1 [${ASSEMBLED}]`,
  ]);
  assert.deepEqual(parseAllow(allow).errors, []);
  // A file with a NUL byte is not read for joins: its bytes are scanned for the names themselves.
  const binary = repo({ ...CLEAN, "data.bin": Buffer.concat([Buffer.from([0]), Buffer.from(`${line}\n`)]) });
  assert.equal(cli(binary, "--tree-only").rc, 0);
});

// ── the pinned directory ────────────────────────────────────────────────────────────────

function copyOfDir() {
  const d = join(tmp(), "general-use");
  cpSync(HERE, d, { recursive: true });
  return d;
}

test("the directory is the pinned copy: every shared file listed and unchanged, nothing unlisted", () => {
  assert.deepEqual(checkDir(HERE), []);
  const listed = readFileSync(join(HERE, "SHA256SUMS"), "utf8").trim().split("\n").map((l) => l.split("  ")[1]);
  assert.deepEqual(listed, [...SHARED].sort());
  assert.deepEqual(LOCAL, ["SOURCE", "allow.txt", "first-party.txt"]);
});

test("the directory is refused when a file is missing, changed, unlisted, or a list is pinned", () => {
  const cases = [
    ["a changed scanner", (d) => writeFileSync(join(d, "scan.mjs"), `${readFileSync(join(d, "scan.mjs"), "utf8")}\n`), /^scan\.mjs was changed$/],
    ["a missing test file", (d) => unlinkSync(join(d, "scan.test.mjs")), /^scan\.test\.mjs is listed and missing$/],
    ["an unlisted file", (d) => writeFileSync(join(d, "extra-rules.mjs"), "export {};\n"), /^extra-rules\.mjs is not listed$/],
    ["an unlisted file in a subdirectory", (d) => { mkdirSync(join(d, "more")); writeFileSync(join(d, "more", "x.txt"), "x\n"); }, /^more\/x\.txt is not listed$/],
    ["a shared file dropped from the list", (d) => writeFileSync(join(d, "SHA256SUMS"), readFileSync(join(d, "SHA256SUMS"), "utf8").split("\n").filter((l) => !l.endsWith("  scan.mjs")).join("\n")), /^SHA256SUMS does not list scan\.mjs$/],
    ["no allow.txt", (d) => unlinkSync(join(d, "allow.txt")), /^allow\.txt is missing$/],
    ["no SOURCE", (d) => unlinkSync(join(d, "SOURCE")), /^SOURCE is missing$/],
    ["a malformed list line", (d) => writeFileSync(join(d, "SHA256SUMS"), `${readFileSync(join(d, "SHA256SUMS"), "utf8")}scan.mjs\n`), /^SHA256SUMS has a line/],
    ["a symbolic link for a shared file", (d) => { unlinkSync(join(d, "README.md")); symlinkSync("scan.mjs", join(d, "README.md")); }, /^README\.md is not a regular file$/],
  ];
  for (const [what, change, want] of cases) {
    const d = copyOfDir();
    change(d);
    assert.ok(checkDir(d).some((p) => want.test(p)), `${what}: ${JSON.stringify(checkDir(d))}`);
    const r = spawnSync(process.execPath, [join(HERE, "verify-dir.mjs"), d], { encoding: "utf8", env: ENV });
    assert.equal(r.status, 1, what);
    assert.match(r.stdout, /REFUSED/);
  }
  const gone = spawnSync(process.execPath, [join(HERE, "verify-dir.mjs"), join(copyOfDir(), "nowhere")], { encoding: "utf8", env: ENV });
  assert.equal(gone.status, 2);
});

const COMMIT = `${"0123456789abcdef".repeat(2)}01234567`;
const TAG = "v0.2.14";
const HEAD_OF_SOURCE = `${CANONICAL_REPOSITORY}\n${TAG}\n${COMMIT}\n`;
const sumsOf = (d) => readFileSync(join(d, "SHA256SUMS"), "utf8");
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
/** The directory as another repository carries it: SOURCE names the owning repository, the tag and its commit, and records its list. */
function vendoredCopy() {
  const d = copyOfDir();
  writeFileSync(join(d, "SOURCE"), `${HEAD_OF_SOURCE}\n${sumsOf(d)}`);
  return d;
}
const verifyCli = (d, env = {}) => {
  const r = spawnSync(process.execPath, [join(HERE, "verify-dir.mjs"), d], { encoding: "utf8", env: { ...ENV, ...env } });
  return { rc: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
};

test("the CI variables are one list: the scanner's and the directory check's are the same", () => {
  assert.deepEqual(CI_VARIABLES, SCAN_CI_VARIABLES);
  assert.deepEqual(CI_VARIABLES, ["CI", "GITHUB_ACTIONS", "FORGEJO_ACTIONS", "GITEA_ACTIONS"]);
});

test("the assembled exemption is the pinned set: the scanner's list is verify-dir's SHARED, by full path", () => {
  assert.deepEqual([...ASSEMBLED_EXEMPT].sort(), SHARED.map((name) => `ci/general-use/${name}`).sort());
  assert.equal(Object.isFrozen(ASSEMBLED_EXEMPT), true);
});

const LEGACY_NOTE = `general-use: note: SOURCE names its source by the earlier URL; write its first line as ${CANONICAL_REPOSITORY}\n`;

test("a copy in another repository is bound to its source: the owning repository's name, a tag, its commit, and the recorded list", () => {
  assert.equal(CANONICAL_REPOSITORY, "VBCDX/vbcdx");
  assert.equal(LEGACY_URL, "https://github.com/VBCDX/vbcdx.git");
  const ok = vendoredCopy();
  assert.deepEqual(checkDir(ok), []);
  const okRun = verifyCli(ok);
  assert.equal(okRun.rc, 0, okRun.all);
  assert.equal(okRun.err, "", "the name needs no note");
  assert.deepEqual(parseSource(`${HEAD_OF_SOURCE}\nlist\n`), { canonical: false, origin: CANONICAL_REPOSITORY, tag: TAG, commit: COMMIT, sums: "list\n" });
  assert.deepEqual(parseSource("canonical\n"), { canonical: true });
  for (const tag of ["v0.0.0", "v1.2.3", "v10.20.30", "v1.2.3-rc.1", "v1.2.3-0", "v1.2.3-alpha-1.x"]) {
    const d = copyOfDir();
    writeFileSync(join(d, "SOURCE"), `${CANONICAL_REPOSITORY}\n${tag}\n${COMMIT}\n\n${sumsOf(d)}`);
    assert.deepEqual(checkDir(d), [], tag);
  }

  // A pinned file edited, the lists left alone.
  const edited = vendoredCopy();
  writeFileSync(join(edited, "scan.mjs"), `${readFileSync(join(edited, "scan.mjs"), "utf8")}// more\n`);
  assert.deepEqual(checkDir(edited), ["scan.mjs was changed"]);
  assert.equal(verifyCli(edited).rc, 1);

  // The same edit, with the local list regenerated to match it: the record still names the source's.
  const repinned = vendoredCopy();
  writeFileSync(join(repinned, "scan.mjs"), `${readFileSync(join(repinned, "scan.mjs"), "utf8")}// more\n`);
  writeFileSync(join(repinned, "SHA256SUMS"), sumsOf(repinned).replace(/^[0-9a-f]{64}( {2}scan\.mjs)$/m, `${sha256(join(repinned, "scan.mjs"))}$1`));
  assert.deepEqual(checkDir(repinned), ["SHA256SUMS is not the list SOURCE records for its commit"]);
  assert.equal(verifyCli(repinned).rc, 1);
  assert.match(verifyCli(repinned).out, /REFUSED/);

  // A record that differs from the local list, the files untouched; and a commit with no record.
  const records = [
    (sums) => `${HEAD_OF_SOURCE}\n${sums.replace(/^[0-9a-f]/, (c) => (c === "0" ? "1" : "0"))}`,
    (sums) => `${HEAD_OF_SOURCE}\n${sums.split("\n").slice(1).join("\n")}`,
    (sums) => `${HEAD_OF_SOURCE}\n${sums}\n`,
    () => HEAD_OF_SOURCE,
    () => `${HEAD_OF_SOURCE}\n`,
  ];
  records.forEach((record, i) => {
    const d = copyOfDir();
    writeFileSync(join(d, "SOURCE"), record(sumsOf(d)));
    assert.deepEqual(checkDir(d), ["SHA256SUMS is not the list SOURCE records for its commit"], `record ${i + 1}`);
    assert.equal(verifyCli(d).rc, 1, `record ${i + 1}`);
  });
});

test("a copy that names another source than the owning repository is refused: the match is exact, and the earlier URL passes only exactly, with a note", () => {
  // Other spellings of the name: another case, a slash, a suffix, a space, another owner or
  // repository, a host in front (our own forge's, built from pieces, and another).
  const names = [
    CANONICAL_REPOSITORY.toLowerCase(), CANONICAL_REPOSITORY.toUpperCase(), `${CANONICAL_REPOSITORY}/`, `/${CANONICAL_REPOSITORY}`, `${CANONICAL_REPOSITORY}.git`,
    ` ${CANONICAL_REPOSITORY}`, `${CANONICAL_REPOSITORY} `, `${CANONICAL_REPOSITORY}-core`, "someone/vbcdx", "VBCDX",
    j("https://git.", "tam", "tam.co/", CANONICAL_REPOSITORY, ".git"), `https://github.com/${CANONICAL_REPOSITORY}`,
  ];
  // Other spellings of the earlier URL: each is refused; only the URL itself is read.
  const urls = [
    "https://github.com/someone/vbcdx.git", `${LEGACY_URL}/`, LEGACY_URL.replace(/\.git$/, ""), LEGACY_URL.toLowerCase(), LEGACY_URL.toUpperCase(),
    LEGACY_URL.replace("https:", "http:"), `git+${LEGACY_URL}`, `${LEGACY_URL} `, ` ${LEGACY_URL}`, `${LEGACY_URL}#main`, "git@github.com:VBCDX/vbcdx.git", "canonical",
  ];
  [...names, ...urls].forEach((origin, i) => {
    assert.notEqual(origin, CANONICAL_REPOSITORY, `origin ${i + 1}`);
    assert.notEqual(origin, LEGACY_URL, `origin ${i + 1}`);
    const d = copyOfDir();
    writeFileSync(join(d, "SOURCE"), `${origin}\n${TAG}\n${COMMIT}\n\n${sumsOf(d)}`);
    assert.deepEqual(checkDir(d), [`SOURCE names another source than ${CANONICAL_REPOSITORY}`], `origin ${i + 1}`);
    const r = verifyCli(d);
    assert.equal(r.rc, 1, `origin ${i + 1}`);
    assert.match(r.out, /^general-use: ci\/general-use is REFUSED\n$/);
    // The line read from the file is not printed: only the name this check knows.
    assert.equal(r.err, `general-use: SOURCE names another source than ${CANONICAL_REPOSITORY}\n`);
  });
  // The earlier URL itself, exactly: the pinned copy, with one note, and still bound to its record.
  const legacy = copyOfDir();
  writeFileSync(join(legacy, "SOURCE"), `${LEGACY_URL}\n${TAG}\n${COMMIT}\n\n${sumsOf(legacy)}`);
  assert.deepEqual(checkDir(legacy), []);
  const lr = verifyCli(legacy);
  assert.equal(lr.rc, 0, lr.all);
  assert.equal(lr.out, "general-use: ci/general-use is the pinned copy\n");
  assert.equal(lr.err, LEGACY_NOTE);
  const legacyWrongRecord = copyOfDir();
  writeFileSync(join(legacyWrongRecord, "SOURCE"), `${LEGACY_URL}\n${TAG}\n${COMMIT}\n`);
  assert.deepEqual(checkDir(legacyWrongRecord), ["SHA256SUMS is not the list SOURCE records for its commit"]);
  assert.equal(verifyCli(legacyWrongRecord).rc, 1);
  // Another source and another list: both are said.
  const d = copyOfDir();
  writeFileSync(join(d, "SOURCE"), `https://example.invalid/x.git\n${TAG}\n${COMMIT}\n`);
  assert.deepEqual(checkDir(d), [`SOURCE names another source than ${CANONICAL_REPOSITORY}`, "SHA256SUMS is not the list SOURCE records for its commit"]);
});

test("a commit pin names its own commit: `vX.Y.Z-commit.<40-hex>` passes only with the commit line's id, in full", () => {
  const pinned = (label, commit = COMMIT) => {
    const d = copyOfDir();
    writeFileSync(join(d, "SOURCE"), `${CANONICAL_REPOSITORY}\n${label}\n${commit}\n\n${sumsOf(d)}`);
    return d;
  };
  const ok = pinned(`v0.3.2-commit.${COMMIT}`);
  assert.deepEqual(checkDir(ok), []);
  assert.equal(verifyCli(ok).rc, 0);
  const other = COMMIT.replace(/^./, "f");
  const wrong = [`v0.3.2-commit.${other}`, `v0.3.2-commit.${COMMIT.slice(0, 12)}`, `v0.3.2-commit.${COMMIT}0`, `v0.3.2-commit.${COMMIT}.x`, "v0.3.2-commit.main"];
  for (const label of wrong) {
    const d = pinned(label);
    assert.deepEqual(checkDir(d), ["SOURCE's commit-pin label names another commit than its commit line"], label);
    assert.equal(verifyCli(d).rc, 1, label);
  }
  // The commit line moved, the label did not.
  assert.deepEqual(checkDir(pinned(`v0.3.2-commit.${COMMIT}`, other)), ["SOURCE's commit-pin label names another commit than its commit line"]);
  // A pre-release that is no commit pin is a tag, as before.
  assert.deepEqual(checkDir(pinned("v0.3.2-rc.1")), []);
});

test("a SOURCE that is neither form cannot be checked: exit 2, never the pinned copy", () => {
  const withTag = (tag) => (sums) => `${CANONICAL_REPOSITORY}\n${tag}\n${COMMIT}\n\n${sums}`;
  const malformed = [
    "latest\n", "canonical", "canonical\n\n", "", (sums) => `canonical\n\n${sums}`,
    // The earlier form, a commit id first: no first line, no tag.
    `${COMMIT}\n`, (sums) => `${COMMIT}\n\n${sums}`, (sums) => `${TAG}\n${COMMIT}\n\n${sums}`, (sums) => `${CANONICAL_REPOSITORY}\n${COMMIT}\n\n${sums}`,
    // A tag that is not a release tag of the owning repository's kind.
    ...["0.2.14", "release-1", "v1.2", "v1", "v1.2.3.4", "v01.2.3", "v1.02.3", "v1.2.03", "V1.2.3", "v1.2.3-", "v1.2.3-a..b", "v1.2.3+build", " v1.2.3", "v1.2.3 ", "", "main", "v1.2.x"].map(withTag),
    // A commit id that is not one, a missing empty line, a line too many, a first line that is empty.
    (sums) => `${CANONICAL_REPOSITORY}\n${TAG}\n${COMMIT.toUpperCase()}\n\n${sums}`, (sums) => `${CANONICAL_REPOSITORY}\n${TAG}\n${COMMIT.slice(1)}\n\n${sums}`,
    (sums) => `${CANONICAL_REPOSITORY}\n${TAG}\n${COMMIT}\n${sums}`, `${CANONICAL_REPOSITORY}\n${TAG}\n${COMMIT}`, (sums) => `${CANONICAL_REPOSITORY}\n${TAG}\n${TAG}\n${COMMIT}\n\n${sums}`,
    (sums) => `\n${TAG}\n${COMMIT}\n\n${sums}`, (sums) => `${CANONICAL_REPOSITORY}\n\n${TAG}\n${COMMIT}\n\n${sums}`,
  ];
  malformed.forEach((source, i) => {
    const d = copyOfDir();
    writeFileSync(join(d, "SOURCE"), typeof source === "string" ? source : source(sumsOf(d)));
    assert.throws(() => checkDir(d), SourceError, `form ${i + 1}`);
    const r = verifyCli(d);
    assert.equal(r.rc, 2, `form ${i + 1}`);
    assert.equal(r.out, "");
    assert.match(r.err, /^general-use: the directory could not be checked: SOURCE must hold /);
  });
});

// ── the pull-request step: the base branch's checker decides ────────────────────────────

const inGate = (name) => `ci/general-use/${name}`;
/** A repository whose main branch carries this directory's gate (and empty lists). */
function gatedRepo({ scanner, files = {}, allow = "", firstParty = "" } = {}) {
  return repo({ ...CLEAN, ...gateFiles({ scanner }), ...files }, { allow, firstParty });
}
/** The directory's shared files and SOURCE, with a list that pins them as given (`pin: false` leaves this directory's list). */
function gateFiles({ scanner, pin = true, change = (files) => files, source = () => "canonical\n" } = {}) {
  // SOURCE says canonical whatever this repository's own says: the tests name no repository unless they are about it.
  let files = { ...Object.fromEntries([...SHARED, "SHA256SUMS"].map((name) => [name, readFileSync(join(HERE, name))])), SOURCE: "canonical\n" };
  if (scanner !== undefined) files["scan.mjs"] = scanner;
  files = change(files);
  if (pin) files.SHA256SUMS = Object.keys(files).filter((n) => n !== "SHA256SUMS" && n !== "SOURCE").sort().map((n) => `${createHash("sha256").update(files[n]).digest("hex")}  ${n}\n`).join("");
  files.SOURCE = source(String(files.SHA256SUMS));
  return Object.fromEntries(Object.entries(files).map(([name, body]) => [inGate(name), body]));
}
/** The scanner with one class taken out just before it starts. */
function withoutClass(id) {
  const src = readFileSync(SCAN, "utf8");
  const out = src.replace("\nfunction startedAsProgram() {", `\nCLASSES.splice(CLASSES.findIndex((c) => c.id === ${JSON.stringify(id)}), 1);\nfunction startedAsProgram() {`);
  assert.notEqual(out, src, "the place to change was found");
  return out;
}
// Each run gets a temporary directory of its own, and must leave it empty: the copy of the
// base branch's checker is removed, whatever the outcome.
const runGate = (script, cwd, ...args) => runGateEnv({}, script, cwd, ...args);
const runGateEnv = (env, script, cwd, ...args) => {
  const own = tmp();
  const r = spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", env: { ...ENV, ...env, TMPDIR: own } });
  assert.deepEqual(readdirSync(own), [], "the gate left something in its temporary directory");
  return { rc: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
};
/** What the CI step does: gate.mjs is taken from the base branch and started from outside the tree. */
const gateFromBase = (dir, base, cwd = dir, ...more) => gateFromBaseEnv({}, dir, base, cwd, ...more);
function gateFromBaseEnv(env, dir, base, cwd = dir, ...more) {
  const script = join(tmp(), "gate.mjs");
  writeFileSync(script, git(dir, "show", `${base}:${inGate("gate.mjs")}`));
  return runGateEnv(env, script, cwd, "--base", base, ...more);
}

test("gate: a branch that weakens a class in its own scanner, and adds a hit of that class, still fails", () => {
  const dir = gatedRepo();
  git(dir, "checkout", "-q", "-b", "topic");
  // The branch pins its changed scanner, as a change to the gate would: its directory is consistent.
  commit(dir, { ...gateFiles({ scanner: withoutClass("vocabulary") }), "docs/b.md": j(sampleOf("vocabulary", 0), "\n") }, "feat: b");
  assert.doesNotMatch(gateFromBase(dir, "main").out, /is refused by the verify-dir\.mjs/);
  // The branch's own scanner no longer sees it.
  const own = runGate(join(dir, inGate("scan.mjs")), dir, "--base", "main");
  assert.equal(own.rc, 0, own.all);
  const r = gateFromBase(dir, "main");
  assert.equal(r.rc, 1, r.all);
  assert.deepEqual(hitLines(r.out), ["docs/b.md:1 [vocabulary]"]);
  assert.match(r.out, /^general-use gate: the checker of main \([0-9a-f]{12}\), with its lists did not pass$/m);
  assert.doesNotMatch(r.out, /this tree's own checker, with its lists did not pass/);
  assert.match(r.out, /^general-use gate: this branch changes ci\/general-use\/scan\.mjs: /m);
  assert.match(r.out, /^general-use gate: 2 checkers: NOT CLEAN$/m);
  // Nor does it help the branch to empty its own copy of the step: the base's copy is the one started.
  commit(dir, gateFiles({ scanner: withoutClass("vocabulary"), change: (files) => ({ ...files, "gate.mjs": "process.exitCode = 0;\n" }) }), "feat: c");
  const again = gateFromBase(dir, "main");
  assert.equal(again.rc, 1, again.all);
  assert.match(again.out, /^general-use gate: this branch changes ci\/general-use\/gate\.mjs: /m);
});

test("gate: a rule the branch adds applies to the branch too (the stricter of the two decides)", () => {
  // The base's scanner lacks a class, and the tree already holds a name of it.
  const dir = gatedRepo({ scanner: withoutClass("vocabulary"), files: { "docs/b.md": j(sampleOf("vocabulary", 0), "\n") } });
  git(dir, "checkout", "-q", "-b", "topic");
  commit(dir, gateFiles(), "feat: the class is back");
  const r = gateFromBase(dir, "main");
  assert.equal(r.rc, 1, r.all);
  assert.deepEqual(hitLines(r.out), ["docs/b.md:1 [vocabulary]"]);
  assert.match(r.out, /^general-use gate: this tree's own checker, with its lists did not pass$/m);
  assert.doesNotMatch(r.out, /the checker of main \([0-9a-f]{12}\), with its lists did not pass/);
});

test("gate: a clean branch passes both checkers, from any directory with --root", () => {
  const dir = gatedRepo();
  git(dir, "checkout", "-q", "-b", "topic");
  commit(dir, { "src/b.js": "export const b = 2;\n" }, "feat: b");
  for (const r of [gateFromBase(dir, "main"), gateFromBase(dir, "main", tmp(), "--root", dir)]) {
    assert.equal(r.rc, 0, r.all);
    assert.equal(r.err, "general-use: note: SOURCE says canonical and GITHUB_REPOSITORY is not set: which repository this is was not checked\n".repeat(2), "nothing but the note of a run that names no repository, once for the base's copy and once for the tree's");
    assert.match(r.out, /^general-use gate: this tree's ci\/general-use, by the verify-dir\.mjs of main \([0-9a-f]{12}\)\ngeneral-use: ci\/general-use is the pinned copy$/m);
    assert.equal(r.out.match(/^general-use: \d+ files, 1 commit messages: clean$/gm).length, 2, r.out);
    assert.match(r.out, /^general-use gate: 2 checkers: clean$/m);
    assert.doesNotMatch(r.out, /this branch changes/);
  }
  // The commit messages of the branch are in both runs.
  commit(dir, { "src/c.js": "export const c = 3;\n" }, j("feat: c for the ", sampleOf("vocabulary", 0)));
  const dirty = gateFromBase(dir, "main");
  assert.equal(dirty.rc, 1, dirty.all);
  assert.equal(hitLines(dirty.out).length, 2, dirty.out);
});

test("gate: a base with no checker has nothing to compare with: the tree's own copy decides, and the log says so", () => {
  const dir = repo(CLEAN);
  git(dir, "rm", "-q", "-r", "ci");
  git(dir, "commit", "-q", "-m", "no gate yet");
  git(dir, "checkout", "-q", "-b", "topic");
  commit(dir, { ...gateFiles(), [inGate("allow.txt")]: "", [inGate("first-party.txt")]: "" }, "feat: the gate");
  // The base has no gate.mjs to take, so the step starts the tree's.
  const r = runGate(join(dir, inGate("gate.mjs")), dir, "--base", "main");
  assert.equal(r.rc, 0, r.all);
  assert.match(r.out, /^general-use gate: main has no ci\/general-use\/scan\.mjs: nothing to compare with, so this tree's own checker decides$/m);
  assert.match(r.out, /^general-use gate: 1 checkers: clean$/m);
  commit(dir, { "docs/b.md": j(sampleOf("vocabulary", 0), "\n") }, "feat: b");
  const hit = runGate(join(dir, inGate("gate.mjs")), dir, "--base", "main");
  assert.equal(hit.rc, 1, hit.all);
  assert.deepEqual(hitLines(hit.out), ["docs/b.md:1 [vocabulary]"]);
});

test("gate: an error is never a clean result (no base, an unknown base, a scan that cannot complete)", () => {
  const dir = gatedRepo();
  git(dir, "checkout", "-q", "-b", "topic");
  commit(dir, { "src/b.js": "export const b = 2;\n" }, "feat: b");
  const script = join(dir, inGate("gate.mjs"));
  for (const args of [[], ["--base"], ["--base", "no-such-ref"], ["--base", "--all"], ["--base", ""], ["--base", "main", "--everything"], ["--base", "main", "--root", join(dir, "nowhere")]]) {
    const r = runGate(script, dir, ...args);
    assert.equal(r.rc, 2, args.join(" ") + r.all);
    assert.match(r.err, /^general-use gate: could not be completed: /);
    assert.doesNotMatch(r.all, /clean\n/);
  }
  for (const args of [[], ["--base", ""], ["--root", dir]]) assert.match(runGate(script, dir, ...args).err, /: --base <ref\|commit> is needed\n/);
  // Outside any repository, with no --root.
  const outside = tmp();
  writeFileSync(join(outside, ".git"), "not a git directory\n");
  assert.equal(runGate(script, outside, "--base", "main").rc, 2);
  // The branch removes a list: its own scan cannot complete, and the gate's status says so, not "hits".
  git(dir, "rm", "-q", inGate("allow.txt"));
  git(dir, "commit", "-q", "-m", "no allow list");
  const r = gateFromBase(dir, "main");
  assert.equal(r.rc, 2, r.all);
  assert.match(r.out, /^general-use gate: this tree's own checker, with its lists could not complete its scan$/m);
  assert.match(r.out, /^general-use gate: 2 checkers: NOT CLEAN$/m);
  // A scan that cannot complete outranks one that found hits.
  commit(dir, { "docs/b.md": j(sampleOf("vocabulary", 0), "\n") }, "feat: b, with a name in it");
  const both = gateFromBase(dir, "main");
  assert.equal(both.rc, 2, both.all);
  assert.match(both.out, /^general-use gate: the checker of main \([0-9a-f]{12}\), with its lists did not pass$/m);
});

test("gate: the copy that decides is verified first: a base whose scanner is not its pinned one runs nothing, exit 2", () => {
  // The base's scanner lacks a class and its list still pins the real one.
  const dir = repo({ ...CLEAN, ...gateFiles({ scanner: withoutClass("vocabulary"), pin: false }) });
  git(dir, "checkout", "-q", "-b", "topic");
  commit(dir, { "src/b.js": "export const b = 2;\n" }, "feat: b");
  const r = gateFromBase(dir, "main");
  assert.equal(r.rc, 2, r.all);
  assert.match(r.all, /^general-use: scan\.mjs was changed$/m);
  assert.match(r.out, /^general-use gate: the checker of main \([0-9a-f]{12}\) is not its own pinned copy: it was not run, and nothing was checked$/m);
  assert.doesNotMatch(r.out, /files, \d+ commit messages|checkers: /);
});

test("gate: the base run reads the base branch's lists: a branch cannot allow its own hit or drop a first-party name", () => {
  const name = sampleOf("vocabulary", 2);
  const line = `const sample = "${name}";`;
  const allowRowFor = (path) => `${path}\tvocabulary\t${lineHash(line)}\tGeneric sample data for a parser test, no real name.\n`;
  const ownScan = (dir) => runGate(join(dir, inGate("scan.mjs")), dir, "--root", dir, "--base", "main");

  // An allow.txt entry added with the line it allows.
  const a = gatedRepo();
  git(a, "checkout", "-q", "-b", "topic");
  commit(a, { "test/p.test.js": `${line}\n`, [inGate("allow.txt")]: allowRowFor("test/p.test.js") }, "test: p");
  assert.equal(ownScan(a).rc, 0, "by its own lists the branch is clean");
  const ra = gateFromBase(a, "main");
  assert.equal(ra.rc, 1, ra.all);
  assert.deepEqual(hitLines(ra.out), ["test/p.test.js:1 [vocabulary]"]);
  assert.match(ra.out, /^general-use gate: the checker of main \([0-9a-f]{12}\), with its lists did not pass$/m);
  assert.match(ra.out, /^general-use gate: this branch changes ci\/general-use\/allow\.txt: /m);

  // A first-party name taken off the list, and used where it was not declared.
  const fp = "name\tacme.widget/\nfile\tsrc/table.js\n";
  const b = gatedRepo({ files: { "src/table.js": "export const W = 'acme.widget/1';\n" }, firstParty: fp });
  git(b, "checkout", "-q", "-b", "topic");
  commit(b, { "src/render.js": "const special = 'acme.widget/1';\n", [inGate("first-party.txt")]: "" }, "feat: render");
  assert.equal(ownScan(b).rc, 0, "by its own lists the branch is clean");
  const rb = gateFromBase(b, "main");
  assert.equal(rb.rc, 1, rb.all);
  assert.deepEqual(hitLines(rb.out), ["src/render.js:1 [first-party]"]);

  // A declaring file added to the list, with the name in it.
  const c = gatedRepo({ files: { "src/table.js": "export const W = 'acme.widget/1';\n" }, firstParty: fp });
  git(c, "checkout", "-q", "-b", "topic");
  commit(c, { "src/more.js": "const again = 'acme.widget/1';\n", [inGate("first-party.txt")]: `${fp}file\tsrc/more.js\n` }, "feat: more");
  assert.equal(ownScan(c).rc, 0);
  assert.deepEqual(hitLines(gateFromBase(c, "main").out), ["src/more.js:1 [first-party]"]);

  // The other way round is no trap: a branch that removes an allowed line with its entry, or a
  // declared name with its file, leaves the base's lists with entries that match nothing here.
  const d = gatedRepo({ files: { "test/p.test.js": `${line}\n`, "src/table.js": "export const W = 'acme.widget/1';\n" }, allow: allowRowFor("test/p.test.js"), firstParty: fp });
  git(d, "checkout", "-q", "-b", "topic");
  commit(d, { "test/p.test.js": "// nothing\n", "src/table.js": "export const W = 1;\n", [inGate("allow.txt")]: "", [inGate("first-party.txt")]: "" }, "test: p needs no sample");
  const rd = gateFromBase(d, "main");
  assert.equal(rd.rc, 0, rd.all);
  assert.doesNotMatch(rd.out, /stale/);
});

test("--lists reads the two lists from another directory: its entries apply, and none of them is stale here", () => {
  const line = `const sample = "${sampleOf("vocabulary", 2)}";`;
  const row = `test/p.test.js\tvocabulary\t${lineHash(line)}\tGeneric sample data for a parser test, no real name.\n`;
  const dir = repo({ ...CLEAN, "test/p.test.js": `${line}\n` });
  assert.equal(cli(dir, "--tree-only").rc, 1);
  const lists = tmp();
  write(lists, { "allow.txt": `${row}${row.replace("p.test", "q.test")}`, "first-party.txt": "name\tacme.widget/\nfile\tsrc/table.js\n" });
  const r = cli(dir, "--tree-only", "--lists", lists);
  assert.equal(r.rc, 0, r.all);
  // The same lists as the tree's own are held to the usual rule.
  const own = repo({ ...CLEAN, "test/p.test.js": `${line}\n` }, { allow: `${row}${row.replace("p.test", "q.test")}` });
  assert.match(cli(own, "--tree-only").out, /^allow\.txt:2 stale: /m);
  // A malformed entry is refused wherever the list is read from.
  write(lists, { "allow.txt": "not an entry\n" });
  assert.match(cli(dir, "--tree-only", "--lists", lists).out, /^allow\.txt:1 needs 4 tab-separated fields/m);
  unlinkSync(join(lists, "first-party.txt"));
  neverClean(cli(dir, "--tree-only", "--lists", lists));
  neverClean(cli(dir, "--tree-only", "--lists", join(lists, "nowhere")));
  neverClean(cli(dir, "--tree-only", "--lists"));
});

// ── the workflow directories are the base branch's, entry for entry ─────────────────────

const CI_YML = ".forgejo/workflows/ci.yml";
const RELEASE_YML = ".forgejo/workflows/release.yml";
const GITEA_YML = ".gitea/workflows/ci.yml";
const GITHUB_YML = ".github/workflows/ci.yml";
const CI_TEXT = ["name: CI", "on:", "  push:", "    branches: [main]", "  pull_request:", "jobs:", "  test:", "    steps:", "      - run: npm test", "  general-use:", "    steps:", "      - run: node ci/general-use/gate.mjs", ""].join("\n");
const RELEASE_TEXT = ["name: Release", "on:", "  push:", "    tags: [v*]", "jobs:", "  publish:", "    steps:", "      - run: npm publish", ""].join("\n");
const WORKFLOWS = { [CI_YML]: CI_TEXT, [RELEASE_YML]: RELEASE_TEXT, [GITEA_YML]: CI_TEXT, [GITHUB_YML]: CI_TEXT };
/** The workflow entries the gate refuses, in the order it prints them. */
const differing = (out) => out.split("\n").map((l) => /^general-use gate: the workflow entry (.*) is added, removed, renamed, changed in mode or type, or edited in the gate's job or the text before `jobs:`: a pull request runs the workflow of its own head, so this is merged only through the forge's protection of the workflow path$/.exec(l)).filter(Boolean).map((m) => m[1]);
/** How many of the gate's counts differ from the base's (one line each). */
const counted = (out) => out.split("\n").filter((l) => /^general-use gate: the workflows name (ci\/general-use\/gate\.mjs|the gate's job) \d+ times, and main \d+ times: /.test(l)).length;
/** The workflow files the gate passes with a notice. */
const noticed = (out) => out.split("\n").map((l) => /^general-use gate: notice: the workflow file (.*) is edited outside the gate's job and the text before `jobs:`: /.exec(l)).filter(Boolean).map((m) => m[1]);
const modeOf = (dir, path) => git(dir, "ls-tree", "HEAD", "--", path).split(" ")[0];
const stage = (dir, message) => {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", message);
};
const DIRS = [".forgejo/workflows", ".gitea/workflows", ".github/workflows"];
const GATE_JOB = "  general-use:\n    steps:\n      - run: node ci/general-use/gate.mjs\n";

// Each row: a change on a branch of a repository whose base has the four workflow files, and
// what the gate must then say: the entries it refuses, how many of its counts differ, and the
// files it passes with a notice. Refused entries or a count make the status 1.
const workflowRows = [
  ["identical workflows", () => {}, {}],
  ["a file that is no workflow is edited, next to the directories and elsewhere", (dir) => write(dir, { "src/b.js": "export const b = 2;\n", ".forgejo/notes.md": "notes\n", ".github/CODEOWNERS": "* @example\n", "docs/a.md": "# A page\n\nMore.\n" }), {}],
  // A job that reports as the gate, added to another workflow file: the edit itself keeps what
  // that file protects, and the count of the gate's job is what refuses it.
  ["a job that reports as the gate is added to another workflow file, at four spaces", (dir) => write(dir, { [RELEASE_YML]: RELEASE_TEXT.replace("jobs:\n", "jobs:\n    general-use:\n        steps:\n            - run: true\n") }), { counts: 1, notices: [RELEASE_YML] }],
  // The spellings below are the ones a parser of workflow text had to tell apart, and got wrong one
  // after the other. Nothing here parses them: each is refused by the count, which reads no syntax.
  ...[
    ["with one space before its id", "jobs:\n general-use:\n  steps:\n   - run: true\n"],
    ["with three spaces before its id", "jobs:\n   general-use:\n      steps:\n         - run: true\n"],
    ["with a tab before its id", "jobs:\n\tgeneral-use:\n\t\tsteps:\n\t\t\t- run: true\n"],
    ["with an anchor on its line", "jobs:\n  general-use: &gate\n    steps:\n      - run: true\n"],
    ["as an alias of another job", "jobs:\n  general-use: *publish\n"],
    ["by a merge key", "jobs:\n  general-use:\n    <<: *publish\n"],
    ["with its id in quotes", "jobs:\n  \"general-use\":\n    steps:\n      - run: true\n"],
    ["by a name on the line after the key", "jobs:\n  other:\n    name:\n      general-use\n    steps:\n      - run: true\n"],
  ].map(([how, jobs]) => [`a job that reports as the gate is added to another workflow file, ${how}`, (dir) => write(dir, { [RELEASE_YML]: RELEASE_TEXT.replace("jobs:\n", jobs) }), { counts: 1, notices: [RELEASE_YML] }]),
  ["a job that reports as the gate is added to another workflow file, as a flow mapping", (dir) => write(dir, { [RELEASE_YML]: RELEASE_TEXT.replace("jobs:\n", "jobs: { general-use: { steps: [ { run: 'true' } ] } }\nmore:\n") }), { refused: [RELEASE_YML], counts: 1 }],
  ["a job named as the gate is added to another workflow file", (dir) => write(dir, { [RELEASE_YML]: `${RELEASE_TEXT}  other:\n    name: general-use\n    steps:\n      - run: true\n` }), { counts: 1, notices: [RELEASE_YML] }],
  ["another job of the gate's own workflow file is edited", (dir) => write(dir, { [CI_YML]: CI_TEXT.replace("npm test", "npm run test:all") }), { notices: [CI_YML] }],
  ["the gate's own job is edited", (dir) => write(dir, { [CI_YML]: CI_TEXT.replace("node ci/general-use/gate.mjs", "node ci/general-use/scan.mjs --tree-only") }), { refused: [CI_YML], counts: 1 }],
  ["the triggers are edited", (dir) => write(dir, { [CI_YML]: CI_TEXT.replace("  pull_request:\n", "") }), { refused: [CI_YML] }],
  ["a space is added at the end of a line before `jobs:`", (dir) => write(dir, { [RELEASE_YML]: RELEASE_TEXT.replace("name: Release\n", "name: Release \n") }), { refused: [RELEASE_YML] }],
  ["an empty line is added at the end of the gate's workflow file", (dir) => write(dir, { [CI_YML]: `${CI_TEXT}\n` }), { notices: [CI_YML] }],
  ["a comment is added to the workflow of the directory the forge reads last, before `jobs:`", (dir) => write(dir, { [GITHUB_YML]: `# a note\n${CI_TEXT}` }), { refused: [GITHUB_YML] }],
  ["only the mode of a workflow file changes", (dir) => {
    assert.equal(modeOf(dir, RELEASE_YML), "100644");
    // On disk and in the index: the row does not depend on the file system keeping modes.
    chmodSync(join(dir, RELEASE_YML), 0o755);
    git(dir, "update-index", "--chmod=+x", RELEASE_YML);
  }, { refused: [RELEASE_YML] }, (dir) => assert.equal(modeOf(dir, RELEASE_YML), "100755", "the fixture changed the mode, and nothing else")],
  ["the first workflow directory is replaced by a link to another", (dir) => {
    git(dir, "rm", "-q", "-r", ".forgejo/workflows");
    mkdirSync(join(dir, ".forgejo"), { recursive: true });
    symlinkSync("../.github/workflows", join(dir, ".forgejo/workflows"));
  }, { refused: [".forgejo/workflows", CI_YML, RELEASE_YML], counts: 2 }, (dir) => assert.equal(modeOf(dir, ".forgejo/workflows"), "120000")],
  ["the first workflow directory is replaced by a plain file", (dir) => {
    git(dir, "rm", "-q", "-r", ".forgejo/workflows");
    mkdirSync(join(dir, ".forgejo"), { recursive: true });
    writeFileSync(join(dir, ".forgejo/workflows"), "not a directory\n");
  }, { refused: [".forgejo/workflows", CI_YML, RELEASE_YML], counts: 2 }, (dir) => assert.equal(modeOf(dir, ".forgejo/workflows"), "100644")],
  ["the directory above the first workflow directory is replaced by a link", (dir) => {
    git(dir, "rm", "-q", "-r", ".forgejo");
    symlinkSync(".github", join(dir, ".forgejo"));
  }, { refused: [CI_YML, RELEASE_YML], counts: 2 }, (dir) => assert.equal(modeOf(dir, ".forgejo"), "120000")],
  ["the directory above the first workflow directory is replaced by a plain file", (dir) => {
    git(dir, "rm", "-q", "-r", ".forgejo");
    writeFileSync(join(dir, ".forgejo"), "not a directory\n");
  }, { refused: [CI_YML, RELEASE_YML], counts: 2 }, (dir) => assert.equal(modeOf(dir, ".forgejo"), "100644")],
  ...DIRS.flatMap((d) => {
    const f = `${d}/ci.yml`;
    const edit = (text) => (dir) => write(dir, { [f]: text });
    return [
      [`a file is added in ${d}`, (dir) => write(dir, { [`${d}/extra.yml`]: RELEASE_TEXT }), { refused: [`${d}/extra.yml`] }],
      [`a file is added in a directory below ${d}`, (dir) => write(dir, { [`${d}/more/extra.yml`]: RELEASE_TEXT }), { refused: [`${d}/more/extra.yml`] }],
      [`a file is removed from ${d}`, (dir) => git(dir, "rm", "-q", f), { refused: [f], counts: 2 }],
      [`a file is renamed in ${d}`, (dir) => git(dir, "mv", f, `${d}/main.yml`), { refused: [f, `${d}/main.yml`] }],
      // A note about the gate in another job, on a line of its own, is no job: not counted.
      [`in ${d}, a comment line about the gate is added to another job`, edit(CI_TEXT.replace("      - run: npm test\n", "      # the general-use job runs ci/general-use/gate.mjs\n      - run: npm test\n")), { notices: [f] }],
      // After code on the same line it is counted: a \`#\` there is not cut at.
      [`in ${d}, a comment about the gate after a step is counted`, edit(CI_TEXT.replace("      - run: npm test\n", "      - run: npm test # not general-use\n")), { counts: 1, notices: [f] }],
      // What the blocked pull requests did: another job of the gate's file is edited.
      [`in ${d}, another job gets a container and a step`, edit(CI_TEXT.replace("    steps:\n      - run: npm test\n", "    container:\n      options: --tmpfs /tmp\n    steps:\n      - run: test -d /tmp\n      - run: npm test\n")), { notices: [f] }],
      [`in ${d}, a step is added inside the gate's job`, edit(CI_TEXT.replace(GATE_JOB, GATE_JOB.replace("    steps:\n", "    steps:\n      - run: true\n"))), { refused: [f] }],
      [`in ${d}, a line is added at the end of the gate's job`, edit(`${CI_TEXT}    continue-on-error: true\n`), { refused: [f] }],
      [`in ${d}, a line is added at the end of the gate's job, after a comment`, edit(`${CI_TEXT}  # a note\n    if: false\n`), { refused: [f] }],
      // The gate's job is checked where its key line is, line for line: its text placed
      // anywhere else does not stand for it.
      [`in ${d}, the gate's job is disabled and its body put back after a comment line`, edit(CI_TEXT.replace(GATE_JOB, `  general-use:\n    if: false\n#  general-use:\n${GATE_JOB.split("\n").slice(1).join("\n")}`)), { refused: [f] }],
      [`in ${d}, the gate's job is disabled and a copy of it is put after the last job, as a comment`, edit(`${CI_TEXT.replace(GATE_JOB, "  general-use:\n    if: false\n    steps:\n      - run: true\n")}#${GATE_JOB.split("\n").join("\n#")}`.replace(/#$/, "")), { refused: [f], counts: 2 }],
      [`in ${d}, a line is put between the gate's key line and its steps`, edit(CI_TEXT.replace(GATE_JOB, GATE_JOB.replace("  general-use:\n", "  general-use:\n    if: false\n"))), { refused: [f] }],
      // Disabled in place, same number of lines, and a copy of its text put inside another
      // job after a comment line: every count is the base's and a key follows the job, so
      // only comparing it line for line where its key line is refuses it.
      [`in ${d}, the gate's job is disabled in place and a copy of its text is put inside another job`, edit(CI_TEXT.replace("      - run: npm test\n", `      - run: npm test\n#${GATE_JOB}`).replace(`#${GATE_JOB}  general-use:\n    steps:\n      - run: node ci/general-use/gate.mjs\n`, `#${GATE_JOB}  general-use:\n    if: false\n    steps: []\n`)), { refused: [f] }],
      // A line of the gate's job edited in place, its old text still inside it.
      [`in ${d}, the gate's step is edited in place to ignore its status`, edit(CI_TEXT.replace("      - run: node ci/general-use/gate.mjs\n", "      - run: node ci/general-use/gate.mjs || true\n")), { refused: [f] }],
      [`in ${d}, the gate's steps line is edited in place`, edit(CI_TEXT.replace(GATE_JOB, GATE_JOB.replace("    steps:\n", "    steps: # none\n"))), { refused: [f] }],
      [`in ${d}, the gate's key line is indented by three spaces`, edit(CI_TEXT.replace(GATE_JOB, ` ${GATE_JOB}`)), { refused: [f] }],
      [`in ${d}, the gate's key line ends in a carriage return`, edit(CI_TEXT.replace("  general-use:\n", "  general-use:\r\n")), { refused: [f] }],
      [`in ${d}, the gate's job is removed`, edit(CI_TEXT.replace(GATE_JOB, "")), { refused: [f], counts: 2 }],
      [`in ${d}, a second job starts gate.mjs`, edit(`${CI_TEXT}  again:\n    steps:\n      - run: node ci/general-use/gate.mjs --root .\n`), { counts: 2, notices: [f] }],
      [`in ${d}, a second job is named as the gate`, edit(`${CI_TEXT}  shadow:\n    name: general-use\n    steps:\n      - run: true\n`), { counts: 1, notices: [f] }],
      [`in ${d}, a second job has the gate's key`, edit(`${CI_TEXT}${GATE_JOB.replace("node ci/general-use/gate.mjs", "true")}`), { refused: [f], counts: 1 }],
      [`in ${d}, a key is added at the start of a line after \`jobs:\``, edit(`${CI_TEXT}on:\n  workflow_dispatch:\n`), { refused: [f] }],
      [`in ${d}, a second \`jobs:\` line is added`, edit(`${CI_TEXT}jobs:\n  test:\n    steps:\n      - run: true\n`), { refused: [f] }],
    ];
  }),
  // A key at the start of a line where nothing else would see it: in a file with no gate,
  // and between two jobs of the gate's file.
  ["a key is added at the start of a line after `jobs:`, in another workflow file", (dir) => write(dir, { [RELEASE_YML]: `${RELEASE_TEXT}on:\n  workflow_dispatch:\n` }), { refused: [RELEASE_YML] }],
  ["a key is added at the start of a line between two jobs of the gate's file", (dir) => write(dir, { [CI_YML]: CI_TEXT.replace(GATE_JOB, `on:\n  workflow_dispatch:\n${GATE_JOB}`) }), { refused: [CI_YML] }],
  ["a second `jobs:` line is added between two jobs of the gate's file", (dir) => write(dir, { [CI_YML]: CI_TEXT.replace(GATE_JOB, `jobs:\n${GATE_JOB}`) }), { refused: [CI_YML] }],
  ["a file is moved from one workflow directory to another", (dir) => git(dir, "mv", RELEASE_YML, ".github/workflows/release.yml"), { refused: [RELEASE_YML, ".github/workflows/release.yml"] }],
  ["every file of the first workflow directory is removed, so that the forge would read the next", (dir) => git(dir, "rm", "-q", "-r", ".forgejo/workflows"), { refused: [CI_YML, RELEASE_YML], counts: 2 }],
  ["a file that is no workflow is added inside a workflow directory", (dir) => write(dir, { ".forgejo/workflows/notes.txt": "notes\n" }), { refused: [".forgejo/workflows/notes.txt"] }],
];

/** Runs one row on a fresh repository whose base has `files`; checks every part of what the gate says. */
function workflowCase(files, change, { refused = [], counts = 0, notices = [] }, prove = () => {}) {
  const dir = gatedRepo({ files });
  git(dir, "checkout", "-q", "-b", "topic");
  change(dir);
  stage(dir, "ci: a change");
  prove(dir);
  const r = gateFromBase(dir, "main");
  const bad = refused.length > 0 || counts > 0;
  assert.equal(r.rc, bad ? 1 : 0, `status: ${r.all}`);
  assert.deepEqual(differing(r.out), [...refused].sort(), r.out);
  assert.equal(counted(r.out), counts, r.out);
  assert.deepEqual(noticed(r.out), [...notices].sort(), r.out);
  assert.deepEqual(hitLines(r.out), [], "the scans themselves are clean");
  assert.match(r.out, bad ? /^general-use gate: 2 checkers: NOT CLEAN$/m : /^general-use gate: 2 checkers: clean$/m);
  // The listing is compared, never shown: no object id, and nothing of a file.
  assert.doesNotMatch(r.all, /\b[0-9a-f]{40}\b|100644|100755|120000|npm publish|npm test|continue-on-error/);
}

for (const [what, change, want, prove] of workflowRows) {
  const bad = (want.refused?.length ?? 0) > 0 || (want.counts ?? 0) > 0;
  test(`gate, workflows: ${what}: ${bad ? "refused" : want.notices?.length ? "passed with a notice" : "clean"}`, () => workflowCase(WORKFLOWS, change, want, prove));
}

// The gate's job reports under its own `name:`: a second job with that name, and no other
// word of the gate in it, is seen only by that count.
const NAMED_CI = CI_TEXT.replace("  general-use:\n    steps:\n", "  general-use:\n    name: Gate of the tree\n    steps:\n");
const NAMED = { ...WORKFLOWS, [CI_YML]: NAMED_CI };
test("gate, workflows: a second job with the gate's own `name:` is refused, in the gate's file", () =>
  workflowCase(NAMED, (dir) => write(dir, { [CI_YML]: `${NAMED_CI}  shadow:\n    name: Gate of the tree\n    steps:\n      - run: true\n` }), { counts: 1, notices: [CI_YML] }));
test("gate, workflows: a second job with the gate's own `name:`, in quotes, is refused, in another file", () =>
  workflowCase(NAMED, (dir) => write(dir, { [RELEASE_YML]: `${RELEASE_TEXT}  shadow:\n    name: "Gate of the tree"\n    steps:\n      - run: true\n` }), { counts: 1, notices: [RELEASE_YML] }));
test("gate, workflows: a base file that names gate.mjs and cannot be cut passes no edit to any workflow", () => {
  // gate.mjs is named only above `jobs:`, so no job holds it: what reports as the gate is not known.
  const uncut = `# runs ci/general-use/gate.mjs\n${CI_TEXT.replace("      - run: node ci/general-use/gate.mjs\n", "      - run: node gate.js\n")}`;
  workflowCase({ ...WORKFLOWS, [CI_YML]: uncut }, (dir) => write(dir, { [RELEASE_YML]: RELEASE_TEXT.replace("npm publish", "npm publish --dry-run") }), { refused: [RELEASE_YML] });
});

test("gate, workflows: the comparison is with the base branch as it is now: a branch cut before a change to the gate's job on the base is refused until it is rebased", () => {
  const dir = gatedRepo({ files: WORKFLOWS });
  git(dir, "checkout", "-q", "-b", "topic");
  commit(dir, { "src/b.js": "export const b = 2;\n" }, "feat: b");
  assert.equal(gateFromBase(dir, "main").rc, 0);
  // The base moves on: the gate's job changes after the branch was cut. The branch itself changed no workflow.
  git(dir, "checkout", "-q", "main");
  commit(dir, { [CI_YML]: CI_TEXT.replace("node ci/general-use/gate.mjs", "node ci/general-use/gate.mjs --root .") }, "ci: the gate names its root");
  git(dir, "checkout", "-q", "topic");
  assert.equal(git(dir, "diff", "--name-only", "main...topic"), "src/b.js\n", "since the merge base the branch changed one file, and no workflow");
  const behind = gateFromBase(dir, "main");
  assert.equal(behind.rc, 1, `status: ${behind.all}`);
  assert.deepEqual(differing(behind.out), [CI_YML]);
  git(dir, "rebase", "-q", "main");
  const rebased = gateFromBase(dir, "main");
  assert.equal(rebased.rc, 0, `status: ${rebased.all}`);
  assert.deepEqual(differing(rebased.out), []);
});

test("gate, workflows: a base with no workflow at all has an empty list: the first workflow a branch adds is refused", () => {
  const dir = gatedRepo();
  git(dir, "checkout", "-q", "-b", "topic");
  commit(dir, { "src/b.js": "export const b = 2;\n" }, "feat: b");
  const none = gateFromBase(dir, "main");
  assert.equal(none.rc, 0, `status: ${none.all}`);
  commit(dir, { [CI_YML]: CI_TEXT }, "ci: a workflow");
  const first = gateFromBase(dir, "main");
  assert.equal(first.rc, 1, `status: ${first.all}`);
  assert.deepEqual(differing(first.out), [CI_YML]);
});

test("gate, workflows: a path is named with its control characters escaped, on one line", () => {
  const dir = gatedRepo({ files: WORKFLOWS });
  git(dir, "checkout", "-q", "-b", "topic");
  commit(dir, { ".forgejo/workflows/x\n::error::y.yml": RELEASE_TEXT, ".github/workflows/z\x7f\u0085.yml": RELEASE_TEXT }, "ci: two names");
  const r = gateFromBase(dir, "main");
  assert.equal(r.rc, 1, `status: ${r.all}`);
  assert.deepEqual(differing(r.out), [".forgejo/workflows/x\\x0a::error::y.yml", ".github/workflows/z\\x7f\\x85.yml"]);
  for (const line of r.all.split("\n")) assert.doesNotMatch(line, /^\s*(::|##\[)/);
  assert.doesNotMatch(r.all, /[\u0000-\u0009\u000b-\u001f\u007f\u0085]/);
});

test("gate, workflows: this repository's own workflow directories compare equal with themselves", (t) => {
  const here = [".forgejo/workflows", ".gitea/workflows", ".github/workflows"].filter((d) => existsSync(join(REPO, d)));
  if (here.length === 0) return t.diagnostic("this repository has no workflow directory: nothing to compare");
  const files = {};
  for (const d of here) for (const name of readdirSync(join(REPO, d))) files[`${d}/${name}`] = readFileSync(join(REPO, d, name));
  const dir = gatedRepo({ files });
  git(dir, "checkout", "-q", "-b", "topic");
  commit(dir, { "src/b.js": "export const b = 2;\n" }, "feat: b");
  assert.deepEqual(differing(gateFromBase(dir, "main").out), []);
});

test("gate: the tree's own directory is read by the base branch's verify-dir: a copy cannot change its check and its source together", () => {
  // A copy in another repository: SOURCE names the owning repository, a tag and its commit.
  const copyOf = (origin) => (sums) => `${origin}\n${TAG}\n${COMMIT}\n\n${sums}`;
  const dir = repo({ ...CLEAN, ...gateFiles({ source: copyOf(CANONICAL_REPOSITORY) }) });
  const env = { CI: "true", GITHUB_REPOSITORY: "someone/their-tool" };
  git(dir, "checkout", "-q", "-b", "topic");
  commit(dir, { "src/b.js": "export const b = 2;\n" }, "feat: b");
  const clean = gateFromBaseEnv(env, dir, "main");
  assert.equal(clean.rc, 0, clean.all);

  // The branch points its copy at a fork: its own verify-dir.mjs is changed to name the fork,
  // SOURCE names it, and the lists are regenerated. By its own check the directory is fine.
  const FORK = "someone/vbcdx";
  const forked = gateFiles({ source: copyOf(FORK), change: (files) => ({ ...files, "verify-dir.mjs": String(files["verify-dir.mjs"]).replace(`"${CANONICAL_REPOSITORY}"`, `"${FORK}"`) }) });
  assert.notEqual(String(forked[inGate("verify-dir.mjs")]), readFileSync(join(HERE, "verify-dir.mjs"), "utf8"), "the constant was changed");
  commit(dir, forked, "ci: the gate, from a fork");
  const own = spawnSync(process.execPath, [join(dir, inGate("verify-dir.mjs"))], { encoding: "utf8", env: { ...ENV, ...env } });
  assert.equal(own.status, 0, own.stdout + own.stderr);
  const r = gateFromBaseEnv(env, dir, "main");
  assert.equal(r.rc, 1, r.all);
  assert.match(r.err, new RegExp(`^general-use: SOURCE names another source than ${CANONICAL_REPOSITORY.replace(/[./]/g, "\\$&")}$`, "m"));
  assert.match(r.out, /^general-use gate: this tree's ci\/general-use is refused by the verify-dir\.mjs of main \([0-9a-f]{12}\)$/m);
  assert.deepEqual(hitLines(r.out), [], "the scans are clean: the directory check is what fails");

  // A copy that starts to say canonical, and one whose scanner no longer matches its list.
  git(dir, "checkout", "-q", "-B", "topic", "main");
  commit(dir, gateFiles(), "ci: this copy says canonical");
  const claims = gateFromBaseEnv(env, dir, "main");
  assert.equal(claims.rc, 1, claims.all);
  assert.match(claims.err, /^general-use: SOURCE says canonical, but this is someone\/their-tool: /m);
  git(dir, "checkout", "-q", "-B", "topic", "main");
  commit(dir, { [inGate("scan.mjs")]: withoutClass("vocabulary") }, "ci: a scanner that is not the pinned one");
  const loose = gateFromBaseEnv(env, dir, "main");
  assert.equal(loose.rc, 1, loose.all);
  assert.match(loose.err, /^general-use: scan\.mjs was changed$/m);
  assert.match(loose.out, /^general-use gate: this tree's ci\/general-use is refused by the verify-dir\.mjs of main /m);
});

test("only the owning repository may say canonical: a copy that says it is refused, by verify-dir and by the gate's check of the base copy", () => {
  assert.equal(CANONICAL_REPOSITORY, "VBCDX/vbcdx");
  const d = copyOfDir();
  writeFileSync(join(d, "SOURCE"), "canonical\n");
  const NOTE = "general-use: note: SOURCE says canonical and GITHUB_REPOSITORY is not set: which repository this is was not checked\n";
  const CHECKED = (repo) => `general-use: SOURCE is canonical, checked against GITHUB_REPOSITORY ${repo}\n`;
  for (const repo of [CANONICAL_REPOSITORY, "vbcdx/vbcdx", CANONICAL_REPOSITORY.toUpperCase()]) {
    assert.deepEqual(verifyDir(d, { GITHUB_REPOSITORY: repo }), [], repo);
    const r = verifyCli(d, { GITHUB_REPOSITORY: repo });
    assert.equal(r.rc, 0, repo + r.err);
    assert.ok(r.out.startsWith(CHECKED(repo)), r.out);
    assert.equal(r.err, "");
  }
  for (const repo of [`${CANONICAL_REPOSITORY}-core`, `x${CANONICAL_REPOSITORY}`, "someone/vbcdx", "VBCDX", "VBCDX/vbcdx/"]) {
    assert.deepEqual(verifyDir(d, { GITHUB_REPOSITORY: repo }), [`SOURCE says canonical, but this is ${repo}: a copy records its source commit`]);
    const r = verifyCli(d, { GITHUB_REPOSITORY: repo });
    assert.equal(r.rc, 1, repo);
    assert.match(r.out, /^general-use: ci\/general-use is REFUSED\n$/);
    assert.doesNotMatch(r.all, /checked against|was not checked/);
  }
  // A CI job that names no repository cannot make the claim: refused, with a fixed message.
  const NO_REPOSITORY = "SOURCE says canonical, and this CI job names no repository (GITHUB_REPOSITORY is not set): the claim cannot be checked, so it is refused";
  for (const name of CI_VARIABLES) {
    for (const env of [{ [name]: "true" }, { [name]: "1", GITHUB_REPOSITORY: "" }]) {
      assert.deepEqual(verifyDir(d, env), [NO_REPOSITORY], name);
      const r = verifyCli(d, env);
      assert.equal(r.rc, 1, name);
      assert.equal(r.err, `general-use: ${NO_REPOSITORY}\n`);
      assert.equal(r.out, "general-use: ci/general-use is REFUSED\n");
    }
    // The same job, naming the owning repository or another: as without the variable.
    assert.equal(verifyCli(d, { [name]: "true", GITHUB_REPOSITORY: CANONICAL_REPOSITORY }).rc, 0, name);
    assert.equal(verifyCli(d, { [name]: "true", GITHUB_REPOSITORY: `${CANONICAL_REPOSITORY}-core` }).rc, 1, name);
    // A variable that is there and empty is not a CI job.
    assert.equal(verifyCli(d, { [name]: "" }).rc, 0, name);
    // A copy that names its source makes no such claim.
    assert.equal(verifyCli(vendoredCopy(), { [name]: "true" }).rc, 0, name);
  }
  // No repository named (a local run): accepted, and the note says what was not checked.
  for (const env of [{}, { GITHUB_REPOSITORY: "" }]) {
    assert.deepEqual(verifyDir(d, env), []);
    const r = verifyCli(d, env);
    assert.equal(r.rc, 0, r.err);
    assert.equal(r.err, NOTE);
    assert.equal(r.out, "general-use: ci/general-use is the pinned copy\n");
  }
  // A copy that names its source commit is bound to it as before, whatever the repository.
  for (const repo of [CANONICAL_REPOSITORY, `${CANONICAL_REPOSITORY}-core`]) {
    const copy = vendoredCopy();
    const ok = verifyCli(copy, { GITHUB_REPOSITORY: repo });
    assert.equal(ok.rc, 0, repo + ok.err);
    assert.equal(ok.all, "general-use: ci/general-use is the pinned copy\n");
    writeFileSync(join(copy, "scan.mjs"), `${readFileSync(join(copy, "scan.mjs"), "utf8")}// more\n`);
    assert.equal(verifyCli(copy, { GITHUB_REPOSITORY: repo }).rc, 1, repo);
  }
  // Through the gate: the base branch's copy says canonical. In another repository it is not run.
  const dir = gatedRepo();
  git(dir, "checkout", "-q", "-b", "topic");
  commit(dir, { "src/b.js": "export const b = 2;\n" }, "feat: b");
  const here = gateFromBaseEnv({ GITHUB_REPOSITORY: CANONICAL_REPOSITORY }, dir, "main");
  assert.equal(here.rc, 0, here.all);
  assert.ok(here.out.includes(CHECKED(CANONICAL_REPOSITORY)), here.out);
  const elsewhere = gateFromBaseEnv({ GITHUB_REPOSITORY: `${CANONICAL_REPOSITORY}-core` }, dir, "main");
  assert.equal(elsewhere.rc, 2, elsewhere.all);
  assert.match(elsewhere.err, /^general-use: SOURCE says canonical, but this is VBCDX\/vbcdx-core: a copy records its source commit$/m);
  assert.match(elsewhere.out, /is not its own pinned copy: it was not run, and nothing was checked$/m);
  assert.doesNotMatch(elsewhere.out, /files, \d+ commit messages|checkers: /);
});

test("a path is printed on one line and is never a command to a CI runner: control characters and a leading :: are escaped", () => {
  const name = sampleOf("vocabulary", 2);
  const body = `${name}\n`;
  const nul = Buffer.concat([Buffer.from([0]), Buffer.from(body)]);
  const dir = gatedRepo();
  git(dir, "checkout", "-q", "-b", "topic");
  commit(dir, {
    "docs/a\n::warning::forged.md": body, "::warning::top.md": body, "  ::error::spaced.md": body, "##[error]old.md": body,
    "docs/b\r\x1b[2K\x7f.md": body, "docs/c\u0085\u2028\u2029.md": body, "docs/mid::warning::x.md": body, "docs/n\nul.bin": nul,
    "docs/w\nide.txt": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("plain", "utf16le")]),
    [inGate("x\n::notice::y")]: "clean\n", [inGate("z\x7f\u0085\u2028\u2029")]: "clean\n",
  }, "docs: some names");
  const expected = [
    "  \\x3a:error::spaced.md:1 [vocabulary]", "\\x23#[error]old.md:1 [vocabulary]", "\\x3a:warning::top.md:1 [vocabulary]",
    "docs/a\\x0a::warning::forged.md:1 [vocabulary]", "docs/b\\x0d\\x1b[2K\\x7f.md:1 [vocabulary]", "docs/c\\x85\\u{2028}\\u{2029}.md:1 [vocabulary]",
    "docs/mid::warning::x.md:1 [vocabulary]", "docs/n\\x0aul.bin:1 [vocabulary]",
  ];
  const noCommand = (text) => {
    for (const line of text.split(/\r\n|[\n\r\u0085\u2028\u2029]/)) assert.doesNotMatch(line, /^\s*(::|##\[)/, "a line a CI runner would act on");
    assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f\u0085\u2028\u2029]/, "a control character in the output");
  };
  const scan = cli(dir, "--tree-only");
  assert.equal(scan.rc, 1, scan.all);
  assert.deepEqual(hitLines(scan.out).sort(), [...expected].sort());
  assert.ok(scan.out.includes("note: docs/n\\x0aul.bin holds a NUL byte: "), scan.out);
  assert.ok(scan.out.includes("note: docs/w\\x0aide.txt starts with a UTF-16 byte-order mark: "), scan.out);
  noCommand(scan.all);
  const hashes = cli(dir, "--tree-only", "--hashes");
  assert.ok(hashes.out.includes(`docs/a\\x0a::warning::forged.md:1 [vocabulary] docs/a\\x0a::warning::forged.md\tvocabulary\t${lineHash(name)}\n`), hashes.out);
  noCommand(hashes.all.replace(/\t/g, " "));
  // A file that cannot be read, an argument and a ref that git refuses: the message is escaped too.
  unlinkSync(join(dir, "docs/a\n::warning::forged.md"));
  const gone = cli(dir, "--tree-only");
  assert.equal(gone.err, "general-use: the scan could not be completed: cannot read docs/a\\x0a::warning::forged.md: ENOENT\n");
  git(dir, "checkout", "-q", "--", ".");
  for (const args of [["--tree-only", "--x\u2028::error::y"], ["--tree-only", "--x\n::error::y"], ["--base", "no\u2028::error::ref"]]) {
    const r = cli(dir, ...args);
    assert.equal(r.rc, 2);
    noCommand(r.all);
    assert.equal(r.err.split("\n")[0].startsWith("general-use: "), true);
  }
  // A message of git that repeats what it was given: a root that is not there.
  // git itself writes the ASCII control characters of a path as question marks: these it does not.
  const odd = join(tmp(), "no\u2028::error::dir\u0085");
  const noRoot = spawnSync(process.execPath, [SCAN, "--root", odd, "--tree-only", "--lists", join(dir, "ci", "general-use")], { encoding: "utf8", env: ENV });
  assert.equal(noRoot.status, 2);
  assert.match(noRoot.stderr, /no\\u\{2028\}::error::dir\\x85/);
  noCommand(noRoot.stdout + noRoot.stderr);
  const gateNoRoot = runGate(join(dir, inGate("gate.mjs")), dir, "--base", "main", "--root", odd);
  assert.equal(gateNoRoot.rc, 2);
  assert.match(gateNoRoot.err, /no\\u\{2028\}::error::dir\\x85/);
  noCommand(gateNoRoot.all);
  // The gate's own lines: the changed file's name, and the base as it was given.
  const gate = gateFromBase(dir, "main");
  assert.equal(gate.rc, 1, gate.all);
  assert.ok(gate.out.includes("general-use gate: this branch changes ci/general-use/x\\x0a::notice::y: a change to the gate is reviewed as one\n"), gate.out);
  assert.ok(gate.out.includes("general-use gate: this branch changes ci/general-use/z\\x7f\\x85\\u{2028}\\u{2029}: "), gate.out);
  noCommand(gate.all);
  // A base that git resolves although it holds a line break (a search for a commit message).
  const oddBase = runGate(join(dir, inGate("gate.mjs")), dir, "--base", "main^{/[\n::error::a-z]}");
  // Both scans are given the commit it resolves to, not the text: they run, and find the names.
  assert.equal(oddBase.rc, 1, oddBase.all);
  assert.equal(oddBase.out.match(/^general-use: \d+ files, \d+ commit messages: NOT CLEAN/gm).length, 2, oddBase.out);
  assert.ok(oddBase.out.includes("general-use gate: the copy of ci/general-use from main^{/[\\x0a::error::a-z]} ("), oddBase.out);
  noCommand(oddBase.all);
  noCommand(runGate(join(dir, inGate("gate.mjs")), dir, "--base", "no\n::error::ref").all);
  // verify-dir: a file in the directory that is not listed.
  const d = copyOfDir();
  writeFileSync(join(d, "x\n::warning::y"), "x\n");
  writeFileSync(join(d, "z\x7f\u0085\u2028\u2029"), "x\n");
  const verify = verifyCli(d);
  assert.equal(verify.rc, 1);
  assert.ok(verify.err.includes("general-use: x\\x0a::warning::y is not listed\n"), verify.err);
  assert.ok(verify.err.includes("general-use: z\\x7f\\x85\\u{2028}\\u{2029} is not listed\n"), verify.err);
  noCommand(verify.all);
  noCommand(verifyCli(copyOfDir(), { GITHUB_REPOSITORY: "a/b\n::error::c" }).all);
});

test("gate: a base whose checker predates this step runs its scanner with the tree's lists and compares no workflow, and says so", () => {
  // The directory as it was before gate.mjs: four shared files, pinned as four.
  const before = gateFiles({
    change: ({ "gate.mjs": _, ...files }) => ({ ...files, "verify-dir.mjs": readFileSync(join(HERE, "verify-dir.mjs"), "utf8").replace('"README.md", "gate.mjs", ', '"README.md", ') }),
  });
  assert.equal(inGate("gate.mjs") in before, false);
  const name = sampleOf("vocabulary", 2);
  const line = `const sample = "${name}";`;
  const dir = repo({ ...CLEAN, ...before, ...WORKFLOWS });
  git(dir, "checkout", "-q", "-b", "topic");
  const row = `test/p.test.js\tvocabulary\t${lineHash(line)}\tGeneric sample data for a parser test, no real name.\n`;
  commit(dir, { ...gateFiles(), "test/p.test.js": `${line}\n`, [inGate("allow.txt")]: row, [CI_YML]: CI_TEXT.replace("node ci/general-use/gate.mjs", "node other.mjs"), ".forgejo/workflows/extra.yml": RELEASE_TEXT }, "feat: the step");
  // The base has no gate.mjs to take, so the step starts the tree's.
  const r = runGate(join(dir, inGate("gate.mjs")), dir, "--base", "main");
  assert.equal(r.rc, 0, r.all);
  assert.match(r.out, /^general-use gate: the checker of main predates this step: it runs with this tree's lists, and the workflows are not compared$/m);
  assert.deepEqual(differing(r.out), []);
  assert.match(r.out, /^general-use gate: the checker of main \([0-9a-f]{12}\)$/m);
  assert.match(r.out, /^general-use gate: 2 checkers: clean$/m);
  // Its scanner still decides: a name with no entry fails there.
  commit(dir, { "docs/b.md": `${name}\n`, [inGate("scan.mjs")]: withoutClass("vocabulary") }, "feat: b");
  const hit = runGate(join(dir, inGate("gate.mjs")), dir, "--base", "main");
  assert.equal(hit.rc, 1, hit.all);
  assert.deepEqual(hitLines(hit.out), ["docs/b.md:1 [vocabulary]"]);
});
