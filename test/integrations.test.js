import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIntegrations, validateManifest } from "../src/config/integrations.js";
import { FIXTURE_IDS, PACK_ARG } from "./helpers/fixture-pack.js";

// The integrations file is read only if no one but its owner can change it (and its
// directory too), and these tests write theirs with the default mode. Pin the umask a
// CI runner has, so a host whose umask is 002 (user private groups) runs them the same.
process.umask(0o022);

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

test("validateManifest names what is wrong with each malformed manifest", () => {
  const t = () => forgejoManifest().tools[0];
  const cases = [
    [null, /Manifest m\.json is not an object/, 2],
    ["a string", /is not an object/, 2],
    [forgejoManifest({ extra: 1 }), /Unknown field "extra" in manifest m\.json/, 2],
    [forgejoManifest({ schema_version: 2 }), /unsupported schema_version 2/, 5],
    [forgejoManifest({ service: "other" }), /declares service other, expected forgejo/, 5],
    [forgejoManifest({ package_version: "" }), /is missing package_version/, 2],
    [forgejoManifest({ package_version: 1 }), /is missing package_version/, 2],
    [forgejoManifest({ tools: {} }), /tools must be an array/, 2],
    [forgejoManifest({ tools: [null] }), /has a non-object tool entry/, 2],
    [forgejoManifest({ tools: [(({ effect, ...rest }) => rest)(t())] }), /tool is missing effect/, 2],
    [forgejoManifest({ tools: [{ ...t(), name: "" }] }), /has a tool with no name/, 2],
    [forgejoManifest({ tools: [{ ...t(), name: 7 }] }), /has a tool with no name/, 2],
    [forgejoManifest({ tools: [{ ...t(), name: "bad name" }] }), /a tool name is 1-128 letters/, 2],
    [forgejoManifest({ tools: [{ ...t(), required_permissions: "all" }] }), /required_permissions must be an array/, 2],
    [forgejoManifest({ tools: [t(), t()] }), /has duplicate tool names/, 2],
  ];
  for (const [manifest, re, code] of cases) {
    assert.throws(() => validateManifest(manifest, "forgejo", "m.json"), (err) => {
      assert.match(err.message, re);
      assert.equal(err.code, code, err.message);
      return true;
    });
  }
});

test("loadIntegrations names what is wrong with the file's own structure", () => {
  const d = scratch();
  const mf = join(d, "forgejo.json");
  writeFileSync(mf, JSON.stringify(forgejoManifest()));
  const f = join(d, "integrations.json");
  const refused = (body, re, code = 2) => {
    writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body));
    assert.throws(() => loadIntegrations(f), (err) => {
      assert.match(err.message, re);
      assert.equal(err.code, code, err.message);
      return true;
    });
  };
  refused("null", /is not an object/);
  refused("7", /is not an object/);
  refused({ schema_version: 1, services: {}, more: 1 }, /Unknown field "more" in integrations file/);
  refused({ schema_version: 2, services: {} }, /unsupported schema_version 2/, 5);
  refused({ schema_version: 1 }, /has no services object/);
  refused({ schema_version: 1, services: "none" }, /has no services object/);
  refused({ schema_version: 1, services: { forgejo: null } }, /Service forgejo must be an object/);
  refused({ schema_version: 1, services: { forgejo: "x" } }, /Service forgejo must be an object/);
  refused({ schema_version: 1, services: { forgejo: { server_name: "forgejo", manifest_file: mf, surprise: 1 } } }, /Unknown field "surprise" in service forgejo/);
  refused({ schema_version: 1, services: { forgejo: { server_name: "forgejo", manifest_file: "forgejo.json" } } }, /manifest_file must be an absolute path/);
  refused({ schema_version: 1, services: { forgejo: { server_name: "forgejo" } } }, /manifest_file must be an absolute path/);
  refused({ schema_version: 1, services: { forgejo: { server_name: "forgejo", manifest_file: join(d, "absent.json") } } }, /Cannot read forgejo manifest: .*absent\.json \(ENOENT\)/);
  refused({ schema_version: 1, services: { forgejo: { server_name: "forgejo", manifest_file: d } } }, /Cannot read forgejo manifest: .* \(EISDIR\)/);
  // The file itself: absent, and in a directory that is absent.
  assert.throws(() => loadIntegrations(join(d, "nope.json")), /Cannot read integrations file: .*nope\.json \(ENOENT\)/);
  assert.throws(() => loadIntegrations(join(d, "no-dir", "integrations.json")), /Cannot read integrations file: .*integrations\.json \(ENOENT\)/);
  // A file with no service is a valid, empty file.
  writeFileSync(f, JSON.stringify({ schema_version: 1, services: {} }));
  assert.deepEqual(loadIntegrations(f), { services: {} });
  rmSync(d, { recursive: true, force: true });
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
      },
    },
  }));
  const res = loadIntegrations(intf);
  assert.equal(res.services.forgejo.contract, "vbcdx.forgejo/1");
  assert.deepEqual(res.services.forgejo.tools, ["create_comment", "whoami"]);
  // The file binds no role and carries no credential map.
  assert.deepEqual(res.services.forgejo.roles, []);
  assert.equal("credentials" in res.services.forgejo, false);
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
    services: { forgejo: { server_name: "code-host", manifest_file: mf } },
  }));
  assert.throws(() => loadIntegrations(wrongName), /server_name must be exactly/);
  rmSync(d, { recursive: true, force: true });
});

