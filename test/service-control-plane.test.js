// `vbcdx install|remove|doctor|service … control-plane`: the control plane's auth and registry
// daemon (vbcdx-control), installed standalone. It ships in the sidecar's signed release tree and
// gets its own user, config, state, runtime dir and unit, so it can share a host with a sidecar.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { parse as tomlParse } from "smol-toml";
import { keypair, signFile } from "./helpers/minisign-signer.js";
import { tempDir } from "./helpers/temp-dir.js";
import { humanPlan, planInstall, runService } from "../src/service/index.js";
import { parseServiceArgs } from "../src/service/args.js";
import { fakeSystem } from "../src/service/system.js";
import { fakeAccounts } from "./helpers/fake-accounts.js";
import { validateRecord } from "../src/service/apply.js";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const KEY = keypair(9);
const BINS = ["vbcdx-sidecar", "vbcdx-svc", "vbcdx-control"];

// One signed release tree holding all three binaries, as the release job packs it.
function release(version = "0.1.0") {
  const root = tempDir("vbcdx-rel-");
  const files = {};
  for (const name of BINS) {
    const rel = `@vbcdx/sidecar-linux-x64-gnu/bin/${name}`;
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    const body = Buffer.from(`#!/bin/sh\n# ${name} ${version}\n`);
    writeFileSync(join(root, rel), body, { mode: 0o755 });
    files[rel] = sha(body);
  }
  const sums = Buffer.from(JSON.stringify({ schema: 1, package: "@vbcdx/sidecar", version, files }));
  writeFileSync(join(root, "checksums.json"), sums);
  writeFileSync(join(root, "checksums.json.minisig"), signFile(KEY, sums, `vbcdx-release @vbcdx/sidecar ${version}`));
  return root;
}

// A host under a temp root: systemctl answers `active`; `check` answers the daemon's check.
function host({ uid = 0, check = () => ({}), active = "active", accounts = {} } = {}) {
  const root = tempDir("vbcdx-host-");
  // Users and groups as shadow-utils keeps them (helpers/fake-accounts.js): no stub weaker than the host.
  const acct = fakeAccounts({ ...accounts, gid: process.getgid() });
  // The unit's state as systemctl reports it; a test can change it after install (`h.unit.active`).
  const unit = { active };
  const sys = fakeSystem(root, { uid, answer: (cmd, args) => {
    const a = acct.answer(cmd, args);
    if (a) return a;
    if (args.includes("check")) return check(cmd, args);
    if (cmd === "systemctl" && args.includes("is-active")) return { stdout: `${unit.active}\n` };
    return {};
  } });
  return { acct, sys, root, unit, deps: { sys, trustedKeys: [KEY.pub], platformId: "linux-x64-gnu",
    host: { uid, home: uid === 0 ? "/root" : "/home/u", runtimeDir: uid === 0 ? null : "/run/user/1000" } } };
}
const run = (argv, h) => runService(parseServiceArgs(argv), h.deps);
const install = (h, rel, svc = "control-plane", extra = []) => run(["install", "service", svc, "--from", rel, ...extra], h);
const plan = (h, rel, extra = []) => planInstall(parseServiceArgs(["install", "service", "control-plane", "--from", rel, ...extra]), h.deps).plan;
const at = (h, p) => join(h.root, p);
const calls = (h, cmd) => h.sys.calls.filter((c) => c[0] === cmd).map((c) => c.slice(1).join(" "));
// systemctl calls without the post-start liveness polls (is-active / show NRestarts), and whether the
// wait polled after `after` (the start or restart call).
const lifecycle = (h) => calls(h, "systemctl").filter((c) => !/^(--user )?(is-active|show) /.test(c));
const waitedAfter = (h, after) => {
  const all = calls(h, "systemctl");
  const i = all.lastIndexOf(after);
  return i >= 0 && /^(--user )?is-active /.test(all[i + 1] || "");
};
const recordOf = (h) => JSON.parse(readFileSync(at(h, "/root/.vbcdx/manifests/installation.json"), "utf8")).services;

