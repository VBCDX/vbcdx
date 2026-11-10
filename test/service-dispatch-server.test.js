// `vbcdx install|remove|doctor … dispatch-server`: the Dispatch server in control-plane mode, from its own
// signed release (@vbcdx/dispatch). Root only, its own user; one recorded file (the unit's
// EnvironmentFile, no secret in it); the link key and CSR made as the service user; the unit
// starts only once the certificate from `vbcdx-control services add dispatch` passes `dispatch check`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { keypair, signFile } from "./helpers/minisign-signer.js";
import { tempDir } from "./helpers/temp-dir.js";
import { humanReport, planInstall, runService } from "../src/service/index.js";
import { parseServiceArgs } from "../src/service/args.js";
import { fakeSystem } from "../src/service/system.js";
import { fakeAccounts } from "./helpers/fake-accounts.js";
import { EXIT } from "../src/errors.js";
import { fileRestorer } from "../src/service/apply.js";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const KEY = keypair(11);
const EXEC = "/usr/local/lib/vbcdx/dispatch-server/0.1.0/dispatch";
const STATE = "/var/lib/vbcdx-dispatch/default";
const ENV = "/etc/vbcdx-dispatch/default/dispatch.env";
const CP_MODE = ["--link-listen", "0.0.0.0:8443", "--control-url", "https://10.0.0.5:8443"];
const CERT = "-----BEGIN CERTIFICATE-----\nMIIBleaf\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nMIIBca\n-----END CERTIFICATE-----\n";

