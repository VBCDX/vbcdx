import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectCredentialTriples, classifyTriple, serializeCredentialFile,
  evaluateExisting, writeCredentialFile,
} from "../src/credentials/writer.js";
import { parseEnvText } from "../src/config/env-parser.js";
import { FIXTURE_IDS, PACK_ARG } from "./helpers/fixture-pack.js";

function creds() {
  const d = mkdtempSync(join(tmpdir(), "vbcdx-cred-"));
  const c = join(d, "creds");
  mkdirSync(c, { mode: 0o700 });
  return { d, c };
}

test("collects and groups triples by normalized role", () => {
  const m = collectCredentialTriples(new Map([
    ["VBCDX_AGENTS_USER_CODE_AGENT", "alice"],
    ["VBCDX_AGENTS_TOKEN_CODE_AGENT", "tok"],
    ["VBCDX_AGENTS_PASSWORD_PM_AGENT", "pw"],
    ["VBCDX_AGENTS_USER_PM_AGENT", "bob"],
  ]));
  assert.equal(m.get("code-agent").user, "alice");
  assert.equal(m.get("code-agent").token, "tok");
  assert.equal(m.get("code-agent").known, true);
  assert.equal(m.get("pm-agent").password, "pw");
});

test("USER/TOKEN/PASSWORD for one role are not collisions", () => {
  assert.doesNotThrow(() => collectCredentialTriples(new Map([
    ["VBCDX_AGENTS_USER_QA_AGENT", "u"],
    ["VBCDX_AGENTS_TOKEN_QA_AGENT", "t"],
    ["VBCDX_AGENTS_PASSWORD_QA_AGENT", "p"],
  ])));
});

test("classifyTriple: disabled / complete / incomplete", () => {
  assert.equal(classifyTriple({ user: "", token: "", password: "" }), "disabled");
  assert.equal(classifyTriple({ user: "u", token: "t", password: "" }), "complete");
  assert.equal(classifyTriple({ user: "u", token: "", password: "p" }), "complete");
  assert.equal(classifyTriple({ user: "u", token: "", password: "" }), "incomplete");
  assert.equal(classifyTriple({ user: "", token: "t", password: "" }), "incomplete");
});

test("unknown-role suffix that is unsafe is rejected", () => {
  assert.throws(
    () => collectCredentialTriples(new Map([["VBCDX_AGENTS_USER__FOO", "x"]])),
    /invalid role suffix/,
  );
});

test("serialization round-trips losslessly through the reader grammar", () => {
  const triple = { role: "code-agent", user: 'a "b" $c', token: "t=ok#1", password: "" };
  const body = serializeCredentialFile(triple);
  const parsed = parseEnvText(body, "cred");
  assert.equal(parsed.get("VBCDX_AGENTS_ROLE"), "code-agent");
  assert.equal(parsed.get("VBCDX_AGENTS_USER"), 'a "b" $c');
  assert.equal(parsed.get("VBCDX_AGENTS_TOKEN"), "t=ok#1");
  assert.equal(parsed.has("VBCDX_AGENTS_PASSWORD"), false);
});

test("writes a 0600 credential file and never leaks the value in the path", () => {
  const { d, c } = creds();
  const res = writeCredentialFile({ credentialsDir: c, triple: { role: "code-agent", user: "u", token: "secret-tok", password: "" } });
  assert.equal(res.action, "written");
  assert.equal(statSync(res.path).mode & 0o777, 0o600);
  const body = readFileSync(res.path, "utf8");
  assert.match(body, /VBCDX_AGENTS_TOKEN/);
  rmSync(d, { recursive: true, force: true });
});

test("retains a valid existing file without force and reports it", () => {
  const { d, c } = creds();
  const t = { role: "code-agent", user: "u", token: "old", password: "" };
  writeCredentialFile({ credentialsDir: c, triple: t });
  const res = writeCredentialFile({ credentialsDir: c, triple: { ...t, token: "new" }, force: false });
  assert.equal(res.action, "retained");
  const body = readFileSync(res.path, "utf8");
  assert.match(body, /old/); // not replaced
  rmSync(d, { recursive: true, force: true });
});

test("force replaces a valid existing file after safety checks", () => {
  const { d, c } = creds();
  const t = { role: "code-agent", user: "u", token: "old", password: "" };
  writeCredentialFile({ credentialsDir: c, triple: t });
  const res = writeCredentialFile({ credentialsDir: c, triple: { ...t, token: "new" }, force: true });
  assert.equal(res.action, "replaced");
  assert.match(readFileSync(res.path, "utf8"), /new/);
  rmSync(d, { recursive: true, force: true });
});

test("an invalid existing file (wrong role) fails even with force", () => {
  const { d, c } = creds();
  const p = join(c, "code-agent.env");
  writeFileSync(p, 'VBCDX_AGENTS_ROLE="pm-agent"\nVBCDX_AGENTS_USER="u"\nVBCDX_AGENTS_TOKEN="t"\n', { mode: 0o600 });
  assert.throws(
    () => writeCredentialFile({ credentialsDir: c, triple: { role: "code-agent", user: "u", token: "t", password: "" }, force: true }),
    /invalid|fails even with --force/,
  );
  rmSync(d, { recursive: true, force: true });
});

test("a valid empty file may be replaced without force", () => {
  const { d, c } = creds();
  const p = join(c, "code-agent.env");
  writeFileSync(p, "", { mode: 0o600 });
  const res = writeCredentialFile({ credentialsDir: c, triple: { role: "code-agent", user: "u", token: "t", password: "" }, force: false });
  assert.equal(res.action, "written");
  rmSync(d, { recursive: true, force: true });
});

test("errors never contain the credential value", () => {
  const { d, c } = creds();
  const p = join(c, "code-agent.env");
  writeFileSync(p, 'VBCDX_AGENTS_ROLE="code-agent"\nVBCDX_AGENTS_USER="u"\n', { mode: 0o600 }); // missing token/password
  try {
    writeCredentialFile({ credentialsDir: c, triple: { role: "code-agent", user: "u", token: "SUPERSECRET", password: "" }, force: true });
    assert.fail("should throw");
  } catch (err) {
    assert.doesNotMatch(err.message, /SUPERSECRET/);
  }
  rmSync(d, { recursive: true, force: true });
});
