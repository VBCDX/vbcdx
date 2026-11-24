import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/index.js";
import { EXIT } from "../src/errors.js";
import { FIXTURE_IDS, PACK_ARG } from "./helpers/fixture-pack.js";

// The integrations file is read only if no one but its owner can change it (and its
// directory too), and these tests write theirs with the default mode. Pin the umask a
// CI runner has, so a host whose umask is 002 (user private groups) runs them the same.
process.umask(0o022);

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

test("a Claude user install writes every role's definition and no credentials", () => {
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

// What the refusals below leave behind: nothing. No definition, no manifest, no credential file.
function refusedWith(run, root, re) {
  try {
    run();
    assert.fail("should be refused");
  } catch (err) {
    assert.equal(err.code, EXIT.CONFIG, err.message);
    assert.match(err.message, re);
    assert.equal(err.message.includes("SECRET-TOKEN"), false, "no value in the refusal");
  }
  for (const made of ["state", "claude", "creds"]) assert.equal(existsSync(join(root, made)), false, `${made} was not created`);
}

test("a credential triple in the config file is refused (exit 2), complete or incomplete, and writes nothing", () => {
  for (const triple of [
    [`VBCDX_AGENTS_USER_CODE_AGENT=alice`, `VBCDX_AGENTS_TOKEN_CODE_AGENT=SECRET-TOKEN`], // complete: once written 0600
    [`VBCDX_AGENTS_USER_CODE_AGENT=alice`], // incomplete: once exit 3
    [`VBCDX_AGENTS_TOKEN_CODE_AGENT__FORGEJO=SECRET-TOKEN`], // one tool's file
  ]) {
    const e = env();
    const cfg = e.write([`VBCDX_AGENTS_BASE_DIR=${e.root}/state`, `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${e.root}/claude`, ...triple]);
    for (const extra of [[], ["--force"], ["--dry-run"]]) {
      refusedWith(() => init([PACK_ARG, "--harness=claude", "--env=" + cfg, "--agents=code-agent", ...extra]), e.root,
        new RegExp(`remove these keys from the configuration file: ${triple.map((l) => l.split("=")[0]).join(", ")}\\.`));
    }
    e.cleanup();
  }
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

test("an existing credential file is neither read nor replaced, with or without --force: the run warns and leaves it", () => {
  const e = env();
  const cfg = e.write([`VBCDX_AGENTS_BASE_DIR=${e.root}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${e.root}/creds`, `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${e.root}/claude`]);
  const credPath = join(e.root, "creds", "code-agent.env");
  mkdirSync(join(e.root, "creds"), { mode: 0o700 });
  const body = 'VBCDX_AGENTS_ROLE="code-agent"\nVBCDX_AGENTS_USER="alice"\nVBCDX_AGENTS_TOKEN="SECRET-TOKEN"\n';
  writeFileSync(credPath, body, { mode: 0o600 });
  const then = new Date(Date.now() - 3600_000);
  utimesSync(credPath, then, then);
  const before = statSync(credPath);
  for (const extra of [[], ["--force"]]) {
    const report = init([PACK_ARG, "--harness=claude", "--env=" + cfg, "--agents=code-agent", ...extra]);
    assert.equal("credentials" in report, false);
    assert.deepEqual(report.warnings.filter((w) => w.includes(credPath)).length, 1);
    assert.equal(JSON.stringify(report).includes("SECRET-TOKEN"), false);
    const after = statSync(credPath);
    assert.deepEqual([after.mtimeMs, after.mode, after.size, after.ino], [before.mtimeMs, before.mode, before.size, before.ino]);
    assert.equal(readFileSync(credPath, "utf8"), body);
  }
  assert.equal(readFileSync(join(e.root, "claude", "agents", "code-agent.md"), "utf8").includes("credential"), false);
  e.cleanup();
});

test("an integrations file that maps a role to a credential file is refused (exit 2) for every contract, whatever the file is", () => {
  for (const [service, contract, role] of [["forgejo", "vbcdx.forgejo/1", "review-agent"], ["coolify", "vbcdx.coolify/1", "devops-agent"], ["tracker", "example.tracker/1", "code-agent"]]) {
    const bodies = {
      valid: `VBCDX_AGENTS_ROLE="${role}"\nVBCDX_AGENTS_USER="r"\nVBCDX_AGENTS_TOKEN="SECRET-TOKEN"\n`, // once: bound
      "wrong-role": 'VBCDX_AGENTS_ROLE="someone-else"\nVBCDX_AGENTS_TOKEN="SECRET-TOKEN"\n', // once: exit 3
      "no-token": `VBCDX_AGENTS_ROLE="${role}"\n`, // once: exit 3
      missing: null, // once: exit 3
    };
    for (const [label, body] of Object.entries(bodies)) {
      const e = env();
      const side = mkdtempSync(join(tmpdir(), "vbcdx-e2e-side-"));
      const manifest = join(side, `${service}.json`);
      writeFileSync(manifest, JSON.stringify({
        schema_version: 1, service, contract, package_version: "1.0.0",
        tools: [{ name: "whoami", description: "d", inputSchema: {}, outputSchema: {}, effect: "read", required_permissions: [] }],
      }));
      const cred = join(side, `${role}.env`);
      if (body !== null) writeFileSync(cred, body, { mode: 0o600 });
      const intf = join(side, "int.json");
      writeFileSync(intf, JSON.stringify({ schema_version: 1, services: { [service]: { server_name: service, manifest_file: manifest, credentials: { [role]: cred } } } }));
      const cfg = e.write([`VBCDX_AGENTS_BASE_DIR=${e.root}/state`, `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${e.root}/claude`, `VBCDX_AGENTS_INTEGRATIONS_FILE=${intf}`]);
      refusedWith(() => init([PACK_ARG, "--harness=claude", "--env=" + cfg, `--agents=${role}`]), e.root,
        new RegExp(`remove these fields: ${service}\\.credentials\\.`), `${service} ${label}`);
      rmSync(side, { recursive: true, force: true });
      e.cleanup();
    }
  }
});

test("a triple for a role no pack has is refused like any other, under default-all and under an explicit selection", () => {
  for (const agents of [[], ["--agents=code-agent"]]) {
    const e = env();
    const cfg = e.write([`VBCDX_AGENTS_BASE_DIR=${e.root}/state`, `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${e.root}/claude`, `VBCDX_AGENTS_USER_LEGACY_BOT=u`, `VBCDX_AGENTS_TOKEN_LEGACY_BOT=SECRET-TOKEN`]);
    refusedWith(() => init([PACK_ARG, "--harness=claude", "--env=" + cfg, ...agents]), e.root,
      /remove these keys from the configuration file: VBCDX_AGENTS_USER_LEGACY_BOT, VBCDX_AGENTS_TOKEN_LEGACY_BOT\./);
    e.cleanup();
  }
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