// @vbcdx/dispatch as dispatch's release job packs it (one platform is enough here).
function release(version = "0.1.0") {
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

// A host under a temp root. `dispatch link csr` (run through runuser) writes its two files as the
// real one does, refusing existing ones; `dispatch check` answers `check`.
function host({ uid = 0, check = () => ({ stdout: "dispatch check: ok (control-plane mode)\n" }), active = "active", ss = () => "" } = {}) {
  const root = tempDir("vbcdx-dhost-");
  const acct = fakeAccounts({ gid: process.getgid() });
  const sys = fakeSystem(root, { uid, answer: (cmd, args, o) => {
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
    if (cmd === "ss") return { stdout: ss() };
    // A shell step as the service user (apply.js asServiceUser): run for real, on the temp root's
    // paths (they are already under it), as this test's own user.
    if (cmd === "runuser" && args[3] === "/bin/sh") {
      const r = spawnSync("/bin/sh", args.slice(4), { input: o && o.input, encoding: "utf8" });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    }
    if (args.includes("check")) return check(cmd, args);
    if (cmd === "systemctl" && args.includes("is-active")) return { stdout: `${active}\n` };
    return {};
  } });
  return { sys, root, deps: { sys, trustedKeys: [KEY.pub], platformId: "linux-x64-gnu",
    host: { uid, home: uid === 0 ? "/root" : "/home/u", runtimeDir: uid === 0 ? null : "/run/user/1000" } } };
}
const run = (argv, h) => runService(parseServiceArgs(argv), h.deps);
const install = (h, rel, extra = []) => run(["install", "service", "dispatch-server", "--from", rel, ...CP_MODE, ...extra], h);
const plan = (h, rel, extra = CP_MODE) => planInstall(parseServiceArgs(["install", "service", "dispatch-server", "--from", rel, ...extra]), h.deps).plan;
const at = (h, p) => join(h.root, p);
const calls = (h, cmd) => h.sys.calls.filter((c) => c[0] === cmd).map((c) => c.slice(1).join(" "));
const certFile = (text = CERT) => {
  const p = join(tempDir("vbcdx-dcert-"), "dispatch.crt");
  writeFileSync(p, text);
  return p;
};

test("the plan: its own user and dirs, one env file with the control-plane-mode settings and no secret, the link paths", () => {
  const p = plan(host(), release());
  assert.equal(p.scope, "system");
  assert.deepEqual(p.user, { name: "vbcdx-dispatch", system: true, shell: "/usr/sbin/nologin" });
  assert.deepEqual(p.binaries.map((b) => [b.name, b.to]), [["dispatch", EXEC]]);
  const dir = (path) => p.dirs.find((d) => d.path === path);
  assert.deepEqual(dir(STATE), { path: STATE, mode: "0700", owner: "vbcdx-dispatch", group: "vbcdx-dispatch" });
  assert.deepEqual(dir("/etc/vbcdx-dispatch/default"), { path: "/etc/vbcdx-dispatch/default", mode: "0750", owner: "root", group: "vbcdx-dispatch" });
  assert.equal(p.files.length, 1);
  const [f] = p.files;
  assert.deepEqual([f.path, f.mode, f.owner, f.group], [ENV, "0640", "root", "vbcdx-dispatch"]);
  const settings = f.text.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(settings, ["LISTEN_ADDR=127.0.0.1:8080", "PUBLIC_URL=http://127.0.0.1:8080", `DATA_DIR=${STATE}`,
    "VBCDX_LINK_ADDR=0.0.0.0:8443", "VBCDX_CONTROL_URL=https://10.0.0.5:8443",
    `VBCDX_SERVICE_CERT=${STATE}/link.crt`, `VBCDX_SERVICE_KEY=${STATE}/link.key`]);
  assert.ok(!/SECRET|PASSWORD|TOKEN/.test(f.text), "no secret in the env file");
  assert.equal(f.sha256, sha(f.text));
  assert.equal(p.listen, "127.0.0.1:8080");
  assert.deepEqual(p.check, [EXEC, "check", "--env-file", ENV]);
  assert.deepEqual(p.csr, [EXEC, "link", "csr", "--key-out", `${STATE}/link.key`, "--csr-out", `${STATE}/link.csr`]);
  // 0.0.0.0 can't be dialled: the hint says which address to put there.
  assert.equal(p.link.services_add,
    `vbcdx-control services add dispatch --url https://<this host's address>:8443/vbcdx/v1 --csr ${STATE}/link.csr --cert-out dispatch.crt`);
  const named = plan(host(), release(), ["--link-listen", "dispatch.lan:9443", "--control-url", "https://cp.lan:8443",
    "--listen", "127.0.0.1:9090", "--public-url", "https://dispatch.example"]);
  assert.match(named.link.services_add, /--url https:\/\/dispatch\.lan:9443\/vbcdx\/v1 /);
  assert.ok(named.files[0].text.includes("LISTEN_ADDR=127.0.0.1:9090\nPUBLIC_URL=https://dispatch.example\n"));
});

test("the unit: env file, check then serve, as vbcdx-dispatch, hardened; setrlimit returns EPERM instead of killing Go", () => {
  const lines = plan(host(), release()).unit.text.split("\n");
  // The product term is "control-plane mode"; no internal wording ships in the unit.
  assert.ok(!/herd/i.test(lines.join("\n")), "no internal wording in the unit");
  for (const line of ["Description=Dispatch server, control-plane mode (instance default)", "Type=exec", "User=vbcdx-dispatch", "Group=vbcdx-dispatch", `EnvironmentFile=${ENV}`,
    `ExecStartPre=${EXEC} check`, `ExecStart=${EXEC} serve`, "Restart=on-failure", "UMask=0077",
    "StateDirectory=vbcdx-dispatch/default", "StateDirectoryMode=0700", "NoNewPrivileges=yes", "ProtectSystem=strict",
    "ProtectHome=yes", "PrivateTmp=yes", "PrivateDevices=yes", "MemoryDenyWriteExecute=yes",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6", "SystemCallFilter=@system-service", "SystemCallFilter=~@privileged",
    "SystemCallErrorNumber=EPERM", "CapabilityBoundingSet=", "AmbientCapabilities=", "LimitCORE=0", "WantedBy=multi-user.target"]) {
    assert.ok(lines.includes(line), `missing: ${line}`);
  }
  assert.ok(!lines.includes("SystemCallFilter=~@privileged @resources"), "@resources is not denied (Go's setrlimit)");
});

test("control-plane-mode flags are checked before the registry is asked", () => {
  const h = host();
  const refused = (extra, re) => {
    const o = parseServiceArgs(["install", "service", "dispatch-server", ...extra]);
    assert.throws(() => planInstall(o, h.deps), (e) => e.code === EXIT.CONFIG && re.test(e.message), extra.join(" "));
  };
  refused([], /control-plane mode: it needs --link-listen/);
  refused(["--link-listen", "0.0.0.0:8443"], /needs --link-listen/);
  refused(["--control-url", "https://cp:8443"], /needs --link-listen/);
  refused(["--link-listen", "8443", "--control-url", "https://cp:8443"], /--link-listen takes/);
  refused(["--link-listen", "h:0", "--control-url", "https://cp:8443"], /--link-listen takes/);
  for (const bad of ["http://cp:8443", "https://cp", "https://cp:8443/x", "https://u:p@cp:8443", "https://cp:8443/", "cp:8443"]) {
    refused(["--link-listen", "h:1", "--control-url", bad], /--control-url takes/);
  }
  // Each value is one line of dispatch.env: new URL() would drop a newline or tab and pass it.
  for (const [flag, bad] of [["--control-url", "https://cp\nVBCDX_X=1:8443"], ["--control-url", "https://cp:8443\t"],
    ["--control-url", "https://cp:8443?a=1"], ["--control-url", "https://cp:8443#x"], ["--control-url", "https://cp:8443?"],
    ["--public-url", "https://d.example\rX=1"], ["--public-url", "https://d.example?"], ["--public-url", "https://d.example #"],
    ["--link-listen", "h:1\n"]]) {
    const extra = { "--control-url": ["--link-listen", "h:1", "--control-url", bad], "--public-url": [...CP_MODE, "--public-url", bad],
      "--link-listen": ["--link-listen", bad, "--control-url", "https://cp:8443"] }[flag];
    refused(extra, new RegExp(`${flag} has a control character, a space, \\? or #`));
  }
  refused([...CP_MODE, "--public-url", "http://dispatch.example"], /must be https unless/);
  refused([...CP_MODE, "--public-url", "https://dispatch.example/app"], /--public-url takes/);
  assert.deepEqual(calls(h, "npm"), [], "npm was never run");
});

test("flags of other services are refused for dispatch-server, and its own for them", () => {
  for (const extra of [["--control-plane", "vbcdx+https://h:1?auth=mtls&pin=sha256:" + "0".repeat(64)], ["--tunnel", "0.0.0.0:1", "--tunnel-name", "t"],
    ["--enroll-token-stdin"]]) {
    assert.throws(() => parseServiceArgs(["install", "service", "dispatch-server", ...CP_MODE, ...extra]), /not a dispatch-server flag/);
  }
  for (const svc of ["sidecar", "control-plane"]) {
    for (const k of ["--link-listen", "--control-url", "--public-url", "--service-cert"]) {
      assert.throws(() => parseServiceArgs(["install", "service", svc, k, "x"]), new RegExp(`${k} is for dispatch-server`));
    }
  }
  const h = host();
  assert.throws(() => plan(h, release(), [...CP_MODE, "--listen", "unix:/run/x.sock"]), /takes <host>:<port>/);
});

test("first install: the key and CSR are made as vbcdx-dispatch, nothing is checked or started, the next step is printed", () => {
  const h = host();
  const r = install(h, release());
  assert.equal(r.code, 0);
  assert.deepEqual(calls(h, "runuser").filter((c) => c.includes("csr")),
    [`-u vbcdx-dispatch -- ${at(h, EXEC)} link csr --key-out ${STATE}/link.key --csr-out ${STATE}/link.csr`]);
  assert.ok(!calls(h, "runuser").some((c) => c.includes(" check")), "no check without a certificate");
  const ctl = calls(h, "systemctl");
  assert.ok(ctl.includes("enable vbcdx-dispatch-server-default.service"), ctl.join("|"));
  assert.ok(!ctl.some((c) => c.includes("--now") || c.startsWith("restart")), "not started");
  assert.equal(r.report.started, false);
  assert.equal(r.report.link.cert, null);
  assert.match(r.report.link.next, /vbcdx-control services add dispatch --url https:\/\/<this host's address>:8443\/vbcdx\/v1 .*--service-cert dispatch\.crt/);
  assert.equal(statSync(at(h, `${STATE}/link.key`)).mode & 0o777, 0o600);
  const rec = JSON.parse(readFileSync(at(h, "/root/.vbcdx/manifests/installation.json"), "utf8")).services["dispatch-server:default"];
  assert.deepEqual(rec.files.map((f) => f.path), [ENV]);
  assert.equal(rec.package, "@vbcdx/dispatch");
});

test("first install on a real-looking host: the unit is inactive (never started), and install still succeeds", () => {
  const h = host({ active: "inactive" });
  const r = install(h, release());
  assert.equal(r.code, 0);
  assert.equal(r.report.started, false);
});

test("--service-cert: written 0600 for the service user, checked as that user with the env file, then started", () => {
  const h = host();
  install(h, release());
  const before = h.sys.calls.length;
  const r = install(h, release(), ["--service-cert", certFile()]);
  assert.equal(r.code, 0);
  const after = h.sys.calls.slice(before).map((c) => c.join(" "));
  assert.ok(!after.some((c) => c.includes(" csr ")), "the key is not remade");
  assert.ok(after.includes(`runuser -u vbcdx-dispatch -- ${at(h, EXEC)} check --env-file ${ENV}`), after.join("\n"));
  // Written as the service user, never by root: no chown of anything in the state directory.
  const write = after.findIndex((c) => c.startsWith("runuser -u vbcdx-dispatch -- /bin/sh -c umask 077") && c.endsWith(at(h, `${STATE}/link.crt`)));
  assert.ok(write >= 0, after.join("\n"));
  assert.ok(!after.some((c) => c.startsWith("chown") && c.includes(STATE)), "root chowns nothing in the state directory");
  assert.ok(!existsSync(at(h, `${STATE}/link.crt.vbcdx-prev`)) && !existsSync(at(h, `${STATE}/link.crt.vbcdx-new`)), "no leftovers");
  assert.ok(after.includes("systemctl restart vbcdx-dispatch-server-default.service"), after.join("\n"));
  assert.equal(readFileSync(at(h, `${STATE}/link.crt`), "utf8"), CERT);
  assert.equal(statSync(at(h, `${STATE}/link.crt`)).mode & 0o777, 0o600);
  assert.equal(r.report.started, true);
  assert.equal(r.report.link.next, null);
  // The order: the certificate is in place before the check, and the check before the start.
  const i = (s) => after.findIndex((c) => c.includes(s));
  assert.ok(write < i(" check --env-file") && i(" check --env-file") < i("systemctl restart"));
  // Replacing it (after services add --replace): the new one is in place, the saved old one is gone.
  const NEW = CERT.replace("MIIBleaf", "MIIBnewleaf");
  assert.equal(install(h, release(), ["--service-cert", certFile(NEW)]).code, 0);
  assert.equal(readFileSync(at(h, `${STATE}/link.crt`), "utf8"), NEW);
  assert.ok(!existsSync(at(h, `${STATE}/link.crt.vbcdx-prev`)), "the saved previous certificate is dropped");
});

test("a certificate dispatch check refuses: nothing starts, and the certificate is taken back out", () => {
  // The unit was never started (no certificate yet): systemd reports it inactive.
  const h = host({ active: "inactive", check: () => ({ status: 1, stderr: "dispatch: control-plane mode: service key: private key does not match public key\n" }) });
  install(h, release());
  assert.throws(() => install(h, release(), ["--service-cert", certFile()]),
    (e) => e.code === EXIT.SUBPROCESS && /refuses the config install wrote/.test(e.message) && e.details.lines.some((l) => /does not match/.test(l)));
  assert.ok(!existsSync(at(h, `${STATE}/link.crt`)), "the refused certificate is gone");
  assert.ok(!calls(h, "systemctl").some((c) => c.startsWith("restart") || c.includes("--now")));
  assert.ok(existsSync(at(h, `${STATE}/link.key`)), "the key stays");
});

test("a unit that doesn't stay up after the certificate is added: the install says so and the certificate goes", () => {
  let state = "active";
  const h = host({ active: "active" });
  install(h, release());
  // From here systemd reports the unit failed (e.g. the link address is taken).
  const answer = h.sys.run.bind(h.sys);
  h.sys.run = (cmd, args, o) => (cmd === "systemctl" && args.includes("is-active") ? (h.sys.calls.push([cmd, ...args]), { status: 3, stdout: `${state}\n`, stderr: "" }) : answer(cmd, args, o));
  state = "failed";
  assert.throws(() => install(h, release(), ["--service-cert", certFile()]), (e) => e.code === EXIT.SUBPROCESS && /did not start/.test(e.message));
  assert.ok(!existsSync(at(h, `${STATE}/link.crt`)), "the certificate is taken back out");
});

test("B1: a link.crt the service user replaced with a symlink is never followed by root: the target keeps its owner and bytes", () => {
  const h = host();
  install(h, release());
  const target = at(h, "/etc/shadow-stand-in");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "root-only\n", { mode: 0o600 });
  symlinkSync(target, at(h, `${STATE}/link.crt`));
  const before = h.sys.calls.length;
  assert.equal(install(h, release(), ["--service-cert", certFile()]).code, 0);
  assert.equal(readFileSync(target, "utf8"), "root-only\n", "the link's target is untouched");
  assert.ok(!lstatSync(at(h, `${STATE}/link.crt`)).isSymbolicLink(), "the link itself was replaced");
  assert.equal(readFileSync(at(h, `${STATE}/link.crt`), "utf8"), CERT);
  const after = h.sys.calls.slice(before).map((c) => c.join(" "));
  assert.ok(!after.some((c) => c.startsWith("chown") && (c.includes("link.crt") || c.includes("shadow"))), after.join("\n"));
});

test("B1: the undo is the service user's too: a planted link at the certificate path is put back as a link, never read by root", () => {
  // A cert check that fails, after the user planted a link where the old certificate was.
  const h = host({ active: "inactive", check: () => ({ status: 1, stderr: "dispatch: no\n" }) });
  install(h, release());
  const target = at(h, "/etc/shadow-stand-in");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "root-only\n", { mode: 0o600 });
  symlinkSync(target, at(h, `${STATE}/link.crt`));
  assert.throws(() => install(h, release(), ["--service-cert", certFile()]), (e) => e.code === EXIT.SUBPROCESS);
  assert.equal(readFileSync(target, "utf8"), "root-only\n");
  assert.ok(!existsSync(at(h, `${STATE}/link.crt.vbcdx-prev`)), "the saved copy was moved back");
  assert.ok(!h.sys.calls.some((c) => c[0] === "chown" && c.join(" ").includes(`${STATE}/`)), "no chown of anything in the state directory");
});

