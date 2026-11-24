// 12 rows: K1-K11 plus the CONTROL install.
// killed by: in `src/config/config.js` loadConfig, `if (SCALAR_KEYS.has(key)) continue;` changed to `continue;` for every `VBCDX_AGENTS_` key (k1 then gets status 0).
// Fail closed on bad config. Drafted by OpenCode from card s13-v-a2, reviewed.
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

const rows = [
  {
    id: "K1",
    what: "an unsupported key is rejected before any write",
    setup: () => homeWithConfig([`VBCDX_AGENTS_BASEDIR=${C}`]),
    re: /Unsupported configuration key VBCDX_AGENTS_BASEDIR/,
  },
  {
    id: "K2",
    what: "a missing base dir is rejected before any write",
    setup: () => {
      const home = scratch();
      mkdirSync(join(home, ".claude"));
      const cfg = join(home, "cfg.env");
      writeFileSync(cfg, [`VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${home}/.claude`].join("\n") + "\n");
      return { home, cfg };
    },
    re: /VBCDX_AGENTS_BASE_DIR is required/,
  },
  {
    id: "K3",
    what: "a relative base dir is rejected before any write",
    setup: () => {
      const home = scratch();
      mkdirSync(join(home, ".claude"));
      const cfg = join(home, "cfg.env");
      writeFileSync(cfg, [
        `VBCDX_AGENTS_BASE_DIR=rel/${C}`,
        `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${home}/.claude`,
      ].join("\n") + "\n");
      return { home, cfg };
    },
    re: /VBCDX_AGENTS_BASE_DIR must be an absolute path/,
  },
  {
    id: "K4",
    what: "a base dir with a dot-dot segment is rejected before any write",
    setup: () => {
      const home = scratch();
      mkdirSync(join(home, ".claude"));
      const cfg = join(home, "cfg.env");
      writeFileSync(cfg, [
        `VBCDX_AGENTS_BASE_DIR=${home}/a/../${C}`,
        `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${home}/.claude`,
      ].join("\n") + "\n");
      return { home, cfg };
    },
    re: /VBCDX_AGENTS_BASE_DIR must not contain '\.\.'/,
  },
  {
    id: "K5",
    what: "a missing claude config dir is rejected before any write",
    setup: () => {
      const home = scratch();
      mkdirSync(join(home, ".claude"));
      const cfg = join(home, "cfg.env");
      writeFileSync(cfg, [`VBCDX_AGENTS_BASE_DIR=${home}/state`].join("\n") + "\n");
      return { home, cfg };
    },
    re: /VBCDX_AGENTS_CLAUDE_CONFIG_DIR is required for claude user scope/,
  },
  {
    id: "K6",
    what: "the reserved workdir key is rejected before any write",
    setup: () => homeWithConfig([`VBCDX_AGENTS_WORKDIR=${C}`]),
    re: /VBCDX_AGENTS_WORKDIR is reserved/,
  },
  {
    id: "K7",
    what: "a non-URL code host is rejected before any write",
    setup: () => homeWithConfig([`VBCDX_AGENTS_CODE_HOST_URL=not a url ${C}`]),
    re: /VBCDX_AGENTS_CODE_HOST_URL must be an absolute HTTP\(S\) URL/,
  },
  {
    id: "K8",
    what: "a non-http code host scheme is rejected before any write",
    setup: () => homeWithConfig([`VBCDX_AGENTS_CODE_HOST_URL=ftp://git.example.test/${C}`]),
    re: /VBCDX_AGENTS_CODE_HOST_URL must use http or https/,
  },
  {
    id: "K9",
    what: "credentials embedded in the code host URL are rejected before any write",
    setup: () => homeWithConfig([`VBCDX_AGENTS_CODE_HOST_URL=https://u:${C}@git.example.test`]),
    re: /VBCDX_AGENTS_CODE_HOST_URL must not embed credentials/,
  },
  {
    id: "K10",
    what: "an empty overlay entry is rejected before any write",
    setup: () => {
      const { home, cfg } = homeWithConfig();
      writeFileSync(cfg, readFileSync(cfg, "utf8") + `VBCDX_AGENTS_OVERLAY_DIRS=${home}/o1::${home}/o2\n`);
      return { home, cfg };
    },
    re: /VBCDX_AGENTS_OVERLAY_DIRS has an empty entry/,
  },
  {
    id: "K11",
    what: "a relative overlay dir is rejected before any write",
    setup: () => homeWithConfig([`VBCDX_AGENTS_OVERLAY_DIRS=rel/${C}`]),
    re: /VBCDX_AGENTS_OVERLAY_DIRS must be an absolute path/,
  },
];

for (const row of rows) {
  test(`S13 s13-v-a2: ${row.id} ${row.what}`, () => {
    const { home, cfg } = row.setup();
    const before = tree(home);
    const r = vbcdx(home, ["install", "agent", "code-agent", "--harness=claude", `--env=${cfg}`, PACK_ARG]);
    assert.equal(r.status, EXIT.CONFIG, r.stderr);
    assert.match(r.stderr, row.re);
    assert.deepEqual(tree(home), before);
    assert.equal((r.stdout + r.stderr).includes(C), false);
  });
}

test("S13 s13-v-a2: CONTROL a valid config installs and writes", () => {
  const { home, cfg } = homeWithConfig();
  const before = tree(home);
  const r = vbcdx(home, ["install", "agent", "code-agent", "--harness=claude", `--env=${cfg}`, PACK_ARG]);
  assert.equal(r.status, 0, r.stderr);
  assert.notDeepEqual(tree(home), before);
});
