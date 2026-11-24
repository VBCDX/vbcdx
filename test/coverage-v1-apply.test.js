// Coverage drafts for src/service/apply.js (branches test/service-apply.test.js and the other
// service tests leave uncovered). Each test names the apply.js line(s) it reaches and asserts the
// observable behaviour of that branch. Harness patterns are copied from service-apply.test.js
// (`host`, `writeRelease`, `scripted`), service-tunnel.test.js (enroll) and
// service-dispatch-server.test.js (`dhost`, the real /bin/sh behind `runuser … /bin/sh -c`).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { keypair, signFile } from "./helpers/minisign-signer.js";
import { tempDir } from "./helpers/temp-dir.js";
import { planInstall, runService } from "../src/service/index.js";
import {
  applyInstall, backupClashes, configExec, doctorService, fileConflicts, lineDiff, listenInUse, newestVersion, planChanges,
  recordedInstances, serviceAction, validateRecord,
} from "../src/service/apply.js";
import { parseServiceArgs } from "../src/service/args.js";
import { fakeSystem } from "../src/service/system.js";
import { fakeAccounts } from "./helpers/fake-accounts.js";
import { EXIT, InstallerError } from "../src/errors.js";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const KEY = keypair(5);
const CONF = "/etc/vbcdx/default/sidecar.toml";
const UNIT = "/etc/systemd/system/vbcdx-sidecar-default.service";
const LEGACY = "/etc/vbcdx/default/modules.toml";
const SERVICE = "vbcdx-sidecar-default.service";

// ---- sidecar harness (service-apply.test.js) -------------------------------------------------
function writeRelease(root, version, binBase = root) {
  mkdirSync(root, { recursive: true });
  const files = {};
  for (const name of ["vbcdx-sidecar", "vbcdx-svc"]) {
    const rel = `@vbcdx/sidecar-linux-x64-gnu/bin/${name}`;
    mkdirSync(join(binBase, dirname(rel)), { recursive: true });
    const body = Buffer.from(`#!/bin/sh\n# ${name} ${version}\n`);
    writeFileSync(join(binBase, rel), body, { mode: 0o755 });
    files[rel] = sha(body);
  }
  const sums = Buffer.from(JSON.stringify({ schema: 1, package: "@vbcdx/sidecar", version, files }));
  writeFileSync(join(root, "checksums.json"), sums);
  writeFileSync(join(root, "checksums.json.minisig"), signFile(KEY, sums, `vbcdx-release @vbcdx/sidecar ${version}`));
  return root;
}
const release = (version = "0.1.0") => writeRelease(tempDir("vbcdx-rel-"), version);

function host({ uid = 0, active = "active", gid = process.getgid(), check = () => ({}), runtimeDir = "/run/user/1000" } = {}) {
  const root = tempDir("vbcdx-host-");
  const home = uid === 0 ? "/root" : "/home/u";
  const acct = fakeAccounts({ gid });
  const unit = { active };
  const sys = fakeSystem(root, { uid, answer: (cmd, args) => {
    const a = acct.answer(cmd, args);
    if (a) return a;
    if (args.includes("check")) return check(cmd, args);
    if (cmd === "systemctl" && args.includes("is-active")) return { stdout: `${unit.active}\n` };
    return {};
  } });
  return { acct, sys, root, unit, deps: { sys, trustedKeys: [KEY.pub], platformId: "linux-x64-gnu",
    host: { uid, home, runtimeDir: uid === 0 ? null : runtimeDir } } };
}
const run = (argv, h) => runService(parseServiceArgs(argv), h.deps);
const install = (h, rel, extra = []) => run(["install", "service", "sidecar", "--from", rel, ...extra], h);
const planOf = (h, extra = []) => planInstall(parseServiceArgs(["install", "service", "sidecar", "--from", release(), ...extra]), h.deps).plan;
const at = (h, p) => join(h.root, p);
const calls = (h, cmd) => h.sys.calls.filter((c) => c[0] === cmd).map((c) => c.slice(1).join(" "));
const recFile = (h, home = "/root") => at(h, `${home}/.vbcdx/manifests/installation.json`);
const sidecarRecord = (h) => JSON.parse(readFileSync(recFile(h), "utf8")).services["sidecar:default"];
function editRecord(h, fn, { home = "/root", k = "sidecar:default" } = {}) {
  const m = JSON.parse(readFileSync(recFile(h, home), "utf8"));
  fn(m.services[k], m);
  writeFileSync(recFile(h, home), JSON.stringify(m));
}
const edit = (h, p, line = "# local edit\n") => writeFileSync(at(h, p), readFileSync(at(h, p), "utf8") + line);

// Put `fn` in front of the host's command runner. fn returns undefined to let the host answer, or
// a result (merged over the success default and recorded like any other call).
function intercept(h, fn) {
  const inner = h.sys.run;
  h.sys.run = (cmd, args, o) => {
    const r = fn(cmd, args, o);
    if (r === undefined) return inner(cmd, args, o);
    h.sys.calls.push([cmd, ...args]);
    h.sys.opts.push(o || {});
    return { status: 0, stdout: "", stderr: "", ...r };
  };
}

// After install starts the unit, it waits on the fake clock (service-apply.test.js `scripted`).
function scripted({ script, journal = "", uid = 0 } = {}) {
  const h = host({ uid });
  let started = null;
  h.sys.run = ((orig) => (cmd, args, o) => {
    if (cmd === "systemctl" && args.includes("enable") && args.includes("--now")) started = h.sys.clock.t;
    if (cmd === "systemctl" && started !== null && (args.includes("is-active") || args.includes("show"))) {
      h.sys.calls.push([cmd, ...args]);
      const s = script(h.sys.clock.t - started);
      return { status: 0, stdout: `${args.includes("is-active") ? s.state : s.restarts}\n`, stderr: "" };
    }
    if (cmd === "journalctl") {
      h.sys.calls.push([cmd, ...args]);
      return { status: 0, stdout: journal, stderr: "" };
    }
    return orig(cmd, args, o);
  })(h.sys.run);
  return h;
}

