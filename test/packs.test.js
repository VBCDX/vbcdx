// The agent-pack contract: vbcdx-pack.json, role.json, loading, the catalogue, discovery
// and the commands that read packs. The installer ships no roles of its own.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePackDeclaration, validateRoleDescriptor, readPack, PACK_DECLARATION_FILE } from "../src/packs/load.js";
import { buildCatalog, loadCatalog } from "../src/packs/catalog.js";
import { FIXTURE_PACK, FIXTURE_PACK_DIR, FIXTURE_IDS, PACK_ARG } from "./helpers/fixture-pack.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const roots = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "vbcdx-packs-")); roots.push(d); return d; };
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + "\n");
const none = () => null; // no global npm root in lookups

const DECL = readJson(join(FIXTURE_PACK_DIR, PACK_DECLARATION_FILE));
const ROLE = readJson(join(FIXTURE_PACK_DIR, "assets", "roles", "code-agent", "role.json"));

/** A copy of the fixture pack under a fresh directory, optionally renamed. */
function copyPack({ name = "@example/agent-pack", packName } = {}) {
  const dir = join(tmp(), "pack");
  cpSync(FIXTURE_PACK_DIR, dir, { recursive: true });
  writeJson(join(dir, "package.json"), { ...readJson(join(dir, "package.json")), name });
  if (packName) writeJson(join(dir, PACK_DECLARATION_FILE), { ...readJson(join(dir, PACK_DECLARATION_FILE)), name: packName });
  return dir;
}

/** A minimal one-role pack with the given role id (and optional skills). */
function tinyPack(dir, { pkg = "@example/tiny", packName = "tiny", role = "solo-agent", skills = {} } = {}) {
  mkdirSync(join(dir, "roles", role), { recursive: true });
  writeJson(join(dir, "package.json"), { name: pkg, version: "0.1.0" });
  const decl = { schema_version: 1, name: packName, roles_dir: "roles", roles: [role] };
  if (Object.keys(skills).length) decl.skills_dir = "skills";
  writeJson(join(dir, PACK_DECLARATION_FILE), decl);
  writeJson(join(dir, "roles", role, "role.json"), { ...ROLE, id: role, credential_suffix: role.toUpperCase().replace(/-/g, "_"), dependencies: {}, remote_capabilities: {} });
  writeFileSync(join(dir, "roles", role, "prompt.md"), "You are a coding agent.\n");
  for (const [rel, content] of Object.entries(skills)) {
    mkdirSync(dirname(join(dir, "skills", rel)), { recursive: true });
    writeFileSync(join(dir, "skills", rel), content);
  }
  return dir;
}

const errorsOf = (fn, v) => fn(v).errors.join("\n");

// ── vbcdx-pack.json ─────────────────────────────────────────────────────────

test("the fixture declaration is valid and the fixture pack loads every listed role in order", () => {
  assert.deepEqual(validatePackDeclaration(DECL), { ok: true, errors: [] });
  assert.equal(FIXTURE_PACK.name, "example-agents");
  assert.equal(FIXTURE_PACK.package, "@example/agent-pack");
  assert.deepEqual(FIXTURE_PACK.roles.map((r) => r.id), DECL.roles);
  assert.ok(FIXTURE_PACK.roles.every((r) => r.pack === "example-agents" && r.prompt.length > 0));
  assert.ok(Object.isFrozen(FIXTURE_PACK.roles[0].descriptor.policy), "descriptors are frozen deep");
});

