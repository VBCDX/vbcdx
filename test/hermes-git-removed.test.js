// Hermes git isn't in this release: the installer gives no role a git credential.
//
// What these tests pin:
//   rule 1  the integrations file's git fields, and the http service that carried them, are
//       refused by name (exit 2, nothing written, no value echoed), never ignored;
//   rule 2  no file any harness renders names a token variable or a terminal passthrough, and a
//       Hermes profile is its three definitions plus, for a web-search role, the plugin;
//   rule 3  the helper is not shipped: not in the package, not in the repository, not exported;
//   rule 4  a profile an earlier version wrote loses the helper, the passthrough and the git
//       section of SOUL.md on the next install, and nothing else of the operator's;
//   rule 5  the documents state the rule without an exception, and say what an upgrade does.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadIntegrations } from "../src/config/integrations.js";
import * as integrationsModule from "../src/config/integrations.js";
import * as hermesModule from "../src/renderers/hermes.js";
import { renderHermes } from "../src/renderers/hermes.js";
import { renderFlat } from "../src/renderers/index.js";
import { boundServiceTools } from "../src/renderers/native.js";
import { classifyHermesConfig, ownedDigest, ownedPaths } from "../src/fs/hermes-config.js";
import { parsePy } from "../src/fs/pyyaml.js";
import { sha256 } from "../src/fs/safe-writer.js";
import { getRole } from "../src/roles/index.js";
import { init } from "../src/index.js";
import { EXIT, InstallerError } from "../src/errors.js";
import { FIXTURE_IDS, PACK_ARG } from "./helpers/fixture-pack.js";

// The integrations file is read only if no one but its owner can change it; pin the umask so
// a host with umask 002 writes the fixtures the same way.
process.umask(0o022);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// A value that must never come back: on stdout, on stderr, in an error or in a written file.
const CANARY = "CANARY-4c81d2-do-not-echo";
const GIT_REFUSAL = "Hermes git isn't in this release";

const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "vbcdx-nogit-"));
  roots.push(d);
  return d;
}
const read = (p) => readFileSync(p, "utf8");

/** Every file under `dir`, relative, sorted. */
function tree(dir) {
  const out = [];
  const walk = (p) => {
    for (const name of readdirSync(p)) {
      const full = join(p, name);
      if (lstatSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

const tool = (name) => ({ name, description: name, inputSchema: {}, outputSchema: {}, effect: "read", required_permissions: [] });
function integrationsFile(services, { contract = "example.tracker/1" } = {}) {
  const dir = scratch();
  const out = {};
  for (const [name, svc] of Object.entries(services)) {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ schema_version: 1, service: name, contract, package_version: "0.1.0", tools: [tool("get_issue"), tool("whoami")] }));
    out[name] = { server_name: name, manifest_file: join(dir, `${name}.json`), ...svc };
  }
  const file = join(dir, "integrations.json");
  writeFileSync(file, JSON.stringify({ schema_version: 1, services: out }));
  chmodSync(file, 0o600);
  return file;
}

function codeAndMessage(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof InstallerError, `expected an InstallerError, got ${err && err.stack}`);
    return { code: err.code, message: err.message };
  }
  return { code: EXIT.OK, message: "" };
}

// The service an earlier version accepted for Hermes git, with a value in every field.
const HTTP = { transport: "http", url: `https://gw.example/mcp/${CANARY}`, roles: ["code-agent"] };
const GIT = { git_url: `https://git.example/${CANARY}`, git_roles: { "code-agent": "fork", "review-agent": "read" } };
const CARRIER = { ...HTTP, roles: ["code-agent", "review-agent"], ...GIT };

// ── rule 1: refused by name ──────────────────────────────────────────────────────

