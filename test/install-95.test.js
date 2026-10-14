// `vbcdx install agent|skill|tool`, list, remove, doctor.
//
// Every harness writer is checked against the format quoted from its vendor docs
// (see src/install/harness-targets.js and the README "Harness formats" table).
// Tests never read the real harness homes: each runs in a scratch HOME with an
// empty environment for the harness root variables.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parse as tomlParse } from "smol-toml";
import { parsePy } from "../src/fs/pyyaml.js";
import { resolveContext } from "../src/install/context.js";
import { installTool, installAgent, installSkill, list, remove, doctor } from "../src/install/commands.js";
import { resolveToolPackage, runToolManifest } from "../src/install/tool-package.js";
import { checkedEdit, FORMATS } from "../src/install/config-entry.js";
import { parseVbcdxArgs, printable, printableValue } from "../src/install/args.js";
import { readManifest } from "../src/fs/manifest.js";
import { EXIT } from "../src/errors.js";
import { FIXTURE_IDS, FIXTURE_SKILLS_DIR, PACK_ARG } from "./helpers/fixture-pack.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const FIXTURE = join(HERE, "fixtures", "tool-package");
const FIXTURE_BIN = join(FIXTURE, "bin", "example-tracker");
const SERVER = "example-tracker";
// The fixture's stdio settings: EXAMPLE_TRACKER_HTTP_PORT is read only in http mode ("modes": ["http"]),
// so no harness entry that starts the stdio server carries it.
const ENV_NAMES = ["EXAMPLE_TRACKER_URL", "EXAMPLE_TRACKER_WRITES", "EXAMPLE_TRACKER_TOKEN"];

function scratch() {
  return mkdtempSync(join(tmpdir(), "vbcdx-95-"));
}

function ctxFor(harness, home, { scope = "user", cwd = home, env = {} } = {}) {
  return resolveContext({ harness, scope, envPath: null, home, cwd, env });
}

function withHome(fn) {
  const home = scratch();
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return EXIT.OK;
}

const read = (p) => readFileSync(p, "utf8");
const readJson = (p) => JSON.parse(read(p));
// smol-toml >= 1.9 returns null-prototype objects (prototype-pollution hardening).
// `assert.deepEqual` under node:assert/strict is `deepStrictEqual`, which compares
// prototypes, so normalise a parsed TOML value to plain objects before comparing it
// with an object literal.
const plain = (v) => JSON.parse(JSON.stringify(v));
// A credential file the way the installer writes one: 0600, in 0700 directories.
function writeCred(credentialsDir, rel, body) {
  const file = join(credentialsDir, rel);
  for (let d = dirname(file); d.startsWith(credentialsDir); d = dirname(d)) {
    mkdirSync(d, { recursive: true });
    chmodSync(d, 0o700);
    if (d === credentialsDir) break;
  }
  writeFileSync(file, body);
  chmodSync(file, 0o600);
  return file;
}

// A full tool manifest for service forgejo, as the strict validator wants.
const fullManifest = (names) => ({ schema_version: 1, service: "forgejo", contract: "vbcdx.forgejo/1", package_version: "0.0.1",
  tools: [...names].sort().map((n) => ({ name: n, description: "d", inputSchema: {}, outputSchema: {}, effect: "read", required_permissions: [] })) });

// A forgejo-shaped tool package: server_name forgejo is in the roles' reviewed allowlists.
function forgejoPackage(dir, { credentialFile = true } = {}) {
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@example/forgejo-like", version: "0.0.1", bin: { "fj-tool": "bin/fj-tool.js" } }));
  const decl = {
    schema_version: 1, server_name: "forgejo", stdio: { bin: "fj-tool", args: ["mcp"] },
    env: [{ name: "FJ_URL", description: "Forge origin.", kind: "config", required: true }],
    manifest: { args: ["manifest"] },
  };
  if (credentialFile) decl.credential_file = { argument: "credential_file" };
  writeFileSync(join(dir, "vbcdx.json"), JSON.stringify(decl));
  writeFileSync(join(dir, "bin", "fj-tool.js"),
    `if (process.argv[2] === "manifest") console.log(${JSON.stringify(JSON.stringify(fullManifest(["get_issue", "whoami", "zzz_not_allowlisted"])))});\n`);
  return dir;
}

// ── harness writers, against the quoted formats ─────────────────────────────

test("claude user scope: ~/.claude.json mcpServers.<name> = {type: stdio, command, args, env refs}", () => withHome((home) => {
  const r = installTool(ctxFor("claude", home), FIXTURE);
  assert.equal(r.action, "install");
  const file = join(home, ".claude.json");
  assert.equal(r.file, file);
  assert.deepEqual(readJson(file), {
    mcpServers: {
      [SERVER]: {
        type: "stdio", command: "node", args: [FIXTURE_BIN, "mcp"],
        // code.claude.com/docs/en/mcp: ${VAR} expands; ${VAR:-default} falls back. Required stays bare.
        env: {
          EXAMPLE_TRACKER_URL: "${EXAMPLE_TRACKER_URL}",
          EXAMPLE_TRACKER_WRITES: "${EXAMPLE_TRACKER_WRITES:-}",
          EXAMPLE_TRACKER_TOKEN: "${EXAMPLE_TRACKER_TOKEN:-}",
        },
      },
    },
  });
}));

test("claude with CLAUDE_CONFIG_DIR writes <dir>/.claude.json; project scope writes <worktree>/.mcp.json", () => withHome((home) => {
  const cfg = join(home, "cfg");
  installTool(ctxFor("claude", home, { env: { CLAUDE_CONFIG_DIR: cfg } }), FIXTURE);
  assert.ok(readJson(join(cfg, ".claude.json")).mcpServers[SERVER]);
  assert.equal(existsSync(join(home, ".claude.json")), false);

  const repo = join(home, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "sub"));
  installTool(ctxFor("claude", home, { scope: "project", cwd: join(repo, "sub") }), FIXTURE);
  assert.equal(readJson(join(repo, ".mcp.json")).mcpServers[SERVER].type, "stdio");
}));

test("codex: <CODEX_HOME>/config.toml [mcp_servers.<name>] command, args, env_vars; comments kept", () => withHome((home) => {
  const file = join(home, ".codex", "config.toml");
  mkdirSync(dirname(file));
  const original = '# my settings\nmodel = "o3"\n\n[mcp_servers.other]\ncommand = "x" # keep me\n';
  writeFileSync(file, original);
  installTool(ctxFor("codex", home), FIXTURE);
  const text = read(file);
  assert.ok(text.startsWith(original), "the existing text, comments included, is kept verbatim");
  // learn.chatgpt.com/docs/extend/mcp?surface=cli: env_vars forwards variables by name.
  assert.deepEqual(plain(tomlParse(text).mcp_servers[SERVER]), { command: "node", args: [FIXTURE_BIN, "mcp"], env_vars: ENV_NAMES });
  assert.deepEqual(plain(tomlParse(text).mcp_servers.other), { command: "x" });
  remove(ctxFor("codex", home), "tool", SERVER);
  assert.equal(read(file), original, "remove restores the file byte for byte");
}));

test("opencode: <config>/opencode.json mcp.<name> = {type: local, command: [..], enabled, environment {env:VAR}}", () => withHome((home) => {
  installTool(ctxFor("opencode", home), FIXTURE);
  const doc = readJson(join(home, ".config", "opencode", "opencode.json"));
  assert.deepEqual(doc.mcp[SERVER], {
    type: "local", command: ["node", FIXTURE_BIN, "mcp"], enabled: true,
    environment: Object.fromEntries(ENV_NAMES.map((n) => [n, `{env:${n}}`])),
  });
}));