test("a symlinked dispatch.env is refused before anything is written, and fileRestorer itself never reads through a link", () => {
  const h = host();
  install(h, release());
  const target = at(h, "/etc/shadow-stand-in");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "root-only\n", { mode: 0o600 });
  rmSync(at(h, ENV));
  symlinkSync(target, at(h, ENV));
  // The carry-over reads no link (exit 5); with every setting given, the file check refuses it (exit 4).
  assert.throws(() => install(h, release(), ["--listen", "127.0.0.1:9999"]), (e) => e.code === EXIT.CONFLICT && /ENOTREG/.test(e.message));
  assert.throws(() => install(h, release(), ["--listen", "127.0.0.1:9999", "--public-url", "http://127.0.0.1:9999", "--force"]),
    (e) => e.code === EXIT.FILESYSTEM && /not a regular file/.test(e.message));
  assert.equal(readFileSync(target, "utf8"), "root-only\n");
  // The restorer, on its own (every root undo of a file goes through it): a link is refused, not read.
  assert.throws(() => fileRestorer(h.sys, ENV), (e) => e.code === EXIT.FILESYSTEM && /symlink/.test(e.message));
  const fifoDir = at(h, "/etc/vbcdx-dispatch/default");
  mkdirSync(join(fifoDir, "d"), { recursive: true });
  assert.throws(() => fileRestorer(h.sys, "/etc/vbcdx-dispatch/default/d"), (e) => e.code === EXIT.FILESYSTEM && /not a regular file/.test(e.message));
  // A regular file is read and put back.
  writeFileSync(at(h, "/etc/x.conf"), "before\n", { mode: 0o640 });
  const undo = fileRestorer(h.sys, "/etc/x.conf");
  writeFileSync(at(h, "/etc/x.conf"), "after\n");
  undo();
  assert.equal(readFileSync(at(h, "/etc/x.conf"), "utf8"), "before\n");
});

