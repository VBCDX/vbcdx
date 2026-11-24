// Installer coverage, second batch, group 1: `remove` and `doctor` over hand-seeded manifest records.
// Each record is written through the real manifest reader/writer, keyed as the installer keys it, so
// every case reaches the branch through the exported commands and real files only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "./helpers/temp-dir.js";
import "./helpers/fixture-pack.js";
import { EXIT } from "../src/errors.js";
import { resolveContext } from "../src/install/context.js";
import { catalogueSkills, doctor, list, remove } from "../src/install/commands.js";
import { skillTarget } from "../src/install/harness-targets.js";
import { readManifest, writeManifest } from "../src/fs/manifest.js";
import { ownedDigest } from "../src/fs/hermes-config.js";
import { packageVersion } from "../src/index.js";

const ZERO = "0".repeat(64);
const SKILL_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKILL = catalogueSkills().find((s) => typeof s.name === "string" && SKILL_RE.test(s.name) && s.description).name;

function ctxFor(harness) {
  const home = tempDir("vbcdx-cov-rm-");
  return resolveContext({ harness, scope: "user", envPath: null, home, cwd: home, env: {} });
}
// The installer's own manifest, plus records; returns what was written.
function seed(ctx, { files = {}, entries = {}, tools = {} } = {}) {
  const m = readManifest(ctx.manifestPath, packageVersion());
  m.files = { ...m.files, ...files };
  m.entries = entries;
  m.tools = tools;
  mkdirSync(dirname(ctx.manifestPath), { recursive: true });
  writeManifest(ctx.manifestPath, m);
  return m;
}
const manifest = (ctx) => JSON.parse(readFileSync(ctx.manifestPath, "utf8"));
const toolKey = (ctx, server) => `${ctx.harness}:user:${ctx.config.harnessRoot}:${server}`;
const write = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
const isErr = (code, re) => (e) => e.code === code && re.test(e.message);

test("the fixture catalogue has an installable skill", () => {
  assert.equal(typeof SKILL, "string");
});

// commands.js 311 (a recorded file already gone is "absent") + 304 (its directory doesn't exist,
// so the empty-dir cleanup's read fails and is ignored): the record is dropped, nothing is created.
test("remove skill: a recorded file that is already gone is absent, and its record is dropped", () => {
  const ctx = ctxFor("claude");
  const dest = skillTarget(ctx, SKILL);
  seed(ctx, { files: { [dest]: { skill: SKILL, harness: "claude", digest: ZERO } } });
  const report = remove(ctx, "skill", SKILL);
  assert.deepEqual(report.removed, [{ path: dest, action: "absent" }]);
  assert.equal(dest in manifest(ctx).files, false);
  assert.equal(existsSync(dest), false);
});

// commands.js 322: an owned-keys record (a merged config) whose file is gone is absent.
test("remove skill: an owned-keys record whose file is gone is absent", () => {
  const ctx = ctxFor("claude");
  const dest = skillTarget(ctx, SKILL);
  seed(ctx, { files: { [dest]: { skill: SKILL, harness: "claude", owned_paths: [["vbcdx"]], owned_digest: ZERO } } });
  assert.deepEqual(remove(ctx, "skill", SKILL, { dryRun: true }).removed, [{ path: dest, action: "absent" }]);
});

// commands.js 328 + 412: a merged config that isn't YAML is a conflict, left untouched; a dry run
// lists it under `conflicts` (by path) instead of throwing, and a real run refuses (exit 5).
test("remove skill: an owned-keys file that isn't YAML conflicts; a dry run lists it, a real run refuses", () => {
  const ctx = ctxFor("claude");
  const dest = skillTarget(ctx, SKILL);
  const raw = "key: [unclosed\n";
  write(dest, raw);
  seed(ctx, { files: { [dest]: { skill: SKILL, harness: "claude", owned_paths: [["vbcdx"]], owned_digest: ZERO } } });
  const dry = remove(ctx, "skill", SKILL, { dryRun: true });
  assert.deepEqual(dry.conflicts, [dest]);
  assert.throws(() => remove(ctx, "skill", SKILL), isErr(EXIT.CONFLICT, /it cannot be read as YAML; left untouched/));
  assert.equal(readFileSync(dest, "utf8"), raw);
  assert.equal(dest in manifest(ctx).files, true);
});

// commands.js 333: an empty mapping holds no owned key; with the recorded digest of "nothing owned"
// and nothing left after the owned keys go, the file is deleted whole, not edited.
test("remove skill: an owned-keys file that is an empty mapping is deleted whole", () => {
  const ctx = ctxFor("claude");
  const dest = skillTarget(ctx, SKILL);
  const paths = [["vbcdx"]];
  write(dest, "{}\n");
  seed(ctx, { files: { [dest]: { skill: SKILL, harness: "claude", owned_paths: paths, owned_digest: ownedDigest({}, paths) } } });
  const report = remove(ctx, "skill", SKILL);
  assert.deepEqual(report.removed, [{ path: dest, action: "delete-file" }]);
  assert.equal(existsSync(dest), false);
});