test("hermes: <HERMES_HOME>/config.yaml mcp_servers.<name> = {command, args, env ${VAR}}; comments kept", () => withHome((home) => {
  const file = join(home, ".hermes", "config.yaml");
  mkdirSync(dirname(file));
  writeFileSync(file, "# operator notes\nmodel:\n  default: some-model  # keep\n");
  installTool(ctxFor("hermes", home), FIXTURE);
  const text = read(file);
  assert.match(text, /# operator notes/);
  assert.match(text, /default: some-model +# keep/); // kept; YAML normalises the spacing
  const doc = parsePy(text);
  assert.deepEqual(doc.mcp_servers[SERVER], {
    command: "node", args: [FIXTURE_BIN, "mcp"], env: Object.fromEntries(ENV_NAMES.map((n) => [n, `\${${n}}`])),
  });
  assert.deepEqual(doc.model, { default: "some-model" });
}));

test("no environment value is ever written: only references, even when the variable is set", () => withHome((home) => {
  const before = process.env.EXAMPLE_TRACKER_TOKEN;
  process.env.EXAMPLE_TRACKER_TOKEN = "sekret-token-value-0123456789";
  try {
    for (const h of ["claude", "codex", "opencode", "hermes"]) {
      const r = installTool(ctxFor(h, home), FIXTURE);
      assert.equal(read(r.file).includes("sekret-token-value"), false, h);
    }
    assert.equal(read(join(home, ".vbcdx", "manifests", "installation.json")).includes("sekret-token-value"), false);
  } finally {
    if (before === undefined) delete process.env.EXAMPLE_TRACKER_TOKEN;
    else process.env.EXAMPLE_TRACKER_TOKEN = before;
  }
}));

// ── ownership: re-run, conflicts, removal ───────────────────────────────────

test("a re-run is a no-op and leaves every file byte-identical", () => withHome((home) => {
  for (const h of ["claude", "codex", "opencode", "hermes"]) {
    const first = installTool(ctxFor(h, home), FIXTURE);
    const bytes = read(first.file);
    const again = installTool(ctxFor(h, home), FIXTURE);
    assert.equal(again.action, "noop", h);
    assert.equal(read(first.file), bytes, h);
  }
}));

test("other keys survive install, and remove restores a file it did not create", () => withHome((home) => {
  const file = join(home, ".claude.json");
  const original = { numStartups: 3, mcpServers: { mine: { type: "stdio", command: "x" } }, projects: { "/p": {} } };
  writeFileSync(file, JSON.stringify(original));
  installTool(ctxFor("claude", home), FIXTURE);
  assert.deepEqual(Object.keys(readJson(file).mcpServers), ["mine", SERVER]);
  remove(ctxFor("claude", home), "tool", SERVER);
  assert.deepEqual(readJson(file), original);
}));

test("remove deletes a file the installer created and nothing else is in", () => withHome((home) => {
  for (const h of ["claude", "codex", "opencode", "hermes"]) {
    const r = installTool(ctxFor(h, home), FIXTURE);
    remove(ctxFor(h, home), "tool", SERVER);
    assert.equal(existsSync(r.file), false, h);
  }
  const m = readManifest(join(home, ".vbcdx", "manifests", "installation.json"), "0");
  assert.deepEqual(m.entries, {});
  assert.deepEqual(m.tools, {});
}));

test("two tools in one installer-created file: removing both deletes it, in either order", () => withHome((home) => {
  const second = forgejoPackage(join(home, "fj"), { credentialFile: false });
  for (const h of ["claude", "codex", "opencode", "hermes"]) {
    for (const order of [[SERVER, "forgejo"], ["forgejo", SERVER]]) {
      const file = installTool(ctxFor(h, home), FIXTURE).file;
      installTool(ctxFor(h, home), second);
      remove(ctxFor(h, home), "tool", order[0]);
      assert.ok(existsSync(file), `${h}: the file stays while ${order[1]} is in it`);
      remove(ctxFor(h, home), "tool", order[1]);
      assert.equal(existsSync(file), false, `${h}: removing ${order.join(" then ")} restores the absent file`);
    }
  }
}));

test("two tools in a file the user created: removing both leaves the file, in either order", () => withHome((home) => {
  const second = forgejoPackage(join(home, "fj"), { credentialFile: false });
  const file = join(home, ".claude.json");
  for (const order of [[SERVER, "forgejo"], ["forgejo", SERVER]]) {
    writeFileSync(file, JSON.stringify({ numStartups: 1 }));
    installTool(ctxFor("claude", home), FIXTURE);
    installTool(ctxFor("claude", home), second);
    remove(ctxFor("claude", home), "tool", order[0]);
    remove(ctxFor("claude", home), "tool", order[1]);
    assert.deepEqual(readJson(file), { numStartups: 1 }, order.join(" then "));
  }
}));

test("a hand-edited entry is a conflict for install and remove; --force overrides", () => withHome((home) => {
  const ctx = ctxFor("claude", home);
  const file = installTool(ctx, FIXTURE).file;
  const doc = readJson(file);
  doc.mcpServers[SERVER].args.push("--edited");
  writeFileSync(file, JSON.stringify(doc));
  assert.equal(codeOf(() => installTool(ctx, FIXTURE)), EXIT.CONFLICT);
  assert.equal(codeOf(() => remove(ctx, "tool", SERVER)), EXIT.CONFLICT);
  assert.deepEqual(readJson(file), doc, "a refused run writes nothing");
  assert.equal(installTool(ctx, FIXTURE, { force: true }).action, "forced");
  assert.deepEqual(readJson(file).mcpServers[SERVER].args, [FIXTURE_BIN, "mcp"]);
  doc.mcpServers[SERVER].args = ["edited"];
  writeFileSync(file, JSON.stringify(doc));
  remove(ctx, "tool", SERVER, { force: true });
  assert.equal(existsSync(file), false);
}));

test("an existing entry of the same name that the installer did not write is a conflict", () => withHome((home) => {
  const file = join(home, ".claude.json");
  writeFileSync(file, JSON.stringify({ mcpServers: { [SERVER]: { type: "stdio", command: "theirs" } } }));
  assert.equal(codeOf(() => installTool(ctxFor("claude", home), FIXTURE)), EXIT.CONFLICT);
  const r = installTool(ctxFor("claude", home), FIXTURE, { dryRun: true });
  assert.match(r.conflict, /not written by the installer/);
  assert.equal(readJson(file).mcpServers[SERVER].command, "theirs");
}));

test("a file that cannot be edited in place is refused, never rewritten whole", () => withHome((home) => {
  const oc = join(home, ".config", "opencode", "opencode.json");
  mkdirSync(dirname(oc), { recursive: true });
  const jsonc = '{\n  // a comment\n  "theme": "dark"\n}\n';
  writeFileSync(oc, jsonc);
  assert.equal(codeOf(() => installTool(ctxFor("opencode", home), FIXTURE, { force: true })), EXIT.CONFLICT);
  assert.equal(read(oc), jsonc);
  // A TOML table defined with dotted keys cannot be replaced as a block.
  const toml = join(home, ".codex", "config.toml");
  mkdirSync(dirname(toml));
  const dotted = `mcp_servers.${SERVER}.command = "theirs"\n`;
  writeFileSync(toml, dotted);
  assert.equal(codeOf(() => installTool(ctxFor("codex", home), FIXTURE, { force: true })), EXIT.CONFLICT);
  assert.equal(read(toml), dotted);
}));

test("an edit that changes anything outside the entry is refused", () => {
  const text = '{"a": 1, "mcpServers": {}}';
  const onDisk = { doc: JSON.parse(text) };
  const path = ["mcpServers", "x"];
  assert.throws(() => checkedEdit("json", onDisk, path, () => '{"a": 2, "mcpServers": {"x": 1}}', true, 1), /outside the entry/);
  assert.equal(checkedEdit("json", onDisk, path, () => FORMATS.json.set(text, path, 1), true, 1), FORMATS.json.set(text, path, 1));
});

test("an edit that does not leave the entry exactly as rendered is refused (review finding 2)", () => {
  const text = '{"mcpServers": {}}';
  const onDisk = { doc: JSON.parse(text) };
  const path = ["mcpServers", "x"];
  // Writes a different value, or none at all: neither may be reported as installed.
  assert.throws(() => checkedEdit("json", onDisk, path, () => FORMATS.json.set(text, path, 2), true, 1), /does not hold the entry as rendered/);
  assert.throws(() => checkedEdit("json", onDisk, path, () => text, true, 1), /does not hold the entry as rendered/);
  // A removal that leaves the entry behind is refused too.
  const withEntry = '{"mcpServers": {"x": 1}}';
  assert.throws(() => checkedEdit("json", { doc: JSON.parse(withEntry) }, path, () => withEntry, false), /still present/);
});

test("TOML: an [[array of tables]] after the entry survives install and remove", () => withHome((home) => {
  const file = join(home, ".codex", "config.toml");
  mkdirSync(dirname(file));
  installTool(ctxFor("codex", home), FIXTURE);
  writeFileSync(file, read(file) + '\n[[profiles]]\nname = "a"\n');
  const withArray = read(file);
  assert.equal(installTool(ctxFor("codex", home), FIXTURE).action, "noop");
  remove(ctxFor("codex", home), "tool", SERVER);
  assert.deepEqual(plain(tomlParse(read(file))), { profiles: [{ name: "a" }] });
  assert.ok(withArray.length > read(file).length);
}));

test("a config file that existed before install is never deleted by remove, even when left empty", () => withHome((home) => {
  const repo = join(home, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const file = join(repo, ".mcp.json");
  writeFileSync(file, '{"mcpServers": {}}');
  const ctx = ctxFor("claude", home, { scope: "project", cwd: repo });
  installTool(ctx, FIXTURE);
  remove(ctx, "tool", SERVER);
  assert.ok(existsSync(file));
  assert.deepEqual(readJson(file), {});
}));

test("install tool refuses a declaration that carries a token in its args and writes nothing (review finding 1)", () => withHome((home) => {
  const pkg = join(home, "evil");
  cpSync(FIXTURE, pkg, { recursive: true });
  const decl = readJson(join(pkg, "vbcdx.json"));
  delete decl.$schema;
  decl.stdio.args = ["mcp", "ghp" + "_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"];
  writeFileSync(join(pkg, "vbcdx.json"), JSON.stringify(decl));
  assert.equal(codeOf(() => installTool(ctxFor("claude", home), pkg)), EXIT.CONFIG);
  assert.equal(existsSync(join(home, ".claude.json")), false);
  assert.equal(existsSync(join(home, ".vbcdx")), false);
}));

// A tool package whose manifest command leaves a marker file, so a test can tell whether
// the package's code ran.
function markerPackage(dir, marker) {
  forgejoPackage(dir, { credentialFile: false });
  writeFileSync(join(dir, "bin", "fj-tool.js"),
    `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran"); console.log(${JSON.stringify(JSON.stringify(fullManifest(["whoami"])))});\n`);
  return dir;
}

test("--dry-run never runs the package's manifest command (review finding 3)", () => withHome((home) => {
  const marker = join(home, "ran");
  const pkg = markerPackage(join(home, "fj"), marker);
  for (const h of ["claude", "codex", "opencode", "hermes"]) {
    const r = installTool(ctxFor(h, home), pkg, { dryRun: true });
    assert.equal(r.action, "install", h);
    assert.equal(r.tools, null, `${h}: no tool count without running the package`);
  }
  assert.equal(existsSync(marker), false, "the package's code never ran");
  const r = installTool(ctxFor("claude", home), pkg);
  assert.equal(r.tools, 1);
  assert.ok(existsSync(marker), "a real install does run it");
}));

test("a refused install never runs the package's manifest command", () => withHome((home) => {
  const marker = join(home, "ran");
  const pkg = markerPackage(join(home, "fj"), marker);
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { forgejo: { command: "theirs" } } }));
  assert.equal(codeOf(() => installTool(ctxFor("claude", home), pkg)), EXIT.CONFLICT);
  assert.equal(codeOf(() => installTool(ctxFor("claude", home), pkg, { dryRun: true })), EXIT.OK);
  assert.equal(existsSync(marker), false);
}));

