// The command-line entrypoints' remaining untaken branch arms. Each case runs the real
// executable in a private home and asserts the exit status, the output and what was
// written, so an arm that stops being taken (or starts printing the other side) fails.
//
// Arms covered here, by the file and line at the commit this file was written against:
//   bin/vbcdx.js:149          a legacy tool record with no config entry: the list row has no file
//   bin/vbcdx.js:223,224      --help on a command that has no help: no usage block is printed
//   bin/vbcdx.js:225          `config service --help`: the help belongs to the service area
//   bin/vbcdx.js:387          a skill with no frontmatter name: packs --json falls back to its id
//   bin/vbcdx-dev-agents.js:69  an init that binds integrations: the offline binding line
//   bin/vbcdx-dev-agents.js:72  a locked directory source: printed as dir, not as a git origin
//
// TWO ARMS ARE NOT HERE because no real invocation reaches them at this commit, without a
// product change:
//   bin/vbcdx.js:138  `if (report.command)` — no report object in src/ ever sets `command`
//                     (installTool's report carries package, version, server, tools, file,
//                     action; `launch` is on the manifest record, not the report).
//   bin/vbcdx.js:146  `report.launchEnv || {}` — every agent report's launchEnv comes from
//                     config.launchEnv, which is always an object (`{}` at minimum), so the
//                     fallback `{}` is never evaluated.
// Both need a product decision (dead code, or a producer), not a test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.js";
import { FIXTURE_PACK_DIR, PACK_ARG } from "./helpers/fixture-pack.js";
import { fetchSources } from "../src/sources/fetch.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "bin", "vbcdx.js");
const DEV_BIN = join(HERE, "..", "bin", "vbcdx-dev-agents.js");
const TOOL_FIXTURE = join(HERE, "fixtures", "tool-package");

// The integrations file is writable only by its owner, and its directory too
// (src/config/integrations.js). Pin the umask a CI runner has so a host whose umask
// is 002 (user private groups) does not make the file group-writable.
process.umask(0o022);

const env = (home) => ({ PATH: process.env.PATH, HOME: home, TMPDIR: home, XDG_RUNTIME_DIR: home });
const run = (args, home) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", cwd: home, env: env(home) });
const runDev = (args, home) => spawnSync(process.execPath, [DEV_BIN, ...args], { encoding: "utf8", cwd: home, env: env(home) });

test("list prints a tool row with no file for a record written before config entries were kept", () => {
  // bin/vbcdx.js:149, the `: ""` arm of the file suffix.
  const home = tempDir("vbcdx-cov-v7-list-");
  mkdirSync(join(home, ".claude"));
  const tool = run(["install", "tool", TOOL_FIXTURE, "--harness=claude"], home);
  assert.equal(tool.status, 0, tool.stderr);
  // A manifest from an earlier release records the tool but no `entries` key for it:
  // the src renderer test coverage-v2v3-g1-cmd-b.test.js seeds the same shape.
  const manifest = join(home, ".vbcdx", "manifests", "installation.json");
  const doc = JSON.parse(readFileSync(manifest, "utf8"));
  for (const rec of Object.values(doc.tools)) rec.entry = null;
  writeFileSync(manifest, JSON.stringify(doc, null, 2) + "\n");

  const r = run(["list", "--harness=claude"], home);
  assert.equal(r.status, 0, r.stderr);
  const row = r.stdout.split("\n").find((l) => l.startsWith("  tool  example-tracker "));
  assert.ok(row, r.stdout);
  assert.match(row, /  2 tools$/);
  assert.equal(row.includes(join(home, ".claude.json")), false, "a record with no entry prints no file");
});

test("--help on a command that has none prints no usage block and still refuses the command", () => {
  // bin/vbcdx.js:223 (the `: null` arm) and :224 (the early return it feeds).
  const home = tempDir("vbcdx-cov-v7-help-");
  const r = run(["bogus", "--help"], home);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^error: Unknown command: bogus\.$/m);
  assert.equal(r.stdout, "", "no usage block is printed for a command with no help");
});