// ---- control-plane tunnel pieces (service-tunnel.test.js) ------------------------------------
const PIN = `sha256:${"ab".repeat(32)}`;
const CP = `vbcdx+https://cp.example:8443?auth=mtls&pin=${PIN}`;
const TOKEN = ["vbx", "enr", "canary7f3"].join("_");   // assembled: a whole token literal trips the leak guard
const line = (o) => ({ stdout: `${JSON.stringify(o)}\n` });
const enrollOut = (id = "sc_7f3") => line({ changed: true, data: { sidecar_id: id, replaced: null, state: "/var/lib/vbcdx/default/tunnel" } });
const TUNNEL = "/var/lib/vbcdx/default/tunnel";
// A sidecar host whose `enroll` is answered by `enroll()`; a successful one writes the tunnel
// credentials, as the daemon does.
function enrollHost(enroll = () => enrollOut(), extra = {}) {
  const h = host(extra);
  h.deps.readStdin = () => Buffer.from(`${TOKEN}\n`);
  intercept(h, (cmd, args) => {
    if (!args.includes("enroll")) return undefined;
    const r = enroll(cmd, args);
    if (!r.status) {
      mkdirSync(at(h, TUNNEL), { recursive: true });
      writeFileSync(at(h, join(TUNNEL, "client.key")), "k");
    }
    return r;
  });
  return h;
}
const enrollArgs = ["--control-plane", CP, "--enroll-token-stdin"];

// ---- dispatch-server harness (service-dispatch-server.test.js) -------------------------------
const STATE = "/var/lib/vbcdx-dispatch/default";
const CP_MODE = ["--link-listen", "0.0.0.0:8443", "--control-url", "https://10.0.0.5:8443"];
const CERT = "-----BEGIN CERTIFICATE-----\nMIIBleaf\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nMIIBca\n-----END CERTIFICATE-----\n";
function dispatchRelease(version = "0.1.0") {
  const root = tempDir("vbcdx-drel-");
  const rel = "@vbcdx/dispatch-linux-x64-gnu/bin/dispatch";
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  const body = Buffer.from(`\x7fELF dispatch ${version}\n`);
  writeFileSync(join(root, rel), body, { mode: 0o755 });
  const sums = Buffer.from(JSON.stringify({ schema: 1, package: "@vbcdx/dispatch", version, files: { [rel]: sha(body) } }));
  writeFileSync(join(root, "checksums.json"), sums);
  writeFileSync(join(root, "checksums.json.minisig"), signFile(KEY, sums, `vbcdx-release @vbcdx/dispatch ${version}`));
  return root;
}
function dhost({ check = () => ({ stdout: "dispatch check: ok (control-plane mode)\n" }), active = "active" } = {}) {
  const root = tempDir("vbcdx-dhost-");
  const acct = fakeAccounts({ gid: process.getgid() });
  const sys = fakeSystem(root, { uid: 0, answer: (cmd, args, o) => {
    const a = acct.answer(cmd, args);
    if (a) return a;
    if (cmd === "runuser" && args.includes("csr")) {
      const key = args[args.indexOf("--key-out") + 1];
      const csr = args[args.indexOf("--csr-out") + 1];
      if (existsSync(join(root, key)) || existsSync(join(root, csr))) return { status: 1, stderr: "dispatch: exists; give a new path\n" };
      writeFileSync(join(root, key), "KEY", { mode: 0o600 });
      writeFileSync(join(root, csr), "-----BEGIN CERTIFICATE REQUEST-----\n", { mode: 0o644 });
      return {};
    }
    // A shell step as the service user (apply.js asServiceUser): run for real, as this test's user.
    if (cmd === "runuser" && args[3] === "/bin/sh") {
      const r = spawnSync("/bin/sh", args.slice(4), { input: o && o.input, encoding: "utf8" });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    }
    if (args.includes("check")) return check(cmd, args);
    if (cmd === "systemctl" && args.includes("is-active")) return { stdout: `${active}\n` };
    return {};
  } });
  return { acct, sys, root, deps: { sys, trustedKeys: [KEY.pub], platformId: "linux-x64-gnu", host: { uid: 0, home: "/root", runtimeDir: null } } };
}
const dinstall = (h, rel, extra = []) => run(["install", "service", "dispatch-server", "--from", rel, ...CP_MODE, ...extra], h);
const certFile = (text = CERT) => {
  const p = join(tempDir("vbcdx-dcert-"), "dispatch.crt");
  writeFileSync(p, text);
  return p;
};
// The shell scripts asServiceUser runs (apply.js CERT_*), told apart by their text.
const isWrite = (script) => script.startsWith("umask 077");
const isUndo = (script) => script.startsWith("if [ -e");
const isDone = (script) => script === 'rm -f -- "$1.vbcdx-prev"';
const shellStep = (pick, result) => (cmd, args) => (cmd === "runuser" && args[3] === "/bin/sh" && pick(args[5]) ? result : undefined);

// ================================================================================================
// must() / checkConfig() / asServiceUser() / enroll: failures with and without stderr
// ================================================================================================

// apply.js 43:210-214: a failing command with no stderr gives one line, not a stderr line too.
test("apply.js 43: a failed step that printed nothing on stderr has only its own headline line", () => {
  const h = host();
  intercept(h, (cmd) => (cmd === "useradd" ? { status: 1 } : undefined));
  assert.throws(() => install(h, release()), (e) => e instanceof InstallerError && e.code === EXIT.SUBPROCESS
    && e.message === "creating the vbcdx user failed (useradd exited 1)."
    && JSON.stringify(e.details.lines) === JSON.stringify(["creating the vbcdx user failed (useradd exited 1)."]));
  // With stderr: its last line is added.
  const w = host();
  intercept(w, (cmd) => (cmd === "useradd" ? { status: 1, stderr: "useradd: warm up\nuseradd: cannot lock /etc/passwd\n" } : undefined));
  assert.throws(() => install(w, release()), (e) => e.code === EXIT.SUBPROCESS
    && JSON.stringify(e.details.lines) === JSON.stringify(["creating the vbcdx user failed (useradd exited 1).", "useradd: cannot lock /etc/passwd"]));
});

// apply.js 61:61-65 and 63:65-69: the daemon's check refuses but says nothing on stderr.
test("apply.js 61/63: a daemon check that refuses with no stderr is exit 6 with the headline line only", () => {
  for (const uid of [0, 1000]) {
    const h = host({ uid, check: () => ({ status: 2 }) });
    assert.throws(() => install(h, release()), (e) => e.code === EXIT.SUBPROCESS
      && e.message === "The sidecar refuses the config install wrote (vbcdx-sidecar check exited 2); nothing was started."
      && JSON.stringify(e.details.lines) === JSON.stringify([e.message]), `uid ${uid}`);
    assert.equal(calls(h, "systemctl").length, 0, "no unit was loaded");
  }
});