test("CLI: a dry run reports that the manifest was not run", () => withHome((home) => {
  mkdirSync(join(home, ".claude")); // Claude Code is installed: install uses its default home
  const r = vbcdx(home, ["install", "tool", FIXTURE, "--harness=claude", "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\(manifest not run\) for claude: install/);
}));

test("--dry-run writes nothing", () => withHome((home) => {
  const r = installTool(ctxFor("codex", home), FIXTURE, { dryRun: true });
  assert.equal(r.action, "install");
  assert.equal(existsSync(join(home, ".codex")), false);
  assert.equal(existsSync(join(home, ".vbcdx")), false);
}));

// ── package resolution ───────────────────────────────────────────────────────

test("resolveToolPackage finds a named package in node_modules up from cwd, and says how to install a missing one", () => withHome((home) => {
  const project = join(home, "proj", "deep");
  mkdirSync(project, { recursive: true });
  cpSync(FIXTURE, join(home, "proj", "node_modules", "@example", "tracker-plugin"), { recursive: true });
  const none = () => null;
  const found = resolveToolPackage("@example/tracker-plugin", { cwd: project, packageRoot: home, npmGlobalRoot: none });
  assert.equal(found.declaration.server_name, SERVER);
  assert.throws(() => resolveToolPackage("@example/absent", { cwd: project, packageRoot: home, npmGlobalRoot: none }),
    /not installed[\s\S]*npm install -g @example\/absent/);
  assert.throws(() => resolveToolPackage("../../etc", { cwd: project, packageRoot: home, npmGlobalRoot: none }), /No package directory|not a VBCDX tool package/);
  assert.throws(() => resolveToolPackage("Bad Name", { cwd: project, npmGlobalRoot: none }), /not an npm package name/);
}));

test("a package whose name differs from the requested one is refused", () => withHome((home) => {
  cpSync(FIXTURE, join(home, "node_modules", "@example", "other"), { recursive: true });
  assert.throws(() => resolveToolPackage("@example/other", { cwd: home, packageRoot: home, npmGlobalRoot: () => null }), /holds package @example\/tracker-plugin/);
}));

// ── install agent: binding to installed tools ───────────────────────────────

test("install agent binds a role to installed tools through its reviewed allowlist", () => withHome((home) => {
  const pkg = forgejoPackage(join(home, "fj"));
  installTool(ctxFor("claude", home), pkg);
  const r = installAgent(ctxFor("claude", home), ["review-agent"]);
  assert.deepEqual(r.integrations, ["forgejo"]);
  assert.deepEqual(r.launchEnv, {}, "the default home needs no launch variable");
  const def = read(join(home, ".claude", "agents", "review-agent.md"));
  assert.match(def, /mcp__forgejo__get_issue, mcp__forgejo__whoami/);
  assert.equal(def.includes("zzz_not_allowlisted"), false, "a tool outside the allowlist is never bound");
  // The role's own file for this tool, not one file for every tool.
  assert.ok(def.includes(`credential_file="${join(home, ".vbcdx", "credentials", "review-agent", "forgejo.env")}"`));
  assert.ok(r.warnings.some((w) => /create .*review-agent\/forgejo\.env with VBCDX_AGENTS_USER and VBCDX_AGENTS_TOKEN or VBCDX_AGENTS_PASSWORD \(or set VBCDX_AGENTS_TOKEN_REVIEW_AGENT__FORGEJO/.test(w)), r.warnings.join("\n"));
  assert.equal(r.warnings.some((w) => /no longer read/.test(w)), false, "no legacy file, no legacy hint");
  assert.equal(installAgent(ctxFor("claude", home), ["review-agent"]).generated[0].action, "noop");
}));

test("a role is bound before its credential file exists, and doctor reports the file missing until it does", () => withHome((home) => {
  const pkg = forgejoPackage(join(home, "fj"));
  installTool(ctxFor("claude", home), pkg);
  installAgent(ctxFor("claude", home), ["review-agent"]);
  const creds = join(home, ".vbcdx", "credentials");
  const file = join(creds, "review-agent", "forgejo.env");
  const env = { FJ_URL: "x" };
  const check = (rep) => rep.tools[0].checks.find((c) => c.check === "credential file review-agent");
  let rep = doctor(ctxFor("claude", home), { env });
  assert.equal(check(rep).ok, false);
  assert.equal(check(rep).detail,
    `${file} missing: forgejo calls as review-agent fail until it exists with VBCDX_AGENTS_USER and VBCDX_AGENTS_TOKEN or VBCDX_AGENTS_PASSWORD`);
  assert.equal(rep.ok, false);
  writeCred(creds, join("review-agent", "forgejo.env"), "");
  rep = doctor(ctxFor("claude", home), { env });
  assert.equal(check(rep).ok, false, "an empty file is not a credential");
  assert.match(check(rep).detail, /forgejo\.env is empty: it needs VBCDX_AGENTS_USER and/);
  writeCred(creds, join("review-agent", "forgejo.env"), 'VBCDX_AGENTS_ROLE="review-agent"\nVBCDX_AGENTS_TOKEN="t"\n');
  rep = doctor(ctxFor("claude", home), { env });
  assert.equal(check(rep).ok, false, "the Forgejo contract needs a user");
  assert.equal(check(rep).detail, `${file} is invalid: missing VBCDX_AGENTS_USER`);
  writeCred(creds, join("review-agent", "forgejo.env"), 'VBCDX_AGENTS_ROLE="pm-agent"\nVBCDX_AGENTS_USER="u"\nVBCDX_AGENTS_TOKEN="t"\n');
  rep = doctor(ctxFor("claude", home), { env });
  assert.equal(check(rep).ok, false, "another role's file is not this role's credential");
  assert.match(check(rep).detail, /is invalid: role field does not match the expected role review-agent/);
  writeCred(creds, join("review-agent", "forgejo.env"), 'VBCDX_AGENTS_ROLE="review-agent"\nVBCDX_AGENTS_USER="u"\nVBCDX_AGENTS_TOKEN="t"\n');
  chmodSync(file, 0o644);
  rep = doctor(ctxFor("claude", home), { env });
  assert.equal(check(rep).ok, false, "a world-readable file is unsafe");
  assert.match(check(rep).detail, /is unsafe: /);
  chmodSync(file, 0o600);
  rep = doctor(ctxFor("claude", home), { env });
  assert.equal(check(rep).ok, true, check(rep).detail);
  assert.equal(check(rep).detail, file);
  assert.equal(rep.ok, true);
  assert.equal(JSON.stringify(rep).includes('"t"'), false);
}));

test("a role-wide file from an earlier install is never read for a tool: doctor and install agent say where it belongs", () => withHome((home) => {
  const pkg = forgejoPackage(join(home, "fj"));
  installTool(ctxFor("claude", home), pkg);
  const creds = join(home, ".vbcdx", "credentials");
  const legacy = writeCred(creds, "review-agent.env", 'VBCDX_AGENTS_ROLE="review-agent"\nVBCDX_AGENTS_USER="u"\nVBCDX_AGENTS_TOKEN="t"\n');
  const file = join(creds, "review-agent", "forgejo.env");
  const r = installAgent(ctxFor("claude", home), ["review-agent"]);
  const hint = `; ${legacy} is no longer read for forgejo: copy its forgejo credentials to ${file}`;
  assert.ok(r.warnings.some((w) => w.endsWith(hint)), r.warnings.join("\n"));
  assert.equal(r.credentials.length, 0, "install never moves or rewrites a credential file");
  const rep = doctor(ctxFor("claude", home), { env: { FJ_URL: "x" } });
  const check = rep.tools[0].checks.find((c) => c.check === "credential file review-agent");
  assert.equal(check.ok, false, "the legacy file does not satisfy the binding");
  assert.ok(check.detail.endsWith(hint), check.detail);
  assert.equal(existsSync(file), false);
  assert.equal(read(legacy), 'VBCDX_AGENTS_ROLE="review-agent"\nVBCDX_AGENTS_USER="u"\nVBCDX_AGENTS_TOKEN="t"\n', "the legacy file is left as it was");
}));

test("install agent without installed tools binds nothing; a tool without credential_file binds by role", () => withHome((home) => {
  installAgent(ctxFor("opencode", home), ["review-agent"]);
  assert.equal(read(join(home, ".config", "opencode", "agents", "review-agent.md")).includes("forgejo_"), false);
  installTool(ctxFor("opencode", home), forgejoPackage(join(home, "fj"), { credentialFile: false }));
  installAgent(ctxFor("opencode", home), ["review-agent"]);
  const def = read(join(home, ".config", "opencode", "agents", "review-agent.md"));
  assert.match(def, /forgejo_whoami: true/);
  assert.match(def, /call forgejo tools without a credential_file argument/);
}));

test("install agent on hermes gives the profile the declared launch for the installed tool", () => withHome((home) => {
  const pkg = forgejoPackage(join(home, "fj"));
  installTool(ctxFor("hermes", home), pkg);
  installAgent(ctxFor("hermes", home), ["review-agent"]);
  const cfg = parsePy(read(join(home, ".hermes", "profiles", "review-agent", "config.yaml")));
  assert.deepEqual(cfg.mcp_servers.forgejo.command, "node");
  assert.deepEqual(cfg.mcp_servers.forgejo.args, [join(pkg, "bin", "fj-tool.js"), "mcp"]);
  assert.deepEqual(cfg.mcp_servers.forgejo.env, { FJ_URL: "${FJ_URL}" });
  assert.deepEqual(cfg.mcp_servers.forgejo.tools.include, ["get_issue", "whoami"]);
}));

// ── skills ───────────────────────────────────────────────────────────────────

test("install skill writes <dir>/<name>/SKILL.md for claude, opencode and codex", () => withHome((home) => {
  const src = read(join(FIXTURE_SKILLS_DIR, "development", "WRITING-NOTES.MD"));
  const name = "writing-notes-example"; // its frontmatter name: OpenCode requires dir == name
  const expected = {
    claude: join(home, ".claude", "skills", name, "SKILL.md"),
    opencode: join(home, ".config", "opencode", "skills", name, "SKILL.md"),
    codex: join(home, ".agents", "skills", name, "SKILL.md"),
  };
  for (const [h, path] of Object.entries(expected)) {
    const r = installSkill(ctxFor(h, home), "writing-notes");
    assert.equal(r.file, path, h);
    assert.equal(read(path), src, h);
    assert.equal(installSkill(ctxFor(h, home), "WRITING-NOTES").action, "noop", h);
  }
  const repo = join(home, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  assert.equal(installSkill(ctxFor("claude", home, { scope: "project", cwd: repo }), name).file, join(repo, ".claude", "skills", name, "SKILL.md"));
}));

test("install skill on hermes reports unsupported and writes nothing", () => withHome((home) => {
  assert.equal(codeOf(() => installSkill(ctxFor("hermes", home), "writing-notes")), EXIT.CONFLICT);
  assert.deepEqual(readdirSync(home), []);
  assert.equal(codeOf(() => installSkill(ctxFor("claude", home), "no-such-skill")), EXIT.CONFIG);
}));

test("remove skill accepts the names install skill accepts", () => withHome((home) => {
  for (const typed of ["writing-notes", "WRITING-NOTES", "writing-notes-example"]) {
    const r = installSkill(ctxFor("claude", home), typed);
    remove(ctxFor("claude", home), "skill", typed);
    assert.equal(existsSync(r.file), false, typed);
  }
  // A skill installed under a name the catalogue no longer has is removable by that name.
  const dir = join(home, ".claude", "skills", "retired-skill");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "old\n");
  const mpath = join(home, ".vbcdx", "manifests", "installation.json");
  const m = readJson(mpath);
  m.files[join(dir, "SKILL.md")] = { digest: createHash("sha256").update("old\n").digest("hex"), mode: 420, skill: "retired-skill", harness: "claude" };
  writeFileSync(mpath, JSON.stringify(m));
  remove(ctxFor("claude", home), "skill", "retired-skill");
  assert.equal(existsSync(dir), false);
}));

test("remove skill deletes the file and its directory; an edited skill is a conflict", () => withHome((home) => {
  const name = "writing-notes-example";
  const r = installSkill(ctxFor("claude", home), name);
  writeFileSync(r.file, "edited\n");
  assert.equal(codeOf(() => remove(ctxFor("claude", home), "skill", name)), EXIT.CONFLICT);
  assert.equal(read(r.file), "edited\n");
  installSkill(ctxFor("claude", home), name, { force: true });
  remove(ctxFor("claude", home), "skill", name);
  assert.equal(existsSync(dirname(r.file)), false);
}));

// ── list, remove agent, doctor ──────────────────────────────────────────────

test("list reports installed tools, agents and skills for the harness", () => withHome((home) => {
  installTool(ctxFor("claude", home), FIXTURE);
  installAgent(ctxFor("claude", home), ["qa-agent"]);
  installSkill(ctxFor("claude", home), "writing-notes");
  installTool(ctxFor("codex", home), FIXTURE);
  const l = list(ctxFor("claude", home));
  assert.deepEqual(l.tools.map((t) => t.server), [SERVER]);
  assert.deepEqual(l.agents.map((a) => a.role), ["qa-agent"]);
  assert.deepEqual(l.skills.map((s) => s.name), ["writing-notes-example"]);
}));

test("remove agent deletes only that role's recorded files; an unrecorded file is untouched", () => withHome((home) => {
  installAgent(ctxFor("codex", home), ["qa-agent", "code-agent"]);
  const dir = join(home, ".codex", "agents");
  writeFileSync(join(dir, "mine.toml"), "x = 1\n");
  remove(ctxFor("codex", home), "agent", "qa-agent");
  assert.deepEqual(readdirSync(dir).sort(), ["code-agent.toml", "mine.toml"]);
  writeFileSync(join(dir, "code-agent.toml"), "edited = true\n");
  assert.equal(codeOf(() => remove(ctxFor("codex", home), "agent", "code-agent")), EXIT.CONFLICT);
  assert.ok(existsSync(join(dir, "code-agent.toml")));
  assert.equal(codeOf(() => remove(ctxFor("codex", home), "agent", "qa-agent")), EXIT.CONFIG, "nothing recorded");
}));

test("remove agent only touches the scope it is run for", () => withHome((home) => {
  const repo = join(home, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const project = ctxFor("claude", home, { scope: "project", cwd: repo });
  installAgent(ctxFor("claude", home), ["qa-agent"]);
  installAgent(project, ["qa-agent"]);
  remove(project, "agent", "qa-agent");
  assert.equal(existsSync(join(repo, ".claude", "agents", "qa-agent.md")), false);
  assert.ok(existsSync(join(home, ".claude", "agents", "qa-agent.md")), "the user-scope definition stays");
}));

test("remove agent on hermes removes owned keys from config.yaml and keeps the operator's", () => withHome((home) => {
  installAgent(ctxFor("hermes", home), ["qa-agent"]);
  const cfg = join(home, ".hermes", "profiles", "qa-agent", "config.yaml");
  writeFileSync(cfg, read(cfg) + "display:\n  skin: dark\n");
  remove(ctxFor("hermes", home), "agent", "qa-agent");
  assert.deepEqual(parsePy(read(cfg)), { display: { skin: "dark" } });
  assert.equal(existsSync(join(home, ".hermes", "profiles", "qa-agent", "SOUL.md")), false);
}));

test("the manifest command sees PATH, HOME and its declared variables, not the caller's other ones (review finding 4)", () => withHome((home) => {
  const pkg = forgejoPackage(join(home, "fj"));
  // A manifest that names one tool per variable it can see.
  writeFileSync(join(pkg, "bin", "fj-tool.js"),
    `const m=${JSON.stringify(fullManifest([]))};const t=(n)=>({name:n,description:"d",inputSchema:{},outputSchema:{},effect:"read",required_permissions:[]});` +
    "m.tools=['FJ_URL','VBCDX_TEST_SECRET','PATH','HOME'].filter((k)=>process.env[k]).sort().map(t);console.log(JSON.stringify(m));\n");
  const env = { PATH: process.env.PATH, HOME: home, FJ_URL: "https://forge.example.com", VBCDX_TEST_SECRET: "s3cret" };
  const { tools } = runToolManifest(resolveToolPackage(pkg, { cwd: home }), { env });
  assert.deepEqual(tools, ["FJ_URL", "HOME", "PATH"]);
}));

test("an installed tool's manifest gets the strict check, and its contract is recorded", () => withHome((home) => {
  const pkg = forgejoPackage(join(home, "fj"));
  const env = { PATH: process.env.PATH, HOME: home, FJ_URL: "https://forge.example.com" };
  for (const [label, body] of [
    ["a bare tools list", { tools: [{ name: "whoami" }] }],
    ["another service", { ...fullManifest(["whoami"]), service: "coolify" }],
    ["no contract", (() => { const m = fullManifest(["whoami"]); delete m.contract; return m; })()],
    ["a tool name outside the charset", fullManifest(["who ami"])],
  ]) {
    writeFileSync(join(pkg, "bin", "fj-tool.js"), `console.log(${JSON.stringify(JSON.stringify(body))});\n`);
    assert.throws(() => runToolManifest(resolveToolPackage(pkg, { cwd: home }), { env }), /Manifest @example\/forgejo-like manifest/, label);
  }
  forgejoPackage(pkg);
  // A declared contract must be the one the manifest reports.
  const declPath = join(pkg, "vbcdx.json");
  const decl = readJson(declPath);
  writeFileSync(declPath, JSON.stringify({ ...decl, contract: "vbcdx.coolify/1" }));
  assert.throws(() => installTool(ctxFor("claude", home), pkg), /declares contract vbcdx\.coolify\/1 but its manifest reports vbcdx\.forgejo\/1/);
  writeFileSync(declPath, JSON.stringify({ ...decl, contract: "vbcdx.forgejo/1" }));
  installTool(ctxFor("claude", home), pkg);
  const m = readManifest(join(home, ".vbcdx", "manifests", "installation.json"), "0");
  assert.deepEqual(Object.values(m.tools).map((t) => t.contract), ["vbcdx.forgejo/1"]);
}));

test("doctor re-validates the package before running anything from it (security low 2)", () => withHome((home) => {
  const pkg = forgejoPackage(join(home, "fj"));
  installTool(ctxFor("claude", home), pkg);
  const marker = join(home, "ran");
  const declPath = join(pkg, "vbcdx.json");
  const decl = readJson(declPath);
  writeFileSync(join(pkg, "bin", "fj-tool.js"), `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`);
  writeFileSync(declPath, JSON.stringify({ ...decl, stdio: { bin: "fj-tool", args: ["mcp", "--url=https://x.example.com"] } }));
  let r = doctor(ctxFor("claude", home), { env: { FJ_URL: "x" } });
  const checks = Object.fromEntries(r.tools[0].checks.map((c) => [c.check, c]));
  assert.equal(checks.declaration.ok, false);
  assert.equal(checks.manifest, undefined, "an invalid package is not run");
  assert.equal(existsSync(marker), false);
  writeFileSync(declPath, JSON.stringify(decl));
  const pj = readJson(join(pkg, "package.json"));
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ ...pj, name: "@someone/else" }));
  r = doctor(ctxFor("claude", home), { env: { FJ_URL: "x" } });
  assert.match(r.tools[0].checks.find((c) => c.check === "declaration").detail, /now holds @someone\/else/);
  assert.equal(existsSync(marker), false);
}));

test("doctor checks package, entry, manifest command and env, reporting set/unset only", () => withHome((home) => {
  installTool(ctxFor("claude", home), FIXTURE);
  const bad = doctor(ctxFor("claude", home), { env: { ...process.env, EXAMPLE_TRACKER_URL: "" } });
  assert.equal(bad.ok, false);
  const checks = Object.fromEntries(bad.tools[0].checks.map((c) => [c.check, c]));
  assert.equal(checks.manifest.detail, "2 tools");
  assert.equal(checks["harness entry"].ok, true);
  assert.equal(checks["env EXAMPLE_TRACKER_URL"].detail, "not set (required)");
  const good = doctor(ctxFor("claude", home), { env: { ...process.env, EXAMPLE_TRACKER_URL: "https://tracker.example.com" } });
  assert.equal(good.ok, true);
  assert.equal(JSON.stringify(good).includes("tracker.example.com"), false, "a value is never reported");
  const file = join(home, ".claude.json");
  writeFileSync(file, "{}");
  assert.equal(doctor(ctxFor("claude", home), { env: { EXAMPLE_TRACKER_URL: "x" } }).ok, false, "a missing entry fails");
}));

// ── context and arguments ────────────────────────────────────────────────────

test("install never assumes a harness is installed: a missing default home is refused, not created", () => withHome((home) => {
  const at = (harness, o = {}) => () => resolveContext({ harness, scope: "user", envPath: null, home, env: {}, requireHome: true, ...o });
  for (const [harness, rel] of [["claude", ".claude"], ["codex", ".codex"], ["opencode", join(".config", "opencode")], ["hermes", ".hermes"]]) {
    assert.throws(at(harness), new RegExp(`No ${harness} configuration found at .*: ${harness} may not be installed`), harness);
    mkdirSync(join(home, rel), { recursive: true });
    assert.doesNotThrow(at(harness), `${harness} once its home exists`);
  }
  // Claude Code may have only ~/.claude.json, where it keeps user-scope MCP servers.
  rmSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude.json"), "{}");
  assert.doesNotThrow(at("claude"));
  rmSync(join(home, ".claude.json"));
  // The harness's own variable is the user saying where it is, not a guess.
  assert.doesNotThrow(at("claude", { env: { CLAUDE_CONFIG_DIR: join(home, "elsewhere") } }));
  // list, doctor and remove act only on what the manifest recorded.
  assert.doesNotThrow(at("claude", { requireHome: false }));
  // Project scope writes into the worktree (.mcp.json), not the user's harness home.
  const repo = join(home, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  assert.doesNotThrow(at("claude", { scope: "project", cwd: repo }));
}));

test("CLI: install with no harness home refuses and writes nothing; dsh is not a harness", () => withHome((home) => {
  const r = vbcdx(home, ["install", "tool", FIXTURE, "--harness=claude"]);
  assert.equal(r.status, EXIT.CONFIG, r.stderr);
  assert.match(r.stderr, /No claude configuration found at .*\.claude: .*Set CLAUDE_CONFIG_DIR or pass --env/);
  assert.equal(existsSync(join(home, ".claude.json")), false, "no harness file created");
  assert.equal(existsSync(join(home, ".vbcdx")), false, "no state written");
  assert.equal(vbcdx(home, ["list", "--harness=claude"]).status, 0, "list needs no installed harness");
  const d = vbcdx(home, ["install", "tool", FIXTURE, "--harness=dsh"]);
  assert.equal(d.status, EXIT.CONFIG);
  assert.match(d.stderr, /Unsupported --harness: dsh/);
}));

test("without --env: the harness's own variable, else its documented default, and ~/.vbcdx state", () => {
  const home = "/home/u";
  assert.equal(resolveContext({ harness: "codex", scope: "user", envPath: null, home, env: {} }).config.harnessRoot, "/home/u/.codex");
  assert.equal(resolveContext({ harness: "codex", scope: "user", envPath: null, home, env: { CODEX_HOME: "/x" } }).config.harnessRoot, "/x");
  assert.equal(resolveContext({ harness: "opencode", scope: "user", envPath: null, home, env: {} }).config.harnessRoot, "/home/u/.config/opencode");
  assert.equal(resolveContext({ harness: "hermes", scope: "user", envPath: null, home, env: {} }).config.harnessRoot, "/home/u/.hermes");
  const c = resolveContext({ harness: "claude", scope: "user", envPath: null, home, env: {} });
  assert.equal(c.manifestPath, "/home/u/.vbcdx/manifests/installation.json");
  assert.equal(c.rootExplicit, false);
  assert.throws(() => resolveContext({ harness: "codex", scope: "user", envPath: null, home, env: { CODEX_HOME: "rel" } }), /absolute/);
});

test("with --env the configured directories win, as for init", () => withHome((home) => {
  const envFile = join(home, "agents.env");
  writeFileSync(envFile, `VBCDX_AGENTS_BASE_DIR=${home}/state\nVBCDX_AGENTS_CREDENTIALS_DIR=${home}/creds\nVBCDX_AGENTS_CODEX_HOME=${home}/cx\n`);
  const ctx = resolveContext({ harness: "codex", scope: "user", envPath: envFile, home: "/nonexistent", env: { CODEX_HOME: "/ignored" } });
  assert.equal(ctx.config.harnessRoot, `${home}/cx`);
  installTool(ctx, FIXTURE);
  assert.ok(existsSync(join(home, "cx", "config.toml")));
  assert.ok(existsSync(join(home, "state", "manifests", "installation.json")));
}));

test("parseVbcdxArgs validates commands, kinds, names and options", () => {
  const ok = parseVbcdxArgs(["install", "agent", "qa-agent,code-agent", "--harness=claude", "--scope=project"]);
  assert.deepEqual([ok.kind, ok.names, ok.scope], ["agent", ["qa-agent", "code-agent"], "project"]);
  assert.throws(() => parseVbcdxArgs(["list", "--harness=claude", "--profile=team"]), /Unknown or malformed option: --profile=team/);
  const packs = parseVbcdxArgs(["install", "skill", "x", "--harness=claude", "--pack=a", "--pack=./b"]).packs;
  assert.deepEqual(packs, ["a", "./b"]);
  assert.deepEqual(parseVbcdxArgs(["packs", "--pack=a", "--json"]).packs, ["a"]);
  const bad = [
    [["frobnicate", "--harness=claude"], /Unknown command/],
    [["install", "widget", "x", "--harness=claude"], /agent, skill or tool/],
    [["install", "tool", "--harness=claude"], /needs a name/],
    [["install", "agent", "Bad_Id", "--harness=claude"], /Unknown agent ID/],
    [["install", "tool", "a", "--harness=claude", "--pack=x"], /install tool does not take --pack/],
    [["list", "--harness=claude", "--pack=x"], /list does not take --pack/],
    [["remove", "agent", "qa-agent", "--harness=claude", "--pack=x"], /remove agent does not take --pack/],
    [["install", "agent", "qa-agent", "--harness=claude", "--pack="], /--pack requires a value/],
    [["packs", "--harness=claude"], /packs does not take --harness/],
    [["packs", "--dry-run"], /does not take --force or --dry-run/],
    [["install", "tool", "a", "b", "--harness=claude"], /Unexpected argument/],
    [["install", "tool", "a"], /--harness is required/],
    [["install", "tool", "a", "--harness=vim"], /Unsupported --harness/],
    [["install", "tool", "a", "--harness=claude", "--env=rel.env"], /absolute/],
    [["install", "tool", "a", "--harness=hermes", "--scope=project"], /does not accept --scope/],
    [["install", "tool", "a", "--harness=claude", "--token=x"], /Unknown or malformed option/],
    [["list", "--harness=claude", "--force"], /does not take/],
    [["remove", "agent", "qa-agent,code-agent", "--harness=claude"], /one agent ID/],
  ];
  for (const [argv, re] of bad) assert.throws(() => parseVbcdxArgs(argv), re, argv.join(" "));
});

test("a manifest written as @vbcdx/dev-agents is still read, and rewritten as @vbcdx/vbcdx", () => withHome((home) => {
  const p = join(home, "m.json");
  writeFileSync(p, JSON.stringify({ schema_version: 1, package: "@vbcdx/dev-agents", package_version: "0.1.0", files: {} }));
  assert.equal(readManifest(p, "0").package, "@vbcdx/vbcdx");
  writeFileSync(p, JSON.stringify({ schema_version: 1, package: "@someone/else", package_version: "0.1.0", files: {} }));
  assert.throws(() => readManifest(p, "0"), /different package/);
}));

// ── the CLI, end to end ─────────────────────────────────────────────────────

function vbcdx(home, args, extraEnv = {}) {
  const env = { ...process.env, HOME: home, ...extraEnv };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENCODE_CONFIG_DIR", "HERMES_HOME"]) {
    if (!(k in extraEnv)) delete env[k];
  }
  // Installing an agent or a skill reads the fixture agent pack; nothing else takes --pack.
  const pack = args[0] === "install" && (args[1] === "agent" || args[1] === "skill") ? [PACK_ARG] : [];
  return spawnSync(process.execPath, [join(ROOT, "bin", "vbcdx.js"), ...args, ...pack], { encoding: "utf8", env, cwd: home });
}

test("CLI: install tool, install agent, re-run, list, doctor, remove", () => withHome((home) => {
  mkdirSync(join(home, ".claude")); // Claude Code is installed: install uses its default home
  const pkg = forgejoPackage(join(home, "fj"));
  let r = vbcdx(home, ["install", "tool", pkg, "--harness=claude"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /MCP server "forgejo" \(3 tools\) for claude: install/);
  assert.match(r.stderr, /FJ_URL is required/);
  r = vbcdx(home, ["install", "agent", "review-agent", "--harness=claude"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /bound tools: forgejo/);
  assert.equal(r.stdout.includes("launch with"), false);
  assert.equal(vbcdx(home, ["install", "tool", pkg, "--harness=claude", "--quiet"]).status, 0);
  r = vbcdx(home, ["list", "--harness=claude", "--json"]);
  assert.deepEqual(JSON.parse(r.stdout).agents.map((a) => a.role), ["review-agent"]);
  r = vbcdx(home, ["doctor", "--harness=claude"], { FJ_URL: "https://forge.example.com/secret-path" });
  assert.equal(r.status, EXIT.CONFLICT, "the role's credential file does not exist yet");
  assert.match(r.stdout, /FAIL credential file review-agent: .*review-agent\/forgejo\.env missing/);
  writeCred(join(home, ".vbcdx", "credentials"), join("review-agent", "forgejo.env"), 'VBCDX_AGENTS_ROLE="review-agent"\nVBCDX_AGENTS_USER="u"\nVBCDX_AGENTS_TOKEN="t"\n');
  r = vbcdx(home, ["doctor", "--harness=claude"], { FJ_URL: "https://forge.example.com/secret-path" });
  assert.equal(r.status, 0, r.stdout);
  assert.equal((r.stdout + r.stderr).includes("secret-path"), false);
  assert.equal(vbcdx(home, ["doctor", "--harness=claude"], { FJ_URL: "" }).status, EXIT.CONFLICT);
  r = vbcdx(home, ["remove", "tool", "forgejo", "--harness=claude"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /remove tool forgejo for claude\n {2}delete-file: /);
  assert.equal(existsSync(join(home, ".claude.json")), false);
}));

test("printable keeps newlines and tabs and escapes every other control character", () => {
  assert.equal(printable("a\u001b[31mb\nc\td\u0085e\u2028f\u2029g\u007fh\u0007"), "a\\u001b[31mb\nc\td\\u0085e\\u2028f\\u2029g\\u007fh\\u0007");
  assert.equal(printable("plain — ünïcödé"), "plain — ünïcödé");
});

test("printable escapes Unicode format characters: bidi overrides and isolates, zero-width, soft hyphen, tags", () => {
  assert.equal(printable("a\u202eb\u2066c\u2067d\u2069e\u061cf\u200bg\u200eh\u2060i\u00adj\ufeffk\u{e0041}l"),
    "a\\u202eb\\u2066c\\u2067d\\u2069e\\u061cf\\u200bg\\u200eh\\u2060i\\u00adj\\ufeffk\\u{e0041}l");
  assert.equal(printable("lone \ud800 surrogate"), "lone \\ud800 surrogate");
  assert.equal(printable("emoji 🙂 and newline\nstay"), "emoji 🙂 and newline\nstay");
});

test("printableValue also escapes newlines and tabs, so a value cannot break its line", () => {
  assert.equal(printableValue("pkg\nApplied tool forged\tx\u202ey"), "pkg\\u000aApplied tool forged\\u0009x\\u202ey");
  assert.equal(printableValue("plain — ünïcödé"), "plain — ünïcödé");
});

test("CLI: control sequences in printed text reach the terminal escaped (review finding 3)", () => withHome((home) => {
  mkdirSync(join(home, ".claude")); // Claude Code is installed: install uses its default home
  const bad = join(home, "pkg\u001b[2K\u001b[31mSPOOFED\u2028x");
  const r = vbcdx(home, ["install", "tool", bad, "--harness=claude"]);
  assert.equal(r.status, EXIT.CONFIG);
  assert.match(r.stderr, /No package directory at .*pkg\\u001b\[2K\\u001b\[31mSPOOFED\\u2028x/);
  assert.equal(/[\u001b\u2028]/.test(r.stderr), false, "no raw control character is written");
}));

test("CLI: a path holding a newline or a bidi override cannot forge or reorder a report line", () => withHome((home) => {
  mkdirSync(join(home, ".claude")); // Claude Code is installed: install uses its default home
  const dir = forgejoPackage(join(home, "pkg\n    ok   forged: line\u202eevil"));
  assert.equal(vbcdx(home, ["install", "tool", dir, "--harness=claude"]).status, 0);
  const r = vbcdx(home, ["doctor", "--harness=claude"]);
  const pkgLines = r.stdout.split("\n").filter((l) => l.includes("package: "));
  assert.equal(pkgLines.length, 1, r.stdout);
  assert.ok(pkgLines[0].endsWith("pkg\\u000a    ok   forged: line\\u202eevil"), pkgLines[0]);
  assert.equal(/forged/.test(r.stdout.replace(pkgLines[0], "")), false, "no forged line");
  assert.equal(/[\u202e]/.test(r.stdout + r.stderr), false, "no raw bidi override is written");
}));

test("CLI: a package found by path must carry a valid npm name and version, checked before anything prints", () => withHome((home) => {
  mkdirSync(join(home, ".claude"));
  for (const [field, value] of [["name", "@example/x\nApplied tool forged"], ["name", "\u202eevil"], ["name", undefined], ["version", "1.0.0\u202e"], ["version", "1.0.0\nApplied tool forged"], ["version", 1]]) {
    const dir = forgejoPackage(join(home, `p-${field}-${String(value).length}`));
    const pkg = readJson(join(dir, "package.json"));
    if (value === undefined) delete pkg[field];
    else pkg[field] = value;
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
    const r = vbcdx(home, ["install", "tool", dir, "--harness=claude", "--dry-run"]);
    assert.equal(r.status, EXIT.CONFIG, `${field}=${JSON.stringify(value)}: ${r.stdout}`);
    assert.match(r.stderr, new RegExp(`package.json has (no valid npm package name|an invalid version)`));
    assert.equal(r.stdout, "");
    assert.equal(/forged|\u202e/.test(r.stderr), false, r.stderr);
  }
}));

// Every stderr line is a line vbcdx meant to print: it starts "error:" or "warning:", or
// is an indented item of a list vbcdx printed.
function stderrLines(r) {
  return r.stderr.replace(/\n$/, "").split("\n");
}

test("CLI: a parser's code frame quoting a malformed config file cannot add lines to the error", () => withHome((home) => {
  const cases = [
    ["hermes", "HERMES_HOME", join(home, ".hermes"), "config.yaml", "model:\n  default: x\n bad: [1, 2\nerror: FORGED by the config file\n"],
    ["codex", "CODEX_HOME", join(home, ".codex"), "config.toml", 'model = "x"\n[broken\nerror = "FORGED by the config file"\n'],
  ];
  for (const [harness, envVar, dir, file, text] of cases) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), text);
    for (const extra of [["--dry-run"], []]) {
      const r = vbcdx(home, ["install", "tool", FIXTURE, `--harness=${harness}`, ...extra], { [envVar]: dir });
      assert.equal(r.status, EXIT.CONFLICT, `${harness} ${extra}: ${r.stderr}`);
      const errors = stderrLines(r).filter((l) => !l.startsWith("warning: "));
      assert.match(r.stderr, /cannot be read as (yaml|toml)/, r.stderr);
      // The refused file is named, and its note (the code frame, escaped) stays on one line.
      for (const l of errors) assert.match(l, /^(error: |  \S|      \S)/, `${harness} ${extra}: ${JSON.stringify(l)}`);
      assert.equal(errors.filter((l) => l.includes("FORGED")).every((l) => l.includes("\\u000a")), true, r.stderr);
      assert.equal(read(join(dir, file)), text);
    }
  }
}));

test("CLI: an error holding a newline stays on one line; an error that lists items keeps its lines", () => withHome((home) => {
  mkdirSync(join(home, ".claude"));
  const r = vbcdx(home, ["install", "tool", join(home, "missing\nerror: FORGED"), "--harness=claude"]);
  assert.equal(r.status, EXIT.CONFIG);
  assert.deepEqual(stderrLines(r).length, 1, r.stderr);
  assert.match(r.stderr, /^error: No package directory at .*missing\\u000aerror: FORGED/);

  const missing = vbcdx(home, ["install", "tool", "@example/not-installed-anywhere", "--harness=claude"], { npm_config_prefix: join(home, "npm-prefix") });
  assert.equal(missing.status, EXIT.CONFIG);
  assert.deepEqual(stderrLines(missing), [
    "error: @example/not-installed-anywhere is not installed. Install it first, then rerun:",
    "  npm install -g @example/not-installed-anywhere",
  ]);

  const bad = join(home, "bad-decl");
  forgejoPackage(bad);
  const decl = readJson(join(bad, "vbcdx.json"));
  delete decl.env;
  delete decl.stdio;
  writeFileSync(join(bad, "vbcdx.json"), JSON.stringify(decl));
  const invalid = vbcdx(home, ["install", "tool", bad, "--harness=claude", "--dry-run"]);
  assert.equal(invalid.status, EXIT.CONFIG);
  const lines = stderrLines(invalid);
  assert.match(lines[0], /^error: Invalid tool declaration .*vbcdx\.json:$/);
  assert.ok(lines.length >= 3, invalid.stderr);
  for (const l of lines.slice(1)) assert.match(l, /^ {2}\S/, l);
}));

test("CLI: a refused-file list keeps one escaped line per file, dry run or not", () => withHome((home) => {
  const cfg = join(home, "cfg\n  FORGED item");
  mkdirSync(join(cfg, "agents"), { recursive: true });
  writeFileSync(join(cfg, "agents", "review-agent.md"), "hand made\n");
  const item = `  ${join(home, "cfg\\u000a  FORGED item", "agents", "review-agent.md")}`;
  const dry = vbcdx(home, ["install", "agent", "review-agent", "--harness=claude", "--dry-run"], { CLAUDE_CONFIG_DIR: cfg });
  assert.equal(dry.status, EXIT.CONFLICT, dry.stderr);
  assert.deepEqual(stderrLines(dry).filter((l) => !l.startsWith("warning: ")), ["error: 1 item(s) would be refused (rerun with --force):", item]);
  const real = vbcdx(home, ["install", "agent", "review-agent", "--harness=claude"], { CLAUDE_CONFIG_DIR: cfg });
  assert.equal(real.status, EXIT.CONFLICT, real.stderr);
  const lines = stderrLines(real).filter((l) => !l.startsWith("warning: "));
  assert.equal(lines.length, 2, real.stderr);
  assert.match(lines[0], /^error: Refusing to overwrite 1 file\(s\) .*Rerun with --force to replace them:$/);
  assert.equal(lines[1], item);
  assert.equal(read(join(cfg, "agents", "review-agent.md")), "hand made\n");
}));

test("CLI: a dry-run conflict exits 5 like the real run; bad arguments exit 2", () => withHome((home) => {
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { [SERVER]: { command: "theirs" } } }));
  const r = vbcdx(home, ["install", "tool", FIXTURE, "--harness=claude", "--dry-run"]);
  assert.equal(r.status, EXIT.CONFLICT);
  assert.match(r.stderr, /would be refused/);
  assert.equal(vbcdx(home, ["install", "tool", FIXTURE]).status, EXIT.CONFIG);
  assert.equal(vbcdx(home, ["install", "tool", join(home, "missing"), "--harness=claude"]).status, EXIT.CONFIG);
  assert.equal(vbcdx(home, ["--version"]).stdout.trim(), JSON.parse(read(join(ROOT, "package.json"))).version);
}));

