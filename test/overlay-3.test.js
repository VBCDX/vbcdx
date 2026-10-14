// Overlays. A team's rules layered onto a pack's roles without forking
// them: variables, text appended to every role or one role, filled slots, and roles of the
// overlay's own (by shipping a pack). Removing the overlay restores the generic output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { readPack } from "../src/packs/load.js";
import { buildCatalog, loadCatalog } from "../src/packs/catalog.js";
import { readOverlay, validateOverlayDeclaration, composeRoles } from "../src/overlays/overlay.js";
import { EXIT } from "../src/errors.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PACK = join(HERE, "fixtures", "agent-pack");
const read = (p) => readFileSync(p, "utf8");

function withDir(fn) {
  const d = mkdtempSync(join(tmpdir(), "vbcdx-3-"));
  try {
    return fn(d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return { code: err.code, message: err.message };
  }
  return { code: EXIT.OK, message: "" };
}

/** The fixture pack, with code-agent's prompt given a slot and two variables. */
function slottedPack(root) {
  const dir = join(root, "pack");
  cpSync(PACK, dir, { recursive: true });
  const decl = JSON.parse(read(join(dir, "vbcdx-pack.json")));
  decl.vars = {
    human_account: { default: "the human owner", description: "Who approves merges." },
    branch_pattern: { default: "a branch per issue", description: "How branches are named." },
  };
  writeFileSync(join(dir, "vbcdx-pack.json"), JSON.stringify(decl));
  const prompt = join(dir, "assets", "roles", "code-agent", "prompt.md");
  writeFileSync(prompt, `${read(prompt).trimEnd()}\n\n## Process\n\n<!-- vbcdx:slot review-process -->Ask for a review.<!-- /vbcdx:slot -->\n\nWork on {{vars.branch_pattern}}; {{vars.human_account}} merges.\n`);
  return dir;
}

function overlay(root, name, { decl = {}, files = {} } = {}) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "vbcdx-overlay.json"), JSON.stringify({ schema_version: 1, name, version: "1.0.0", packs: ["example-agents"], ...decl }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

const roleOf = (catalog, id) => catalog.roles.get(id);

// ── composition ──────────────────────────────────────────────────────────────

test("an overlay fills a slot, sets variables and appends rules, in the documented order", () => withDir((root) => {
  const pack = readPack(slottedPack(root));
  const core = pack.roles.find((r) => r.id === "code-agent").prompt;
  const o = readOverlay(overlay(root, "acme", {
    decl: { vars: { human_account: "alice" } },
    files: { "all.md": "Team rule for everyone.\n", "roles/code-agent.md": "Rule for code-agent, {{vars.human_account}}.\n", "slots/review-process.md": "Ask review-agent, then red-team.\n" },
  }));
  const c = buildCatalog([pack], { overlays: [o] });
  const expected = core
    .replace("<!-- vbcdx:slot review-process -->Ask for a review.<!-- /vbcdx:slot -->", "Ask review-agent, then red-team.")
    .replace("{{vars.branch_pattern}}", "a branch per issue").replace("{{vars.human_account}}", "alice")
    .trimEnd() + "\n\nTeam rule for everyone.\n\nRule for code-agent, alice.\n";
  assert.equal(roleOf(c, "code-agent").prompt, expected);
  // Another role of the pack gets the all-role rule only.
  const qa = pack.roles.find((r) => r.id === "qa-agent").prompt;
  assert.equal(roleOf(c, "qa-agent").prompt, `${qa.trimEnd()}\n\nTeam rule for everyone.\n`);
  assert.deepEqual(roleOf(c, "qa-agent").overlays, [{ name: "acme", version: "1.0.0", digest: o.digest }]);
}));

test("without an overlay a pack that uses no slot or variable is unchanged; a slotted one keeps its defaults", () => withDir((root) => {
  const plain = readPack(PACK);
  const c = buildCatalog([plain]);
  for (const r of plain.roles) {
    assert.equal(roleOf(c, r.id).prompt, r.prompt, r.id);
    assert.deepEqual(roleOf(c, r.id).overlays, []);
  }
  const slotted = buildCatalog([readPack(slottedPack(root))]);
  const p = roleOf(slotted, "code-agent").prompt;
  assert.ok(p.includes("\n\nAsk for a review.\n\nWork on a branch per issue; the human owner merges.\n"), p);
  assert.equal(p.includes("vbcdx:slot"), false, "slot markers never reach a rendered prompt");
}));

test("a role-specific slot wins over the all-role one; later overlays append after earlier ones", () => withDir((root) => {
  const pack = readPack(slottedPack(root));
  const a = readOverlay(overlay(root, "first", { files: { "slots/review-process.md": "everyone\n", "slots/code-agent/review-process.md": "code-agent only\n", "all.md": "A\n" } }));
  const b = readOverlay(overlay(root, "second", { files: { "all.md": "B\n" } }));
  const p = roleOf(buildCatalog([pack], { overlays: [a, b] }), "code-agent").prompt;
  assert.ok(p.includes("## Process\n\ncode-agent only\n"));
  assert.ok(p.endsWith("\n\nA\n\nB\n"));
}));

test("variables expand once: a value is never expanded again", () => withDir((root) => {
  const pack = readPack(slottedPack(root));
  const o = readOverlay(overlay(root, "acme", { decl: { vars: { human_account: "{{vars.branch_pattern}}" } } }));
  const p = roleOf(buildCatalog([pack], { overlays: [o] }), "code-agent").prompt;
  assert.ok(p.includes("; {{vars.branch_pattern}} merges."), p);
}));

test("an overlay that ships a pack adds its roles; they are untouched unless its packs list them", () => withDir((root) => {
  const pack = readPack(slottedPack(root));
  const dir = overlay(root, "acme", { files: { "all.md": "Team rule.\n" } });
  // The overlay's own pack: one role.
  mkdirSync(join(dir, "roles", "x"), { recursive: true });
  cpSync(join(PACK, "assets", "roles", "qa-agent"), join(dir, "own", "team-agent"), { recursive: true });
  const rj = JSON.parse(read(join(dir, "own", "team-agent", "role.json")));
  rj.id = "team-agent";
  rj.credential_suffix = "TEAM_AGENT";
  writeFileSync(join(dir, "own", "team-agent", "role.json"), JSON.stringify(rj));
  writeFileSync(join(dir, "vbcdx-pack.json"), JSON.stringify({ schema_version: 1, name: "acme-roles", roles_dir: "own", roles: ["team-agent"], contracts: ["vbcdx.forgejo/1", "vbcdx.coolify/1"] }));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "acme-overlay", version: "1.0.0" }));
  rmSync(join(dir, "roles"), { recursive: true });
  const c = loadCatalog([pack.dir], { overlays: [dir] });
  assert.ok(c.ids.includes("team-agent"));
  assert.equal(roleOf(c, "team-agent").prompt.includes("Team rule."), false, "acme-roles is not in the overlay's packs");
  assert.ok(roleOf(c, "code-agent").prompt.endsWith("Team rule.\n"));
  assert.deepEqual(c.overlays.map((o) => o.name), ["acme"]);
}));