// vbcdx-core crates/vbcdx-config/src/schema.rs `CONTROL` (main 4eda5565, with the tunnel
// listener): any other key makes `vbcdx-control check` exit 2. The installer writes the two paths
// it lays out, plus tunnel and tunnel_name with --tunnel.
const CONTROL_KEYS = ["admin_socket", "socket_group", "state_dir", "tunnel", "tunnel_name", "log.level"];

test("the plan: its own user, dirs, config and unit; only vbcdx-control is copied", () => {
  const h = host();
  const p = plan(h, release());
  assert.equal(p.scope, "system");
  assert.deepEqual(p.user, { name: "vbcdx-control", system: true, shell: "/usr/sbin/nologin" });
  assert.deepEqual(p.binaries.map((b) => [b.name, b.to]), [["vbcdx-control", "/usr/local/lib/vbcdx/control-plane/0.1.0/vbcdx-control"]]);
  assert.deepEqual(p.symlink, { path: "/usr/local/lib/vbcdx/control-plane/current", target: "0.1.0" });
  const dir = (path) => p.dirs.find((d) => d.path === path);
  assert.deepEqual(dir("/var/lib/vbcdx-control/default"), { path: "/var/lib/vbcdx-control/default", mode: "0700", owner: "vbcdx-control", group: "vbcdx-control" });
  assert.deepEqual(dir("/etc/vbcdx-control/default"), { path: "/etc/vbcdx-control/default", mode: "0750", owner: "root", group: "vbcdx-control" });
  const [f] = p.files;
  assert.deepEqual([f.path, f.mode, f.owner, f.group], ["/etc/vbcdx-control/default/control.toml", "0640", "root", "vbcdx-control"]);
  assert.deepEqual({ ...tomlParse(f.text) }, { admin_socket: "/run/vbcdx-control/default.admin.sock", state_dir: "/var/lib/vbcdx-control/default" });
  assert.equal(f.sha256, sha(f.text));
  assert.equal(p.listen, "unix:/run/vbcdx-control/default.admin.sock");
  assert.equal(p.unit.path, "/etc/systemd/system/vbcdx-control-plane-default.service");
  assert.deepEqual(p.check, ["/usr/local/lib/vbcdx/control-plane/0.1.0/vbcdx-control", "check", "--instance", "default",
    "--instance-dir", "/etc/vbcdx-control/default"]);
});

test("the unit follows core's reference: check then serve, as vbcdx-control, hardened; narrowed to unix sockets without --tunnel", () => {
  const t = plan(host(), release(), ["--instance", "cp1"]).unit.text;
  const lines = t.split("\n");
  const exec = "/usr/local/lib/vbcdx/control-plane/0.1.0/vbcdx-control";
  const args = "--instance cp1 --instance-dir /etc/vbcdx-control/cp1";
  // The reference unit's [Service] lines (vbcdx-core crates/vbcdx-control/systemd/vbcdx-control@.service),
  // with the installer's versioned binary in place of /usr/bin. One line deliberately differs: with
  // no --tunnel the installer renders RestrictAddressFamilies=AF_UNIX, where the reference (since
  // the tunnel listener) allows AF_UNIX AF_INET AF_INET6.
  for (const line of ["Type=exec", "User=vbcdx-control", "Group=vbcdx-control", `ExecStartPre=${exec} check ${args}`,
    `ExecStart=${exec} serve ${args}`, "Restart=on-failure", "RestartSec=2s", "UMask=0077", "StateDirectory=vbcdx-control/cp1",
    "StateDirectoryMode=0700", "RuntimeDirectory=vbcdx-control", "RuntimeDirectoryMode=0700", "RuntimeDirectoryPreserve=yes",
    "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes", "PrivateDevices=yes",
    "ProtectKernelTunables=yes", "ProtectKernelModules=yes", "ProtectKernelLogs=yes", "ProtectControlGroups=yes",
    "ProtectClock=yes", "ProtectHostname=yes", "ProtectProc=invisible", "ProcSubset=pid", "RestrictAddressFamilies=AF_UNIX",
    "RestrictNamespaces=yes", "RestrictRealtime=yes", "RestrictSUIDSGID=yes", "LockPersonality=yes",
    "MemoryDenyWriteExecute=yes", "SystemCallArchitectures=native", "SystemCallFilter=@system-service",
    "SystemCallFilter=~@privileged @resources", "CapabilityBoundingSet=", "AmbientCapabilities=", "LimitCORE=0",
    "WantedBy=multi-user.target"]) {
    assert.ok(lines.includes(line), `missing: ${line}`);
  }
  assert.equal(lines.filter((l) => l.startsWith("RestrictAddressFamilies=")).length, 1, "one address-family line, AF_UNIX only");
  assert.ok(!lines.some((l) => /^(ExecReload|User=vbcdx$|Group=vbcdx$)/.test(l)), "nothing of the sidecar's unit");
  assert.ok(!t.includes("node_modules"));
});

