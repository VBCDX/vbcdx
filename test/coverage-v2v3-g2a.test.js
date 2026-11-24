// Coverage for the remaining branches of src/fs/safe-writer.js and src/sources/tree.js.
// Every failure here is produced at a real boundary: a file state in a temp dir, a path that is
// too long for the filesystem, a live child process, or the `deps` / `hooks` seams the module
// exports on purpose. Nothing patches module internals.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, chownSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDir } from "./helpers/temp-dir.js";
import { EXIT } from "../src/errors.js";
import {
  acquireLocks, assertManagedPath, atomicWrite, discardTemp, holderCommand, lockHolder, procCommand,
  procStart, removeAside, removeManagedFile, validateExistingFile,
} from "../src/fs/safe-writer.js";
import { assertLinksConfined, copyTree, treeDigest } from "../src/sources/tree.js";

const IS_ROOT = process.getuid() === 0;
const sha = (b) => createHash("sha256").update(b).digest("hex");

// A PID that is certainly not running: a process that has already exited.
function deadPid() {
  const r = spawnSync("true");
  assert.equal(r.status, 0);
  return r.pid;
}

function caught(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail("expected the call to throw");
}

// ── safe-writer: path guards ────────────────────────────────────────────────

// safe-writer.js 51-53: a relative or non-string path is refused as not absolute.
test("assertManagedPath refuses a relative path and a non-string", () => {
  for (const [bad, shown] of [["rel/dir/file", "rel/dir/file"], [42, "42"], [undefined, "undefined"]]) {
    const err = caught(() => assertManagedPath(bad));
    assert.equal(err.code, EXIT.FILESYSTEM);
    assert.equal(err.message, `Managed path must be absolute: ${shown}`);
  }
});

// safe-writer.js 55-57: a `..` component is refused even though the path is absolute.
test("assertManagedPath refuses a '..' component", () => {
  const p = "/some/dir/../elsewhere";
  const err = caught(() => assertManagedPath(p));
  assert.equal(err.code, EXIT.FILESYSTEM);
  assert.equal(err.message, `Managed path must not contain '..': ${p}`);
  // a name that merely contains dots is fine
  assert.doesNotThrow(() => assertManagedPath("/some/dir/..hidden/file.."));
});

// safe-writer.js 141-143: a regular file owned by another user is refused.
// As root the file is chowned to an unprivileged id; as a normal user a file root owns
// (/etc/passwd) is used.
test("validateExistingFile refuses a file not owned by the effective user", (t) => {
  let target;
  if (IS_ROOT) {
    const d = tempDir("vbcdx-g2a-own-");
    target = join(d, "theirs.txt");
    writeFileSync(target, "x");
    chownSync(target, 65534, 65534);
  } else {
    target = "/etc/passwd";
    if (lstatSync(target).isSymbolicLink() || statSync(target).uid === process.getuid()) {
      t.skip("no file owned by another user is available");
      return;
    }
  }
  const err = caught(() => validateExistingFile(target));
  assert.equal(err.code, EXIT.FILESYSTEM);
  assert.equal(err.message, `File is not owned by the effective user: ${target}`);
});

// ── safe-writer: atomicWrite failure cleanup ────────────────────────────────

// safe-writer.js 210-219: a failing open of the temp file reports filesystemError with the errno
// and leaves nothing behind. (The parent directory is missing.)
test("atomicWrite reports the errno and leaves no temp file when the temp cannot be created", () => {
  const d = tempDir("vbcdx-g2a-aw-");
  const dest = join(d, "no-such-dir", "out.txt");
  const err = caught(() => atomicWrite(dest, "data"));
  assert.equal(err.code, EXIT.FILESYSTEM);
  assert.equal(err.message, `Failed to write ${dest}: ENOENT.`);
  assert.equal(existsSync(dest), false);
  assert.deepEqual(readdirSync(d), []);
});

// safe-writer.js 210-219: the same cleanup for a permission failure (needs a non-root user:
// root ignores directory modes, so this is skipped when running as root).
test("atomicWrite reports EACCES for a directory it may not write to", (t) => {
  if (IS_ROOT) {
    t.skip("directory permissions do not stop root");
    return;
  }
  const d = tempDir("vbcdx-g2a-ro-");
  const ro = join(d, "ro");
  mkdirSync(ro);
  chmodSync(ro, 0o500);
  try {
    const dest = join(ro, "out.txt");
    const err = caught(() => atomicWrite(dest, "data"));
    assert.equal(err.code, EXIT.FILESYSTEM);
    assert.equal(err.message, `Failed to write ${dest}: EACCES.`);
    assert.deepEqual(readdirSync(ro), []);
  } finally {
    chmodSync(ro, 0o700);
  }
});

