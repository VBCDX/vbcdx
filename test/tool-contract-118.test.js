// Tools bind to roles by contract, and a service may have any name.
// A role allows tools under the contract key of its descriptor's remote_capabilities;
// a descriptor keyed by server name (packs before contracts) still binds that server.
// An unknown contract reaches no role.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_PACK_DIR } from "./helpers/fixture-pack.js";
import { readPack } from "../src/packs/load.js";
import { loadIntegrations, FORGEJO_CONTRACT } from "../src/config/integrations.js";
import { boundServiceTools } from "../src/renderers/native.js";
import { renderHermes, renderHermesMcpServers, hermesServiceTokenEnv, hermesHttpTokenEnv, hermesGit } from "../src/renderers/hermes.js";
import { buildPlan } from "../src/planner.js";
import { parseInitArgs } from "../src/cli/args.js";
import { parseEnvFile } from "../src/config/env-parser.js";
import { buildAgentCard } from "../src/a2a/card.js";
import { getRole } from "../src/roles/index.js";
import { EXIT } from "../src/errors.js";
import { installedToolBindings } from "../src/install/commands.js";

const roots = [];
const scratch = () => { const d = mkdtempSync(join(tmpdir(), "vbcdx-contract-")); roots.push(d); return d; };
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const tool = (name, effect = "read") => ({ name, description: name, inputSchema: {}, outputSchema: {}, effect, required_permissions: [] });
const manifest = (service, contract, names) => ({ schema_version: 1, service, contract, package_version: "1.0.0", tools: [...names].sort().map((n) => tool(n)) });

function writeIntegrations(dir, services) {
  const out = {};
  for (const [name, { contract, tools, ...rest }] of Object.entries(services)) {
    const mf = join(dir, `${name}.json`);
    writeFileSync(mf, JSON.stringify(manifest(name, contract, tools)));
    out[name] = { server_name: name, manifest_file: mf, ...rest };
  }
  const f = join(dir, "integrations.json");
  writeFileSync(f, JSON.stringify({ schema_version: 1, services: out }));
  return f;
}

const descriptor = (id, remote) => ({ id, remote_capabilities: remote });

test("a third-party service loads under any well-formed name and keeps its contract", () => {
  const d = scratch();
  const res = loadIntegrations(writeIntegrations(d, {
    tracker: { contract: "example.tracker/1", tools: ["list_tickets", "close_ticket"], transport: "http", url: "https://tracker.example/mcp", roles: ["code-agent"] },
  }));
  assert.equal(res.services.tracker.contract, "example.tracker/1");
  assert.deepEqual(res.services.tracker.tools, ["close_ticket", "list_tickets"]);
});

test("a role allows tools by contract: the server name doesn't matter", () => {
  const d = scratch();
  const integ = loadIntegrations(writeIntegrations(d, {
    git: { contract: FORGEJO_CONTRACT, tools: ["whoami", "create_comment", "merge_pull_request"], transport: "http", url: "https://mcp.example/forgejo", roles: ["code-agent"] },
  }));
  const role = descriptor("code-agent", { [FORGEJO_CONTRACT]: ["whoami", "create_comment"] });
  const [b] = boundServiceTools(role, integ);
  assert.equal(b.server, "git");
  assert.equal(b.contract, FORGEJO_CONTRACT);
  assert.deepEqual(b.tools, ["create_comment", "whoami"]); // merge_pull_request is not in the role's list
});

test("a descriptor keyed by server name still binds that server (packs before contracts)", () => {
  const d = scratch();
  const integ = loadIntegrations(writeIntegrations(d, {
    forgejo: { contract: FORGEJO_CONTRACT, tools: ["whoami"], transport: "http", url: "https://mcp.example/forgejo", roles: ["code-agent"] },
  }));
  assert.deepEqual(boundServiceTools(descriptor("code-agent", { forgejo: ["whoami"] }), integ).map((b) => b.server), ["forgejo"]);
});

test("an unknown contract binds to no role, even one listing the same tool names under another contract", () => {
  const d = scratch();
  const integ = loadIntegrations(writeIntegrations(d, {
    tracker: { contract: "example.tracker/1", tools: ["whoami"], transport: "http", url: "https://tracker.example/mcp", roles: ["code-agent"] },
  }));
  assert.deepEqual(boundServiceTools(descriptor("code-agent", { [FORGEJO_CONTRACT]: ["whoami"] }), integ), []);
  assert.equal(boundServiceTools(descriptor("code-agent", { "example.tracker/1": ["whoami"] }), integ).length, 1);
});

