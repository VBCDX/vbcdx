// Shared safe writer (spec section 9).
//
// Every managed mutation in the installer — generated definitions, staged plans,
// the manifest — goes through this module. It is the one place that enforces path
// safety, ownership, permissions, atomicity, and locking, so no caller can
// accidentally follow a symlink or leave a half-written file behind. It writes no
// credential file: the installer has none to write.
//
// Guarantees:
//   * No path component of a managed destination is a symlink (checked before
//     and again at mutation time to defeat TOCTOU swaps).
//   * Existing regular targets are owned by the effective user, and a file's mode is
//     applied to the temp file BEFORE any content is written. The ownership check
//     reads an OPEN DESCRIPTOR (fstat) opened O_NOFOLLOW, not a re-resolved
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
  lstatSync, fstatSync, readFileSync, existsSync, linkSync, constants as fsc,
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
 * regular (non-symlink) file owned by the effective user. Returns the fstat.
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
 * behaviour.
 */
export function validateExistingFile(absPath) {
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
 *   before content is written, so a 0600 file never briefly exists world-readable
 * @returns {{digest: string, bytes: number}}
 */
export function atomicWrite(absPath, content, { mode = 0o644 } = {}) {
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
  const tmp = join(dir, `.vbcdx-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let fd;
  try {
    // O_EXCL: never follow/clobber an existing temp; create with the final mode.
    fd = openSync(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, mode);
    // open()'s mode is masked by the process umask; set the declared mode exactly, so a
    // 0644 definition is 0644 and a 0600 config file 0600 whatever the operator's umask.
    fchmodSync(fd, mode);
    writeSync(fd, buf);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, absPath);
  } catch (err) {
    discardTemp(fd, tmp);
    // Every call above raises an Error with a `code` starting with E: an fs errno (EACCES, EFBIG,
    // EIO, ...) or a Node validation code (ERR_INVALID_ARG_TYPE, ...). So this is the only way out:
    // a failed write is never reported as the success return below.
    throw filesystemError(`Failed to write ${absPath}: ${err.code}.`);
  }
  return { digest: sha256(buf), bytes: buf.length };
}

/**
 * Clean up after a failed write: close the descriptor if the failure left one open, then remove
 * the temp file. The write already failed, so neither step may replace the error the caller is
 * about to raise: a close of a descriptor that is already closed and an unlink of a temp that is
 * already gone are both ignored.
 *
 * Both steps are real syscalls and each arm has a real input. An error after the descriptor was
 * closed (`fd = undefined` before the rename) reaches the unlink with the temp still present; a
 * failed open reaches it with no descriptor and no temp; and a descriptor closed twice or a temp
 * removed twice fails with EBADF / ENOENT, which is swallowed here exactly as it must be.
 */
export function discardTemp(fd, tmp) {
  if (fd !== undefined) {
    try { closeSync(fd); } catch { /* ignore: the write already failed; this is cleanup */ }
  }
  try { unlinkSync(tmp); } catch { /* ignore: temp may not exist */ }
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

// A lock holds "<pid> <start time>\n": the start time (/proc/<pid>/stat field 22, clock ticks
// since boot) tells a live holder from a later process that reused its PID. Where /proc is
// absent, and in a lock from before this format, only the PID is there: a live PID then counts
// as the holder. Liveness is `kill(pid, 0)`, so this assumes every run that shares a lock is in
// one PID namespace (a holder in another one would look dead).
export function procStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command (field 2) is in parentheses and may hold spaces; the fields after it are plain.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] || null;
  } catch {
    return null;
  }
}
// The holder as a message may show it: never its full argv (which can hold another process's
// secrets once a PID is reused), only the program name, plus the subcommand words when it is
// vbcdx; control characters stripped, length capped.
export function holderCommand(argv) {
  if (!argv.length) return null;
  const base = (a) => a.split("/").pop();
  const at = argv.findIndex((a) => /^vbcdx(\.js)?$/.test(base(a)));
  const words = at >= 0 ? ["vbcdx", ...argv.slice(at + 1).filter((a) => /^[a-z][a-z-]*$/.test(a)).slice(0, 4)] : [base(argv[0])];
  return words.join(" ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 80) || null;
}
export function procCommand(pid) {
  try {
    return holderCommand(readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean));
  } catch {
    return null;
  }
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // alive, owned by someone else
  }
}
// An empty lock this young may be one a live process created and hasn't written yet (O_EXCL
// create, then the write): it's never taken over before this age.
export const LOCK_FRESH_MS = 5000;

// A lock's identity and bytes, read without following a symlink or blocking on a FIFO.
function readLock(lock) {
  const st = lstatSync(lock);
  if (!st.isFile()) return { st, text: null };
  const fd = openSync(lock, fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK);
  try {
    return { st, text: readFileSync(fd, "utf8") };
  } finally {
    closeSync(fd);
  }
}

/**
 * Who holds a lock file: {state: "free"} when there is none; {state: "stale", pid, reason, ino}
 * when its holder can't be alive (its PID is dead, its start time shows the PID was reused, or it
 * is empty and older than LOCK_FRESH_MS); otherwise {state: "held", pid, command, ageMs}. Anything
 * else (a non-regular file, content in no format this version reads, a PID of 0) is held: refusing
 * is the safe side. Reads only; dry runs use it too.
 */
export function lockHolder(lock, { now = Date.now() } = {}) {
  let r;
  try {
    r = readLock(lock);
  } catch (e) {
    if (e && e.code === "ENOENT") return { state: "free" };
    throw e;
  }
  const ageMs = Math.max(0, now - r.st.mtimeMs);
  const held = (extra = {}) => ({ state: "held", pid: null, command: null, ageMs, ...extra });
  if (r.text === null) return held({ note: "not a regular file" });
  if (r.text === "") return ageMs < LOCK_FRESH_MS ? held() : { state: "stale", pid: null, reason: "it names no process", ino: r.st.ino };
  const m = /^(\d+)(?: (\d+))?\n?$/.exec(r.text);
  if (!m || Number(m[1]) <= 0) return held({ note: "in a format this version doesn't read" });
  const pid = Number(m[1]);
  if (!pidAlive(pid)) return { state: "stale", pid, reason: `process ${pid} is not running`, ino: r.st.ino };
  const recorded = m[2] || null;
  const now0 = procStart(pid);
  if (recorded && now0 && recorded !== now0) return { state: "stale", pid, reason: `PID ${pid} now belongs to another process`, ino: r.st.ino };
  // A lock without a start time (written before it was recorded) can't tell a reused PID from its
  // holder, so a live PID there is taken as the holder.
  return held({ pid, command: procCommand(pid) });
}

function heldMessage(p, h) {
  const who = h.pid ? `process ${h.pid}${h.command ? ` (${h.command})` : ""}` : `another process${h.note ? ` (the lock is ${h.note})` : ""}`;
  return `Another operation holds the lock for ${p}: ${who}, for ${Math.round(h.ageMs / 1000)} s. Retry after it finishes.`;
}

const defaultOnStale = (s) => process.stderr.write(`warning: took over the lock for ${s.path}: ${s.reason}.\n`);
const ownToken = () => {
  const start = procStart(process.pid);
  return start ? `${process.pid} ${start}\n` : `${process.pid}\n`;
};
// Remove a lock only while it still carries this process's own token: never one another run
// holds now.
function removeOwn(lock, token) {
  try {
    const r = readLock(lock);
    if (r.text === token) unlinkSync(lock);
  } catch { /* gone already, or not ours */ }
}

/**
 * Remove the file a takeover renamed aside. It can no longer be the lock (it was renamed, so the
 * lock path is free), and a removal can still fail for real: a directory at that path (unlink(2)
 * refuses one with EISDIR), a mode change, an immutable bit set by an operator, an EIO or NFS
 * fault, a concurrent run. The run can then go on, so this warns on stderr and leaves the file for
 * the operator instead of failing the takeover. Every unlink(2) failure carries an errno (a bad
 * argument becomes a Node ERR_* code), so the warning always names one.
 */
export function removeAside(aside) {
  try {
    unlinkSync(aside);
  } catch (e) {
    process.stderr.write(`warning: could not remove ${aside} (${e.code}); remove it by hand.\n`);
  }
}

/**
 * Take over a stale lock, or say why not. Only one run takes over at a time: the takeover is done
 * under a second O_EXCL lock, `<lock>.takeover`, and the lock is judged again under it. A fresh
 * acquirer can't create the lock meanwhile (the stale file is still there), and no other taker
 * can act, so the file renamed aside is the one judged stale; its inode is checked all the same,
 * and put back if it isn't. Returns the stale verdict when it took the lock over; throws otherwise.
 * A `.takeover` left by a run killed mid-takeover is never removed automatically (that would need
 * the same guard again): the error names both files to remove by hand.
 */
function takeOver(p, lock, token, hooks) {
  const mutex = `${lock}.takeover`;
  let mfd;
  try {
    mfd = openSync(mutex, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o600);
  } catch (e) {
    if (!e || e.code !== "EEXIST") throw filesystemError(`Cannot take over the stale lock for ${p}: ${(e && e.code) || "error"}.`);
    const mh = lockHolder(mutex);
    if (mh.state === "stale") {
      throw filesystemError(`A takeover of the stale lock for ${p} was interrupted (${mh.reason}). Remove ${lock} and ${mutex} by hand, then retry.`);
    }
    throw filesystemError(`Another run is taking over the stale lock for ${p}; retry after it finishes.`);
  }
  writeSync(mfd, Buffer.from(token));
  closeSync(mfd);
  try {
    if (hooks.underTakeover) hooks.underTakeover(lock);
    const h = lockHolder(lock);
    if (h.state === "free") return null; // the caller tries O_EXCL again
    if (h.state !== "stale") throw filesystemError(heldMessage(p, h));
    const aside = `${lock}.stale-${process.pid}-${Date.now()}`;
    if (hooks.beforeRename) hooks.beforeRename(lock);
    renameSync(lock, aside);
    if (lstatSync(aside).ino !== h.ino) {
      // Not the file judged stale (impossible under the takeover lock, but never remove a live one).
      try { linkSync(aside, lock); unlinkSync(aside); } catch { /* the path was retaken: leave both */ }
      throw filesystemError(`The lock for ${p} changed during takeover; retry.`);
    }
    removeAside(aside);
    return h;
  } finally {
    removeOwn(mutex, token);
  }
}

/**
 * Acquire exclusive lockfiles for a set of destinations, in a stable sorted
 * order to avoid deadlock. Returns a release() function. Dry-run callers must
 * not call this. A lockfile is `<path>.lock` created with O_EXCL, holding this
 * process's `<pid> <start time>`; release removes only a lock that still holds it.
 *
 * A lock whose holder can't be alive (lockHolder: stale) is taken over (see takeOver), and
 * `onStale` ({path, pid, reason}) is told; by default a warning goes to stderr. `hooks`
 * (afterJudge, underTakeover, beforeRename, afterTakeover) is a test seam only: a step injected
 * between the judgement and the takeover, to test the interleavings.
 */
export function acquireLocks(paths, { onStale = defaultOnStale, hooks = {} } = {}) {
  requirePosix();
  const ordered = [...new Set(paths)].sort();
  const held = [];
  const token = ownToken();
  try {
    for (const p of ordered) {
      assertNoSymlinkComponents(p);
      ensureDir(dirname(p));
      const lock = `${p}.lock`;
      let fd;
      for (let attempt = 0; fd === undefined; attempt++) {
        if (attempt > 2) throw filesystemError(`Cannot acquire lock for ${p}: it keeps changing; retry.`);
        try {
          fd = openSync(lock, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o600);
        } catch (err) {
          if (!err || err.code !== "EEXIST") throw filesystemError(`Cannot acquire lock for ${p}: ${(err && err.code) || "error"}.`);
          const h = lockHolder(lock);
          if (h.state === "free") continue;
          if (h.state !== "stale") throw filesystemError(heldMessage(p, h));
          if (hooks.afterJudge) hooks.afterJudge(lock);
          const taken = takeOver(p, lock, token, hooks);
          if (taken) onStale({ path: p, pid: taken.pid, reason: taken.reason });
          if (hooks.afterTakeover) hooks.afterTakeover(lock);
        }
      }
      writeSync(fd, Buffer.from(token));
      closeSync(fd);
      held.push(lock);
    }
  } catch (err) {
    for (const lock of held.reverse()) removeOwn(lock, token);
    throw err;
  }
  return function release() {
    for (const lock of held.reverse()) removeOwn(lock, token);
  };
}
