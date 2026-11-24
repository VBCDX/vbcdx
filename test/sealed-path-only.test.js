// One path for a tool's key: Keyhole and the sidecar. The installer writes no credential
// file, reads none, and writes no harness entry that carries or references a key.
//
// These tests pin the refusals that replace the per-role credential-file mode:
//   rule 1  the configuration file's per-role credential keys are refused by name;
//   rule 2  the integrations file's credential fields are refused by name;
//   rule 3  a tool package that asks for a key is refused;
//   rule 4  credential files an earlier version left on disk are reported, never touched;
//   rule 5  no MCP entry has headers, a url, or a reference to a credential.
// Every refusal is checked for three things: its exit code, that nothing was written,
// and that no value (a token, a file's content, a path inside a credentials map) is echoed.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as tomlParse } from "smol-toml";
import { parsePy } from "../src/fs/pyyaml.js";
import { loadConfig } from "../src/config/config.js";
import { loadIntegrations } from "../src/config/integrations.js";
import { validateToolDeclaration, assertToolDeclaration, KEYED_TOOL_REFUSAL } from "../src/install/tool-declaration.js";
import { mcpTarget, renderMcpEntry, skillTarget } from "../src/install/harness-targets.js";
import { legacyCredentialLeftovers, leftoverWarning, LEFTOVER_ADVICE, SESSION_STORE_DIR } from "../src/install/legacy-credentials.js";
import { installedToolBindings, isKeyedToolRecord, installAgent, installTool, doctor } from "../src/install/commands.js";
import { resolveContext } from "../src/install/context.js";
import { buildPlan } from "../src/planner.js";
import { executePlan } from "../src/executor.js";
import { renderHermes } from "../src/renderers/hermes.js";
import { renderFlat } from "../src/renderers/index.js";
import { boundServiceTools, boundToolsNote } from "../src/renderers/native.js";
import { getRole } from "../src/roles/index.js";
import { activeCatalog, setActiveCatalog } from "../src/packs/catalog.js";
import { readPack, validateRoleDescriptor } from "../src/packs/load.js";
import { EXIT, InstallerError } from "../src/errors.js";
import * as errors from "../src/errors.js";
import * as safeWriter from "../src/fs/safe-writer.js";
import * as registry from "../src/roles/registry.js";
import { FIXTURE_IDS, FIXTURE_PACK_DIR, PACK_ARG } from "./helpers/fixture-pack.js";

// The integrations file is read only if no one but its owner can change it; pin the umask so
// a host with umask 002 writes the fixtures the same way.
process.umask(0o022);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TOOL_FIXTURE = join(HERE, "fixtures", "tool-package");
const HARNESSES = ["claude", "codex", "opencode", "hermes"];
// A value that must never come back: on stdout, on stderr, in an error or in a written file.
const CANARY = "CANARY-9f3e7a-do-not-echo";

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "vbcdx-sealed-"));
  roots.push(d);
  return d;
}
const read = (p) => readFileSync(p, "utf8");

/** Every file under `dir`, relative, sorted: what "nothing was written" is compared on. */
function tree(dir) {
  const out = [];
  const walk = (p) => {
    for (const name of readdirSync(p)) {
      const full = join(p, name);
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full);
      else out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

function vbcdx(home, args, { env = {}, bin = "vbcdx.js" } = {}) {
  return spawnSync(process.execPath, [join(ROOT, "bin", bin), ...args], {
    encoding: "utf8", cwd: home, timeout: 60000,
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, ...env },
  });
}

/** A home with a Claude config dir, and a config file with these extra lines. */
function homeWithConfig(lines = [], harness = "claude") {
  const home = scratch();
  const harnessDir = join(home, `.${harness}`);
  mkdirSync(harnessDir);
  const key = { claude: "VBCDX_AGENTS_CLAUDE_CONFIG_DIR", hermes: "VBCDX_AGENTS_HERMES_HOME" }[harness];
  const cfg = join(home, "cfg.env");
  writeFileSync(cfg, [`VBCDX_AGENTS_BASE_DIR=${home}/state`, `${key}=${harnessDir}`, ...lines].join("\n") + "\n");
  return { home, cfg, harnessDir };
}

const ctxFor = (harness, home, opts = {}) => resolveContext({ harness, scope: "user", envPath: null, home, cwd: home, env: {}, ...opts });

function codeAndMessage(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof InstallerError, `expected an InstallerError, got ${err && err.stack}`);
    return { code: err.code, message: err.message };
  }
  return { code: EXIT.OK, message: "" };
}

// ── rule 1: per-role credential keys in the configuration file ──────────────────

const cfgMap = (extra) => new Map(Object.entries({ VBCDX_AGENTS_BASE_DIR: "/b", ...extra }));

test("rule 1: every per-role credential key is refused by name, exit 2, whatever its value", () => {
  // The shapes an earlier version accepted or diagnosed one by one: a role-wide triple, a
  // role-and-service triple, an invalid role suffix, an invalid service suffix, an unknown role
  // before "__", two spellings of one triple, an incomplete triple, and a blank ("disabled") one.
  const shapes = [
    { VBCDX_AGENTS_USER_CODE_AGENT: CANARY, VBCDX_AGENTS_TOKEN_CODE_AGENT: CANARY },
    { VBCDX_AGENTS_TOKEN_CODE_AGENT__FORGEJO: CANARY },
    { VBCDX_AGENTS_PASSWORD_CODE_AGENT__FORGEJO: CANARY },
    { "VBCDX_AGENTS_TOKEN_../../etc": CANARY },
    { VBCDX_AGENTS_TOKEN_CODE_AGENT__BAD__NAME: CANARY },
    { VBCDX_AGENTS_TOKEN_CODE__AGENT__FORGEJO: CANARY },
    { VBCDX_AGENTS_TOKEN_CODE_AGENT: CANARY, VBCDX_AGENTS_TOKEN_code_agent: CANARY },
    { VBCDX_AGENTS_USER_CODE_AGENT: CANARY },
    { VBCDX_AGENTS_USER_NOT_A_ROLE: CANARY },
    { VBCDX_AGENTS_TOKEN_CODE_AGENT: "" },
  ];
  for (const keys of shapes) {
    const { code, message } = codeAndMessage(() => loadConfig(cfgMap(keys), { harness: "claude", scope: "project" }));
    assert.equal(code, EXIT.CONFIG, JSON.stringify(Object.keys(keys)));
    assert.match(message, /Credential files are no longer written; remove these keys from the configuration file: /);
    assert.match(message, /Put each key in Keyhole and grant the tool/);
    for (const k of Object.keys(keys)) assert.ok(message.includes(k), `the refusal names ${k}`);
    assert.equal(message.includes(CANARY), false, "no value in the refusal");
  }
});

test("rule 1: the refusal lists every such key at once, and nothing else in the file", () => {
  const { message } = codeAndMessage(() => loadConfig(cfgMap({
    VBCDX_AGENTS_USER_A: "u", VBCDX_AGENTS_TOKEN_B__X: "t", VBCDX_AGENTS_PASSWORD_C: "p",
    VBCDX_AGENTS_HERMES_MODEL: "m", PATH: "/usr/bin", VBCDX_AGENTS_CODE_HOST_URL: "https://git.example",
  }), { harness: "claude", scope: "project" }));
  assert.match(message, /: VBCDX_AGENTS_USER_A, VBCDX_AGENTS_TOKEN_B__X, VBCDX_AGENTS_PASSWORD_C\. /);
  for (const other of ["VBCDX_AGENTS_HERMES_MODEL", "PATH", "VBCDX_AGENTS_CODE_HOST_URL", "VBCDX_AGENTS_BASE_DIR"]) {
    assert.equal(message.includes(other), false, `${other} is not a credential key`);
  }
});

test("rule 1: keys that only look similar are not credential keys", () => {
  // No suffix after the field, or another field word: the unknown-key rule answers, not rule 1.
  for (const k of ["VBCDX_AGENTS_TOKEN", "VBCDX_AGENTS_TOKEN_", "VBCDX_AGENTS_SECRET_CODE_AGENT", "VBCDX_AGENTS_USERS_X"]) {
    const { code, message } = codeAndMessage(() => loadConfig(cfgMap({ [k]: "v" }), { harness: "claude", scope: "project" }));
    assert.equal(code, EXIT.CONFIG);
    if (k === "VBCDX_AGENTS_USERS_X") continue; // USER + S_X would be a stretch; only the code matters
    assert.match(message, /Unsupported configuration key/, k);
  }
  // An unrelated key that merely contains the words is ignored, as every unrelated key is.
  assert.equal(loadConfig(cfgMap({ MY_VBCDX_AGENTS_TOKEN_X: "v" }), { harness: "claude", scope: "project" }).baseDir, "/b");
});