// ── refusals ─────────────────────────────────────────────────────────────────

test("the declaration's own rules", () => {
  const ok = { schema_version: 1, name: "acme", version: "1.0.0", packs: ["example-agents"] };
  assert.deepEqual(validateOverlayDeclaration(ok), { ok: true, errors: [] });
  for (const [mutate, re] of [
    [(d) => { delete d.packs; }, /missing required field packs/],
    [(d) => { d.packs = []; }, /packs must list/],
    [(d) => { d.packs = ["a1", "a1"]; }, /distinct/],
    [(d) => { d.name = "Bad"; }, /name must be/],
    [(d) => { d.version = "1 0"; }, /version must be/],
    [(d) => { d.vars = { Bad: "x" }; }, /is not a variable name/],
    [(d) => { d.vars = { ok: "two\nlines" }; }, /one non-empty line/],
    [(d) => { d.extra = 1; }, /unknown field "extra"/],
    [(d) => { d.schema_version = 2; }, /schema_version must be 1/],
    [(d) => { d.$schema = "https://x/vbcdx-overlay.schema.json"; }, /\$schema must be/],
  ]) {
    const d = structuredClone(ok);
    mutate(d);
    const r = validateOverlayDeclaration(d);
    assert.equal(r.ok, false, JSON.stringify(d));
    assert.match(r.errors.join("\n"), re);
  }
});

