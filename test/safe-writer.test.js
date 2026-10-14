import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, statSync, rmSync, lstatSync, chmodSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWrite, assertNoSymlinkComponents, validateExistingFile, acquireLocks, sha256,
  assertRegularDestination, symlinkRefusalFor, ensurePrivateCredentialDir, removeManagedFile,
} from "../src/fs/safe-writer.js";
import { classifyGenerated, applyGenerated } from "../src/fs/manifest.js";

function scratch() {
  return mkdtempSync(join(tmpdir(), "vbcdx-sw-"));
}

test("atomicWrite creates a file with the requested mode", () => {
  const d = scratch();
  const p = join(d, "a", "b.txt");
  mkdirSync(join(d, "a"));
  const { digest } = atomicWrite(p, "hello", { mode: 0o600 });
  assert.equal(digest, sha256(Buffer.from("hello")));
  assert.equal(statSync(p).mode & 0o777, 0o600);
  rmSync(d, { recursive: true, force: true });
});

test("atomicWrite refuses to overwrite through a symlink target", () => {
  const d = scratch();
  const real = join(d, "real.txt");
  const link = join(d, "link.txt");
  writeFileSync(real, "x");
  symlinkSync(real, link);
  assert.throws(() => atomicWrite(link, "y"), /symlink/);
  rmSync(d, { recursive: true, force: true });
});

test("assertRegularDestination isolates atomicWrite's inner symlink re-check", () => {
  // atomicWrite hands this guard the destination's mutation-time lstat. Feeding
  // it a fabricated symlink stat directly bypasses assertNoSymlinkComponents (the
  // outer walk that otherwise catches the symlink first), so the inner redundant
  // guard is the sole thing under test. isFile()=>true isolates the SYMLINK
  // branch specifically: delete that branch and this stat throws nothing, so the
  // assertion fails — the redundant TOCTOU guard can no longer rot unnoticed.
  const swappedSymlink = { isSymbolicLink: () => true, isFile: () => true };
  assert.throws(
    () => assertRegularDestination(swappedSymlink, "/creds/role.env"),
    /Refusing to overwrite a symlink/,
  );
  // A realistic symlink lstat (isFile false) is still refused AS a symlink, not
  // misfiled as a generic non-regular file.
  const realSymlink = { isSymbolicLink: () => true, isFile: () => false };
  assert.throws(
    () => assertRegularDestination(realSymlink, "/creds/role.env"),
    /Refusing to overwrite a symlink/,
  );
  // A non-symlink non-regular target (dir/FIFO) is refused as non-regular.
  assert.throws(
    () => assertRegularDestination({ isSymbolicLink: () => false, isFile: () => false }, "/creds/role.env"),
    /non-regular file/,
  );
  // A regular file, or an absent destination (null), is allowed through.
  assert.doesNotThrow(
    () => assertRegularDestination({ isSymbolicLink: () => false, isFile: () => true }, "/creds/role.env"),
  );
  assert.doesNotThrow(() => assertRegularDestination(null, "/creds/role.env"));
});

test("symlinkRefusalFor isolates validateExistingFile's inner ELOOP remap", () => {
  // validateExistingFile opens the target O_NOFOLLOW and, on ELOOP, remaps the raw
  // error to a friendly "Refusing a symlink" refusal. On a static filesystem
  // assertNoSymlinkComponents already rejects a symlinked terminal component before
  // open() is reached, so that remap only fires in the TOCTOU race where a symlink
  // is swapped in between the walk and the open — a window not deterministically
  // reproducible in-process. So, exactly as the earlier fix isolated assertRegularDestination,
  // the mapping is a pure directly-callable helper and IS the thing under test here.
  // Feeding it a synthetic ELOOP error bypasses assertNoSymlinkComponents entirely.
  const eloop = Object.assign(new Error("simulated race"), { code: "ELOOP" });
  const mapped = symlinkRefusalFor(eloop, "/creds/role.env");
  assert.match(mapped.message, /Refusing a symlink: \/creds\/role\.env/);
  assert.notEqual(mapped, eloop, "ELOOP must be remapped to the friendly refusal, not passed through raw");
  // Any other error code is returned UNCHANGED (same object) for the caller to
  // rethrow — the remap must not swallow or reshape non-symlink failures.
  const eacces = Object.assign(new Error("permission denied"), { code: "EACCES" });
  assert.equal(symlinkRefusalFor(eacces, "/creds/role.env"), eacces);
  // A non-errno throw (no .code) is likewise passed through untouched.
  const weird = new Error("not an errno");
  assert.equal(symlinkRefusalFor(weird, "/creds/role.env"), weird);
});

test("assertNoSymlinkComponents rejects a symlinked directory component", () => {
  const d = scratch();
  mkdirSync(join(d, "realdir"));
  symlinkSync(join(d, "realdir"), join(d, "linkdir"));
  assert.throws(() => assertNoSymlinkComponents(join(d, "linkdir", "f.txt")), /symlink/);
  rmSync(d, { recursive: true, force: true });
});

