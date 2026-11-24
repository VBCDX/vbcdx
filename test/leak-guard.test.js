// The package is universal: nothing in the repository names one deployment.
//
// The rules live in one place, ci/general-use/scan.mjs (the general-use gate CI runs on every
// pull request and push). This file calls it over a wider set than the gate's: every tracked
// file plus every file npm publishes, so a file that is ignored by git but shipped by `files`
// is read too. It holds no pattern of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scanRepo, selfTest, trackedFiles } from "../ci/general-use/scan.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// What npm publishes: the `files` entries (directories walked), the files npm always
// includes, and .env.example. packs/ is the A2A image's build context, which holds only
// its README in the repository.
function shippedFiles() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const roots = [...pkg.files, "package.json", "README.md", "LICENSE", ".env.example"];
  const out = new Set();
  const walk = (p) => {
    if (statSync(p).isDirectory()) for (const e of readdirSync(p)) walk(join(p, e));
    else out.add(relative(ROOT, p));
  };
  for (const r of roots) if (existsSync(join(ROOT, r))) walk(join(ROOT, r));
  return [...out].sort();
}

test("the rule set passes its own self-test", () => {
  assert.deepEqual(selfTest(), []);
});

test("the walk covers what npm ships, including the plugin, the schemas and .env.example", () => {
  const files = new Set([...trackedFiles(ROOT), ...shippedFiles()]);
  for (const f of [
    ".env.example", "README.md", "package.json", "bin/vbcdx-dev-agents.js", "src/renderers/hermes.js",
    "assets/hermes/plugins/web-litellm-search/__init__.py", "assets/hermes/plugins/web-litellm-search/plugin.yaml",
    "schema/vbcdx-pack.schema.json", "schema/vbcdx-role.schema.json", "src/packs/load.js",
  ]) assert.ok(files.has(f), `${f} is walked`);
});

test("no tracked or shipped file names a deployment, and no first-party name is special-cased", () => {
  const cfg = (name) => readFileSync(join(ROOT, "ci", "general-use", name), "utf8");
  const r = scanRepo({ root: ROOT, allowText: cfg("allow.txt"), firstPartyText: cfg("first-party.txt"), extraFiles: shippedFiles() });
  assert.ok(r.files >= shippedFiles().length, "every shipped file was scanned");
  // Where and which class only: the line's text is never part of the failure message.
  assert.deepEqual(r.hits.map((h) => `${h.where} [${h.cls}]`), []);
  assert.deepEqual(r.refused, []);
});
