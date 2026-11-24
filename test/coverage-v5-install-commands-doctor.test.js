// Installer coverage, wave five: what doctor() reports when the installed package is gone
// (commands.js 473-474) or its declaration no longer validates (496-497). Both cases are
// reached the way doctor itself reads them: the package as it is now, not as it was recorded.
//
// The manifest-command catch (504-505) is already covered by test/install-95.test.js:639, and
// the keyed-tool record (514-516) by test/sealed-path-only.test.js:838-878, so neither is
// duplicated here.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { doctor, installTool } from "../src/install/commands.js";
import { resolveContext } from "../src/install/context.js";
import { tempDir } from "./helpers/temp-dir.js";

const TOOL_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tool-package");

describe("src/install/commands.js coverage, part 5: doctor", () => {
  // A user-scope context with the default root: installTool writes the entry into
  // <home>/.claude.json, and doctor reads the manifest it recorded.
  const ctxFor = (home) => resolveContext({ harness: "claude", scope: "user", envPath: null, home, cwd: home, env: {} });
  const env = { EXAMPLE_TRACKER_URL: "https://tracker.example.com" };
  const install = (home) => {
    const pkgDir = join(home, "pkg");
    cpSync(TOOL_FIXTURE, pkgDir, { recursive: true });
    installTool(ctxFor(home), pkgDir);
    return pkgDir;
  };

  // commands.js 473-474: the package.json the record names is gone.
  test("doctor reports a package that is gone", () => {
    const home = tempDir("vbcdx-cov-doctor-");
    const pkgDir = install(home);
    rmSync(join(pkgDir, "package.json"));
    const report = doctor(ctxFor(home), { env });
    const tool = report.tools[0];
    assert.deepEqual(tool.checks.find((c) => c.check === "package"), { check: "package", ok: false, detail: pkgDir });
    assert.equal(tool.checks.some((c) => c.check === "declaration"), false, "a missing package is not read");
    assert.equal(tool.checks.some((c) => c.check === "manifest"), false, "a missing package is not run");
    assert.equal(tool.ok, false);
    assert.equal(report.ok, false);
  });

  // commands.js 496-497: the package is still there but its declaration no longer validates,
  // so the recorded check reports the first line of the refusal and nothing is run.
  test("doctor reports a declaration that no longer validates", () => {
    const home = tempDir("vbcdx-cov-doctor-");
    const pkgDir = install(home);
    const declPath = join(pkgDir, "vbcdx.json");
    const declaration = JSON.parse(readFileSync(declPath, "utf8"));
    delete declaration.manifest;
    writeFileSync(declPath, JSON.stringify(declaration));
    const report = doctor(ctxFor(home), { env });
    const tool = report.tools[0];
    const checks = Object.fromEntries(tool.checks.map((c) => [c.check, c]));
    assert.equal(checks.declaration.ok, false);
    assert.match(checks.declaration.detail, /^Invalid tool declaration .*vbcdx\.json:$/);
    assert.equal(checks.manifest, undefined, "an invalid package is not run");
    assert.deepEqual(tool.checks.filter((c) => !c.ok).map((c) => c.check), ["declaration"], "the only failed check");
    assert.equal(tool.ok, false);
    assert.equal(report.ok, false);
  });
});