test("validateExistingFile enforces 0600 in a 0700 dir for secrets", () => {
  const d = scratch();
  const secretDir = join(d, "creds");
  mkdirSync(secretDir, { mode: 0o700 });
  const f = join(secretDir, "role.env");
  writeFileSync(f, "x", { mode: 0o600 });
  assert.doesNotThrow(() => validateExistingFile(f, { secret: true }));
  // Widen the mode -> rejected.
  const f2 = join(secretDir, "loose.env");
  writeFileSync(f2, "x", { mode: 0o644 });
  chmodSync(f2, 0o644); // writeFileSync's mode is masked by the umask
  assert.throws(() => validateExistingFile(f2, { secret: true }), /0600/);
  rmSync(d, { recursive: true, force: true });
});

test("validateExistingFile rejects a FIFO promptly instead of blocking on it", {
  skip: process.platform === "win32" ? "mkfifo is POSIX-only" : false,
}, () => {
  // A FIFO is not a symlink, so O_NOFOLLOW does not reject it. Without O_NONBLOCK
  // open(fifo, O_RDONLY) blocks forever waiting for a writer — a stale FIFO left
  // by a crashed process (or planted in a writable parent) would hang the check
  // with no error and no timeout. The fix adds O_NONBLOCK so the open returns and
  // the fstat surfaces "Not a regular file".
  //
  // openSync is synchronous, so a regression blocks the event loop and node's own
  // per-test timeout timer can never fire — the run would hang CI. So the check
  // runs in a CHILD process under a hard wall-clock timeout the parent enforces
  // and kills: a regression surfaces as a killed child (assertion failure), never
  // a hang.
  const d = scratch();
  const fifo = join(d, "pipe");
  execFileSync("mkfifo", [fifo]);
  const swUrl = new URL("../src/fs/safe-writer.js", import.meta.url).href;
  const child = `
    import { validateExistingFile } from ${JSON.stringify(swUrl)};
    try {
      validateExistingFile(${JSON.stringify(fifo)});
      process.stdout.write("NO_THROW");
      process.exit(2);
    } catch (e) {
      if (/Not a regular file/.test(e.message)) { process.stdout.write("OK"); process.exit(0); }
      process.stdout.write("OTHER:" + e.message);
      process.exit(3);
    }
  `;
  let out;
  try {
    out = execFileSync(process.execPath, ["--input-type=module", "-e", child], {
      timeout: 5000,
      encoding: "utf8",
    });
  } catch (err) {
    rmSync(d, { recursive: true, force: true });
    if (err.killed || err.signal || err.code === "ETIMEDOUT") {
      assert.fail(
        "validateExistingFile did not return within 5s on a FIFO — it blocked. " +
          "Regression: openSync is missing O_NONBLOCK.",
      );
    }
    // A non-zero exit that was not a kill means the child threw the wrong thing.
    assert.fail(`FIFO check exited unexpectedly: code=${err.status} out=${err.stdout} err=${err.stderr}`);
  }
  rmSync(d, { recursive: true, force: true });
  assert.equal(out, "OK", `expected a prompt "Not a regular file" rejection, got: ${out}`);
});

test("secret writes never briefly exist with a broad mode", () => {
  const d = scratch();
  const secretDir = join(d, "creds");
  mkdirSync(secretDir, { mode: 0o700 });
  const f = join(secretDir, "s.env");
  atomicWrite(f, "token", { mode: 0o600, secret: true });
  assert.equal(statSync(f).mode & 0o777, 0o600);
  rmSync(d, { recursive: true, force: true });
});

test("acquireLocks is exclusive and releasable", () => {
  const d = scratch();
  const p = join(d, "x", "file");
  const release = acquireLocks([p]);
  assert.throws(() => acquireLocks([p]), /lock/);
  release();
  const release2 = acquireLocks([p]);
  release2();
  rmSync(d, { recursive: true, force: true });
});

test("classifyGenerated covers install/noop/repair/update/conflict", () => {
  const d = scratch();
  const p = join(d, "def.md");
  // install: not recorded, absent
  assert.equal(classifyGenerated(p, "aaa", undefined), "install");
  // write it, record digest bbb
  writeFileSync(p, "content-b");
  const bbb = sha256(Buffer.from("content-b"));
  // noop: recorded, on-disk equals new
  assert.equal(classifyGenerated(p, bbb, { digest: bbb }), "noop");
  // update: recorded old digest matches on-disk, new digest differs
  assert.equal(classifyGenerated(p, "new", { digest: bbb }), "update");
  // conflict: recorded, on-disk differs from both recorded and new (user edit)
  assert.equal(classifyGenerated(p, "new", { digest: "old-different" }), "conflict");
  // conflict: unowned differing content
  assert.equal(classifyGenerated(p, "new", undefined), "conflict");
  rmSync(d, { recursive: true, force: true });
});