test("every rule that needs the packs fails by name", () => withDir((root) => {
  const pack = readPack(slottedPack(root));
  const fail = (o, re) => assert.match(codeOf(() => buildCatalog([pack], { overlays: [readOverlay(o)] })).message, re);
  fail(overlay(root, "o1", { decl: { packs: ["missing-pack"] } }), /^Overlay o1 applies to pack missing-pack, which is not loaded\.$/);
  fail(overlay(root, "o2", { decl: { vars: { nobody_declares: "x" } } }), /^Overlay o2 sets variable nobody_declares, which none of its packs \(example-agents\) declares\.$/);
  fail(overlay(root, "o3", { files: { "roles/no-such-role.md": "x\n" } }), /^Overlay o3: roles\/no-such-role\.md names a role its packs do not have\.$/);
  fail(overlay(root, "o4", { files: { "slots/no-such-slot.md": "x\n" } }), /^Overlay o4: slots\/no-such-slot\.md fills a slot no role of its packs has\.$/);
  fail(overlay(root, "o5", { files: { "slots/qa-agent/review-process.md": "x\n" } }), /^Overlay o5: slots\/qa-agent\/review-process\.md fills a slot role qa-agent does not have\.$/);
  fail(overlay(root, "o6", { files: { "slots/no-such-role/review-process.md": "x\n" } }), /^Overlay o6: slots\/no-such-role\/ names a role its packs do not have\.$/);
  const a = readOverlay(overlay(root, "o7", { files: { "slots/review-process.md": "a\n" } }));
  const b = readOverlay(overlay(root, "o8", { files: { "slots/code-agent/review-process.md": "b\n" } }));
  assert.match(codeOf(() => buildCatalog([pack], { overlays: [a, b] })).message, /^Overlays o7 and o8 both fill slot review-process of role code-agent; only one may\.$/);
}));

test("overlay files: empty, out of the overlay, or misnamed fail by name", () => withDir((root) => {
  assert.match(codeOf(() => readOverlay(overlay(root, "e1", { files: { "all.md": "  \n" } }))).message, /^Overlay e1: all\.md is empty\.$/);
  const out = overlay(root, "e2");
  writeFileSync(join(root, "secret.txt"), "SECRET\n");
  mkdirSync(join(out, "roles"));
  execFileSync("ln", ["-s", join(root, "secret.txt"), join(out, "roles", "code-agent.md")]);
  const r = codeOf(() => readOverlay(out));
  assert.match(r.message, /^Overlay e2: roles\/code-agent\.md leads outside the overlay\.$/);
  assert.equal(r.message.includes("SECRET"), false);
  assert.match(codeOf(() => readOverlay(overlay(root, "e3", { files: { "roles/Bad_Name.md": "x\n" } }))).message, /roles\/Bad_Name\.md is not named/);
  assert.match(codeOf(() => readOverlay(join(root, "nowhere"))).message, /No overlay directory at/);
  const noDecl = join(root, "e4");
  mkdirSync(noDecl);
  assert.match(codeOf(() => readOverlay(noDecl)).message, /has no vbcdx-overlay\.json; it is not a VBCDX overlay/);
  const bad = overlay(root, "e5", { decl: { packs: [] } });
  assert.match(codeOf(() => readOverlay(bad)).message, /vbcdx-overlay\.json is invalid:\n {2}packs must list/);
}));