// apply.js 70:23-73:4: asServiceUser fails, with and without stderr (dispatch-server link certificate).
test("apply.js 70-73: a certificate step that fails as the service user is exit 6 naming the step, the user and the exit", () => {
  for (const [result, lines] of [
    [{ status: 3, stderr: "sh: link.crt.vbcdx-new: Permission denied\n" }, ["sh: link.crt.vbcdx-new: Permission denied"]],
    [{ status: 3 }, []],
  ]) {
    const h = dhost();
    dinstall(h, dispatchRelease());
    intercept(h, shellStep(isWrite, result));
    const head = "writing the link certificate failed (as vbcdx-dispatch, exit 3).";
    assert.throws(() => dinstall(h, dispatchRelease(), ["--service-cert", certFile()]), (e) => e.code === EXIT.SUBPROCESS
      && e.message === head && JSON.stringify(e.details.lines) === JSON.stringify([head, ...lines]), JSON.stringify(result));
    assert.ok(!existsSync(at(h, `${STATE}/link.crt`)), "no certificate is left behind");
  }
});

// apply.js 148: applyInstall called with a token but a plan that has no control plane to enroll with.
test("apply.js 148: a token with a plan that has no enroll step is refused (exit 5) and nothing is left", () => {
  const h = host();
  const rel = release();
  const token = Buffer.from(TOKEN);
  const p = planOf(h);
  assert.ok(!p.enroll, "the plan has no enroll step");
  assert.throws(() => applyInstall(p, h.sys, { token }), (e) => e.code === EXIT.CONFLICT
    && e.message === "An enrollment token was given but this install has no control plane to enroll with.");
  assert.ok(!existsSync(at(h, CONF)), "the config was taken out again");
  assert.ok(!h.acct.users.has("vbcdx"), "the user this run created is gone");
  assert.ok(!h.sys.calls.some((c) => c.includes("enroll")), "nothing was run as an enroll");
  // Already in place: the same refusal, and the record is untouched.
  install(h, rel);
  const before = readFileSync(recFile(h), "utf8");
  const n = h.sys.calls.length;
  assert.throws(() => applyInstall(planOf(h), h.sys, { token }), (e) => e.code === EXIT.CONFLICT && /no control plane to enroll with/.test(e.message));
  assert.equal(readFileSync(recFile(h), "utf8"), before);
  assert.ok(!h.sys.calls.slice(n).some((c) => c.includes("enroll")));
});

// apply.js 153:73-77 and 156:67-71: enroll exits non-zero with nothing on stderr.
test("apply.js 153/156: an enroll that fails with no stderr is exit 6 with the headline line only; status 5 adds the token-and-force hint", () => {
  const h = enrollHost(() => ({ status: 3 }));
  assert.throws(() => install(h, release(), enrollArgs), (e) => e.code === EXIT.SUBPROCESS
    && e.message === "vbcdx-sidecar enroll exited 3; nothing was started." && JSON.stringify(e.details.lines) === JSON.stringify([e.message]));
  assert.ok(!existsSync(at(h, CONF)), "the install was undone");
  const five = enrollHost(() => ({ status: 5, stderr: "vbcdx-sidecar: already enrolled\n" }));
  // The remedy must be executable by the reader of a system install, which is root: the state dir
  // belongs to the unit user (so a bare enroll as root fails its ownership check) and --token-file
  // refuses a file root owns, so root pipes the token in and runs it as the unit user.
  const direct = `${at(five, "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-sidecar")} enroll --instance default --instance-dir /etc/vbcdx/default --token-stdin --force < <token-file>.`;
  assert.throws(() => install(five, release(), enrollArgs), (e) => e.code === EXIT.SUBPROCESS
    && e.message === `vbcdx-sidecar enroll exited 5; nothing was started. An enrolled sidecar is refused: to replace its identity, get a new one-time token from a control-plane operator (minted on the control host with vbcdx-control sidecars enroll-token), then re-enroll with sudo runuser -u vbcdx -- ${direct} --force replaces the existing identity.`
    && !e.message.includes("--token-file")
    && e.details.lines.at(-1) === "vbcdx-sidecar: already enrolled");
});

// apply.js 158:88-90: a user-scope install runs the daemon as itself, so the remedy is the direct
// command with the token on stdin: no runuser, no sudo, and no --token-file for a file it may not own.
test("apply.js 158: a user-scope refused enroll names the direct command, not runuser", () => {
  const h = enrollHost(() => ({ status: 5, stderr: "vbcdx-sidecar: already enrolled\n" }), { uid: 1000 });
  assert.throws(() => install(h, release(), enrollArgs), (e) => e.code === EXIT.SUBPROCESS
    && !e.message.includes("runuser") && !e.message.includes("sudo")
    && !e.message.includes("--token-file")
    && /enroll --instance default --instance-dir \S+ --token-stdin --force < <token-file>\. --force replaces the existing identity\.$/.test(e.message));
});

// apply.js 161:49-70: enroll succeeded but its data carries no sidecar_id.
test("apply.js 161: an enroll whose data has no sidecar_id is reported as (no id reported)", () => {
  const h = enrollHost(() => line({ changed: true, data: {} }));
  const r = install(h, release(), enrollArgs).report;
  assert.equal(r.changed, true);
  assert.equal(r.enrolled, "(no id reported)");
});

// apply.js 200:48-62, 201:50-67, 201:119-124: a step after enroll fails with a plain Error
// (no code, no details): it becomes an exit-6 InstallerError that names the spent token.
test("apply.js 200/201: a plain error after a successful enroll becomes exit 6, names the spent token and the id to revoke", () => {
  const h = enrollHost();
  let reloads = 0;
  intercept(h, (cmd, args) => {
    if (cmd === "systemctl" && args.includes("daemon-reload") && (reloads += 1) === 1) throw new Error("kaboom");
    return undefined;
  });
  const extra = "The sidecar had enrolled as sc_7f3 with a token that is now spent; its tunnel credentials were removed. "
    + "Revoke it on the control host (vbcdx-control sidecars revoke sc_7f3 --yes) and use a new token.";
  assert.throws(() => install(h, release(), enrollArgs), (e) => e instanceof InstallerError && e.code === EXIT.SUBPROCESS
    && e.message === `kaboom ${extra}` && JSON.stringify(e.details.lines) === JSON.stringify(["kaboom", extra]));
  assert.ok(!existsSync(at(h, TUNNEL)), "the tunnel credentials this run wrote are gone");
  assert.ok(!existsSync(at(h, CONF)), "the install was undone");
});