test("B2: a cert re-run that fails to start on a running instance puts the old certificate back and starts it again", () => {
  let fail = false;
  const h = host();
  install(h, release(), ["--service-cert", certFile()]);
  const answer = h.sys.run.bind(h.sys);
  // From now: the unit is active until the new certificate's start, which then fails.
  h.sys.run = (cmd, args, o) => {
    if (cmd === "systemctl" && args.includes("is-active")) {
      h.sys.calls.push([cmd, ...args]);
      return { status: fail ? 3 : 0, stdout: fail ? "failed\n" : "active\n", stderr: "" };
    }
    const r = answer(cmd, args, o);
    if (cmd === "systemctl" && args[0] === "restart" && !fail && h.sys.calls.filter((c) => c[1] === "restart").length === 1) fail = true;
    return r;
  };
  const before = h.sys.calls.length;
  const NEW = CERT.replace("MIIBleaf", "MIIBnewleaf");
  assert.throws(() => install(h, release(), ["--service-cert", certFile(NEW)]), (e) => e.code === EXIT.SUBPROCESS && /did not start/.test(e.message));
  assert.equal(readFileSync(at(h, `${STATE}/link.crt`), "utf8"), CERT, "the old certificate is back");
  const ctl = h.sys.calls.slice(before).filter((c) => c[0] === "systemctl").map((c) => c.slice(1).join(" "));
  assert.deepEqual(ctl.slice(-2), ["reset-failed vbcdx-dispatch-server-default.service", "restart vbcdx-dispatch-server-default.service"], ctl.join("|"));
});