test("a pack's own slots and variables are checked too", () => withDir((root) => {
  const dir = slottedPack(root);
  const prompt = join(dir, "assets", "roles", "code-agent", "prompt.md");
  const base = read(prompt);
  writeFileSync(prompt, `${base}\n{{vars.undeclared}}\n`);
  assert.match(codeOf(() => buildCatalog([readPack(dir)])).message, /^Role code-agent uses \{\{vars\.undeclared\}\}, which pack example-agents does not declare\.$/);
  writeFileSync(prompt, `${base}\n<!-- vbcdx:slot review-process -->again<!-- /vbcdx:slot -->\n`);
  assert.match(codeOf(() => buildCatalog([readPack(dir)])).message, /^Role code-agent marks slot review-process twice\.$/);
  writeFileSync(prompt, `${base.replace("Ask for a review.", "<!-- vbcdx:slot inner -->x")}\n`);
  assert.match(codeOf(() => buildCatalog([readPack(dir)])).message, /slot review-process holds another slot; slots do not nest/);
  const decl = JSON.parse(read(join(dir, "vbcdx-pack.json")));
  decl.vars.bad = { default: "", description: "x" };
  writeFileSync(join(dir, "vbcdx-pack.json"), JSON.stringify(decl));
  writeFileSync(prompt, base);
  assert.match(codeOf(() => readPack(dir)).message, /vars\.bad\.default must be one non-empty line/);
}));

// ── through the installers, every harness ────────────────────────────────────

const HARNESS_HOME = { claude: "VBCDX_AGENTS_CLAUDE_CONFIG_DIR", codex: "VBCDX_AGENTS_CODEX_HOME", opencode: "VBCDX_AGENTS_OPENCODE_CONFIG_DIR", hermes: "VBCDX_AGENTS_HERMES_HOME" };

function initAt(root, harness, packDir, overlays, extraLines = []) {
  const cfg = join(root, `${harness}.env`);
  writeFileSync(cfg, [`VBCDX_AGENTS_BASE_DIR=${root}/state-${harness}`, `VBCDX_AGENTS_CREDENTIALS_DIR=${root}/creds`, `${HARNESS_HOME[harness]}=${root}/home-${harness}`, ...extraLines].join("\n") + "\n");
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "vbcdx-dev-agents.js"), "init", `--harness=${harness}`, `--env=${cfg}`, `--pack=${packDir}`, "--force",
    ...overlays.map((o) => `--overlay=${o}`)], { encoding: "utf8", cwd: root, env: { PATH: process.env.PATH, HOME: root } });
  assert.equal(r.status, 0, r.stderr);
  return r;
}

function tree(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), p);
      else out[p] = read(join(d, e.name));
    }
  };
  walk(dir, "");
  return out;
}

test("every harness renders the overlay, reports it, records it, and returns to the generic output when it is removed", () => withDir((root) => {
  const packDir = slottedPack(root);
  const o = overlay(root, "acme", { decl: { vars: { human_account: "alice" } }, files: { "all.md": "Team rule ACME-7.\n", "slots/review-process.md": "Ask review-agent ACME-8.\n" } });
  for (const harness of Object.keys(HARNESS_HOME)) {
    const home = join(root, `home-${harness}`);
    const generic = (() => { initAt(root, harness, packDir, []); return tree(home); })();
    const r = initAt(root, harness, packDir, [o]);
    assert.match(r.stdout, /^ {2}overlay acme 1\.0\.0 sha256:[0-9a-f]{64}$/m, harness);
    const shaped = tree(home);
    const codeAgentFiles = Object.entries(shaped).filter(([p]) => p.includes("code-agent"));
    assert.ok(codeAgentFiles.some(([, t]) => t.includes("Team rule ACME-7.") && t.includes("Ask review-agent ACME-8.") && t.includes("; alice merges.")), harness);
    const manifest = JSON.parse(read(join(root, `state-${harness}`, "manifests", "installation.json")));
    const rec = Object.values(manifest.files).find((f) => f.role === "code-agent");
    assert.equal(rec.overlays[0].name, "acme", harness);
    // Removing the overlay restores the generic output byte for byte.
    initAt(root, harness, packDir, []);
    assert.deepEqual(tree(home), generic, harness);
    const after = JSON.parse(read(join(root, `state-${harness}`, "manifests", "installation.json")));
    assert.equal(Object.values(after.files).some((f) => f.overlays), false, `${harness}: no overlay recorded once removed`);
  }
}));