// ── packaging ────────────────────────────────────────────────────────────────

test("published as @vbcdx/vbcdx with a vbcdx bin; vbcdx-dev-agents stays as an alias", () => {
  const pkg = JSON.parse(read(join(ROOT, "package.json")));
  assert.equal(pkg.name, "@vbcdx/vbcdx");
  assert.deepEqual(pkg.bin, { vbcdx: "bin/vbcdx.js", "vbcdx-dev-agents": "bin/vbcdx-dev-agents.js" });
  for (const f of ["bin", "src", "schema", "assets"]) assert.ok(pkg.files.includes(f), f);
  // Roles and skills ship in agent packs, never in the installer.
  for (const f of ["skills", "assets/roles"]) assert.ok(!pkg.files.includes(f), f);
});

test("`vbcdx-dev-agents init` still works and prints a deprecation note on stderr", () => withHome((home) => {
  const envFile = join(home, "agents.env");
  writeFileSync(envFile, `VBCDX_AGENTS_BASE_DIR=${home}/state\nVBCDX_AGENTS_CREDENTIALS_DIR=${home}/creds\nVBCDX_AGENTS_CLAUDE_CONFIG_DIR=${home}/cc\n`);
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "vbcdx-dev-agents.js"), "init", PACK_ARG, "--harness=claude", `--env=${envFile}`, "--agents=qa-agent"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /`vbcdx-dev-agents init` is deprecated[\s\S]*vbcdx install agent/);
  assert.ok(existsSync(join(home, "cc", "agents", "qa-agent.md")));
  assert.equal(spawnSync(process.execPath, [join(ROOT, "bin", "vbcdx-dev-agents.js"), "--version"], { encoding: "utf8" }).stderr, "");
}));