test("a cert-less upgrade that fails never restarts a unit that never ran (restartPrevious follows the cert gate)", () => {
  const h = host({ active: "inactive" });
  install(h, release());
  const answer = h.sys.run.bind(h.sys);
  h.sys.run = (cmd, args, o) => (cmd === "systemctl" && args[0] === "enable"
    ? (h.sys.calls.push([cmd, ...args]), { status: 1, stdout: "", stderr: "enable failed\n" }) : answer(cmd, args, o));
  const before = h.sys.calls.length;
  assert.throws(() => install(h, release("0.2.0")), (e) => e.code === EXIT.SUBPROCESS);
  const ctl = h.sys.calls.slice(before).filter((c) => c[0] === "systemctl").map((c) => c[1]);
  assert.ok(!ctl.includes("restart") && !ctl.includes("reset-failed"), ctl.join("|"));
});

test("the URLs written to dispatch.env are the parsed ones, never the raw text", () => {
  const p = plan(host(), release(), ["--link-listen", "0.0.0.0:8443", "--control-url", "HTTPS://CP.Example:8443", "--public-url", "HTTPS://Dispatch.Example"]);
  assert.ok(p.files[0].text.includes("VBCDX_CONTROL_URL=https://cp.example:8443\n"), p.files[0].text);
  assert.ok(p.files[0].text.includes("PUBLIC_URL=https://dispatch.example\n"), p.files[0].text);
});