for (const [label, bin, argv] of [
  ["vbcdx install agent", "vbcdx.js", (cfg) => ["install", "agent", "code-agent", "--harness=claude", `--env=${cfg}`, PACK_ARG]],
  ["vbcdx install agent --dry-run", "vbcdx.js", (cfg) => ["install", "agent", "code-agent", "--harness=claude", `--env=${cfg}`, PACK_ARG, "--dry-run"]],
  ["vbcdx install tool", "vbcdx.js", (cfg) => ["install", "tool", TOOL_FIXTURE, "--harness=claude", `--env=${cfg}`]],
  ["vbcdx doctor", "vbcdx.js", (cfg) => ["doctor", "--harness=claude", `--env=${cfg}`]],
  ["vbcdx-dev-agents init", "vbcdx-dev-agents.js", (cfg) => ["init", PACK_ARG, "--harness=claude", `--env=${cfg}`, "--agents=code-agent"]],
]) {
  test(`rule 1 at the command line (${label}): exit 2, nothing written, no value echoed`, () => {
    const { home, cfg } = homeWithConfig([`VBCDX_AGENTS_USER_CODE_AGENT__FORGEJO=${CANARY}`, `VBCDX_AGENTS_TOKEN_CODE_AGENT__FORGEJO=${CANARY}`]);
    const before = tree(home);
    const r = vbcdx(home, argv(cfg), { bin });
    assert.equal(r.status, EXIT.CONFIG, r.stderr);
    assert.match(r.stderr, /remove these keys from the configuration file: VBCDX_AGENTS_USER_CODE_AGENT__FORGEJO, VBCDX_AGENTS_TOKEN_CODE_AGENT__FORGEJO\./);
    assert.equal((r.stdout + r.stderr).includes(CANARY), false, "the token is never echoed");
    assert.deepEqual(tree(home), before, "nothing was written: no definition, no manifest, no credential file");
  });
}

test("a config file without the old credentials-dir key loads, and no command creates that directory", () => {
  const { home, cfg } = homeWithConfig();
  const r = vbcdx(home, ["install", "agent", "code-agent", "--harness=claude", `--env=${cfg}`, PACK_ARG]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "", "no warning on a clean host");
  assert.doesNotMatch(r.stdout, /credential/);
  assert.equal(existsSync(join(home, "state", "credentials")), false);
  // Without --env the context no longer names a credentials directory either.
  const ctx = ctxFor("claude", home);
  assert.equal(ctx.entries.has("VBCDX_AGENTS_CREDENTIALS_DIR"), false);
  assert.equal(ctx.config.legacyCredentialsDir, join(home, ".vbcdx", "credentials"));
});

// ── rule 2: credential fields in the integrations file ───────────────────────────

const tool = (name) => ({ name, description: name, inputSchema: {}, outputSchema: {}, effect: "read", required_permissions: [] });
function integrationsFile(services, { contract = "example.tracker/1" } = {}) {
  const dir = scratch();
  const out = {};
  for (const [name, svc] of Object.entries(services)) {
    const manifest = { schema_version: 1, service: name, contract: svc.$contract || contract, package_version: "0.1.0", tools: [tool("get_issue"), tool("whoami")] };
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(manifest));
    const { $contract, ...rest } = svc;
    out[name] = { server_name: name, manifest_file: join(dir, `${name}.json`), ...rest };
  }
  const file = join(dir, "integrations.json");
  writeFileSync(file, JSON.stringify({ schema_version: 1, services: out }));
  chmodSync(file, 0o600);
  return file;
}
const HTTP = { transport: "http", url: `https://gw.example/mcp/${CANARY}`, roles: ["code-agent"] };

test("rule 2: each credential field of a service is refused by name, exit 2", () => {
  const cases = [
    // A role -> credential file map, on a stdio service: the old binding.
    [{ credentials: { "code-agent": `/abs/${CANARY}.env` } }, ["tracker.credentials"]],
    // The shapes the old loader diagnosed one by one (not an object, an unknown role, a relative path).
    [{ credentials: CANARY }, ["tracker.credentials"]],
    [{ credentials: { "no-such-role": `/abs/${CANARY}` } }, ["tracker.credentials"]],
    [{ credentials: { "code-agent": `relative/${CANARY}` } }, ["tracker.credentials"]],
    [{ credentials: {} }, ["tracker.credentials"]],
    [{ headers: { Authorization: `Bearer ${CANARY}` } }, ["tracker.headers"]],
    // An http service: every call carried the role's bearer token.
    [HTTP, ["tracker.transport", "tracker.url", "tracker.roles"]],
    [{ ...HTTP, tool_prefix: "Gw-" }, ["tracker.transport", "tracker.url", "tracker.roles", "tracker.tool_prefix"]],
    [{ transport: "http" }, ["tracker.transport"]],
    // http with credentials, and plain http off-host with or without the old opt-in.
    [{ ...HTTP, credentials: {} }, ["tracker.credentials", "tracker.transport", "tracker.url", "tracker.roles"]],
    [{ ...HTTP, url: `http://${CANARY}.example/mcp`, allow_cleartext: true }, ["tracker.allow_cleartext", "tracker.transport", "tracker.url", "tracker.roles"]],
    [{ ...HTTP, url: `http://${CANARY}.example/mcp` }, ["tracker.transport", "tracker.url", "tracker.roles"]],
    [{ allow_cleartext: false }, ["tracker.allow_cleartext"]],
  ];
  for (const [svc, fields] of cases) {
    const file = integrationsFile({ tracker: svc });
    const { code, message } = codeAndMessage(() => loadIntegrations(file));
    assert.equal(code, EXIT.CONFIG, JSON.stringify(svc));
    assert.ok(message.startsWith(`Integrations file ${file}: per-role credentials are no longer read or sent; remove these fields: ${fields.join(", ")}. `), message);
    assert.match(message, /Put each key in Keyhole and grant the tool/);
    assert.equal(message.replace(file, "").includes(CANARY), false, "no path, url or header value in the refusal");
  }
});

test("rule 2: one refusal names the fields of every service in the file", () => {
  const file = integrationsFile({
    alpha: { credentials: { "code-agent": "/abs/a.env" } },
    clean: {},
    beta: HTTP,
  });
  const { message } = codeAndMessage(() => loadIntegrations(file));
  assert.match(message, /remove these fields: alpha\.credentials, beta\.transport, beta\.url, beta\.roles\. /);
  assert.equal(message.includes("clean."), false);
});

test("rule 2: a credential file the map points at is never opened, whatever it is", () => {
  // Missing, for another role, malformed, a directory, a dangling symlink: an earlier version
  // read the file and answered each differently (exit 3 or 4). Now the answer is the same for
  // all of them, because the field is refused before any path in it is looked at.
  const dir = scratch();
  writeFileSync(join(dir, "other-role.env"), `VBCDX_AGENTS_ROLE=pm-agent\nVBCDX_AGENTS_TOKEN=${CANARY}\n`);
  writeFileSync(join(dir, "malformed.env"), `not an env file ${CANARY}\n`);
  mkdirSync(join(dir, "a-directory"));
  symlinkSync(join(dir, "nowhere"), join(dir, "dangling"));
  const messages = new Set();
  for (const target of ["missing.env", "other-role.env", "malformed.env", "a-directory", "dangling"]) {
    const file = integrationsFile({ tracker: { credentials: { "code-agent": join(dir, target) } } });
    const { code, message } = codeAndMessage(() => loadIntegrations(file));
    assert.equal(code, EXIT.CONFIG);
    assert.equal(message.includes(CANARY), false);
    assert.equal(message.includes(target), false, "the credential path is not echoed");
    messages.add(message.replace(file, "<file>"));
  }
  assert.equal(messages.size, 1, "the same refusal whatever the file is");
});

