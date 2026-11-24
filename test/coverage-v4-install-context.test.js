// The run context resolves directories for one harness and scope. These tests
// cover the two guards that refuse an unusable context before anything is read
// from the harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveContext } from "../src/install/context.js";
import { tempDir } from "./helpers/temp-dir.js";

test("without --env a missing or relative home is refused", () => {
  for (const home of ["", "relative/home"]) {
    assert.throws(
      () => resolveContext({ harness: "claude", scope: "user", envPath: null, home, env: {} }),
      (err) => {
        // src/install/context.js:57
        assert.equal(err.message, "Cannot find the home directory; pass --env=<absolute config file>.");
        return true;
      },
    );
  }
});

test("project scope outside a Git worktree is refused", () => {
  const home = tempDir("vbcdx-cov-context-home-");
  const cwd = tempDir("vbcdx-cov-context-work-");
  assert.throws(
    () => resolveContext({ harness: "claude", scope: "project", envPath: null, cwd, home, env: {} }),
    (err) => {
      // src/install/context.js:77
      assert.equal(err.message, "Project scope requires running inside a Git worktree; none was found.");
      return true;
    },
  );
});
