// 11 malformed-env rows (G1-G11) plus the control row: 12 tests.
// killed by: any one `throw configError(...)` in src/config/env-parser.js replaced by a fallback value (its row then gets status 0 and writes files).
// Fail closed on bad config. Drafted by OpenCode from card s13-v-a1, reviewed.
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

const C = `Zq.${randomBytes(6).toString("hex")}`;

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

const ROWS = [
  { id: "G1", what: "unterminated double-quoted value (g1)", lines: [`S13_X="${C}`], re: /Malformed double-quoted value for S13_X at line \d+/ },
  { id: "G2", what: "double-quoted value followed by trailing text (g2)", lines: [`S13_X="${C}" tail`], re: /Malformed double-quoted value for S13_X at line \d+/ },
  { id: "G3", what: "unterminated single-quoted value (g3)", lines: [`S13_X='${C}`], re: /Unterminated single-quoted value for S13_X at line \d+/ },
  { id: "G4", what: "single-quoted value with trailing text (g4)", lines: [`S13_X='${C}'x'`], re: /Malformed single-quoted value for S13_X at line \d+/ },
  { id: "G5", what: "unknown escape in a double-quoted value (g5)", lines: [`S13_X="${C}\\q"`], re: /Malformed double-quoted value for S13_X at line \d+/ },
  { id: "G6", what: "duplicate key (g6)", lines: [`S13_X=${C}`, `S13_X=${C}`], re: /Duplicate configuration key/ },
  { id: "G7", what: "duplicate key differing only in case (g7)", lines: [`S13_X=${C}`, `s13_x=${C}`], re: /Duplicate configuration key/ },
  { id: "G8", what: "raw NUL byte in the file (g8)", lines: [`S13_X=${C}\u0000`], re: /contains a NUL byte/ },
  { id: "G9", what: "JSON NUL escape in a double-quoted value (g9)", lines: [`S13_X="${C}\\u0000"`], re: /Value for S13_X at line \d+ contains a NUL byte/ },
  { id: "G10", what: "JSON line-break escape in a double-quoted value (G10)", lines: [`S13_X="${C}\\nx"`], re: /Value for S13_X at line \d+ contains a line break/ },
  { id: "G11", what: "line without an equals sign (G11)", lines: [`${C} has no equals sign`], re: /Malformed line \d+ in .*: expected KEY=VALUE/ },
];

for (const row of ROWS) {
  test(`S13 s13-v-a1: ${row.what}`, () => {
    const { home, cfg } = homeWithConfig();
    writeFileSync(cfg, readFileSync(cfg, "utf8") + row.lines.join("\n") + "\n");
    const before = tree(home);
    const r = vbcdx(home, ["install", "agent", "code-agent", "--harness=claude", `--env=${cfg}`, PACK_ARG]);
    assert.equal(r.status, EXIT.CONFIG, r.stderr);
    assert.match(r.stderr, row.re);
    assert.deepEqual(tree(home), before);
    assert.equal((r.stdout + r.stderr).includes(C), false);
  });
}

test("S13 s13-v-a1: well-formed env line is accepted and the install writes files (control)", () => {
  const { home, cfg } = homeWithConfig();
  writeFileSync(cfg, readFileSync(cfg, "utf8") + `S13_X=${C}` + "\n");
  const before = tree(home);
  const r = vbcdx(home, ["install", "agent", "code-agent", "--harness=claude", `--env=${cfg}`, PACK_ARG]);
  assert.equal(r.status, 0, r.stderr);
  assert.notDeepEqual(tree(home), before);
  assert.equal((r.stdout + r.stderr).includes(C), false);
});
