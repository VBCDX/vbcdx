import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateToolDeclaration,
  assertToolDeclaration,
  readToolDeclaration,
  TOOL_DECLARATION_SCHEMA_PATH,
  envForMode,
} from "../src/install/tool-declaration.js";
import { EXIT } from "../src/errors.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "fixtures", "tool-package");
const PKG = JSON.parse(readFileSync(join(FIXTURE_DIR, "package.json"), "utf8"));
const schema = JSON.parse(readFileSync(TOOL_DECLARATION_SCHEMA_PATH, "utf8"));

function decl() {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, "vbcdx.json"), "utf8"));
}

function errorsOf(d, opts) {
  const r = validateToolDeclaration(d, opts);
  assert.equal(r.ok, false, "expected the declaration to be refused");
  return r.errors.join("\n");
}

test("the fixture declaration is valid, with and without its package.json", () => {
  assert.deepEqual(validateToolDeclaration(decl()), { ok: true, errors: [] });
  assert.deepEqual(validateToolDeclaration(decl(), { pkg: PKG }), { ok: true, errors: [] });
});

test("a minimal declaration (no http, contract or credential_file) is valid", () => {
  const d = { schema_version: 1, server_name: "ab", stdio: { bin: "ab", args: [] }, env: [], manifest: { args: ["manifest"] } };
  assert.equal(validateToolDeclaration(d).ok, true);
});

test("the shipped schema is valid JSON whose patterns compile", () => {
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.pattern === "string") new RegExp(node.pattern);
    for (const v of Object.values(node)) walk(v);
  };
  walk(schema);
  assert.equal(schema.additionalProperties, false);
});

test("the schema is shipped in the npm package", () => {
  const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));
  assert.ok(pkg.files.includes("schema"), "package.json files must include schema/");
});

test("every required top-level field the schema names is enforced", () => {
  for (const field of schema.required) {
    const d = decl();
    delete d[field];
    assert.match(errorsOf(d), new RegExp(`missing required field ${field.replace("$", "\\$")}`));
  }
});

test("non-objects and unknown fields are refused at every level", () => {
  assert.match(errorsOf(null), /must be a JSON object/);
  assert.match(errorsOf([]), /must be a JSON object/);
  assert.match(errorsOf({ ...decl(), default_url: "x" }), /unknown field "default_url"/);
  const nested = decl();
  nested.stdio.env = { A: "b" };
  assert.match(errorsOf(nested), /stdio: unknown field "env"/);
  const envVal = decl();
  envVal.env[0].value = "https://tracker.example.com";
  assert.match(errorsOf(envVal), /env\[0\]: unknown field "value"/);
  const httpPort = decl();
  httpPort.http.port = 8080;
  assert.match(errorsOf(httpPort), /http: unknown field "port"/);
});

test("schema_version, server_name and contract are checked", () => {
  assert.match(errorsOf({ ...decl(), schema_version: 2 }), /schema_version must be 1/);
  for (const bad of ["Forgejo", "my_server", "a", "-a", "a-", "9a", "a.b"]) {
    assert.match(errorsOf({ ...decl(), server_name: bad }), /server_name/, bad);
  }
  assert.match(errorsOf({ ...decl(), contract: "vbcdx.forgejo" }), /contract/);
});

test("stdio.bin must be a bare bin name present in package.json", () => {
  const withPath = decl();
  withPath.stdio.bin = "bin/example-tracker.js";
  assert.match(errorsOf(withPath), /stdio.bin must be a package bin name/);
  const missing = decl();
  missing.stdio.bin = "other-bin";
  assert.match(errorsOf(missing, { pkg: PKG }), /not a bin entry/);
  // A string bin field maps the unscoped package name to the file.
  const stringBin = { name: "@example/tracker-plugin", bin: "bin/x.js" };
  const d = decl();
  d.stdio.bin = "tracker-plugin";
  assert.equal(validateToolDeclaration(d, { pkg: stringBin }).ok, true);
});