test("a setting read only in http mode stays out of the stdio install: entry, warning, doctor and Hermes", () => withHome((home) => {
  const pkg = forgejoPackage(join(home, "fj"));
  const declPath = join(pkg, "vbcdx.json");
  const decl = readJson(declPath);
  decl.http = { args: ["serve"], path: "/mcp", port_env: "FJ_HTTP_PORT" };
  decl.env.push(
    { name: "FJ_HTTP_PORT", description: "Listen port in network mode.", kind: "config", required: true, modes: ["http"] },
    { name: "FJ_STDIO_ONLY", description: "Read by the stdio server only.", kind: "config", required: false, modes: ["stdio"] },
  );
  writeFileSync(declPath, JSON.stringify(decl));
  const r = installTool(ctxFor("claude", home), pkg);
  assert.deepEqual(readJson(join(home, ".claude.json")).mcpServers.forgejo.env, { FJ_URL: "${FJ_URL}", FJ_STDIO_ONLY: "${FJ_STDIO_ONLY:-}" });
  assert.equal(r.warnings.some((w) => w.includes("FJ_HTTP_PORT")), false, "a required http-only setting is not required to start the stdio server");
  const rep = doctor(ctxFor("claude", home), { env: { FJ_URL: "x" } });
  assert.deepEqual(rep.tools[0].checks.filter((c) => c.check.startsWith("env ")).map((c) => c.check), ["env FJ_URL", "env FJ_STDIO_ONLY"]);
  installTool(ctxFor("hermes", home), pkg);
  installAgent(ctxFor("hermes", home), ["review-agent"]);
  const cfg = parsePy(read(join(home, ".hermes", "profiles", "review-agent", "config.yaml")));
  assert.deepEqual(cfg.mcp_servers.forgejo.env, { FJ_URL: "${FJ_URL}", FJ_STDIO_ONLY: "${FJ_STDIO_ONLY}" });
}));

