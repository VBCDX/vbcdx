// Installer coverage, fourth batch: behaviour tests for uncovered ranges (see each test's comment).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { join as pjoin } from "node:path";
import { tempDir } from "./helpers/temp-dir.js";
import "./helpers/fixture-pack.js";
import { loadIntegrations } from "../src/config/integrations.js";

describe("src/config/integrations.js coverage, part 1", () => {
  // Both targets below sit on the "cannot read" diagnostics of the trusted reader,
  // reached only through the single exported entry point that takes a path.
  const namesFileAndErrno = (absPath) => (err) => {
    assert.ok(err instanceof Error, "a real Error is thrown, not a bare string");
    assert.ok(err.message.includes(absPath), `the diagnostic names the file: ${err.message}`);
    assert.ok(err.message.includes("(ENOENT)"), `the diagnostic carries the errno code: ${err.message}`);
    assert.match(err.message, /^Cannot read /, `the diagnostic starts with the read wording: ${err.message}`);
    return true;
  };

  test("a missing parent directory is reported as a read error naming the absolute file", () => {
    // src/config/integrations.js 97
    const dir = tempDir("vbcdx-cov-integrations-");
    chmodSync(dir, 0o700);
    const absPath = pjoin(dir, "absent-dir", "integrations.json");
    assert.throws(() => loadIntegrations(absPath), namesFileAndErrno(absPath));
  });

  test("an absent file inside an owner-only directory is reported as a read error", () => {
    // src/config/integrations.js 105
    const dir = tempDir("vbcdx-cov-integrations-");
    chmodSync(dir, 0o700);
    const absPath = pjoin(dir, "absent-integrations.json");
    assert.throws(() => loadIntegrations(absPath), namesFileAndErrno(absPath));
  });

  test("the missing-file diagnostic is deterministic across two calls", () => {
    // src/config/integrations.js 105 (same branch, error is not thrown conditionally)
    const dir = tempDir("vbcdx-cov-integrations-");
    chmodSync(dir, 0o700);
    const absPath = pjoin(dir, "still-absent.json");
    let first;
    try {
      loadIntegrations(absPath);
      assert.fail("loadIntegrations must throw for an absent file");
    } catch (err) {
      first = err;
    }
    assert.throws(() => loadIntegrations(absPath), (err) => err.message === first.message);
  });
});
