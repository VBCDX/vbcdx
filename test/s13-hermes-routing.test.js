// 10 rows: R1-R9 and the CONTROL.
// killed by: in `src/config/config.js` loadHermesRouting, `if (model || Object.keys(roleModels).length) { throw ... }` replaced with nothing (R1/R2 then get status 0).
// Fail closed on bad config. Drafted by OpenCode from card s13-v-b3, reviewed.

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
const U = "https://llm.example.test";

const rows = [
  {
    what: "model without base URL",
    lines: [`VBCDX_AGENTS_HERMES_MODEL=m1-${C}`],
    stderr: /requires VBCDX_AGENTS_HERMES_BASE_URL/,
  },
  {
    what: "per-role model without base URL",
    lines: [`VBCDX_AGENTS_HERMES_MODEL_CODE_AGENT=m1-${C}`],
    stderr: /requires VBCDX_AGENTS_HERMES_BASE_URL/,
  },
  {
    what: "base URL without model",
    lines: [`VBCDX_AGENTS_HERMES_BASE_URL=${U}`],
    stderr: /requires VBCDX_AGENTS_HERMES_MODEL or a per-role/,
  },
  {
    what: "model with a space",
    lines: [`VBCDX_AGENTS_HERMES_BASE_URL=${U}`, `VBCDX_AGENTS_HERMES_MODEL=m ${C}`],
    stderr: /VBCDX_AGENTS_HERMES_MODEL is not a valid model name/,
  },
  {
    what: "base URL with embedded credentials",
    lines: [`VBCDX_AGENTS_HERMES_BASE_URL=https://u:${C}@llm.example.test`, `VBCDX_AGENTS_HERMES_MODEL=m1`],
    stderr: /VBCDX_AGENTS_HERMES_BASE_URL must not embed credentials/,
  },
  {
    what: "web search tool without URL",
    lines: [`VBCDX_AGENTS_HERMES_WEB_SEARCH_TOOL=t1-${C}`],
    stderr: /requires VBCDX_AGENTS_HERMES_WEB_SEARCH_URL/,
  },
  {
    what: "web search URL without tool",
    lines: [`VBCDX_AGENTS_HERMES_WEB_SEARCH_URL=${U}/${C}`],
    stderr: /requires VBCDX_AGENTS_HERMES_WEB_SEARCH_TOOL/,
  },
  {
    what: "invalid web search tool name",
    lines: [`VBCDX_AGENTS_HERMES_WEB_SEARCH_URL=${U}`, `VBCDX_AGENTS_HERMES_WEB_SEARCH_TOOL=-${C}`],
    stderr: /VBCDX_AGENTS_HERMES_WEB_SEARCH_TOOL is not a valid search tool name/,
  },
  {
    what: "unknown role model",
    lines: [`VBCDX_AGENTS_HERMES_BASE_URL=${U}`, `VBCDX_AGENTS_HERMES_MODEL_NOSUCHROLE=m1`],
    stderr: /does not name a role of a loaded agent pack/,
  },
];

for (const row of rows) {
  test(`S13 s13-v-b3: ${row.what} is rejected before writing`, () => {
    const { home, cfg } = homeWithConfig(row.lines, "hermes");
    const before = tree(home);
    const r = vbcdx(home, ["install", "agent", "code-agent", "--harness=hermes", `--env=${cfg}`, PACK_ARG]);
    assert.equal(r.status, EXIT.CONFIG, r.stderr || "");
    assert.match(r.stderr || "", row.stderr);
    assert.deepEqual(tree(home), before);
    assert.equal((r.stdout + r.stderr).includes(C), false);
  });
}

test("S13 s13-v-b3: control installs with valid routing", () => {
  const { home, cfg } = homeWithConfig([
    `VBCDX_AGENTS_HERMES_BASE_URL=${U}`,
    "VBCDX_AGENTS_HERMES_MODEL=m1",
  ], "hermes");
  const before = tree(home);
  const r = vbcdx(home, ["install", "agent", "code-agent", "--harness=hermes", `--env=${cfg}`, PACK_ARG]);
  const first = (r.stderr || "").split("\n")[0];
  assert.equal(r.status, 0, r.status === 0 ? undefined : `CONTROL FAILED: ${r.status} ${first}`);
  assert.notDeepEqual(tree(home), before);
  assert.equal((r.stdout + r.stderr).includes(C), false);
});
