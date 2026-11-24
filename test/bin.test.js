import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PACK_ARG } from "./helpers/fixture-pack.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "vbcdx-dev-agents.js");

function run(args, opts = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", ...opts });
}

test("--version prints the version and exits 0", () => {
  const r = run(["--version"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("--help exits 0; no command exits 2", () => {
  assert.equal(run(["--help"]).status, 0);
  assert.equal(run([]).status, 2);
  assert.equal(run(["bogus"]).status, 2);
});

test("missing --harness exits 2 (config)", () => {
  const r = run(["init", "--env=/tmp/x"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--harness is required/);
});

test("a full install exits 0 and reports actions", () => {
  const root = mkdtempSync(join(tmpdir(), "vbcdx-bin-"));
  const cfg = join(root, "c.env");
  writeFileSync(cfg, [
    `VBCDX_AGENTS_BASE_DIR=${root}/state`,
    `VBCDX_AGENTS_CREDENTIALS_DIR=${root}/creds`,
    `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${root}/claude`,
  ].join("\n") + "\n");
  const r = run(["init", PACK_ARG, "--harness=claude", `--env=${cfg}`, "--agents=code-agent,pm-agent"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /definition code-agent: install/);
  rmSync(root, { recursive: true, force: true });
});

// A base directory whose manifests/ is a regular file: mkdirSync throws a raw EEXIST
// inside executePlan, before any try, so the alias's own error path reports it and the
// run exits 4 (filesystem), not 0 and not a config error.
test("a filesystem failure under the base directory exits 4 and writes no manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "vbcdx-bin-fs-"));
  try {
    mkdirSync(join(root, "base"));
    writeFileSync(join(root, "base", "manifests"), "x");
    const cfg = join(root, "c.env");
    writeFileSync(cfg, [
      `VBCDX_AGENTS_BASE_DIR=${root}/base`,
      `VBCDX_AGENTS_CREDENTIALS_DIR=${root}/creds`,
      `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${root}/claude`,
    ].join("\n") + "\n");
    const r = run(["init", PACK_ARG, "--harness=claude", `--env=${cfg}`]);
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, /^error: (ENOTDIR|EEXIST): /m);
    // It landed on the filesystem handler, not on an argument or config guard.
    assert.doesNotMatch(r.stderr, /usage:/);
    assert.equal(existsSync(join(root, "base", "manifests", "installation.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("--quiet suppresses routine progress but not warnings", () => {
  const root = mkdtempSync(join(tmpdir(), "vbcdx-bin-"));
  const cfg = join(root, "c.env");
  writeFileSync(cfg, [
    `VBCDX_AGENTS_BASE_DIR=${root}/state`,
    `VBCDX_AGENTS_CREDENTIALS_DIR=${root}/creds`,
    `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${root}/claude`,
  ].join("\n") + "\n");
  // A credential file an earlier version left behind: the run warns about it.
  mkdirSync(join(root, "creds"));
  writeFileSync(join(root, "creds", "legacy-bot.env"), "x");
  const r = run(["init", PACK_ARG, "--harness=claude", `--env=${cfg}`, "--quiet"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), ""); // routine progress suppressed
  assert.match(r.stderr, /warning:.*legacy-bot\.env/); // warning not suppressed
  rmSync(root, { recursive: true, force: true });
});

// The deprecated alias escapes what it prints, as bin/vbcdx.js does.
test("the alias escapes control characters in what it echoes back", () => {
  const unknown = run(["bad\u001b[31mcmd‮"]);
  assert.equal(unknown.status, 2);
  // A command that isn't name-shaped isn't quoted back at all.
  assert.match(unknown.stderr, /Unknown command: <not shown>/);
  assert.doesNotMatch(unknown.stderr, /[\u001b‮]/);
  const bad = run(["init", "--harness=claude", PACK_ARG, "--env=/nonexistent/\u001b]0;pwned\u0007.env"]);
  assert.notEqual(bad.status, 0);
  // A typed path isn't quoted back in an error: it is named by its position.
  assert.match(bad.stderr, /error: Cannot read configuration file: <argument 4>/);
  assert.doesNotMatch(bad.stderr + bad.stdout, /[\u0000-\u0008\u000b-\u001f\u007f]/);
});

test("the alias escapes a path it prints on stdout", () => {
  const d = mkdtempSync(join(tmpdir(), "vbcdx-alias-"));
  try {
    const claude = join(d, "cl‮aude");
    const cfg = join(d, "cfg.env");
    writeFileSync(cfg, `VBCDX_AGENTS_BASE_DIR=${d}/base\nVBCDX_AGENTS_CREDENTIALS_DIR=${d}/creds\nVBCDX_AGENTS_CLAUDE_CONFIG_DIR=${claude}\n`);
    const r = run(["init", "--harness=claude", `--env=${cfg}`, PACK_ARG, "--agents=code-agent", "--dry-run"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /cl\\u202eaude\/agents\/code-agent\.md/);
    assert.doesNotMatch(r.stdout, /‮/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// A newline or tab inside a value is escaped too, so it cannot forge a line.
test("the alias cannot be made to print a forged line by a newline in a value", () => {
  const bad = run(["init", "--harness=claude", PACK_ARG, "--env=/nonexistent/\nFORGED-LINE\t.env"]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /error: Cannot read configuration file: <argument 4>/);
  assert.equal(bad.stderr.split("\n").some((l) => l.startsWith("FORGED-LINE")), false);
  const unknown = run(["bad\nFORGED-CMD"]);
  assert.match(unknown.stderr, /Unknown command: <not shown>/);
  assert.equal(unknown.stderr.split("\n").some((l) => l.startsWith("FORGED-CMD")), false);
  const d = mkdtempSync(join(tmpdir(), "vbcdx-alias-nl-"));
  try {
    const claude = join(d, "cl\nFORGED-PATH");
    const cfg = join(d, "cfg.env");
    writeFileSync(cfg, `VBCDX_AGENTS_BASE_DIR=${d}/base\nVBCDX_AGENTS_CREDENTIALS_DIR=${d}/creds\nVBCDX_AGENTS_CLAUDE_CONFIG_DIR=${JSON.stringify(claude)}\n`);
    // A path printed on stdout comes from the config file, which refuses a line break in
    // any value, so the report's per-value escaping is the second line of defence.
    const r = run(["init", "--harness=claude", `--env=${cfg}`, PACK_ARG, "--agents=code-agent", "--dry-run"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /VBCDX_AGENTS_CLAUDE_CONFIG_DIR at line 3 contains a line break/);
    assert.equal(r.stdout, "");
  } finally { rmSync(d, { recursive: true, force: true }); }
});
