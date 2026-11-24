// The service plans' own checks, reached through their public entry points: how a
// --control-plane connection string is split into parameters, the two servers' flag validation
// (a URL the URL parser itself refuses, and the missing-settings refusals), and the run line a
// plan carries when no unit is asked for. Every case passes values only: nothing is fetched,
// dialled or written, and the only addresses are the loopback literal the source itself uses
// and a reserved `.example` name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EXIT } from "../src/errors.js";
import { buildPlan, parseControlPlane, parseDispatch, parseKeyhole } from "../src/service/plan.js";

const PIN = `sha256:${"ab".repeat(32)}`;
const CONTROL_URL = "https://cp.example:8443";
const DISPATCH_RELEASE = { version: "0.1.0", package: "@vbcdx/dispatch", platform: "linux-x64-gnu",
  signature: { keyId: "0".repeat(16) },
  binaries: [{ name: "dispatch", sha256: "0".repeat(64), path: "/rel/dispatch", bytes: Buffer.alloc(0) }] };
// Keyhole's first release with `keyhole check` and --env-file (KEYHOLE_MIN).
const KEYHOLE_RELEASE = { version: "0.1.0-dev.2", package: "@vbcdx/keyhole", platform: "linux-x64-gnu",
  signature: { keyId: "0".repeat(16) },
  binaries: [{ name: "keyhole", sha256: "0".repeat(64), path: "/rel/keyhole", bytes: Buffer.alloc(0) }] };
const SYSTEM = { uid: 0, home: "/root", runtimeDir: null };
const web = { kind: "tcp", host: "127.0.0.1", port: 8080, text: "127.0.0.1:8080" };
const dispatch = { linkListen: "127.0.0.1:9001", controlUrl: CONTROL_URL, publicUrl: "http://127.0.0.1:8080" };
const CONTROL_CA = "-----BEGIN CERTIFICATE-----\nMIIBcontrolca\n-----END CERTIFICATE-----\n";
const keyhole = { linkListen: "127.0.0.1:9002", controlUrl: CONTROL_URL, controlCa: CONTROL_CA };
const base = { instance: "default", release: DISPATCH_RELEASE, serviceManager: "systemd", listen: null, start: true, host: SYSTEM };

/** Asserts `fn` refuses with exactly `message` under exit code `code`. */
function refused(fn, code, message) {
  assert.throws(fn, (e) => e.code === code && e.message === message);
}

// ── the control-plane connection string ──────────────────────────────────────

test("a query parameter with no '=' is kept as its own key", () => {
  // src/service/plan.js:63 — indexOf("=") is -1, so the whole piece is the key
  // The module validates vbcdx+https, auth=mtls and exactly one of pin=/ca=; the rest of the
  // grammar is the daemon's to check, so the value is accepted and returned as given.
  const value = `vbcdx+https://cp.example:8443?auth=mtls&pin=${PIN}&x`;
  assert.equal(parseControlPlane(value), value);
});

test("a query parameter with an empty value keeps the empty string", () => {
  // src/service/plan.js:65 — the piece after "=" is empty, so the value is ""
  const value = `vbcdx+https://cp.example:8443?auth=mtls&pin=${PIN}&xa=`;
  assert.equal(parseControlPlane(value), value);
});

// ── buildPlan's own guards ───────────────────────────────────────────────────

test("an unknown service name is refused before a service profile is looked up", () => {
  // src/service/plan.js:309
  refused(() => buildPlan({ ...base, service: "bogus" }), EXIT.CONFIG, "Unknown service: bogus.");
});

test("a launchd unit is refused: this version ships systemd units and --service none only", () => {
  // src/service/plan.js:312
  refused(() => buildPlan({ ...base, service: "sidecar", serviceManager: "launchd" }), EXIT.CONFLICT,
    "launchd units are not available in this version yet (Linux systemd and --service none are).");
});

test("a relative HOME cannot place a service's files", () => {
  // src/service/plan.js:314
  refused(() => buildPlan({ ...base, service: "sidecar", serviceManager: "none",
    host: { uid: 0, home: "relative/home", runtimeDir: null } }), EXIT.CONFIG, "HOME must be set to an absolute path.");
});

// ── dispatch-server ──────────────────────────────────────────────────────────

