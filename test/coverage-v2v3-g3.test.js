// Branch coverage for the agent-pack validators, the A2A cards server and its entrypoint,
// and the service argument, release, leftover and error-quoting helpers. Each test names the
// source range it reaches.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.js";
import { FIXTURE_PACK, PACK_ARG } from "./helpers/fixture-pack.js";
import { keypair, signFile } from "./helpers/minisign-signer.js";
import { EXIT } from "../src/errors.js";
import {
  validatePackDeclaration,
  validateRoleDescriptor,
  readPack,
  PACK_DECLARATION_FILE,
  PACK_SCHEMA_PATH,
  ROLE_SCHEMA_PATH,
} from "../src/packs/load.js";
import { createRequestHandler, resolveBaseUrl } from "../src/a2a/server.js";
import { compareVersions } from "../src/service/areas.js";
import { parseServiceArgs } from "../src/service/args.js";
import { SERVICES, hostPlatform, verifyRelease } from "../src/service/artifact.js";
import { unrecordedLeftovers } from "../src/service/leftovers.js";
import { layout } from "../src/service/plan.js";
import { fakeSystem } from "../src/service/system.js";
import { NOT_SHOWN, redactTyped, shownName } from "../src/shown.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "a2a-server.js");
const PACK_SCHEMA = JSON.parse(readFileSync(PACK_SCHEMA_PATH, "utf8"));
const ROLE_SCHEMA = JSON.parse(readFileSync(ROLE_SCHEMA_PATH, "utf8"));

const ROLE_ID = FIXTURE_PACK.roles[0].id;
const CONTRACT = FIXTURE_PACK.contracts[0];
const roleBase = () => JSON.parse(JSON.stringify(FIXTURE_PACK.roles[0].descriptor));
const declBase = () => ({ schema_version: 1, name: FIXTURE_PACK.name, roles_dir: "roles", roles: [ROLE_ID] });

// ── src/packs/load.js: pack declaration ─────────────────────────────────────

test("a contract_tags object with a non-array contracts list reports each tagged contract as unlisted", () => {
  // load.js 134: `Array.isArray(decl.contracts) ? decl.contracts : []`: the empty list.
  assert.deepEqual(validatePackDeclaration(declBase()), { ok: true, errors: [] });
  const res = validatePackDeclaration({ ...declBase(), contracts: "not-a-list", contract_tags: { [CONTRACT]: "ci" } });
  assert.equal(res.ok, false);
  assert.deepEqual(res.errors, [
    "contracts must be an array.",
    `contract_tags: ${CONTRACT} is not listed in contracts.`,
  ]);
});

test("vars that is not an object is refused", () => {
  // load.js 147: vars must be an object.
  for (const bad of ["text", ["a"], null, 3]) {
    assert.deepEqual(validatePackDeclaration({ ...declBase(), vars: bad }), { ok: false, errors: ["vars must be an object."] });
  }
});

test("more variables than the schema allows is refused", () => {
  // load.js 149: the count limit, read from the pack schema.
  const max = PACK_SCHEMA.properties.vars.maxProperties;
  const vars = {};
  for (let i = 0; i <= max; i++) vars[`v${i}`] = { default: "d", description: "d" };
  assert.equal(Object.keys(vars).length, max + 1);
  assert.deepEqual(validatePackDeclaration({ ...declBase(), vars }), { ok: false, errors: [`vars has more than ${max} variables.`] });
  delete vars[`v${max}`];
  assert.deepEqual(validatePackDeclaration({ ...declBase(), vars }), { ok: true, errors: [] });
});

test("a variable with a bad name, a non-object spec, or a missing field is reported and the rest are still read", () => {
  // load.js 152 (bad name: skipped), 153 (spec not an object: skipped), 156 (a missing
  // default/description key is left to checkKeys, not checked twice).
  const res = validatePackDeclaration({
    ...declBase(),
    vars: { "Bad-Name": { default: "d", description: "d" }, plain: "text", partial: { default: "d" } },
  });
  assert.equal(res.ok, false);
  assert.deepEqual(res.errors, [
    'vars: "Bad-Name" is not a variable name (lowercase letters, digits and underscores, starting with a letter).',
    "vars.plain must be an object.",
    "vars.partial: missing required field description.",
  ]);
});