test("validatePackDeclaration: every per-field rule, each case changing the input", () => {
  const cases = [
    ["not an object", [], /must be a JSON object/],
    ["unknown field", { ...DECL, extra: 1 }, /unknown field "extra"/],
    ["missing name", (({ name, ...d }) => d)(DECL), /missing required field name/],
    ["missing roles_dir", (({ roles_dir, ...d }) => d)(DECL), /missing required field roles_dir/],
    ["missing roles", (({ roles, ...d }) => d)(DECL), /missing required field roles/],
    ["missing schema_version", (({ schema_version, ...d }) => d)(DECL), /missing required field schema_version/],
    ["$schema as a URL", { ...DECL, $schema: "https://h.example/vbcdx-pack.schema.json" }, /\$schema must be a relative path/],
    ["schema_version 2", { ...DECL, schema_version: 2 }, /schema_version must be 1/],
    ["name with capitals", { ...DECL, name: "Dev" }, /name must be/],
    ["name ending in a hyphen", { ...DECL, name: "dev-" }, /name must be/],
    ["description over two lines", { ...DECL, description: "a\nb" }, /description must be one/],
    ["description too long", { ...DECL, description: "x".repeat(201) }, /description must be one/],
    ["roles_dir traversal", { ...DECL, roles_dir: "../roles" }, /roles_dir must be a relative directory/],
    ["roles_dir absolute", { ...DECL, roles_dir: "/etc" }, /roles_dir must be a relative directory/],
    ["roles_dir dot segment", { ...DECL, roles_dir: "assets/./roles" }, /roles_dir must be a relative directory/],
    ["skills_dir backslash", { ...DECL, skills_dir: "a\\b" }, /skills_dir must be a relative directory/],
    ["roles empty", { ...DECL, roles: [] }, /roles must list at least 1/],
    ["roles not an array", { ...DECL, roles: "code-agent" }, /roles must be an array/],
    ["role id listed twice", { ...DECL, roles: ["code-agent", "code-agent"] }, /code-agent is listed twice/],
    ["role id with an underscore", { ...DECL, roles: ["code_agent"] }, /roles\[0\] is not a valid role id/],
    ["role id too long", { ...DECL, roles: ["a".repeat(65)] }, /roles\[0\] is not a valid role id/],
    ["too many roles", { ...DECL, roles: Array.from({ length: 257 }, (_, i) => `r${i}`) }, /more than 256/],
    ["contract without a major", { ...DECL, contracts: ["vbcdx.forgejo"] }, /contracts\[0\] is not a valid contract/],
    ["contract listed twice", { ...DECL, contracts: ["a.b/1", "a.b/1"] }, /a\.b\/1 is listed twice/],
  ];
  for (const [label, decl, expected] of cases) {
    assert.notDeepEqual(decl, DECL, `${label}: the case changes the input`);
    assert.match(errorsOf(validatePackDeclaration, decl), expected, label);
  }
  // Optional fields may be absent.
  const { description, skills_dir, contracts, $schema, ...minimal } = DECL;
  assert.deepEqual(validatePackDeclaration(minimal), { ok: true, errors: [] });
});

// ── role.json ───────────────────────────────────────────────────────────────

test("validateRoleDescriptor: every fixture role is valid", () => {
  for (const r of FIXTURE_PACK.roles) assert.deepEqual(validateRoleDescriptor(r.descriptor, r.id), { ok: true, errors: [] }, r.id);
});

const EXT = { name: "audit-gate", status: "unavailable", note: "No tool exists for it yet." };

