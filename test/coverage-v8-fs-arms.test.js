// Coverage for the remaining branches of src/fs/hermes-config.js and src/fs/safe-writer.js.
// Each case drives the exported caller the installer uses (classifyHermesConfig, acquireLocks,
// removeManagedFile) at the boundary the arm exists for, and asserts the visible result, so an
// arm that stops being taken, or starts reporting the other side, fails.
//
// Arms covered here, by file and line at the commit this file was written against:
//   hermes-config.js:71    a timestamp at an owned key digests as a timestamp, not as the
//                          map JSON would give it (so the two never collide)
//   hermes-config.js:76    an explicitly undefined value at an owned key digests as null, and
//                          still differs from an absent key
//   hermes-config.js:138   a read that fails with no errno: the message carries the error
//   hermes-config.js:162   an empty rendered config is the empty YAML document, not a crash
//   safe-writer.js:286     an unlink that fails with no errno is named "error"
//   safe-writer.js:447     a takeover mutex open that fails with no errno is named "error"
//   safe-writer.js:503     a lock open that fails with no errno is named "error"
//   safe-writer.js:505     the lock is removed between a failed O_EXCL open and the judge:
//                          the attempt is retried, not reported as another holder
//
// FIVE ARMS ARE NOT HERE because no real invocation reaches them at this commit, without a
// product change:
//   hermes-config.js:86    the equal-key arm of the path sort — only a duplicated owned_paths
//                          list reaches it, and it is inert: equal keys are byte-identical
//                          entries, so no inversion of the arm can change the digest and no
//                          test can fail on it. Taken-but-unpinnable, not a missing test.
//   hermes-config.js:144   a parse error with no message — the yaml package only throws
//                          Error instances carrying a message, and its ESM export cannot be
//                          stubbed from a test.
//   hermes-config.js:190   a merge error with no message — same: the only throws here are
//                          Error/YAMLParseError instances with a message.
//   safe-writer.js:320     a /proc/<pid>/stat with no field 22 — Linux always writes it.
//   safe-writer.js:405     no /proc start time — this host always has /proc.
// The two /proc arms are coverable only by mocking /proc itself; that is reported to the PM,
// not forced here.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.js";
import { EXIT } from "../src/errors.js";
import { classifyHermesConfig, ownedDigest } from "../src/fs/hermes-config.js";
import { parsePy } from "../src/fs/pyyaml.js";
import { acquireLocks, removeManagedFile } from "../src/fs/safe-writer.js";

function caught(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail("expected the call to throw");
}

// A PID that is certainly not running: a process that has already exited.
function deadPid() {
  const r = spawnSync("true");
  assert.equal(r.status, 0, r.stderr);
  return r.pid;
}

// Replace one node:fs export for the duration of `fn`. The filesystem is the boundary these
// arms defend; a temp dir cannot produce an errno-less failure or a lock that vanishes between
// two calls, and the suite reaches such shapes this way in coverage-v1-apply and
// coverage-v5-executor-package-version.
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

// ── hermes-config ───────────────────────────────────────────────────────────

test("a timestamp at an owned key does not digest like the map JSON writes for it", () => {
  // hermes-config.js:71, the PyTimestamp arm of canonical().
  const d = tempDir("vbcdx-cov-v8-hc-");
  const config = join(d, "config.yaml");
  // PyYAML writes a date unquoted, so a config the operator edited can hold one at an owned
  // key; the rendered value equal to it in JSON shape is a map with the source as a string.
  writeFileSync(config, "model: 2001-12-15\n");
  const rendered = 'model: {timestamp: "2001-12-15"}\n';

  // The tag exists so these two never share a digest: JSON.stringify of the timestamp (its
  // toJSON) is exactly the canonical form of that map.
  assert.notEqual(
    ownedDigest(parsePy("model: 2001-12-15\n"), [["model"]]),
    ownedDigest(parsePy(rendered), [["model"]]),
    "a timestamp and a map spelling the same text are different values",
  );

  // Driven through the real caller: because the digests differ, the on-disk file is not the
  // rendered one, so it is a conflict, not a noop. Taking the JSON fallback for the timestamp
  // would make the digests equal and classify it as having nothing to write.
  const r = classifyHermesConfig(config, rendered, undefined);
  assert.equal(r.cls, "conflict", r.note);
  assert.match(r.note, /^not recorded as written by the installer; /);
});

test("an explicitly undefined value at an owned key digests as null, not as absent", () => {
  // hermes-config.js:76, the `v === undefined ? null : v` arm of canonical()'s tail. No YAML
  // or JSON document can carry `undefined`, so this arm is reached through the exported digest
  // itself — the same call the test above makes — with the one shape the tail has to normalise
  // rather than let through, because `JSON.stringify(undefined)` is undefined and the digest
  // would otherwise carry the literal text.
  const atUndefined = ownedDigest({ model: undefined }, [["model"]]);
  assert.equal(atUndefined, ownedDigest({ model: null }, [["model"]]), "undefined digests as null");
  assert.notEqual(atUndefined, ownedDigest({}, [["model"]]), "and an absent key is not null");
});