test("classifyGenerated repairs a missing owned file even at same version", () => {
  const d = scratch();
  const p = join(d, "gone.md");
  assert.equal(classifyGenerated(p, "any", { digest: "recorded" }), "repair");
  rmSync(d, { recursive: true, force: true });
});

test("applyGenerated refuses a conflict without force and overwrites with force", () => {
  const d = scratch();
  const p = join(d, "c.md");
  writeFileSync(p, "user-edit");
  const content = "package-new";
  const digest = sha256(Buffer.from(content));
  assert.throws(
    () => applyGenerated({ absPath: p, content, digest, recordedEntry: { digest: "old" }, force: false }),
    /--force/,
  );
  const res = applyGenerated({ absPath: p, content, digest, recordedEntry: { digest: "old" }, force: true });
  assert.equal(res.action, "forced");
  rmSync(d, { recursive: true, force: true });
});

// Open()'s mode is masked by the umask, so atomicWrite sets the declared mode itself.
test("atomicWrite gives the declared mode whatever the umask", () => {
  const d = scratch();
  const old = process.umask(0o077); // a hardened operator host
  try {
    const f = join(d, "definition.md");
    atomicWrite(f, "x", { mode: 0o644 });
    assert.equal(statSync(f).mode & 0o777, 0o644);
  } finally {
    process.umask(old);
  }
  const old2 = process.umask(0o000); // and a permissive one: a secret stays 0600
  try {
    const secretDir = join(d, "creds");
    mkdirSync(secretDir, { mode: 0o700 });
    chmodSync(secretDir, 0o700);
    const f = join(secretDir, "role.env");
    atomicWrite(f, "x", { mode: 0o600, secret: true });
    assert.equal(statSync(f).mode & 0o777, 0o600);
  } finally {
    process.umask(old2);
  }
  rmSync(d, { recursive: true, force: true });
});

test("ensurePrivateCredentialDir creates exactly 0700 whatever the umask, and leaves an existing dir alone", () => {
  const d = scratch();
  const made = join(d, "creds");
  const old = process.umask(0o177); // would strip the owner-execute bit from mkdir
  try {
    ensurePrivateCredentialDir(made);
  } finally {
    process.umask(old);
  }
  assert.equal(statSync(made).mode & 0o777, 0o700, "a created credentials dir is exactly 0700");
  // An existing dir is not touched: forcing its mode would mask the non-private
  // dir the credential pre-check exists to refuse.
  const existing = join(d, "existing");
  mkdirSync(existing, { recursive: true });
  chmodSync(existing, 0o755);
  ensurePrivateCredentialDir(existing);
  assert.equal(statSync(existing).mode & 0o777, 0o755, "an existing dir keeps its mode");
  rmSync(d, { recursive: true, force: true });
});

test("ensurePrivateCredentialDir forces 0700 on every missing ancestor under an exotic umask", () => {
  const d = scratch();
  const previous = process.umask(0o177); // would leave every plain mkdir 0600
  try {
    const deep = join(d, "missing-base", ".config", "vbcdx", "credentials");
    ensurePrivateCredentialDir(deep);
    for (const dir of [
      join(d, "missing-base"),
      join(d, "missing-base", ".config"),
      join(d, "missing-base", ".config", "vbcdx"),
      deep,
    ]) {
      assert.equal(statSync(dir).mode & 0o777, 0o700, `${dir} is exactly 0700`);
    }
  } finally {
    process.umask(previous);
    rmSync(d, { recursive: true, force: true });
  }
});

test("removeManagedFile surfaces an object that reappears across the unlink", () => {
  const d = scratch();
  const p = join(d, "managed.txt");
  writeFileSync(p, "original", { mode: 0o600 });
  assert.throws(
    () => removeManagedFile(p, {
      unlinkSync: (target) => { unlinkSync(target); writeFileSync(target, "swapped"); },
    }),
    /reappeared/,
  );
  rmSync(d, { recursive: true, force: true });
});

test("removeManagedFile fails closed on an unconfirmable post-unlink stat", () => {
  const d = scratch();
  const p = join(d, "managed.txt");
  writeFileSync(p, "original", { mode: 0o600 });
  // First lstat is the pre-unlink re-stat; the second (post-unlink) fails with
  // EACCES, which does NOT prove removal — it must surface, never return true.
  let calls = 0;
  assert.throws(
    () => removeManagedFile(p, {
      lstatSync: (target) => {
        calls += 1;
        if (calls === 2) {
          const err = new Error("denied");
          err.code = "EACCES";
          throw err;
        }
        return lstatSync(target);
      },
    }),
    /could not confirm removal \(EACCES\)/,
  );
  // ENOENT is the one error that proves removal: a real unlink still returns true.
  const gone = join(d, "gone.txt");
  writeFileSync(gone, "x", { mode: 0o600 });
  assert.equal(removeManagedFile(gone), true, "a real removal still returns true");
  rmSync(d, { recursive: true, force: true });
});