test("validateRoleDescriptor: every rule, each case changing the input", () => {
  assert.deepEqual(validateRoleDescriptor({ ...ROLE, external_dependencies: [EXT] }, "code-agent"), { ok: true, errors: [] });
  const with_ = (patch) => ({ ...ROLE, ...patch });
  const cases = [
    ["not an object", null, /must be a JSON object/],
    ["unknown field (a retired source_id)", with_({ source_id: "x" }), /unknown field "source_id"/],
    ["missing policy", (({ policy, ...d }) => d)(ROLE), /missing required field policy/],
    ["missing opencode_mode", (({ opencode_mode, ...d }) => d)(ROLE), /missing required field opencode_mode/],
    ["schema_version 2", with_({ schema_version: 2 }), /schema_version must be 1/],
    ["id not its directory", with_({ id: "other-agent", credential_suffix: "OTHER_AGENT" }), /does not match its directory code-agent/],
    ["id malformed", with_({ id: "Code" }), /id must be lowercase/],
    ["suffix not derived from the id", with_({ credential_suffix: "CODING_AGENT" }), /credential_suffix must be CODE_AGENT/],
    ["suffix malformed", with_({ credential_suffix: "code-agent" }), /credential_suffix must be upper-case/],
    ["name on two lines", with_({ name: "a\nb" }), /name must be one non-empty line/],
    ["empty description", with_({ description: "" }), /description must be one non-empty line/],
    ["description too long", with_({ description: "x".repeat(1001) }), /description must be one non-empty line/],
    ["policy not an object", with_({ policy: "implementer" }), /policy must be an object/],
    ["policy unknown key", with_({ policy: { ...ROLE.policy, extra: true } }), /policy: unknown field "extra"/],
    ["policy kind malformed", with_({ policy: { ...ROLE.policy, kind: "Kind 1" } }), /policy\.kind must be/],
    ["policy may_merge not boolean", with_({ policy: { ...ROLE.policy, may_merge: "no" } }), /policy\.may_merge must be true or false/],
    ["policy summary empty", with_({ policy: { ...ROLE.policy, summary: "" } }), /policy\.summary must be one/],
    ["filesystem not in the enum", with_({ local_capabilities: { ...ROLE.local_capabilities, filesystem: "full" } }), /filesystem must be one of read-only, read-write/],
    ["shell not boolean", with_({ local_capabilities: { ...ROLE.local_capabilities, shell: 1 } }), /local_capabilities\.shell must be true or false/],
    ["capabilities unknown key", with_({ local_capabilities: { ...ROLE.local_capabilities, gpu: true } }), /local_capabilities: unknown field "gpu"/],
    ["web_search not boolean", with_({ web_search: "yes" }), /web_search must be true or false/],
    ["remote service key malformed", with_({ remote_capabilities: { Forgejo: ["whoami"] } }), /remote_capabilities key "Forgejo" is not a service name/],
    ["remote tool listed twice", with_({ remote_capabilities: { forgejo: ["whoami", "whoami"] } }), /whoami is listed twice/],
    ["remote tool malformed", with_({ remote_capabilities: { forgejo: ["who ami"] } }), /forgejo\[0\] is not a valid tool name/],
    ["remote tools not a list", with_({ remote_capabilities: { forgejo: "whoami" } }), /remote_capabilities\.forgejo must be an array/],
    ["dependency contract malformed", with_({ dependencies: { forgejo: "forgejo" } }), /dependencies\.forgejo must be a contract/],
    ["opencode_mode not in the enum", with_({ opencode_mode: "agent" }), /opencode_mode must be one of primary, subagent, all/],
    ["external_dependencies not a list", with_({ external_dependencies: {} }), /external_dependencies must be an array/],
    ["external dependency unknown key", with_({ external_dependencies: [{ ...EXT, url: "x" }] }), /external_dependencies\[0\]: unknown field "url"/],
    ["external dependency missing note", with_({ external_dependencies: [(({ note, ...e }) => e)(EXT)] }), /external_dependencies\[0\]: missing required field note/],
    ["external dependency status", with_({ external_dependencies: [{ ...EXT, status: "maybe" }] }), /status must be one of available, unavailable/],
    ["external dependency name", with_({ external_dependencies: [{ ...EXT, name: "Gate" }] }), /\.name must be lowercase/],
    ["external dependency note on two lines", with_({ external_dependencies: [{ ...EXT, note: "a\nb" }] }), /\.note must be one/],
  ];
  for (const [label, d, expected] of cases) {
    assert.notDeepEqual(d, ROLE, `${label}: the case changes the input`);
    assert.match(errorsOf((v) => validateRoleDescriptor(v, "code-agent"), d), expected, label);
  }
});

// ── readPack: the rules that need the package on disk ──────────────────────