test("VBCDX_AGENTS_OVERLAY_DIRS applies overlays after --overlay; init needs absolute paths", () => withDir((root) => {
  const packDir = slottedPack(root);
  const a = overlay(root, "first", { files: { "all.md": "FIRST\n" } });
  const b = overlay(root, "second", { files: { "all.md": "SECOND\n" } });
  initAt(root, "claude", packDir, [a], [`VBCDX_AGENTS_OVERLAY_DIRS=${b}`]);
  const text = read(join(root, "home-claude", "agents", "code-agent.md"));
  assert.ok(text.indexOf("FIRST") < text.indexOf("SECOND") && text.indexOf("FIRST") > 0, text.slice(-200));
  const cfg = join(root, "claude.env");
  const rel = spawnSync(process.execPath, [join(ROOT, "bin", "vbcdx-dev-agents.js"), "init", "--harness=claude", `--env=${cfg}`, `--pack=${packDir}`, "--overlay=first"],
    { encoding: "utf8", cwd: root, env: { PATH: process.env.PATH, HOME: root } });
  assert.equal(rel.status, EXIT.CONFIG);
  assert.match(rel.stderr, /--overlay must be an absolute path/);
  writeFileSync(cfg, `VBCDX_AGENTS_BASE_DIR=${root}/s\nVBCDX_AGENTS_CREDENTIALS_DIR=${root}/c\nVBCDX_AGENTS_CLAUDE_CONFIG_DIR=${root}/h\nVBCDX_AGENTS_OVERLAY_DIRS=relative/dir\n`);
  const envRel = spawnSync(process.execPath, [join(ROOT, "bin", "vbcdx-dev-agents.js"), "init", "--harness=claude", `--env=${cfg}`, `--pack=${packDir}`],
    { encoding: "utf8", cwd: root, env: { PATH: process.env.PATH, HOME: root } });
  assert.match(envRel.stderr, /VBCDX_AGENTS_OVERLAY_DIRS must be an absolute path/);
}));

test("vbcdx install agent takes --overlay (relative to the working directory); other commands refuse it", () => withDir((root) => {
  const packDir = slottedPack(root);
  overlay(root, "acme", { files: { "all.md": "ACME RULE\n" } });
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const env = { ...process.env, HOME: home };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENCODE_CONFIG_DIR", "HERMES_HOME"]) delete env[k];
  const run = (args) => spawnSync(process.execPath, [join(ROOT, "bin", "vbcdx.js"), ...args], { encoding: "utf8", cwd: root, env });
  let r = run(["install", "agent", "code-agent", "--harness=claude", `--pack=${packDir}`, "--overlay=acme"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}overlay acme 1\.0\.0 sha256:[0-9a-f]{64}$/m);
  assert.ok(read(join(home, ".claude", "agents", "code-agent.md")).includes("ACME RULE"));
  r = run(["install", "skill", "x", "--harness=claude", "--overlay=acme"]);
  assert.equal(r.status, EXIT.CONFIG);
  assert.match(r.stderr, /Only install agent takes --overlay/);
}));

test("a new overlay version with the same text updates the record, not the file", () => withDir((root) => {
  const packDir = slottedPack(root);
  const o = overlay(root, "acme", { files: { "all.md": "RULE\n" } });
  initAt(root, "claude", packDir, [o]);
  const decl = JSON.parse(read(join(o, "vbcdx-overlay.json")));
  decl.version = "1.0.1";
  writeFileSync(join(o, "vbcdx-overlay.json"), JSON.stringify(decl));
  const r = initAt(root, "claude", packDir, [o]);
  assert.match(r.stdout, /definition code-agent: noop/);
  const manifest = JSON.parse(read(join(root, "state-claude", "manifests", "installation.json")));
  assert.equal(Object.values(manifest.files).find((f) => f.role === "code-agent").overlays[0].version, "1.0.1");
}));

// ── the design review's musts ────────────────────────────────────────────────