// ── src/packs/load.js: role descriptor ──────────────────────────────────────

test("the role descriptor sections that must be objects, and the dependency keys and counts, are checked", () => {
  const maxItems = ROLE_SCHEMA.properties.external_dependencies.maxItems;
  const rows = [
    // load.js 203
    { name: "local_capabilities not an object", set: { local_capabilities: "yes" }, errors: ["local_capabilities must be an object."] },
    // load.js 217
    { name: "remote_capabilities not an object", set: { remote_capabilities: ["x"] }, errors: ["remote_capabilities must be an object."] },
    // load.js 229
    { name: "dependencies not an object", set: { dependencies: "x" }, errors: ["dependencies must be an object."] },
    // load.js 232
    {
      name: "dependencies key that is not a service name",
      set: { dependencies: { Not_A_Service: CONTRACT } },
      errors: ['dependencies key "Not_A_Service" is not a service name.'],
    },
    // load.js 245
    { name: "external_dependencies entry not an object", set: { external_dependencies: ["x"] }, errors: ["external_dependencies[0] must be an object."] },
  ];
  assert.deepEqual(validateRoleDescriptor(roleBase(), ROLE_ID), { ok: true, errors: [] });
  for (const row of rows) {
    const res = validateRoleDescriptor({ ...roleBase(), ...row.set }, ROLE_ID);
    assert.equal(res.ok, false, row.name);
    assert.deepEqual(res.errors, row.errors, row.name);
  }
  // load.js 242: one more entry than the schema's limit. (Each empty entry also reports its own
  // missing fields; the count message is the one under test.)
  const tooMany = validateRoleDescriptor({ ...roleBase(), external_dependencies: Array.from({ length: maxItems + 1 }, () => ({})) }, ROLE_ID);
  assert.equal(tooMany.ok, false);
  assert.ok(tooMany.errors.includes(`external_dependencies has more than ${maxItems} items.`), tooMany.errors.join("\n"));
});

// ── src/packs/load.js: readPack ─────────────────────────────────────────────

/** A one-role pack under a fresh directory; `role` and `decl` let a test change the files. */
function miniPack({ role = {}, decl = {} } = {}) {
  const dir = tempDir("vbcdx-g3-pack-");
  mkdirSync(join(dir, "roles", ROLE_ID), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@example/mini", version: "0.1.0" }));
  writeFileSync(join(dir, PACK_DECLARATION_FILE), JSON.stringify({ ...declBase(), ...decl }));
  const descriptor = { ...roleBase(), dependencies: {}, remote_capabilities: {}, ...role };
  writeFileSync(join(dir, "roles", ROLE_ID, "role.json"), JSON.stringify(descriptor));
  writeFileSync(join(dir, "roles", ROLE_ID, "prompt.md"), "You are a coding agent.\n");
  return dir;
}

test("a pack with no description loads with an empty description", () => {
  // load.js 328: `decl.description || ""`.
  const pack = readPack(miniPack());
  assert.equal(pack.description, "");
  assert.equal(pack.name, FIXTURE_PACK.name);
  assert.equal(pack.version, "0.1.0");
  assert.deepEqual(pack.roles.map((r) => r.id), [ROLE_ID]);
});

test("a role whose dependencies or remote_capabilities is not an object is refused with that reason alone", () => {
  // load.js 312 and 315: the cross-file contract checks treat a non-object as empty, so the
  // only error is the descriptor's own.
  const rows = [
    { field: "dependencies", value: "oops", message: `role ${ROLE_ID}: dependencies must be an object.` },
    { field: "remote_capabilities", value: ["oops"], message: `role ${ROLE_ID}: remote_capabilities must be an object.` },
  ];
  for (const row of rows) {
    assert.throws(() => readPack(miniPack({ role: { [row.field]: row.value } })), (e) => {
      assert.equal(e.code, EXIT.CONFIG);
      assert.deepEqual(e.details.lines.slice(1), [`  ${row.message}`], row.field);
      return true;
    });
  }
});

// ── src/a2a/server.js ───────────────────────────────────────────────────────

/** A recorded response for a handler called directly. */
function fakeRes() {
  const res = {
    status: null,
    headers: null,
    ended: false,
    body: undefined,
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
    },
    end(body) {
      res.ended = true;
      res.body = body;
    },
  };
  return res;
}

