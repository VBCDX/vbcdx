// Coverage for the remaining untaken branch arms of src/install/commands.js,
// src/install/locate.js and src/install/tool-declaration.js.
//
// Each case drives the exported caller the commands use (installTool, installSkill, remove,
// locatePackageDir, readToolDeclaration) and asserts what the run does, so an arm that stops
// being taken, or starts behaving as the other side, fails here.
//
// Arms covered, by file and line at the commit this file was written against:
//   commands.js:136        an entry the operator edited between the pre-lock plan and the
//                          plan taken under the lock is refused with that plan's note
//   commands.js:269        a skill file edited in the same window is refused under the lock
//   commands.js:305        the empty-directory cleanup's read fails (the directory vanished
//                          after the lock was released) and is ignored: the record is still
//                          dropped
//   locate.js:54           an `npm root -g` that prints something other than an absolute
//                          path is not used as a search root
//   locate.js:65           a spec that is not a name or a path is refused
//   tool-declaration.js:250  a declaration read that fails with no errno says "read error"
//
// FOUR ARMS ARE NOT HERE, because no real input reaches them without a product change:
//   commands.js:343        a merge error whose `message` is falsy: mergeConfig throws only
//                          Error/YAMLParseError/RangeError/TypeError, every one with a
//                          message, from every text a file can hold.
//   commands.js:345        `parsePy(content) || {}` needs mergeConfig to return text that
//                          parses to null; an emptied mapping always stringifies to "{}\n",
//                          which parses to {} (truthy). Measured over 28 document shapes
//                          against five path lists (140 merges): none parsed to null.
//   commands.js:353        an ownedDigest error with a falsy `message`: canonical() recurses,
//                          so the worst real case is a RangeError, which carries a message.
//   commands.js:405        the rethrow needs findSkill to throw a non-InstallerError; every
//                          path inside it throws configError (an InstallerError), and the
//                          only other route is a non-string `name`, which the CLI cannot
//                          produce.
// Those four are named with these reasons in the report to the PM rather than forced.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.js";
import "./helpers/fixture-pack.js";
import { EXIT } from "../src/errors.js";
import { catalogueSkills, installSkill, installTool, remove } from "../src/install/commands.js";
import { resolveContext } from "../src/install/context.js";
import { skillTarget } from "../src/install/harness-targets.js";
import { readToolDeclaration } from "../src/install/tool-declaration.js";
import { locatePackageDir } from "../src/install/locate.js";

const TOOL_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tool-package");
const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKILL = catalogueSkills().find((s) => typeof s.name === "string" && SKILL_NAME_RE.test(s.name) && s.description).name;

const ctxFor = (home) => resolveContext({ harness: "claude", scope: "user", envPath: null, home, cwd: home, env: {} });

function caught(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail("expected the call to throw");
}