test("rule 2: a service with no credential field loads, binds no role, and exposes no credentials map", () => {
  const file = integrationsFile({ tracker: { stdio: { command: "example-tracker", args: ["mcp"], env: ["EXAMPLE_TRACKER_URL"] } } });
  const { services } = loadIntegrations(file);
  assert.equal(Object.hasOwn(services.tracker, "credentials"), false);
  assert.deepEqual(services.tracker.roles, []);
  assert.deepEqual(Object.keys(services.tracker).sort(), ["contract", "manifestFile", "packageVersion", "roles", "serverName", "stdio", "tools"]);
  for (const id of FIXTURE_IDS) {
    assert.deepEqual(boundServiceTools({ ...getRole(id).descriptor, remote_capabilities: { "example.tracker/1": ["whoami"] } }, { services }), []);
  }
});

test("rule 2 at the command line: exit 2, nothing written, no value echoed (install agent, init, dry run)", () => {
  for (const [bin, argv] of [
    ["vbcdx.js", (cfg) => ["install", "agent", "code-agent", "--harness=claude", `--env=${cfg}`, PACK_ARG]],
    ["vbcdx.js", (cfg) => ["install", "agent", "code-agent", "--harness=claude", `--env=${cfg}`, PACK_ARG, "--dry-run"]],
    ["vbcdx-dev-agents.js", (cfg) => ["init", PACK_ARG, "--harness=claude", `--env=${cfg}`, "--agents=code-agent"]],
  ]) {
    const credFile = join(scratch(), "code-agent.env");
    writeFileSync(credFile, `VBCDX_AGENTS_ROLE=code-agent\nVBCDX_AGENTS_USER=u\nVBCDX_AGENTS_TOKEN=${CANARY}\n`);
    const file = integrationsFile({ tracker: { credentials: { "code-agent": credFile } }, gateway: HTTP });
    const { home, cfg } = homeWithConfig([`VBCDX_AGENTS_INTEGRATIONS_FILE=${file}`]);
    const before = tree(home);
    const r = vbcdx(home, argv(cfg), { bin });
    assert.equal(r.status, EXIT.CONFIG, r.stderr);
    assert.match(r.stderr, /remove these fields: tracker\.credentials, gateway\.transport, gateway\.url, gateway\.roles\./);
    assert.equal((r.stdout + r.stderr).includes(CANARY), false);
    assert.equal((r.stdout + r.stderr).includes(credFile), false, "the credential file's path is not echoed");
    assert.deepEqual(tree(home), before, "nothing was written");
  }
});

// ── rule 3: a tool package that asks for a key ───────────────────────────────────

const keylessDecl = () => JSON.parse(read(join(TOOL_FIXTURE, "vbcdx.json")));
const credentialEnv = { name: "EXAMPLE_TRACKER_TOKEN", description: "API token for the tracker.", kind: "credential", required: false };

test("the shared tool fixture is keyless: no credential_file, no credential-kind variable", () => {
  const decl = keylessDecl();
  assert.equal(validateToolDeclaration(decl).ok, true);
  assert.equal("credential_file" in decl, false);
  assert.deepEqual([...new Set(decl.env.map((e) => e.kind))], ["config"]);
});

test("rule 3: a declaration with credential_file is refused once, with the Keyhole pointer, whatever the field holds", () => {
  for (const value of [{ argument: "credential_file" }, { argument: "Bad-Name" }, "credential_file", null, 42, { argument: "x", extra: CANARY }]) {
    const { ok, errors: errs } = validateToolDeclaration({ ...keylessDecl(), credential_file: value });
    assert.equal(ok, false);
    assert.deepEqual(errs, [`credential_file is no longer supported: ${KEYED_TOOL_REFUSAL}.`], JSON.stringify(value));
  }
  assert.match(KEYED_TOOL_REFUSAL, /this tool needs a key; register it as a Keyhole tool/);
});

test("rule 3: an env item of kind credential is refused with the same pointer; any other unknown kind keeps its own error", () => {
  const decl = keylessDecl();
  const res = validateToolDeclaration({ ...decl, env: [...decl.env, credentialEnv] });
  assert.deepEqual(res.errors, [`env[${decl.env.length}].kind is "credential": ${KEYED_TOOL_REFUSAL}.`]);
  const other = validateToolDeclaration({ ...decl, env: decl.env.map((e, i) => (i === 0 ? { ...e, kind: "secret" } : e)) });
  assert.deepEqual(other.errors, ["env[0].kind must be one of config."]);
  // Both at once: both are named.
  const both = validateToolDeclaration({ ...decl, env: [...decl.env, credentialEnv], credential_file: { argument: "credential_file" } });
  assert.equal(both.errors.length, 2);
  assert.ok(both.errors.every((e) => e.includes(KEYED_TOOL_REFUSAL)));
});

test("rule 3: the shipped schema has neither credential_file nor the credential kind", () => {
  const schema = JSON.parse(read(join(ROOT, "schema", "vbcdx-tool.schema.json")));
  assert.equal(Object.hasOwn(schema.properties, "credential_file"), false);
  assert.deepEqual(schema.properties.env.items.properties.kind.enum, ["config"]);
  assert.equal(schema.additionalProperties, false, "so a schema-only validator refuses credential_file too");
});

test("rule 3: assertToolDeclaration throws exit 2 and echoes nothing the declaration held", () => {
  const { code, message } = codeAndMessage(() => assertToolDeclaration({ ...keylessDecl(), credential_file: { argument: CANARY } }));
  assert.equal(code, EXIT.CONFIG);
  assert.match(message, /^Invalid tool declaration vbcdx\.json:\n {2}credential_file is no longer supported: this tool needs a key; register it as a Keyhole tool/);
  assert.equal(message.includes(CANARY), false);
});

/** A copy of the tool fixture, its declaration changed by `mutate`, whose bin records being run. */
function markedPackage(mutate = () => {}) {
  const dir = join(scratch(), "marked-tool");
  cpSync(TOOL_FIXTURE, dir, { recursive: true });
  const decl = JSON.parse(read(join(dir, "vbcdx.json")));
  delete decl.$schema;
  mutate(decl);
  writeFileSync(join(dir, "vbcdx.json"), JSON.stringify(decl));
  // When the manifest command runs, it leaves this marker in the package directory.
  const bin = join(dir, "bin", "example-tracker");
  const src = read(bin);
  assert.ok(src.includes("// Test fixture"));
  writeFileSync(bin, src.replace("// Test fixture", `import { writeFileSync as mark } from "node:fs";\nmark(${JSON.stringify(join(dir, "RAN"))}, "");\n// Test fixture`));
  return dir;
}

test("control for the rule 3 rows: the same package without a key request installs, and its manifest command runs", () => {
  const home = scratch();
  mkdirSync(join(home, ".claude"));
  const pkg = markedPackage();
  const r = vbcdx(home, ["install", "tool", pkg, "--harness=claude"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(pkg, "RAN")), true, "the marker shows when the package's code runs");
  assert.ok(JSON.parse(read(join(home, ".claude.json"))).mcpServers["example-tracker"]);
});

for (const [label, mutate] of [
  ["credential_file", (d) => { d.credential_file = { argument: "credential_file" }; }],
  ["an env item of kind credential", (d) => { d.env.push(credentialEnv); }],
]) {
  for (const harness of HARNESSES) {
    test(`rule 3 at the command line: install tool refuses a package with ${label} (${harness}), exit 2, nothing written or run`, () => {
      const home = scratch();
      mkdirSync(join(home, { claude: ".claude", codex: ".codex", opencode: ".config/opencode", hermes: ".hermes" }[harness]), { recursive: true });
      const pkg = markedPackage(mutate);
      const before = tree(home);
      for (const extra of [[], ["--dry-run"], ["--force"]]) {
        const r = vbcdx(home, ["install", "tool", pkg, `--harness=${harness}`, ...extra], { env: { EXAMPLE_TRACKER_TOKEN: CANARY } });
        assert.equal(r.status, EXIT.CONFIG, r.stderr);
        assert.match(r.stderr, /this tool needs a key; register it as a Keyhole tool/);
        assert.equal((r.stdout + r.stderr).includes(CANARY), false);
      }
      assert.deepEqual(tree(home), before, "no harness entry and no manifest");
      assert.equal(existsSync(join(pkg, "RAN")), false, "the package's code was not run");
    });
  }
}