test("a control plane and a sidecar of the same instance share no file, dir, user or unit", () => {
  const h = host();
  const rel = release();
  const cp = plan(h, rel);
  const sc = planInstall(parseServiceArgs(["install", "service", "sidecar", "--from", rel]), h.deps).plan;
  const paths = (p) => new Set([...p.dirs.map((d) => d.path), ...p.files.map((f) => f.path), ...p.binaries.map((b) => b.to),
    p.symlink.path, p.unit.path, p.state_dir, p.config_dir, p.listen]);
  const common = [...paths(cp)].filter((x) => paths(sc).has(x));
  // Only the shared library root, which neither remove deletes.
  assert.deepEqual(common, ["/usr/local/lib/vbcdx"]);
  assert.notEqual(cp.user.name, sc.user.name);
});

test("install: user vbcdx-control with its own home, owners, check as that user, then enable --now", () => {
  const h = host();
  const r = install(h, release()).report;
  assert.equal(r.changed, true);
  assert.deepEqual(calls(h, "useradd"), ["--system --user-group --home-dir /var/lib/vbcdx-control --no-create-home --shell /usr/sbin/nologin vbcdx-control"]);
  assert.ok(calls(h, "chown").includes(`vbcdx-control:vbcdx-control ${at(h, "/var/lib/vbcdx-control/default")}`));
  assert.ok(calls(h, "chown").includes(`root:vbcdx-control ${at(h, "/etc/vbcdx-control/default/control.toml")}`));
  assert.deepEqual(calls(h, "runuser"), [`-u vbcdx-control -- ${at(h, "/usr/local/lib/vbcdx/control-plane/0.1.0/vbcdx-control")} check --instance default --instance-dir /etc/vbcdx-control/default`]);
  assert.deepEqual(lifecycle(h), ["daemon-reload", "enable --now vbcdx-control-plane-default.service"]);
  assert.ok(waitedAfter(h, "enable --now vbcdx-control-plane-default.service"), "install waits for the daemon after starting it");
  assert.equal(statSync(at(h, "/etc/vbcdx-control/default/control.toml")).mode & 0o777, 0o640);
  assert.equal(statSync(at(h, "/var/lib/vbcdx-control/default")).mode & 0o777, 0o700);
  const rec = recordOf(h)["control-plane:default"];
  assert.deepEqual([rec.service, rec.version, rec.state_dir, rec.config_dir], ["control-plane", "0.1.0", "/var/lib/vbcdx-control/default", "/etc/vbcdx-control/default"]);
});

test("installing twice is changed:false and runs no command", () => {
  const h = host();
  const rel = release();
  install(h, rel);
  const before = h.sys.calls.length;
  assert.equal(install(h, rel).report.changed, false);
  assert.equal(h.sys.calls.length, before);
});