test("arguments are lowercase subcommands then --flags, so none can carry a value", () => {
  for (const bad of ["--url=https://x.example.com", "https://x.example.com", "/abs/path", "a b", "", "--port=8080",
    "-v", "Mcp", "mcp2", "v1", "--retries-3", "a.b", "--", "mcp-", "a--b", "--" + "a".repeat(30)]) {
    const d = decl();
    d.stdio.args = ["mcp", bad];
    assert.match(errorsOf(d), /stdio.args\[1\] must be a lowercase subcommand or --flag/, JSON.stringify(bad));
  }
  for (const ok of [["mcp"], ["serve", "--read-only"], ["mcp", "--stdio", "--no-color"], []]) {
    const d = decl();
    d.stdio.args = ok;
    assert.equal(validateToolDeclaration(d).ok, true, ok.join(" "));
  }
  const m = decl();
  m.manifest.args = "manifest";
  assert.match(errorsOf(m), /manifest.args must be an array/);
  const many = decl();
  many.http.args = Array(9).fill("x");
  assert.match(errorsOf(many), /more than 8/);
});

test("env entries: name, uniqueness, kind and required", () => {
  const lower = decl();
  lower.env[0].name = "example_url";
  assert.match(errorsOf(lower), /env\[0\].name must be an upper-case/);
  const dup = decl();
  dup.env[1].name = dup.env[0].name;
  assert.match(errorsOf(dup), /listed twice/);
  const kind = decl();
  kind.env[0].kind = "secret";
  assert.match(errorsOf(kind), /kind must be one of credential, config/);
  const req = decl();
  req.env[0].required = "yes";
  assert.match(errorsOf(req), /required must be true or false/);
  assert.match(errorsOf({ ...decl(), env: {} }), /env must be an array/);
});

test("a description is one line and never a value", () => {
  const nl = decl();
  nl.env[0].description = "line one\nline two";
  assert.match(errorsOf(nl), /one non-empty line/);
  const empty = decl();
  empty.env[0].description = "  ";
  assert.match(errorsOf(empty), /one non-empty line/);
  const long = decl();
  long.env[0].description = "x ".repeat(101);
  assert.match(errorsOf(long), /one non-empty line/);
  const url = decl();
  url.env[0].description = "Tracker origin, e.g. https://tracker.example.com";
  assert.match(errorsOf(url), /looks like it holds a value/);
  const token = decl();
  token.env[2].description = "Token, for example ghp_0123456789abcdefABCDEF0123456789abcd";
  assert.match(errorsOf(token), /looks like it holds a value/);
});

test("http: path shape and port_env must be a declared env var", () => {
  for (const bad of ["mcp", "/mcp?x=1", "//host/mcp", "/a/../b", "/", "https://h.example.com/mcp"]) {
    const d = decl();
    d.http.path = bad;
    assert.match(errorsOf(d), /http.path/, bad);
  }
  const undeclared = decl();
  undeclared.http.port_env = "SOME_OTHER_PORT";
  assert.match(errorsOf(undeclared), /SOME_OTHER_PORT must also be listed in env/);
  const missing = decl();
  delete missing.http.path;
  assert.match(errorsOf(missing), /http: missing required field path/);
});

test("credential_file.argument is a tool argument name", () => {
  assert.match(errorsOf({ ...decl(), credential_file: { argument: "Credential-File" } }), /credential_file.argument/);
  assert.match(errorsOf({ ...decl(), credential_file: "credential_file" }), /credential_file must be an object/);
});

test("validation reports every problem, not just the first", () => {
  const d = decl();
  d.schema_version = 9;
  d.server_name = "BAD";
  d.env[0].kind = "nope";
  const r = validateToolDeclaration(d);
  assert.equal(r.errors.length, 3);
});

test("assertToolDeclaration throws a config error listing every problem", () => {
  const d = decl();
  d.server_name = "BAD";
  try {
    assertToolDeclaration(d, { source: "pkg/vbcdx.json" });
    assert.fail("expected a throw");
  } catch (err) {
    assert.equal(err.code, EXIT.CONFIG);
    assert.match(err.message, /Invalid tool declaration pkg\/vbcdx.json:\n {2}server_name/);
  }
});