test("loadIntegrations lists no roles: every field of an http service is refused by name, whatever it holds", () => {
  const d = scratch();
  const mf = join(d, "forgejo.json");
  writeFileSync(mf, JSON.stringify(forgejoManifest()));
  const f = join(d, "int.json");
  const write = (svc) => writeFileSync(f, JSON.stringify({ schema_version: 1, services: { forgejo: { server_name: "forgejo", manifest_file: mf, ...svc } } }));
  const http = { transport: "http", url: "https://git.example/mcp" };
  // What an earlier version diagnosed one by one inside an http service (an unknown role, a
  // role twice, no roles, no url, a bad url, a bad prefix) is one refusal now, by field name.
  for (const [svc, fields] of [
    [{ ...http, roles: ["coder-agent"] }, "forgejo.transport, forgejo.url, forgejo.roles"],
    [{ ...http, roles: ["code-agent", "code-agent"] }, "forgejo.transport, forgejo.url, forgejo.roles"],
    [{ ...http }, "forgejo.transport, forgejo.url"],
    [{ transport: "http", roles: ["code-agent"] }, "forgejo.transport, forgejo.roles"],
    [{ ...http, url: "ftp://git.example", roles: ["code-agent"] }, "forgejo.transport, forgejo.url, forgejo.roles"],
    [{ ...http, roles: ["code-agent"], tool_prefix: "bad prefix" }, "forgejo.transport, forgejo.url, forgejo.roles, forgejo.tool_prefix"],
    [{ ...http, roles: ["code-agent"], tool_prefix: "Gw-" }, "forgejo.transport, forgejo.url, forgejo.roles, forgejo.tool_prefix"],
    // The same fields on a service that does not say http.
    [{ url: "https://x.example" }, "forgejo.url"],
    [{ roles: [] }, "forgejo.roles"],
    [{ tool_prefix: "x" }, "forgejo.tool_prefix"],
  ]) {
    write(svc);
    assert.throws(() => loadIntegrations(f), (err) => err.code === 2 && err.message.includes(`per-role credentials are no longer read or sent; remove these fields: ${fields}. `), JSON.stringify(svc));
  }
  // With a git field, the same fields are named by the git refusal.
  write({ ...http, roles: ["code-agent"], git_url: "https://git.example", git_roles: { "code-agent": "fork" } });
  assert.throws(() => loadIntegrations(f), (err) => err.code === 2 && err.message.includes("Hermes git isn't in this release; remove these fields: forgejo.transport, forgejo.url, forgejo.roles, forgejo.git_url, forgejo.git_roles. "));
  write({ transport: "sse" });
  assert.throws(() => loadIntegrations(f), /transport must be "stdio"\./);
  write({ transport: "stdio" });
  assert.deepEqual(loadIntegrations(f).services.forgejo.roles, []);
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
  const ok = load({ stdio: { command: "vbcdx-forgejo", args: ["mcp", "--quiet"], env: ["VBCDX_FORGEJO_URL", "VBCDX_FORGEJO_WRITES"] } });
  assert.deepEqual(ok.stdio, { command: "vbcdx-forgejo", args: ["mcp", "--quiet"], env: { VBCDX_FORGEJO_URL: "${VBCDX_FORGEJO_URL}", VBCDX_FORGEJO_WRITES: "${VBCDX_FORGEJO_WRITES}" } });
  assert.deepEqual(load({ stdio: { command: "acme-tool" } }).stdio, { command: "acme-tool", args: [], env: {} });
  assert.equal(load({}).stdio, undefined, "no stdio key: no launch");
  const cases = [
    ["not an object", { stdio: "vbcdx-forgejo mcp" }, /stdio must be an object/],
    ["an unknown key", { stdio: { command: "x", cwd: "/tmp" } }, /unknown key|not allowed|cwd/],
    ["no command", { stdio: { args: ["mcp"] } }, /stdio\.command must be a program name/],
    ["a path for a command", { stdio: { command: "/usr/bin/x" } }, /stdio\.command must be a program name/],
    ["an uppercase command", { stdio: { command: "Tool" } }, /stdio\.command must be a program name/],
    ["an argument with a value", { stdio: { command: "x", args: ["--url=https://h"] } }, /stdio\.args must be/],
    ["an argument with a digit", { stdio: { command: "x", args: ["--port8080"] } }, /stdio\.args must be/],
    ["too many arguments", { stdio: { command: "x", args: Array(17).fill("mcp") } }, /stdio\.args must be/],
    ["a lowercase variable", { stdio: { command: "x", env: ["url"] } }, /stdio\.env must be/],
    ["a variable with a value", { stdio: { command: "x", env: ["URL=https://h"] } }, /stdio\.env must be/],
    ["a variable twice", { stdio: { command: "x", env: ["URL", "URL"] } }, /stdio\.env lists a variable twice/],
    ["with transport http", { transport: "http", stdio: { command: "x" } }, /remove these fields: forgejo\.transport\./],
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
  const body = JSON.stringify({ schema_version: 1, services: { forgejo: { server_name: "forgejo", manifest_file: mf } } });
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