// Replace one node:fs export for the duration of `fn`. Both arms below defend against a file
// that changes between two reads inside one command; a single process cannot hold both states
// on disk at once, so the second read is served the edited text. The suite reaches such
// shapes this way already (test/coverage-v1-apply.test.js reads a code-less unlink error).
function withFsMock(t, name, impl, fn) {
  const real = fs[name];
  t.mock.method(fs, name, (...args) => impl(real, ...args));
  syncBuiltinESMExports();
  try {
    return fn();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
}

test("the fixture catalogue has an installable skill", () => {
  assert.equal(typeof SKILL, "string");
});

// ── commands.js: install tool ───────────────────────────────────────────────

test("an entry edited between the pre-lock plan and the locked one is refused with that note", (t) => {
  // commands.js:136: the plan is recomputed under the lock, and a conflict found there is
  // refused with the note the recomputation produced, not the pre-lock one.
  const home = tempDir("vbcdx-cov-v9-inst-");
  const pkgDir = join(home, "pkg");
  cpSync(TOOL_FIXTURE, pkgDir, { recursive: true });
  const ctx = ctxFor(home);
  const target = installTool(ctx, pkgDir).file;
  const before = readFileSync(target, "utf8");

  let reads = 0;
  const err = withFsMock(t, "readFileSync", (real, p, ...rest) => {
    if (String(p) !== target) return real(p, ...rest);
    reads += 1;
    const text = String(real(p, ...rest));
    if (reads === 1) return text;
    // The operator's edit, arriving after the pre-lock plan.
    const doc = JSON.parse(text);
    const server = Object.keys(doc.mcpServers)[0];
    doc.mcpServers[server].env = { HAND_EDITED: "yes" };
    return JSON.stringify(doc, null, 2) + "\n";
  }, () => caught(() => installTool(ctx, pkgDir)));

  assert.equal(reads, 2, "the plan was taken twice: before the lock and under it");
  assert.equal(err.name, "InstallerError");
  assert.equal(err.code, EXIT.CONFLICT);
  assert.match(err.message, /^Refusing to change .*\.claude\.json: the entry was edited since the installer wrote it; --force replaces the entry and keeps the rest of the file\. Nothing was written\.$/);
  assert.equal(readFileSync(target, "utf8"), before, "the edited file was left as the operator wrote it");
});

// ── commands.js: install skill ──────────────────────────────────────────────

test("a skill file edited between the pre-lock check and the locked one is refused under the lock", (t) => {
  // commands.js:269: the classification is taken again under the lock; a file that changed
  // in between is refused there, with the short note that lives on that arm.
  const home = tempDir("vbcdx-cov-v9-inst-");
  const ctx = ctxFor(home);
  installSkill(ctx, SKILL);
  const dest = skillTarget(ctx, SKILL);
  const before = readFileSync(dest, "utf8");

  let reads = 0;
  const err = withFsMock(t, "readFileSync", (real, p, ...rest) => {
    if (String(p) !== dest) return real(p, ...rest);
    reads += 1;
    return reads === 1 ? real(p, ...rest) : `${before}\n<!-- hand edited -->\n`;
  }, () => caught(() => installSkill(ctx, SKILL)));

  assert.equal(reads, 2, "the classification was taken twice: before the lock and under it");
  assert.equal(err.name, "InstallerError");
  assert.equal(err.code, EXIT.CONFLICT);
  assert.equal(err.message, `Refusing to overwrite ${dest}: it was modified outside the installer. Nothing was written.`);
  assert.equal(readFileSync(dest, "utf8"), before, "the edited file was left as the operator wrote it");
});

// ── commands.js: remove skill ───────────────────────────────────────────────

test("a skill whose file is already gone is dropped, and a failed directory cleanup is ignored", (t) => {
  // commands.js:305: after the locks are released the empty-directory cleanup reads the
  // directory first; when that read fails the failure is swallowed and the record is still
  // dropped. The lock creates the directory, so the only way to see the read fail in one
  // process is to have the directory vanish at that moment: the read is served ENOENT.
  const home = tempDir("vbcdx-cov-v9-inst-");
  const ctx = ctxFor(home);
  installSkill(ctx, SKILL);
  const dest = skillTarget(ctx, SKILL);
  const dir = dirname(dest);
  rmSync(dest);

  const report = withFsMock(t, "readdirSync", (real, p, ...rest) => {
    if (String(p) === dir) {
      const e = new Error(`ENOENT: no such file or directory, scandir '${dir}'`);
      e.code = "ENOENT";
      throw e;
    }
    return real(p, ...rest);
  }, () => remove(ctx, "skill", SKILL));

  assert.deepEqual(report.removed, [{ path: dest, action: "absent" }]);
  assert.equal(dest in JSON.parse(readFileSync(ctx.manifestPath, "utf8")).files, false, "the record is dropped");
});

// ── locate.js ───────────────────────────────────────────────────────────────

test("an npm root that is not an absolute path is not used as a search root", () => {
  // locate.js:54, the `: null` arm. `defaultNpmGlobalRoot` is only reached when no root is
  // injected, so the test puts a real `npm` executable on PATH that prints a relative token.
  // The package sits where that token would resolve, so accepting it would find the package.
  const root = tempDir("vbcdx-cov-v9-locate-");
  const pack = join(root, "@example", "rel-root-pack");
  mkdirSync(pack, { recursive: true });
  writeFileSync(join(pack, "package.json"), JSON.stringify({ name: "@example/rel-root-pack", version: "1.0.0" }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const npm = join(bin, "npm");
  writeFileSync(npm, "#!/bin/sh\necho .\n");
  chmodSync(npm, 0o755);

  const oldPath = process.env.PATH;
  const oldCwd = process.cwd();
  process.env.PATH = `${bin}:${oldPath}`;
  process.chdir(root);
  try {
    assert.throws(
      () => locatePackageDir("@example/rel-root-pack", { cwd: root }),
      { name: "InstallerError", code: EXIT.CONFIG, message: /^@example\/rel-root-pack is not installed\. Install it first, then rerun:\n {2}npm install -g @example\/rel-root-pack$/ },
    );
  } finally {
    process.chdir(oldCwd);
    process.env.PATH = oldPath;
  }
  assert.deepEqual(JSON.parse(readFileSync(join(pack, "package.json"), "utf8")).version, "1.0.0", "the decoy is untouched");
});

test("a spec that is neither a name nor a path is refused before any search", () => {
  // locate.js:65: the guard every caller relies on before a path is built.
  for (const spec of ["", undefined, null, 42]) {
    assert.throws(
      () => locatePackageDir(spec),
      { name: "InstallerError", code: EXIT.CONFIG, message: /^A package needs a package name or path\.$/ },
      String(spec),
    );
  }
});

// ── tool-declaration.js ─────────────────────────────────────────────────────

test("a declaration read that fails without an errno says 'read error'", (t) => {
  // tool-declaration.js:250: a read failure with no `code` has only the words "read error".
  const dir = tempDir("vbcdx-cov-v9-td-");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@example/x", version: "1.0.0" }));
  writeFileSync(join(dir, "vbcdx.json"), "{}");
  const declPath = join(dir, "vbcdx.json");

  const err = withFsMock(t, "readFileSync", (real, p, ...rest) => {
    if (String(p) === declPath) throw new Error("disk on fire");
    return real(p, ...rest);
  }, () => caught(() => readToolDeclaration(dir)));

  assert.equal(err.name, "InstallerError");
  assert.equal(err.code, EXIT.CONFIG);
  assert.equal(err.message, `${dir} has no readable vbcdx.json (read error); it is not a VBCDX tool package.`);
});
