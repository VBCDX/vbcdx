// Installer coverage, fourth batch: behaviour tests for the plan executor.
// The target is marked in the test's comment, in the shape the earlier batches use.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildPlan, parseInitArgs } from "../src/index.js";
import { executePlan } from "../src/executor.js";
import { parseEnvFile } from "../src/config/env-parser.js";
import { FIXTURE_IDS } from "./helpers/fixture-pack.js";
import { tempDir } from "./helpers/temp-dir.js";

const ROLE_ID = FIXTURE_IDS[0];
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// A temp install of one role on the claude harness, with the manifest path its plan uses.
function install() {
  const root = tempDir("vbcdx-cov-executor-");
  const cfg = join(root, "config.env");
  writeFileSync(cfg, [
    `VBCDX_AGENTS_BASE_DIR=${join(root, "state")}`,
    `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${join(root, "claude")}`,
    "",
  ].join("\n"));
  const manifestPath = join(root, "state", "manifests", "installation.json");
  const agentsDir = join(root, "claude", "agents");
  const leftover = join(agentsDir, "old-agent.md");
  const plan = (more = []) => buildPlan(parseInitArgs([`--harness=claude`, `--env=${cfg}`, `--agents=${ROLE_ID}`, ...more]), parseEnvFile(cfg));
  return { root, manifestPath, agentsDir, leftover, plan };
}

// A manifest recording one file a previous render wrote for this role and target.
function recordLeftover(manifestPath, leftover, content) {
  mkdirSync(dirname(manifestPath), { recursive: true });
  const entry = { digest: sha256(content), mode: 0o644, role: ROLE_ID, harness: "claude", package_version: "0.1.0" };
  const manifest = { schema_version: 1, package: "@vbcdx/vbcdx", package_version: "0.1.0", files: { [leftover]: entry } };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

// src/executor.js 108
test("a forced dry run reports a hand-edited leftover as forced, and deletes nothing", () => {
  const i = install();
  const original = "written by an earlier render\n";
  recordLeftover(i.manifestPath, i.leftover, original);
  mkdirSync(i.agentsDir, { recursive: true });
  writeFileSync(i.leftover, original);
  const edited = original + "a line the operator added\n";
  writeFileSync(i.leftover, edited);

  const dry = executePlan(i.plan(["--dry-run"]));
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.removals, [{ role: ROLE_ID, destination: i.leftover, action: "conflict" }]);
  assert.deepEqual(dry.conflicts, [i.leftover]);

  // With --force the same dry run reports what a real run would do to it.
  const forced = executePlan(i.plan(["--dry-run", "--force"]));
  assert.deepEqual(forced.removals, [{ role: ROLE_ID, destination: i.leftover, action: "forced" }]);
  assert.deepEqual(forced.conflicts, []);
  assert.equal(readFileSync(i.leftover, "utf8"), edited, "a dry run deletes nothing, even with --force");
});