test("rule 1: git_url, git_roles and the http service that carried them are refused by name, exit 2", () => {
  const cases = [
    // The whole carrier, as the earlier README showed it, under either contract.
    [CARRIER, ["tracker.transport", "tracker.url", "tracker.roles", "tracker.git_url", "tracker.git_roles"]],
    [{ ...CARRIER, tool_prefix: "Gw-" }, ["tracker.transport", "tracker.url", "tracker.roles", "tracker.tool_prefix", "tracker.git_url", "tracker.git_roles"]],
    // git_url alone enabled no role; it is refused all the same.
    [{ ...HTTP, git_url: GIT.git_url }, ["tracker.transport", "tracker.url", "tracker.roles", "tracker.git_url"]],
    // Either git field on a service with no http field: on its own, and with an explicit stdio.
    [{ git_url: GIT.git_url }, ["tracker.git_url"]],
    [{ git_roles: GIT.git_roles }, ["tracker.git_roles"]],
    [{ transport: "stdio", ...GIT }, ["tracker.git_url", "tracker.git_roles"]],
    // Any value at all: the fields are refused by name, before a value is looked at.
    [{ git_url: 7, git_roles: CANARY }, ["tracker.git_url", "tracker.git_roles"]],
    [{ git_url: null }, ["tracker.git_url"]],
    [{ ...GIT, stdio: { command: "example-tracker" } }, ["tracker.git_url", "tracker.git_roles"]],
  ];
  for (const contract of ["vbcdx.forgejo/1", "example.tracker/1"]) {
    for (const [svc, fields] of cases) {
      const file = integrationsFile({ tracker: svc }, { contract });
      const { code, message } = codeAndMessage(() => loadIntegrations(file));
      assert.equal(code, EXIT.CONFIG, JSON.stringify(svc));
      assert.equal(message,
        `Integrations file ${file}: ${GIT_REFUSAL}; remove these fields: ${fields.join(", ")}. ` +
        'The installer gives no role a git credential (README, "Hermes git is removed").');
      assert.equal(message.replace(file, "").includes(CANARY), false, "no url, role map or other value in the refusal");
    }
  }
});

test("rule 1: every field of an http service is refused wherever it stands, with or without transport", () => {
  // Without a git field these are the old bearer-token fields: the credential refusal names them.
  for (const [svc, fields] of [
    [HTTP, ["tracker.transport", "tracker.url", "tracker.roles"]],
    [{ url: HTTP.url }, ["tracker.url"]],
    [{ roles: [] }, ["tracker.roles"]],
    [{ tool_prefix: "Gw-" }, ["tracker.tool_prefix"]],
    [{ transport: "stdio", url: HTTP.url, roles: ["code-agent"], tool_prefix: "Gw-" }, ["tracker.url", "tracker.roles", "tracker.tool_prefix"]],
  ]) {
    const file = integrationsFile({ tracker: svc });
    const { code, message } = codeAndMessage(() => loadIntegrations(file));
    assert.equal(code, EXIT.CONFIG, JSON.stringify(svc));
    assert.ok(message.startsWith(`Integrations file ${file}: per-role credentials are no longer read or sent; remove these fields: ${fields.join(", ")}. `), message);
    assert.equal(message.includes(GIT_REFUSAL), false, "no git field: the git refusal is not raised");
    assert.equal(message.replace(file, "").includes(CANARY), false);
  }
  // The only transport left is stdio, stated or not; anything else is not a transport.
  for (const svc of [{}, { transport: "stdio" }]) {
    assert.deepEqual(loadIntegrations(integrationsFile({ tracker: svc })).services.tracker.roles, []);
  }
  for (const transport of ["sse", "HTTP", "", null, 1]) {
    const { code, message } = codeAndMessage(() => loadIntegrations(integrationsFile({ tracker: { transport } })));
    assert.equal(code, EXIT.CONFIG);
    assert.equal(message, 'Service tracker transport must be "stdio".');
  }
});

test("rule 1: one refusal names the credential fields and the git fields of every service", () => {
  const file = integrationsFile({
    alpha: { credentials: { "code-agent": `/abs/${CANARY}.env` } },
    clean: {},
    beta: CARRIER,
    gamma: HTTP,
    delta: { ...CARRIER, headers: { Authorization: `Bearer ${CANARY}` } },
  });
  const { code, message } = codeAndMessage(() => loadIntegrations(file));
  assert.equal(code, EXIT.CONFIG);
  assert.equal(message,
    `Integrations file ${file}: per-role credentials are no longer read or sent; remove these fields: ` +
    "alpha.credentials, gamma.transport, gamma.url, gamma.roles, delta.headers. " +
    'Put each key in Keyhole and grant the tool (README, "How a tool gets its key"). ' +
    `${GIT_REFUSAL}; remove these fields: ` +
    "beta.transport, beta.url, beta.roles, beta.git_url, beta.git_roles, delta.transport, delta.url, delta.roles, delta.git_url, delta.git_roles. " +
    'The installer gives no role a git credential (README, "Hermes git is removed").');
  assert.equal(message.includes("clean."), false);
  assert.equal(message.replace(file, "").includes(CANARY), false);
});