test("B3: the documented cert re-run works on a network-exposed instance: the recorded listen carries its acknowledgement", () => {
  const h = host();
  assert.equal(install(h, release(), ["--listen", "0.0.0.0:8080", "--expose-on-network", "--i-understand-network-exposure",
    "--public-url", "https://dispatch.example"]).code, 0);
  const r = run(["install", "service", "dispatch-server", "--from", release(), "--service-cert", certFile()], h);
  assert.equal(r.code, 0);
  assert.ok(readFileSync(at(h, ENV), "utf8").includes("LISTEN_ADDR=0.0.0.0:8080\n"));
  const dry = run(["install", "service", "dispatch-server", "--from", release(), "--dry-run"], h);
  assert.ok(dry.report.carried.some((c) => c.setting === "expose_on_network"));
  // A loopback listen carries no acknowledgement.
  const h2 = host();
  install(h2, release());
  assert.ok(!run(["install", "service", "dispatch-server", "--from", release(), "--dry-run"], h2).report.carried.some((c) => c.setting === "expose_on_network"));
});

test("a certificate in the first run: key and CSR made, then the certificate, check, start", () => {
  const h = host();
  const r = install(h, release(), ["--service-cert", certFile()]);
  assert.equal(r.report.started, true);
  const all = h.sys.calls.map((c) => c.join(" "));
  const i = (s) => all.findIndex((c) => c.includes(s));
  assert.ok(i(" link csr ") < i(" check --env-file") && i(" check --env-file") < i("enable --now"), all.join("\n"));
});