// safe-writer.js 212-213: the cleanup after a failed write closes the descriptor the failure left
// open and removes the temp, and neither step's own failure may replace the write error. Each arm
// is a real syscall failure here: a descriptor closed twice gives EBADF, a temp already gone gives
// ENOENT, and discardTemp swallows both.
test("discardTemp closes an open descriptor and removes the temp, ignoring a failing step", () => {
  const d = tempDir("vbcdx-g2a-discard-");
  const tmp = join(d, ".vbcdx-tmp-probe");
  writeFileSync(tmp, "partial");
  const fd = openSync(tmp, "r");
  discardTemp(fd, tmp); // the real close, then the real unlink
  assert.equal(existsSync(tmp), false, "removed with the real unlink");
  // The descriptor really was closed by the call above: closing it again is EBADF.
  assert.throws(() => closeSync(fd), { code: "EBADF" }, "discardTemp closed the descriptor it was given");
  // A failing open reaches it with no descriptor, and there is still nothing to remove.
  assert.doesNotThrow(() => discardTemp(undefined, join(d, "absent-temp")));
  // The cleanup's own failures are real and ignored: this descriptor is already closed (EBADF) and
  // this temp does not exist (ENOENT), so the caller still reports the write error, not these.
  const closed = openSync(tmp, "w");
  closeSync(closed);
  assert.throws(() => closeSync(closed), { code: "EBADF" }, "the descriptor really is closed");
  assert.throws(() => unlinkSync(join(d, "absent-temp")), { code: "ENOENT" }, "the temp really is gone");
  assert.doesNotThrow(() => discardTemp(closed, join(d, "absent-temp")));
});

// safe-writer.js 39-42: on a platform that has no POSIX uid, every managed mutation refuses before
// it touches a path. `isPosix()` is `typeof process.getuid === "function"`, so removing it in a
// child process is the platform this version does not support (not a stub of the module).
test("atomicWrite refuses on a non-POSIX platform with the unsupported-platform error", () => {
  const d = tempDir("vbcdx-g2a-posix-");
  const dest = join(d, "out.txt");
  const modUrl = pathToFileURL(join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "fs", "safe-writer.js")).href;
  const script = [
    `const m = await import(process.argv[1]);`,
    "delete process.getuid;",
    "try {",
    `  m.atomicWrite(process.argv[2], "data");`,
    '  process.stdout.write(JSON.stringify({ wrote: true }) + "\\n");',
    "} catch (e) {",
    '  process.stdout.write(JSON.stringify({ code: e.code, message: e.message }) + "\\n");',
    "}",
    "",
  ].join("\n");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script, modUrl, dest], { encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    code: EXIT.FILESYSTEM,
    message: "This installer's filesystem-safety guarantees require a POSIX platform; other platforms are unsupported in v1.",
  });
  assert.equal(existsSync(dest), false, "nothing was written");
});

// ── safe-writer: procCommand and removeAside ────────────────────────────────

// safe-writer.js 321-322: the start time of a PID whose /proc entry is gone is null, not an error -
// the process exited between the liveness check and this read. (lockHolder asks only for an alive
// PID, so the public API cannot reach this.)
test("procStart is null for a PID that is gone and clock ticks for a live one", () => {
  assert.equal(procStart(deadPid()), null);
  assert.match(procStart(process.pid), /^\d+$/);
});

// safe-writer.js 324-325: the command of a PID whose /proc entry is gone is null, not an error -
// the process exited between the liveness check and this read. (Its only caller in takeOver asks
// for an alive PID, so the public API cannot reach this.)
test("procCommand is null for a PID that is gone and names the program of a live one", () => {
  assert.equal(procCommand(deadPid()), null);
  assert.match(procCommand(process.pid), /^node(\s|$)/);
});