// ================================================================================================
// the wait after start
// ================================================================================================

// apply.js 223:67-72 and 223:81-93: is-active prints nothing, so the state is "unknown".
test("apply.js 223: a unit whose is-active prints nothing is state unknown, and install refuses at the deadline", () => {
  const h = host();
  intercept(h, (cmd, args) => (cmd === "systemctl" && args.includes("is-active") ? { stdout: "" } : undefined));
  assert.throws(() => install(h, release()), (e) => e.code === EXIT.SUBPROCESS && /\(it is unknown\)/.test(e.message));
  assert.ok(!existsSync(at(h, CONF)), "the install was undone");
});

// apply.js 357:55-66: the journal hint for a user unit says --user (no daemon line was found).
test("apply.js 357: a user unit that did not start without a daemon line points at journalctl --user", () => {
  const h = scripted({ uid: 1000, script: () => ({ state: "failed", restarts: "0" }), journal: "systemd: something unrelated\n" });
  const hint = `See journalctl --user -u ${SERVICE}.`;
  assert.throws(() => install(h, release()), (e) => e.code === EXIT.SUBPROCESS
    && e.message === `${SERVICE} did not start (it is failed); the install was undone. ${hint}`
    && JSON.stringify(e.details.lines) === JSON.stringify([`${SERVICE} did not start (it is failed); the install was undone.`, hint]));
});

// apply.js 313:34-75 and 313:119-130: starting the previous version fails too, reset-failed also
// failed, and the unit is a user unit.
test("apply.js 313: a user unit whose previous version will not start again names reset-failed and systemctl --user", () => {
  const h = host({ uid: 1000 });
  install(h, release("0.1.0"));
  let failing = false;
  let restarts = 0;
  intercept(h, (cmd, args) => {
    if (cmd !== "systemctl") return undefined;
    if (args.includes("is-active")) return { stdout: failing ? "failed\n" : "active\n" };
    if (failing && args.includes("reset-failed")) return { status: 1, stderr: "reset-failed: nope\n" };
    // The first restart is the new version's; the undo's is the one that fails.
    if (failing && args.includes("restart")) return (restarts += 1) === 1 ? {} : { status: 1, stderr: "restart: nope\n" };
    return undefined;
  });
  failing = true;
  assert.throws(() => install(h, release("0.2.0")), (e) => e.code === EXIT.SUBPROCESS && /did not start/.test(e.message)
    && e.message.includes(`Starting 0.1.0 again failed too (systemctl restart exited 1; reset-failed exited 1): check systemctl --user status ${SERVICE}.`));
  const c = calls(h, "systemctl");
  assert.ok(c.includes(`--user reset-failed ${SERVICE}`), c.join("|"));
});

// ================================================================================================
// listenInUse
// ================================================================================================

const ssFor = (...locals) => ({ run: () => ({ status: 0, stdout: `${locals.map((l) => `LISTEN 0 4096 ${l} 0.0.0.0:*`).join("\n")}\n`, stderr: "" }) });
const tcpPlan = (listen) => ({ start: true, unit: { name: SERVICE }, listen, files: [{ sha256: "x" }] });

// apply.js 285:23-35: `ss` itself fails: it says nothing, whatever it printed.
test("apply.js 285: a failing ss is never trusted: listenInUse says nothing", () => {
  const sys = { run: () => ({ status: 1, stdout: "LISTEN 0 4096 127.0.0.1:7777 0.0.0.0:*\n", stderr: "ss: boom" }) };
  assert.equal(listenInUse(sys, tcpPlan("127.0.0.1:7777"), null), null);
  // The same listener with ss working is a conflict (so the null above is the status check).
  assert.match(listenInUse(ssFor("127.0.0.1:7777"), tcpPlan("127.0.0.1:7777"), null), /^--listen 127\.0\.0\.1:7777 \(in use: something already listens on 127\.0\.0\.1:7777\)$/);
});

// apply.js 289:102-141: a localhost listen clashes with a loopback listener of either family.
test("apply.js 289: --listen localhost:<port> is held by a listener on 127.0.0.1 or [::1], not by another address", () => {
  const plan = tcpPlan("localhost:7777");
  assert.equal(listenInUse(ssFor("127.0.0.1:7777"), plan, null),
    "--listen localhost:7777 (in use: something already listens on 127.0.0.1:7777)");
  assert.equal(listenInUse(ssFor("[::1]:7777"), plan, null),
    "--listen localhost:7777 (in use: something already listens on [::1]:7777)");
  assert.equal(listenInUse(ssFor("10.0.0.5:7777"), plan, null), null, "another address is not localhost");
  assert.equal(listenInUse(ssFor("127.0.0.1:7778"), plan, null), null, "another port is not held");
});

// ================================================================================================
// validateRecord / readServices
// ================================================================================================

// apply.js 414:109-115: a record whose listen is not a string.
test("apply.js 414: a record with a non-string listen is refused as an unexpected listen", () => {
  const h = host();
  install(h, release());
  const rec = sidecarRecord(h);
  assert.equal(validateRecord("sidecar:default", rec, { scope: "system", home: "/root" }), rec, "the untouched record passes");
  for (const bad of [null, 7, ["127.0.0.1:1"]]) {
    assert.throws(() => validateRecord("sidecar:default", { ...rec, listen: bad }, { scope: "system", home: "/root" }),
      (e) => e.code === EXIT.FILESYSTEM && /unexpected listen;/.test(e.message), JSON.stringify(bad));
  }
});

// apply.js 432:30-38: the record path can't be read for a reason other than "absent".
test("apply.js 432: a record path under a regular file (ENOTDIR) is an error, not an empty record", () => {
  const root = tempDir("vbcdx-rec-");
  const sys = fakeSystem(root);
  writeFileSync(join(root, "root"), "not a directory");
  assert.throws(() => recordedInstances(sys, { scope: "system", home: "/root" }), (e) => e.code === "ENOTDIR");
  // Contrast: with no such path at all the record is simply empty.
  assert.deepEqual(recordedInstances(fakeSystem(tempDir("vbcdx-rec-")), { scope: "system", home: "/root" }), []);
});