test("a config vbcdx-control check refuses never reaches a unit, and the message is the control plane's", () => {
  const h = host({ check: () => ({ status: 2, stderr: "vbcdx-control: control.toml: unknown key x\n" }) });
  assert.throws(() => install(h, release()), (e) => {
    assert.match(e.message, /^The control-plane refuses the config install wrote \(vbcdx-control check exited 2\); nothing was started\.$/);
    return true;
  });
  assert.deepEqual(calls(h, "systemctl"), []);
  assert.ok(!existsSync(at(h, "/etc/vbcdx-control/default/control.toml")), "the config it wrote is taken back");
  assert.ok(!existsSync(at(h, "/root/.vbcdx/manifests/installation.json")) || !recordOf(h)["control-plane:default"]);
  // The rest of what this run made goes too: its user and every directory it created.
  assert.equal(calls(h, "useradd").length, 1, "the fixture really created the user first");
  assert.deepEqual(calls(h, "userdel"), ["vbcdx-control"]);
  for (const p of ["/usr/local/lib/vbcdx", "/var/lib/vbcdx-control", "/etc/vbcdx-control"]) assert.ok(!existsSync(at(h, p)), `${p} is gone`);
});

test("the rollback removes only empty directories: one holding something this run didn't write stays", () => {
  let root = null;
  const foreign = "/var/lib/vbcdx-control/default/not-from-this-run";
  // `check` runs after the directories exist; whatever lands in one meanwhile is not this run's.
  const h = host({ check: () => (writeFileSync(join(root, foreign), "x"), { status: 2, stderr: "vbcdx-control: refused\n" }) });
  root = h.root;
  assert.throws(() => install(h, release()), /refuses the config/);
  assert.equal(readFileSync(at(h, foreign), "utf8"), "x", "the file is untouched");
  assert.ok(existsSync(at(h, "/var/lib/vbcdx-control/default")) && existsSync(at(h, "/var/lib/vbcdx-control")), "its directory and that one's parent stay");
  for (const p of ["/etc/vbcdx-control", "/usr/local/lib/vbcdx"]) assert.ok(!existsSync(at(h, p)), `${p} (empty, made by this run) is gone`);
});