test("a request with no headers resolves to the plain localhost base URL", () => {
  // server.js 99: `req.headers || {}`.
  assert.equal(resolveBaseUrl({}, undefined), "http://localhost");
  assert.equal(resolveBaseUrl({}, "https://cards.example"), "https://cards.example");
});

test("a request with no method is a GET", () => {
  // server.js 113: `req.method || "GET"`.
  const res = fakeRes();
  createRequestHandler()({ url: "/healthz", headers: {} }, res);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body.toString("utf8")), { status: "ok" });
});

test("a URL that cannot be parsed is a 404, with no body on HEAD", () => {
  // server.js 125-127: new URL() throws, the handler answers not_found.
  for (const url of ["//", "http://[", "//[::1"]) {
    const get = fakeRes();
    createRequestHandler()({ method: "GET", url, headers: {} }, get);
    assert.equal(get.status, 404, url);
    assert.deepEqual(JSON.parse(get.body.toString("utf8")), { error: "not_found" }, url);
    const head = fakeRes();
    createRequestHandler()({ method: "HEAD", url, headers: {} }, head);
    assert.equal(head.status, 404, url);
    assert.equal(head.ended, true);
    assert.equal(head.body, undefined, "HEAD sends no body");
  }
});

// ── bin/a2a-server.js ───────────────────────────────────────────────────────

/** Start the real entrypoint; resolves once it prints its listening line. */
function startBin(env) {
  const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, VBCDX_A2A_PACKS: FIXTURE_PACK.dir, ...env };
  if (process.env.NODE_V8_COVERAGE) childEnv.NODE_V8_COVERAGE = process.env.NODE_V8_COVERAGE;
  for (const k of Object.keys(childEnv)) if (childEnv[k] === undefined) delete childEnv[k];
  const child = spawn(process.execPath, [BIN], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  const state = { out: "", err: "", exit: null };
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => { state.exit = { code, signal }; resolve(state.exit); }));
  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`no listening line: ${state.out} ${state.err}`)); }, 10000);
    child.stderr.on("data", (d) => { state.err += d; });
    child.stdout.on("data", (d) => {
      state.out += d;
      const line = state.out.split("\n").find((l) => l.startsWith("a2a-cards: listening on "));
      if (line) { clearTimeout(timer); resolve(line); }
    });
    exited.then(() => { clearTimeout(timer); reject(new Error(`exited early: ${state.out} ${state.err}`)); });
  });
  listening.catch(() => {});
  return { child, state, listening, exited };
}