test("an integrations-file stdio service on Hermes starts the way the installed tool of that name and contract declares", () => withHome((home) => {
  const pkg = forgejoPackage(join(home, "fj"));
  const declPath = join(pkg, "vbcdx.json");
  const decl = readJson(declPath);
  decl.http = { args: ["serve"], path: "/mcp", port_env: "FJ_HTTP_PORT" };
  decl.env.push({ name: "FJ_HTTP_PORT", description: "Listen port in network mode.", kind: "config", required: false, modes: ["http"] });
  writeFileSync(declPath, JSON.stringify(decl));
  const manifestFile = join(home, "forgejo.json");
  const integrations = join(home, "integrations.json");
  const cfg = join(home, "config.env");
  const writeIntegrations = (contract) => {
    writeFileSync(manifestFile, JSON.stringify({ ...fullManifest(["get_issue", "whoami"]), contract }));
    writeFileSync(integrations, JSON.stringify({ schema_version: 1, services: { forgejo: { server_name: "forgejo", manifest_file: manifestFile, credentials: { "review-agent": join(home, "creds", "review-agent.env") } } } }));
  };
  writeFileSync(cfg, [`VBCDX_AGENTS_BASE_DIR=${home}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${home}/creds`, `VBCDX_AGENTS_HERMES_HOME=${home}/hermes`,
    `VBCDX_AGENTS_INTEGRATIONS_FILE=${integrations}`, "VBCDX_AGENTS_USER_REVIEW_AGENT=u", "VBCDX_AGENTS_TOKEN_REVIEW_AGENT=t"].join("\n") + "\n");
  const ctx = () => resolveContext({ harness: "hermes", scope: "user", envPath: cfg, home, cwd: home, env: {} });
  writeIntegrations("vbcdx.forgejo/1");
  installTool(ctx(), pkg);
  installAgent(ctx(), ["review-agent"]);
  const server = () => parsePy(read(join(home, "hermes", "profiles", "review-agent", "config.yaml"))).mcp_servers?.forgejo;
  assert.deepEqual(plain(server()), { command: "node", args: [join(pkg, "bin", "fj-tool.js"), "mcp"], env: { FJ_URL: "${FJ_URL}" }, tools: { include: ["get_issue", "whoami"], prompts: false, resources: false } });
  // Another contract under the same name is not that tool, so the bundled companion table is
  // consulted instead, and it has no launch for that contract.
  writeIntegrations("other.forge/1");
  installAgent(ctx(), ["review-agent"], { force: true });
  assert.equal(server(), undefined, "a contract with no companion and no matching installed tool gets no stdio server");
}));