// ── rule 5: no MCP entry carries or references a credential ──────────────────────

/** Every key at any depth of a parsed entry. */
function keysOf(value, out = new Set()) {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (!Array.isArray(value)) out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}
const ALLOWED_ENTRY_KEYS = {
  claude: ["type", "command", "args", "env"],
  codex: ["command", "args", "env_vars"],
  opencode: ["type", "command", "enabled", "environment"],
  hermes: ["command", "args", "env"],
};
const FORBIDDEN_ENTRY_KEYS = ["headers", "url", "Authorization", "authorization", "token", "bearer_token_env_var", "http_headers"];
const LAUNCH = { command: "node", args: ["/abs/bin/example-tracker", "mcp"] };

test("rule 5: for every harness, an MCP entry is a stdio launch with references to config settings only", () => {
  const decl = keylessDecl();
  const configNames = decl.env.filter((e) => !e.modes || e.modes.includes("stdio")).map((e) => e.name);
  for (const harness of HARNESSES) {
    const entry = renderMcpEntry(harness, decl, LAUNCH);
    assert.deepEqual(Object.keys(entry).sort(), [...ALLOWED_ENTRY_KEYS[harness]].sort(), harness);
    for (const k of FORBIDDEN_ENTRY_KEYS) assert.equal(keysOf(entry).has(k), false, `${harness}: ${k}`);
    const envPart = entry.env || entry.environment || Object.fromEntries(entry.env_vars.map((n) => [n, ""]));
    assert.deepEqual(Object.keys(envPart), configNames, `${harness}: only the declared config settings`);
    // References, never values: nothing from the environment is copied in.
    assert.doesNotMatch(JSON.stringify(entry), /https?:\/\/|Bearer/, harness);
  }
  assert.equal(renderMcpEntry("unknown", decl, LAUNCH), null);
});

test("an MCP entry and a skill go to the harness's own file, user or project scope; an unknown harness has none", () => {
  const ctx = (harness, scope, rootExplicit = true) => ({ harness, scope, config: { harnessRoot: "/root-of-harness" }, worktreeRoot: "/work", home: "/home/u", rootExplicit });
  const where = (harness, scope, explicit) => { const t = mcpTarget(ctx(harness, scope, explicit), "srv"); return t && [t.file, t.format, t.path.join("."), t.mode]; };
  assert.deepEqual(where("claude", "user"), ["/root-of-harness/.claude.json", "json", "mcpServers.srv", 0o600]);
  assert.deepEqual(where("claude", "user", false), ["/home/u/.claude.json", "json", "mcpServers.srv", 0o600]);
  assert.deepEqual(where("claude", "project"), ["/work/.mcp.json", "json", "mcpServers.srv", 0o644]);
  assert.deepEqual(where("codex", "user"), ["/root-of-harness/config.toml", "toml", "mcp_servers.srv", 0o600]);
  assert.deepEqual(where("codex", "project"), ["/work/.codex/config.toml", "toml", "mcp_servers.srv", 0o600]);
  assert.deepEqual(where("opencode", "user"), ["/root-of-harness/opencode.json", "json", "mcp.srv", 0o644]);
  assert.deepEqual(where("opencode", "project"), ["/work/opencode.json", "json", "mcp.srv", 0o644]);
  assert.deepEqual(where("hermes", "user"), ["/root-of-harness/config.yaml", "yaml", "mcp_servers.srv", 0o600]);
  assert.equal(where("unknown", "user"), null);
  const skill = (harness, scope) => skillTarget(ctx(harness, scope), "notes");
  assert.equal(skill("claude", "user"), "/root-of-harness/skills/notes/SKILL.md");
  assert.equal(skill("claude", "project"), "/work/.claude/skills/notes/SKILL.md");
  assert.equal(skill("opencode", "user"), "/root-of-harness/skills/notes/SKILL.md");
  assert.equal(skill("opencode", "project"), "/work/.opencode/skills/notes/SKILL.md");
  assert.equal(skill("codex", "user"), "/home/u/.agents/skills/notes/SKILL.md");
  assert.equal(skill("codex", "project"), "/work/.agents/skills/notes/SKILL.md");
  assert.equal(skill("hermes", "user"), null);
});

test("rule 5: a renderer asked to write an entry for a keyed declaration refuses, for every harness", () => {
  const decl = keylessDecl();
  for (const harness of [...HARNESSES, "unknown"]) {
    for (const keyed of [
      { ...decl, credential_file: { argument: "credential_file" } },
      { ...decl, env: [...decl.env, credentialEnv] },
      { ...decl, env: [credentialEnv] },
    ]) {
      const { code, message } = codeAndMessage(() => renderMcpEntry(harness, keyed, LAUNCH));
      assert.equal(code, EXIT.CONFIG, harness);
      assert.equal(message, `No MCP entry is written for example-tracker: ${KEYED_TOOL_REFUSAL}.`);
    }
    // A credential-kind variable read only in http mode is not part of the stdio entry, but the
    // declaration is refused before that (rule 3); the renderer judges the stdio set it would write.
    const httpOnly = { ...decl, env: [{ ...credentialEnv, modes: ["http"] }] };
    assert.equal(validateToolDeclaration(httpOnly).ok, false);
  }
});

test("rule 5 end to end: install a keyless tool and an agent for every harness; nothing on disk has a header, url or key", () => {
  for (const harness of HARNESSES) {
    const home = scratch();
    const rel = { claude: ".claude", codex: ".codex", opencode: ".config/opencode", hermes: ".hermes" }[harness];
    mkdirSync(join(home, rel), { recursive: true });
    const env = { EXAMPLE_TRACKER_URL: `https://tracker.example/${CANARY}`, EXAMPLE_TRACKER_WRITES: CANARY };
    let r = vbcdx(home, ["install", "tool", TOOL_FIXTURE, `--harness=${harness}`], { env });
    assert.equal(r.status, 0, r.stderr);
    r = vbcdx(home, ["install", "agent", "code-agent", `--harness=${harness}`, PACK_ARG], { env });
    assert.equal(r.status, 0, r.stderr);
    const entryFile = { claude: ".claude.json", codex: ".codex/config.toml", opencode: ".config/opencode/opencode.json", hermes: ".hermes/config.yaml" }[harness];
    const raw = read(join(home, entryFile));
    const doc = harness === "codex" ? JSON.parse(JSON.stringify(tomlParse(raw))) : harness === "hermes" ? parsePy(raw) : JSON.parse(raw);
    const entry = (doc.mcpServers || doc.mcp_servers || doc.mcp)["example-tracker"];
    assert.ok(entry, `${harness}: the entry exists`);
    assert.deepEqual(Object.keys(entry).sort(), [...ALLOWED_ENTRY_KEYS[harness]].sort(), harness);
    for (const file of tree(home)) {
      const text = read(join(home, file));
      assert.equal(text.includes(CANARY), false, `${harness}: ${file} holds a value from the environment`);
      assert.doesNotMatch(text, /"headers"|headers:|Authorization|Bearer |credential_file/, `${harness}: ${file}`);
      assert.doesNotMatch(text, /vbx_ses_/, `${harness}: ${file} holds a session token`);
    }
    assert.equal(existsSync(join(home, ".vbcdx", "credentials")), false, `${harness}: no credentials directory is created`);
  }
});