test("readToolDeclaration reads, cross-checks and refuses duplicate keys", () => {
  const { declaration, pkg } = readToolDeclaration(FIXTURE_DIR);
  assert.equal(declaration.server_name, "example-tracker");
  assert.equal(pkg.name, "@example/tracker-plugin");

  const dir = mkdtempSync(join(tmpdir(), "vbcdx-decl-"));
  try {
    assert.throws(() => readToolDeclaration(dir), /not a VBCDX tool package/);
    writeFileSync(join(dir, "package.json"), JSON.stringify(PKG));
    assert.throws(() => readToolDeclaration(dir), /no readable vbcdx.json/);
    writeFileSync(join(dir, "vbcdx.json"), '{"schema_version":1,"schema_version":1}');
    assert.throws(() => readToolDeclaration(dir), /duplicate/i);
    const d = decl();
    d.stdio.bin = "not-in-package";
    writeFileSync(join(dir, "vbcdx.json"), JSON.stringify(d));
    assert.throws(() => readToolDeclaration(dir), /not a bin entry/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A 39-character token, built at run time so the literal never sits in the source.
const TOKEN = "ghp" + "_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

test("no args list can carry a key, token or host, at any length (review findings 1)", () => {
  // Each was once accepted by the 31-character cap alone.
  const values = [TOKEN, "AKIAIOSFODNN7EXAMPLE", "--" + "a".repeat(29) + "1", "deadbeef1234", "git.example.com", "10.0.0.1", "s3cr3t"];
  for (const field of ["stdio", "http", "manifest"]) {
    for (const v of values) {
      const d = decl();
      d[field].args = [...d[field].args, v];
      assert.match(errorsOf(d), new RegExp(`${field}.args\\[\\d\\] must be a lowercase subcommand or --flag`), `${field} ${v}`);
    }
  }
});

test("a flag cannot be given a value: no subcommand may follow a flag", () => {
  const d = decl();
  d.stdio.args = ["mcp", "--token", "hunter"];
  assert.match(errorsOf(d), /stdio.args\[2\] follows a flag/);
  d.stdio.args = ["--verbose", "mcp"];
  assert.match(errorsOf(d), /stdio.args\[1\] follows a flag/);
});

test("a description refuses a host name, an IP address and key-like runs of 20+ characters", () => {
  for (const bad of ["Forgejo at git.example.com", "Defaults to example.org", "Server at 10.0.0.1",
    "Key AKIAIOSFODNN7EXAMPLE", "Run " + "a1".repeat(10), "Secret " + "x".repeat(31)]) {
    const d = decl();
    d.env[0].description = bad;
    assert.match(errorsOf(d), /looks like it holds a value/, bad);
  }
  // Each remaining guard on its own: a URL with no dotted host, and a 32+ run of
  // underscore-joined pieces none of which reaches 20 characters.
  for (const bad of ["Use http://localhost:8080 locally", "Ref " + "A".repeat(19) + "_" + "B".repeat(19)]) {
    const d = decl();
    d.env[0].description = bad;
    assert.match(errorsOf(d), /looks like it holds a value/, bad);
  }
  // Variable names, ports and ordinary prose stay allowed.
  for (const ok of ["Set VBCDX_FORGEJO_TIMEOUT_MS to change it.", "Listen port, 8080 by default.", "off, write or full."]) {
    const d = decl();
    d.env[0].description = ok;
    assert.equal(validateToolDeclaration(d).ok, true, ok);
  }
});

test("$schema is a relative path to the schema file: no URL, no credentials, no other file", () => {
  for (const ok of ["vbcdx-tool.schema.json", "./node_modules/@vbcdx/vbcdx/schema/vbcdx-tool.schema.json", "../../../schema/vbcdx-tool.schema.json"]) {
    assert.equal(validateToolDeclaration({ ...decl(), $schema: ok }).ok, true, ok);
  }
  for (const bad of [
    "https://example.com/vbcdx-tool.schema.json",
    `https://user:${TOKEN}@example.com/vbcdx-tool.schema.json`,
    `${TOKEN}/vbcdx-tool.schema.json`,
    "/abs/vbcdx-tool.schema.json",
    "schema/other.json",
    42,
  ]) {
    assert.match(errorsOf({ ...decl(), $schema: bad }), /\$schema must be a relative path/, String(bad));
  }
  assert.match(errorsOf({ ...decl(), $schema: "a/".repeat(100) + "vbcdx-tool.schema.json" }), /\$schema/);
  // A one-element array stringifies to a matching path: only the type check refuses it.
  assert.match(errorsOf({ ...decl(), $schema: ["vbcdx-tool.schema.json"] }), /\$schema must be a relative path/);
  // Eight 28-character segments fit the pattern (254 characters); only maxLength 200 refuses it.
  const long = `${"a".repeat(28)}/`.repeat(8) + "vbcdx-tool.schema.json";
  assert.ok(new RegExp(schema.properties.$schema.pattern).test(long) && long.length > 200);
  assert.match(errorsOf({ ...decl(), $schema: long }), /\$schema must be a relative path/);
});

test("a description refuses control characters and line or paragraph separators (finding 3)", () => {
  for (const bad of ["safe\u001b[2K\u001b[31mSPOOFED", "bell\u0007", "osc\u001b]52;c;aGk=\u0007", "c1\u0085x", "line two", "para two", "del\u007f"]) {
    const d = decl();
    d.env[0].description = bad;
    assert.match(errorsOf(d), /printable text/, JSON.stringify(bad));
  }
  const d = decl();
  d.env[0].description = "Origine de l'instance — ünïcödé is fine.";
  assert.equal(validateToolDeclaration(d).ok, true);
});

test("a description refuses every Unicode format character in the BMP and the tag characters", () => {
  const bad = [];
  for (let n = 0; n <= 0xffff; n++) {
    const c = String.fromCharCode(n);
    if (/\p{Cf}/u.test(c)) bad.push(c);
  }
  bad.push("\u{e0001}", "\u{e0041}", "\u{e007f}");
  assert.ok(bad.length > 40, String(bad.length));
  for (const c of bad) {
    const d = decl();
    d.env[0].description = `Forge${c}origin.`;
    assert.match(errorsOf(d), /printable text/, `U+${c.codePointAt(0).toString(16)}`);
  }
});

test("size limits are enforced: env items and http.path length (finding 2)", () => {
  const many = decl();
  many.env = Array.from({ length: 65 }, (_, i) => ({ name: `V${i}`, description: "d", kind: "config", required: false }));
  many.http.port_env = "V0";
  assert.match(errorsOf(many), /env has more than 64 items/);
  many.env.length = 64;
  assert.equal(validateToolDeclaration(many).ok, true);
  const long = decl();
  long.http.path = "/" + "a".repeat(128);
  assert.match(errorsOf(long), /http.path/);
  long.http.path = "/" + "a".repeat(127);
  assert.equal(validateToolDeclaration(long).ok, true);
});

// A minimal evaluator for the JSON Schema keywords the shipped schema uses, so the
// schema's own claims are executed rather than read (review finding 2).
function schemaErrors(node, value, root = schema) {
  if (node.$ref) return schemaErrors(root.$defs[node.$ref.split("/").pop()], value, root);
  const errs = [];
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (node.type && !(node.type === type || (node.type === "integer" && Number.isInteger(value)))) return ["type"];
  if ("const" in node && value !== node.const) errs.push("const");
  if (node.enum && !node.enum.includes(value)) errs.push("enum");
  if (type === "string") {
    if (node.minLength !== undefined && value.length < node.minLength) errs.push("minLength");
    if (node.maxLength !== undefined && value.length > node.maxLength) errs.push("maxLength");
    if (node.pattern && !new RegExp(node.pattern).test(value)) errs.push("pattern");
  }
  if (node.not && schemaErrors(node.not, value, root).length === 0) errs.push("not");
  if (node.anyOf && !node.anyOf.some((n) => schemaErrors(n, value, root).length === 0)) errs.push("anyOf");
  if (type === "array") {
    if (node.maxItems !== undefined && value.length > node.maxItems) errs.push("maxItems");
    if (node.minItems !== undefined && value.length < node.minItems) errs.push("minItems");
    if (node.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errs.push("uniqueItems");
    if (node.items) value.forEach((v) => errs.push(...schemaErrors(node.items, v, root)));
  }
  if (type === "object" && node.properties) {
    for (const k of node.required || []) if (!(k in value)) errs.push(`required ${k}`);
    for (const [k, v] of Object.entries(value)) {
      if (node.properties[k]) errs.push(...schemaErrors(node.properties[k], v, root));
      else if (node.additionalProperties === false) errs.push(`additional ${k}`);
    }
  }
  return errs;
}

test("the shipped schema alone refuses every per-field value guard the validator applies", () => {
  assert.deepEqual(schemaErrors(schema, decl()), [], "the fixture is valid against the schema");
  const cases = [
    ["token in args", (d) => { d.stdio.args.push(TOKEN); }],
    ["AWS key in args", (d) => { d.manifest.args.push("AKIAIOSFODNN7EXAMPLE"); }],
    ["digits in a flag", (d) => { d.http.args.push("--retries-3"); }],
    ["host in a description", (d) => { d.env[0].description = "Forgejo at git.example.com"; }],
    ["IP in a description", (d) => { d.env[0].description = "Server at 10.0.0.1"; }],
    ["20-char key run in a description", (d) => { d.env[0].description = "Key AKIAIOSFODNN7EXAMPLE"; }],
    ["blank description", (d) => { d.env[0].description = "   "; }],
    ["control character in a description", (d) => { d.env[0].description = "a\u001bb"; }],
    ["'..' in http.path", (d) => { d.http.path = "/a/../b"; }],
    ["URL in $schema", (d) => { d.$schema = "https://example.com/vbcdx-tool.schema.json"; }],
    ["unknown field", (d) => { d.stdio.env = {}; }],
    ["empty modes", (d) => { d.env[0].modes = []; }],
    ["unknown mode", (d) => { d.env[0].modes = ["sse"]; }],
    ["repeated mode", (d) => { d.env[0].modes = ["stdio", "stdio"]; }],
    ["modes not a list", (d) => { d.env[0].modes = "stdio"; }],
  ];
  for (const [label, mutate] of cases) {
    const d = decl();
    mutate(d);
    assert.equal(validateToolDeclaration(d).ok, false, `validator: ${label}`);
    assert.notDeepEqual(schemaErrors(schema, d), [], `schema alone: ${label}`);
  }
});

test("the six cross-field rules are validator-only, as the schema states", () => {
  const cases = [
    ["port_env not listed in env", (d) => { d.http.port_env = "SOME_OTHER_PORT"; }, null],
    ["duplicate env names", (d) => { d.env[1].name = d.env[0].name; }, null],
    ["bin not in package.json", (d) => { d.stdio.bin = "other-bin"; }, PKG],
    ["subcommand after a flag", (d) => { d.stdio.args = ["--verbose", "mcp"]; }, null],
    ["port_env not read in http mode", (d) => { d.env[3].modes = ["stdio"]; }, null],
    ["an http-mode variable without an http mode", (d) => { delete d.http; d.env[3].modes = ["http"]; }, null],
  ];
  assert.match(schema.description, /checked only by the reference validator/);
  for (const [label, mutate, pkg] of cases) {
    const d = decl();
    mutate(d);
    assert.deepEqual(schemaErrors(schema, d), [], `schema alone accepts: ${label}`);
    assert.equal(validateToolDeclaration(d, pkg ? { pkg } : {}).ok, false, `validator refuses: ${label}`);
  }
});

// ── env modes ─────────────────────────────────────────────

test("env modes: stdio, http or both; absent means both", () => {
  for (const modes of [["stdio"], ["http"], ["stdio", "http"], ["http", "stdio"]]) {
    const d = decl();
    d.env[1].modes = modes;
    assert.deepEqual(validateToolDeclaration(d), { ok: true, errors: [] }, JSON.stringify(modes));
  }
  const errs = (mutate) => { const d = decl(); mutate(d); return errorsOf(d); };
  assert.match(errs((d) => { d.env[1].modes = ["stdio", "http", "stdio"]; }), /env\[1\]\.modes must list stdio and\/or http, each at most once/);
  assert.match(errs((d) => { d.env[1].modes = [1]; }), /env\[1\]\.modes must list/);
  assert.match(errs((d) => { d.env[3].modes = ["stdio"]; }), /http\.port_env EXAMPLE_TRACKER_HTTP_PORT is read in http mode, so its modes must include http/);
  assert.match(errs((d) => { delete d.http; d.env[1].modes = ["http"]; }), /env\[1\]\.modes lists http, but the declaration has no http mode/);
  assert.match(errs((d) => { delete d.http; d.env[1].modes = ["stdio", "http"]; }), /env\[1\]\.modes lists http, but the declaration has no http mode/);
  const noHttp = decl();
  delete noHttp.http;
  noHttp.env[1].modes = ["stdio"];
  delete noHttp.env[3].modes; // the fixture reads its port in http mode only
  assert.equal(validateToolDeclaration(noHttp).ok, true, "stdio alone needs no http mode");
});

test("envForMode keeps the items a mode reads", () => {
  const env = [{ name: "A" }, { name: "B", modes: ["stdio"] }, { name: "C", modes: ["http"] }, { name: "D", modes: ["http", "stdio"] }];
  assert.deepEqual(envForMode(env, "stdio").map((e) => e.name), ["A", "B", "D"]);
  assert.deepEqual(envForMode(env, "http").map((e) => e.name), ["A", "C", "D"]);
  assert.deepEqual(envForMode(undefined, "stdio"), []);
});