test("doctor checks the settings the package declares now, not the ones recorded at install", () => withHome((home) => {
  const pkg = forgejoPackage(join(home, "fj"));
  installTool(ctxFor("claude", home), pkg);
  const declPath = join(pkg, "vbcdx.json");
  const decl = readJson(declPath);
  decl.env.push({ name: "FJ_NEW_REQUIRED", description: "A setting a later version requires.", kind: "config", required: true });
  writeFileSync(declPath, JSON.stringify(decl));
  const rep = doctor(ctxFor("claude", home), { env: { FJ_URL: "x" } });
  const check = rep.tools[0].checks.find((c) => c.check === "env FJ_NEW_REQUIRED");
  assert.deepEqual(check, { check: "env FJ_NEW_REQUIRED", ok: false, detail: "not set (required)" });
  assert.equal(rep.ok, false);
  // An invalid declaration falls back to the recorded settings, and is reported as invalid.
  writeFileSync(declPath, "{");
  const bad = doctor(ctxFor("claude", home), { env: { FJ_URL: "x" } });
  assert.ok(bad.tools[0].checks.some((c) => c.check === "declaration" && !c.ok));
  assert.ok(bad.tools[0].checks.some((c) => c.check === "env FJ_URL" && c.ok));
}));

test("install agent all installs every role of the loaded packs; an unknown id names the loaded roles", () => withHome((home) => {
  mkdirSync(join(home, ".claude"));
  let r = vbcdx(home, ["install", "agent", "all", "--harness=claude", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).generated.map((g) => g.role), [...FIXTURE_IDS]);
  r = vbcdx(home, ["install", "agent", "nosuch-agent", "--harness=claude"]);
  assert.equal(r.status, EXIT.CONFIG);
  assert.match(r.stderr, /Unknown agent ID in selection: nosuch-agent .* The loaded roles are: [a-z-]+(, [a-z-]+)+; `vbcdx packs` lists them by pack\./);
  assert.ok(r.stderr.includes(FIXTURE_IDS[0]));
}));