test("rule 1: the refusal comes before anything in the service is read", () => {
  // A manifest that does not exist, a wrong server_name and an unknown field: an accepted
  // service would stop on each. A service with a git field stops on the git field first.
  const dir = scratch();
  const file = join(dir, "integrations.json");
  writeFileSync(file, JSON.stringify({ schema_version: 1, services: {
    tracker: { server_name: "other", manifest_file: join(dir, `${CANARY}.json`), surprise: CANARY, ...CARRIER },
  } }));
  chmodSync(file, 0o600);
  const { code, message } = codeAndMessage(() => loadIntegrations(file));
  assert.equal(code, EXIT.CONFIG);
  assert.match(message, /Hermes git isn't in this release; remove these fields: tracker\.transport, tracker\.url, tracker\.roles, tracker\.git_url, tracker\.git_roles\. /);
  assert.equal(message.includes(CANARY), false);
});

test("rule 1 at the command line: exit 2, nothing written, no value echoed, for every harness", () => {
  const rel = { claude: ".claude", codex: ".codex", opencode: ".config/opencode", hermes: ".hermes" };
  const key = { claude: "VBCDX_AGENTS_CLAUDE_CONFIG_DIR", codex: "VBCDX_AGENTS_CODEX_HOME", opencode: "VBCDX_AGENTS_OPENCODE_CONFIG_DIR", hermes: "VBCDX_AGENTS_HERMES_HOME" };
  for (const harness of Object.keys(rel)) {
    for (const [bin, argv] of [
      ["vbcdx.js", (cfg) => ["install", "agent", "code-agent", `--harness=${harness}`, `--env=${cfg}`, PACK_ARG]],
      ["vbcdx.js", (cfg) => ["install", "agent", "code-agent", `--harness=${harness}`, `--env=${cfg}`, PACK_ARG, "--dry-run"]],
      ["vbcdx-dev-agents.js", (cfg) => ["init", PACK_ARG, `--harness=${harness}`, `--env=${cfg}`, "--agents=code-agent"]],
    ]) {
      const home = scratch();
      mkdirSync(join(home, rel[harness]), { recursive: true });
      const file = integrationsFile({ forgejo: CARRIER }, { contract: "vbcdx.forgejo/1" });
      const cfg = join(home, "cfg.env");
      writeFileSync(cfg, [`VBCDX_AGENTS_BASE_DIR=${home}/state`, `${key[harness]}=${join(home, rel[harness])}`, `VBCDX_AGENTS_INTEGRATIONS_FILE=${file}`].join("\n") + "\n");
      const before = tree(home);
      const r = spawnSync(process.execPath, [join(ROOT, "bin", bin), ...argv(cfg)], {
        encoding: "utf8", cwd: home, timeout: 60000, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home },
      });
      const label = `${harness} ${bin} ${argv(cfg).includes("--dry-run") ? "dry run" : ""}`;
      assert.equal(r.status, EXIT.CONFIG, `${label}: ${r.stderr}`);
      assert.ok(r.stderr.includes(`${GIT_REFUSAL}; remove these fields: forgejo.transport, forgejo.url, forgejo.roles, forgejo.git_url, forgejo.git_roles.`), `${label}: ${r.stderr}`);
      assert.equal((r.stdout + r.stderr).includes(CANARY), false, label);
      assert.deepEqual(tree(home), before, `${label}: nothing was written`);
    }
  }
});

test("rule 1: the names an earlier version reserved for git token keys are ordinary service names again", () => {
  assert.equal("RESERVED_SERVICE_NAMES" in integrationsModule, false);
  for (const name of ["agents", "forgejo-git"]) {
    const { services } = loadIntegrations(integrationsFile({ [name]: {} }));
    assert.deepEqual(Object.keys(services[name]).sort(), ["contract", "manifestFile", "packageVersion", "roles", "serverName", "tools"]);
  }
});

// ── rule 2: nothing rendered names a token or a passthrough ──────────────────────

