import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIntegrations, validateManifest } from "../src/config/integrations.js";
import { FIXTURE_IDS, PACK_ARG } from "./helpers/fixture-pack.js";

function scratch() {
  return mkdtempSync(join(tmpdir(), "vbcdx-int-"));
}

function forgejoManifest(overrides = {}) {
  return {
    schema_version: 1,
    service: "forgejo",
    contract: "vbcdx.forgejo/1",
    package_version: "1.0.0",
    tools: [
      { name: "create_comment", description: "d", inputSchema: {}, outputSchema: {}, effect: "write", required_permissions: ["write:issue"] },
      { name: "whoami", description: "d", inputSchema: {}, outputSchema: {}, effect: "read", required_permissions: ["read:user"] },
    ],
    ...overrides,
  };
}

test("validateManifest accepts a well-formed sorted manifest", () => {
  const names = validateManifest(forgejoManifest(), "forgejo", "m.json");
  assert.deepEqual(names, ["create_comment", "whoami"]);
});

test("validateManifest rejects an unsorted tools array", () => {
  const m = forgejoManifest();
  m.tools = m.tools.reverse();
  assert.throws(() => validateManifest(m, "forgejo", "m.json"), /sorted by name/);
});

test("validateManifest rejects a malformed contract and bad effect", () => {
  // Any well-formed contract is accepted: a tool binds only where a role lists its contract.
  for (const contract of ["not a contract", "vbcdx.forgejo", "vbcdx.forgejo/0", "Vbcdx.forgejo/1", 1]) {
    assert.throws(() => validateManifest(forgejoManifest({ contract }), "forgejo", "m"), /contract/, String(contract));
  }
  assert.deepEqual(validateManifest(forgejoManifest({ contract: "vbcdx.forgejo/2" }), "forgejo", "m").length > 0, true);
  const m = forgejoManifest();
  m.tools[0].effect = "mutate";
  assert.throws(() => validateManifest(m, "forgejo", "m"), /invalid effect/);
});

test("loadIntegrations validates the file and referenced manifests", () => {
  const d = scratch();
  const mf = join(d, "forgejo.json");
  writeFileSync(mf, JSON.stringify(forgejoManifest()));
  const intf = join(d, "integrations.json");
  writeFileSync(intf, JSON.stringify({
    schema_version: 1,
    services: {
      forgejo: {
        server_name: "forgejo",
        manifest_file: mf,
        credentials: { "code-agent": join(d, "code-agent.env") },
      },
    },
  }));
  const res = loadIntegrations(intf);
  assert.equal(res.services.forgejo.contract, "vbcdx.forgejo/1");
  assert.deepEqual(res.services.forgejo.tools, ["create_comment", "whoami"]);
  assert.equal(res.services.forgejo.credentials["code-agent"], join(d, "code-agent.env"));
  rmSync(d, { recursive: true, force: true });
});

test("loadIntegrations rejects an unknown service and wrong server_name", () => {
  const d = scratch();
  const bad = join(d, "bad.json");
  // Any service name of the declaration's shape is accepted; a malformed one is not.
  for (const name of ["Git_Lab", "1tracker", "a", "tracker-", "x".repeat(65)]) {
    writeFileSync(bad, JSON.stringify({ schema_version: 1, services: { [name]: {} } }));
    assert.throws(() => loadIntegrations(bad), /must be 2-64 characters of lowercase letters/, name);
  }
  const mf = join(d, "forgejo.json");
  writeFileSync(mf, JSON.stringify(forgejoManifest()));
  const wrongName = join(d, "wrongname.json");
  writeFileSync(wrongName, JSON.stringify({
    schema_version: 1,
    services: { forgejo: { server_name: "code-host", manifest_file: mf, credentials: {} } },
  }));
  assert.throws(() => loadIntegrations(wrongName), /server_name must be exactly/);
  rmSync(d, { recursive: true, force: true });
});

test("loadIntegrations rejects a credential role no loaded pack has", () => {
  const d = scratch();
  const mf = join(d, "forgejo.json");
  writeFileSync(mf, JSON.stringify(forgejoManifest()));
  const f = join(d, "int.json");
  writeFileSync(f, JSON.stringify({
    schema_version: 1,
    services: { forgejo: { server_name: "forgejo", manifest_file: mf, credentials: { "coder-agent": join(d, "x.env") } } },
  }));
  assert.throws(() => loadIntegrations(f), /not a role of a loaded agent pack/);
  rmSync(d, { recursive: true, force: true });
});

test("loadIntegrations rejects duplicate JSON keys", () => {
  const d = scratch();
  const f = join(d, "dup.json");
  writeFileSync(f, '{"schema_version":1,"schema_version":1,"services":{}}');
  assert.throws(() => loadIntegrations(f), /duplicate object key/);
  rmSync(d, { recursive: true, force: true });
});