test("must 1: only {{vars.<name>}} is a token; ${{ github.sha }} and {{ x }} pass through with and without an overlay", () => withDir((root) => {
  const dir = slottedPack(root);
  const prompt = join(dir, "assets", "roles", "code-agent", "prompt.md");
  writeFileSync(prompt, `${read(prompt)}\nCI: \${{ github.sha }} and {{ x }} and {{ vars }} stay.\n`);
  const pack = readPack(dir);
  for (const overlays of [[], [readOverlay(overlay(root, "acme", { files: { "all.md": "Also \${{ github.ref }} and {{ y }}.\n" } }))]]) {
    const p = roleOf(buildCatalog([pack], { overlays }), "code-agent").prompt;
    assert.ok(p.includes("CI: ${{ github.sha }} and {{ x }} and {{ vars }} stay."), p.slice(-300));
    if (overlays.length) assert.ok(p.includes("Also ${{ github.ref }} and {{ y }}."));
  }
}));

test("must 2: a partial install (--agents) with an overlay valid for the whole pack works; a role in no pack fails by name", () => withDir((root) => {
  const packDir = slottedPack(root);
  // review-process exists only in code-agent; installing just qa-agent must still accept the overlay.
  const o = overlay(root, "acme", { files: { "slots/review-process.md": "Team review.\n", "roles/code-agent.md": "Code rule.\n", "all.md": "All rule.\n" } });
  const cfg = join(root, "c.env");
  writeFileSync(cfg, `VBCDX_AGENTS_BASE_DIR=${root}/s\nVBCDX_AGENTS_CREDENTIALS_DIR=${root}/c\nVBCDX_AGENTS_HERMES_HOME=${root}/h\n`);
  const run = (extra) => spawnSync(process.execPath, [join(ROOT, "bin", "vbcdx-dev-agents.js"), "init", "--harness=hermes", `--env=${cfg}`, `--pack=${packDir}`, "--force", ...extra],
    { encoding: "utf8", cwd: root, env: { PATH: process.env.PATH, HOME: root } });
  const r = run(["--agents=qa-agent", `--overlay=${o}`]);
  assert.equal(r.status, 0, r.stderr);
  const soul = read(join(root, "h", "profiles", "qa-agent", "SOUL.md"));
  assert.ok(soul.includes("All rule.") && !soul.includes("Code rule."));
  const bad = overlay(root, "bad", { files: { "roles/ghost-agent.md": "x\n" } });
  const r2 = run(["--agents=qa-agent", `--overlay=${bad}`]);
  assert.equal(r2.status, EXIT.CONFIG);
  assert.match(r2.stderr, /Overlay bad: roles\/ghost-agent\.md names a role its packs do not have\./);
}));

test("must 3: the installer owns the composed text: a rerun with --force is a noop, an overlay change is an update, never a refusal", () => withDir((root) => {
  const packDir = slottedPack(root);
  const o = overlay(root, "acme", { files: { "all.md": "Rule one.\n" } });
  initAt(root, "hermes", packDir, [o]);
  let r = initAt(root, "hermes", packDir, [o]);
  assert.match(r.stdout, /definition code-agent: noop -> .*SOUL\.md/);
  assert.equal(/conflict|forced|refus/i.test(r.stdout + r.stderr), false, r.stdout);
  writeFileSync(join(o, "all.md"), "Rule two.\n");
  r = initAt(root, "hermes", packDir, [o]);
  assert.match(r.stdout, /definition code-agent: update -> .*SOUL\.md/);
  assert.equal(/conflict|forced/i.test(r.stdout + r.stderr), false, r.stdout);
  assert.ok(read(join(root, "home-hermes", "profiles", "code-agent", "SOUL.md")).includes("Rule two."));
  // Without --force too: the owned file updates, it is not refused as hand-edited.
  writeFileSync(join(o, "all.md"), "Rule three.\n");
  const cfg = join(root, "hermes.env");
  const plain = spawnSync(process.execPath, [join(ROOT, "bin", "vbcdx-dev-agents.js"), "init", "--harness=hermes", `--env=${cfg}`, `--pack=${packDir}`, `--overlay=${o}`],
    { encoding: "utf8", cwd: root, env: { PATH: process.env.PATH, HOME: root } });
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /definition code-agent: update/);
}));