test("readPack refuses a directory without vbcdx-pack.json, naming it", () => {
  const dir = tmp();
  writeJson(join(dir, "package.json"), { name: "@example/not-a-pack", version: "1.0.0" });
  assert.throws(() => readPack(dir), /has no vbcdx-pack\.json; it is not a VBCDX agent pack/);
});

test("readPack: cross-file rules, each naming the role or directory", () => {
  const cases = [
    ["roles_dir missing", (d) => rmSync(join(d, "assets", "roles"), { recursive: true }), /roles_dir assets\/roles is not a directory/],
    ["a listed role has no directory", (d) => rmSync(join(d, "assets", "roles", "qa-agent"), { recursive: true }), /role qa-agent assets\/roles\/qa-agent is not a directory/],
    ["prompt.md missing", (d) => rmSync(join(d, "assets", "roles", "qa-agent", "prompt.md")), /role qa-agent prompt\.md is missing/],
    ["prompt.md blank", (d) => writeFileSync(join(d, "assets", "roles", "qa-agent", "prompt.md"), " \n"), /role qa-agent prompt\.md is empty/],
    ["role.json missing", (d) => rmSync(join(d, "assets", "roles", "qa-agent", "role.json")), /role qa-agent role\.json is missing/],
    ["role.json has a duplicate key", (d) => writeFileSync(join(d, "assets", "roles", "qa-agent", "role.json"), '{"id":"qa-agent","id":"qa-agent"}'), /[Dd]uplicate/],
    ["role.json invalid", (d) => {
      const p = join(d, "assets", "roles", "qa-agent", "role.json");
      writeJson(p, { ...readJson(p), web_search: "no" });
    }, /role qa-agent: web_search must be true or false/],
    ["a role depends on a contract the pack does not list", (d) => {
      const p = join(d, PACK_DECLARATION_FILE);
      writeJson(p, { ...readJson(p), contracts: ["vbcdx.forgejo/1"] });
    }, /role \S+: dependencies\.coolify names vbcdx\.coolify\/1, which the pack does not list in contracts/],
    ["skills_dir missing", (d) => rmSync(join(d, "skills"), { recursive: true }), /skills_dir skills is not a directory/],
    ["roles_dir is a symlink out of the package", (d) => {
      const outside = join(tmp(), "roles");
      cpSync(join(d, "assets", "roles"), outside, { recursive: true });
      rmSync(join(d, "assets", "roles"), { recursive: true });
      symlinkSync(outside, join(d, "assets", "roles"));
    }, /roles_dir assets\/roles resolves outside the package/],
    ["a role directory is a symlink out of the package", (d) => {
      const outside = join(tmp(), "qa");
      cpSync(join(d, "assets", "roles", "qa-agent"), outside, { recursive: true });
      rmSync(join(d, "assets", "roles", "qa-agent"), { recursive: true });
      symlinkSync(outside, join(d, "assets", "roles", "qa-agent"));
    }, /role qa-agent assets\/roles\/qa-agent resolves outside the package/],
  ];
  for (const [label, mutate, expected] of cases) {
    const dir = copyPack();
    assert.doesNotThrow(() => readPack(dir), `${label}: the copy loads before the mutation`);
    mutate(dir);
    assert.throws(() => readPack(dir), expected, label);
  }
});

test("readPack checks the package identity: a named spec must find that package", () => {
  const dir = copyPack({ name: "@example/renamed" });
  assert.equal(readPack(dir).package, "@example/renamed");
  assert.throws(() => readPack(dir, { spec: "@example/agent-pack" }), /holds package @example\/renamed, not @example\/agent-pack/);
  writeJson(join(dir, "package.json"), { name: "Not A Name", version: "1" });
  assert.throws(() => readPack(dir), /no valid npm package name/);
});

// ── the catalogue ───────────────────────────────────────────────────────────

