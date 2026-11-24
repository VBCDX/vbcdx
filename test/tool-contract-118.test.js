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
import { loadIntegrations } from "../src/config/integrations.js";
import { boundServiceTools } from "../src/renderers/native.js";
import { buildAgentCard } from "../src/a2a/card.js";
import { getRole } from "../src/roles/index.js";
import { installedToolBindings } from "../src/install/commands.js";

// The integrations file is read only if no one but its owner can change it (and its
// directory too), and these tests write theirs with the default mode. Pin the umask a
// CI runner has, so a host whose umask is 002 (user private groups) runs them the same.
process.umask(0o022);

// A contract a pack may name. Nothing in the installer treats it differently from any other.
const FORGEJO_CONTRACT = "vbcdx.forgejo/1";

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

// Bindings as `vbcdx install tool` records them: the only way a role is bound to a tool. (The
// integrations file binds none: it carries no roles list for a tool, and no credentials map.)
function installed(services, roleIds = ["code-agent"]) {
  const ctx = { harness: "claude", scope: "user", config: { harnessRoot: "/h" } };
  const tools = Object.fromEntries(Object.entries(services).map(([name, { contract, tools: names }]) => [
    `claude:user:/h:${name}`, { server_name: name, contract, tools: [...names].sort(), launch: { command: "x", args: [] }, env: [] },
  ]));
  return installedToolBindings(ctx, { tools }, roleIds);
}

test("a third-party service loads under any well-formed name and keeps its contract", () => {
  const d = scratch();
  const res = loadIntegrations(writeIntegrations(d, {
    tracker: { contract: "example.tracker/1", tools: ["list_tickets", "close_ticket"] },
  }));
  assert.equal(res.services.tracker.contract, "example.tracker/1");
  assert.deepEqual(res.services.tracker.tools, ["close_ticket", "list_tickets"]);
  // ...and the file binds no role to it, whatever the role's allowlist says.
  assert.deepEqual(boundServiceTools(descriptor("code-agent", { "example.tracker/1": ["list_tickets"] }), res), []);
});

test("a role allows tools by contract: the server name doesn't matter", () => {
  const integ = installed({ git: { contract: FORGEJO_CONTRACT, tools: ["whoami", "create_comment", "merge_pull_request"] } });
  const role = descriptor("code-agent", { [FORGEJO_CONTRACT]: ["whoami", "create_comment"] });
  const [b] = boundServiceTools(role, integ);
  assert.equal(b.server, "git");
  assert.equal(b.contract, FORGEJO_CONTRACT);
  assert.deepEqual(b.tools, ["create_comment", "whoami"]); // merge_pull_request is not in the role's list
});

test("a descriptor keyed by server name still binds that server (packs before contracts)", () => {
  const integ = installed({ forgejo: { contract: FORGEJO_CONTRACT, tools: ["whoami"] } });
  assert.deepEqual(boundServiceTools(descriptor("code-agent", { forgejo: ["whoami"] }), integ).map((b) => b.server), ["forgejo"]);
});

test("an unknown contract binds to no role, even one listing the same tool names under another contract", () => {
  const integ = installed({ tracker: { contract: "example.tracker/1", tools: ["whoami"] } });
  assert.deepEqual(boundServiceTools(descriptor("code-agent", { [FORGEJO_CONTRACT]: ["whoami"] }), integ), []);
  assert.equal(boundServiceTools(descriptor("code-agent", { "example.tracker/1": ["whoami"] }), integ).length, 1);
});

test("an agent card tags a contract-keyed role the same as a name-keyed one", () => {
  const role = getRole("code-agent");
  const byName = buildAgentCard(role, { baseUrl: "https://agents.example" });
  const byContract = buildAgentCard({ ...role, descriptor: { ...role.descriptor, remote_capabilities: { [FORGEJO_CONTRACT]: ["whoami"] } } }, { baseUrl: "https://agents.example" });
  assert.deepEqual(byContract.skills[0].tags, byName.skills[0].tags);
  assert.ok(byContract.skills[0].tags.includes("code-host"));
});

test("a tool installed with `vbcdx install tool` binds by the contract its manifest reported", () => {
  const ctx = { harness: "claude", scope: "user", config: { harnessRoot: "/h" } };
  const record = (server_name, contract) => ({ server_name, contract, tools: ["list"], launch: { command: "x", args: [] }, env: [] });
  const manifest = { tools: { "claude:user:/h:tracker": record("tracker", "example.tracker/1"), "claude:user:/h:legacy": record("legacy", undefined) } };
  const integ = installedToolBindings(ctx, manifest, ["code-agent"]);
  assert.equal(integ.services.tracker.contract, "example.tracker/1");
  assert.equal(integ.services.legacy.contract, null, "a record from before contracts were kept has none");
  const byContract = descriptor("code-agent", { "example.tracker/1": ["list"], legacy: ["list"] });
  assert.deepEqual(boundServiceTools(byContract, integ).map((b) => b.server).sort(), ["legacy", "tracker"]);
  assert.deepEqual(boundServiceTools(descriptor("code-agent", { [FORGEJO_CONTRACT]: ["list"] }), integ), []);
});

// ── A pack can declare contract keys; own keys only ──

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
  const integ = installed({ git: { contract: FORGEJO_CONTRACT, tools: ["whoami", "create_comment", "merge_pull_request"] } });
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
  // The name is accepted in the integrations file too.
  assert.equal(loadIntegrations(writeIntegrations(scratch(), { constructor: { contract: "example.tracker/1", tools: ["list"] } })).services.constructor.contract, "example.tracker/1");
  const integ = installed({ constructor: { contract: "example.tracker/1", tools: ["list"] } });
  assert.deepEqual(boundServiceTools(descriptor("code-agent", { [FORGEJO_CONTRACT]: ["whoami"] }), integ), []);
  assert.deepEqual(boundServiceTools(descriptor("code-agent", { constructor: ["list"] }), integ).map((b) => b.tools), [["list"]]);
  const role = getRole("code-agent");
  const card = buildAgentCard({ ...role, descriptor: { ...role.descriptor, remote_capabilities: { constructor: ["list"] } } }, { baseUrl: "https://agents.example" });
  assert.ok(card.skills[0].tags.every((t) => typeof t === "string"));
});