test("an http tool's bearer header comes from VBCDX_<SERVER>_TOKEN, so the bundled names are unchanged", () => {
  assert.equal(hermesHttpTokenEnv("forgejo"), "VBCDX_FORGEJO_TOKEN");
  assert.equal(hermesHttpTokenEnv("coolify"), "VBCDX_COOLIFY_TOKEN");
  assert.equal(hermesHttpTokenEnv("my-tracker"), "VBCDX_MY_TRACKER_TOKEN");
  const servers = renderHermesMcpServers([
    { server: "my-tracker", contract: "example.tracker/1", transport: "http", url: "https://t.example/mcp", toolPrefix: "", tools: ["list"] },
  ]);
  assert.deepEqual(servers["my-tracker"].headers, { Authorization: "Bearer ${VBCDX_MY_TRACKER_TOKEN}" });
});

test("git_url follows the Forgejo contract, not the name forgejo", () => {
  const d = scratch();
  const ok = loadIntegrations(writeIntegrations(d, {
    git: { contract: FORGEJO_CONTRACT, tools: ["whoami"], transport: "http", url: "https://mcp.example/forgejo", roles: ["code-agent"], git_url: "https://git.example", git_roles: { "code-agent": "fork" } },
  }));
  assert.equal(ok.services.git.gitUrl, "https://git.example");
  const role = descriptor("code-agent", { [FORGEJO_CONTRACT]: ["whoami"] });
  const g = hermesGit(boundServiceTools(role, ok));
  assert.equal(g.tokenEnv, "VBCDX_GIT_TOKEN"); // the fork token is the binding's own key
  // The rendered helper pushes with that key, not the one a service named "forgejo" gets.
  const base = getRole("code-agent");
  const rendered = renderHermes({ ...base, descriptor: { ...base.descriptor, remote_capabilities: { [FORGEJO_CONTRACT]: ["whoami"] } } }, { integrations: ok });
  const helper = rendered.files.find((f) => f.name === "bin/hermes-git");
  assert.ok(helper, "a fork-mode Forgejo binding renders bin/hermes-git");
  assert.match(helper.content, /VBCDX_GIT_TOKEN/);
  assert.doesNotMatch(helper.content, /VBCDX_FORGEJO_TOKEN/);
  const d2 = scratch();
  assert.throws(() => loadIntegrations(writeIntegrations(d2, {
    forgejo: { contract: "example.tracker/1", tools: ["whoami"], transport: "http", url: "https://t.example/mcp", roles: ["code-agent"], git_url: "https://git.example" },
  })), /git_url is only valid for a vbcdx\.forgejo\/1 service/);
  // A read role's token is the read-scoped key, whatever the service is called.
  assert.equal(hermesServiceTokenEnv({ server: "git", contract: FORGEJO_CONTRACT, gitMode: "read" }), "VBCDX_FORGEJO_GIT_TOKEN");
});

test("an external credential file needs USER for the Forgejo contract and only TOKEN for any other", () => {
  const d = scratch();
  const creds = join(d, "creds");
  const tokenOnly = join(d, "code-agent.env");
  writeFileSync(tokenOnly, 'VBCDX_AGENTS_ROLE="code-agent"\nVBCDX_AGENTS_TOKEN="t"\n');
  const cfgFor = (integ) => {
    const cfg = join(d, `cfg-${roots.length}-${Math.random().toString(36).slice(2)}.env`);
    writeFileSync(cfg, [`VBCDX_AGENTS_BASE_DIR=${d}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${creds}`,
      `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${d}/claude`, `VBCDX_AGENTS_INTEGRATIONS_FILE=${integ}`, ""].join("\n"));
    return cfg;
  };
  const plan = (integ) => { const cfg = cfgFor(integ); return buildPlan(parseInitArgs(["--harness=claude", "--env=" + cfg, "--agents=code-agent"]), parseEnvFile(cfg)); };
  const other = writeIntegrations(join(d), { tracker: { contract: "example.tracker/1", tools: ["list"], credentials: { "code-agent": tokenOnly } } });
  assert.ok(plan(other), "a token-only file satisfies a non-Forgejo contract");
  const d2 = scratch();
  const forgejo = writeIntegrations(d2, { forgejo: { contract: FORGEJO_CONTRACT, tools: ["whoami"], credentials: { "code-agent": tokenOnly } } });
  assert.throws(() => plan(forgejo), (err) => {
    assert.equal(err.code, EXIT.CREDENTIAL, err.message);
    assert.match(err.message, /credential_key_missing/);
    return true;
  });
});

test("an agent card tags a contract-keyed role the same as a name-keyed one", () => {
  const role = getRole("code-agent");
  const byName = buildAgentCard(role, { baseUrl: "https://agents.example" });
  const byContract = buildAgentCard({ ...role, descriptor: { ...role.descriptor, remote_capabilities: { [FORGEJO_CONTRACT]: ["whoami"] } } }, { baseUrl: "https://agents.example" });
  assert.deepEqual(byContract.skills[0].tags, byName.skills[0].tags);
  assert.ok(byContract.skills[0].tags.includes("code-host"));
});