// commands.js 334: an owned key edited since the install is a conflict that names it, refused
// without --force; with --force the owned keys are removed and the rest of the file is kept.
test("remove skill: an edited owned key conflicts; --force removes the owned keys and keeps the rest", () => {
  const ctx = ctxFor("claude");
  const dest = skillTarget(ctx, SKILL);
  const paths = [["vbcdx"]];
  write(dest, "vbcdx: edited\nkeep: me\n");
  seed(ctx, { files: { [dest]: { skill: SKILL, harness: "claude", owned_paths: paths, owned_digest: ownedDigest({ vbcdx: "as written" }, paths) } } });
  assert.throws(() => remove(ctx, "skill", SKILL), isErr(EXIT.CONFLICT, /a key the installer owns was edited; --force removes the owned keys anyway/));
  const forced = remove(ctx, "skill", SKILL, { force: true });
  assert.deepEqual(forced.removed, [{ path: dest, action: "forced" }]);
  const left = readFileSync(dest, "utf8");
  assert.match(left, /keep: me/);
  assert.doesNotMatch(left, /vbcdx:/);
});

// commands.js 415: a dry run with nothing blocked returns the plan and changes nothing.
test("remove skill --dry-run: nothing blocked returns the report and leaves the file and record", () => {
  const ctx = ctxFor("claude");
  const dest = skillTarget(ctx, SKILL);
  write(dest, "{}\n");
  seed(ctx, { files: { [dest]: { skill: SKILL, harness: "claude", owned_paths: [["vbcdx"]], owned_digest: ownedDigest({}, [["vbcdx"]]) } } });
  const report = remove(ctx, "skill", SKILL, { dryRun: true });
  assert.equal(report.dryRun, true);
  assert.equal(report.conflicts, undefined);
  assert.equal(report.removed.length, 1);
  assert.equal(existsSync(dest), true);
  assert.equal(dest in manifest(ctx).files, true);
});

// commands.js 390: a harness with no skill location refuses a skill removal (exit 5).
test("remove skill: a harness with no skill location refuses (exit 5)", () => {
  const ctx = ctxFor("hermes");
  seed(ctx);
  assert.throws(() => remove(ctx, "skill", SKILL), isErr(EXIT.CONFLICT, /^Skills are not supported for the hermes harness\.$/));
});

// commands.js 370: a tool recorded without a harness entry drops only its record.
test("remove tool: a record with no harness entry drops only the record", () => {
  const ctx = ctxFor("claude");
  const server = "example-tracker";
  seed(ctx, { tools: { [toolKey(ctx, server)]: { harness: "claude", server_name: server, package: "@example/tracker", scope: "user", tools: [], entry: null } } });
  const report = remove(ctx, "tool", server);
  assert.deepEqual(report.removed, []);
  assert.match(report.warnings[0], /rerun `vbcdx install agent` to rebind them/);
  assert.deepEqual(manifest(ctx).tools, {});
  assert.deepEqual(list(ctx).tools, []);
});

// commands.js 453 + 456 + 458: a tool whose package directory is gone and whose recorded entry id
// has no entry record: "package missing" and the entry "missing" with no file to name ("?").
test("doctor: a tool with no package.json and an entry id with no record reports both", () => {
  const ctx = ctxFor("claude");
  const dir = tempDir("vbcdx-cov-pkg-");
  seed(ctx, { tools: { [toolKey(ctx, "gone")]: { harness: "claude", server_name: "gone", package: "@example/gone", scope: "user", dir, tools: [], env: [], entry: "e1" } } });
  const out = doctor(ctx, { env: {} });
  const r = out.tools ? out.tools[0] : out.results[0];
  assert.equal(r.ok, false);
  assert.deepEqual(r.checks.find((c) => c.check === "package"), { check: "package", ok: false, detail: dir });
  assert.deepEqual(r.checks.find((c) => c.check === "harness entry"), { check: "harness entry", ok: false, detail: "?: missing" });
});

// commands.js 457: an entry edited since the install is reported as "edited".
test("doctor: a harness entry edited since the install is reported as edited", () => {
  const ctx = ctxFor("claude");
  const dir = tempDir("vbcdx-cov-pkg-");
  const file = join(ctx.home, "config.json");
  write(file, JSON.stringify({ mcpServers: { edited: { command: "changed" } } }));
  seed(ctx, {
    entries: { e1: { file, format: "json", path: ["mcpServers", "edited"], digest: ZERO } },
    tools: { [toolKey(ctx, "edited")]: { harness: "claude", server_name: "edited", package: "@example/edited", scope: "user", dir, tools: [], env: [], entry: "e1" } },
  });
  const out = doctor(ctx, { env: {} });
  const r = out.tools ? out.tools[0] : out.results[0];
  assert.deepEqual(r.checks.find((c) => c.check === "harness entry"), { check: "harness entry", ok: false, detail: `${file}: edited` });
});

// commands.js 403: a kind other than agent, skill or tool is refused (exit 2), naming it.
test("remove: an unknown kind is refused (exit 2)", () => {
  const ctx = ctxFor("claude");
  seed(ctx);
  assert.throws(() => remove(ctx, "plugin", "x"), isErr(EXIT.CONFIG, /^Unknown kind "plugin": use agent, skill or tool\.$/));
});

// commands.js 453: a missing package alone (no harness entry, no variables) makes the tool not ok.
test("doctor: a missing package by itself makes the tool not ok", () => {
  const ctx = ctxFor("claude");
  const dir = tempDir("vbcdx-cov-pkg-");
  seed(ctx, { tools: { [toolKey(ctx, "lonely")]: { harness: "claude", server_name: "lonely", package: "@example/lonely", scope: "user", dir, tools: [], env: [], entry: null } } });
  const out = doctor(ctx, { env: {} });
  const r = out.tools ? out.tools[0] : out.results[0];
  assert.deepEqual(r.checks.map((c) => [c.check, c.ok]), [["package", false]]);
  assert.equal(r.ok, false);
});