test("a --control-url the URL parser refuses is reported as the flag's own syntax", () => {
  // src/service/plan.js:422-424 — new URL("https://") throws, so cu is null and the check below refuses it
  refused(() => parseDispatch({ ...dispatch, controlUrl: "https://" }, web), EXIT.CONFIG,
    "--control-url takes https://<host>:<port>, with no path, query or credentials.");
});

test("a --public-url the URL parser refuses is reported as the flag's own syntax", () => {
  // src/service/plan.js:433-435 — the same catch for --public-url
  refused(() => parseDispatch({ ...dispatch, publicUrl: "https://" }, web), EXIT.CONFIG,
    "--public-url takes http(s)://<host>[:<port>], with no path.");
});

test("dispatch-server with no settings names both flags its control-plane mode needs", () => {
  // src/service/plan.js:484 — no dispatch object at all
  refused(() => buildPlan({ ...base, service: "dispatch-server", dispatch: null }), EXIT.CONFIG,
    "dispatch-server runs in control-plane mode: it needs --link-listen <host>:<port> (where vbcdx-control reaches it) "
    + "and --control-url https://<control host>:<port> (the control plane's tunnel listener).");
});

test("with --service none, dispatch-server's plan carries the run line that names its env file", () => {
  // src/service/plan.js:525
  const plan = buildPlan({ ...base, service: "dispatch-server", serviceManager: "none", start: false, dispatch });
  assert.equal(plan.unit, null);
  assert.equal(plan.start, false);
  // The same line as `${plan.csr[0]} serve, as vbcdx-dispatch, with ${plan.config_dir}/dispatch.env's settings in its environment`.
  assert.equal(plan.run, "/usr/local/lib/vbcdx/dispatch-server/0.1.0/dispatch serve, as vbcdx-dispatch, with "
    + "/etc/vbcdx-dispatch/default/dispatch.env's settings in its environment");
});

// ── keyhole-server ───────────────────────────────────────────────────────────

test("keyhole-server's --control-url the URL parser refuses is reported as the flag's own syntax", () => {
  // src/service/plan.js:564-566
  refused(() => parseKeyhole({ ...keyhole, controlUrl: "https://" }, web), EXIT.CONFIG,
    "--control-url takes https://<host>:<port>, with no path, query or credentials.");
});

test("keyhole-server's --public-url the URL parser refuses is reported as the flag's own syntax", () => {
  // src/service/plan.js:575-577
  refused(() => parseKeyhole({ ...keyhole, publicUrl: "https://" }, web), EXIT.CONFIG,
    "--public-url takes http(s)://<host>[:<port>], with no path.");
});

test("keyhole-server with no settings names every flag its control-plane mode needs", () => {
  // src/service/plan.js:634 — no keyhole object at all
  refused(() => buildPlan({ ...base, release: KEYHOLE_RELEASE, service: "keyhole-server", keyhole: null }), EXIT.CONFIG,
    "keyhole-server runs in control-plane mode: it needs --link-listen 127.0.0.1:<port> (where vbcdx-control on this host "
    + "reaches it), --control-url https://<control host>:<port> (the control plane's tunnel listener) and --control-ca <file> "
    + "(the control CA certificate, PEM).");
});

test("with --service none, keyhole-server's plan carries the run line and the control CA file", () => {
  // src/service/plan.js:686
  const plan = buildPlan({ ...base, release: KEYHOLE_RELEASE, service: "keyhole-server", serviceManager: "none", start: false, keyhole });
  assert.equal(plan.unit, null);
  assert.equal(plan.start, false);
  // The same line as `${plan.csr[0]} serve, as vbcdx-keyhole, with ${plan.config_dir}/keyhole.env's settings in its environment`.
  assert.equal(plan.run, "/usr/local/lib/vbcdx/keyhole-server/0.1.0-dev.2/keyhole serve, as vbcdx-keyhole, with "
    + "/etc/vbcdx-keyhole/default/keyhole.env's settings in its environment");
  assert.deepEqual(plan.files.map((f) => f.path), ["/etc/vbcdx-keyhole/default/keyhole.env",
    "/etc/vbcdx-keyhole/default/control-ca.pem"]);
  assert.equal(plan.files[1].text, CONTROL_CA);
});