test("no rendered role definition names a credential file, for any harness or binding", () => {
  const integrations = { services: {
    "example-tracker": { serverName: "example-tracker", contract: "example.tracker/1", tools: ["get_issue", "whoami"],
      roles: [...FIXTURE_IDS], stdio: { command: "node", args: ["x"], env: { EXAMPLE_TRACKER_URL: "${EXAMPLE_TRACKER_URL}" } } },
  } };
  for (const id of FIXTURE_IDS) {
    const base = getRole(id);
    const role = { ...base, descriptor: { ...base.descriptor, remote_capabilities: { "example.tracker/1": ["whoami"] } } };
    const texts = [
      ...["claude", "codex", "opencode"].map((h) => renderFlat(h, role, { integrations }).content),
      ...renderHermes(role, { integrations }).files.map((f) => f.content),
    ];
    for (const t of texts) assert.doesNotMatch(t, /credential_file|Bound service credentials|credentials\/|\.env"/, id);
    // What a bound role is told: the server and its tools, nothing else.
    assert.match(texts[0], /## Bound service tools\n\n- `example-tracker`: tools available to your role: whoami\.\n/);
  }
  assert.equal(boundToolsNote([]), "");
});

test("a binding needs the role in the service's roles list; no credentials map can bind one", () => {
  const descriptor = { ...getRole("code-agent").descriptor, remote_capabilities: { "example.tracker/1": ["whoami"] } };
  const svc = (extra) => ({ services: { t: { contract: "example.tracker/1", tools: ["whoami"], ...extra } } });
  assert.equal(boundServiceTools(descriptor, svc({ roles: ["code-agent"] })).length, 1);
  assert.deepEqual(boundServiceTools(descriptor, svc({ roles: ["pm-agent"] })), []);
  assert.deepEqual(boundServiceTools(descriptor, svc({})), []);
  // No integrations, no services, a descriptor with no remote capabilities, and an allowlist
  // none of whose tools the service has: nothing is bound, and nothing is widened to make a match.
  assert.deepEqual(boundServiceTools(descriptor, null), []);
  assert.deepEqual(boundServiceTools(descriptor, {}), []);
  assert.deepEqual(boundServiceTools({ id: "code-agent" }, svc({ roles: ["code-agent"] })), []);
  assert.deepEqual(boundServiceTools({ ...descriptor, remote_capabilities: { "example.tracker/1": [] } }, svc({ roles: ["code-agent"] })), []);
  assert.deepEqual(boundServiceTools({ ...descriptor, remote_capabilities: { "example.tracker/1": ["get_issue"] } }, svc({ roles: ["code-agent"] })), []);
  // The shapes an earlier version bound a role with are inert now.
  assert.deepEqual(boundServiceTools(descriptor, svc({ credentials: { "code-agent": "/abs/code-agent.env" } })), []);
  assert.deepEqual(boundServiceTools(descriptor, svc({ credentials: { "code-agent": "/abs/code-agent.env" }, roles: [] })), []);
  assert.deepEqual(boundServiceTools(descriptor, svc({ credentialFree: true })), []);
});

// ── rule 4: credential files an earlier version left on disk ─────────────────────

/** The 0.2.13 / 0.2.14 layout: <dir>/<role>.env and <dir>/<role>/<service>.env, 0600 in 0700 dirs. */
function oldCredentialFiles(dir) {
  mkdirSync(join(dir, "code-agent"), { recursive: true });
  chmodSync(dir, 0o700);
  chmodSync(join(dir, "code-agent"), 0o700);
  const files = [join(dir, "code-agent.env"), join(dir, "code-agent", "forgejo.env")];
  for (const f of files) {
    writeFileSync(f, `VBCDX_AGENTS_ROLE="code-agent"\nVBCDX_AGENTS_USER="bot"\nVBCDX_AGENTS_TOKEN="${CANARY}"\n`);
    chmodSync(f, 0o600);
  }
  return files;
}
/** What must not change: each file's bytes, mode, and modification time. */
const snapshot = (files) => files.map((f) => { const st = lstatSync(f); return [f, st.mode, st.mtimeMs, st.size, st.isFile() ? read(f) : null]; });

test("rule 4: the lister reports every file of the old layout by path, and nothing under services/", () => {
  const dir = join(scratch(), "credentials");
  const files = oldCredentialFiles(dir);
  mkdirSync(join(dir, SESSION_STORE_DIR, "default"), { recursive: true });
  writeFileSync(join(dir, SESSION_STORE_DIR, "default", "session.json"), "{}");
  assert.deepEqual(legacyCredentialLeftovers(dir), [...files].sort());
  // Only the top-level services/ is the session store: the same name deeper is a leftover.
  mkdirSync(join(dir, "code-agent", SESSION_STORE_DIR));
  writeFileSync(join(dir, "code-agent", SESSION_STORE_DIR, "x.env"), "x");
  assert.deepEqual(legacyCredentialLeftovers(dir), [...files, join(dir, "code-agent", SESSION_STORE_DIR, "x.env")].sort());
});

test("rule 4: the session store is known by its layout, so a role named services is still reported", () => {
  const dir = join(scratch(), "credentials");
  const store = join(dir, SESSION_STORE_DIR);
  mkdirSync(join(store, "default"), { recursive: true });
  writeFileSync(join(store, "default", "session.json"), "{}");
  assert.deepEqual(legacyCredentialLeftovers(dir), [], "the CLI session file is not a leftover");
  // What a role called "services" left: <dir>/services.env and <dir>/services/<tool>.env.
  writeFileSync(join(dir, "services.env"), CANARY);
  writeFileSync(join(store, "tracker.env"), CANARY);
  // Anything else in the store's tree is not the session layout either.
  writeFileSync(join(store, "default", "other.env"), CANARY);
  // A file in the session's place whose name only ends like it is not the session file.
  writeFileSync(join(store, "default", "notsession.json"), CANARY);
  mkdirSync(join(store, "default", "session.json.d"));
  writeFileSync(join(store, "default", "session.json.d", "session.json"), CANARY);
  symlinkSync(join(dir, "services.env"), join(store, "linked"));
  // A symlink at the session file's place is not the CLI's regular file.
  mkdirSync(join(store, "other"));
  symlinkSync(join(dir, "services.env"), join(store, "other", "session.json"));
  // Only the top-level services/ is the store: the same layout under a role is a leftover.
  mkdirSync(join(dir, "code-agent", SESSION_STORE_DIR), { recursive: true });
  writeFileSync(join(dir, "code-agent", SESSION_STORE_DIR, "session.json"), CANARY);
  assert.deepEqual(legacyCredentialLeftovers(dir), [
    join(dir, "code-agent", SESSION_STORE_DIR, "session.json"),
    join(dir, "services.env"),
    join(store, "default", "notsession.json"),
    join(store, "default", "other.env"),
    join(store, "default", "session.json.d", "session.json"),
    join(store, "linked"),
    join(store, "other", "session.json"),
    join(store, "tracker.env"),
  ].sort());
});

test("rule 4: the lister's edges: absent, empty, not a directory, a symlink, an unlistable directory", () => {
  const root = scratch();
  assert.deepEqual(legacyCredentialLeftovers(join(root, "absent")), []);
  assert.deepEqual(legacyCredentialLeftovers(join(root, "absent", "deeper")), []);
  mkdirSync(join(root, "empty", "role"), { recursive: true });
  assert.deepEqual(legacyCredentialLeftovers(join(root, "empty")), [], "empty directories are not files");
  // A file where the directory was, and a path below a file.
  writeFileSync(join(root, "a-file"), CANARY);
  assert.deepEqual(legacyCredentialLeftovers(join(root, "a-file")), [join(root, "a-file")]);
  assert.deepEqual(legacyCredentialLeftovers(join(root, "a-file", "below")), []);
  // A symlink is reported and never followed: its target's files are not listed.
  const target = join(root, "elsewhere");
  mkdirSync(target);
  writeFileSync(join(target, "outside.env"), CANARY);
  const dir = join(root, "creds");
  mkdirSync(dir);
  symlinkSync(target, join(dir, "linked-role"));
  symlinkSync(join(root, "nowhere"), join(dir, "dangling.env"));
  assert.deepEqual(legacyCredentialLeftovers(dir), [join(dir, "dangling.env"), join(dir, "linked-role")]);
  symlinkSync(target, join(root, "dir-link"));
  assert.deepEqual(legacyCredentialLeftovers(join(root, "dir-link")), [join(root, "dir-link")]);
  // A directory that cannot be listed cannot be shown to be empty: it is reported itself.
  const closed = join(dir, "closed-role");
  mkdirSync(closed);
  writeFileSync(join(closed, "hidden.env"), CANARY);
  const fs = {
    lstat: (p) => lstatSync(p),
    readdir: (p) => { if (p === closed) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return readdirSync(p); },
  };
  assert.deepEqual(legacyCredentialLeftovers(dir, fs), [closed, join(dir, "dangling.env"), join(dir, "linked-role")]);
  // ...and one that cannot even be examined is reported too, unless it simply is not there.
  const blind = { lstat: (p) => { if (p === closed) throw Object.assign(new Error("EACCES"), { code: "EACCES" }); return lstatSync(p); }, readdir: (p) => readdirSync(p) };
  assert.deepEqual(legacyCredentialLeftovers(dir, blind), [closed, join(dir, "dangling.env"), join(dir, "linked-role")]);
});

test("rule 4: the lister opens no file: it is given no way to read one", () => {
  // The module imports only lstat and readdir, so a listing cannot contain a file's content.
  const src = read(join(ROOT, "src", "install", "legacy-credentials.js"));
  const imported = [...src.matchAll(/^import \{([^}]+)\} from "node:fs";$/gm)].flatMap((m) => m[1].split(",").map((s) => s.trim()));
  assert.deepEqual(imported.sort(), ["lstatSync", "readdirSync"]);
  assert.doesNotMatch(src, /readFile|openSync|createReadStream|unlink|rmSync|rename|writeFile|chmod/);
});

test("rule 4: the warning and the doctor advice name paths and what to do, and say nothing is read", () => {
  const w = leftoverWarning(["/c/a.env", "/c/a/b.env"]);
  assert.equal(w, "2 credential file(s) written by an earlier version are still on disk and are no longer read: /c/a.env, /c/a/b.env. " +
    "Revoke each token at its service, then delete the files; `vbcdx doctor` fails until they are gone.");
  assert.equal(LEFTOVER_ADVICE, "it is no longer read; revoke its token at the service, then delete it");
});

test("rule 4: doctor fails and lists each leftover; install agent warns with the same list; nothing is read, moved or deleted", () => {
  const home = scratch();
  mkdirSync(join(home, ".claude"));
  const dir = join(home, ".vbcdx", "credentials");
  const files = oldCredentialFiles(dir);
  mkdirSync(join(dir, "services", "default"), { recursive: true });
  writeFileSync(join(dir, "services", "default", "session.json"), JSON.stringify({ token: CANARY }));
  const before = snapshot([...files, dir, join(dir, "code-agent")]);

  // doctor: exit 5, one FAIL line per file, in both output forms.
  let r = vbcdx(home, ["doctor", "--harness=claude"]);
  assert.equal(r.status, EXIT.CONFLICT, r.stderr);
  assert.match(r.stdout, /^doctor for claude: problems found$/m);
  for (const f of files) {
    assert.ok(r.stdout.includes(`  FAIL leftover credential file ${f}: it is no longer read; revoke its token at the service, then delete it`), r.stdout);
  }
  assert.doesNotMatch(r.stdout, /session\.json/, "the CLI session store is not a leftover");
  assert.equal((r.stdout + r.stderr).includes(CANARY), false, "no file content is printed");
  r = vbcdx(home, ["doctor", "--harness=claude", "--json"]);
  assert.equal(r.status, EXIT.CONFLICT);
  const report = JSON.parse(r.stdout);
  assert.equal(report.ok, false);
  assert.deepEqual(report.leftovers, [...files].sort().map((path) => ({ path, detail: LEFTOVER_ADVICE })));
  assert.equal(r.stdout.includes(CANARY), false);

  // install agent: succeeds, and warns with the same paths.
  r = vbcdx(home, ["install", "agent", "code-agent", "--harness=claude", PACK_ARG]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^warning: 2 credential file\(s\) written by an earlier version are still on disk and are no longer read: /m);
  for (const f of files) assert.ok(r.stderr.includes(f), `the warning names ${f}`);
  assert.match(r.stderr, /`vbcdx doctor` fails until they are gone/);
  assert.equal((r.stdout + r.stderr).includes(CANARY), false);
  const definition = read(join(home, ".claude", "agents", "code-agent.md"));
  assert.equal(definition.includes(CANARY), false);
  assert.doesNotMatch(definition, /credential/);
  // ...also on a dry run and through the deprecated init.
  r = vbcdx(home, ["install", "agent", "code-agent", "--harness=claude", PACK_ARG, "--dry-run"]);
  assert.match(r.stderr, /credential file\(s\) written by an earlier version/);

  assert.deepEqual(snapshot([...files, dir, join(dir, "code-agent")]), before, "every file and directory is exactly as it was");

  // Once the operator has deleted the files, doctor passes; the session store is still there.
  for (const f of files) rmSync(f);
  r = vbcdx(home, ["doctor", "--harness=claude"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /leftover/);
  assert.deepEqual(JSON.parse(vbcdx(home, ["doctor", "--harness=claude", "--json"]).stdout).leftovers, []);
  assert.equal(existsSync(join(dir, "services", "default", "session.json")), true);
  r = vbcdx(home, ["install", "agent", "code-agent", "--harness=claude", PACK_ARG]);
  assert.equal(r.stderr, "");
});

test("rule 4: files an earlier version would have refused as unsafe or invalid are reported the same way, and left alone", () => {
  // A symlinked credential file, a world-readable one, one for another role, an empty one, and a
  // credentials directory that is not private: the old writer refused each (exit 3 or 4) even
  // with --force. Nothing is written there now, so the run goes on, and doctor names them all.
  const home = scratch();
  mkdirSync(join(home, ".claude"));
  const dir = join(home, ".vbcdx", "credentials");
  mkdirSync(join(dir, "pm-agent"), { recursive: true });
  chmodSync(dir, 0o755);
  const outside = join(home, "outside.env");
  writeFileSync(outside, `VBCDX_AGENTS_TOKEN="${CANARY}"\n`);
  symlinkSync(outside, join(dir, "code-agent.env"));
  writeFileSync(join(dir, "qa-agent.env"), `VBCDX_AGENTS_ROLE="qa-agent"\nVBCDX_AGENTS_TOKEN="${CANARY}"\n`);
  chmodSync(join(dir, "qa-agent.env"), 0o644);
  writeFileSync(join(dir, "pm-agent", "forgejo.env"), `VBCDX_AGENTS_ROLE="someone-else"\nVBCDX_AGENTS_TOKEN="${CANARY}"\n`);
  writeFileSync(join(dir, "pm-agent", "empty.env"), "");
  const all = [join(dir, "code-agent.env"), join(dir, "pm-agent", "empty.env"), join(dir, "pm-agent", "forgejo.env"), join(dir, "qa-agent.env")];
  const before = snapshot([...all, dir, outside]);

  for (const extra of [[], ["--force"]]) {
    const r = vbcdx(home, ["install", "agent", "code-agent", "--harness=claude", PACK_ARG, ...extra]);
    assert.equal(r.status, 0, r.stderr);
    for (const f of all) assert.ok(r.stderr.includes(f));
    assert.equal((r.stdout + r.stderr).includes(CANARY), false);
  }
  const report = JSON.parse(vbcdx(home, ["doctor", "--harness=claude", "--json"]).stdout);
  assert.deepEqual(report.leftovers.map((l) => l.path), all);
  assert.deepEqual(snapshot([...all, dir, outside]), before, "nothing was repaired, chmodded, followed or removed");
  assert.equal(lstatSync(dir).mode & 0o777, 0o755, "the directory's mode is not changed");
});

test("rule 4: with --env, the old directory is the one the config names, else <BASE_DIR>/credentials", () => {
  // Named: an existing config file that still carries the key points doctor at the old files.
  const named = homeWithConfig();
  const elsewhere = join(named.home, "elsewhere", "creds");
  const files = oldCredentialFiles(elsewhere);
  writeFileSync(named.cfg, read(named.cfg) + `VBCDX_AGENTS_CREDENTIALS_DIR=${elsewhere}\n`);
  let r = vbcdx(named.home, ["doctor", "--harness=claude", `--env=${named.cfg}`, "--json"]);
  assert.equal(r.status, EXIT.CONFLICT, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).leftovers.map((l) => l.path), [...files].sort());
  // ...and it is still validated as a path, never created.
  writeFileSync(named.cfg, read(named.cfg).replace(elsewhere, "relative/creds"));
  r = vbcdx(named.home, ["doctor", "--harness=claude", `--env=${named.cfg}`]);
  assert.equal(r.status, EXIT.CONFIG);
  assert.match(r.stderr, /VBCDX_AGENTS_CREDENTIALS_DIR must be an absolute path/);

  // Not named: the default under the base directory.
  const plain = homeWithConfig();
  const under = oldCredentialFiles(join(plain.home, "state", "credentials"));
  r = vbcdx(plain.home, ["doctor", "--harness=claude", `--env=${plain.cfg}`, "--json"]);
  assert.deepEqual(JSON.parse(r.stdout).leftovers.map((l) => l.path), [...under].sort());
  assert.equal(loadConfig(cfgMap({}), { harness: "claude", scope: "project" }).legacyCredentialsDir, "/b/credentials");
  assert.equal(loadConfig(cfgMap({ VBCDX_AGENTS_CREDENTIALS_DIR: "/c" }), { harness: "claude", scope: "project" }).legacyCredentialsDir, "/c");
});

test("rule 4: the plan carries the leftover warning for every harness, and a clean host gets none", () => {
  for (const harness of HARNESSES) {
    const home = scratch();
    const entries = new Map([["VBCDX_AGENTS_BASE_DIR", join(home, "state")], [{ claude: "VBCDX_AGENTS_CLAUDE_CONFIG_DIR", codex: "VBCDX_AGENTS_CODEX_HOME", opencode: "VBCDX_AGENTS_OPENCODE_CONFIG_DIR", hermes: "VBCDX_AGENTS_HERMES_HOME" }[harness], join(home, "h")]]);
    const args = { harness, scope: "user", force: false, dryRun: true, agents: ["code-agent"], agentsExplicit: true };
    const noHermesNotes = (ws) => ws.filter((w) => !/^No Hermes /.test(w));
    assert.deepEqual(noHermesNotes(buildPlan(args, entries, { cwd: home }).warnings), []);
    const files = oldCredentialFiles(join(home, "state", "credentials"));
    const plan = buildPlan(args, entries, { cwd: home });
    assert.deepEqual(noHermesNotes(plan.warnings), [leftoverWarning([...files].sort())]);
    // The plan and the report have no credential section at all.
    assert.equal("credentialOps" in plan, false);
    assert.equal("credentialsDir" in plan, false);
    const report = executePlan(plan);
    assert.equal("credentials" in report, false);
    assert.equal("credential_errors" in report, false);
    assert.equal(plan.generated.some((g) => "credentials" in g), false);
  }
});

test("a catalogue set by a caller, whose roles carry no overlays list, plans like any other", () => {
  // setActiveCatalog is public API: a role built by hand has only what a renderer reads.
  const base = getRole("code-agent");
  const { overlays: _none, renamedFrom: _no, ...bare } = base;
  const previous = activeCatalog();
  setActiveCatalog({ ...previous, roles: new Map([["code-agent", bare]]), ids: ["code-agent"] });
  try {
    for (const harness of ["claude", "hermes"]) {
      const home = scratch();
      const entries = new Map([["VBCDX_AGENTS_BASE_DIR", join(home, "state")], [harness === "claude" ? "VBCDX_AGENTS_CLAUDE_CONFIG_DIR" : "VBCDX_AGENTS_HERMES_HOME", join(home, "h")]]);
      const plan = buildPlan({ harness, scope: "user", force: false, dryRun: true, agentsExplicit: false }, entries, { cwd: home });
      assert.deepEqual(plan.roles, ["code-agent"]);
      assert.ok(plan.generated.length >= 1);
      for (const g of plan.generated) assert.deepEqual([g.role, g.overlays, g.renamedFrom], ["code-agent", [], null]);
    }
  } finally {
    setActiveCatalog(previous);
  }
  assert.equal(getRole("pm-agent").id, "pm-agent", "the fixture catalogue is back");
});

// ── A tool an earlier version installed that takes a credential ──────────────

test("a keyed tool record is recognised by either mark, and nothing else is", () => {
  assert.equal(isKeyedToolRecord({ credential_file: "credential_file", env: [] }), true);
  assert.equal(isKeyedToolRecord({ credential_file: null, env: [{ name: "X_TOKEN", kind: "credential" }] }), true);
  assert.equal(isKeyedToolRecord({ env: [{ name: "X_URL", kind: "config" }, { name: "X_TOKEN", kind: "credential" }] }), true);
  assert.equal(isKeyedToolRecord({ credential_file: null, env: [{ name: "X_URL", kind: "config" }] }), false);
  assert.equal(isKeyedToolRecord({ env: [] }), false);
  assert.equal(isKeyedToolRecord({}), false);
  assert.equal(isKeyedToolRecord({ env: [null, "x"] }), false);
});

// A keyless tool package under the server name the fixture pack's review-agent is granted
// tools of (get_issue and whoami): the fixture roles key their allowlists by that name.
const GRANTED_CONTRACT = "vbcdx.forgejo/1";
function grantedPackage(dir) {
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@example/forge-tools", version: "0.0.1", bin: { "forge-tool": "bin/forge-tool.js" } }));
  writeFileSync(join(dir, "vbcdx.json"), JSON.stringify({
    schema_version: 1, server_name: "forgejo", stdio: { bin: "forge-tool", args: ["mcp"] },
    env: [{ name: "FORGE_URL", description: "Forge origin.", kind: "config", required: true }],
    manifest: { args: ["manifest"] },
  }));
  const manifest = { schema_version: 1, service: "forgejo", contract: GRANTED_CONTRACT, package_version: "0.0.1", tools: [tool("get_issue"), tool("whoami")] };
  writeFileSync(join(dir, "bin", "forge-tool.js"), `if (process.argv[2] === "manifest") console.log(${JSON.stringify(JSON.stringify(manifest))});\n`);
  return dir;
}
const manifestOf = (home) => join(home, ".vbcdx", "manifests", "installation.json");
/** Rewrite every tool record the way an earlier version recorded a keyed tool. */
function markKeyed(home, mark) {
  const m = JSON.parse(read(manifestOf(home)));
  for (const t of Object.values(m.tools)) mark(t);
  writeFileSync(manifestOf(home), JSON.stringify(m));
}
const tokenEnv = { name: "FORGE_TOKEN", description: "API token for the forge.", kind: "credential", required: false };

for (const [label, mark] of [
  ["a credential_file argument", (t) => { t.credential_file = "credential_file"; }],
  ["a credential-kind variable", (t) => { t.env = [...t.env, tokenEnv]; }],
]) {
  for (const harness of HARNESSES) {
    test(`a tool recorded with ${label} (${harness}): bound to no role, install agent warns, doctor fails and says how to clear it`, () => {
      const home = scratch();
      const rel = { claude: ".claude", codex: ".codex", opencode: ".config/opencode", hermes: ".hermes" }[harness];
      mkdirSync(join(home, rel), { recursive: true });
      const definition = () => (harness === "hermes"
        ? read(join(home, rel, "profiles", "review-agent", "config.yaml")) + read(join(home, rel, "profiles", "review-agent", "SOUL.md"))
        : read(join(home, rel, "agents", `review-agent.${harness === "codex" ? "toml" : "md"}`)));
      installTool(ctxFor(harness, home), grantedPackage(join(home, "pkg")));

      // Control: as installed, the tool is bound to the role and its tools are in the definition.
      let r = installAgent(ctxFor(harness, home), ["review-agent"]);
      assert.deepEqual(r.integrations, ["forgejo"]);
      assert.deepEqual(r.warnings.filter((w) => /per-role credential/.test(w)), []);
      assert.match(definition(), /whoami/);
      assert.equal(doctor(ctxFor(harness, home), { env: { ...process.env, FORGE_URL: "x" } }).ok, true);

      // The same record, marked the way an earlier version recorded a tool that takes a key.
      markKeyed(home, mark);
      assert.equal(installedToolBindings(ctxFor(harness, home), JSON.parse(read(manifestOf(home))), ["review-agent"]), null);
      r = installAgent(ctxFor(harness, home), ["review-agent"]);
      assert.deepEqual(r.integrations, []);
      const advice = "forgejo was installed by an earlier version as a tool that takes a per-role credential; it is bound to no role. " +
        `Remove it (\`vbcdx remove tool forgejo --harness=${harness}\`) and register it as a Keyhole tool`;
      assert.deepEqual(r.warnings.filter((w) => /per-role credential/.test(w)), [`${advice}.`]);
      assert.doesNotMatch(definition(), /whoami|forgejo|FORGE_TOKEN|credential/, "the role's definition no longer names the tool");
      if (harness === "hermes") assert.equal(parsePy(read(join(home, rel, "profiles", "review-agent", "config.yaml"))).mcp_servers, undefined);

      const rep = doctor(ctxFor(harness, home), { env: { ...process.env, FORGE_URL: "x" } });
      assert.equal(rep.ok, false);
      const t = rep.tools.find((x) => x.server === "forgejo");
      assert.equal(t.ok, false);
      assert.deepEqual(t.checks.find((c) => c.check === "key"), { check: "key", ok: false, detail: advice });
      assert.deepEqual(t.checks.filter((c) => !c.ok).map((c) => c.check), ["key"], "the only failed check");
      // The advice works: removing the tool clears doctor.
      const out = vbcdx(home, ["remove", "tool", "forgejo", `--harness=${harness}`]);
      assert.equal(out.status, 0, out.stderr);
      assert.equal(doctor(ctxFor(harness, home), { env: { FORGE_URL: "x" } }).ok, true);
    });
  }
}

test("a keyed record next to a keyless one: only the keyless tool is bound", () => {
  const home = scratch();
  mkdirSync(join(home, ".claude"));
  installTool(ctxFor("claude", home), grantedPackage(join(home, "pkg")));
  installTool(ctxFor("claude", home), TOOL_FIXTURE);
  const m = JSON.parse(read(manifestOf(home)));
  for (const t of Object.values(m.tools)) if (t.server_name === "forgejo") t.credential_file = "credential_file";
  const bound = installedToolBindings(ctxFor("claude", home), m, ["review-agent", "code-agent"]);
  assert.deepEqual(Object.keys(bound.services), ["example-tracker"]);
  assert.deepEqual(bound.services["example-tracker"].roles, ["review-agent", "code-agent"]);
  assert.deepEqual(Object.keys(bound.services["example-tracker"]).sort(), ["contract", "roles", "serverName", "stdio", "tools"]);
});

test("doctor is not ok when only a leftover is wrong, and prints no tool as failed for it", () => {
  const home = scratch();
  mkdirSync(join(home, ".claude"));
  installTool(ctxFor("claude", home), TOOL_FIXTURE);
  const files = oldCredentialFiles(join(home, ".vbcdx", "credentials"));
  const rep = doctor(ctxFor("claude", home), { env: { ...process.env, EXAMPLE_TRACKER_URL: "x" } });
  assert.equal(rep.tools.every((t) => t.ok), true);
  assert.equal(rep.ok, false);
  assert.equal(rep.leftovers.length, files.length);
});

// ── Packs that still carry credential_suffix ─────────────────────────────────

test("a role.json loads with credential_suffix, without it, and with any value in it", () => {
  const base = JSON.parse(read(join(FIXTURE_PACK_DIR, "assets", "roles", "code-agent", "role.json")));
  assert.equal(base.credential_suffix, "CODE_AGENT", "the fixture pack still carries the field");
  assert.equal(readPack(FIXTURE_PACK_DIR).roles.length > 0, true);
  const { credential_suffix: _dropped, ...without } = base;
  for (const d of [base, without, { ...base, credential_suffix: "WRONG" }, { ...base, credential_suffix: "not-a-suffix" }, { ...base, credential_suffix: 7 }, { ...base, credential_suffix: null }]) {
    assert.deepEqual(validateRoleDescriptor(d, "code-agent"), { ok: true, errors: [] }, JSON.stringify(d.credential_suffix));
  }
  const schema = JSON.parse(read(join(ROOT, "schema", "vbcdx-role.schema.json")));
  assert.equal(schema.required.includes("credential_suffix"), false);
  assert.deepEqual(Object.keys(schema.properties.credential_suffix), ["description"], "accepted with any value");
});

// ── What is gone from the product ────────────────────────────────────────────

function srcFiles(dir = join(ROOT, "src")) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? srcFiles(join(dir, e.name)) : e.name.endsWith(".js") ? [join(dir, e.name)] : []));
}