test("buildCatalog: roles in pack order; a role id, pack name, skill or document in two packs is refused naming both", () => {
  const a = readPack(tinyPack(tmp(), { pkg: "@example/a", packName: "pack-a", role: "alpha-agent" }));
  const b = readPack(tinyPack(tmp(), { pkg: "@example/b", packName: "pack-b", role: "beta-agent" }));
  assert.deepEqual(buildCatalog([b, a]).ids, ["beta-agent", "alpha-agent"]);
  assert.deepEqual(buildCatalog([FIXTURE_PACK, a]).ids, [...FIXTURE_IDS, "alpha-agent"]);

  const sameRole = readPack(tinyPack(tmp(), { pkg: "@example/c", packName: "pack-c", role: "alpha-agent" }));
  assert.throws(() => buildCatalog([a, sameRole]), /Role alpha-agent is in two agent packs, pack-a and pack-c/);
  const sameName = readPack(tinyPack(tmp(), { pkg: "@example/d", packName: "pack-a", role: "delta-agent" }));
  assert.throws(() => buildCatalog([a, sameName]), /Two agent packs are named pack-a/);

  const skill = { "development/SHARED.MD": "---\nname: shared\ndescription: d\n---\n" };
  const s1 = readPack(tinyPack(tmp(), { pkg: "@example/s1", packName: "s-one", role: "s1-agent", skills: skill }));
  const s2 = readPack(tinyPack(tmp(), { pkg: "@example/s2", packName: "s-two", role: "s2-agent", skills: skill }));
  assert.throws(() => buildCatalog([s1, s2]), /Skill development\/SHARED\.MD is shipped by two agent packs, s-one and s-two/);
  const doc = { "README.md": "# r\n" };
  const d1 = readPack(tinyPack(tmp(), { pkg: "@example/d1", packName: "d-one", role: "d1-agent", skills: doc }));
  const d2 = readPack(tinyPack(tmp(), { pkg: "@example/d2", packName: "d-two", role: "d2-agent", skills: doc }));
  assert.throws(() => buildCatalog([d1, d2]), /Document README\.md is shipped by two agent packs, d-one and d-two/);

  // Skills from several packs merge into one catalogue, each remembering its pack.
  const merged = buildCatalog([FIXTURE_PACK, s1]);
  const dev = merged.skills.bySlug.get("development");
  assert.deepEqual([...dev.skills.keys()], ["SHARED.MD", "WRITING-NOTES.MD"]);
  assert.equal(dev.skills.get("SHARED.MD").pack, "s-one");
});

test("loadCatalog: --pack values resolve by path or name; the same pack named twice loads once", () => {
  const home = tmp();
  mkdirSync(join(home, "node_modules", "@example"), { recursive: true });
  symlinkSync(FIXTURE_PACK_DIR, join(home, "node_modules", "@example", "agent-pack"));
  const byName = loadCatalog(["@example/agent-pack"], { cwd: home, packageRoot: home, npmGlobalRoot: none });
  assert.deepEqual(byName.ids, [...FIXTURE_IDS]);
  const twice = loadCatalog(["@example/agent-pack", FIXTURE_PACK_DIR], { cwd: home, packageRoot: home, npmGlobalRoot: none });
  assert.equal(twice.packs.length, 1);
  assert.throws(() => loadCatalog(["@example/absent"], { cwd: home, packageRoot: home, npmGlobalRoot: none }), /@example\/absent is not installed[\s\S]*npm install -g @example\/absent/);
});