// safe-writer.js 441-442: the file a takeover renamed aside can fail to be removed for real - a
// directory at that path makes unlink(2) refuse with EISDIR, even for root - and the takeover goes
// on: the operator gets the warning on stderr and is told to remove it by hand. The warning goes to
// the real stderr, so it is read from a child's, never by patching this process's.
test("removeAside removes the file, and warns on stderr when the unlink really fails", () => {
  const d = tempDir("vbcdx-g2a-aside-");
  const aside = join(d, "record.json.lock.stale-1");
  writeFileSync(aside, "");
  removeAside(aside); // the real unlink; silent on success
  assert.equal(existsSync(aside), false, "removed with the real unlink");
  mkdirSync(aside); // a directory there: the child's unlink(2) fails with EISDIR
  assert.equal(caught(() => unlinkSync(aside)).code, "EISDIR", "a real unlink failure carries its errno");
  const modUrl = pathToFileURL(join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "fs", "safe-writer.js")).href;
  const script = "const m = await import(process.argv[1]); m.removeAside(process.argv[2]);";
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script, modUrl, aside], { encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, `warning: could not remove ${aside} (EISDIR); remove it by hand.\n`);
  assert.equal(statSync(aside).isDirectory(), true, "the aside path is still there for the operator");
});

// ── safe-writer: removeManagedFile ──────────────────────────────────────────

// safe-writer.js 260-263: a file that is already gone is "nothing to remove", not an error.
test("removeManagedFile returns false for a path that does not exist", () => {
  const d = tempDir("vbcdx-g2a-rm-");
  assert.equal(removeManagedFile(join(d, "absent.txt")), false);
});

// safe-writer.js 264-266: the pre-unlink re-stat finds the object is no longer a regular file
// owned by us. The `lstatSync` dep is the module's own seam; the first stat the validation
// passed, the re-stat says otherwise, and the file must survive.
test("removeManagedFile refuses when the re-stat is no longer a regular file owned by us", () => {
  const d = tempDir("vbcdx-g2a-rm-");
  const me = process.getuid();
  const cases = [
    ["not a file", { isFile: () => false, uid: me }],
    ["another owner", { isFile: () => true, uid: me + 1 }],
  ];
  for (const [label, fake] of cases) {
    const p = join(d, `${label.replace(/ /g, "-")}.txt`);
    writeFileSync(p, "keep");
    const err = caught(() => removeManagedFile(p, { lstatSync: () => fake }));
    assert.equal(err.code, EXIT.FILESYSTEM, label);
    assert.equal(err.message, `Refusing to remove ${p}: it is no longer the validated regular file.`, label);
    assert.equal(readFileSync(p, "utf8"), "keep", label);
  }
});

// safe-writer.js 269-272: the target vanishes between validation and the re-stat -> false;
// any other re-stat error is rethrown unchanged.
test("removeManagedFile treats a vanished target as removed and rethrows other stat errors", () => {
  const d = tempDir("vbcdx-g2a-rm-");
  const p = join(d, "f.txt");
  writeFileSync(p, "x");
  const gone = Object.assign(new Error("gone"), { code: "ENOENT" });
  assert.equal(removeManagedFile(p, { lstatSync: () => { throw gone; } }), false);
  assert.equal(readFileSync(p, "utf8"), "x");

  const boom = Object.assign(new Error("denied"), { code: "EACCES" });
  const err = caught(() => removeManagedFile(p, { lstatSync: () => { throw boom; } }));
  assert.equal(err, boom);
});

// safe-writer.js 279: after a successful unlink the confirming stat fails with an error that has
// no code -> the message says "error".
test("removeManagedFile reports an unconfirmable removal with a generic error name", () => {
  const d = tempDir("vbcdx-g2a-rm-");
  const p = join(d, "f.txt");
  writeFileSync(p, "x");
  let calls = 0;
  const lstatSync2 = (path) => {
    calls += 1;
    if (calls === 1) return lstatSync(path);
    throw new Error("no code on this one");
  };
  const err = caught(() => removeManagedFile(p, { lstatSync: lstatSync2 }));
  assert.equal(err.code, EXIT.FILESYSTEM);
  assert.equal(err.message, `Removed ${p} but could not confirm removal (error); investigate.`);
  assert.equal(existsSync(p), false);
});

// ── safe-writer: lock holder reading ────────────────────────────────────────