test("the credential writer, its helpers and the credential exit path are gone", () => {
  assert.equal(existsSync(join(ROOT, "src", "credentials")), false);
  for (const name of ["ensurePrivateCredentialDir", "assertPrivateCredentialDir"]) assert.equal(name in safeWriter, false, name);
  assert.equal("credentialError" in errors, false);
  assert.equal("idToSuffix" in registry, false);
  // Nothing raises exit 3 any more; the number stays reserved.
  assert.equal(EXIT.CREDENTIAL, 3);
  const gone = /writeCredentialFile|serializeCredentialFile|collectCredentialTriples|evaluateExisting|credentialPath|credentialConfigKey|missingCredentialFields|classifyTriple|externalCredentialOk|credentialBindingNote|credentialOps|classifyCredentials|credentialFree|credentialFile\b|EXIT\.CREDENTIAL|VBCDX_AGENTS_ROLE\b|secret: true/;
  for (const f of [...srcFiles(), join(ROOT, "bin", "vbcdx.js"), join(ROOT, "bin", "vbcdx-dev-agents.js")]) {
    assert.doesNotMatch(read(f), gone, relative(ROOT, f));
  }
  // atomicWrite has no "secret" mode left to misuse: an unknown option changes nothing.
  const dir = scratch();
  chmodSync(dir, 0o755);
  safeWriter.atomicWrite(join(dir, "f"), "x", { mode: 0o600, secret: true });
  assert.equal(lstatSync(join(dir, "f")).mode & 0o777, 0o600);
  assert.equal(safeWriter.validateExistingFile(join(dir, "f"), { secret: true }).isFile(), true);
});

