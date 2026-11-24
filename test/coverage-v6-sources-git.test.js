// A git source at fetch time: what happens when the child cannot start at all, and when it
// starts but fails without writing to stderr. The child's environment is the module's only
// input, so a temp directory on PATH decides whether `git` exists and what it does; the
// refusal names the source's label and, with no output to quote, the exit status.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRef } from "../src/sources/git.js";
import { EXIT } from "../src/errors.js";
import { tempDir } from "./helpers/temp-dir.js";

const URL = "https://git.example.org/acme/r.git";
const LABEL = "source r";

/** The error a call refuses with; a failure when it returns instead. */
function refusal(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail("expected the call to refuse");
}

/** A temp `bin` holding one executable `git` that runs `body` and nothing else. */
function stubGit(body) {
  const bin = join(tempDir("vbcdx-cov-sources-git-"), "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "git"), 0o755);
  return bin;
}

test("a git that cannot be spawned is refused by label, with the spawn error", () => {
  const empty = tempDir("vbcdx-cov-sources-git-");
  // src/sources/git.js:62
  const err = refusal(() => resolveRef(URL, "main", { env: { PATH: empty }, label: LABEL }));
  assert.equal(err.message, `${LABEL}: git could not run (ENOENT).`);
  assert.equal(err.code, EXIT.CONFIG);
});

test("a git that fails with no output is refused by its exit status", () => {
  const env = { PATH: stubGit("exit 3") };
  // src/sources/git.js:55 — empty stderr takes the `text || ""` arm
  // src/sources/git.js:63 — an empty scrub result takes the `exit <status>` arm
  const err = refusal(() => resolveRef(URL, "main", { env, label: LABEL }));
  assert.equal(err.message, `${LABEL}: git ls-remote failed: exit 3`);
  assert.equal(err.code, EXIT.CONFIG);
});
