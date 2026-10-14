// Shared safe writer (spec section 9).
//
// Every managed mutation in the installer — generated definitions, credential
// files, staged plans, the manifest — goes through this module. It is the one
// place that enforces path safety, ownership, permissions, atomicity, and
// locking, so no caller can accidentally follow a symlink, widen a secret's
// mode, or leave a half-written file behind.
//
// Guarantees:
//   * No path component of a managed destination is a symlink (checked before
//     and again at mutation time to defeat TOCTOU swaps).
//   * Existing regular targets are owned by the effective user; secret files
//     additionally require 0600 in a 0700 parent, and the restrictive mode is
//     applied to the temp file BEFORE any secret content is written. These
//     checks read an OPEN DESCRIPTOR (fstat) opened O_NOFOLLOW, not a re-resolved
//     path, so the object validated is provably the object opened (TOCTOU-safe).
//   * Writes are atomic: content goes to a same-directory temp file, is fsynced
//     and renamed over the destination. A failure cleans up its temp file.
//   * Locks are exclusive per destination, acquired in a stable (sorted) order
//     to avoid deadlock; dry-run takes no lock and performs no write.
//
// This module never removes a directory recursively and never deletes files it
// did not create. Multi-file operations are NOT globally transactional and this
// module does not pretend otherwise; callers report partial effects.

import {
  openSync, closeSync, writeSync, fsyncSync, fchmodSync, renameSync, unlinkSync, mkdirSync,
  lstatSync, fstatSync, readFileSync, existsSync, constants as fsc,
} from "node:fs";
import { dirname, join, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { filesystemError } from "../errors.js";

export function isPosix() {
  return typeof process.getuid === "function";
}

function requirePosix() {
  if (!isPosix()) {
    throw filesystemError(
      "This installer's filesystem-safety guarantees require a POSIX platform; other platforms are unsupported in v1.",
    );
  }
}

export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/** Reject a path that is not an absolute path or contains a `..` component. */
export function assertManagedPath(absPath) {
  if (typeof absPath !== "string" || !isAbsolute(absPath)) {
    throw filesystemError(`Managed path must be absolute: ${String(absPath)}`);
  }
  const parts = absPath.split(sep);
  if (parts.some((p) => p === "..")) {
    throw filesystemError(`Managed path must not contain '..': ${absPath}`);
  }
}

/**
 * Walk the existing prefix of an absolute path and reject any symlink
 * component. The destination itself may be absent; if present it must be a
 * regular file (checked by the caller). Returns nothing; throws on violation.
 */
export function assertNoSymlinkComponents(absPath) {
  assertManagedPath(absPath);
  const parts = absPath.split(sep).filter(Boolean);
  let cur = sep;
  for (let i = 0; i < parts.length; i++) {
    cur = i === 0 ? sep + parts[0] : join(cur, parts[i]);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      return; // component does not exist yet; nothing below it can either
    }
    if (st.isSymbolicLink()) {
      throw filesystemError(`Refusing to traverse a symlink path component: ${cur}`);
    }
  }
}

/** Ensure a directory exists with the given mode, creating parents safely. */
export function ensureDir(absDir, mode = 0o755) {
  assertNoSymlinkComponents(absDir);
  mkdirSync(absDir, { recursive: true, mode });
}

/**
 * Create a private credentials directory and force its mode to exactly 0700
 * when THIS call creates it, so the process umask cannot leave it without the
 * owner-execute bit the 0700 contract requires (the exact-mode precedent
 * for files is). An EXISTING directory is left untouched: the credential
 * pre-check must still see and refuse a non-private one, so forcing the
 * mode here would mask exactly the failure that check exists for.
 */
