// 25 rows: 6 commands (install agent, install agent --dry-run, install tool, remove agent, list, doctor) x 4 rows each (e1 duplicate, e2 unknown, e3 missing, e4 control) + 1 relative --env row.
// killed by: in src/install/context.js resolveContext, entries = parseEnvFile(envPath) wrapped in a try/catch that falls back to new Map() (every e1 row then passes the parse).
// Fail closed on bad config. Drafted by OpenCode from card s13-v-a3, reviewed.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { PACK_ARG } from "./helpers/fixture-pack.js";
import { EXIT } from "../src/errors.js";

process.umask(0o022);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const TOOL_FIXTURE = join(HERE, "fixtures", "tool-package");

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "vbcdx-s13-"));
  roots.push(d);
  return d;
}

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

const C = `Zq.${randomBytes(6).toString("hex")}`;

const COMMANDS = [
  { name: "install agent", args: (cfg) => ["install", "agent", "code-agent", "--harness=claude", `--env=${cfg}`, PACK_ARG] },
  { name: "install agent --dry-run", args: (cfg) => ["install", "agent", "code-agent", "--harness=claude", `--env=${cfg}`, PACK_ARG, "--dry-run"] },
  { name: "install tool", args: (cfg) => ["install", "tool", TOOL_FIXTURE, "--harness=claude", `--env=${cfg}`] },
  // remove takes no --pack ("remove agent does not take --pack."). Its control needs something to
  // remove, so it installs the agent first and requires that install to succeed.
  { name: "remove agent", setup: (home, cfg) => {
    const i = vbcdx(home, ["install", "agent", "code-agent", "--harness=claude", `--env=${cfg}`, PACK_ARG]);
    assert.equal(i.status, 0, i.stderr);
  }, args: (cfg) => ["remove", "agent", "code-agent", "--harness=claude", `--env=${cfg}`] },
  { name: "list", args: (cfg) => ["list", "--harness=claude", `--env=${cfg}`] },
  { name: "doctor", args: (cfg) => ["doctor", "--harness=claude", `--env=${cfg}`] },
];

for (const cmd of COMMANDS) {
  test(`S13 s13-v-a3: ${cmd.name} e1 duplicate key`, () => {
    const { home, cfg } = homeWithConfig([`S13_X=${C}`, `S13_X=${C}`]);
    const before = tree(home);
    const r = vbcdx(home, cmd.args(cfg));
    assert.equal(r.status, EXIT.CONFIG, r.stderr);
    assert.match(r.stderr, /Duplicate configuration key/);
    assert.deepEqual(tree(home), before);
    assert.equal((r.stdout + r.stderr).includes(C), false);
  });

  test(`S13 s13-v-a3: ${cmd.name} e2 unknown key`, () => {
    const { home, cfg } = homeWithConfig([`VBCDX_AGENTS_BASEDIR=${C}`]);
    const before = tree(home);
    const r = vbcdx(home, cmd.args(cfg));
    assert.equal(r.status, EXIT.CONFIG, r.stderr);
    assert.match(r.stderr, /Unsupported configuration key VBCDX_AGENTS_BASEDIR/);
    assert.deepEqual(tree(home), before);
    assert.equal((r.stdout + r.stderr).includes(C), false);
  });

  test(`S13 s13-v-a3: ${cmd.name} e3 missing configuration file`, () => {
    const { home, cfg } = homeWithConfig();
    const before = tree(home);
    const r = vbcdx(home, cmd.args(`${cfg}.missing`));
    assert.equal(r.status, EXIT.CONFIG, r.stderr);
    assert.match(r.stderr, /Cannot read configuration file/);
    assert.deepEqual(tree(home), before);
    assert.equal((r.stdout + r.stderr).includes(C), false);
  });

  test(`S13 s13-v-a3: ${cmd.name} e4 control`, () => {
    const { home, cfg } = homeWithConfig();
    cmd.setup?.(home, cfg);
    const r = vbcdx(home, cmd.args(cfg));
    assert.notEqual(r.status, EXIT.CONFIG, r.stderr);
    assert.doesNotMatch(r.stderr, /configuration/i);
    // With the agent installed first, removing it must work outright.
    if (cmd.name === "remove agent") assert.equal(r.status, 0, r.stderr);
  });
}

test("S13 s13-v-a3: install agent rejects a relative --env path", () => {
  const { home } = homeWithConfig();
  const before = tree(home);
  const r = vbcdx(home, ["install", "agent", "code-agent", "--harness=claude", "--env=rel/cfg.env", PACK_ARG]);
  assert.equal(r.status, EXIT.CONFIG, r.stderr);
  assert.match(r.stderr, /--env must be an absolute path/);
  assert.deepEqual(tree(home), before);
  assert.equal((r.stdout + r.stderr).includes(C), false);
});