test("the Forgejo contract appears in no rule at all: only as an example of a contract name in an error message", () => {
  const NAME = /vbcdx\.forgejo\/1|FORGEJO_CONTRACT/;
  const hits = {};
  for (const f of srcFiles()) {
    const lines = read(f).split("\n").filter((l) => NAME.test(l));
    if (lines.length) hits[relative(ROOT, f)] = lines.map((l) => l.trim());
  }
  // Exactly this line, the text of an error message: nothing in src/ compares a contract with
  // it, keys a rule on it or derives a name from it.
  assert.deepEqual(hits, {
    "src/config/integrations.js": [
      "throw conflictError(`Manifest ${source} declares contract ${JSON.stringify(obj.contract)}; a contract looks like <name>/<major>, e.g. vbcdx.forgejo/1.`);",
    ],
  });
  // tool-declaration.js gives an example that isn't a first-party name.
  assert.match(read(join(ROOT, "src", "install", "tool-declaration.js")), /contract must look like <name>\/<major>, for example acme\.tracker\/1\./);
  // No constant for it, and no code that compares a contract with a contract literal.
  for (const f of srcFiles()) {
    assert.doesNotMatch(read(f), /FORGEJO_CONTRACT|contract\s*[!=]==?\s*["'`][a-z0-9.-]+\/\d/, relative(ROOT, f));
  }
});

test("what npm packs holds no credential writer and no doc that tells anyone to create a credential file", () => {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const files = JSON.parse(r.stdout)[0].files.map((f) => f.path);
  for (const expected of ["src/install/legacy-credentials.js", "src/fs/safe-writer.js", "README.md", ".env.example", "schema/vbcdx-tool.schema.json"]) {
    assert.ok(files.includes(expected), `${expected} is packed`);
  }
  assert.deepEqual(files.filter((f) => /credentials?\//.test(f) || /writer/.test(f.replace("safe-writer", ""))), []);
  const writer = /writeCredentialFile|serializeCredentialFile|collectCredentialTriples|ensurePrivateCredentialDir|credential_file=|VBCDX_AGENTS_ROLE\b/;
  // What an operator would copy to make one: the old key names as assignments, or the old file layout.
  const howTo = /^\s*#?\s*VBCDX_AGENTS_(USER|TOKEN|PASSWORD)_[A-Z0-9_]+=|credentials\/<role>\/<tool>\.env|<CREDENTIALS_DIR>\/<role>/m;
  for (const f of files) {
    const text = read(join(ROOT, f));
    assert.doesNotMatch(text, writer, f);
    assert.doesNotMatch(text, howTo, f);
  }
  const example = read(join(ROOT, ".env.example"));
  assert.doesNotMatch(example, /VBCDX_AGENTS_CREDENTIALS_DIR|VBCDX_AGENTS_(USER|TOKEN|PASSWORD)_/);
  const readme = read(join(ROOT, "README.md"));
  assert.match(readme, /^## How a tool gets its key$/m);
  assert.doesNotMatch(readme, /^## Credentials$/m);
  assert.doesNotMatch(readme, /call the\s+service directly with its own token/);
  assert.doesNotMatch(readme, /"credential_file"|allow_cleartext": true/);
});