test("a config read that fails with no errno names the error in the conflict note", (t) => {
  // hermes-config.js:138, the `: err` arm of the read reason.
  const d = tempDir("vbcdx-cov-v8-hc-");
  const config = join(d, "config.yaml");
  writeFileSync(config, "model: qwen3-14b\n");
  // A failure with no errno (as opposed to every readFileSync syscall error) has only its
  // message to report, so the reason must carry the error itself.
  const r = withFsMock(t, "readFileSync", (real, path, ...rest) => {
    if (String(path) === config) throw new Error("disk on fire");
    return real(path, ...rest);
  }, () => classifyHermesConfig(config, "model: qwen3-14b\n", undefined));

  assert.equal(r.cls, "conflict");
  assert.match(r.note, /^cannot be read \(Error: disk on fire\); --force replaces the whole file/);
});

test("an empty rendered config is the empty document: an install with no owned keys", () => {
  // hermes-config.js:162, the `|| {}` arm.
  const d = tempDir("vbcdx-cov-v8-hc-");
  // parsePy("") is null (an empty YAML document), so the classifier must fall back to {}.
  const r = classifyHermesConfig(join(d, "config.yaml"), "", undefined);
  assert.equal(r.cls, "install");
  assert.deepEqual(r.record.owned_paths, []);
  assert.equal(r.recordChanged, true, "a first install records the (empty) key list");
});

// ── safe-writer: removeManagedFile ──────────────────────────────────────────

test("an unlink that fails with no errno is reported as a generic error", () => {
  // safe-writer.js:286, the `: "error"` arm. The `unlinkSync` dep is the module's own seam.
  const d = tempDir("vbcdx-cov-v8-sw-");
  const p = join(d, "managed.txt");
  writeFileSync(p, "original", { mode: 0o600 });
  const err = caught(() => removeManagedFile(p, {
    unlinkSync: () => { throw new Error("disk on fire"); },
  }));
  assert.equal(err.code, EXIT.FILESYSTEM);
  assert.equal(err.message, `Failed to remove ${p}: error.`);
  assert.equal(readFileSync(p, "utf8"), "original", "nothing was removed");
});

// ── safe-writer: acquireLocks ───────────────────────────────────────────────

test("a takeover mutex open that fails with no errno names it 'error'", (t) => {
  // safe-writer.js:447, the `|| "error"` arm.
  const d = tempDir("vbcdx-cov-v8-sw-");
  const p = join(d, "installation.json");
  writeFileSync(`${p}.lock`, `${deadPid()} 1\n`);

  const err = withFsMock(t, "openSync", (real, path, ...rest) => {
    if (String(path) === `${p}.lock.takeover`) throw new Error("mutex boom");
    return real(path, ...rest);
  }, () => caught(() => acquireLocks([p], { onStale: () => {} })));

  assert.equal(err.code, EXIT.FILESYSTEM);
  assert.equal(err.message, `Cannot take over the stale lock for ${p}: error.`);
  assert.equal(existsSync(`${p}.lock`), true, "the stale lock is left for the operator");
});

test("a lock open that fails with no errno names it 'error'", (t) => {
  // safe-writer.js:503, the `|| "error"` arm.
  const d = tempDir("vbcdx-cov-v8-sw-");
  const p = join(d, "installation.json");

  const err = withFsMock(t, "openSync", (real, path, ...rest) => {
    if (String(path) === `${p}.lock`) throw new Error("lock boom");
    return real(path, ...rest);
  }, () => caught(() => acquireLocks([p], { onStale: () => {} })));

  assert.equal(err.code, EXIT.FILESYSTEM);
  assert.equal(err.message, `Cannot acquire lock for ${p}: error.`);
  assert.equal(existsSync(`${p}.lock`), false, "no lock was left behind");
});

test("a lock removed between the failed open and the judge is retried, not called held", (t) => {
  // safe-writer.js:505, the `continue` arm. The failed open reports EEXIST while no lock file
  // exists, which is exactly the interleaving where another run removed it in between.
  const d = tempDir("vbcdx-cov-v8-sw-");
  const p = join(d, "installation.json");
  let attempts = 0;
  const out = withFsMock(t, "openSync", (real, path, ...rest) => {
    if (String(path) === `${p}.lock`) {
      attempts += 1;
      if (attempts === 1) {
        const e = new Error("exists");
        e.code = "EEXIST";
        throw e;
      }
    }
    return real(path, ...rest);
  }, () => {
    const release = acquireLocks([p], { onStale: () => assert.fail("there is nothing to take over") });
    const held = existsSync(`${p}.lock`);
    const token = readFileSync(`${p}.lock`, "utf8");
    // readLock opens the lock too, so count the attempts while it is still held.
    const attemptsWhileHeld = attempts;
    release();
    return { attempts: attemptsWhileHeld, held, token, after: existsSync(`${p}.lock`) };
  });

  assert.equal(out.attempts, 2, "the open is retried once");
  assert.equal(out.held, true, "the retry acquires the lock");
  assert.match(out.token, new RegExp(`^${process.pid}( \\d+)?\\n$`));
  assert.equal(out.after, false, "release removes it");
});