export function ensurePrivateCredentialDir(absDir) {
  if (existsSync(absDir)) return;
  assertNoSymlinkComponents(absDir);
  // mkdirSync's mode is umask-masked, and a recursive mkdir descends into the
  // masked ancestor it just created — under umask 0177 that ancestor is 0600
  // (no owner-execute), so the recursion wedges with EACCES and reproduces
  // the same symptom one level up (the documented layout has a
  // not-yet-existing parent). Create the missing chain ONE component at a
  // time, oldest first, forcing 0700 through a descriptor before descending —
  // the exact-mode precedent is the one for files.
  const created = [];
  for (let cur = absDir; !existsSync(cur); cur = dirname(cur)) {
    created.push(cur);
    if (dirname(cur) === cur) break;
  }
  for (const dir of created.reverse()) {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      if (err && err.code === "EEXIST") continue; // created concurrently; leave it untouched
      throw err;
    }
    let fd;
    try {
      fd = openSync(dir, fsc.O_RDONLY | fsc.O_DIRECTORY | fsc.O_NOFOLLOW);
      fchmodSync(fd, 0o700);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

/**
 * Validate that `dir` is a real directory of mode 0700 owned by the effective
 * user, inspecting an OPEN DIRECTORY DESCRIPTOR (fstat) rather than re-resolving
 * the path with lstat. O_NOFOLLOW rejects a symlinked directory and O_DIRECTORY
 * rejects a non-directory atomically at open() — so a component swapped in after
 * an earlier path walk cannot redirect what we check (fd-based TOCTOU defence,
 * issue). `badModeMsg`/`badOwnerMsg` let each caller keep its own wording.
 */
function validateSecretDir(dir, { badModeMsg, badOwnerMsg }) {
  let fd;
  try {
    fd = openSync(dir, fsc.O_RDONLY | fsc.O_DIRECTORY | fsc.O_NOFOLLOW);
  } catch (err) {
    // A symlinked dir (ELOOP), a non-directory (ENOTDIR), an unreadable dir
    // (EACCES — therefore not a readable 0700 dir) or an absent one (ENOENT)
    // all fail the private-directory requirement.
    if (err && ["ELOOP", "ENOTDIR", "EACCES", "ENOENT"].includes(err.code)) {
      throw filesystemError(badModeMsg);
    }
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if ((st.mode & 0o777) !== 0o700) throw filesystemError(badModeMsg);
    if (st.uid !== process.getuid()) throw filesystemError(badOwnerMsg);
    return st;
  } finally {
    closeSync(fd);
  }
}

/**
 * The private-parent rule atomicWrite applies before writing a secret: a real 0700
 * directory owned by the effective user. Exported so the installer's pre-check can
 * apply the same rule before the first write.
 */
export function assertPrivateCredentialDir(dir) {
  const msg = `Credential directory must be a private 0700 dir owned by you: ${dir}`;
  validateSecretDir(dir, { badModeMsg: msg, badOwnerMsg: msg });
}

/**
 * Map an open() failure from validateExistingFile's O_NOFOLLOW|O_NONBLOCK open
 * into the friendly symlink refusal, or return the error unchanged for the caller
 * to rethrow. Returns the error to throw rather than throwing so the mapping is a
 * pure, directly-callable unit.
 *
 * This is redundant defence-in-depth, the same class as assertRegularDestination:
 * on a static filesystem assertNoSymlinkComponents rejects a symlinked terminal
 * component before open() is ever reached, so the ELOOP branch fires only in the
 * TOCTOU window where a symlink is swapped in after the walk and before the open.
 * That race is not deterministically reproducible in-process, so — mirroring the
 * fix that isolated assertRegularDestination — the mapping lives here as a
 * mutation-observable unit with a direct test (see test/safe-writer.test.js). A
 * future edit that drops the remap (rethrowing raw ELOOP) then fails that test
 * instead of silently degrading the swapped-in-symlink message.
 */
export function symlinkRefusalFor(err, absPath) {
  if (err && err.code === "ELOOP") return filesystemError(`Refusing a symlink: ${absPath}`);
  return err;
}

/**
 * Validate an existing regular file for managed update/retention: it must be a
 * regular (non-symlink) file owned by the effective user. When `secret` is
 * true, require mode 0600 and a 0700 immediate parent. Returns the fstat.
 *
 * The file is opened O_RDONLY|O_NOFOLLOW and validated via fstat on that open
 * descriptor, not via a second lstat of the path: the object we check is
 * provably the object the descriptor names, closing the TOCTOU window where a
 * component is swapped between the path walk above and the check.
 * O_NOFOLLOW makes a symlinked terminal component fail atomically at open().
 * assertNoSymlinkComponents still runs first because O_NOFOLLOW only guards the
 * terminal component, not intermediate directories.
 *
 * O_NONBLOCK is required in addition to O_NOFOLLOW: O_NOFOLLOW rejects a symlink
 * but a FIFO is not a symlink, so open(fifo, O_RDONLY) would block indefinitely
 * waiting for a writer. O_NONBLOCK is a no-op for a regular file and makes a FIFO
 * (or a device with no reader) fail promptly, so the "Not a regular file" check
 * below is reached instead of the call hanging — matching the pre-fd lstat
 * behaviour. validateSecretDir dodges this separately via O_DIRECTORY.
 */
export function validateExistingFile(absPath, { secret = false } = {}) {
  requirePosix();
  assertNoSymlinkComponents(absPath);
  let fd;
  try {
    fd = openSync(absPath, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  } catch (err) {
    throw symlinkRefusalFor(err, absPath);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw filesystemError(`Not a regular file: ${absPath}`);
    if (st.uid !== process.getuid()) {
      throw filesystemError(`File is not owned by the effective user: ${absPath}`);
    }
    if (secret) {
      const perm = st.mode & 0o777;
      if (perm !== 0o600) {
        throw filesystemError(`Credential file must be mode 0600: ${absPath}`);
      }
      const parent = dirname(absPath);
      validateSecretDir(parent, {
        badModeMsg: `Credential directory must be mode 0700: ${parent}`,
        badOwnerMsg: `Credential directory is not owned by the effective user: ${parent}`,
      });
    }
    return st;
  } finally {
    closeSync(fd);
  }
}

/**
 * Reject a destination that, at mutation time, is a symlink or a non-regular
 * file. `existing` is the destination's lstat, or null when it is absent.
 *
 * This is DELIBERATE, redundant defence-in-depth — not dead code. On a static
 * filesystem the symlink branch is already unreachable: assertNoSymlinkComponents
 * walks and rejects a symlinked terminal component before atomicWrite ever lstats
 * the destination, so removing this branch fails no attack test (that is exactly
 * the coverage gap it was raised for). The branch exists only to close the
 * TOCTOU window where a symlink is swapped in AFTER that walk and BEFORE the
 * write. Do not delete it as "unreachable": it is exercised directly by a unit
 * test (see test/safe-writer.test.js), so a future edit that breaks it is caught.
 */
export function assertRegularDestination(existing, absPath) {
  if (existing && existing.isSymbolicLink()) {
    throw filesystemError(`Refusing to overwrite a symlink: ${absPath}`);
  }
  if (existing && !existing.isFile()) {
    throw filesystemError(`Refusing to overwrite a non-regular file: ${absPath}`);
  }
}

/**
 * Atomically write content to an absolute destination.
 *
 * @param {string} absPath  destination
 * @param {string|Buffer} content
 * @param {object} [opts]
 * @param {number} [opts.mode=0o644] final file mode; applied to the temp file
 *   before content is written so a secret never briefly exists world-readable
 * @param {boolean} [opts.secret=false] enforce a private parent directory
 * @returns {{digest: string, bytes: number}}
 */
export function atomicWrite(absPath, content, { mode = 0o644, secret = false } = {}) {
  requirePosix();
  assertNoSymlinkComponents(absPath);
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  const dir = dirname(absPath);
  // Re-validate the destination at mutation time to defeat a component swapped in
  // after assertNoSymlinkComponents walked the path. See assertRegularDestination
  // for why this redundant guard is kept and how it is tested.
  let existing;
  try {
    existing = lstatSync(absPath);
  } catch {
    existing = null;
  }
  assertRegularDestination(existing, absPath);
  if (secret) {
    // fd-based (fstat) re-check of the private parent directory.
    assertPrivateCredentialDir(dir);
  }
  const tmp = join(dir, `.vbcdx-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let fd;
  try {
    // O_EXCL: never follow/clobber an existing temp; create with the final mode.
    fd = openSync(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, mode);
    // open()'s mode is masked by the process umask; set the declared mode exactly, so a
    // 0644 definition is 0644 and a 0600 credential 0600 whatever the operator's umask.
    fchmodSync(fd, mode);
    writeSync(fd, buf);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, absPath);
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { unlinkSync(tmp); } catch { /* ignore: temp may not exist */ }
    if (err && err.code && err.code.startsWith("E")) {
      throw filesystemError(`Failed to write ${absPath}: ${err.code}.`);
    }
    throw err;
  }
  return { digest: sha256(buf), bytes: buf.length };
}

/**
 * Remove a managed file — one the installer wrote and the current render no longer
 * produces. Like every other managed mutation it goes through the
 * no-follow rules above: the path walk rejects a symlinked component and the file
 * is opened O_NOFOLLOW and validated by fstat (a regular file, owned by the
 * effective user) before it is unlinked, so a directory, a symlink, a FIFO, or
 * another user's file is refused and never removed.
 *
 * The window between the validation and the unlink is the same one atomicWrite
 * closes with its rename: an object swapped in by a process that can already write
 * this directory. A path-based unlink cannot be made atomic (node:fs offers no
 * fd-relative unlink), so the window is NARROWED rather than closed: the
 * path walk and an ownership/regular-file stat are re-run immediately before the
 * unlink, and the path is re-checked after it. A swap that still slips through and
 * leaves an object behind is surfaced loudly instead of reported as success.
 * Nothing outside the manifest-derived candidate set is ever passed in.
 *
 * @returns {boolean} true when a file was removed, false when it was already gone
 */
export function removeManagedFile(absPath, deps = {}) {
  const unlink = deps.unlinkSync || unlinkSync;
  const lstat = deps.lstatSync || lstatSync;
  requirePosix();
  assertNoSymlinkComponents(absPath);
  try {
    validateExistingFile(absPath);
  } catch (err) {
    if (err && err.code === "ENOENT") return false; // already gone: nothing to remove
    throw err;
  }
  // Narrow the validation -> unlink window: re-walk and re-stat the target
  // immediately before the unlink, so a component swapped in after the fd-based
  // check is not what gets removed.
  assertNoSymlinkComponents(absPath);
  let st;
  try {
    st = lstat(absPath);
  } catch (err) {
    if (err && err.code === "ENOENT") return false; // already gone: nothing to remove
    throw err;
  }
  if (!st.isFile() || st.uid !== process.getuid()) {
    throw filesystemError(`Refusing to remove ${absPath}: it is no longer the validated regular file.`);
  }
  try {
    unlink(absPath);
  } catch (err) {
    if (err && err.code === "ENOENT") return false; // already gone: nothing to remove
    throw filesystemError(`Failed to remove ${absPath}: ${err && err.code ? err.code : "error"}.`);
  }
  // Detect a swap across the unlink: if an object is at the path again, the
  // removal did not provably remove what was validated — surface it, never "removed".
  try {
    lstat(absPath);
  } catch (err) {
    if (err && err.code === "ENOENT") return true; // provably gone
    throw filesystemError(`Removed ${absPath} but could not confirm removal (${err && err.code ? err.code : "error"}); investigate.`);
  }
  throw filesystemError(`Removed ${absPath} but an object reappeared at that path; investigate.`);
}

/** Read a file and return its sha256 digest, or null if absent. */
export function digestOf(absPath) {
  try {
    return sha256(readFileSync(absPath));
  } catch {
    return null;
  }
}

// ── Exclusive locks ─────────────────────────────────────────────────────────

/**
 * Acquire exclusive lockfiles for a set of destinations, in a stable sorted
 * order to avoid deadlock. Returns a release() function. Dry-run callers must
 * not call this. A lockfile is `<path>.lock` created with O_EXCL.
 */
export function acquireLocks(paths) {
  requirePosix();
  const ordered = [...new Set(paths)].sort();
  const held = [];
  try {
    for (const p of ordered) {
      assertNoSymlinkComponents(p);
      ensureDir(dirname(p));
      const lock = `${p}.lock`;
      let fd;
      try {
        fd = openSync(lock, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o600);
      } catch (err) {
        if (err && err.code === "EEXIST") {
          throw filesystemError(`Another operation holds the lock for ${p}; retry after it releases.`);
        }
        throw filesystemError(`Cannot acquire lock for ${p}: ${err.code || "error"}.`);
      }
      writeSync(fd, Buffer.from(`${process.pid}\n`));
      closeSync(fd);
      held.push(lock);
    }
  } catch (err) {
    for (const lock of held.reverse()) {
      try { unlinkSync(lock); } catch { /* ignore */ }
    }
    throw err;
  }
  return function release() {
    for (const lock of held.reverse()) {
      try { unlinkSync(lock); } catch { /* ignore */ }
    }
  };
}