// safe-writer.js 363-365: a lock path that cannot be stat'd for a reason other than "absent"
// (its parent is a regular file -> ENOTDIR) is thrown, not reported as free.
test("lockHolder rethrows a stat error that is not ENOENT", () => {
  const d = tempDir("vbcdx-g2a-lh-");
  const notDir = join(d, "plain-file");
  writeFileSync(notDir, "x");
  const err = caught(() => lockHolder(join(notDir, "x.lock")));
  assert.equal(err.code, "ENOTDIR");
});

// safe-writer.js 318: a holder command with nothing printable left after stripping is null.
test("holderCommand is null when nothing printable remains", () => {
  assert.equal(holderCommand([]), null);
  assert.equal(holderCommand(["\u0001\u0002"]), null);
  assert.equal(holderCommand(["/usr/bin/"]), null);
  assert.equal(holderCommand(["/usr/bin/sleep", "30"]), "sleep");
});

// safe-writer.js 383: a live holder whose command cannot be named is shown by PID alone.
// A child started with a control character as its program name has a command that strips to
// nothing (holderCommand -> null), so the message is "process <pid>, for N s." with no
// parenthesised name.
test("acquireLocks names a live holder by PID alone when its command is unprintable", () => {
  const d = tempDir("vbcdx-g2a-held-");
  const p = join(d, "state", "record.json");
  mkdirSync(join(d, "state"));
  const child = spawn("sleep", ["30"], { stdio: "ignore", argv0: "\u0001" });
  try {
    writeFileSync(`${p}.lock`, `${child.pid}\n`);
    const err = caught(() => acquireLocks([p]));
    assert.equal(err.code, EXIT.FILESYSTEM);
    assert.match(err.message, new RegExp(`^Another operation holds the lock for ${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: process ${child.pid}, for \\d+ s\\. Retry after it finishes\\.$`));
    assert.equal(lockHolder(`${p}.lock`).command, null);
  } finally {
    child.kill("SIGKILL");
  }
});

// ── safe-writer: acquiring and taking over locks ────────────────────────────

// safe-writer.js 387: the default onStale writes a warning to stderr. Run in a child process
// so the test reads the real stderr stream.
test("acquireLocks warns on stderr by default when it takes over a stale lock", () => {
  const d = tempDir("vbcdx-g2a-warn-");
  const p = join(d, "state", "record.json");
  mkdirSync(join(d, "state"));
  const dead = deadPid();
  writeFileSync(`${p}.lock`, `${dead}\n`);
  const modUrl = pathToFileURL(join(fileURLToPath(new URL(".", import.meta.url)), "..", "src", "fs", "safe-writer.js")).href;
  const script = "const m = await import(process.argv[1]); const release = m.acquireLocks([process.argv[2]]); release();";
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script, modUrl, p], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, `warning: took over the lock for ${p}: process ${dead} is not running.\n`);
  assert.equal(existsSync(`${p}.lock`), false);
});

// safe-writer.js 398: release() tolerates a lock that is already gone (removeOwn's catch).
test("release does not throw when the lock file was removed meanwhile", () => {
  const d = tempDir("vbcdx-g2a-rel-");
  const p = join(d, "state", "record.json");
  const release = acquireLocks([p]);
  assert.equal(existsSync(`${p}.lock`), true);
  unlinkSync(`${p}.lock`);
  assert.doesNotThrow(() => release());
  assert.equal(existsSync(`${p}.lock`), false);
});

// safe-writer.js 416: the takeover mutex cannot be created for a reason other than "exists".
// The mutex name is the lock name plus ".takeover"; a lock name of 250 characters is legal but
// the mutex name (259) exceeds the 255-byte name limit, so creating it fails ENAMETOOLONG.
test("takeOver reports the errno when the takeover mutex cannot be created", () => {
  const d = tempDir("vbcdx-g2a-long-");
  const p = join(d, "a".repeat(245));
  writeFileSync(`${p}.lock`, `${deadPid()}\n`);
  const err = caught(() => acquireLocks([p]));
  assert.equal(err.code, EXIT.FILESYSTEM);
  assert.equal(err.message, `Cannot take over the stale lock for ${p}: ENAMETOOLONG.`);
  assert.equal(existsSync(`${p}.lock`), true, "the stale lock is left in place");
});

