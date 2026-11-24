// Install coverage, fifth batch: behaviour tests for uncovered ranges (see each test's comment).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.js";
import { readLock, lockedSource } from "../src/sources/lock.js";
import { treeDigest } from "../src/sources/tree.js";
import { EXIT } from "../src/errors.js";

const SHA = "b".repeat(40);

// A lock on disk, read back through readLock so its own digest check is the real one. Each
// source gets a store directory of its own; `packageJson` is what a tool or pack ships there.
function lockOf(root, entries) {
  const sources = {};
  for (const [name, { kinds, packageJson }] of Object.entries(entries)) {
    const dir = join(root, "store", `${name}@${SHA}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "payload.txt"), "x\n");
    if (packageJson) writeFileSync(join(dir, "package.json"), JSON.stringify(packageJson));
    sources[name] = {
      kinds,
      git: "https://example.invalid/acme/pack.git",
      ref: "main",
      sha: SHA,
      path: `${name}@${SHA}`,
      digest: treeDigest(dir),
    };
  }
  const lockPath = join(root, "vbcdx.lock.json");
  writeFileSync(lockPath, JSON.stringify({ schema_version: 1, store: "store", sources }));
  return readLock(lockPath);
}

function thrownBy(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail("expected the call to throw");
  return undefined;
}

test("a missing source is refused by name, with the article the noun takes and the kind's own listing", () => {
  // src/sources/lock.js:103
  const lock = lockOf(tempDir("vbcdx-cov-lock-"), { agents: { kinds: ["agents"] } });
  const none = `in the lock ${lock.path} (it has: none); with --lock, nothing else is searched.`;

  const a = thrownBy(() => lockedSource(lock, "thing", "tool", "tool package"));
  assert.equal(a.code, EXIT.CONFIG);
  assert.equal(a.message, `thing is not a tool package ${none}`);

  const an = thrownBy(() => lockedSource(lock, "thing", "overlay", "overlay"));
  assert.equal(an.code, EXIT.CONFIG);
  assert.equal(an.message, `thing is not an overlay ${none}`);

  // The same lock lists what it does hold for the kind that is asked for, and an "a" noun.
  assert.equal(
    thrownBy(() => lockedSource(lock, "thing", "agents", "agent pack")).message,
    `thing is not an agent pack in the lock ${lock.path} (it has: agents); with --lock, nothing else is searched.`,
  );
});

test("a source is found by the package name it holds, not only by its own name", () => {
  // src/sources/lock.js:96 and :101
  const lock = lockOf(tempDir("vbcdx-cov-lock-"), {
    other: { kinds: ["agents"], packageJson: { name: "@example/other-pack", version: "1.0.0" } },
    mine: { kinds: ["agents"], packageJson: { name: "@example/agent-pack", version: "1.0.0" } },
  });
  const found = lockedSource(lock, "@example/agent-pack", "agents", "agent pack");
  assert.equal(found.name, "mine");
  assert.equal(found.absDir, join(lock.store, `mine@${SHA}`));
});

test("two sources holding the same package name are refused rather than guessed at", () => {
  // src/sources/lock.js:101 — a second match is not a choice.
  const root = tempDir("vbcdx-cov-lock-");
  const lock = lockOf(root, {
    one: { kinds: ["agents"], packageJson: { name: "@example/agent-pack", version: "1.0.0" } },
    two: { kinds: ["agents"], packageJson: { name: "@example/agent-pack", version: "1.0.0" } },
  });
  const err = thrownBy(() => lockedSource(lock, "@example/agent-pack", "agents", "agent pack"));
  assert.equal(err.code, EXIT.CONFIG);
  assert.equal(
    err.message,
    `@example/agent-pack is not an agent pack in the lock ${lock.path} (it has: one, two); with --lock, nothing else is searched.`,
  );
});
