// The command-line entrypoint's own branches: the removed `init` command, a skill removal
// that must not be blocked by an unreadable installed pack, a filesystem failure in `fetch`
// that is not an InstallerError, and the code a service command returns. Each case runs the
// real executable in a private home and asserts the exit status, the output and what was
// written, so a branch that stops refusing (or stops working) is caught.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.js";
import { PACK_ARG } from "./helpers/fixture-pack.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "vbcdx.js");
const TOOL_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tool-package");
const run = (args, home) => spawnSync(process.execPath, [BIN, ...args], {
  encoding: "utf8",
  cwd: home,
  env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, XDG_RUNTIME_DIR: home },
});

test("the removed init command is refused, naming both replacements, exit 2", () => {
  // bin/vbcdx.js:278-280
  const home = tempDir("vbcdx-cov-cli-");
  const r = run(["init"], home);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stderr, "error: `vbcdx init` does not exist; use `vbcdx install agent`, or the deprecated `vbcdx-dev-agents init`.\n");
  assert.equal(r.stdout, "");
});

test("an unreadable installed pack does not block removing an installed skill", () => {
  // bin/vbcdx.js:326-327
  const home = tempDir("vbcdx-cov-cli-");
  // The installed name (the skill's own frontmatter name): a removal that cannot read the
  // catalogue builds the path from the typed name, so it must be the name install recorded.
  const name = "writing-notes-example";
  // install refuses a user-scope home with no harness configuration (src/install/context.js:65).
  mkdirSync(join(home, ".claude"));
  const first = run(["install", "skill", name, "--harness=claude", PACK_ARG], home);
  assert.equal(first.status, 0, first.stderr);
  const skillDir = join(home, ".claude", "skills", name);
  assert.equal(existsSync(join(skillDir, "SKILL.md")), true, first.stderr);
  const pack = join(home, "node_modules", "unreadable-pack");
  mkdirSync(pack, { recursive: true });
  writeFileSync(join(pack, "package.json"), JSON.stringify({ name: "unreadable-pack" }));
  writeFileSync(join(pack, "vbcdx-pack.json"), "{not json");
  const removed = run(["remove", "skill", name, "--harness=claude"], home);
  assert.equal(removed.status, 0, removed.stderr);
  assert.ok(!removed.stderr.includes("error:"), removed.stderr);
  assert.equal(existsSync(skillDir), false, "the installed skill directory is gone");
});

test("a fetch failure that is not an InstallerError exits 4 and writes no lock", () => {
  // bin/vbcdx.js:372-374
  const home = tempDir("vbcdx-cov-cli-");
  const src = join(home, "src");
  mkdirSync(src);
  const store = join(home, "store");
  writeFileSync(store, ""); // a regular file where the store directory has to go
  const sources = join(src, "vbcdx.sources.json");
  writeFileSync(sources, JSON.stringify({ schema_version: 1, sources: { "acme-dir": { dir: join(src, "tree") } } }));
  const lock = join(src, "vbcdx.lock.json");
  const r = run(["fetch", `--sources=${sources}`, `--lock=${lock}`, `--store=${store}`], home);
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /^error: EEXIST: /);
  assert.equal(existsSync(lock), false, "no lock is written when the store cannot be made");
});

test("list services prints its report and returns the service command's code", () => {
  // bin/vbcdx.js:263
  const home = tempDir("vbcdx-cov-cli-");
  const r = run(["list", "services", "--json"], home);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.ok(Array.isArray(report.services), r.stdout);
});

// bin/vbcdx.js:146: an explicit --env file makes the config root explicit, so install agent
// keeps the launch variable the operator must export and prints it.
test("install agent prints the launch environment for an explicit config root", () => {
  const home = tempDir("vbcdx-cov-cli-");
  const root = join(home, "cc");
  mkdirSync(root, { recursive: true });
  const envFile = join(home, "agents.env");
  writeFileSync(envFile, `VBCDX_AGENTS_BASE_DIR=${join(home, "state")}\nVBCDX_AGENTS_CLAUDE_CONFIG_DIR=${root}\n`);
  const r = run(["install", "agent", "all", "--harness=claude", `--env=${envFile}`, PACK_ARG], home);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.split("\n").includes(`  launch with CLAUDE_CONFIG_DIR=${root}`), r.stdout);
});

// bin/vbcdx.js:149-151: `list` is the report shape that carries tools, agents and skills;
// install tool, install agent and install skill fill the manifest it reads, and each report
// line is asserted with the exact spacing human() prints.
test("list prints the installed tool, agent and skill report lines", () => {
  const home = tempDir("vbcdx-cov-cli-");
  mkdirSync(join(home, ".claude"));
  const tool = run(["install", "tool", TOOL_FIXTURE, "--harness=claude"], home);
  assert.equal(tool.status, 0, tool.stderr);
  const agents = run(["install", "agent", "all", "--harness=claude", PACK_ARG], home);
  assert.equal(agents.status, 0, agents.stderr);
  const skill = run(["install", "skill", "writing-notes-example", "--harness=claude", PACK_ARG], home);
  assert.equal(skill.status, 0, skill.stderr);
  const r = run(["list", "--harness=claude"], home);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Installed for claude \(manifest .*\):$/m);
  assert.match(r.stdout, /^ {2}tool {2}example-tracker {2}@example\/tracker-plugin@1\.2\.3 {2}user:\S+ {2}2 tools {2}\S+$/m);
  assert.match(r.stdout, /^ {2}agent [a-z0-9-]+ {2}\d+ file\(s\)$/m);
  assert.match(r.stdout, /^ {2}skill writing-notes-example {2}\S+$/m);
});

// bin/vbcdx.js:290 + 299: fetch --json prints the report as JSON, and sources prints the
// lock's sources as text (the non-JSON arm) in the same shape the lock recorded.
test("fetch --json prints JSON and sources prints the lock as text", () => {
  const home = tempDir("vbcdx-cov-cli-");
  const src = join(home, "src");
  mkdirSync(src);
  const tree = join(src, "tree");
  cpSync(TOOL_FIXTURE, tree, { recursive: true });
  const sources = join(src, "vbcdx.sources.json");
  writeFileSync(sources, JSON.stringify({ schema_version: 1, sources: { "acme-dir": { dir: tree } } }));
  const lock = join(src, "vbcdx.lock.json");
  const store = join(home, "store");

  const fetched = run(["fetch", "--json", `--sources=${sources}`, `--lock=${lock}`, `--store=${store}`], home);
  assert.equal(fetched.status, 0, fetched.stderr);
  const report = JSON.parse(fetched.stdout);
  assert.equal(report.lock, lock);
  assert.equal(report.store, store);
  assert.deepEqual(report.sources.map((s) => s.name), ["acme-dir"]);
  assert.deepEqual(report.sources[0].kinds, ["tool"]);

  const listed = run(["sources", `--lock=${lock}`], home);
  assert.equal(listed.status, 0, listed.stderr);
  const [head] = listed.stdout.split("\n");
  assert.equal(head, `Lock ${lock}`);
  assert.match(listed.stdout, /^ {2}source acme-dir \(tool\): dir .* \(sha256:[0-9a-f]{64}\)$/m);
  assert.notEqual(listed.stdout.trimStart()[0], "{");
});