test("--service-cert is read safely: a regular file, PEM certificates only, never a key, bounded", () => {
  const h = host();
  const dir = tempDir("vbcdx-dcertbad-");
  const link = join(dir, "link.crt");
  symlinkSync(certFile(), link);
  const big = join(dir, "big.crt");
  writeFileSync(big, "-----BEGIN CERTIFICATE-----\n" + "A".repeat(70 * 1024));
  for (const [path, re] of [[link, /not a symlink/], [dir, /regular file/], [certFile("hello\n"), /not a PEM certificate chain/],
    [certFile(CERT + "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n"), /not a PEM certificate chain/],
    [big, /larger than a certificate chain/], [join(dir, "none.crt"), /can't be opened/]]) {
    assert.throws(() => install(h, release(), ["--service-cert", path]), (e) => e.code === EXIT.CONFIG && re.test(e.message), path);
  }
  assert.ok(!existsSync(at(h, ENV)), "nothing was installed");
});

test("doctor: the key, the certificate and dispatch check, as the unit's user", () => {
  const h = host();
  install(h, release());
  let r = run(["doctor", "--service", "dispatch-server"], h);
  assert.equal(r.code, 5);
  const byName = (rep) => Object.fromEntries(rep.checks.map((c) => [c.check, c]));
  let c = byName(r.report);
  assert.equal(c["link key 0600"].ok, true);
  assert.equal(c["link certificate"].ok, false);
  assert.match(c["link certificate"].detail, /services add dispatch/);
  install(h, release(), ["--service-cert", certFile()]);
  r = run(["doctor", "--service", "dispatch-server"], h);
  c = byName(r.report);
  assert.equal(r.code, 0, JSON.stringify(r.report.checks.filter((x) => !x.ok)));
  assert.deepEqual(r.report.checks.map((x) => x.check), ["binary dispatch", "current symlink", `file ${ENV}`, "state dir 0700",
    "link key 0600", "link certificate", "dispatch check", "unit file", "unit active"]);
  assert.ok(calls(h, "runuser").includes(`-u vbcdx-dispatch -- ${at(h, EXEC)} check --env-file ${ENV}`));
  // A key readable by anyone else fails, though it is still there.
  chmodSync(at(h, `${STATE}/link.key`), 0o644);
  r = run(["doctor", "--service", "dispatch-server"], h);
  assert.equal(r.code, 5);
  assert.equal(byName(r.report)["link key 0600"].ok, false);
});

test("doctor reports a failing dispatch check with its last line", () => {
  let ok = true;
  const h = host({ check: () => (ok ? { stdout: "dispatch check: ok\n" } : { status: 1, stderr: "dispatch: control-plane mode: open link.crt: no such file\n" }) });
  install(h, release(), ["--service-cert", certFile()]);
  ok = false;
  const r = run(["doctor", "--service", "dispatch-server"], h);
  const c = r.report.checks.find((x) => x.check === "dispatch check");
  assert.equal(r.code, 5);
  assert.deepEqual([c.ok, c.detail], [false, "dispatch: control-plane mode: open link.crt: no such file"]);
});

// `ss -H -l -t -n` lines: state, recv-q, send-q, local address:port, peer.
const listening = (...locals) => () => locals.map((l) => `LISTEN 0 4096 ${l} 0.0.0.0:*`).join("\n") + "\n";

test("--link-listen already bound (e.g. the control plane's own tunnel port on the same host) is refused before anything is written", () => {
  for (const [held, link] of [["0.0.0.0:8443", "0.0.0.0:8443"], ["198.51.100.7:8443", "0.0.0.0:8443"], ["0.0.0.0:8443", "198.51.100.7:8443"],
    ["[::]:8443", "0.0.0.0:8443"]]) {
    const h = host({ ss: listening(held) });
    assert.throws(() => run(["install", "service", "dispatch-server", "--from", release(), "--link-listen", link, "--control-url", "https://10.0.0.5:8443"], h),
      (e) => e.code === EXIT.CONFLICT && e.message.startsWith(`--link-listen ${link} (in use: something already listens on ${held})`), `${held} vs ${link}`);
    assert.ok(!existsSync(at(h, ENV)) && !calls(h, "runuser").length, "nothing written or run");
    const dry = run(["install", "service", "dispatch-server", "--from", release(), "--link-listen", link, "--control-url", "https://10.0.0.5:8443", "--dry-run"], h);
    assert.equal(dry.code, EXIT.CONFLICT);
    assert.match(dry.report.listen_in_use, /^--link-listen /);
  }
  // Another port, or another address of the same port: fine.
  for (const held of ["0.0.0.0:8444", "198.51.100.5:8443"]) {
    const h = host({ ss: listening(held) });
    assert.equal(run(["install", "service", "dispatch-server", "--from", release(), "--link-listen", "198.51.100.7:8443",
      "--control-url", "https://10.0.0.5:8443"], h).code, 0, held);
  }
});

test("the instance's own link listener is not 'in use' on a reinstall with the same settings (the cert re-run)", () => {
  let held = "";
  const h = host({ ss: () => held });
  install(h, release());
  held = listening("0.0.0.0:8443", "127.0.0.1:8080")();
  assert.equal(install(h, release(), ["--service-cert", certFile()]).code, 0);
  // Different settings (another link port), while something holds that one: refused.
  held = listening("0.0.0.0:8443", "0.0.0.0:9443")();
  assert.throws(() => run(["install", "service", "dispatch-server", "--from", release(), "--link-listen", "0.0.0.0:9443",
    "--control-url", "https://10.0.0.5:8443"], h), (e) => e.code === EXIT.CONFLICT && /--link-listen 0\.0\.0\.0:9443 \(in use/.test(e.message));
});

test("the cert re-run needs no control-plane-mode flags again: listen, link, control URL and public URL are carried from what is installed", () => {
  const h = host();
  const first = install(h, release(), ["--listen", "127.0.0.1:9090", "--public-url", "https://dispatch.example"]);
  assert.equal(first.code, 0);
  const envBefore = readFileSync(at(h, ENV), "utf8");
  const r = run(["install", "service", "dispatch-server", "--from", release(), "--service-cert", certFile()], h);
  assert.equal(r.code, 0);
  assert.equal(r.report.started, true);
  assert.equal(readFileSync(at(h, ENV), "utf8"), envBefore, "the settings are unchanged");
  const dry = run(["install", "service", "dispatch-server", "--from", release(), "--dry-run"], h);
  assert.deepEqual(dry.report.carried.map((c) => [c.setting, c.value]), [["listen", "127.0.0.1:9090"],
    ["link_listen", "0.0.0.0:8443"], ["control_url", "https://10.0.0.5:8443"], ["public_url", "https://dispatch.example"]]);
  // A flag that is given overrides only its own setting.
  const over = run(["install", "service", "dispatch-server", "--from", release(), "--link-listen", "0.0.0.0:9443", "--dry-run"], h);
  assert.ok(over.report.files[0].text.includes("VBCDX_LINK_ADDR=0.0.0.0:9443\n"));
  assert.ok(over.report.files[0].text.includes("VBCDX_CONTROL_URL=https://10.0.0.5:8443\n"));
});

test("a PUBLIC_URL that was only the default follows a new --listen; a chosen one is kept", () => {
  const h = host();
  install(h, release());
  const moved = run(["install", "service", "dispatch-server", "--from", release(), "--listen", "127.0.0.1:9191", "--dry-run"], h);
  assert.ok(moved.report.files[0].text.includes("LISTEN_ADDR=127.0.0.1:9191\nPUBLIC_URL=http://127.0.0.1:9191\n"));
  assert.ok(!moved.report.carried.some((c) => c.setting === "public_url"));
});

test("an installed dispatch.env that can't be read or parsed refuses the carry-over: nothing is guessed", () => {
  const h = host();
  install(h, release());
  writeFileSync(at(h, ENV), "LISTEN_ADDR=127.0.0.1:8080\nexport FOO\n");
  assert.throws(() => run(["install", "service", "dispatch-server", "--from", release(), "--dry-run"], h),
    (e) => e.code === EXIT.CONFLICT && /isn't KEY=VALUE/.test(e.message) && e.details.refused === "carry-over");
  rmSync(at(h, ENV));
  assert.throws(() => run(["install", "service", "dispatch-server", "--from", release(), "--dry-run"], h),
    (e) => e.code === EXIT.CONFLICT && /can't be read \(ENOENT\)/.test(e.message));
  // All three given: the file isn't needed.
  assert.equal(run(["install", "service", "dispatch-server", "--from", release(), ...CP_MODE, "--public-url", "http://127.0.0.1:8080", "--dry-run", "--force"], h).code, 0);
});

test("a user (non-root) install is refused: dispatch-server runs as its own system user", () => {
  const h = host({ uid: 1000 });
  assert.throws(() => install(h, release()), (e) => e.code === EXIT.CONFLICT && /needs root/.test(e.message));
});

test("remove takes out the unit and env file; --wipe also the state with the key and certificate", () => {
  const h = host();
  install(h, release(), ["--service-cert", certFile()]);
  run(["remove", "service", "dispatch-server"], h);
  assert.ok(!existsSync(at(h, ENV)) && !existsSync(at(h, "/etc/systemd/system/vbcdx-dispatch-server-default.service")));
  assert.ok(existsSync(at(h, `${STATE}/link.key`)), "state is kept without --wipe");
  install(h, release(), ["--service-cert", certFile()]);
  run(["remove", "service", "dispatch-server", "--wipe"], h);
  assert.ok(!existsSync(at(h, `${STATE}/link.key`)) && !existsSync(at(h, `${STATE}/link.crt`)));
});

test("a dry run shows the plan and the link step, writes nothing and carries no certificate bytes", () => {
  const h = host();
  const r = run(["install", "service", "dispatch-server", "--from", release(), ...CP_MODE, "--dry-run", "--json"], h);
  assert.equal(r.code, 0);
  assert.equal(r.report.dryRun, true);
  assert.equal(r.report.link.key, `${STATE}/link.key`);
  assert.ok(!existsSync(at(h, ENV)));
  assert.deepEqual(calls(h, "runuser"), []);
});

// The human install output prints the step that gets the certificate (it was only in --json).
test("install prints next: while the link certificate is missing, on a rerun too, and not once it is in", () => {
  const h = host();
  const first = install(h, release());
  const NEXT = /^  next: On the control host: vbcdx-control services add dispatch --url https:\/\/<this host's address>:8443\/vbcdx\/v1 .*then rerun this install with --service-cert dispatch\.crt\.$/m;
  assert.match(humanReport("install", first.report), NEXT);
  const again = install(h, release());
  assert.equal(again.code, 0);
  assert.equal(again.report.changed, false, "the rerun changes nothing");
  assert.match(humanReport("install", again.report), NEXT);
  const done = install(h, release(), ["--service-cert", certFile()]);
  assert.equal(done.report.link.next, null);
  assert.ok(!humanReport("install", done.report).includes("next:"), humanReport("install", done.report));
});

// A plain remove keeps the state directory (keys, database) and now says so; --wipe deletes it instead.
test("remove names the state it keeps; --wipe in its place deletes it and keeps nothing", () => {
  const h = host();
  install(h, release(), ["--service-cert", certFile()]);
  const dry = run(["remove", "service", "dispatch-server", "--dry-run"], h);
  assert.equal(dry.report.state_kept, STATE);
  assert.ok(humanReport("remove", dry.report).split("\n").includes(
    `  keep ${STATE} (state and held credentials); --wipe in place of this remove deletes it too`), humanReport("remove", dry.report));
  const wipeDry = run(["remove", "service", "dispatch-server", "--wipe", "--dry-run"], h);
  assert.equal(wipeDry.report.state_kept, null);
  assert.ok(wipeDry.report.actions.includes(`delete ${STATE} (state and held credentials)`));
  assert.ok(!humanReport("remove", wipeDry.report).includes(" keep "), humanReport("remove", wipeDry.report));
  const plain = run(["remove", "service", "dispatch-server"], h);
  assert.equal(plain.report.state_kept, STATE);
  assert.ok(existsSync(at(h, `${STATE}/link.key`)));
  assert.ok(humanReport("remove", plain.report).split("\n").includes(
    `  kept ${STATE} (state and held credentials); the instance is no longer recorded, so a later remove --wipe won't find it`), humanReport("remove", plain.report));
  // A state directory already gone is not claimed as kept.
  install(h, release(), ["--service-cert", certFile()]);
  rmSync(at(h, STATE), { recursive: true, force: true });
  assert.equal(run(["remove", "service", "dispatch-server", "--dry-run"], h).report.state_kept, null);
});
