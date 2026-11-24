// Install coverage, fifth batch: the version this package stamps on what it writes, when its
// own package.json cannot be read. `readPkgVersion()` (`src/executor.js:26-32`) resolves the
// file from `import.meta.url`, so the run has to happen in a copy of the package. The copy is
// imported while its package.json is still valid — Node reads it to load the module, and an
// invalid one stops the import — and the file is broken afterwards, which is when the executor
// reads it (once per run, at `:91`).
//
// The copy covers the invalid-JSON shape but cannot credit the line: scripts/coverage.mjs
// (`measuredPath`, :83-93) only keeps scripts under this repo's bin/ and src/, so a report
// from a temp copy is dropped. The second test runs the shipped module in place and makes its
// own read throw (EACCES) through `t.mock` + `syncBuiltinESMExports`, the pattern the service
// tests already use (test/service-apply.test.js:948, test/coverage-v1-apply.test.js:794);
// this keeps the copy test as belt-and-braces rather than the only evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { cpSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDir } from "./helpers/temp-dir.js";
import { FIXTURE_IDS, FIXTURE_PACK_DIR } from "./helpers/fixture-pack.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The config a run reads: state and harness config under `root`, so nothing touches the real home.
function configAt(root) {
  const cfg = join(root, "config.env");
  writeFileSync(cfg, [
    `VBCDX_AGENTS_BASE_DIR=${join(root, "state")}`,
    `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${join(root, "claude")}`,
    "",
  ].join("\n"));
  return cfg;
}

// A copy of this package: what the loaded modules read at run time (src/, schema/ at
// src/packs/load.js:24-29, package.json), bin/ for a complete package, and the real
// node_modules linked in, so the copy renders through the same two dependencies.
function copiedPackage(name) {
  const root = tempDir(`vbcdx-exec-version-${name}-`);
  for (const dir of ["bin", "schema", "src"]) cpSync(join(ROOT, dir), join(root, dir), { recursive: true });
  cpSync(join(ROOT, "package.json"), join(root, "package.json"));
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"), "dir");
  return { root, cfg: configAt(root), manifestPath: join(root, "state", "manifests", "installation.json") };
}

const run = (mod, cfg) =>
  mod.init([`--pack=${FIXTURE_PACK_DIR}`, "--harness=claude", `--env=${cfg}`, `--agents=${FIXTURE_IDS[0]}`]);

// src/executor.js:29-31
test("a package.json that no longer parses stamps the fallback version on the next run", async () => {
  const copy = copiedPackage("broken");
  const mod = await import(pathToFileURL(join(copy.root, "src", "index.js")).href);

  // Control: with the copy's own package.json in place, the run stamps the version it holds.
  run(mod, copy.cfg);
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(JSON.parse(readFileSync(copy.manifestPath, "utf8")).package_version, version);
  assert.notEqual(version, "0.0.0", "the real package has a version");

  // Make the copy's package.json unparseable, after its modules are loaded, and run again: the
  // executor reads the file on every run, so this is the catch, and the run still completes.
  writeFileSync(join(copy.root, "package.json"), "{ not json");
  const report = run(mod, copy.cfg);
  assert.ok(report.generated.length > 0, "the run still completes");
  assert.equal(JSON.parse(readFileSync(copy.manifestPath, "utf8")).package_version, "0.0.0");
});

// src/executor.js:30-31, in place: the shipped module's own read of its own package.json fails.
// EACCES, not invalid JSON: the catch has to handle every read error, and this is the shape a
// copy on disk cannot produce without changing the file's permissions under the repo.
test("the shipped executor stamps the fallback version when its own package.json read fails", async (t) => {
  const mod = await import(pathToFileURL(join(ROOT, "src", "index.js")).href);
  const root = tempDir("vbcdx-exec-version-inplace-");
  const cfg = configAt(root);
  const manifestPath = join(root, "state", "manifests", "installation.json");

  // Control: with its own file readable, the shipped module stamps the version it holds.
  run(mod, cfg);
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).package_version, version);
  assert.notEqual(version, "0.0.0", "the real package has a version");

  // Only this package's own package.json fails; every other read in the run is delegated.
  const own = join(ROOT, "package.json");
  const real = fs.readFileSync;
  let hits = 0;
  t.mock.method(fs, "readFileSync", (path, ...rest) => {
    if (String(path) === own) {
      hits += 1;
      throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: "EACCES" });
    }
    return real(path, ...rest);
  });
  syncBuiltinESMExports();
  let report;
  try {
    report = run(mod, cfg);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(hits, 1, "the executor read its own package.json exactly once");
  assert.ok(report.generated.length > 0, "the run still completes");
  assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).package_version, "0.0.0");
});
