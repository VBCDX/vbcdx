// One credential file per role and service. A role bound to two
// tools holds two tokens, in <credentials dir>/<role>/<service>.env, each file
// checked against its service's contract; a legacy <role>.env is never read for a
// tool, and nothing moves or rewrites one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  collectCredentialTriples, classifyTriple, credentialPath, credentialConfigKey, missingCredentialFields,
  describeFields, evaluateExisting, writeCredentialFile, requiredFieldsText,
} from "../src/credentials/writer.js";
import { FORGEJO_CONTRACT, COOLIFY_CONTRACT } from "../src/config/integrations.js";
import { parseEnvText } from "../src/config/env-parser.js";
import { resolveContext } from "../src/install/context.js";
import { installTool, installAgent, doctor } from "../src/install/commands.js";
import { init } from "../src/index.js";
import { EXIT } from "../src/errors.js";
import { PACK_ARG } from "./helpers/fixture-pack.js";

const read = (p) => readFileSync(p, "utf8");
const modeOf = (p) => statSync(p).mode & 0o777;

function withDir(fn) {
  const d = mkdtempSync(join(tmpdir(), "vbcdx-2b-"));
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

// ── parsing ──────────────────────────────────────────────────────────────────

test("a <ROLE>__<SERVICE> suffix files a triple of its own; the role-wide triple stays separate", () => {
  const m = collectCredentialTriples(new Map([
    ["VBCDX_AGENTS_USER_DEVOPS_AGENT", "role-wide"],
    ["VBCDX_AGENTS_TOKEN_DEVOPS_AGENT", "t0"],
    ["VBCDX_AGENTS_USER_DEVOPS_AGENT__FORGEJO", "fj"],
    ["VBCDX_AGENTS_TOKEN_DEVOPS_AGENT__FORGEJO", "t1"],
    ["VBCDX_AGENTS_TOKEN_DEVOPS_AGENT__COOLIFY", "t2"],
    ["VBCDX_AGENTS_TOKEN_DEVOPS_AGENT__MY_TOOL", "t3"],
  ]));
  assert.deepEqual([...m.keys()].sort(), ["devops-agent", "devops-agent/coolify", "devops-agent/forgejo", "devops-agent/my-tool"]);
  assert.deepEqual(m.get("devops-agent"), { role: "devops-agent", service: null, known: true, user: "role-wide", token: "t0", password: "" });
  assert.deepEqual(m.get("devops-agent/forgejo"), { role: "devops-agent", service: "forgejo", known: true, user: "fj", token: "t1", password: "" });
  assert.equal(m.get("devops-agent/coolify").token, "t2");
  assert.equal(m.get("devops-agent/coolify").user, "", "one service's fields never fill another's");
  assert.equal(m.get("devops-agent/my-tool").service, "my-tool");
});

test("the first __ splits role from service: a role id never holds two hyphens in a row", () => {
  const m = collectCredentialTriples(new Map([["VBCDX_AGENTS_TOKEN_CODE_AGENT__A__B", "t"]]));
  assert.deepEqual([...m.keys()], ["code-agent/a--b"]);
});

test("an empty or malformed service suffix is a config error that names the key, never its value", () => {
  for (const key of ["VBCDX_AGENTS_TOKEN_CODE_AGENT__", "VBCDX_AGENTS_TOKEN_CODE_AGENT__9X", "VBCDX_AGENTS_TOKEN_CODE_AGENT__X", "VBCDX_AGENTS_TOKEN_CODE_AGENT__X_"]) {
    const r = codeOf(() => collectCredentialTriples(new Map([[key, "SECRET-VALUE"]])));
    assert.equal(r.code, EXIT.CONFIG, key);
    assert.match(r.message, /invalid service suffix/, key);
    assert.ok(r.message.includes(key), key);
    assert.equal(r.message.includes("SECRET-VALUE"), false);
  }
  // An empty role before the separator is still an invalid role.
  assert.match(codeOf(() => collectCredentialTriples(new Map([["VBCDX_AGENTS_TOKEN___FORGEJO", "x"]]))).message, /invalid role suffix/);
});

test("two spellings of one role and service are ambiguous", () => {
  const r = codeOf(() => collectCredentialTriples(new Map([
    ["VBCDX_AGENTS_TOKEN_CODE_AGENT__FORGEJO", "a"],
    ["VBCDX_AGENTS_TOKEN_code_agent__forgejo", "b"],
  ])));
  assert.equal(r.code, EXIT.CONFIG);
  assert.match(r.message, /Ambiguous credential keys for role code-agent on forgejo/);
});

test("paths and config keys", () => {
  assert.equal(credentialPath("/c", "code-agent"), "/c/code-agent.env");
  assert.equal(credentialPath("/c", "code-agent", "forgejo"), "/c/code-agent/forgejo.env");
  assert.equal(credentialConfigKey("TOKEN", "code-agent"), "VBCDX_AGENTS_TOKEN_CODE_AGENT");
  assert.equal(credentialConfigKey("USER", "code-agent", "my-tool"), "VBCDX_AGENTS_USER_CODE_AGENT__MY_TOOL");
});

// ── what each file must hold ─────────────────────────────────────────────────

test("required fields: role-wide and Forgejo need USER and TOKEN or PASSWORD; another contract needs TOKEN", () => {
  const forgejo = { service: "forgejo", contract: FORGEJO_CONTRACT };
  const coolify = { service: "coolify", contract: COOLIFY_CONTRACT };
  const unbound = { service: "later", contract: null };
  for (const target of [{}, forgejo]) {
    assert.deepEqual(missingCredentialFields({}, target), [["USER"], ["TOKEN", "PASSWORD"]]);
    assert.deepEqual(missingCredentialFields({ token: "t" }, target), [["USER"]]);
    assert.deepEqual(missingCredentialFields({ user: "u" }, target), [["TOKEN", "PASSWORD"]]);
    assert.deepEqual(missingCredentialFields({ user: "u", password: "p" }, target), []);
    assert.deepEqual(missingCredentialFields({ user: " ", token: "t" }, target), [["USER"]], "blank is unset");
  }
  assert.deepEqual(missingCredentialFields({}, coolify), [["TOKEN"]]);
  assert.deepEqual(missingCredentialFields({ token: "t" }, coolify), []);
  assert.deepEqual(missingCredentialFields({ user: "u", password: "p" }, coolify), [["TOKEN"]]);
  // A service no binding names yet: TOKEN, or USER and PASSWORD.
  assert.deepEqual(missingCredentialFields({ token: "t" }, unbound), []);
  assert.deepEqual(missingCredentialFields({ user: "u", password: "p" }, unbound), []);
  assert.deepEqual(missingCredentialFields({}, unbound), [["TOKEN"]]);
  assert.deepEqual(missingCredentialFields({ user: "u" }, unbound), [["TOKEN", "PASSWORD"]]);
  assert.deepEqual(missingCredentialFields({ password: "p" }, unbound), [["TOKEN", "USER"]]);
  assert.equal(requiredFieldsText(coolify), "VBCDX_AGENTS_TOKEN");
  assert.equal(requiredFieldsText(forgejo), "VBCDX_AGENTS_USER and VBCDX_AGENTS_TOKEN or VBCDX_AGENTS_PASSWORD");
  assert.equal(describeFields([["USER"]], (f) => credentialConfigKey(f, "qa-agent", "forgejo")), "VBCDX_AGENTS_USER_QA_AGENT__FORGEJO");
  assert.equal(classifyTriple({ user: "", token: "t", password: "" }, coolify), "complete");
  assert.equal(classifyTriple({ user: "", token: "t", password: "" }, forgejo), "incomplete");
  assert.equal(classifyTriple({ user: "", token: "", password: "" }, coolify), "disabled");
  assert.equal(classifyTriple({ user: "", token: "t", password: "" }), "incomplete", "no target keeps the role-wide rule");
});

test("an existing service file is judged by its contract, and its reason names the missing key", () => withDir((d) => {
  const c = join(d, "creds");
  mkdirSync(join(c, "devops-agent"), { recursive: true, mode: 0o700 });
  chmodSync(c, 0o700);
  chmodSync(join(c, "devops-agent"), 0o700);
  const p = join(c, "devops-agent", "coolify.env");
  writeFileSync(p, 'VBCDX_AGENTS_ROLE="devops-agent"\nVBCDX_AGENTS_TOKEN="t"\n', { mode: 0o600 });
  assert.deepEqual(evaluateExisting(p, "devops-agent", { service: "coolify", contract: COOLIFY_CONTRACT }), { state: "valid" });
  assert.deepEqual(evaluateExisting(p, "devops-agent", { service: "forgejo", contract: FORGEJO_CONTRACT }), { state: "invalid", reason: "missing VBCDX_AGENTS_USER" });
  assert.deepEqual(evaluateExisting(p, "devops-agent"), { state: "invalid", reason: "missing VBCDX_AGENTS_USER" }, "role-wide rule");
  // The writer keeps such a file without --force, and refuses it under the wrong contract.
  const triple = { role: "devops-agent", service: "coolify", user: "", token: "new", password: "" };
  assert.equal(writeCredentialFile({ credentialsDir: c, triple, contract: COOLIFY_CONTRACT }).action, "retained");
  assert.match(codeOf(() => writeCredentialFile({ credentialsDir: c, triple, contract: FORGEJO_CONTRACT, force: true })).message,
    /devops-agent\/coolify\.env is invalid \(missing VBCDX_AGENTS_USER\)/);
  const res = writeCredentialFile({ credentialsDir: c, triple, contract: COOLIFY_CONTRACT, force: true });
  assert.equal(res.action, "replaced");
  assert.equal(res.path, p);
  assert.equal(parseEnvText(read(p), p).get("VBCDX_AGENTS_TOKEN"), "new");
  assert.equal(modeOf(p), 0o600);
}));

test("the writer refuses an unsafe service identifier", () => withDir((d) => {
  assert.match(codeOf(() => writeCredentialFile({ credentialsDir: d, triple: { role: "code-agent", service: "../x", user: "u", token: "t", password: "" } })).message,
    /Unsafe credential service identifier/);
}));

// ── end to end: one role, two tools, two files ───────────────────────────────

const tools = (names) => [...names].sort().map((n) => ({ name: n, description: "d", inputSchema: {}, outputSchema: {}, effect: "read", required_permissions: [] }));

function toolPackage(dir, { server, contract, envName, toolNames, credentialFile = true }) {
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@example/${server}-like`, version: "0.0.1", bin: { [`${server}-tool`]: "bin/tool.js" } }));
  writeFileSync(join(dir, "vbcdx.json"), JSON.stringify({
    schema_version: 1, server_name: server, stdio: { bin: `${server}-tool`, args: ["mcp"] },
    env: [{ name: envName, description: "Origin.", kind: "config", required: true }],
    manifest: { args: ["manifest"] },
    ...(credentialFile ? { credential_file: { argument: "credential_file" } } : {}),
  }));
  const manifest = { schema_version: 1, service: server, contract, package_version: "0.0.1", tools: tools(toolNames) };
  writeFileSync(join(dir, "bin", "tool.js"), `if (process.argv[2] === "manifest") console.log(${JSON.stringify(JSON.stringify(manifest))});\n`);
  return dir;
}

/** A home with a forgejo-like and a coolify-like tool installed for claude, and a config file. */
function twoTools(home, lines) {
  const cfg = join(home, "config.env");
  writeFileSync(cfg, [
    `VBCDX_AGENTS_BASE_DIR=${home}/state`,
    `VBCDX_AGENTS_CREDENTIALS_DIR=${home}/creds`,
    `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${home}/claude`,
    ...lines,
  ].join("\n") + "\n");
  const ctx = () => resolveContext({ harness: "claude", scope: "user", envPath: cfg, home, cwd: home, env: {} });
  installTool(ctx(), toolPackage(join(home, "fj"), { server: "forgejo", contract: FORGEJO_CONTRACT, envName: "FJ_URL", toolNames: ["whoami", "get_issue"] }));
  installTool(ctx(), toolPackage(join(home, "cf"), { server: "coolify", contract: COOLIFY_CONTRACT, envName: "CF_URL", toolNames: ["health", "deploy"] }));
  return { ctx, creds: join(home, "creds"), def: join(home, "claude", "agents", "devops-agent.md") };
}

test("a role bound to two tools gets two private files, two tokens, and a definition naming each", () => withDir((home) => {
  const { ctx, creds, def } = twoTools(home, [
    "VBCDX_AGENTS_USER_DEVOPS_AGENT__FORGEJO=fj-user",
    "VBCDX_AGENTS_TOKEN_DEVOPS_AGENT__FORGEJO=fj-token",
    "VBCDX_AGENTS_TOKEN_DEVOPS_AGENT__COOLIFY=cf-token",
  ]);
  const fj = join(creds, "devops-agent", "forgejo.env");
  const cf = join(creds, "devops-agent", "coolify.env");
  const dry = installAgent(ctx(), ["devops-agent"], { dryRun: true });
  assert.deepEqual(dry.credentials.map((c) => [c.service, c.path, c.action]).sort(), [["coolify", cf, "written"], ["forgejo", fj, "written"]]);
  assert.equal(existsSync(creds), false, "a dry run creates nothing");
  const r = installAgent(ctx(), ["devops-agent"]);
  assert.deepEqual(r.integrations.sort(), ["coolify", "forgejo"]);
  assert.deepEqual(r.credentials.map((c) => [c.service, c.path, c.action]).sort(), [["coolify", cf, "written"], ["forgejo", fj, "written"]]);
  assert.equal(modeOf(creds), 0o700);
  assert.equal(modeOf(join(creds, "devops-agent")), 0o700);
  assert.equal(modeOf(fj), 0o600);
  assert.equal(modeOf(cf), 0o600);
  assert.equal(read(fj), 'VBCDX_AGENTS_ROLE="devops-agent"\nVBCDX_AGENTS_USER="fj-user"\nVBCDX_AGENTS_TOKEN="fj-token"\n');
  assert.equal(read(cf), 'VBCDX_AGENTS_ROLE="devops-agent"\nVBCDX_AGENTS_TOKEN="cf-token"\n');
  assert.equal(existsSync(join(creds, "devops-agent.env")), false, "no role-wide file is invented");
  assert.deepEqual(readdirSync(join(creds, "devops-agent")).sort(), ["coolify.env", "forgejo.env"], "no lock or temp file is left behind");
  const text = read(def);
  assert.ok(text.includes(`credential_file="${fj}"`));
  assert.ok(text.includes(`credential_file="${cf}"`));
  assert.equal(r.warnings.some((w) => /credential file/.test(w)), false, r.warnings.join("\n"));
  const report = JSON.stringify(r);
  for (const secret of ["fj-token", "cf-token"]) assert.equal(report.includes(secret), false);
  const rep = doctor(ctx(), { env: { FJ_URL: "x", CF_URL: "y" } });
  assert.equal(rep.ok, true, JSON.stringify(rep.tools.map((t) => t.checks.filter((c) => !c.ok))));
  // A rerun keeps both files as they are.
  const again = installAgent(ctx(), ["devops-agent"]);
  assert.deepEqual(again.credentials.map((c) => c.action), ["retained", "retained"]);
}));

test("an incomplete service triple names the config key and the file, writes nothing, and leaks nothing", () => withDir((home) => {
  const { ctx, creds, def } = twoTools(home, [
    "VBCDX_AGENTS_TOKEN_DEVOPS_AGENT__FORGEJO=SECRET-A",
    "VBCDX_AGENTS_USER_DEVOPS_AGENT__COOLIFY=SECRET-B",
  ]);
  const r = codeOf(() => installAgent(ctx(), ["devops-agent"]));
  assert.equal(r.code, EXIT.CREDENTIAL);
  assert.match(r.message, /^Credential triple for devops-agent on (forgejo|coolify) is incomplete: set VBCDX_AGENTS_/);
  const fjMsg = `set VBCDX_AGENTS_USER_DEVOPS_AGENT__FORGEJO for ${join(creds, "devops-agent", "forgejo.env")}`;
  const cfMsg = `set VBCDX_AGENTS_TOKEN_DEVOPS_AGENT__COOLIFY for ${join(creds, "devops-agent", "coolify.env")}`;
  assert.ok(r.message.includes(fjMsg) || r.message.includes(cfMsg), r.message);
  assert.equal(/SECRET-/.test(r.message), false);
  assert.equal(existsSync(creds), false);
  assert.equal(existsSync(def), false);
}));

test("an existing role directory that is not private refuses the run before anything is written", () => withDir((home) => {
  const { ctx, creds, def } = twoTools(home, ["VBCDX_AGENTS_TOKEN_DEVOPS_AGENT__COOLIFY=cf-token"]);
  mkdirSync(join(creds, "devops-agent"), { recursive: true });
  chmodSync(creds, 0o700);
  chmodSync(join(creds, "devops-agent"), 0o755);
  const dry = installAgent(ctx(), ["devops-agent"], { dryRun: true });
  assert.deepEqual(dry.credentials, [{ role: "devops-agent", service: "coolify", path: join(creds, "devops-agent", "coolify.env"), action: "refused" }]);
  assert.match(dry.credential_errors[0], /Credential directory must be a private 0700 dir owned by you: .*\/devops-agent$/);
  const r = codeOf(() => installAgent(ctx(), ["devops-agent"]));
  assert.equal(r.code, EXIT.CREDENTIAL);
  assert.match(r.message, /Refusing to run: 1 existing credential file\(s\) would fail; nothing was written/);
  assert.equal(existsSync(def), false);
  assert.deepEqual(readdirSync(join(creds, "devops-agent")), []);
}));

test("init writes a service file for an unbound service, and says nothing reads it yet", () => withDir((root) => {
  const cfg = join(root, "config.env");
  writeFileSync(cfg, [
    `VBCDX_AGENTS_BASE_DIR=${root}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${root}/creds`, `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${root}/claude`,
    "VBCDX_AGENTS_TOKEN_CODE_AGENT__MY_TOOL=t",
  ].join("\n") + "\n");
  const report = init([PACK_ARG, "--harness=claude", "--env=" + cfg, "--scope=user", "--agents=code-agent"]);
  const file = join(root, "creds", "code-agent", "my-tool.env");
  assert.deepEqual(report.credentials, [{ role: "code-agent", service: "my-tool", path: file, action: "written", unknown: false }]);
  assert.ok(report.warnings.includes(`Credential file ${file} will be written, but no bound service is named my-tool; nothing reads it until one is.`));
  assert.equal(modeOf(join(root, "creds", "code-agent")), 0o700);
  assert.equal(modeOf(file), 0o600);
}));

test("an integrations file may map a role to its service file, which the same run writes", () => withDir((root) => {
  const manifest = join(root, "forgejo.json");
  writeFileSync(manifest, JSON.stringify({ schema_version: 1, service: "forgejo", contract: FORGEJO_CONTRACT, package_version: "0.0.1", tools: tools(["whoami"]) }));
  const file = join(root, "creds", "code-agent", "forgejo.env");
  const integrations = join(root, "integrations.json");
  writeFileSync(integrations, JSON.stringify({ schema_version: 1, services: { forgejo: { server_name: "forgejo", manifest_file: manifest, credentials: { "code-agent": file } } } }));
  const cfg = join(root, "config.env");
  const base = [
    `VBCDX_AGENTS_BASE_DIR=${root}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${root}/creds`, `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${root}/claude`,
    `VBCDX_AGENTS_INTEGRATIONS_FILE=${integrations}`,
  ];
  // Without the service triple the mapped file must already exist.
  writeFileSync(cfg, base.join("\n") + "\n");
  assert.equal(codeOf(() => init([PACK_ARG, "--harness=claude", "--env=" + cfg, "--agents=code-agent"])).code, EXIT.CREDENTIAL);
  // The role-wide triple writes <role>.env, which is not the mapped file.
  writeFileSync(cfg, [...base, "VBCDX_AGENTS_USER_CODE_AGENT=u", "VBCDX_AGENTS_TOKEN_CODE_AGENT=t"].join("\n") + "\n");
  assert.equal(codeOf(() => init([PACK_ARG, "--harness=claude", "--env=" + cfg, "--agents=code-agent"])).code, EXIT.CREDENTIAL);
  writeFileSync(cfg, [...base, "VBCDX_AGENTS_USER_CODE_AGENT__FORGEJO=u", "VBCDX_AGENTS_TOKEN_CODE_AGENT__FORGEJO=t"].join("\n") + "\n");
  const report = init([PACK_ARG, "--harness=claude", "--env=" + cfg, "--agents=code-agent"]);
  assert.deepEqual(report.credentials.map((c) => [c.path, c.action]), [[file, "written"]]);
  assert.ok(read(join(root, "claude", "agents", "code-agent.md")).includes(`credential_file="${file}"`));
}));

test("CLI: install agent reports each service's file on its own line", () => withDir((home) => {
  twoTools(home, [
    "VBCDX_AGENTS_USER_DEVOPS_AGENT__FORGEJO=u",
    "VBCDX_AGENTS_TOKEN_DEVOPS_AGENT__FORGEJO=SECRET-FJ",
    "VBCDX_AGENTS_TOKEN_DEVOPS_AGENT__COOLIFY=SECRET-CF",
  ]);
  const env = { ...process.env, HOME: home };
  for (const k of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "OPENCODE_CONFIG_DIR", "HERMES_HOME"]) delete env[k];
  const bin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "vbcdx.js");
  const r = spawnSync(process.execPath, [bin, "install", "agent", "devops-agent", "--harness=claude", `--env=${join(home, "config.env")}`, PACK_ARG], { encoding: "utf8", env, cwd: home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}credential devops-agent\/forgejo: written$/m);
  assert.match(r.stdout, /^ {2}credential devops-agent\/coolify: written$/m);
  assert.equal(/SECRET-/.test(r.stdout + r.stderr), false);
}));

test("an existing service file that misses a field its contract needs is refused, even with --force", () => withDir((home) => {
  const { ctx, creds, def } = twoTools(home, ["VBCDX_AGENTS_USER_DEVOPS_AGENT__FORGEJO=u", "VBCDX_AGENTS_TOKEN_DEVOPS_AGENT__FORGEJO=t"]);
  const fj = join(creds, "devops-agent", "forgejo.env");
  mkdirSync(join(creds, "devops-agent"), { recursive: true });
  chmodSync(creds, 0o700);
  chmodSync(join(creds, "devops-agent"), 0o700);
  writeFileSync(fj, 'VBCDX_AGENTS_ROLE="devops-agent"\nVBCDX_AGENTS_TOKEN="old"\n', { mode: 0o600 });
  const dry = installAgent(ctx(), ["devops-agent"], { dryRun: true, force: true });
  assert.deepEqual(dry.credentials.map((c) => c.action), ["refused"]);
  assert.match(dry.credential_errors[0], /forgejo\.env is invalid \(missing VBCDX_AGENTS_USER\)/);
  const r = codeOf(() => installAgent(ctx(), ["devops-agent"], { force: true }));
  assert.equal(r.code, EXIT.CREDENTIAL);
  assert.equal(existsSync(def), false);
  assert.equal(read(fj), 'VBCDX_AGENTS_ROLE="devops-agent"\nVBCDX_AGENTS_TOKEN="old"\n');
}));

// ── only the role/tool pairs a definition binds ──

const cred = (role, user) => `VBCDX_AGENTS_ROLE="${role}"\n${user ? `VBCDX_AGENTS_USER="${user}"\n` : ""}VBCDX_AGENTS_TOKEN="t"\n`;
function privateFile(creds, rel, body) {
  const file = join(creds, rel);
  for (const d of [creds, join(creds, rel.split("/")[0])]) { mkdirSync(d, { recursive: true }); chmodSync(d, 0o700); }
  writeFileSync(file, body, { mode: 0o600 });
  return file;
}

test("a role whose allowlist grants no tool of a service is neither warned about nor checked for its file", () => withDir((home) => {
  const { ctx, creds } = twoTools(home, []);
  // review-agent's allowlist grants forgejo tools only; devops-agent's grants both.
  const r = installAgent(ctx(), ["review-agent", "devops-agent"]);
  const warned = r.warnings.filter((w) => /credential file/.test(w)).map((w) => w.split(",")[0]).sort();
  assert.deepEqual(warned, ["devops-agent is bound to coolify", "devops-agent is bound to forgejo", "review-agent is bound to forgejo"]);
  const manifest = JSON.parse(read(join(home, "state", "manifests", "installation.json")));
  const recorded = Object.fromEntries(Object.values(manifest.files).filter((f) => f.role).map((f) => [f.role, f.credentials]));
  assert.deepEqual(recorded, {
    "review-agent": { forgejo: join(creds, "review-agent", "forgejo.env") },
    "devops-agent": { forgejo: join(creds, "devops-agent", "forgejo.env"), coolify: join(creds, "devops-agent", "coolify.env") },
  });
  privateFile(creds, "review-agent/forgejo.env", cred("review-agent", "u"));
  privateFile(creds, "devops-agent/forgejo.env", cred("devops-agent", "u"));
  privateFile(creds, "devops-agent/coolify.env", cred("devops-agent"));
  const env = { FJ_URL: "x", CF_URL: "y" };
  let rep = doctor(ctx(), { env });
  assert.equal(rep.ok, true, JSON.stringify(rep.tools.map((t) => t.checks.filter((c) => !c.ok))));
  const coolify = rep.tools.find((t) => t.server === "coolify");
  assert.deepEqual(coolify.checks.filter((c) => c.check.startsWith("credential file")).map((c) => c.check), ["credential file devops-agent"]);
  // A manifest written before bindings were recorded keeps the old, every-role check.
  const mpath = join(home, "state", "manifests", "installation.json");
  for (const f of Object.values(manifest.files)) delete f.credentials;
  writeFileSync(mpath, JSON.stringify(manifest));
  rep = doctor(ctx(), { env });
  assert.equal(rep.ok, false);
  const legacyCheck = rep.tools.find((t) => t.server === "coolify").checks.find((c) => c.check === "credential file review-agent");
  assert.equal(legacyCheck.ok, false);
  assert.ok(legacyCheck.detail.startsWith(`${join(creds, "review-agent", "coolify.env")} missing`), legacyCheck.detail);
  // ...until the next install agent records them, even though no definition changed.
  const again = installAgent(ctx(), ["review-agent", "devops-agent"]);
  assert.ok(again.generated.every((g) => g.action === "noop"));
  assert.equal(doctor(ctx(), { env }).ok, true);
}));

test("a triple for a service that takes no credential file is written with a warning that nothing reads it", () => withDir((home) => {
  const { ctx, creds } = twoTools(home, ["VBCDX_AGENTS_TOKEN_DEVOPS_AGENT__TRACKER=t"]);
  installTool(ctx(), toolPackage(join(home, "tr"), { server: "tracker", contract: "example.tracker/1", envName: "TR_URL", toolNames: ["a"], credentialFile: false }));
  const r = installAgent(ctx(), ["devops-agent"]);
  const file = join(creds, "devops-agent", "tracker.env");
  assert.ok(r.warnings.includes(`Credential file ${file} will be written, but tracker takes no credential file (its identity travels with each call); nothing reads it.`), r.warnings.join("\n"));
  assert.equal(existsSync(file), true);
}));

test("a key whose role part is unknown and followed by __ is refused as a likely typo, not dropped", () => {
  for (const key of ["VBCDX_AGENTS_TOKEN_CODE__AGENT", "VBCDX_AGENTS_USER_CODE__AGENT__FORGEJO"]) {
    const r = codeOf(() => collectCredentialTriples(new Map([[key, "SECRET"]])));
    assert.equal(r.code, EXIT.CONFIG, key);
    assert.match(r.message, /: code is not a role of a loaded agent pack\. A role suffix uses single underscores \(CODE_AGENT\); two separate the role from a service \(CODE_AGENT__FORGEJO\)\.$/);
    assert.ok(r.message.startsWith(`Credential key ${key}:`));
    assert.equal(r.message.includes("SECRET"), false);
  }
  // A role-wide key for an unknown role keeps its old treatment: collected, and judged by the planner.
  assert.equal(collectCredentialTriples(new Map([["VBCDX_AGENTS_TOKEN_SOMEONE_ELSE", "t"]])).get("someone-else").known, false);
});