test("must 4: slots are filled before variables expand, so a value cannot create a slot", () => withDir((root) => {
  const pack = readPack(slottedPack(root));
  const value = "<!-- vbcdx:slot review-process -->injected<!-- /vbcdx:slot -->";
  const o = readOverlay(overlay(root, "acme", { decl: { vars: { human_account: value } }, files: { "slots/review-process.md": "Team review.\n" } }));
  const p = roleOf(buildCatalog([pack], { overlays: [o] }), "code-agent").prompt;
  assert.ok(p.includes("\n\nTeam review.\n\n"), "the real slot is filled");
  assert.ok(p.includes(`; ${value} merges.`), "the value stays literal text, not a second slot");
}));

test("an overlay can be a lock source: fetched, kind overlay, and named with --overlay under --lock", async () => {
  const { fetchSources } = await import("../src/sources/fetch.js");
  withDir((root) => {
    const packDir = slottedPack(root);
    const o = overlay(root, "acme", { files: { "all.md": "LOCKED RULE\n" } });
    const sourcesPath = join(root, "vbcdx.sources.json");
    writeFileSync(sourcesPath, JSON.stringify({ schema_version: 1, sources: { pack: { dir: packDir }, team: { dir: o } } }));
    const out = fetchSources({ sourcesPath, lockPath: join(root, "vbcdx.lock.json"), storeDir: join(root, "store") });
    assert.deepEqual(out.sources.map((s) => [s.name, s.kinds]), [["pack", ["agents"]], ["team", ["overlay"]]]);
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    const env = { ...process.env, HOME: home };
    for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENCODE_CONFIG_DIR", "HERMES_HOME"]) delete env[k];
    const r = spawnSync(process.execPath, [join(ROOT, "bin", "vbcdx.js"), "install", "agent", "code-agent", "--harness=claude", `--lock=${join(root, "vbcdx.lock.json")}`, "--overlay=team"],
      { encoding: "utf8", cwd: root, env });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(read(join(home, ".claude", "agents", "code-agent.md")).includes("LOCKED RULE"));
    const r2 = spawnSync(process.execPath, [join(ROOT, "bin", "vbcdx.js"), "install", "agent", "code-agent", "--harness=claude", `--lock=${join(root, "vbcdx.lock.json")}`, "--overlay=pack"],
      { encoding: "utf8", cwd: root, env });
    assert.equal(r2.status, EXIT.CONFIG);
    assert.match(r2.stderr, /pack is not an overlay in the lock .* \(it has: team\); with --lock, nothing else is searched/);
  });
});

// ── rename: a pack role installed under a local id ──────────────────────────

test("rename installs a pack role under the local id only, with its id and credential suffix rewritten", () => withDir((root) => {
  const pack = readPack(slottedPack(root));
  const o = readOverlay(overlay(root, "acme", { decl: { rename: { "review-agent": "red-team" } }, files: { "roles/red-team.md": "Red team rule.\n" } }));
  const c = buildCatalog([pack], { overlays: [o] });
  assert.equal(c.ids.includes("review-agent"), false);
  assert.ok(c.ids.includes("red-team"));
  assert.equal(c.ids.indexOf("red-team"), pack.roles.findIndex((r) => r.id === "review-agent"), "it keeps its place in the pack's order");
  const r = roleOf(c, "red-team");
  assert.equal(r.id, "red-team");
  assert.equal(r.descriptor.id, "red-team");
  assert.equal(r.descriptor.credential_suffix, "RED_TEAM");
  assert.equal(r.descriptor.name, pack.roles.find((x) => x.id === "review-agent").descriptor.name, "the display name stays the pack's");
  assert.equal(r.renamedFrom, "review-agent");
  assert.ok(r.prompt.endsWith("Red team rule.\n"));
  assert.equal(roleOf(c, "code-agent").renamedFrom, null);
}));

