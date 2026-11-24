// Installer coverage, second batch, group 1: behaviour tests for uncovered ranges (see each test's comment).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buildPlan, planRemovals } from "../src/planner.js";
import { buildCatalog, setActiveCatalog } from "../src/packs/catalog.js";
import { EXIT } from "../src/errors.js";
import { FIXTURE_IDS } from "./helpers/fixture-pack.js";
import { tempDir } from "./helpers/temp-dir.js";

describe("src/planner.js coverage, part 1", () => {
  const idsOf = (v) => (v && typeof v === "object" ? Object.values(v).flatMap(idsOf) : [v]);
  const ROLE_ID = idsOf(FIXTURE_IDS).find((v) => typeof v === "string");

  // src/planner.js 122
  test("planRemovals returns no candidate when the render produced nothing", () => {
    const plan = { roles: [ROLE_ID], generated: [] };
    const manifest = {
      files: { "render/old.txt": { role: ROLE_ID, harness: "claude", digest: "d0" } },
    };
    assert.deepEqual(planRemovals(plan, manifest), []);
  });

  // src/planner.js 130
  test("planRemovals drops every candidate when the render paths share no common root", () => {
    const disjoint = {
      roles: [ROLE_ID],
      generated: [
        { destination: "alpha/build/one.txt", role: ROLE_ID, harness: "claude" },
        { destination: "beta/build/two.txt", role: ROLE_ID, harness: "claude" },
      ],
    };
    const stale = {
      files: { "alpha/build/old.txt": { role: ROLE_ID, harness: "claude", digest: "d1" } },
    };
    assert.deepEqual(planRemovals(disjoint, stale), []);

    const shared = {
      roles: [ROLE_ID],
      generated: [{ destination: "shared/build/new.txt", role: ROLE_ID, harness: "claude" }],
    };
    const staleShared = {
      files: { "shared/build/old.txt": { role: ROLE_ID, harness: "claude", digest: "d2" } },
    };
    assert.deepEqual(planRemovals(shared, staleShared), [
      { role: ROLE_ID, destination: "shared/build/old.txt", digest: "d2" },
    ]);
  });

  // src/planner.js 165
  test("planRemovals treats a manifest without a files record as having none", () => {
    const plan = {
      roles: [ROLE_ID],
      generated: [{ destination: "shared/build/new.txt", role: ROLE_ID, harness: "claude" }],
    };
    assert.deepEqual(planRemovals(plan, {}), []);
    assert.deepEqual(planRemovals(plan, { files: null }), []);
  });

  // src/planner.js 50 — the "none" arm, taken when no loaded pack supplied a role.
  test("an unknown agent ID says no role is loaded when the catalogue holds none", () => {
    const root = tempDir("vbcdx-cov-planner-");
    const entries = new Map([
      ["VBCDX_AGENTS_BASE_DIR", join(root, "state")],
      ["VBCDX_AGENTS_CLAUDE_CONFIG_DIR", join(root, "claude")],
    ]);
    const previous = setActiveCatalog(buildCatalog([]));
    try {
      assert.throws(
        () => buildPlan({ harness: "claude", scope: "user", agents: ["not-a-role"], force: false, dryRun: false }, entries),
        (err) => {
          assert.equal(err.code, EXIT.CONFIG, err.message);
          assert.equal(
            err.message,
            "Unknown agent ID in selection: not-a-role (not a role of a loaded agent pack). The loaded roles are: none; `vbcdx packs` lists them by pack.",
          );
          return true;
        },
      );
    } finally {
      setActiveCatalog(previous);
    }
  });
});
