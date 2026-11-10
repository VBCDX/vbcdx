import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SECRET_PREFIXES, findSecretArg } from "../src/service/scan.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "vbcdx.js");
const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });

// For each token prefix, `vbcdx config service …` and `vbcdx install service …`
// exit 2 before parsing or any I/O, and the token is not in stderr or stdout.
const FORMS = [
  (t) => ["config", "service", "sidecar", "auth", "login", "token", t],
  (t) => ["config", "service", "sidecar", `--token=${t}`],
  // A message body is argv too: a token-shaped one is refused like any other.
  (t) => ["config", "service", "dispatch", "messages", "send", "ws_1", "--body", `here it is ${t}`],
  (t) => ["install", "service", "sidecar", "--from", `/x/${t}`],
  (t) => ["list", "services", `x,${t}`],
];

test("every token prefix in every position exits 2 and is never echoed", () => {
  for (const prefix of SECRET_PREFIXES) {
    const token = `${prefix}CANARY0123456789abcdef`;
    for (const form of FORMS) {
      const r = run(form(token));
      const where = `${prefix} in ${form("T").join(" ")}`;
      assert.equal(r.status, 2, where);
      assert.ok(!r.stderr.includes("CANARY") && !r.stdout.includes("CANARY"), `token echoed: ${where}`);
      assert.match(r.stderr, /Revoke that token/, where);
    }
  }
});

test("config service: the scan runs on the whole command line, before the prefix is cut off", () => {
  // The token is argument 6 of `config service sidecar users add <token>`. A scan of only the
  // sliced `sidecar …` (what vbcdx-svc gets) would call it argument 4.
  const r = run(["config", "service", "sidecar", "users", "add", "kh_live_CANARY0123456789abcdef"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /argument 6, kh_live_/);
  assert.ok(!r.stderr.includes("CANARY"));
});

test("the prefix list is the spec's, pinned here independently of the scanner", () => {
  // Written out again, so dropping a prefix from the scanner fails here instead of quietly
  // shrinking the per-prefix test above, which iterates the scanner's own list.
  assert.deepEqual([...SECRET_PREFIXES].sort(), [
    "kh_enr_", "kh_conn_", "kh_sc_", "kh_call_", "kh_live_",
    "dsp_agent_", "dsp_ws_", "dsp_enr_", "dsp_sc_", "dsp_call_", "dsp_inv_",
    // vbx_enr_: the control plane's one-time sidecar enrollment token.
    "vbx_call_", "vbx_enr_", "au_rt_",
  ].sort());
});

test("a postgres DSN with a password is refused; one without is not a secret", () => {
  assert.ok(findSecretArg(["--sidecar", "postgres://u:pw@db/x"]));
  assert.ok(findSecretArg(["postgresql://u:CANARY@h:5432/d"]));
  assert.ok(findSecretArg(["POSTGRES://u:CANARY@h/d"]), "the scheme is case-insensitive");
  assert.equal(findSecretArg(["postgres://db.internal/x", "postgres://u@db/x"]), null);
  const r = run(["config", "service", "sidecar", "auth", "connect", "local-db", "--dsn=postgres://u:CANARY@h/d"]);
  assert.equal(r.status, 2);
  assert.ok(!r.stderr.includes("CANARY"));
});

test("an ordinary argument is not mistaken for a secret", () => {
  assert.equal(findSecretArg(["install", "service", "sidecar", "--instance", "default", "--dry-run", "--json"]), null);
});

test("the scan runs before parsing: a secret beside an unknown command still exits 2 for the secret", () => {
  const r = run(["no-such-command", "kh_live_CANARY0123456789"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Revoke that token/);
});