test("a tool installed with `vbcdx install tool` binds by the contract its manifest reported", () => {
  const ctx = { harness: "claude", scope: "user", config: { harnessRoot: "/h", credentialsDir: "/c" } };
  const record = (server_name, contract) => ({ server_name, contract, tools: ["list"], credential_file: null, launch: { command: "x", args: [] }, env: [] });
  const manifest = { tools: { "claude:user:/h:tracker": record("tracker", "example.tracker/1"), "claude:user:/h:legacy": record("legacy", undefined) } };
  const integ = installedToolBindings(ctx, manifest, ["code-agent"]);
  assert.equal(integ.services.tracker.contract, "example.tracker/1");
  assert.equal(integ.services.legacy.contract, null, "a record from before contracts were kept has none");
  const byContract = descriptor("code-agent", { "example.tracker/1": ["list"], legacy: ["list"] });
  assert.deepEqual(boundServiceTools(byContract, integ).map((b) => b.server).sort(), ["legacy", "tracker"]);
  assert.deepEqual(boundServiceTools(descriptor("code-agent", { [FORGEJO_CONTRACT]: ["list"] }), integ), []);
});

// ── A pack can declare contract keys; own keys only; reserved token keys ──

function packWithCodeAgentRemote(remote, { contracts } = {}) {
  const dir = join(scratch(), "pack");
  cpSync(FIXTURE_PACK_DIR, dir, { recursive: true });
  const rolePath = join(dir, "assets", "roles", "code-agent", "role.json");
  const role = JSON.parse(readFileSync(rolePath, "utf8"));
  writeFileSync(rolePath, JSON.stringify({ ...role, remote_capabilities: remote }));
  if (contracts) {
    const declPath = join(dir, "vbcdx-pack.json");
    writeFileSync(declPath, JSON.stringify({ ...JSON.parse(readFileSync(declPath, "utf8")), contracts }));
  }
  return dir;
}

test("a pack's role.json may key remote_capabilities by contract, and readPack's role binds by it", () => {
  const pack = readPack(packWithCodeAgentRemote({ [FORGEJO_CONTRACT]: ["whoami", "create_comment"] }));
  const role = pack.roles.find((r) => r.id === "code-agent");
  const d = scratch();
  const integ = loadIntegrations(writeIntegrations(d, {
    git: { contract: FORGEJO_CONTRACT, tools: ["whoami", "create_comment", "merge_pull_request"], transport: "http", url: "https://mcp.example/forgejo", roles: ["code-agent"] },
  }));
  const [b] = boundServiceTools(role.descriptor, integ);
  assert.equal(b.server, "git");
  assert.deepEqual(b.tools, ["create_comment", "whoami"]);
});

test("a contract key must be well formed and listed in the pack's contracts", () => {
  assert.throws(() => readPack(packWithCodeAgentRemote({ "example.tracker/1": ["list"] })),
    /role code-agent: remote_capabilities names contract example\.tracker\/1, which the pack does not list in contracts/);
  assert.ok(readPack(packWithCodeAgentRemote({ "example.tracker/1": ["list"] }, { contracts: ["example.tracker/1", FORGEJO_CONTRACT, "vbcdx.coolify/1"] })));
  for (const bad of ["Vbcdx.forgejo/1", "vbcdx.forgejo/0", "vbcdx.forgejo", "-x/1"]) {
    assert.throws(() => readPack(packWithCodeAgentRemote({ [bad]: ["whoami"] })), /is not a service name or a contract/, bad);
  }
});

test("a service called constructor binds nothing it isn't granted and tags nothing", () => {
  const d = scratch();
  const integ = loadIntegrations(writeIntegrations(d, {
    constructor: { contract: "example.tracker/1", tools: ["list"], transport: "http", url: "https://t.example/mcp", roles: ["code-agent"] },
  }));
  assert.deepEqual(boundServiceTools(descriptor("code-agent", { [FORGEJO_CONTRACT]: ["whoami"] }), integ), []);
  assert.deepEqual(boundServiceTools(descriptor("code-agent", { constructor: ["list"] }), integ).map((b) => b.tools), [["list"]]);
  const role = getRole("code-agent");
  const card = buildAgentCard({ ...role, descriptor: { ...role.descriptor, remote_capabilities: { constructor: ["list"] } } }, { baseUrl: "https://agents.example" });
  assert.ok(card.skills[0].tags.every((t) => typeof t === "string"));
});

test("a service name whose token key is taken is refused", () => {
  for (const name of ["forgejo-git", "agents"]) {
    const d = scratch();
    assert.throws(() => loadIntegrations(writeIntegrations(d, {
      [name]: { contract: "example.tracker/1", tools: ["list"], transport: "http", url: "https://t.example/mcp", roles: ["code-agent"] },
    })), new RegExp(`Service name "${name}" in integrations file is reserved`), name);
  }
  // A near name is fine and gets its own key.
  assert.equal(hermesHttpTokenEnv("forgejo-git2"), "VBCDX_FORGEJO_GIT2_TOKEN");
});