test("loadCatalog without --pack discovers every installed pack, nearest root first; none is an error unless allowed", () => {
  const home = tmp();
  const project = join(home, "project");
  mkdirSync(join(project, "node_modules", "@example"), { recursive: true });
  mkdirSync(join(home, "node_modules"), { recursive: true });
  symlinkSync(FIXTURE_PACK_DIR, join(project, "node_modules", "@example", "agent-pack"));
  tinyPack(join(home, "node_modules", "tiny-pack"), { pkg: "tiny-pack", packName: "tiny", role: "solo-agent" });
  // A same-named package further out is shadowed by the nearer one, as Node resolves it.
  tinyPack(join(home, "node_modules", "@example", "agent-pack"), { pkg: "@example/agent-pack", packName: "shadowed", role: "shadow-agent" });
  // A package without vbcdx-pack.json is not a pack.
  mkdirSync(join(home, "node_modules", "plain"), { recursive: true });
  writeJson(join(home, "node_modules", "plain", "package.json"), { name: "plain", version: "1.0.0" });

  const found = loadCatalog([], { cwd: project, packageRoot: project, npmGlobalRoot: none });
  assert.deepEqual(found.packs.map((p) => p.name), ["example-agents", "tiny"]);
  assert.ok(found.ids.includes("solo-agent") && !found.ids.includes("shadow-agent"));

  const empty = tmp();
  assert.throws(() => loadCatalog([], { cwd: empty, packageRoot: empty, npmGlobalRoot: none }), /No agent pack found[\s\S]*npm install -g <agent-pack>[\s\S]*--pack=/);
  assert.deepEqual(loadCatalog([], { cwd: empty, packageRoot: empty, npmGlobalRoot: none, allowEmpty: true }).ids, []);
});

test("with no pack loaded, every role lookup fails closed", () => {
  const script = [
    'import { getRole } from "./src/roles/index.js";',
    'try { getRole("code-agent"); console.log("NO-THROW"); } catch (e) { console.log(e.message); }',
  ].join("\n");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No agent pack is loaded/);
});

// ── the commands that read packs ────────────────────────────────────────────

/** Run a bin with HOME and the npm global prefix pointed at an empty scratch dir. */
function runBin(bin, args, { cwd, env = {} } = {}) {
  const home = cwd || tmp();
  const prefix = join(home, ".npm-global");
  const base = { ...process.env, HOME: home, npm_config_prefix: prefix, NPM_CONFIG_PREFIX: prefix, ...env };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENCODE_CONFIG_DIR", "HERMES_HOME"]) delete base[k];
  return spawnSync(process.execPath, [join(ROOT, "bin", bin), ...args], { encoding: "utf8", cwd: home, env: base });
}

test("vbcdx packs lists each pack with its roles, skills and contracts; none found is not an error", () => {
  const r = runBin("vbcdx.js", ["packs", PACK_ARG, "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const [p] = JSON.parse(r.stdout).packs;
  assert.equal(p.name, "example-agents");
  assert.equal(p.package, "@example/agent-pack");
  assert.deepEqual(p.roles, [...FIXTURE_IDS]);
  assert.deepEqual(p.skills, [{ name: "writing-notes-example", id: "writing-notes", file: "development/WRITING-NOTES.MD" }]);
  assert.deepEqual(p.contracts, ["vbcdx.coolify/1", "vbcdx.forgejo/1"]);
  const human = runBin("vbcdx.js", ["packs", PACK_ARG]);
  assert.match(human.stdout, /^example-agents {2}@example\/agent-pack@1\.0\.0 /);
  assert.match(human.stdout, /roles: adversarial-auditor, all-in-one-dev-agent, code-agent/);
  // The skill shows the name it installs as, which `install skill` accepts.
  assert.match(human.stdout, /skills: writing-notes-example \(development\/WRITING-NOTES\.MD\)/);
  const home = tmp();
  mkdirSync(join(home, ".claude"));
  const unknown = runBin("vbcdx.js", ["install", "skill", "nope", "--harness=claude", PACK_ARG], { cwd: home });
  assert.match(unknown.stderr, /Available: writing-notes-example \(or writing-notes\)/);
  const empty = runBin("vbcdx.js", ["packs"]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, "no agent packs found\n");
});

test("vbcdx install agent finds an installed pack without --pack, and refuses with a hint when there is none", () => {
  const home = tmp();
  mkdirSync(join(home, ".claude"));
  const none_ = runBin("vbcdx.js", ["install", "agent", "qa-agent", "--harness=claude"], { cwd: home });
  assert.equal(none_.status, 2);
  assert.match(none_.stderr, /No agent pack found/);
  mkdirSync(join(home, "node_modules", "@example"), { recursive: true });
  symlinkSync(FIXTURE_PACK_DIR, join(home, "node_modules", "@example", "agent-pack"));
  const ok = runBin("vbcdx.js", ["install", "agent", "qa-agent", "--harness=claude"], { cwd: home });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /qa-agent: install/);
  const unknown = runBin("vbcdx.js", ["install", "agent", "video-creator", "--harness=claude"], { cwd: home });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /video-creator \(not a role of a loaded agent pack\)/);
});

