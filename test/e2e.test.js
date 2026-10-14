import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/index.js";
import { EXIT } from "../src/errors.js";
import { FIXTURE_IDS, PACK_ARG } from "./helpers/fixture-pack.js";

function env() {
  const root = mkdtempSync(join(tmpdir(), "vbcdx-e2e-"));
  return {
    root,
    write(lines) {
      const p = join(root, "config.env");
      writeFileSync(p, lines.join("\n") + "\n");
      return p;
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

test("credential-free Claude user install writes every role's definition and no credentials", () => {
  const e = env();
  const cfg = e.write([
    `VBCDX_AGENTS_BASE_DIR=${e.root}/state`,
    `VBCDX_AGENTS_CREDENTIALS_DIR=${e.root}/creds`,
    `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${e.root}/claude`,
  ]);
  const report = init([PACK_ARG, "--harness=claude", "--env=" + cfg, "--scope=user"]);
  assert.equal(report.generated.length, FIXTURE_IDS.length);
  assert.ok(report.generated.every((g) => g.action === "install"));
  assert.equal(existsSync(join(e.root, "creds")), false); // no credential dir when none needed
  assert.deepEqual(report.launchEnv, { CLAUDE_CONFIG_DIR: `${e.root}/claude` });
  e.cleanup();
});

test("project scope writes into the worktree and fails without one", () => {
  const e = env();
  const cfg = e.write([`VBCDX_AGENTS_BASE_DIR=${e.root}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${e.root}/creds`]);
  // No .git -> fails config phase.
  try {
    init([PACK_ARG, "--harness=opencode", "--env=" + cfg, "--scope=project", "--agents=code-agent"], { cwd: e.root });
    assert.fail("should require a worktree");
  } catch (err) { assert.equal(err.code, EXIT.CONFIG); }
  // With a .git present, writes to <worktree>/.opencode/agents.
  mkdirSync(join(e.root, ".git"));
  const report = init([PACK_ARG, "--harness=opencode", "--env=" + cfg, "--scope=project", "--agents=code-agent"], { cwd: e.root });
  assert.ok(existsSync(join(e.root, ".opencode", "agents", "code-agent.md")));
  e.cleanup();
});

test("--dry-run writes nothing and takes no locks", () => {
  const e = env();
  const cfg = e.write([`VBCDX_AGENTS_BASE_DIR=${e.root}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${e.root}/creds`, `VBCDX_AGENTS_CODEX_HOME=${e.root}/codex`]);
  const report = init([PACK_ARG, "--harness=codex", "--env=" + cfg, "--scope=user", "--agents=code-agent"]);
  const dry = init([PACK_ARG, "--harness=codex", "--env=" + cfg, "--scope=user", "--agents=qa-agent", "--dry-run"]);
  assert.ok(dry.dryRun);
  assert.equal(existsSync(join(e.root, "codex", "agents", "qa-agent.toml")), false);
  assert.ok(existsSync(join(e.root, "codex", "agents", "code-agent.toml"))); // the earlier real run
  e.cleanup();
});

test("complete credential triple writes a 0600 file; incomplete selected fails with exit 3", () => {
  const e = env();
  const cfg = e.write([
    `VBCDX_AGENTS_BASE_DIR=${e.root}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${e.root}/creds`,
    `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${e.root}/claude`,
    `VBCDX_AGENTS_USER_CODE_AGENT=alice`, `VBCDX_AGENTS_TOKEN_CODE_AGENT=tok`,
  ]);
  const report = init([PACK_ARG, "--harness=claude", "--env=" + cfg, "--agents=code-agent"]);
  const credPath = join(e.root, "creds", "code-agent.env");
  assert.equal(statSync(credPath).mode & 0o777, 0o600);
  assert.equal(report.credentials[0].action, "written");

  const bad = e.write([
    `VBCDX_AGENTS_BASE_DIR=${e.root}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${e.root}/creds`,
    `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${e.root}/claude`, `VBCDX_AGENTS_USER_QA_AGENT=bob`,
  ]);
  try {
    init([PACK_ARG, "--harness=claude", "--env=" + bad, "--agents=qa-agent"]);
    assert.fail("incomplete triple should fail");
  } catch (err) { assert.equal(err.code, EXIT.CREDENTIAL); }
  e.cleanup();
});

test("rerun is idempotent; a missing owned file is repaired; a user edit conflicts unless forced", () => {
  const e = env();
  const cfg = e.write([`VBCDX_AGENTS_BASE_DIR=${e.root}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${e.root}/creds`, `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${e.root}/claude`]);
  init([PACK_ARG, "--harness=claude", "--env=" + cfg, "--agents=code-agent"]);
  const def = join(e.root, "claude", "agents", "code-agent.md");

  // Idempotent rerun -> noop.
  const again = init([PACK_ARG, "--harness=claude", "--env=" + cfg, "--agents=code-agent"]);
  assert.equal(again.generated[0].action, "noop");

  // Delete the owned file -> repaired even at the same version.
  rmSync(def);
  const repaired = init([PACK_ARG, "--harness=claude", "--env=" + cfg, "--agents=code-agent"]);
  assert.equal(repaired.generated[0].action, "repair");
  assert.ok(existsSync(def));

  // User edits the file -> conflict without force, forced overwrite with --force.
  writeFileSync(def, "user hand-edit\n");
  try {
    init([PACK_ARG, "--harness=claude", "--env=" + cfg, "--agents=code-agent"]);
    assert.fail("edited file should conflict");
  } catch (err) { assert.equal(err.code, EXIT.CONFLICT); }
  const forced = init([PACK_ARG, "--harness=claude", "--env=" + cfg, "--agents=code-agent", "--force"]);
  assert.equal(forced.generated[0].action, "forced");
  e.cleanup();
});

test("a valid existing credential file is retained without force and replaced with force", () => {
  const e = env();
  const base = [`VBCDX_AGENTS_BASE_DIR=${e.root}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${e.root}/creds`, `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${e.root}/claude`];
  const cfg1 = e.write([...base, `VBCDX_AGENTS_USER_CODE_AGENT=alice`, `VBCDX_AGENTS_TOKEN_CODE_AGENT=old`]);
  init([PACK_ARG, "--harness=claude", "--env=" + cfg1, "--agents=code-agent"]);
  const credPath = join(e.root, "creds", "code-agent.env");
  const cfg2 = e.write([...base, `VBCDX_AGENTS_USER_CODE_AGENT=alice`, `VBCDX_AGENTS_TOKEN_CODE_AGENT=new`]);
  const retained = init([PACK_ARG, "--harness=claude", "--env=" + cfg2, "--agents=code-agent"]);
  assert.equal(retained.credentials[0].action, "retained");
  assert.match(readFileSync(credPath, "utf8"), /old/);
  const replaced = init([PACK_ARG, "--harness=claude", "--env=" + cfg2, "--agents=code-agent", "--force"]);
  assert.equal(replaced.credentials[0].action, "replaced");
  assert.match(readFileSync(credPath, "utf8"), /new/);
  e.cleanup();
});

test("integrations bind tools for a mapped role and require external files for others", () => {
  const e = env();
  const manifest = join(e.root, "forgejo.json");
  writeFileSync(manifest, JSON.stringify({
    schema_version: 1, service: "forgejo", contract: "vbcdx.forgejo/1", package_version: "1.0.0",
    tools: [
      { name: "create_comment", description: "d", inputSchema: {}, outputSchema: {}, effect: "write", required_permissions: [] },
      { name: "whoami", description: "d", inputSchema: {}, outputSchema: {}, effect: "read", required_permissions: [] },
    ],
  }));
  const credDir = join(e.root, "creds");
  mkdirSync(credDir, { mode: 0o700 });
  // Provide an external, valid credential file for review-agent.
  const reviewCred = join(credDir, "review-agent.env");
  writeFileSync(reviewCred, 'VBCDX_AGENTS_ROLE="review-agent"\nVBCDX_AGENTS_USER="r"\nVBCDX_AGENTS_TOKEN="t"\n', { mode: 0o600 });
  const intf = join(e.root, "int.json");
  writeFileSync(intf, JSON.stringify({
    schema_version: 1,
    services: { forgejo: { server_name: "forgejo", manifest_file: manifest, credentials: { "review-agent": reviewCred } } },
  }));
  const cfg = e.write([
    `VBCDX_AGENTS_BASE_DIR=${e.root}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${credDir}`,
    `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${e.root}/claude`, `VBCDX_AGENTS_INTEGRATIONS_FILE=${intf}`,
  ]);
  init([PACK_ARG, "--harness=claude", "--env=" + cfg, "--agents=review-agent"]);
  const def = readFileSync(join(e.root, "claude", "agents", "review-agent.md"), "utf8");
  assert.match(def, /mcp__forgejo__create_comment/);
  assert.match(def, new RegExp(`credential_file="${reviewCred.replace(/[/]/g, "\\/")}"`));
  e.cleanup();
});

test("an integration mapping to a missing external file fails with exit 3", () => {
  const e = env();
  const manifest = join(e.root, "forgejo.json");
  writeFileSync(manifest, JSON.stringify({
    schema_version: 1, service: "forgejo", contract: "vbcdx.forgejo/1", package_version: "1.0.0",
    tools: [{ name: "whoami", description: "d", inputSchema: {}, outputSchema: {}, effect: "read", required_permissions: [] }],
  }));
  const intf = join(e.root, "int.json");
  writeFileSync(intf, JSON.stringify({
    schema_version: 1,
    services: { forgejo: { server_name: "forgejo", manifest_file: manifest, credentials: { "review-agent": join(e.root, "nope.env") } } },
  }));
  const cfg = e.write([
    `VBCDX_AGENTS_BASE_DIR=${e.root}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${e.root}/creds`,
    `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${e.root}/claude`, `VBCDX_AGENTS_INTEGRATIONS_FILE=${intf}`,
  ]);
  try {
    init([PACK_ARG, "--harness=claude", "--env=" + cfg, "--agents=review-agent"]);
    assert.fail("missing external credential should fail");
  } catch (err) { assert.equal(err.code, EXIT.CREDENTIAL); }
  e.cleanup();
});

test("complete unknown-role triple under default-all warns and writes; explicit selection excludes it", () => {
  const e = env();
  const base = [`VBCDX_AGENTS_BASE_DIR=${e.root}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${e.root}/creds`, `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${e.root}/claude`];
  const cfg = e.write([...base, `VBCDX_AGENTS_USER_LEGACY_BOT=u`, `VBCDX_AGENTS_TOKEN_LEGACY_BOT=t`]);
  const dflt = init([PACK_ARG, "--harness=claude", "--env=" + cfg]);
  assert.ok(dflt.warnings.some((w) => /legacy-bot/.test(w)));
  assert.ok(existsSync(join(e.root, "creds", "legacy-bot.env")));
  // Explicit selection excludes the unknown triple entirely.
  const e2 = env();
  const cfg2 = e2.write([`VBCDX_AGENTS_BASE_DIR=${e2.root}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${e2.root}/creds`, `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${e2.root}/claude`, `VBCDX_AGENTS_USER_LEGACY_BOT=u`, `VBCDX_AGENTS_TOKEN_LEGACY_BOT=t`]);
  const expl = init([PACK_ARG, "--harness=claude", "--env=" + cfg2, "--agents=code-agent"]);
  assert.equal(expl.warnings.length, 0);
  assert.equal(existsSync(join(e2.root, "creds", "legacy-bot.env")), false);
  e.cleanup();
  e2.cleanup();
});

test("a separately provisioned Coolify file binds with ROLE+TOKEN and rejects a wrong ROLE / missing token", () => {
  const e = env();
  const manifest = join(e.root, "coolify.json");
  writeFileSync(manifest, JSON.stringify({
    schema_version: 1, service: "coolify", contract: "vbcdx.coolify/1", package_version: "1.0.0",
    tools: [
      { name: "deploy", description: "d", inputSchema: {}, outputSchema: {}, effect: "write", required_permissions: [] },
      { name: "list_applications", description: "d", inputSchema: {}, outputSchema: {}, effect: "read", required_permissions: [] },
    ],
  }));
  const credDir = join(e.root, "creds");
  mkdirSync(credDir, { mode: 0o700 });
  // Coolify's separately provisioned file requires only ROLE + TOKEN (no USER).
  const coolifyCred = join(credDir, "devops-agent.env");
  writeFileSync(coolifyCred, 'VBCDX_AGENTS_ROLE="devops-agent"\nVBCDX_AGENTS_TOKEN="ctok"\n', { mode: 0o600 });
  const intf = join(e.root, "int.json");
  writeFileSync(intf, JSON.stringify({
    schema_version: 1,
    services: { coolify: { server_name: "coolify", manifest_file: manifest, credentials: { "devops-agent": coolifyCred } } },
  }));
  const cfg = e.write([
    `VBCDX_AGENTS_BASE_DIR=${e.root}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${credDir}`,
    `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${e.root}/claude`, `VBCDX_AGENTS_INTEGRATIONS_FILE=${intf}`,
  ]);
  init([PACK_ARG, "--harness=claude", "--env=" + cfg, "--agents=devops-agent"]);
  const def = readFileSync(join(e.root, "claude", "agents", "devops-agent.md"), "utf8");
  assert.match(def, /mcp__coolify__deploy/);
  assert.match(def, new RegExp(`credential_file="${coolifyCred.replace(/[/]/g, "\\/")}"`));

  // Wrong ROLE in the external file is a credential error (exit 3).
  writeFileSync(coolifyCred, 'VBCDX_AGENTS_ROLE="code-agent"\nVBCDX_AGENTS_TOKEN="ctok"\n', { mode: 0o600 });
  try {
    init([PACK_ARG, "--harness=claude", "--env=" + cfg, "--agents=devops-agent"]);
    assert.fail("wrong ROLE should fail");
  } catch (err) { assert.equal(err.code, EXIT.CREDENTIAL); }

  // A Coolify file missing TOKEN is incomplete (exit 3).
  writeFileSync(coolifyCred, 'VBCDX_AGENTS_ROLE="devops-agent"\n', { mode: 0o600 });
  try {
    init([PACK_ARG, "--harness=claude", "--env=" + cfg, "--agents=devops-agent"]);
    assert.fail("missing token should fail");
  } catch (err) { assert.equal(err.code, EXIT.CREDENTIAL); }
  e.cleanup();
});

test("a corrupt installation manifest fails conservatively without claiming ownership", () => {
  const e = env();
  const cfg = e.write([`VBCDX_AGENTS_BASE_DIR=${e.root}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${e.root}/creds`, `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${e.root}/claude`]);
  init([PACK_ARG, "--harness=claude", "--env=" + cfg, "--agents=code-agent"]);
  const manifestPath = join(e.root, "state", "manifests", "installation.json");
  writeFileSync(manifestPath, "{ this is not valid json");
  try {
    init([PACK_ARG, "--harness=claude", "--env=" + cfg, "--agents=code-agent"]);
    assert.fail("corrupt manifest should fail");
  } catch (err) { assert.equal(err.code, EXIT.FILESYSTEM); }
  e.cleanup();
});