test("rename refusals: an unknown role, a role of another pack, an id already taken, a role renamed twice, bad shapes", () => withDir((root) => {
  const pack = readPack(slottedPack(root));
  const fail = (overlays, re) => assert.match(codeOf(() => buildCatalog([pack], { overlays: overlays.map(readOverlay) })).message, re);
  fail([overlay(root, "r1", { decl: { rename: { "ghost-agent": "x-agent" } } })], /^Overlay r1 renames ghost-agent, which is not a role of its packs\.$/);
  fail([overlay(root, "r2", { decl: { rename: { "review-agent": "code-agent" } } })], /^Overlay r2 renames review-agent to code-agent, which is already a role id\.$/);
  fail([overlay(root, "r3", { decl: { rename: { "review-agent": "x-agent" } } }), overlay(root, "r4", { decl: { rename: { "review-agent": "y-agent" } } })],
    /^Overlay r4 renames review-agent, which another overlay already renamed to x-agent\.$/);
  fail([overlay(root, "r5", { decl: { rename: { "review-agent": "x-agent" } } }), overlay(root, "r6", { decl: { rename: { "qa-agent": "x-agent" } } })],
    /^Overlay r6 renames qa-agent to x-agent, which is already a role id\.$/);
  // The overlay's own files use the local id: the pack id no longer names a role.
  fail([overlay(root, "r7", { decl: { rename: { "review-agent": "x-agent" } }, files: { "roles/review-agent.md": "x\n" } })], /^Overlay r7: roles\/review-agent\.md names a role its packs do not have\.$/);
  for (const [rename, re] of [[{ "review-agent": "review-agent" }, /renames the role to itself/], [{ "review-agent": "Bad" }, /must be a role id/], [{ a1: "x-1", b1: "x-1" }, /gives two roles the id x-1/], [[], /rename must be an object/]]) {
    const r = validateOverlayDeclaration({ schema_version: 1, name: "acme", version: "1", packs: ["example-agents"], rename });
    assert.equal(r.ok, false);
    assert.match(r.errors.join("\n"), re);
  }
}));

test("a renamed role installs, takes its credentials and Hermes profile under the local id, and goes back when the overlay goes", () => withDir((root) => {
  const packDir = slottedPack(root);
  const o = overlay(root, "acme", { decl: { rename: { "review-agent": "red-team" } } });
  const cfgLines = ["VBCDX_AGENTS_USER_RED_TEAM=rt", "VBCDX_AGENTS_TOKEN_RED_TEAM=SECRET-RT"];
  const r = initAt(root, "hermes", packDir, [o], cfgLines);
  assert.match(r.stdout, /definition red-team: install -> .*profiles\/red-team\/SOUL\.md/);
  assert.equal(existsSync(join(root, "home-hermes", "profiles", "review-agent")), false);
  assert.equal(read(join(root, "creds", "red-team.env")), 'VBCDX_AGENTS_ROLE="red-team"\nVBCDX_AGENTS_USER="rt"\nVBCDX_AGENTS_TOKEN="SECRET-RT"\n');
  assert.equal((r.stdout + r.stderr).includes("SECRET-RT"), false);
  const cfg = join(root, "hermes.env");
  const only = spawnSync(process.execPath, [join(ROOT, "bin", "vbcdx-dev-agents.js"), "init", "--harness=hermes", `--env=${cfg}`, `--pack=${packDir}`, `--overlay=${o}`, "--agents=red-team", "--force"],
    { encoding: "utf8", cwd: root, env: { PATH: process.env.PATH, HOME: root } });
  assert.equal(only.status, 0, only.stderr);
  // Without the overlay the pack id is back.
  const plain = initAt(root, "hermes", packDir, [], cfgLines.map((l) => l.replace("RED_TEAM", "REVIEW_AGENT")));
  assert.match(plain.stdout, /definition review-agent: install -> .*profiles\/review-agent\/SOUL\.md/);
}));

test("the manifest record of a renamed role notes the pack id it came from", () => withDir((root) => {
  const packDir = slottedPack(root);
  initAt(root, "claude", packDir, [overlay(root, "acme", { decl: { rename: { "review-agent": "red-team" } } })]);
  const m = JSON.parse(read(join(root, "state-claude", "manifests", "installation.json")));
  const recs = Object.values(m.files).filter((f) => f.role === "red-team");
  assert.ok(recs.length > 0);
  for (const f of recs) assert.equal(f.renamed_from, "review-agent");
  assert.equal(Object.values(m.files).some((f) => f.role === "code-agent" && "renamed_from" in f), false);
}));