test("SIGTERM and SIGINT each stop the server cleanly with exit 0", async () => {
  // a2a-server.js 51 (the close callback exits 0) and 55 (SIGINT handler).
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const run = startBin({ PORT: "0", HOST: "127.0.0.1" });
    try {
      await run.listening;
      run.child.kill(signal);
      const exit = await Promise.race([
        run.exited,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${signal}: did not exit: ${run.state.out} ${run.state.err}`)), 8000)),
      ]);
      assert.deepEqual(exit, { code: 0, signal: null }, signal);
      assert.ok(run.state.out.includes(`a2a-cards: received ${signal}, shutting down\n`), run.state.out);
    } finally {
      run.child.kill("SIGKILL");
    }
  }
});

test("with no PORT set the server listens on port 8080 of 127.0.0.1", async (t) => {
  // a2a-server.js 36: `process.env.PORT || 8080`. Only loopback is bound; skipped when 8080 is taken.
  const free = await new Promise((resolve) => {
    const s = createNetServer();
    s.once("error", () => resolve(false));
    s.listen(8080, "127.0.0.1", () => s.close(() => resolve(true)));
  });
  if (!free) return t.skip("127.0.0.1:8080 is in use on this host");
  const run = startBin({ HOST: "127.0.0.1" });
  try {
    const line = await run.listening;
    assert.match(line, /^a2a-cards: listening on 127\.0\.0\.1:8080 \(base URL http:\/\/127\.0\.0\.1:8080\), serving \d+ roles from /);
  } finally {
    run.child.kill("SIGTERM");
    await run.exited;
  }
});

// ── src/service/areas.js ────────────────────────────────────────────────────

test("compareVersions refuses a value that is not a version", () => {
  // areas.js 43.
  assert.throws(() => compareVersions("latest", "1.0.0"), /^Error: not a version: latest$/);
  assert.throws(() => compareVersions("1.0.0", "1.0"), /^Error: not a version: 1\.0$/);
  assert.ok(compareVersions("1.0.0", "1.0.1") < 0);
});

// ── src/service/args.js ─────────────────────────────────────────────────────

const configRefusal = (message) => (e) => {
  assert.equal(e.code, EXIT.CONFIG);
  assert.equal(e.message, message);
  return true;
};

test("a valued option with no value, or given twice, is refused", () => {
  // args.js 76: needs a value (last, empty, or followed by another option).
  for (const argv of [
    ["install", "service", "sidecar", "--instance"],
    ["install", "service", "sidecar", "--instance="],
    ["install", "service", "sidecar", "--instance", "--json"],
  ]) {
    assert.throws(() => parseServiceArgs(argv), configRefusal("--instance needs a value."), argv.join(" "));
  }
  // args.js 77: given twice, in either spelling.
  for (const argv of [
    ["install", "service", "sidecar", "--instance", "a", "--instance", "b"],
    ["install", "service", "sidecar", "--instance=a", "--instance=b"],
  ]) {
    assert.throws(() => parseServiceArgs(argv), configRefusal("--instance is given twice."), argv.join(" "));
  }
});

test("doctor without --service, and service with no action or service, name what is missing", () => {
  // args.js 93: oneService(undefined, ...).
  assert.throws(() => parseServiceArgs(["doctor"]),
    configRefusal("doctor --service needs a service: sidecar, control-plane, dispatch-server or keyhole-server."));
  // args.js 181: `service` alone shows the placeholder, not a typed word.
  assert.throws(() => parseServiceArgs(["service"]),
    configRefusal("service <service> needs one of: status, start, stop, restart, logs."));
  assert.throws(() => parseServiceArgs(["service", "sidecar"]),
    configRefusal("service sidecar needs one of: status, start, stop, restart, logs."));
});

// ── src/service/artifact.js ─────────────────────────────────────────────────

test("hostPlatform refuses a CPU that is not built", () => {
  // artifact.js 42.
  assert.throws(() => hostPlatform({ os: "linux", cpu: "ia32" }), (e) => {
    assert.equal(e.code, EXIT.CONFLICT);
    assert.equal(e.message, "Unsupported CPU: ia32 (x64 and arm64 are built).");
    return true;
  });
  assert.equal(hostPlatform({ os: "darwin", cpu: "arm64" }), "darwin-arm64");
});

test("verifyRelease refuses a service it does not know", () => {
  // artifact.js 67: refused before the release is read.
  assert.throws(() => verifyRelease({ root: tempDir("vbcdx-g3-rel-"), service: "no-such-service", platformId: "linux-x64-gnu", trustedKeys: [] }),
    configRefusal("Unknown service: no-such-service."));
});

const sha = (b) => createHash("sha256").update(b).digest("hex");
const KEY = keypair(5);

/** A release root whose checksums.json is signed; `sumsBytes` is the signed content. */
function signedRoot(service, sumsBytes) {
  const root = tempDir("vbcdx-g3-rel-");
  writeFileSync(join(root, "checksums.json"), sumsBytes);
  writeFileSync(join(root, "checksums.json.minisig"), signFile(KEY, sumsBytes, `vbcdx-release ${SERVICES[service].package} 0.1.0`));
  return root;
}

test("a signed checksums.json that is not JSON is refused", () => {
  // artifact.js 81-83.
  const service = "keyhole-server";
  const root = signedRoot(service, Buffer.from("this is signed but is not json\n"));
  assert.throws(() => verifyRelease({ root, service, platformId: "linux-x64-gnu", trustedKeys: [KEY.pub] }),
    (e) => {
      assert.equal(e.code, EXIT.CONFLICT);
      assert.equal(e.message, "checksums.json is signed but is not JSON.");
      return true;
    });
});

test("a signed release whose binary is absent, or is not a file, is refused as missing", () => {
  // artifact.js 115: the checksum is listed but no root holds a regular file at the path.
  const service = "keyhole-server";
  const platformId = "linux-x64-gnu";
  const binary = SERVICES[service].binaries[0];
  const key = `${SERVICES[service].package}-${platformId}/bin/${binary}`;
  const sums = Buffer.from(JSON.stringify({ schema: 1, package: SERVICES[service].package, version: "0.1.0", files: { [key]: sha(Buffer.from("x")) } }));
  const expected = (e) => {
    assert.equal(e.code, EXIT.CONFLICT);
    assert.equal(e.message, `The release is missing ${key}.`);
    return true;
  };
  const absent = signedRoot(service, sums);
  assert.throws(() => verifyRelease({ root: absent, service, platformId, trustedKeys: [KEY.pub] }), expected);
  // A directory at that path is not a binary either.
  const dirRoot = signedRoot(service, sums);
  mkdirSync(join(dirRoot, key), { recursive: true });
  assert.throws(() => verifyRelease({ root: dirRoot, service, platformId, trustedKeys: [KEY.pub] }), expected);
});

// ── src/service/leftovers.js ────────────────────────────────────────────────

test("an unrecorded current link and version directory are reported as leftovers", () => {
  // leftovers.js 50: no record names the service, and its `current` link exists.
  const root = tempDir("vbcdx-g3-left-");
  const sys = fakeSystem(root);
  const where = { service: "sidecar", instance: "default", scope: "user", home: "/home/someone" };
  const L = layout({ ...where, version: "0" });
  mkdirSync(sys.path(join(L.serviceLib, "1.2.3")), { recursive: true });
  symlinkSync("1.2.3", sys.path(L.current));
  assert.deepEqual(unrecordedLeftovers(sys, where, []), [L.current, join(L.serviceLib, "1.2.3")]);
  // A record naming the service (another instance) leaves the shared binaries alone.
  assert.deepEqual(unrecordedLeftovers(sys, where, [{ service: "sidecar", instance: "other" }]), []);
});

// ── src/shown.js ────────────────────────────────────────────────────────────

test("shownName quotes a scoped package name, and nothing else that is not name-shaped", () => {
  // shown.js 44: the scoped-package branch returns the name itself.
  assert.equal(shownName("@scope/pkg-name"), "@scope/pkg-name");
  assert.equal(shownName("Not A Name"), NOT_SHOWN);
  assert.equal(shownName(7), NOT_SHOWN);
});

test("redactTyped skips argv entries that are not strings", () => {
  // shown.js 81: a non-string entry is ignored, and the later entries keep their positions.
  const typed = "/some/typed/path-value";
  const out = redactTyped(`cannot read ${typed}`, [42, null, typed], { cwd: "/work", home: "/home/someone" });
  assert.equal(out, "cannot read <argument 3>");
});
