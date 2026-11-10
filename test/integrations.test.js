import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

// A stdio service's launch is declared in the integrations file, in the shapes a tool
// declaration uses, and renders as references to its variables, never their values.
test("loadIntegrations reads a stdio launch, held to the tool declaration's shapes", () => {
  const d = scratch();
  const mf = join(d, "forgejo.json");
  writeFileSync(mf, JSON.stringify(forgejoManifest()));
  const intf = join(d, "integrations.json");
  const load = (svc) => {
    writeFileSync(intf, JSON.stringify({ schema_version: 1, services: { forgejo: { server_name: "forgejo", manifest_file: mf, ...svc } } }));
    return loadIntegrations(intf).services.forgejo;
  };
  const ok = load({ credentials: {}, stdio: { command: "vbcdx-forgejo", args: ["mcp", "--quiet"], env: ["VBCDX_FORGEJO_URL", "VBCDX_FORGEJO_WRITES"] } });
  assert.deepEqual(ok.stdio, { command: "vbcdx-forgejo", args: ["mcp", "--quiet"], env: { VBCDX_FORGEJO_URL: "${VBCDX_FORGEJO_URL}", VBCDX_FORGEJO_WRITES: "${VBCDX_FORGEJO_WRITES}" } });
  assert.deepEqual(load({ credentials: {}, stdio: { command: "acme-tool" } }).stdio, { command: "acme-tool", args: [], env: {} });
  assert.equal(load({ credentials: {} }).stdio, undefined, "no stdio key: no launch");
  const cases = [
    ["not an object", { credentials: {}, stdio: "vbcdx-forgejo mcp" }, /stdio must be an object/],
    ["an unknown key", { credentials: {}, stdio: { command: "x", cwd: "/tmp" } }, /unknown key|not allowed|cwd/],
    ["no command", { credentials: {}, stdio: { args: ["mcp"] } }, /stdio\.command must be a program name/],
    ["a path for a command", { credentials: {}, stdio: { command: "/usr/bin/x" } }, /stdio\.command must be a program name/],
    ["an uppercase command", { credentials: {}, stdio: { command: "Tool" } }, /stdio\.command must be a program name/],
    ["an argument with a value", { credentials: {}, stdio: { command: "x", args: ["--url=https://h"] } }, /stdio\.args must be/],
    ["an argument with a digit", { credentials: {}, stdio: { command: "x", args: ["--port8080"] } }, /stdio\.args must be/],
    ["too many arguments", { credentials: {}, stdio: { command: "x", args: Array(17).fill("mcp") } }, /stdio\.args must be/],
    ["a lowercase variable", { credentials: {}, stdio: { command: "x", env: ["url"] } }, /stdio\.env must be/],
    ["a variable with a value", { credentials: {}, stdio: { command: "x", env: ["URL=https://h"] } }, /stdio\.env must be/],
    ["a variable twice", { credentials: {}, stdio: { command: "x", env: ["URL", "URL"] } }, /stdio\.env lists a variable twice/],
    ["with transport http", { transport: "http", url: "https://gw.example/mcp", roles: [], stdio: { command: "x" } }, /stdio is only valid with transport "stdio"/],
  ];
  for (const [label, svc, expected] of cases) {
    assert.throws(() => load(svc), expected, label);
  }
  rmSync(d, { recursive: true, force: true });
});

// The integrations file says which programs Hermes starts, so it is read only when no one
// but its owner can change it. Each case changes one thing from an accepted file.
test("loadIntegrations reads the file only if no one but its owner can change it", () => {
  const d = scratch();
  const mf = join(d, "forgejo.json");
  writeFileSync(mf, JSON.stringify(forgejoManifest()));
  const body = JSON.stringify({ schema_version: 1, services: { forgejo: { server_name: "forgejo", manifest_file: mf, credentials: {} } } });
  const fileIn = (dir, mode) => {
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "integrations.json");
    writeFileSync(f, body);
    chmodSync(f, mode);
    return f;
  };
  // Accepted: the owner's file, 0600 or 0644, and one in a sticky world-writable directory.
  for (const mode of [0o600, 0o644, 0o400]) {
    assert.equal(loadIntegrations(fileIn(join(d, `ok${mode.toString(8)}`), mode)).services.forgejo.serverName, "forgejo", mode.toString(8));
  }
  const sticky = join(d, "sticky");
  mkdirSync(sticky);
  chmodSync(sticky, 0o1777);
  assert.equal(loadIntegrations(fileIn(sticky, 0o644)).services.forgejo.serverName, "forgejo", "a sticky directory, as /tmp");
  // Refused, naming the path and why.
  const refused = (f, why) => assert.throws(() => loadIntegrations(f), (err) => {
    assert.equal(err.code, 2, why);
    assert.ok(err.message.includes(f), why);
    assert.match(err.message, new RegExp(`Refusing the integrations file .*: ${why}`), why);
    return true;
  });
  refused(fileIn(join(d, "g"), 0o664), "it can be written by others");
  refused(fileIn(join(d, "o"), 0o646), "it can be written by others");
  const link = join(d, "link.json");
  symlinkSync(fileIn(join(d, "target"), 0o644), link);
  refused(link, "it is a symlink");
  const gdir = join(d, "gdir");
  const gfile = fileIn(gdir, 0o644);
  chmodSync(gdir, 0o775);
  refused(gfile, "its directory can be written by others");
  const odir = join(d, "odir");
  const ofile = fileIn(odir, 0o644);
  chmodSync(odir, 0o757);
  refused(ofile, "its directory can be written by others");
  const fifoDir = join(d, "notfile");
  mkdirSync(join(fifoDir, "integrations.json"), { recursive: true });
  refused(join(fifoDir, "integrations.json"), "it is not a regular file");
  // Another user's file (needs root to give it away); root's own is the running user's here.
  if (typeof process.geteuid === "function" && process.geteuid() === 0) {
    const other = fileIn(join(d, "other"), 0o644);
    chownSync(other, 65534, 65534);
    refused(other, "it is owned by another user");
  }
  rmSync(d, { recursive: true, force: true });
});
