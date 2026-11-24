// 8 refusal rows + 1 control row.
// killed by: loadIntegrations (src/config/integrations.js) returning null instead of throwing on a parse error (I1/I2 then get status 0).
// Fail closed on bad config. Drafted by OpenCode from card s13-v-b1, reviewed.

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

function appendCfg(cfg, line) {
  writeFileSync(cfg, readFileSync(cfg, "utf8") + line + "\n");
}

const tool = (name) => ({ name, description: name, inputSchema: {}, outputSchema: {}, effect: "read", required_permissions: [] });

function prepareValid(home) {
  const manifest = { schema_version: 1, service: "tracker", contract: "example.tracker/1", package_version: "0.1.0", tools: [tool("get_issue"), tool("whoami")] };
  const manifestFile = join(home, "tracker.manifest.json");
  writeFileSync(manifestFile, JSON.stringify(manifest));
  const integrations = { schema_version: 1, services: { tracker: { server_name: "tracker", manifest_file: manifestFile } } };
  const integFile = join(home, "integrations.json");
  writeFileSync(integFile, JSON.stringify(integrations));
  return { manifest, manifestFile, integrations, integFile };
}

const rows = [
  {
    id: "I1",
    what: "a duplicate key in the integrations file is refused as invalid JSON",
    status: EXIT.CONFIG,
    re: /Invalid JSON/,
    prepare(home) {
      prepareValid(home);
      const integFile = join(home, "integrations.json");
      writeFileSync(integFile, `{"schema_version":1,"services":{},"services":{"x":"${C}"}}`);
      return integFile;
    },
  },
  {
    id: "I2",
    what: "trailing data after the integrations JSON is refused as invalid JSON",
    status: EXIT.CONFIG,
    re: /Invalid JSON/,
    prepare(home) {
      const { integrations, integFile } = prepareValid(home);
      writeFileSync(integFile, JSON.stringify(integrations) + " " + C);
      return integFile;
    },
  },
  {
    id: "I3",
    what: "an unknown field in the integrations file is refused",
    status: EXIT.CONFIG,
    re: /Unknown field "note" in integrations file/,
    prepare(home) {
      const { integrations, integFile } = prepareValid(home);
      writeFileSync(integFile, JSON.stringify({ ...integrations, note: C }));
      return integFile;
    },
  },
  {
    id: "I4",
    what: "an unsupported integrations schema_version is refused",
    status: EXIT.CONFLICT,
    re: /unsupported schema_version 2/,
    prepare(home) {
      const { integrations, integFile } = prepareValid(home);
      writeFileSync(integFile, JSON.stringify({ ...integrations, schema_version: 2 }));
      return integFile;
    },
  },
  {
    id: "I5",
    what: "a server_name that is not the service name is refused",
    status: EXIT.CONFIG,
    re: /server_name must be exactly "tracker"/,
    prepare(home) {
      const { integrations, integFile } = prepareValid(home);
      const changed = { ...integrations, services: { tracker: { ...integrations.services.tracker, server_name: "other" } } };
      writeFileSync(integFile, JSON.stringify(changed));
      return integFile;
    },
  },
  {
    id: "I6",
    what: "a manifest that declares another service is refused",
    status: EXIT.CONFLICT,
    re: /declares service other, expected tracker/,
    prepare(home) {
      const { manifest, manifestFile, integFile } = prepareValid(home);
      writeFileSync(manifestFile, JSON.stringify({ ...manifest, service: "other", package_version: C }));
      return integFile;
    },
  },
  {
    id: "I7",
    what: "a manifest that declares another contract is refused",
    status: EXIT.CONFLICT,
    re: /declares contract "nocontract"/,
    prepare(home) {
      const { manifest, manifestFile, integFile } = prepareValid(home);
      writeFileSync(manifestFile, JSON.stringify({ ...manifest, contract: "nocontract", package_version: C }));
      return integFile;
    },
  },
  {
    id: "I8",
    what: "a relative VBCDX_AGENTS_INTEGRATIONS_FILE is refused",
    status: EXIT.CONFIG,
    re: /VBCDX_AGENTS_INTEGRATIONS_FILE must be an absolute path/,
    prepare() {
      return null;
    },
  },
];

for (const row of rows) {
  test(`S13 s13-v-b1: ${row.what}`, () => {
    const { home, cfg } = homeWithConfig();
    const integFile = row.prepare(home);
    const value = row.id === "I8" ? `rel/${C}.json` : integFile;
    appendCfg(cfg, `VBCDX_AGENTS_INTEGRATIONS_FILE=${value}`);
    const before = tree(home);

    const r = vbcdx(home, ["install", "agent", "code-agent", "--harness=claude", `--env=${cfg}`, PACK_ARG]);

    assert.equal(r.status, row.status, r.stderr);
    assert.match(r.stderr, row.re);
    assert.deepEqual(tree(home), before);
    assert.equal((r.stdout + r.stderr).includes(C), false);
  });
}

test("S13 s13-v-b1: control, the valid integrations file lets install agent proceed", () => {
  const { home, cfg } = homeWithConfig();
  const { integFile } = prepareValid(home);
  appendCfg(cfg, `VBCDX_AGENTS_INTEGRATIONS_FILE=${integFile}`);
  const before = tree(home);

  const r = vbcdx(home, ["install", "agent", "code-agent", "--harness=claude", `--env=${cfg}`, PACK_ARG]);

  assert.equal(r.status, 0, r.stderr);
  assert.notDeepEqual(tree(home), before);
  assert.equal((r.stdout + r.stderr).includes(C), false);
});