const TOKEN_KEY = /VBCDX_[A-Z0-9_]*TOKEN/;
const PASSTHROUGH = /env_passthrough/;
const HELPER = /hermes-git/;
function assertNoGit(text, where) {
  assert.doesNotMatch(text, TOKEN_KEY, `${where}: names a token variable`);
  assert.doesNotMatch(text, PASSTHROUGH, `${where}: names a terminal passthrough`);
  assert.doesNotMatch(text, HELPER, `${where}: names the git helper`);
}

// The bindings a role can be rendered with. The last two are what an earlier version's loader
// returned for a git carrier: this version's loader cannot produce them, and a renderer handed
// one must still write nothing for git.
const STDIO = { command: "example-tracker", args: ["mcp"], env: { EXAMPLE_TRACKER_URL: "${EXAMPLE_TRACKER_URL}" } };
const service = (extra = {}) => ({ serverName: "forgejo", contract: "vbcdx.forgejo/1", tools: ["create_comment", "whoami"], roles: [...FIXTURE_IDS], stdio: STDIO, ...extra });
const BINDINGS = {
  "no integrations": undefined,
  "an installed tool": { services: { forgejo: service() } },
  "an earlier loader's fork carrier": { services: { forgejo: service({
    transport: "http", url: "https://gw.example/mcp", toolPrefix: "", gitUrl: "https://git.example",
    gitRoles: Object.fromEntries(FIXTURE_IDS.map((id) => [id, "fork"])),
  }) } },
  "an earlier loader's read carrier": { services: { "forgejo-git": service({
    serverName: "forgejo-git", transport: "http", url: "https://gw.example/mcp", toolPrefix: "", gitUrl: "https://git.example",
    gitRoles: Object.fromEntries(FIXTURE_IDS.map((id) => [id, "read"])),
  }) } },
};
const ROUTING = { baseUrl: "https://llm.example/v1", model: "example-model", roleModels: {} };
const SEARCH = { baseUrl: "https://llm.example.com", tool: "example-search" };