// ================================================================================================
// no-op and remove of an instance installed with --service none (no unit)
// ================================================================================================

// apply.js 482:81-85: sameAsRecorded for a plan with no unit.
test("apply.js 482: a --service none instance reinstalled with the same arguments is changed:false and runs nothing", () => {
  const h = host();
  const rel = release();
  assert.equal(install(h, rel, ["--service", "none"]).report.changed, true);
  assert.equal(sidecarRecord(h).unit, null);
  const n = h.sys.calls.length;
  assert.equal(install(h, rel, ["--service", "none"]).report.changed, false);
  assert.equal(h.sys.calls.length, n, "no command ran");
});

// apply.js 1048:99-103 and 1103:119-125: remove and list for a record with no unit.
test("apply.js 1048/1103: a --service none instance lists as 'no unit' and remove neither stops nor disables anything", () => {
  const h = host();
  install(h, release(), ["--service", "none"]);
  const [s] = run(["list", "services"], h).report.services;
  assert.deepEqual([s.unit, s.state], [null, "no unit"]);
  const n = h.sys.calls.length;
  const r = run(["remove", "service", "sidecar"], h).report;
  assert.equal(r.removed, true);
  assert.ok(!r.actions.some((a) => /^stop|disable/.test(a)), r.actions.join("|"));
  assert.deepEqual(h.sys.calls.slice(n).filter((c) => c[0] === "systemctl"), [], "systemctl was never called");
  assert.ok(!existsSync(at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0")));
});

// apply.js 1101:72-84 and 1101:93-105: is-active prints nothing, or only whitespace.
test("apply.js 1101: list services shows state unknown when is-active prints nothing or only a newline", () => {
  for (const stdout of ["", "\n", "  \n"]) {
    const h = host();
    install(h, release());
    intercept(h, (cmd, args) => (cmd === "systemctl" && args.includes("is-active") ? { stdout } : undefined));
    assert.deepEqual(run(["list", "services"], h).report.services.map((s) => [s.instance, s.state]), [["default", "unknown"]], JSON.stringify(stdout));
  }
});

// ================================================================================================
// makeDir / fileConflicts / backupClashes / planChanges / lineDiff
// ================================================================================================

// apply.js 534:30-38: lstat of a level install owns fails with something other than ENOENT.
test("apply.js 534: a level whose parent is a regular file (ENOTDIR) fails the install and leaves the host as it found it", () => {
  const h = host();
  mkdirSync(at(h, "/usr/local"), { recursive: true });
  writeFileSync(at(h, "/usr/local/lib"), "a file where a directory belongs");
  assert.throws(() => install(h, release()), (e) => !(e instanceof InstallerError) && e.code === "ENOTDIR");
  assert.ok(!h.acct.users.has("vbcdx"), "the user this run created is gone");
  assert.ok(calls(h, "userdel").length > 0);
  assert.ok(!existsSync(at(h, "/var/lib/vbcdx")) && !existsSync(at(h, CONF)));
});

// apply.js 607:31-36: a record with no files list.
test("apply.js 607: fileConflicts against a record without files treats a differing file on disk as a conflict", () => {
  const h = host();
  const plan = planOf(h);
  mkdirSync(dirname(at(h, CONF)), { recursive: true });
  writeFileSync(at(h, CONF), "# someone else's config\n");
  assert.deepEqual(fileConflicts(h.sys, plan, {}), { conflicts: [CONF], keep: [] });
  assert.deepEqual(fileConflicts(h.sys, plan, undefined), { conflicts: [CONF], keep: [] });
});

// apply.js 618:32-40 and 643:45-645:6: lstat fails with something other than ENOENT.
test("apply.js 618/643: fileConflicts and backupClashes rethrow an lstat error that is not ENOENT", () => {
  const h = host();
  const plan = planOf(h);
  assert.deepEqual(backupClashes(h.sys, [CONF]), [], "nothing there: no clash");
  mkdirSync(at(h, "/etc"), { recursive: true });
  writeFileSync(at(h, "/etc/vbcdx"), "a file where the config directory belongs");
  assert.throws(() => fileConflicts(h.sys, plan, undefined), (e) => e.code === "ENOTDIR");
  assert.throws(() => backupClashes(h.sys, [CONF]), (e) => e.code === "ENOTDIR");
});

// apply.js 667:45-57 and 673:52-57: planChanges with a directory at a file's path, and with a
// record that has no files list (or no record).
test("apply.js 667/673: planChanges reads no directory, and copes with a record without files", () => {
  const h = host();
  const plan = planOf(h);
  mkdirSync(at(h, CONF), { recursive: true });
  for (const rec of [null, {}]) {
    const { files } = planChanges(h.sys, plan, rec);
    assert.deepEqual(files.find((f) => f.path === CONF), { path: CONF, diff: null }, `a directory at the config path is not read (${JSON.stringify(rec)})`);
  }
  // A regular file the record doesn't name was edited by the user: named by the CONFLICT line, never diffed.
  rmSync(at(h, CONF), { recursive: true });
  writeFileSync(at(h, CONF), "# user's own\n");
  for (const rec of [null, {}]) {
    const paths = planChanges(h.sys, plan, rec).files.map((f) => f.path);
    assert.ok(!paths.includes(CONF), `the edited config is not listed (${JSON.stringify(rec)})`);
    assert.ok(paths.includes(UNIT), "a file that is absent still is");
  }
});

// apply.js 724:24-47: the old text has lines left after the new text is used up.
test("apply.js 724: lineDiff of a longer old text against a shorter new one ends with the removed lines", () => {
  assert.deepEqual(lineDiff("a\nb\nc\n", "a\n"), ["-b", "-c"]);
  assert.deepEqual(lineDiff("a\nb\nc\n", "a\nc\nd\n"), ["-b", "+d"]);
});

// apply.js 736:109-117: two edited files that the install would change.
test("apply.js 736: two edited files an install would change are refused together, named in one message", () => {
  const h = host();
  install(h, release("0.1.0"));
  edit(h, CONF);
  edit(h, UNIT, "# local unit edit\n");
  const confBefore = readFileSync(at(h, CONF));
  const unitBefore = readFileSync(at(h, UNIT));
  assert.throws(() => install(h, release("0.2.0"), ["--listen", "127.0.0.1:7781"]), (e) => e.code === EXIT.CONFLICT
    && e.message.startsWith("Edited since install, and this install would change them: ")
    && e.message.includes(`${CONF}, ${UNIT}`) && !/would change it:/.test(e.message));
  assert.deepEqual(readFileSync(at(h, CONF)), confBefore);
  assert.deepEqual(readFileSync(at(h, UNIT)), unitBefore);
  assert.equal(sidecarRecord(h).version, "0.1.0");
});

// apply.js 758:92-101: two earlier --force copies are in the way.
test("apply.js 758: --force with two existing <file>.vbcdx-old copies is refused with the plural 'already exist'", () => {
  const h = host();
  const rel = release();
  install(h, rel);
  edit(h, CONF);
  edit(h, UNIT, "# local unit edit\n");
  run(["remove", "service", "sidecar"], h);
  writeFileSync(at(h, `${CONF}.vbcdx-old`), "# earlier copy of the config\n");
  writeFileSync(at(h, `${UNIT}.vbcdx-old`), "# earlier copy of the unit\n");
  assert.throws(() => install(h, rel, ["--force"]), (e) => e.code === EXIT.CONFLICT
    && e.message.startsWith(`${CONF}.vbcdx-old, ${UNIT}.vbcdx-old already exist (an earlier --force saved a copy there), so --force would overwrite it.`));
  assert.equal(readFileSync(at(h, `${CONF}.vbcdx-old`), "utf8"), "# earlier copy of the config\n");
  assert.equal(readFileSync(at(h, `${UNIT}.vbcdx-old`), "utf8"), "# earlier copy of the unit\n");
});

// ================================================================================================
// undo steps that themselves fail
// ================================================================================================

// apply.js 785:15-52: an undo step of the in-place certificate path fails; the original error stays.
test("apply.js 785: a failing undo step of the certificate step never replaces the error that stopped the install", () => {
  const h = dhost({ active: "inactive", check: () => ({ status: 1, stderr: "dispatch: private key does not match public key\n" }) });
  dinstall(h, dispatchRelease());
  intercept(h, shellStep(isUndo, { status: 1, stderr: "mv: cannot move\n" }));
  assert.throws(() => dinstall(h, dispatchRelease(), ["--service-cert", certFile()]), (e) => e.code === EXIT.SUBPROCESS
    && /refuses the config install wrote/.test(e.message) && e.details.lines.includes("dispatch: private key does not match public key"));
  assert.ok(h.sys.calls.some((c) => c[0] === "runuser" && c[4] === "/bin/sh" && isUndo(c[6])), "the undo was tried");
  assert.ok(existsSync(at(h, `${STATE}/link.crt`)), "its failure is why the certificate is still there");
});

// apply.js 902:11-97: dropping the saved previous certificate fails after a good install.
test("apply.js 902: a failing drop of the saved previous certificate does not fail the install; the leftover is harmless", () => {
  const h = dhost();
  dinstall(h, dispatchRelease(), ["--service-cert", certFile()]);
  const NEW = CERT.replace("MIIBleaf", "MIIBnewleaf");
  intercept(h, shellStep(isDone, { status: 1, stderr: "rm: cannot remove\n" }));
  const r = dinstall(h, dispatchRelease("0.2.0"), ["--service-cert", certFile(NEW)]);
  assert.equal(r.code, 0);
  assert.equal(r.report.upgraded_from, "0.1.0");
  assert.equal(r.report.started, true);
  assert.ok(h.sys.calls.some((c) => c[0] === "runuser" && c[4] === "/bin/sh" && isDone(c[6])), "the drop was tried");
  assert.equal(readFileSync(at(h, `${STATE}/link.crt`), "utf8"), NEW);
  assert.equal(readFileSync(at(h, `${STATE}/link.crt.vbcdx-prev`), "utf8"), CERT, "the leftover is the old certificate");
  assert.equal(JSON.parse(readFileSync(recFile(h), "utf8")).services["dispatch-server:default"].version, "0.2.0");
});

// apply.js 915:11-48: an undo step of a failed install throws; the steps before it still run.
test("apply.js 915: an undo step that throws neither replaces the install's error nor stops the remaining undo steps", () => {
  const h = scripted({ script: () => ({ state: "failed", restarts: "0" }) });
  intercept(h, (cmd, args) => {
    if (cmd === "systemctl" && args.includes("disable")) {
      h.sys.calls.push([cmd, ...args]);
      throw new Error("systemctl vanished");
    }
    return undefined;
  });
  assert.throws(() => install(h, release()), (e) => e instanceof InstallerError && e.code === EXIT.SUBPROCESS && /did not start/.test(e.message));
  assert.ok(calls(h, "systemctl").includes(`disable --now ${SERVICE}`), "the throwing step was reached");
  assert.ok(!existsSync(at(h, CONF)), "the config restorer after it still ran");
  assert.ok(!existsSync(at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0")), "so did the version directory's");
  assert.ok(!h.acct.users.has("vbcdx"), "and the created user's");
});

// ================================================================================================
// newestVersion
// ================================================================================================

// apply.js 943:28-37 and 946:33-36: equal versions, and a larger pre-release in the first argument.
test("apply.js 943/946: newestVersion with equal versions, and with pre-releases given in either order", () => {
  assert.equal(newestVersion(["1.0.0", "1.0.0"]), "1.0.0");
  assert.equal(newestVersion(["2.0.0", "1.0.0", "1.0.0"]), "2.0.0");
  assert.equal(newestVersion(["1.0.0-rc.1", "1.0.0-rc.1"]), "1.0.0-rc.1");
  assert.equal(newestVersion(["1.0.0-beta", "1.0.0-alpha"]), "1.0.0-beta");
  assert.equal(newestVersion(["1.0.0-alpha", "1.0.0-beta"]), "1.0.0-beta");
  assert.equal(newestVersion(["1.0.0-beta", "1.0.0-alpha", "1.0.0-beta"]), "1.0.0-beta");
});

// ================================================================================================
// doctor
// ================================================================================================

// apply.js 1120:7-1122:6: the state directory can't be stat'ed.
test("apply.js 1120: doctor fails 'state dir 0700' when the state directory is gone", () => {
  const h = host();
  install(h, release());
  const ok = () => run(["doctor", "--service", "sidecar"], h).report.checks.find((c) => c.check === "state dir 0700");
  assert.equal(ok().ok, true);
  rmSync(at(h, "/var/lib/vbcdx/default"), { recursive: true });
  assert.deepEqual(ok(), { check: "state dir 0700", ok: false, detail: "/var/lib/vbcdx/default" });
});

// apply.js 1130:44-50: link.key is not a regular file.
test("apply.js 1130: doctor does not take a directory for the link key", () => {
  const h = dhost();
  dinstall(h, dispatchRelease());
  const keyOk = () => run(["doctor", "--service", "dispatch-server"], h).report.checks.find((c) => c.check === "link key 0600");
  assert.equal(keyOk().ok, true);
  rmSync(at(h, `${STATE}/link.key`));
  mkdirSync(at(h, `${STATE}/link.key`));
  chmodSync(at(h, `${STATE}/link.key`), 0o600);
  assert.deepEqual(keyOk(), { check: "link key 0600", ok: false, detail: `${STATE}/link.key` });
});

// apply.js 1149:56-61 and 1150:51-90: dispatch check fails with nothing on stderr.
test("apply.js 1149/1150: a failing dispatch check with no output is reported as 'dispatch check exited <n>'", () => {
  let ok = true;
  const h = dhost({ check: () => (ok ? { stdout: "dispatch check: ok\n" } : { status: 3 }) });
  dinstall(h, dispatchRelease(), ["--service-cert", certFile()]);
  ok = false;
  const r = run(["doctor", "--service", "dispatch-server"], h);
  const c = r.report.checks.find((x) => x.check === "dispatch check");
  assert.equal(r.code, 5);
  assert.deepEqual([c.ok, c.detail], [false, "dispatch check exited 3"]);
});

// apply.js 1155:79-84 and 1158:75-87: the unit's is-active prints nothing.
test("apply.js 1155/1158: doctor shows 'unknown' for a unit whose is-active prints nothing", () => {
  const h = host();
  install(h, release());
  intercept(h, (cmd, args) => (cmd === "systemctl" && args.includes("is-active") ? { stdout: "" } : undefined));
  const c = run(["doctor", "--service", "sidecar"], h).report.checks.find((x) => x.check === "unit active");
  assert.deepEqual(c, { check: "unit active", ok: false, detail: `${SERVICE}: unknown` });
});

// apply.js 1218:24-72: a health probe that reports something.
test("apply.js 1218: a health probe's answer is a doctor check, and a failing one fails the report", () => {
  const h = host();
  install(h, release());
  let seen = null;
  const withProbe = (probe) => run(["doctor", "--service", "sidecar"], { ...h, deps: { ...h.deps, probe } });
  const good = withProbe((rec) => { seen = rec; return { ok: true, detail: "answers on 7777" }; });
  assert.deepEqual(good.report.checks.at(-1), { check: "health probe", ok: true, detail: "answers on 7777" });
  assert.deepEqual([seen.service, seen.instance], ["sidecar", "default"], "the probe is given the record");
  const bad = withProbe(() => ({ ok: false, detail: "no answer" }));
  assert.deepEqual(bad.report.checks.at(-1), { check: "health probe", ok: false, detail: "no answer" });
  assert.equal(bad.report.ok, false);
  // Without a probe answer there is no such check.
  assert.ok(!withProbe(() => null).report.checks.some((c) => c.check === "health probe"));
});

// A record built by hand, for the checks that read the installed config: only the pieces
// doctorService reads. Its config is `text`, recorded with that text's real hash.
function bare(h, service, text, { scope = "system" } = {}) {
  const path = "/etc/test/conf.toml";
  mkdirSync(dirname(at(h, path)), { recursive: true });
  writeFileSync(at(h, path), text);
  return { service, instance: "default", version: "0.1.0", scope, binaries: [], symlink: { path: "/usr/local/lib/test/current", target: "0.1.0" },
    files: [{ path, sha256: sha(Buffer.from(text)) }], state_dir: "/var/lib/test/default", unit: null, config_dir: "/etc/test" };
}
const names = (checks) => checks.map((c) => c.check);
const socketsCheck = (checks) => checks.find((c) => c.check === "sockets");

// apply.js 1233:5-1235:4, 1236:125-131, 1238:116-128, 1241:5-1243:4: the sockets of a config that
// parses but doesn't have the keys install writes, or doesn't parse.
test("apply.js 1233-1243: doctor can't find the sockets of a config that doesn't parse or lacks install's keys", () => {
  const h = host();
  const bad = [
    ["sidecar", "this is = not [valid toml\n"],
    ["sidecar", 'listen = "tcp://127.0.0.1:1"\nadmin_socket = "/a.sock"\n'],
    ["sidecar", "listen = 5\nadmin_socket = \"/a.sock\"\n"],
    ["sidecar", 'listen = "vbcdx+unix:///run/vbcdx/default.sock"\n'],
    ["sidecar", 'listen = "vbcdx+unix://%E0%A4%A"\nadmin_socket = "/a.sock"\n'],
    ["control-plane", 'state_dir = "/var/lib/test"\n'],
    ["control-plane", "admin_socket = 7\n"],
  ];
  for (const [service, text] of bad) {
    const { checks } = doctorService(h.sys, bare(h, service, text));
    assert.deepEqual(socketsCheck(checks), { check: "sockets", ok: false, detail: "/etc/test/conf.toml is not the config install wrote; reinstall to put it back" },
      `${service}: ${JSON.stringify(text)}`);
    assert.ok(!checks.some((c) => /control plane/.test(c.check)), "no control-plane ping for a config doctor can't read");
  }
  // The same function reads good configs: their sockets are listed (and fail only because none exist).
  assert.deepEqual(names(doctorService(h.sys, bare(h, "control-plane", 'admin_socket = "/run/c.sock"\n')).checks).filter((n) => /socket/.test(n)), ["admin socket 0600"]);
  assert.deepEqual(names(doctorService(h.sys, bare(h, "sidecar", 'listen = "vbcdx+unix:///run/a%20b.sock"\nadmin_socket = "/run/a.admin.sock"\n')).checks)
    .filter((n) => /socket/.test(n)), ["socket 0660 group vbcdx", "admin socket 0660 group vbcdx"]);
});

// apply.js 1233:5-1235:4 and 1253:5-1255:4 through a real install: the config's hash matches the
// record but the text is not TOML.
test("apply.js 1233/1253: an installed config replaced by non-TOML (and re-recorded) fails 'sockets' and runs no tunnel check", () => {
  const h = host();
  install(h, release());
  const text = "this is = not [valid toml\n";
  writeFileSync(at(h, CONF), text);
  editRecord(h, (r) => { r.files[0].sha256 = sha(Buffer.from(text)); });
  const { report, code } = run(["doctor", "--service", "sidecar"], h);
  assert.equal(code, 5);
  assert.equal(report.checks.find((c) => c.check === `file ${CONF}`).ok, true, "the file is what was recorded");
  assert.equal(socketsCheck(report.checks).ok, false);
  assert.ok(!report.checks.some((c) => /control plane/.test(c.check)));
});

// apply.js 1261:49-54: getent finds the group but prints nothing.
test("apply.js 1261: a group lookup that succeeds with no output is no group id, so shared sockets fail", async () => {
  const h = host();
  install(h, release());
  const paths = ["/run/vbcdx/default.sock", "/run/vbcdx/default.admin.sock"];
  const servers = [];
  for (const p of paths) {
    mkdirSync(dirname(at(h, p)), { recursive: true });
    const server = createServer();
    await new Promise((ok) => server.listen(at(h, p), ok));
    chmodSync(at(h, p), 0o660);
    servers.push(server);
  }
  try {
    assert.equal(run(["doctor", "--service", "sidecar"], h).code, 0, "with the group's id the sockets pass");
    intercept(h, (cmd, args) => (cmd === "getent" && args[0] === "group" ? { status: 0, stdout: "" } : undefined));
    const { report, code } = run(["doctor", "--service", "sidecar"], h);
    assert.equal(code, 5);
    assert.deepEqual(report.checks.filter((c) => !c.ok).map((c) => c.check), ["socket 0660 group vbcdx", "admin socket 0660 group vbcdx"]);
  } finally {
    await Promise.all(servers.map((s) => new Promise((ok) => s.close(ok))));
  }
});

// ================================================================================================
// serviceAction / configExec
// ================================================================================================

function recorder(status = 0) {
  const sys = { calls: [], opts: [], run: (cmd, args, o) => { sys.calls.push([cmd, ...args]); sys.opts.push(o); return { status, stdout: "", stderr: "" }; } };
  return sys;
}

// apply.js 1270:44-61 and 1270:122-126: logs of a user unit, without --follow.
test("apply.js 1270: logs of a user unit use --user-unit; of a system unit -u; -f only with follow", () => {
  const userRec = { service: "sidecar", instance: "default", scope: "user", unit: { name: SERVICE } };
  const sysRec = { ...userRec, scope: "system" };
  const sys = recorder(7);
  assert.equal(serviceAction(sys, userRec, "logs"), 7, "journalctl's own exit status");
  assert.equal(serviceAction(sys, userRec, "logs", { follow: true }), 7);
  assert.equal(serviceAction(sys, sysRec, "logs"), 7);
  assert.deepEqual(sys.calls, [
    ["journalctl", "--user-unit", SERVICE, "--no-pager"],
    ["journalctl", "--user-unit", SERVICE, "--no-pager", "-f"],
    ["journalctl", "-u", SERVICE, "--no-pager"],
  ]);
  assert.ok(sys.opts.every((o) => o.inherit === true), "output goes to the terminal");
  const s2 = recorder(0);
  serviceAction(s2, userRec, "status");
  assert.deepEqual(s2.calls, [["systemctl", "--user", "status", SERVICE]]);
});

// apply.js 1284:13-74: a record with no vbcdx-svc.
test("apply.js 1284: config on an install with no vbcdx-svc binary is refused (exit 5) and runs nothing", () => {
  const sys = recorder();
  const rec = { service: "control-plane", instance: "default", binaries: [{ name: "vbcdx-control", path: "/usr/local/lib/vbcdx/control-plane/0.1.0/vbcdx-control", sha256: "a".repeat(64) }] };
  assert.throws(() => configExec(sys, rec, ["sidecar", "--help"]), (e) => e.code === EXIT.CONFLICT && e.message === "This install has no vbcdx-svc binary.");
  assert.deepEqual(sys.calls, []);
});

// ================================================================================================
// removeLegacyModules
// ================================================================================================

function legacyModules(h, body = "keyhole = true\n") {
  writeFileSync(at(h, LEGACY), body);
  const m = JSON.parse(readFileSync(recFile(h), "utf8"));
  m.services["sidecar:default"].modules = { path: LEGACY, sha256: sha(Buffer.from(body)) };
  writeFileSync(recFile(h), JSON.stringify(m, null, 2));
}

// apply.js 1303:23-35: the recorded modules.toml is already gone.
test("apply.js 1303: an upgrade whose recorded modules.toml is already gone succeeds, removes and keeps nothing, and drops the entry", () => {
  const h = host();
  install(h, release("0.1.0"));
  legacyModules(h);
  rmSync(at(h, LEGACY));
  const r = install(h, release("0.2.0")).report;
  assert.deepEqual([r.changed, r.upgraded_from, r.legacy_removed, r.kept], [true, "0.1.0", null, []]);
  assert.ok(!("legacy_not_removed" in r));
  assert.equal(sidecarRecord(h).modules, null);
});

// apply.js 1308:72-84: the removal fails with an error that carries no code (the message is the reason).
// Uses the same node:fs mock the existing modules.toml test uses (service-apply.test.js, EPERM there).
test("apply.js 1308: a modules.toml removal that fails with a code-less error names the error's message as the reason", (t) => {
  const h = host();
  install(h, release("0.1.0"));
  legacyModules(h);
  const real = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", (path, ...rest) => {
    if (String(path) === at(h, LEGACY)) throw new Error("disk on fire");
    return real(path, ...rest);
  });
  syncBuiltinESMExports();
  let r;
  try {
    r = install(h, release("0.2.0")).report;
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual([r.changed, r.legacy_removed], [true, null]);
  assert.deepEqual(r.legacy_not_removed, { path: LEGACY, reason: "disk on fire" });
  assert.ok(existsSync(at(h, LEGACY)));
  assert.ok(sidecarRecord(h).modules && sidecarRecord(h).modules.path === LEGACY, "still recorded");
});