test("co-hosted: removing the control plane leaves the sidecar's install untouched", () => {
  const h = host();
  const rel = release();
  install(h, rel, "sidecar");
  install(h, rel);
  const sidecarConf = readFileSync(at(h, "/etc/vbcdx/default/sidecar.toml"));
  const r = run(["remove", "service", "control-plane"], h).report;
  assert.ok(r.actions.includes("stop and disable vbcdx-control-plane-default.service"));
  assert.ok(!existsSync(at(h, "/etc/vbcdx-control/default/control.toml")));
  assert.ok(!existsSync(at(h, "/usr/local/lib/vbcdx/control-plane/0.1.0")));
  assert.ok(!existsSync(at(h, "/usr/local/lib/vbcdx/control-plane/current")));
  assert.ok(existsSync(at(h, "/var/lib/vbcdx-control/default")), "state stays without --wipe");
  assert.deepEqual(readFileSync(at(h, "/etc/vbcdx/default/sidecar.toml")), sidecarConf);
  assert.ok(existsSync(at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-sidecar")));
  assert.deepEqual(Object.keys(recordOf(h)), ["sidecar:default"]);
  assert.equal(run(["list", "services"], h).report.services.length, 1);
});

// A real unix socket at `path` under the host root, with `mode`.
async function socketAt(h, path, mode) {
  const p = at(h, path);
  mkdirSync(dirname(p), { recursive: true });
  const srv = createServer();
  await new Promise((ok) => srv.listen(p, ok));
  chmodSync(p, mode);
  return srv;
}

test("doctor: ok with the admin socket 0600; a 0660 or missing socket, or a stopped unit, fails (exit 5)", async () => {
  const h = host();
  install(h, release());
  const doctor = () => run(["doctor", "--service", "control-plane"], h);
  const missing = doctor();
  assert.equal(missing.code, 5);
  assert.deepEqual(missing.report.checks.filter((c) => !c.ok).map((c) => c.check), ["admin socket 0600"]);
  const srv = await socketAt(h, "/run/vbcdx-control/default.admin.sock", 0o600);
  try {
    const ok = doctor();
    assert.equal(ok.code, 0, JSON.stringify(ok.report.checks.filter((c) => !c.ok)));
    assert.deepEqual(ok.report.checks.map((c) => c.check), ["binary vbcdx-control", "current symlink",
      "file /etc/vbcdx-control/default/control.toml", "state dir 0700", "unit file", "unit active", "admin socket 0600"]);
    chmodSync(at(h, "/run/vbcdx-control/default.admin.sock"), 0o660);
    assert.equal(doctor().code, 5);
  } finally {
    srv.close();
  }
  // A unit that stopped after install (install itself waits for the daemon to stay up).
  const stopped = host();
  install(stopped, release());
  stopped.unit.active = "inactive";
  const r = run(["doctor", "--service", "control-plane"], stopped);
  assert.ok(r.report.checks.some((c) => c.check === "unit active" && !c.ok));
});

test("a record is checked against the control plane's own layout", () => {
  const h = host();
  install(h, release());
  const rec = recordOf(h)["control-plane:default"];
  const where = { scope: "system", home: "/root" };
  assert.doesNotThrow(() => validateRecord("control-plane:default", rec, where));
  // The sidecar's paths in a control-plane record (a planted entry) are refused.
  assert.throws(() => validateRecord("control-plane:default", { ...rec, state_dir: "/var/lib/vbcdx/default" }, where), /unexpected state_dir/);
  assert.throws(() => validateRecord("control-plane:default", { ...rec, files: [{ ...rec.files[0], path: "/etc/vbcdx/default/sidecar.toml" }] }, where), /unexpected files/);
  // A user-scope control-plane record can't exist: refused even when it would match a user layout.
  assert.throws(() => validateRecord("control-plane:default", { ...rec, scope: "user" }, { scope: "user", home: "/home/u" }), /unexpected scope/);
});

test("refused for the control plane in this version: a user install, --listen and --expose-on-network", () => {
  const rel = release();
  assert.throws(() => plan(host({ uid: 1000 }), rel), /control-plane install needs root in this version: it runs as the system user vbcdx-control/);
  assert.throws(() => plan(host(), rel, ["--listen", "127.0.0.1:8443"]), /--listen is for the sidecar; the control plane serves its admin socket only/);
  assert.throws(() => plan(host(), rel, ["--listen", "unix:/run/vbcdx-control/x.sock"]), /--listen is for the sidecar/);
  assert.throws(() => plan(host(), rel, ["--expose-on-network", "--i-understand-network-exposure"]), /--expose-on-network needs a --listen/);
});

test("--service none prints how to run it: serve, not the sidecar's run", () => {
  const p = plan(host(), release(), ["--service", "none"]);
  assert.equal(p.unit, null);
  assert.equal(p.run, "/usr/local/lib/vbcdx/control-plane/0.1.0/vbcdx-control serve --instance default --instance-dir /etc/vbcdx-control/default");
});

test("a release without vbcdx-control is refused before anything is written", () => {
  const rel = release();
  const doc = JSON.parse(readFileSync(join(rel, "checksums.json"), "utf8"));
  delete doc.files["@vbcdx/sidecar-linux-x64-gnu/bin/vbcdx-control"];
  const sums = Buffer.from(JSON.stringify(doc));
  writeFileSync(join(rel, "checksums.json"), sums);
  writeFileSync(join(rel, "checksums.json.minisig"), signFile(KEY, sums, "vbcdx-release @vbcdx/sidecar 0.1.0"));
  const h = host();
  assert.throws(() => install(h, rel), /no checksum for @vbcdx\/sidecar-linux-x64-gnu\/bin\/vbcdx-control/);
  assert.deepEqual(h.sys.calls, []);
});

test("every generated control.toml holds only CONTROL's keys, as absolute paths", () => {
  const tunnel = ["--tunnel", "0.0.0.0:8443", "--tunnel-name", "cp.example"];
  for (const [instance, extra] of [["default", []], ["two", []], ["a-1", []], ["default", tunnel], ["t-2", tunnel]]) {
    const doc = tomlParse(plan(host(), release(), ["--instance", instance, ...extra]).files[0].text);
    for (const k of Object.keys(doc)) assert.ok(CONTROL_KEYS.includes(k), `${instance}: ${k} is not a CONTROL key`);
    assert.equal(doc.admin_socket, `/run/vbcdx-control/${instance}.admin.sock`);
    assert.equal(doc.state_dir, `/var/lib/vbcdx-control/${instance}`);
    assert.deepEqual([doc.tunnel, doc.tunnel_name], extra.length ? ["vbcdx+https://0.0.0.0:8443?auth=mtls", "cp.example"] : [undefined, undefined]);
  }
});

// The real daemon, from a packed release tree: `check` resolves the config and binds nothing.
// Run it on a test host, never on a hypervisor; it needs root and the vbcdx-control user's paths.
const BIN = process.env.VBCDX_CONTROL_BIN;
test("the real vbcdx-control check accepts every generated control.toml", { skip: !BIN && "set VBCDX_CONTROL_BIN to a vbcdx-control from a packed tree" }, () => {
  const root = tempDir("vbcdx-control-check-");
  try {
    for (const instance of ["default", "two", "a-1"]) {
      const p = plan(host(), release(), ["--instance", instance]);
      const dir = join(root, instance);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "control.toml"), p.files[0].text, { mode: 0o600 });
      const r = spawnSync(BIN, ["check", "--instance", instance, "--instance-dir", dir], { encoding: "utf8", env: { PATH: process.env.PATH } });
      assert.equal(r.status, 0, `${instance}: vbcdx-control check exited ${r.status}: ${r.stderr.trim()}`);
      const out = JSON.parse(r.stdout);
      assert.deepEqual([out.instance, out.admin_socket, out.state_dir, out.socket_mode],
        [instance, `/run/vbcdx-control/${instance}.admin.sock`, `/var/lib/vbcdx-control/${instance}`, "0600"]);
    }
    // And it is the real parser: a key outside CONTROL is refused.
    const bad = join(root, "bad");
    mkdirSync(bad, { recursive: true, mode: 0o700 });
    writeFileSync(join(bad, "control.toml"), 'listen = "vbcdx+unix:///run/vbcdx-control/x.sock"\n', { mode: 0o600 });
    const r = spawnSync(BIN, ["check", "--instance", "bad", "--instance-dir", bad], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(r.status, 2, r.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an edited control.toml is the user's too: a reinstall that would change it is refused (exit 5)", () => {
  const h = host();
  const rel = release();
  install(h, rel);
  const conf = at(h, "/etc/vbcdx-control/default/control.toml");
  writeFileSync(conf, readFileSync(conf, "utf8") + "# local edit\n");
  const edited = readFileSync(conf);
  assert.throws(() => install(h, rel, "control-plane", ["--tunnel", "0.0.0.0:8443", "--tunnel-name", "cp.example.com"]),
    (e) => e.code === 5 && e.message.includes("/etc/vbcdx-control/default/control.toml"));
  assert.deepEqual(readFileSync(conf), edited);
});

// An upgrade keeps the control plane's tunnel (carry.js, from the installed control.toml), and
// with it the unit's network address families: the documented `install service control-plane
// --version <new>` must never take the fleet offline.
const CONTROL_CONF = "/etc/vbcdx-control/default/control.toml";
const CONTROL_UNIT = "/etc/systemd/system/vbcdx-control-plane-default.service";
const TUNNEL = ["--tunnel", "0.0.0.0:8443", "--tunnel-name", "cp.example"];
test("an upgrade with nothing but the new version keeps the tunnel: config byte-identical, unit only the version path", () => {
  const h = host();
  install(h, release(), "control-plane", TUNNEL);
  const conf = readFileSync(at(h, CONTROL_CONF), "utf8");
  const unit = readFileSync(at(h, CONTROL_UNIT), "utf8");
  assert.match(unit, /^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m);
  install(h, release("0.2.0"));
  const after = tomlParse(readFileSync(at(h, CONTROL_CONF), "utf8"));
  assert.deepEqual([after.tunnel, after.tunnel_name], ["vbcdx+https://0.0.0.0:8443?auth=mtls", "cp.example"]);
  assert.equal(readFileSync(at(h, CONTROL_CONF), "utf8"), conf);
  assert.equal(readFileSync(at(h, CONTROL_UNIT), "utf8"), unit.replaceAll("/control-plane/0.1.0/", "/control-plane/0.2.0/"));
  assert.notEqual(unit.indexOf("/control-plane/0.1.0/"), -1, "the replace above changed something");
});

test("the control plane's upgrade dry run says upgrade, keeps the tunnel, lists only what changes; --no-tunnel clears it", () => {
  const h = host();
  install(h, release(), "control-plane", TUNNEL);
  const dry = install(h, release("0.2.0"), "control-plane", ["--dry-run"]);
  assert.equal(dry.code, 0);
  const text = humanPlan(dry.report);
  assert.match(text, /^Planned upgrade service control-plane 0\.1\.0 → 0\.2\.0 /);
  assert.match(text, /^ {2}keep tunnel 0\.0\.0\.0:8443 \(sidecars dial cp\.example\) \(from the installed \/etc\/vbcdx-control\/default\/control\.toml\)$/m);
  assert.doesNotMatch(text, /user: create system user/);
  assert.doesNotMatch(text, /control\.toml:$/m, "the config doesn't change: no diff for it");
  assert.doesNotMatch(text, /^ {6}[-+]RestrictAddressFamilies/m, "the address families don't change");
  // --no-tunnel: the tunnel lines and the network families go, shown as a diff first.
  const cleared = humanPlan(install(h, release("0.2.0"), "control-plane", ["--no-tunnel", "--dry-run"]).report);
  assert.match(cleared, /^ {6}-tunnel = "vbcdx\+https:\/\/0\.0\.0\.0:8443\?auth=mtls"$/m);
  assert.match(cleared, /^ {6}-RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$/m);
  assert.match(cleared, /^ {6}\+RestrictAddressFamilies=AF_UNIX$/m);
  install(h, release("0.2.0"), "control-plane", ["--no-tunnel"]);
  assert.equal(tomlParse(readFileSync(at(h, CONTROL_CONF), "utf8")).tunnel, undefined);
  assert.match(readFileSync(at(h, CONTROL_UNIT), "utf8"), /^RestrictAddressFamilies=AF_UNIX$/m);
});

test("a tunnel in the installed control.toml that isn't install's own form is refused, not dropped (exit 5)", () => {
  const h = host();
  install(h, release(), "control-plane", TUNNEL);
  writeFileSync(at(h, CONTROL_CONF), readFileSync(at(h, CONTROL_CONF), "utf8").replace('tunnel_name = "cp.example"\n', ""));
  assert.throws(() => install(h, release("0.2.0")), (e) => e.code === 5 && e.details.refused === "carry-over" && /--no-tunnel/.test(e.message));
  assert.ok(!existsSync(at(h, "/usr/local/lib/vbcdx/control-plane/0.2.0")), "nothing written");
});

test("the control plane's downgrade is refused too (exit 5, nothing written); --allow-downgrade does it and keeps the tunnel", () => {
  const h = host();
  install(h, release("0.2.0"), "control-plane", TUNNEL);
  assert.throws(() => install(h, release("0.1.0")), (e) => e.code === 5 && e.details.refused === "downgrade" && /runs 0\.2\.0, and 0\.1\.0 is older/.test(e.message));
  assert.ok(!existsSync(at(h, "/usr/local/lib/vbcdx/control-plane/0.1.0")), "nothing written");
  const r = install(h, release("0.1.0"), "control-plane", ["--allow-downgrade"]).report;
  assert.equal(r.downgraded_from, "0.2.0");
  assert.equal(tomlParse(readFileSync(at(h, CONTROL_CONF), "utf8")).tunnel_name, "cp.example", "the tunnel carried over the downgrade too");
});