// safe-writer.js 476: the lock file itself cannot be created for a reason other than "exists"
// (the lock name is 256 characters: ENAMETOOLONG).
test("acquireLocks reports the errno when the lock file cannot be created", () => {
  const d = tempDir("vbcdx-g2a-long-");
  const p = join(d, "b".repeat(251));
  const err = caught(() => acquireLocks([p]));
  assert.equal(err.code, EXIT.FILESYSTEM);
  assert.equal(err.message, `Cannot acquire lock for ${p}: ENAMETOOLONG.`);
});

// safe-writer.js 426: the underTakeover hook runs under the takeover mutex, with the lock path.
test("takeOver calls the underTakeover hook with the lock path while holding the mutex", () => {
  const d = tempDir("vbcdx-g2a-hook-");
  const p = join(d, "state", "record.json");
  mkdirSync(join(d, "state"));
  const dead = deadPid();
  writeFileSync(`${p}.lock`, `${dead}\n`);
  const seen = [];
  const stale = [];
  const release = acquireLocks([p], {
    onStale: (s) => stale.push(s),
    hooks: { underTakeover: (lock) => seen.push([lock, existsSync(`${lock}.takeover`)]) },
  });
  assert.deepEqual(seen, [[`${p}.lock`, true]]);
  assert.deepEqual(stale, [{ path: p, pid: dead, reason: `process ${dead} is not running` }]);
  assert.equal(existsSync(`${p}.lock.takeover`), false, "the mutex is removed afterwards");
  release();
});

// safe-writer.js 428: the stale lock disappears under the takeover mutex -> takeOver returns
// null (nothing was taken over, so onStale is not told) and the acquirer simply creates it.
test("acquireLocks creates the lock when the stale one vanishes during the takeover", () => {
  const d = tempDir("vbcdx-g2a-vanish-");
  const p = join(d, "state", "record.json");
  mkdirSync(join(d, "state"));
  writeFileSync(`${p}.lock`, `${deadPid()}\n`);
  const stale = [];
  const release = acquireLocks([p], {
    onStale: (s) => stale.push(s),
    hooks: { underTakeover: (lock) => unlinkSync(lock) },
  });
  assert.deepEqual(stale, []);
  assert.match(readFileSync(`${p}.lock`, "utf8"), new RegExp(`^${process.pid}[ \\d]*\\n$`));
  release();
  assert.equal(existsSync(`${p}.lock`), false);
});

// safe-writer.js 435: the object renamed aside is not the file judged stale (a directory was
// swapped in by the beforeRename hook). Putting it back fails (a directory cannot be hard
// linked), the failure is swallowed, and the takeover reports that the lock changed. The
// swapped-in directory is prepared first so its inode differs from the stale file's.
test("takeOver leaves both objects and reports a changed lock when it cannot put one back", () => {
  const d = tempDir("vbcdx-g2a-swap-");
  const state = join(d, "state");
  mkdirSync(state);
  const p = join(state, "record.json");
  const lock = `${p}.lock`;
  writeFileSync(lock, `${deadPid()}\n`);
  const spare = join(d, "spare-dir");
  mkdirSync(spare);
  const err = caught(() => acquireLocks([p], {
    onStale: () => {},
    hooks: { beforeRename: (l) => { unlinkSync(l); renameSync(spare, l); } },
  }));
  assert.equal(err.code, EXIT.FILESYSTEM);
  assert.equal(err.message, `The lock for ${p} changed during takeover; retry.`);
  const aside = readdirSync(state).filter((n) => n.startsWith("record.json.lock.stale-"));
  assert.equal(aside.length, 1);
  assert.equal(statSync(join(state, aside[0])).isDirectory(), true, "the swapped-in object stays where it was moved");
  assert.equal(existsSync(lock), false);
  assert.equal(existsSync(`${lock}.takeover`), false, "the mutex is removed");
});

// ── tree.js ─────────────────────────────────────────────────────────────────