test("rule 2: no rendered file names a token variable, a passthrough or the helper, for any harness, role or binding", () => {
  let scanned = 0;
  for (const [label, integrations] of Object.entries(BINDINGS)) {
    for (const id of FIXTURE_IDS) {
      const base = getRole(id);
      const role = { ...base, descriptor: { ...base.descriptor, remote_capabilities: { "vbcdx.forgejo/1": ["whoami", "create_comment"] } } };
      // The fixture is meaningful: with a service, the role is bound to it.
      assert.equal(boundServiceTools(role.descriptor, integrations).length, integrations ? 1 : 0, `${label} ${id}`);
      for (const harness of ["claude", "codex", "opencode"]) {
        assertNoGit(renderFlat(harness, role, { integrations }).content, `${label} ${harness} ${id}`);
        scanned++;
      }
      for (const opts of [{ integrations }, { integrations, hermes: ROUTING, webSearch: SEARCH }]) {
        const files = renderHermes(role, opts).files;
        const names = files.map((f) => f.name);
        // A profile is its three definitions and, for a web-search role, the plugin's two files.
        const plugin = opts.webSearch && role.descriptor.web_search ? ["plugins/web-litellm-search/plugin.yaml", "plugins/web-litellm-search/__init__.py"] : [];
        assert.deepEqual(names, ["SOUL.md", "profile.yaml", "config.yaml", ...plugin], `${label} ${id}`);
        assert.deepEqual(names.filter((n) => n.startsWith("bin/")), [], `${label} ${id}: nothing under bin/`);
        assert.deepEqual(files.filter((f) => (f.mode & 0o111) !== 0).map((f) => f.name), [], `${label} ${id}: nothing executable`);
        for (const f of files) {
          assertNoGit(f.content, `${label} hermes ${id} ${f.name}`);
          scanned++;
        }
        const config = parsePy(files.find((f) => f.name === "config.yaml").content);
        assert.equal(Object.hasOwn(config, "terminal"), false, `${label} ${id}: no terminal key`);
        assert.equal(ownedPaths(config).some((p) => p[0] === "terminal"), false);
        // The bound service is still rendered: the scan is not passing on an empty profile.
        if (integrations) assert.deepEqual(Object.keys(config.mcp_servers), Object.keys(integrations.services), `${label} ${id}`);
        assert.doesNotMatch(files.find((f) => f.name === "SOUL.md").content, /^## Git/m, `${label} ${id}: no git section`);
      }
    }
  }
  assert.ok(scanned >= FIXTURE_IDS.length * Object.keys(BINDINGS).length * 9, `scanned ${scanned} files`);
});

test("rule 2 on disk: an install for every harness leaves no file that names a token variable or a passthrough", () => {
  const rel = { claude: ".claude", codex: ".codex", opencode: ".config/opencode", hermes: ".hermes" };
  const key = { claude: "VBCDX_AGENTS_CLAUDE_CONFIG_DIR", codex: "VBCDX_AGENTS_CODEX_HOME", opencode: "VBCDX_AGENTS_OPENCODE_CONFIG_DIR", hermes: "VBCDX_AGENTS_HERMES_HOME" };
  for (const harness of Object.keys(rel)) {
    const home = scratch();
    const harnessDir = join(home, rel[harness]);
    mkdirSync(harnessDir, { recursive: true });
    const cfg = join(home, "cfg.env");
    writeFileSync(cfg, [
      `VBCDX_AGENTS_BASE_DIR=${home}/state`, `${key[harness]}=${harnessDir}`,
      ...(harness === "hermes" ? [
        "VBCDX_AGENTS_HERMES_BASE_URL=https://llm.example/v1", "VBCDX_AGENTS_HERMES_MODEL=example-model",
        "VBCDX_AGENTS_HERMES_WEB_SEARCH_URL=https://llm.example.com", "VBCDX_AGENTS_HERMES_WEB_SEARCH_TOOL=example-search",
      ] : []),
    ].join("\n") + "\n");
    const report = init([PACK_ARG, `--harness=${harness}`, `--env=${cfg}`]);
    assert.equal(report.generated.length >= FIXTURE_IDS.length, true, harness);
    const written = tree(harnessDir);
    assert.ok(written.length >= FIXTURE_IDS.length, `${harness}: ${written.length} files`);
    for (const f of written) assertNoGit(read(join(harnessDir, f)), `${harness} ${f}`);
    assert.deepEqual(written.filter((f) => /(^|\/)bin\//.test(f)), [], `${harness}: nothing under a bin/ directory`);
    assert.deepEqual(written.filter((f) => (lstatSync(join(harnessDir, f)).mode & 0o111) !== 0), [], `${harness}: nothing executable`);
    assertNoGit(read(join(home, "state", "manifests", "installation.json")), `${harness} manifest`);
  }
});

// ── rule 3: the helper is not shipped ────────────────────────────────────────────

test("rule 3: the git helper is in no package file, and nothing exports its renderer or its key names", () => {
  assert.equal(existsSync(join(ROOT, "assets", "hermes", "hermes-git.py")), false);
  assert.deepEqual(readdirSync(join(ROOT, "assets", "hermes")), ["plugins"]);
  const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const files = JSON.parse(r.stdout)[0].files.map((f) => f.path);
  // The listing is the real one: it holds what the package is known to ship.
  for (const expected of ["src/renderers/hermes.js", "assets/hermes/plugins/web-litellm-search/__init__.py", "README.md"]) {
    assert.ok(files.includes(expected), `${expected} is packed`);
  }
  assert.deepEqual(files.filter((f) => /hermes-git|git\.py$/.test(f)), []);
  // No packed program carries the helper's parts: its placeholders, its key names or a credential helper.
  const parts = /@@FORGEJO_URL@@|@@GIT_MODE@@|@@TOKEN_ENV@@|VBCDX_FORGEJO_GIT_TOKEN|credential\.helper|git-receive-pack/;
  for (const f of files.filter((p) => /^(src|bin|assets)\//.test(p))) {
    assert.doesNotMatch(read(join(ROOT, f)), parts, f);
    assert.doesNotMatch(read(join(ROOT, f)), HELPER, f);
  }
  for (const name of ["hermesGit", "renderHermesGit", "hermesGitNote", "hermesServiceTokenEnv", "hermesHttpTokenEnv", "HERMES_GIT_READ_TOKEN_ENV", "HERMES_GIT_SCOPE_ENV", "HERMES_GIT_READ_SCOPE"]) {
    assert.equal(name in hermesModule, false, name);
  }
  for (const name of ["FORGEJO_CONTRACT", "isCleartextOffHost"]) assert.equal(name in integrationsModule, false, name);
});

// ── rule 4: a profile an earlier version wrote ───────────────────────────────────

const GIT_SECTION = [
  "", "## Git: clone, and pull requests from your fork", "",
  'Clone: `python3 "$HERMES_HOME/bin/hermes-git" clone OWNER/REPO`.', "",
].join("\n");

/**
 * A Hermes install by this version, then changed into what version 0.2.14 left for a git
 * role: `terminal.env_passthrough` in config.yaml as an owned path, `bin/hermes-git` as a
 * recorded file, and a git section at the end of SOUL.md. The records are the shapes that
 * version wrote (an entry per file with its digest; config.yaml with owned_paths and
 * owned_digest).
 */
function earlierInstall({ roles = ["code-agent"], keys = ["VBCDX_FORGEJO_TOKEN"], terminalExtra = "" } = {}) {
  const root = scratch();
  const cfg = join(root, "config.env");
  writeFileSync(cfg, [`VBCDX_AGENTS_BASE_DIR=${root}/state`, `VBCDX_AGENTS_HERMES_HOME=${root}/hermes`].join("\n") + "\n");
  const args = (more = []) => [PACK_ARG, "--harness=hermes", `--env=${cfg}`, `--agents=${roles.join(",")}`, ...more];
  init(args());
  const manifestPath = join(root, "state", "manifests", "installation.json");
  const manifest = JSON.parse(read(manifestPath));
  const prof = (id) => join(root, "hermes", "profiles", id);
  const helper = (id) => join(prof(id), "bin", "hermes-git");
  for (const id of roles) {
    const conf = join(prof(id), "config.yaml");
    const text = read(conf) + `terminal:\n${terminalExtra}  env_passthrough:\n${keys.map((k) => `    - ${k}\n`).join("")}`;
    writeFileSync(conf, text);
    const rec = manifest.files[conf];
    rec.owned_paths = [...rec.owned_paths, ["terminal", "env_passthrough"]];
    rec.owned_digest = ownedDigest(parsePy(text), rec.owned_paths);
    rec.digest = sha256(Buffer.from(text));
    mkdirSync(dirname(helper(id)));
    const script = `#!/usr/bin/env python3\n# the helper version 0.2.14 wrote for ${id}\n`;
    writeFileSync(helper(id), script, { mode: 0o755 });
    manifest.files[helper(id)] = { digest: sha256(Buffer.from(script)), mode: 0o755, role: id, harness: "hermes", package_version: "0.2.14", written_at: rec.written_at };
    const soul = join(prof(id), "SOUL.md");
    writeFileSync(soul, read(soul) + GIT_SECTION);
    manifest.files[soul].digest = sha256(readFileSync(soul));
    // The operator's own file, with the token: never the installer's.
    writeFileSync(join(prof(id), ".env"), `${keys[0]}=${CANARY}\n`, { mode: 0o600 });
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { root, cfg, args, prof, helper, manifest: () => JSON.parse(read(manifestPath)) };
}

test("rule 4: the next install removes the helper, the passthrough and the git section a previous version wrote", () => {
  const e = earlierInstall({ roles: ["code-agent", "review-agent"], keys: ["VBCDX_FORGEJO_GIT_TOKEN", "VBCDX_FORGEJO_GIT_TOKEN_SCOPE"] });
  // The starting point is the earlier state: each thing this test says goes is there.
  for (const id of ["code-agent", "review-agent"]) {
    assert.ok(existsSync(e.helper(id)));
    assert.match(read(join(e.prof(id), "config.yaml")), PASSTHROUGH);
    assert.match(read(join(e.prof(id), "SOUL.md")), HELPER);
  }
  // A dry run says what will happen and changes nothing.
  const dry = init(e.args(["--dry-run"]));
  assert.deepEqual(dry.removals, ["code-agent", "review-agent"].map((id) => ({ role: id, destination: e.helper(id), action: "remove" })));
  assert.deepEqual(dry.conflicts, []);
  assert.ok(existsSync(e.helper("code-agent")));

  const report = init(e.args());
  assert.deepEqual(report.removals, ["code-agent", "review-agent"].map((id) => ({ role: id, destination: e.helper(id), action: "remove" })));
  const m = e.manifest();
  for (const id of ["code-agent", "review-agent"]) {
    const action = (name) => report.generated.find((g) => g.destination === join(e.prof(id), name)).action;
    assert.deepEqual([action("SOUL.md"), action("profile.yaml"), action("config.yaml")], ["update", "noop", "update"], id);
    assert.equal(existsSync(e.helper(id)), false, `${id}: the helper is deleted`);
    assert.equal(Object.hasOwn(m.files, e.helper(id)), false, `${id}: and its record`);
    const confText = read(join(e.prof(id), "config.yaml"));
    assertNoGit(confText, `${id} config.yaml`);
    const conf = parsePy(confText);
    assert.equal(Object.hasOwn(conf, "terminal"), false, `${id}: the emptied terminal map goes too`);
    assert.ok(conf.platform_toolsets && conf.agent.disabled_toolsets, `${id}: the rest of the profile is kept`);
    assert.deepEqual(m.files[join(e.prof(id), "config.yaml")].owned_paths, [["platform_toolsets"], ["agent", "disabled_toolsets"]]);
    const soul = read(join(e.prof(id), "SOUL.md"));
    assertNoGit(soul, `${id} SOUL.md`);
    assert.doesNotMatch(soul, /^## Git/m);
    assert.equal(soul, renderHermes(getRole(id)).files.find((f) => f.name === "SOUL.md").content);
    // The token is the operator's: the file is not opened, changed or removed.
    assert.equal(read(join(e.prof(id), ".env")), `VBCDX_FORGEJO_GIT_TOKEN=${CANARY}\n`, `${id}: .env untouched`);
    assert.equal(lstatSync(join(e.prof(id), ".env")).mode & 0o777, 0o600);
  }
  assertNoGit(JSON.stringify(m), "the manifest");
  // And it is done: a rerun changes nothing.
  const again = init(e.args());
  assert.deepEqual(again.removals, []);
  assert.ok(again.generated.every((g) => g.action === "noop"));
});

test("rule 4: the operator's own terminal settings stay; only the passthrough the installer wrote goes", () => {
  const e = earlierInstall({ terminalExtra: "  backend: docker\n" });
  init(e.args());
  const conf = parsePy(read(join(e.prof("code-agent"), "config.yaml")));
  assert.deepEqual(conf.terminal, { backend: "docker" });
  assert.equal(existsSync(e.helper("code-agent")), false);
});

test("rule 4: a helper or a passthrough the operator edited is kept and reported; --force removes it", () => {
  for (const edit of ["helper", "passthrough"]) {
    const e = earlierInstall();
    const helper = e.helper("code-agent");
    const conf = join(e.prof("code-agent"), "config.yaml");
    if (edit === "helper") writeFileSync(helper, read(helper) + "# operator tweak\n");
    else writeFileSync(conf, read(conf) + "    - MY_OWN_KEY\n");
    const before = { helper: read(helper), conf: read(conf), soul: read(join(e.prof("code-agent"), "SOUL.md")) };
    const { code, message } = codeAndMessage(() => init(e.args()));
    assert.equal(code, EXIT.CONFLICT, `${edit}: ${message}`);
    assert.match(message, /nothing was written/);
    assert.ok(message.includes(edit === "helper" ? helper : conf), message);
    assert.equal(message.includes(CANARY), false);
    assert.deepEqual({ helper: read(helper), conf: read(conf), soul: read(join(e.prof("code-agent"), "SOUL.md")) }, before, `${edit}: nothing changed`);

    init(e.args(["--force"]));
    assert.equal(existsSync(helper), false, edit);
    assertNoGit(read(conf), `${edit}: config.yaml after --force`);
    assert.equal(Object.hasOwn(parsePy(read(conf)), "terminal"), false);
    assert.equal(read(join(e.prof("code-agent"), ".env")), `VBCDX_FORGEJO_TOKEN=${CANARY}\n`);
  }
});

// ── rule 5: the documents ────────────────────────────────────────────────────────

test("rule 5: the README and docs/security.md state the rule without an exception and say what an upgrade does", () => {
  const readme = read(join(ROOT, "README.md"));
  const security = read(join(ROOT, "docs", "security.md"));
  for (const [name, text] of [["README.md", readme], ["docs/security.md", security]]) {
    assert.doesNotMatch(text, /[Oo]ne exception|one key path outside|a later release removes it/, name);
    assert.doesNotMatch(text, /"git_url"|"git_roles"|"transport": "http",/, `${name}: no example to copy`);
  }
  assert.match(security, /This is the only way a tool gets a key from Keyhole\./);
  assert.match(security, /the installer gives no role a credential, for git or for\s+any other tool/);
  // The one rendered tool that uses a key the installer doesn't manage is named, with where the key goes.
  assert.match(security, /One rendered tool uses a key that the installer doesn't manage: \*\*Hermes web search\*\*/);
  assert.match(security, /HERMES_PROVIDER_API_KEY/);
  assert.match(security, /only to\s+the configured search gateway \(`VBCDX_AGENTS_HERMES_WEB_SEARCH_URL`\)/);
  assert.match(security, /It refuses redirects/);
  // No absolute claim the code doesn't back.
  assert.doesNotMatch(security, /No tool gets a key any other way/);
  assert.doesNotMatch(security, /This is the only way a tool gets its key\./);
  assert.doesNotMatch(security, /hermes-git|env_passthrough|git_url|git_roles/);
  // The README names the removed parts in one place only: the upgrade note.
  const start = readme.indexOf("#### Hermes git is removed");
  assert.ok(start > readme.indexOf("### Upgrading from 0.2.14 or earlier"), "the note sits in the upgrade section");
  const end = readme.indexOf("\n## ", start);
  const note = readme.slice(start, end);
  for (const part of ["`hermes-git`", "`terminal.env_passthrough`", "`SOUL.md`", "`git_url`", "`git_roles`", "exit 2", "`.env`", "Revoke the token at the git host", "`.git/config`", "It does not touch"]) {
    assert.ok(note.includes(part), `the upgrade note names ${part}`);
  }
  // (A link to the note carries the helper's name in its anchor; that is the note, not a use.)
  const rest = (readme.slice(0, start) + readme.slice(end)).replaceAll("(#hermes-git-is-removed)", "");
  assert.deepEqual(rest.split("\n").filter((l) => /hermes-git|env_passthrough|VBCDX_FORGEJO_GIT_TOKEN|Git for roles/.test(l)), []);
  // Outside the note, git_url and git_roles appear only as fields that are refused.
  for (const line of rest.split("\n").filter((l) => /git_url|git_roles/.test(l))) {
    assert.match(line, /stops \(exit 2\)|^`git_url` or `git_roles`: see /, line);
  }
  const example = read(join(ROOT, ".env.example"));
  assert.doesNotMatch(example, /VBCDX_[A-Z0-9_]*TOKEN|git_roles|git_url|read:repository/);
});

// ── the config classifier's remaining arms ───────────────────────────────────────

// hermes-config.js 171: a profile config.yaml that is absent but was recorded is a repair
// (the installer wrote it once), not a first install.
test("classify: an absent config.yaml with a recorded digest is a repair", () => {
  const profile = join(scratch(), "config.yaml");
  const rendered = "model:\n  default: example\n";
  const report = classifyHermesConfig(profile, rendered, { digest: sha256(Buffer.from("recorded once")) });
  assert.equal(report.cls, "repair");
  assert.equal(report.content, rendered);
});

// hermes-config.js 176: a file that parses but is not a mapping has no `why`, so the fallback
// names the requirement and the whole-file consequence of --force.
test("classify: a config.yaml that parses to a sequence is a mapping conflict", () => {
  const profile = join(scratch(), "config.yaml");
  writeFileSync(profile, "- 1\n");
  const report = classifyHermesConfig(profile, "model:\n  default: example\n", undefined);
  assert.equal(report.cls, "conflict");
  assert.match(report.note, /^is not a YAML mapping; --force replaces the whole file, dropping every key the installer does not own/);
});

// hermes-config.js 207-213: a manifest entry from before key-level ownership records only the
// whole file's digest; a file edited after that digest was taken is not ours, so it conflicts.
test("classify: a legacy whole-file digest no longer matching the file is a conflict", () => {
  const profile = join(scratch(), "config.yaml");
  const onDisk = "model:\n  default: old\nkeep: 1\n";
  const recorded = sha256(Buffer.from(onDisk));
  writeFileSync(profile, onDisk + "later: 2\n");
  const report = classifyHermesConfig(profile, "model:\n  default: example\n", { digest: recorded });
  assert.equal(report.cls, "conflict");
  assert.equal(report.note, "not recorded as written by the installer; --force replaces the owned keys and keeps the others");
});
