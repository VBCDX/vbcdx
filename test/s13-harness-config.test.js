// Rows: h1, h2, CONTROL, h3 (4 tests)
// killed by: not yet shown. Disabling only the `onDisk.doc === null` guard in planEntryWrite SURVIVES: checkedEdit then throws on the malformed text and the write is still refused (a second layer).
// Fail closed on bad config. Drafted by OpenCode from card s13-v-b2, reviewed.

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

// The integrations file is read only if no one but its owner can change it; pin the umask so
// a host with umask 002 writes the fixtures the same way.
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
const BAD = `{"mcpServers": {}, "s13": "${C}", `;

test("S13 s13-v-b2: h1 a malformed harness config is a conflict and nothing is written", () => {
  const { home, cfg, harnessDir } = homeWithConfig();
  const target = join(harnessDir, ".claude.json");
  writeFileSync(target, BAD);
  const before = tree(home);
  const bytes = readFileSync(target);

  const r = vbcdx(home, ["install", "tool", TOOL_FIXTURE, "--harness=claude", `--env=${cfg}`]);

  assert.equal(r.status, EXIT.CONFLICT, r.stderr);
  assert.match(r.stderr, /Nothing was written/);
  assert.ok(readFileSync(target).equals(bytes));
  assert.deepEqual(tree(home), before);
});

test("S13 s13-v-b2: h2 --force never rewrites the malformed file whole", () => {
  const { home, cfg, harnessDir } = homeWithConfig();
  const target = join(harnessDir, ".claude.json");
  writeFileSync(target, BAD);
  const bytes = readFileSync(target);

  vbcdx(home, ["install", "tool", TOOL_FIXTURE, "--harness=claude", `--env=${cfg}`, "--force"]);

  assert.ok(readFileSync(target).equals(bytes));
});

test("S13 s13-v-b2: CONTROL a valid empty config receives mcpServers", () => {
  const { home, cfg, harnessDir } = homeWithConfig();
  const target = join(harnessDir, ".claude.json");
  writeFileSync(target, "{}");

  const r = vbcdx(home, ["install", "tool", TOOL_FIXTURE, "--harness=claude", `--env=${cfg}`]);

  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(readFileSync(target, "utf8"));
  assert.ok(parsed.mcpServers && typeof parsed.mcpServers === "object");
});

// CANDIDATE: may be red on main (the JSON parser's message can quote the file). If red, it is a product finding for vbcdx, not a test bug; the applier reports it and removes this test before the PR.
test("S13 h3 CANDIDATE: the malformed file's content is not echoed", () => {
  const { home, cfg, harnessDir } = homeWithConfig();
  const target = join(harnessDir, ".claude.json");
  writeFileSync(target, BAD);

  const r = vbcdx(home, ["install", "tool", TOOL_FIXTURE, "--harness=claude", `--env=${cfg}`]);

  assert.equal((r.stdout + r.stderr).includes(C), false);
});