test("config service --help is left to the service area, which refuses a missing service name", () => {
  // bin/vbcdx.js:225: `config` has help of its own, but `config service` does not.
  const home = tempDir("vbcdx-cov-v7-config-");
  const r = run(["config", "service", "--help"], home);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^error: config service takes the service name first: vbcdx config service sidecar /m);
  assert.equal(r.stdout, "", "the config help is not printed for the service form");
});

test("packs --json names a skill by its file id when its frontmatter has no name", () => {
  // bin/vbcdx.js:387, the `: id` arm.
  const home = tempDir("vbcdx-cov-v7-packs-");
  const pack = join(home, "pack");
  cpSync(FIXTURE_PACK_DIR, pack, { recursive: true });
  // No frontmatter at all, so frontmatter().name is undefined.
  writeFileSync(join(pack, "skills", "development", "NONAME.MD"), "# A skill file with no frontmatter\n");

  const r = run(["packs", `--pack=${pack}`, "--json"], home);
  assert.equal(r.status, 0, r.stderr);
  const skills = JSON.parse(r.stdout).packs.flatMap((p) => p.skills);
  const unnamed = skills.find((s) => s.file === "development/NONAME.MD");
  assert.ok(unnamed, r.stdout);
  assert.deepEqual({ name: unnamed.name, id: unnamed.id }, { name: "noname", id: "noname" });
  // The control: a skill that does carry a name still reports it, not its id.
  assert.equal(skills.find((s) => s.file.endsWith("WRITING-NOTES.MD")).name, "writing-notes-example");
});

// A private home with a config file the dev-agents entrypoint installs from.
function devHome() {
  const home = tempDir("vbcdx-cov-v7-dev-");
  const configDir = join(home, ".claude");
  mkdirSync(configDir);
  const cfg = join(home, "cfg.env");
  writeFileSync(cfg, [`VBCDX_AGENTS_BASE_DIR=${home}/state`, `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${configDir}`].join("\n") + "\n");
  return { home, cfg, configDir };
}

test("dev-agents init reports the integrations it binds in the offline line", () => {
  // bin/vbcdx-dev-agents.js:69.
  const { home, cfg } = devHome();
  const tool = (name) => ({ name, description: name, inputSchema: {}, outputSchema: {}, effect: "read", required_permissions: [] });
  const manifestFile = join(home, "tracker.manifest.json");
  writeFileSync(manifestFile, JSON.stringify({ schema_version: 1, service: "tracker", contract: "example.tracker/1", package_version: "0.1.0", tools: [tool("get_issue"), tool("whoami")] }));
  const integFile = join(home, "integrations.json");
  writeFileSync(integFile, JSON.stringify({ schema_version: 1, services: { tracker: { server_name: "tracker", manifest_file: manifestFile } } }));
  writeFileSync(cfg, readFileSync(cfg, "utf8") + `VBCDX_AGENTS_INTEGRATIONS_FILE=${integFile}\n`);

  const r = runDev(["init", "--harness=claude", `--env=${cfg}`, PACK_ARG], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}integrations bound \(offline\): tracker — runtime registration unverified$/m);
  assert.equal(existsSync(join(home, ".claude", "agents", "code-agent.md")), true, "the agents were written");
});

test("dev-agents init prints a locked directory source as dir with its digest, not a git origin", () => {
  // bin/vbcdx-dev-agents.js:72, the non-git side of the ternary.
  const { home, cfg } = devHome();
  const sourcesPath = join(home, "vbcdx.sources.json");
  writeFileSync(sourcesPath, JSON.stringify({ schema_version: 1, sources: { pack: { dir: FIXTURE_PACK_DIR } } }));
  const lockPath = join(home, "vbcdx.lock.json");
  const storeDir = join(home, "store");
  const fetched = fetchSources({ sourcesPath, lockPath, storeDir });
  assert.deepEqual(fetched.sources.map((s) => [s.name, s.kinds, s.sha]), [["pack", ["agents"], null]]);

  const r = runDev(["init", "--harness=claude", `--env=${cfg}`, `--lock=${lockPath}`], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^ {2}source pack: dir ${FIXTURE_PACK_DIR} \\(sha256:[0-9a-f]{64}\\)$`, "m"));
  assert.equal(/source pack: .* @ /.test(r.stdout), false, "a directory source has no git ref or commit");
  assert.equal(existsSync(join(home, ".claude", "agents", "code-agent.md")), true);
});