test("vbcdx remove skill maps a catalogue name through the installed packs, and works by installed name without them", () => {
  const home = tmp();
  mkdirSync(join(home, ".claude"));
  const installed = join(home, ".claude", "skills", "writing-notes-example", "SKILL.md");
  assert.equal(runBin("vbcdx.js", ["install", "skill", "WRITING-NOTES", "--harness=claude", PACK_ARG], { cwd: home }).status, 0);
  // No pack is installed next to vbcdx: the catalogue name cannot be mapped, the installed name can.
  const byStem = runBin("vbcdx.js", ["remove", "skill", "WRITING-NOTES", "--harness=claude"], { cwd: home });
  assert.equal(byStem.status, 2);
  assert.match(byStem.stderr, /not recorded as installed/);
  assert.equal(runBin("vbcdx.js", ["remove", "skill", "writing-notes-example", "--harness=claude"], { cwd: home }).status, 0);
  assert.equal(existsSync(installed), false);
  // With the pack installed, the catalogue name works too.
  mkdirSync(join(home, "node_modules", "@example"), { recursive: true });
  symlinkSync(FIXTURE_PACK_DIR, join(home, "node_modules", "@example", "agent-pack"));
  assert.equal(runBin("vbcdx.js", ["install", "skill", "WRITING-NOTES", "--harness=claude"], { cwd: home }).status, 0);
  const mapped = runBin("vbcdx.js", ["remove", "skill", "WRITING-NOTES", "--harness=claude"], { cwd: home });
  assert.equal(mapped.status, 0, mapped.stderr);
  assert.equal(existsSync(installed), false);
});

test("vbcdx-dev-agents init without a pack refuses with the same hint", () => {
  const home = tmp();
  const cfg = join(home, "c.env");
  writeFileSync(cfg, `VBCDX_AGENTS_BASE_DIR=${home}/s\nVBCDX_AGENTS_CREDENTIALS_DIR=${home}/c\nVBCDX_AGENTS_CLAUDE_CONFIG_DIR=${home}/cc\n`);
  const r = runBin("vbcdx-dev-agents.js", ["init", "--harness=claude", `--env=${cfg}`], { cwd: home });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /No agent pack found/);
});

test("the A2A server refuses to start with no pack, and serves the packs VBCDX_A2A_PACKS names", async () => {
  const refused = runBin("a2a-server.js", [], { env: { PORT: "0", HOST: "127.0.0.1" } });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /no agent pack found; set VBCDX_A2A_PACKS/);
  const bad = runBin("a2a-server.js", [], { env: { PORT: "0", HOST: "127.0.0.1", VBCDX_A2A_PACKS: "/nonexistent/pack" } });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /cannot load the agent packs: No package directory/);

  const home = tmp();
  const child = spawn(process.execPath, [join(ROOT, "bin", "a2a-server.js")], {
    cwd: home, env: { ...process.env, HOME: home, PORT: "0", HOST: "127.0.0.1", VBCDX_A2A_PACKS: FIXTURE_PACK_DIR },
  });
  try {
    const line = await new Promise((resolve, reject) => {
      let buf = "";
      child.stdout.on("data", (d) => { buf += d; if (buf.includes("\n")) resolve(buf); });
      child.on("exit", (code) => reject(new Error(`exited ${code}`)));
      setTimeout(() => reject(new Error("no start line")), 10000).unref();
    });
    assert.match(line, new RegExp(`serving ${FIXTURE_IDS.length} roles from example-agents`));
  } finally {
    child.kill("SIGTERM");
  }
});