function makeFifo(path) {
  const r = spawnSync("mkfifo", [path], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
}

// tree.js 19 (? -1): entries are visited in code-unit order whatever order they were created in
// or the filesystem lists them; the expected digest is built by hand in that order.
test("treeDigest visits entries in code-unit order regardless of creation order", () => {
  const names = ["a", "B", "c", "10", "9", "Z", "_x"];
  const build = (root, order) => {
    mkdirSync(root);
    for (const n of order) writeFileSync(join(root, n), `content-${n}`);
  };
  const d = tempDir("vbcdx-g2a-tree-");
  build(join(d, "fwd"), names);
  build(join(d, "rev"), [...names].reverse());
  const sorted = [...names].sort();
  const h = createHash("sha256");
  for (const n of sorted) {
    const body = `content-${n}`;
    h.update(`f\0${n}\0-\0${Buffer.byteLength(body)}\0${sha(body)}\n`);
  }
  const expected = `sha256:${h.digest("hex")}`;
  assert.equal(treeDigest(join(d, "fwd")), expected);
  assert.equal(treeDigest(join(d, "rev")), expected);
});

// tree.js 80 (? "x"): an execute bit is recorded as "x" in the digest, and changes it.
test("treeDigest records a file's execute bit", () => {
  const d = tempDir("vbcdx-g2a-tree-");
  const root = join(d, "t");
  mkdirSync(root);
  const f = join(root, "run.sh");
  writeFileSync(f, "echo hi\n");
  chmodSync(f, 0o644);
  const plain = treeDigest(root);
  chmodSync(f, 0o755);
  const exec = treeDigest(root);
  assert.notEqual(plain, exec);
  const line = `f\0run.sh\0x\0${Buffer.byteLength("echo hi\n")}\0${sha("echo hi\n")}\n`;
  assert.equal(exec, `sha256:${sha(line)}`);
});

// tree.js 80-81: a special file (FIFO) in the tree is refused with a config error naming it.
test("treeDigest refuses a FIFO in the tree", () => {
  const d = tempDir("vbcdx-g2a-tree-");
  const root = join(d, "t");
  mkdirSync(root);
  writeFileSync(join(root, "ok.txt"), "ok");
  const fifo = join(root, "pipe");
  makeFifo(fifo);
  const err = caught(() => treeDigest(root));
  assert.equal(err.code, EXIT.CONFIG);
  assert.equal(err.message, `${fifo} is not a regular file, directory or symlink.`);
});

// tree.js 103: an executable source file is copied as 0755, any other as 0644, whatever the
// source's other bits; symlinks and `.git` keep their existing handling.
test("copyTree normalises copied modes to 0755 / 0644", () => {
  const d = tempDir("vbcdx-g2a-copy-");
  const src = join(d, "src");
  mkdirSync(src);
  writeFileSync(join(src, "tool"), "#!/bin/sh\n");
  chmodSync(join(src, "tool"), 0o710);
  writeFileSync(join(src, "data"), "d");
  chmodSync(join(src, "data"), 0o600);
  symlinkSync("data", join(src, "link"));
  mkdirSync(join(src, ".git"));
  writeFileSync(join(src, ".git", "HEAD"), "ref");
  const dst = join(d, "dst");
  copyTree(src, dst);
  assert.equal(statSync(join(dst, "tool")).mode & 0o777, 0o755);
  assert.equal(statSync(join(dst, "data")).mode & 0o777, 0o644);
  assert.equal(lstatSync(join(dst, "link")).isSymbolicLink(), true);
  assert.equal(existsSync(join(dst, ".git")), false);
  assert.equal(readFileSync(join(dst, "tool"), "utf8"), "#!/bin/sh\n");
});

// tree.js 104: copying a tree that holds a special file (FIFO) is refused with a config error.
test("copyTree refuses a FIFO in the source", () => {
  const d = tempDir("vbcdx-g2a-copy-");
  const src = join(d, "src");
  mkdirSync(src);
  const fifo = join(src, "pipe");
  makeFifo(fifo);
  const err = caught(() => copyTree(src, join(d, "dst")));
  assert.equal(err.code, EXIT.CONFIG);
  assert.equal(err.message, `${fifo} is not a regular file, directory or symlink.`);
});

// tree.js 46-47: a symlink that resolves to the tree's own root leaves the tree (its relative
// target is empty), so it is refused like one that points above it.
test("assertLinksConfined refuses a symlink that points at the tree root itself", () => {
  const d = tempDir("vbcdx-g2a-self-");
  const root = join(d, "t");
  mkdirSync(root);
  symlinkSync(".", join(root, "self"));
  const err = caught(() => assertLinksConfined(root));
  assert.equal(err.code, EXIT.CONFIG);
  assert.equal(err.message, "self is a symlink that points outside the source; a source may only link inside itself.");
});
