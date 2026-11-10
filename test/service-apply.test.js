import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keypair, signFile } from "./helpers/minisign-signer.js";
import { tempDir } from "./helpers/temp-dir.js";
import { humanPlan, planInstall, runService } from "../src/service/index.js";
import { applyInstall, LINE_MAX, lastDaemonLine, lineDiff, newestVersion, planChanges, safeLine, SETTLE_MS, START_DEADLINE_MS } from "../src/service/apply.js";
import { compareVersions } from "../src/service/areas.js";
import { parseServiceArgs } from "../src/service/args.js";
import { fakeSystem } from "../src/service/system.js";
import { fakeAccounts } from "./helpers/fake-accounts.js";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const KEY = keypair(5);

// `binBase` is where the platform package lands: the release dir itself for --from, or npm's
// node_modules (hoisted next to the meta package) for the registry path.
// `bodies` replaces a binary's contents (e.g. a stub or the real vbcdx-svc), checksummed as given.
function writeRelease(root, version, binBase = root, bodies = {}) {
  mkdirSync(root, { recursive: true });
  const files = {};
  for (const name of ["vbcdx-sidecar", "vbcdx-svc"]) {
    const rel = `@vbcdx/sidecar-linux-x64-gnu/bin/${name}`;
    mkdirSync(join(binBase, dirname(rel)), { recursive: true });
    const body = bodies[name] || Buffer.from(`#!/bin/sh\n# ${name} ${version}\n`);
    writeFileSync(join(binBase, rel), body, { mode: 0o755 });
    files[rel] = sha(body);
  }
  const sums = Buffer.from(JSON.stringify({ schema: 1, package: "@vbcdx/sidecar", version, files }));
  writeFileSync(join(root, "checksums.json"), sums);
  writeFileSync(join(root, "checksums.json.minisig"), signFile(KEY, sums, `vbcdx-release @vbcdx/sidecar ${version}`));
  return root;
}
const release = (version = "0.1.0") => writeRelease(tempDir("vbcdx-rel-"), version);

// A host: everything lands under a temp root; systemctl answers "active". There is no user
// vbcdx yet, and group vbcdx is the test's own group (the one its sockets get); `check`
// answers the daemon's `vbcdx-sidecar check`.
// `runs`: a binary name whose calls really execute (output captured); every other command is faked.
function host({ uid = 0, active = "active", npm, gid = process.getgid(), check = () => ({}), runtimeDir = "/run/user/1000", runs = null, accounts = {} } = {}) {
  const root = tempDir("vbcdx-host-");
  const home = uid === 0 ? "/root" : "/home/u";
  // Users and groups as shadow-utils keeps them (helpers/fake-accounts.js): no stub weaker than the host.
  const acct = fakeAccounts({ ...accounts, gid: gid });
  // The unit's state as systemctl reports it; a test can change it after install (`h.unit.active`).
  const unit = { active };
  const sys = fakeSystem(root, { uid, answer: (cmd, args) => {
    const a = acct.answer(cmd, args);
    if (a) return a;
    if (runs && cmd.endsWith(`/${runs}`)) {
      const r = spawnSync(cmd, args, { encoding: "utf8", env: { PATH: process.env.PATH } });
      return { status: r.status === null ? 1 : r.status, stdout: r.stdout, stderr: r.stderr };
    }
    if (args.includes("check")) return check(cmd, args);
    if (cmd === "systemctl" && args.includes("is-active")) return { stdout: `${unit.active}\n` };
    if (cmd === "npm" && npm) return npm(args);
    return {};
  } });
  return { acct, sys, root, unit, deps: { sys, trustedKeys: [KEY.pub], platformId: "linux-x64-gnu",
    host: { uid, home, runtimeDir: uid === 0 ? null : runtimeDir } } };
}
const run = (argv, h) => runService(parseServiceArgs(argv), h.deps);
const install = (h, rel, extra = []) => run(["install", "service", "sidecar", "--from", rel, ...extra], h);
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

test("install applies the plan: user, dirs and modes, verified copies, symlink, config, unit, then start", () => {
  const h = host();
  const r = install(h, release()).report;
  assert.equal(r.changed, true);
  assert.deepEqual(calls(h, "useradd"), ["--system --user-group --home-dir /var/lib/vbcdx --no-create-home --shell /usr/sbin/nologin vbcdx"]);
  assert.equal(statSync(at(h, "/var/lib/vbcdx/default")).mode & 0o777, 0o700);
  assert.equal(statSync(at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-sidecar")).mode & 0o777, 0o755);
  assert.equal(readlinkSync(at(h, "/usr/local/lib/vbcdx/sidecar/current")), "0.1.0");
  assert.equal(statSync(at(h, "/etc/vbcdx/default/sidecar.toml")).mode & 0o777, 0o640);
  assert.match(readFileSync(at(h, "/etc/systemd/system/vbcdx-sidecar-default.service"), "utf8"), /^ExecReload=\/bin\/kill -HUP \$MAINPID$/m);
  assert.ok(calls(h, "chown").includes(`vbcdx:vbcdx ${at(h, "/var/lib/vbcdx/default")}`));
  assert.ok(calls(h, "chown").includes(`root:vbcdx ${at(h, "/etc/vbcdx/default/sidecar.toml")}`));
  assert.deepEqual(lifecycle(h), ["daemon-reload", "enable --now vbcdx-sidecar-default.service"]);
  assert.ok(waitedAfter(h, "enable --now vbcdx-sidecar-default.service"), "install waits for the daemon after starting it");
  const rec = JSON.parse(readFileSync(at(h, "/root/.vbcdx/manifests/installation.json"), "utf8")).services["sidecar:default"];
  assert.deepEqual([rec.version, rec.scope, rec.state_dir], ["0.1.0", "system", "/var/lib/vbcdx/default"]);
});

test("installing twice with the same args is changed:false and runs no command", () => {
  const h = host();
  const rel = release();
  install(h, rel);
  const before = h.sys.calls.length;
  const r = install(h, rel).report;
  assert.equal(r.changed, false);
  assert.equal(h.sys.calls.length, before);
});

test("an existing vbcdx user is reused; --no-start enables without starting", () => {
  const h = host();
  h.sys.run = ((orig) => (cmd, args, o) => (cmd === "getent" ? (h.sys.calls.push([cmd, ...args]), { status: 0, stdout: "vbcdx:x:999" }) : orig(cmd, args, o)))(h.sys.run);
  install(h, release(), ["--no-start"]);
  assert.deepEqual(calls(h, "useradd"), []);
  assert.deepEqual(calls(h, "systemctl"), ["daemon-reload", "enable vbcdx-sidecar-default.service"]);
});

test("a new version flips current and restarts onto its own directory; npm alone never swaps the running binary", () => {
  const h = host();
  install(h, release("0.1.0"));
  const r = install(h, release("0.2.0")).report;
  assert.equal(r.upgraded_from, "0.1.0");
  assert.equal(readlinkSync(at(h, "/usr/local/lib/vbcdx/sidecar/current")), "0.2.0");
  assert.ok(calls(h, "systemctl").includes("restart vbcdx-sidecar-default.service"));
  assert.ok(!existsSync(at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0")), "the version it left goes");
  // The unit runs the copied binary under /usr/local/lib, never one in an npm tree.
  assert.match(readFileSync(at(h, "/etc/systemd/system/vbcdx-sidecar-default.service"), "utf8"),
    /^ExecStart=\/usr\/local\/lib\/vbcdx\/sidecar\/0\.2\.0\/vbcdx-sidecar /m);
});

test("a binary swapped after verification never reaches the install: the verified bytes are written", () => {
  const h = host();
  const rel = release();
  const src = join(rel, "@vbcdx/sidecar-linux-x64-gnu/bin/vbcdx-sidecar");
  const verified = readFileSync(src);
  h.sys.run = ((orig) => (cmd, args, o) => {
    // Mid-install, after verification: rewrite the source, then swap it for a symlink.
    if (cmd === "chown" && args[1].endsWith("/0.1.0")) {
      writeFileSync(src, "swapped");
      unlinkSync(src);
      symlinkSync("/etc/passwd", src);
    }
    return orig(cmd, args, o);
  })(h.sys.run);
  assert.equal(install(h, rel).report.changed, true);
  assert.deepEqual(readFileSync(at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-sidecar")), verified);
});

test("remove takes out what install wrote, keeps an edited file, and leaves state unless --wipe", () => {
  const h = host();
  install(h, release());
  writeFileSync(at(h, "/etc/vbcdx/default/sidecar.toml"), "# edited by hand\n");
  const dry = run(["remove", "service", "sidecar", "--dry-run"], h).report;
  assert.ok(dry.dryRun && dry.kept.includes("/etc/vbcdx/default/sidecar.toml"));
  assert.ok(existsSync(at(h, "/etc/systemd/system/vbcdx-sidecar-default.service")), "a dry run removes nothing");
  const r = run(["remove", "service", "sidecar"], h).report;
  assert.deepEqual(r.kept, ["/etc/vbcdx/default/sidecar.toml"]);
  assert.ok(existsSync(at(h, "/etc/vbcdx/default/sidecar.toml")));
  assert.ok(!existsSync(at(h, "/etc/systemd/system/vbcdx-sidecar-default.service")));
  assert.ok(!existsSync(at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0")));
  assert.ok(existsSync(at(h, "/var/lib/vbcdx/default")), "state stays without --wipe");
  assert.ok(calls(h, "systemctl").includes("disable --now vbcdx-sidecar-default.service"));
  assert.throws(() => run(["remove", "service", "sidecar"], h), (e) => e.code === 2);
});

test("remove --wipe deletes the recorded state dir; a second instance keeps the shared binaries", () => {
  const h = host();
  const rel = release();
  install(h, rel);
  install(h, rel, ["--instance", "two"]);
  run(["remove", "service", "sidecar", "--instance", "two", "--wipe"], h);
  assert.ok(!existsSync(at(h, "/var/lib/vbcdx/two")));
  assert.ok(existsSync(at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-sidecar")), "instance default still uses 0.1.0");
  assert.equal(readlinkSync(at(h, "/usr/local/lib/vbcdx/sidecar/current")), "0.1.0");
});

test("list services shows each instance with its unit state", () => {
  const h = host();
  install(h, release());
  const { services } = run(["list", "services"], h).report;
  assert.deepEqual(services.map((s) => [s.instance, s.version, s.state]), [["default", "0.1.0", "active"]]);
  assert.ok(!("modules" in services[0]), "the sidecar has no modules to list");
});

// Real sockets at the given host paths (doctor lstat()s them), with a mode.
async function sockets(h, paths, mode) {
  const servers = [];
  for (const p of paths) {
    mkdirSync(dirname(at(h, p)), { recursive: true });
    const server = createServer();
    await new Promise((ok) => server.listen(at(h, p), ok));
    chmodSync(at(h, p), mode);
    servers.push(server);
  }
  return () => Promise.all(servers.map((s) => new Promise((ok) => s.close(ok))));
}
const SYSTEM_SOCKETS = ["/run/vbcdx/default.sock", "/run/vbcdx/default.admin.sock"];

test("doctor exits 0 on a healthy install, with both sockets 0660 group vbcdx", async () => {
  const h = host();
  install(h, release());
  const close = await sockets(h, SYSTEM_SOCKETS, 0o660);
  try {
    const { report, code } = run(["doctor", "--service", "sidecar"], h);
    assert.equal(code, 0, JSON.stringify(report.checks.filter((c) => !c.ok)));
    for (const [name, path] of [["socket", SYSTEM_SOCKETS[0]], ["admin socket", SYSTEM_SOCKETS[1]]]) {
      assert.ok(report.checks.some((c) => c.check === `${name} 0660 group vbcdx` && c.detail === path && c.ok), name);
    }
  } finally {
    await close();
  }
});

test("doctor finds the sockets where the installed config puts them, and fails each wrong one", async () => {
  const cases = [
    ["no admin socket", {}, [SYSTEM_SOCKETS[0]], 0o660, /^admin socket 0660 group vbcdx$/],
    ["no listen socket", {}, [SYSTEM_SOCKETS[1]], 0o660, /^socket 0660 group vbcdx$/],
    ["sockets 0600 on a system install", {}, SYSTEM_SOCKETS, 0o600, /^socket 0660/],
    ["sockets owned by another group", { gid: process.getgid() + 1 }, SYSTEM_SOCKETS, 0o660, /^admin socket 0660 group vbcdx$/],
    ["no group vbcdx", { gid: null }, SYSTEM_SOCKETS, 0o660, /^socket 0660 group vbcdx$/],
  ];
  for (const [name, o, paths, mode, re] of cases) {
    const h = host(o);
    install(h, release());
    const close = await sockets(h, paths, mode);
    try {
      const { report, code } = run(["doctor", "--service", "sidecar"], h);
      assert.equal(code, 5, name);
      assert.ok(report.checks.some((c) => !c.ok && re.test(c.check)), `${name}: ${JSON.stringify(report.checks.filter((c) => !c.ok))}`);
    } finally {
      await close();
    }
  }
  // The listen socket named by --listen, not the default.
  const h = host();
  install(h, release(), ["--listen", "unix:/run/vbcdx/other.sock"]);
  const close = await sockets(h, ["/run/vbcdx/other.sock", "/run/vbcdx/default.admin.sock"], 0o660);
  try {
    assert.equal(run(["doctor", "--service", "sidecar"], h).code, 0);
  } finally {
    await close();
  }
  // A regular file where a socket belongs, with the right mode and group.
  const file = host();
  install(file, release());
  const closeOne = await sockets(file, [SYSTEM_SOCKETS[1]], 0o660);
  writeFileSync(at(file, SYSTEM_SOCKETS[0]), "", { mode: 0o660 });
  chmodSync(at(file, SYSTEM_SOCKETS[0]), 0o660);
  try {
    const { report } = run(["doctor", "--service", "sidecar"], file);
    assert.ok(report.checks.some((c) => c.check === "socket 0660 group vbcdx" && !c.ok), "a regular file is not a socket");
  } finally {
    await closeOne();
  }
  // A config that is not the one install wrote: its sockets aren't trusted.
  const edited = host();
  install(edited, release());
  writeFileSync(at(edited, "/etc/vbcdx/default/sidecar.toml"), 'listen = "vbcdx+unix:///run/vbcdx/default.sock"\nadmin_socket = "/x"\n');
  const closeEdited = await sockets(edited, SYSTEM_SOCKETS, 0o660);
  try {
    const { report } = run(["doctor", "--service", "sidecar"], edited);
    assert.ok(report.checks.some((c) => c.check === "sockets" && !c.ok));
  } finally {
    await closeEdited();
  }
});

test("doctor reads the listen socket's path back out of its connection string", async () => {
  // A runtime dir with a space: the config holds it percent-encoded, the socket is at the plain path.
  const h = host({ uid: 1000, runtimeDir: "/run/user/1000 x" });
  install(h, release());
  assert.match(readFileSync(at(h, "/home/u/.vbcdx/services/default/sidecar.toml"), "utf8"), /1000%20x/);
  const close = await sockets(h, ["/run/user/1000 x/vbcdx/default.sock", "/run/user/1000 x/vbcdx/default.admin.sock"], 0o600);
  try {
    const { report, code } = run(["doctor", "--service", "sidecar"], h);
    assert.equal(code, 0, JSON.stringify(report.checks.filter((c) => !c.ok)));
  } finally {
    await close();
  }
});

test("doctor on a user install wants both sockets 0600 under XDG_RUNTIME_DIR", async () => {
  const user = ["/run/user/1000/vbcdx/default.sock", "/run/user/1000/vbcdx/default.admin.sock"];
  for (const [mode, code] of [[0o600, 0], [0o660, 5]]) {
    const h = host({ uid: 1000 });
    install(h, release());
    const close = await sockets(h, user, mode);
    try {
      const { report, code: got } = run(["doctor", "--service", "sidecar"], h);
      assert.equal(got, code, JSON.stringify(report.checks.filter((c) => !c.ok)));
      assert.ok(report.checks.some((c) => c.check === "admin socket 0600" && c.ok === (code === 0)));
    } finally {
      await close();
    }
  }
});

test("install runs the daemon's check on the written config, as vbcdx, before the unit exists", () => {
  const h = host();
  install(h, release());
  const bin = at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-sidecar");
  const i = h.sys.calls.findIndex((c) => c[0] === "runuser");
  assert.deepEqual(h.sys.calls[i], ["runuser", "-u", "vbcdx", "--", bin, "check", "--instance", "default", "--instance-dir", "/etc/vbcdx/default"]);
  assert.ok(i > h.sys.calls.findIndex((c) => c[0] === "chown" && c[2].endsWith("/etc/vbcdx/default/sidecar.toml")), "after the config");
  assert.ok(i < h.sys.calls.findIndex((c) => c[0] === "systemctl"), "before any systemctl");
  // A user install runs it as itself.
  const u = host({ uid: 1000 });
  install(u, release());
  assert.ok(u.sys.calls.some((c) => c[0] === at(u, "/home/u/.vbcdx/lib/sidecar/0.1.0/vbcdx-sidecar")
    && c.slice(1).join(" ") === "check --instance default --instance-dir /home/u/.vbcdx/services/default"));
});

test("a config the daemon refuses stops the install: the daemon's reason, no unit, nothing recorded", () => {
  for (const uid of [0, 1000]) {
    const h = host({ uid, check: () => ({ status: 2, stderr: "vbcdx-sidecar: /etc/vbcdx/default/sidecar.toml: unknown key instance\n" }) });
    assert.throws(() => install(h, release()), (e) => e.code === 6 && /refuses the config/.test(e.message)
      && e.details.lines.includes("vbcdx-sidecar: /etc/vbcdx/default/sidecar.toml: unknown key instance"));
    assert.equal(calls(h, "systemctl").length, 0, "no unit was loaded");
    const conf = uid === 0 ? "/etc/vbcdx/default/sidecar.toml" : "/home/u/.vbcdx/services/default/sidecar.toml";
    assert.ok(!existsSync(at(h, conf)), "the config is taken out again");
    assert.ok(!existsSync(at(h, uid === 0 ? "/etc/systemd/system/vbcdx-sidecar-default.service"
      : "/home/u/.config/systemd/user/vbcdx-sidecar-default.service")));
    assert.deepEqual(run(["list", "services"], h).report.services, []);
  }
});

test("doctor exits 5 and names each problem", () => {
  const cases = [
    ["a changed binary", (h) => writeFileSync(at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-sidecar"), "x"), /binary vbcdx-sidecar/],
    ["a moved current", (h) => { const p = at(h, "/usr/local/lib/vbcdx/sidecar/current"); unlinkSync(p); symlinkSync("9.9.9", p); }, /current symlink/],
    ["a loosened state dir", (h) => chmodSync(at(h, "/var/lib/vbcdx/default"), 0o755), /state dir 0700/],
    ["no socket", () => {}, /^socket 0660 group vbcdx$/],
  ];
  for (const [name, breakIt, re] of cases) {
    const h = host();
    install(h, release());
    breakIt(h);
    const { report, code } = run(["doctor", "--service", "sidecar"], h);
    assert.equal(code, 5, name);
    assert.ok(report.checks.some((c) => !c.ok && re.test(c.check)), name);
  }
  // A unit that stopped after install (install itself waits for the daemon to stay up).
  const idle = host();
  install(idle, release());
  idle.unit.active = "inactive";
  assert.ok(run(["doctor", "--service", "sidecar"], idle).report.checks.some((c) => c.check === "unit active" && !c.ok));
});
test("service <action> and logs run systemctl / journalctl for the instance", () => {
  const h = host();
  install(h, release());
  run(["service", "sidecar", "restart"], h);
  run(["service", "sidecar", "logs", "--follow"], h);
  assert.ok(calls(h, "systemctl").includes("restart vbcdx-sidecar-default.service"));
  assert.deepEqual(calls(h, "journalctl"), ["-u vbcdx-sidecar-default.service --no-pager -f"]);
  const none = host();
  install(none, release(), ["--service", "none"]);
  assert.throws(() => run(["service", "sidecar", "status"], none), (e) => e.code === 2 && /--service none/.test(e.message));
});

test("config service sidecar … runs the recorded vbcdx-svc as `vbcdx-svc sidecar …`, never with the prefix", () => {
  const h = host();
  install(h, release());
  const argv = ["config", "service", "sidecar", "users", "list", "--json"];
  runService(parseServiceArgs(argv), h.deps);
  const bin = at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-svc");
  assert.deepEqual(h.sys.calls.at(-1), [bin, "sidecar", "users", "list", "--json"]);
  assert.ok(!h.sys.calls.at(-1).includes("config") && !h.sys.calls.at(-1).includes("service"), "the config service prefix is never passed");
  // On the installer's own terminal: vbcdx-svc's stdout and stderr are the command's.
  assert.equal(h.sys.opts.at(-1).inherit, true, "configExec runs vbcdx-svc with inherit");
  writeFileSync(at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-svc"), "#!/bin/sh\necho swapped\n");
  assert.throws(() => runService(parseServiceArgs(argv), h.deps), (e) => e.code === 5 && /does not match/.test(e.message));
  const none = host();
  assert.throws(() => runService(parseServiceArgs(argv), none.deps), (e) => e.code === 2 && /install service sidecar/.test(e.message));
});

test("config service --instance finds that instance's record and passes --instance on to vbcdx-svc", () => {
  // Instance two runs another version, so the binary's path shows which record was used.
  const h = host();
  install(h, release());
  install(h, release("0.2.0"), ["--instance", "two"]);
  const two = at(h, "/usr/local/lib/vbcdx/sidecar/0.2.0/vbcdx-svc");
  runService(parseServiceArgs(["config", "service", "sidecar", "--instance", "two", "users", "list"]), h.deps);
  assert.deepEqual(h.sys.calls.at(-1), [two, "sidecar", "--instance", "two", "users", "list"]);
  runService(parseServiceArgs(["config", "service", "sidecar", "users", "list", "--instance=two"]), h.deps);
  assert.deepEqual(h.sys.calls.at(-1), [two, "sidecar", "users", "list", "--instance=two"]);
  runService(parseServiceArgs(["config", "service", "sidecar", "users", "list"]), h.deps);
  assert.equal(h.sys.calls.at(-1)[0], at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-svc"), "no --instance: the default instance");
});

test("config service: a stub vbcdx-svc sees exactly `sidecar …`, and its exit code is the command's", () => {
  // The stub writes the argv it was given to a file, once, from the one run configExec makes; exits 7.
  const seen = join(tempDir("vbcdx-argv-"), "argv");
  const stub = Buffer.from(`#!/bin/sh\nprintf "%s\\n" "$@" > '${seen}'\nexit 7\n`);
  const h = host({ runs: "vbcdx-svc" });
  install(h, writeRelease(tempDir("vbcdx-rel-"), "0.1.0", undefined, { "vbcdx-svc": stub }));
  const { code } = runService(parseServiceArgs(["config", "service", "sidecar", "auth", "login", "pw", "--json"]), h.deps);
  assert.equal(code, 7);
  assert.deepEqual(readFileSync(seen, "utf8").trim().split("\n"), ["sidecar", "auth", "login", "pw", "--json"]);
  assert.equal(h.sys.opts.at(-1).inherit, true, "configExec runs vbcdx-svc with inherit");
});

test("the real host runs an inherit command on the caller's own streams, with its own exit code", () => {
  // What configExec's `inherit` means on a real host: a child node process runs realSystem().run
  // with inherit, and the command's output lands on that process's stdout and stderr, unread.
  const system = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "service", "system.js");
  const child = (inherit) => spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { realSystem } from ${JSON.stringify(system)};
     const r = realSystem().run("sh", ["-c", "echo to-stdout; echo to-stderr >&2; exit 3"], { inherit: ${inherit} });
     process.exitCode = r.status;`], { encoding: "utf8" });
  const on = child(true);
  assert.deepEqual([on.status, on.stdout, on.stderr], [3, "to-stdout\n", "to-stderr\n"]);
  const off = child(false);
  assert.deepEqual([off.status, off.stdout, off.stderr], [3, "", ""], "without inherit the output is captured, not passed");
});

test("config service: --instance after `--` is vbcdx-svc's positional, not the record to use", () => {
  const h = host();
  install(h, release());
  install(h, release("0.2.0"), ["--instance", "two"]);
  runService(parseServiceArgs(["config", "service", "sidecar", "notes", "add", "--", "--instance", "two"]), h.deps);
  assert.deepEqual(h.sys.calls.at(-1), [at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-svc"), "sidecar", "notes", "add", "--", "--instance", "two"]);
});

// Keyhole's and Dispatch's commands run on the sidecar's vbcdx-svc, which carries their calls.
test("config service dispatch|keyhole …: the sidecar's vbcdx-svc sees exactly `dispatch|keyhole …`, and its exit code is the command's", () => {
  const seen = join(tempDir("vbcdx-argv-"), "argv");
  const stub = Buffer.from(`#!/bin/sh\nprintf "%s\\n" "$@" > '${seen}'\nexit 7\n`);
  const h = host({ runs: "vbcdx-svc" });
  install(h, writeRelease(tempDir("vbcdx-rel-"), "0.1.0-dev.4.1", undefined, { "vbcdx-svc": stub }));
  for (const argv of [
    ["dispatch", "messages", "send", "ws_1", "--org", "org_1", "--body", "hello there"],
    ["dispatch", "messages", "list", "ws_1", "--after", "3", "--json"],
    ["keyhole", "auth", "login", "--json"],
  ]) {
    const { code } = runService(parseServiceArgs(["config", "service", ...argv]), h.deps);
    assert.equal(code, 7, argv.join(" "));
    assert.deepEqual(readFileSync(seen, "utf8").trim().split("\n"), argv, "the area name is passed once, never doubled or dropped");
    assert.equal(h.sys.opts.at(-1).inherit, true);
  }
});

test("config service dispatch --instance runs that sidecar instance's vbcdx-svc; with no sidecar it says to install one", () => {
  const h = host();
  install(h, release());
  install(h, release("0.2.0"), ["--instance", "two"]);
  runService(parseServiceArgs(["config", "service", "dispatch", "--instance", "two", "messages", "list", "ws_1"]), h.deps);
  assert.deepEqual(h.sys.calls.at(-1), [at(h, "/usr/local/lib/vbcdx/sidecar/0.2.0/vbcdx-svc"), "dispatch", "--instance", "two", "messages", "list", "ws_1"]);
  runService(parseServiceArgs(["config", "service", "keyhole", "auth", "login"]), h.deps);
  assert.deepEqual(h.sys.calls.at(-1), [at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-svc"), "keyhole", "auth", "login"]);
  const none = host();
  assert.throws(() => runService(parseServiceArgs(["config", "service", "dispatch", "messages", "list", "ws_1"]), none.deps),
    (e) => e.code === 2 && /No sidecar instance "default" is installed: vbcdx install service sidecar/.test(e.message));
});

test("an older sidecar without `dispatch messages`: refused (exit 5) naming the release that has it, before vbcdx-svc runs", () => {
  const h = host();
  install(h, release("0.1.0-dev.3.1"));
  install(h, release("0.1.0-dev.3.1"), ["--instance", "two"]);
  const before = h.sys.calls.length;
  for (const argv of [["dispatch", "messages", "send", "ws_1", "--body", "hi"], ["dispatch", "--org", "org_1", "messages", "list", "ws_1"]]) {
    assert.throws(() => runService(parseServiceArgs(["config", "service", ...argv]), h.deps),
      (e) => e.code === 5 && /`dispatch messages` needs @vbcdx\/sidecar 0\.1\.0-dev\.4\.1 or later; sidecar instance "default" runs 0\.1\.0-dev\.3\.1/.test(e.message)
        && /vbcdx install service sidecar --version 0\.1\.0-dev\.4\.1/.test(e.message), argv.join(" "));
  }
  assert.throws(() => runService(parseServiceArgs(["config", "service", "dispatch", "--instance", "two", "messages", "list", "ws_1"]), h.deps),
    (e) => e.code === 5 && /instance "two"/.test(e.message) && /install service sidecar --instance two --version/.test(e.message));
  assert.equal(h.sys.calls.length, before, "vbcdx-svc never ran");
  // What that release does have still runs.
  runService(parseServiceArgs(["config", "service", "dispatch", "tools", "list"]), h.deps);
  assert.deepEqual(h.sys.calls.at(-1).slice(1), ["dispatch", "tools", "list"]);
  // After `--` everything is vbcdx-svc's positional, never the command.
  runService(parseServiceArgs(["config", "service", "dispatch", "--", "messages"]), h.deps);
  assert.deepEqual(h.sys.calls.at(-1).slice(1), ["dispatch", "--", "messages"]);
  // `messages` as an option's value is not the command.
  runService(parseServiceArgs(["config", "service", "dispatch", "--profile", "messages", "tools", "list"]), h.deps);
  assert.deepEqual(h.sys.calls.at(-1).slice(1), ["dispatch", "--profile", "messages", "tools", "list"]);
  // The release that added it, and later ones, run it.
  for (const v of ["0.1.0-dev.4.1", "0.1.0-dev.10", "0.1.0"]) {
    const up = host();
    install(up, release(v));
    runService(parseServiceArgs(["config", "service", "dispatch", "messages", "list", "ws_1"]), up.deps);
    assert.deepEqual(up.sys.calls.at(-1).slice(1), ["dispatch", "messages", "list", "ws_1"], v);
  }
});

test("config service control-plane is refused, naming what config service takes", () => {
  const h = host();
  install(h, release());
  assert.throws(() => runService(parseServiceArgs(["config", "service", "control-plane", "status"]), h.deps),
    (e) => e.code === 5 && /config service takes sidecar, keyhole or dispatch/.test(e.message));
});

test("compareVersions is SemVer precedence, numeric pre-release identifiers included", () => {
  const order = ["0.1.0-dev.3", "0.1.0-dev.3.1", "0.1.0-dev.4", "0.1.0-dev.4.1", "0.1.0-dev.10", "0.1.0-rc.1", "0.1.0", "0.1.1", "0.2.0", "1.0.0"];
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) {
      const c = Math.sign(compareVersions(order[i], order[j]));
      assert.equal(c, Math.sign(i - j), `${order[i]} vs ${order[j]}`);
    }
  }
  assert.equal(compareVersions("0.1.0-dev.4.1+build.7", "0.1.0-dev.4.1"), 0, "build metadata is ignored");
  assert.ok(compareVersions("1.0.0-1", "1.0.0-alpha") < 0, "a number is older than a word");
  // "-" sorts before digits as text, so these pin the numeric-vs-word rule in both directions.
  assert.ok(compareVersions("1.0.0-9", "1.0.0--") < 0, "a number is older than a word, even one that sorts first as text");
  assert.ok(compareVersions("1.0.0--", "1.0.0-9") > 0, "and the other way round");
});

test("config service: options go after the service name; one before it is refused with the grammar", () => {
  for (const argv of [["config", "service", "--instance", "two", "sidecar", "users", "list"], ["config", "service", "--json", "sidecar"]]) {
    assert.throws(() => parseServiceArgs(argv), (e) => e.code === 2 && /service name first: vbcdx config service sidecar \[--instance <i>\]/.test(e.message), argv.join(" "));
  }
});

// The real vbcdx-svc from a packed tree: it accepts what the installer passes, and refuses the
// old full argv the way a real run saw it (so the test can tell the two apart).
const SVC_BIN = process.env.VBCDX_SVC_BIN;
test("the real vbcdx-svc accepts `sidecar --help` as configExec passes it", { skip: !SVC_BIN && "set VBCDX_SVC_BIN to a vbcdx-svc from a packed tree" }, () => {
  const h = host({ runs: "vbcdx-svc" });
  install(h, writeRelease(tempDir("vbcdx-rel-"), "0.1.0", undefined, { "vbcdx-svc": readFileSync(SVC_BIN) }));
  chmodSync(at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-svc"), 0o755);
  const { code } = runService(parseServiceArgs(["config", "service", "sidecar", "--help"]), h.deps);
  assert.equal(code, 0);
  const old = spawnSync(SVC_BIN, ["config", "service", "sidecar", "--help"], { encoding: "utf8" });
  assert.equal(old.status, 2);
  assert.match(old.stderr, /unrecognized subcommand 'config'/);
});

test("a user install: systemctl --user, no useradd or chown, everything in HOME", () => {
  const h = host({ uid: 1000 });
  install(h, release());
  assert.deepEqual(calls(h, "useradd"), []);
  assert.deepEqual(calls(h, "chown"), []);
  assert.deepEqual(lifecycle(h), ["--user daemon-reload", "--user enable --now vbcdx-sidecar-default.service"]);
  assert.ok(waitedAfter(h, "--user enable --now vbcdx-sidecar-default.service"), "the wait uses systemctl --user");
  assert.equal(statSync(at(h, "/home/u/.vbcdx/services/default")).mode & 0o777, 0o700);
  assert.ok(existsSync(at(h, "/home/u/.config/systemd/user/vbcdx-sidecar-default.service")));
});

test("the registry path: npm --global --ignore-scripts into a private prefix, then the same verification", () => {
  const seen = [];
  const h = host({ npm: (args) => {
    seen.push(args);
    const prefix = args[args.indexOf("--prefix") + 1];
    // As npm lays it out: the meta package, with its platform package hoisted beside it.
    const modules = join(prefix, "lib", "node_modules");
    writeRelease(join(modules, "@vbcdx", "sidecar"), "0.3.0", modules);
    return { status: 0 };
  } });
  const r = run(["install", "service", "sidecar", "--version", "0.3.0"], h).report;
  assert.equal(r.version, "0.3.0");
  const args = seen[0];
  assert.ok(args.includes("--ignore-scripts") && args.includes("--global") && args.includes("@vbcdx/sidecar@0.3.0"));
  assert.ok(!args.some((a) => a.startsWith("--registry") || a.includes("_auth") || a.includes("token")), "no registry or credential on argv");
  const npmAt = h.sys.calls.findIndex((c) => c[0] === "npm");
  assert.equal(h.sys.opts[npmAt].cwd, args[args.indexOf("--prefix") + 1], "npm runs from the empty staging dir, so no project .npmrc applies");
  assert.ok(!existsSync(args[args.indexOf("--prefix") + 1]), "the staging prefix is removed");
  const failing = host({ npm: () => ({ status: 1 }) });
  assert.throws(() => run(["install", "service", "sidecar"], failing), (e) => e.code === 5 && /@vbcdx registry/.test(e.message));
});

test("a re-run repairs a recorded file that was deleted, instead of reporting changed:false", () => {
  const h = host();
  const rel = release();
  install(h, rel);
  unlinkSync(at(h, "/etc/systemd/system/vbcdx-sidecar-default.service"));
  assert.equal(install(h, rel).report.changed, true);
  assert.ok(existsSync(at(h, "/etc/systemd/system/vbcdx-sidecar-default.service")));
  unlinkSync(at(h, "/usr/local/lib/vbcdx/sidecar/current"));
  assert.equal(install(h, rel).report.changed, true, "a missing current is repaired too");
  assert.equal(readlinkSync(at(h, "/usr/local/lib/vbcdx/sidecar/current")), "0.1.0");
});

const recFile = (h, home = "/root") => at(h, `${home}/.vbcdx/manifests/installation.json`);
function editRecord(h, fn, { home = "/root", k = "sidecar:default" } = {}) {
  const m = JSON.parse(readFileSync(recFile(h, home), "utf8"));
  fn(m.services[k], m);
  writeFileSync(recFile(h, home), JSON.stringify(m));
}

test("a record is checked field by field against what install derives, and refused on any difference", () => {
  const rows = [
    ["set of fields", (r) => { r.extra = 1; }],
    ["service", (r) => { r.service = "nope"; }],
    ["instance", (r) => { r.instance = "two"; }],
    ["instance", (r, m) => { m.services["sidecar:../x"] = { ...r, instance: "../x" }; }],
    ["instance", (r, m) => { m.services["sidecar:123"] = { ...r, instance: 123 }; }],
    ["scope", (r) => { r.scope = "user"; }],
    ["package", (r) => { r.package = "@vbcdx/other"; }],
    ["version", (r) => { r.version = "../../etc"; }],
    ["version", (r) => { r.version = ["0.1.0"]; }],
    ["previous", (r) => { r.previous = "../x"; }],
    ["previous", (r) => { r.previous = ["0.1.0"]; }],
    ["platform", (r) => { r.platform = "../x"; }],
    ["platform", (r) => { r.platform = ["linux-x64-gnu"]; }],
    ["signer", (r) => { r.signer = "not-a-key-id"; }],
    ["signer", (r) => { r.signer = ["0123456789ABCDEF"]; }],
    ["binaries", (r) => { r.binaries[0].path = "/victim/keep/a"; }],
    ["binaries", (r) => { r.binaries = []; }],
    ["binaries", (r) => { r.binaries.reverse(); }],
    ["binaries", (r) => { r.binaries[1].sha256 = "x"; }],
    ["binaries", (r) => { r.binaries[0].extra = 1; }],
    ["symlink", (r) => { r.symlink.path = "/etc/passwd"; }],
    ["symlink", (r) => { r.symlink.target = "/etc"; }],
    ["dirs", (r) => { r.dirs[0].path = "/etc"; }],
    ["dirs", (r) => { r.dirs[4].mode = "0777"; }],
    ["files", (r) => { r.files[0].path = "/etc/shadow"; }],
    ["files", (r) => { r.files[0].sha256 = "x"; }],
    ["files", (r) => { r.files[0].extra = 1; }],
    ["files", (r) => { r.files.push({ path: "/etc/shadow", sha256: r.files[0].sha256 }); }],
    ["unit", (r) => { r.unit.name = "ssh.service"; }],
    ["unit", (r) => { r.unit.path = "/etc/systemd/system/ssh.service"; }],
    ["unit", (r) => { r.unit.sha256 = "x"; }],
    ["unit", (r) => { r.unit.extra = 1; }],
    ["modules", (r) => { r.modules = { path: "/etc/shadow", sha256: "a".repeat(64) }; }],
    ["modules", (r) => { r.modules = { path: "/etc/vbcdx/default/modules.toml", sha256: "x" }; }],
    ["modules", (r) => { r.modules = { path: "/etc/vbcdx/default/modules.toml", sha256: "a".repeat(64), extra: 1 }; }],
    ["state_dir", (r) => { r.state_dir = "/etc"; }],
    ["state_dir", (r) => { r.state_dir = "/var/lib/vbcdx/other"; }],
    ["config_dir", (r) => { r.config_dir = "/etc"; }],
    ["listen", (r) => { r.listen = "garbage"; }],
    ["listen", (r) => { r.listen = "unix:/etc/x.sock"; }],
  ];
  for (const [field, mutate] of rows) {
    const h = host();
    install(h, release());
    editRecord(h, mutate);
    const re = new RegExp(`unexpected ${field};`);
    for (const argv of [["list", "services"], ["doctor", "--service", "sidecar"], ["service", "sidecar", "restart"],
      ["config", "service", "sidecar", "users", "list"], ["remove", "service", "sidecar", "--wipe"]]) {
      assert.throws(() => run(argv, h), (e) => e.code === 4 && re.test(e.message), `${field} (${mutate}) via ${argv.join(" ")}`);
    }
  }
});

test("remove checks the whole record before any step: a planted path deletes nothing (all or nothing)", () => {
  const h = host();
  install(h, release());
  mkdirSync(at(h, "/victim/keep"), { recursive: true });
  writeFileSync(at(h, "/victim/keep/a"), "keep me");
  editRecord(h, (r) => { r.binaries[0].path = "/victim/keep/a"; });
  const before = h.sys.calls.length;
  assert.throws(() => run(["remove", "service", "sidecar", "--wipe"], h), (e) => e.code === 4);
  assert.equal(readFileSync(at(h, "/victim/keep/a"), "utf8"), "keep me");
  assert.ok(existsSync(at(h, "/etc/systemd/system/vbcdx-sidecar-default.service")), "the unit is still there");
  assert.ok(existsSync(at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-sidecar")) && existsSync(at(h, "/var/lib/vbcdx/default")));
  assert.equal(h.sys.calls.length, before, "no systemctl, nothing run");
});

test("--wipe deletes only this instance's own state dir: another instance's, or one outside HOME, is refused first", () => {
  const sys = host();
  install(sys, release());
  install(sys, release(), ["--instance", "other"]);
  editRecord(sys, (r) => { r.state_dir = "/var/lib/vbcdx/other"; });
  assert.throws(() => run(["remove", "service", "sidecar", "--wipe"], sys), (e) => e.code === 4 && /state_dir/.test(e.message));
  assert.ok(existsSync(at(sys, "/var/lib/vbcdx/other")) && existsSync(at(sys, "/var/lib/vbcdx/default")));
  const user = host({ uid: 1000 });
  install(user, release());
  mkdirSync(at(user, "/anything/.vbcdx/services/default"), { recursive: true });
  editRecord(user, (r) => { r.state_dir = "/anything/.vbcdx/services/default"; }, { home: "/home/u" });
  assert.throws(() => run(["remove", "service", "sidecar", "--wipe"], user), (e) => e.code === 4 && /state_dir/.test(e.message));
  assert.ok(existsSync(at(user, "/anything/.vbcdx/services/default")) && existsSync(at(user, "/home/u/.config/systemd/user/vbcdx-sidecar-default.service")));
});

test("the record is trusted only as a regular file owned by the effective user and writable by no one else", () => {
  for (const [name, breakIt] of [
    ["group-writable", (h) => chmodSync(recFile(h), 0o660)],
    ["world-writable", (h) => chmodSync(recFile(h), 0o606)],
    // Explicit modes throughout, so only the check named in each row can refuse it (whatever the umask).
    ["a directory in its place", (h) => { unlinkSync(recFile(h)); mkdirSync(recFile(h)); chmodSync(recFile(h), 0o755); }],
    ["a symlinked directory on its path", (h) => {
      const dir = dirname(recFile(h));
      mkdirSync(at(h, "/elsewhere"), { recursive: true });
      chmodSync(at(h, "/elsewhere"), 0o755);
      writeFileSync(at(h, "/elsewhere/installation.json"), readFileSync(recFile(h)));
      chmodSync(at(h, "/elsewhere/installation.json"), 0o644);
      unlinkSync(recFile(h));
      rmdirSync(dir);
      symlinkSync(at(h, "/elsewhere"), dir);
    }],
  ]) {
    const h = host();
    install(h, release());
    breakIt(h);
    assert.throws(() => run(["list", "services"], h), (e) => e.code === 4 && /trust|symlink/.test(e.message), name);
  }
  const h = host();
  install(h, release());
  const other = fakeSystem(h.root, { uid: 0, euid: process.geteuid() + 1 });
  assert.throws(() => runService(parseServiceArgs(["list", "services"]), { ...h.deps, sys: other }), (e) => e.code === 4 && /owned by you/.test(e.message));
});

test("under umask 077 every level still gets its own mode: group vbcdx can reach its config and state", () => {
  const old = process.umask(0o077);
  try {
    const h = host();
    install(h, release());
    const m = (p) => (statSync(at(h, p)).mode & 0o777).toString(8);
    assert.deepEqual(["/etc", "/etc/systemd/system", "/etc/vbcdx", "/etc/vbcdx/default", "/var/lib/vbcdx", "/var/lib/vbcdx/default",
      "/usr/local/lib", "/usr/local/lib/vbcdx", "/usr/local/lib/vbcdx/sidecar", "/usr/local/lib/vbcdx/sidecar/0.1.0",
      "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-sidecar", "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-svc"].map(m),
    ["755", "755", "755", "750", "755", "700", "755", "755", "755", "755", "755", "755"]);
    for (const p of ["/etc/vbcdx", "/var/lib/vbcdx", "/usr/local/lib/vbcdx"]) assert.ok(calls(h, "chown").includes(`root:root ${at(h, p)}`), p);
    assert.ok(calls(h, "chown").includes(`root:vbcdx ${at(h, "/etc/vbcdx/default")}`));
    const u = host({ uid: 1000 });
    install(u, release());
    assert.equal(statSync(at(u, "/home/u/.config/systemd/user")).mode & 0o777, 0o700);
  } finally {
    process.umask(old);
  }
});

test("install never creates through a symlinked or non-directory level it owns", () => {
  for (const level of ["/usr/local/lib/vbcdx/sidecar", "/var/lib/vbcdx", "/etc/vbcdx/default"]) {
    const h = host();
    mkdirSync(at(h, "/elsewhere"), { recursive: true });
    mkdirSync(dirname(at(h, level)), { recursive: true });
    symlinkSync(at(h, "/elsewhere"), at(h, level));
    assert.throws(() => install(h, release()), (e) => e.code === 4 && /symlink or not a directory/.test(e.message), level);
    assert.deepEqual(readdirSync(at(h, "/elsewhere")), [], level);
  }
});

test("a binary is never written through a file or link already at its temp name", () => {
  const h = host();
  const dest = at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-sidecar");
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(at(h, "/outside"), "untouched");
  symlinkSync(at(h, "/outside"), `${dest}.vbcdx-tmp-${process.pid}`);
  assert.throws(() => install(h, release()), (e) => e.code === "EEXIST");
  assert.equal(readFileSync(at(h, "/outside"), "utf8"), "untouched");
  assert.ok(!existsSync(dest));
});

test("instances on different versions: each unit runs its own version, current is the newest left, then goes", () => {
  const h = host();
  const rel1 = release("0.1.0");
  install(h, rel1);
  install(h, release("0.3.0"), ["--instance", "two"]);
  install(h, release("0.2.0"), ["--instance", "three"]);
  const lib = "/usr/local/lib/vbcdx/sidecar";
  const current = () => readlinkSync(at(h, `${lib}/current`));
  assert.equal(current(), "0.2.0");
  for (const [i, v] of [["default", "0.1.0"], ["two", "0.3.0"], ["three", "0.2.0"]]) {
    assert.match(readFileSync(at(h, `/etc/systemd/system/vbcdx-sidecar-${i}.service`), "utf8"), new RegExp(`^ExecStart=${lib}/${v.replace(/\./g, "\\.")}/vbcdx-sidecar `, "m"), i);
  }
  assert.equal(install(h, rel1).report.changed, false, "a re-run is a no-op although current names another version");
  const plan = run(["remove", "service", "sidecar", "--instance", "three", "--dry-run"], h).report.actions;
  assert.ok(plan.includes(`point ${lib}/current at 0.3.0`), plan.join("; "));
  run(["remove", "service", "sidecar", "--instance", "three"], h);
  assert.equal(current(), "0.3.0");
  assert.ok(!existsSync(at(h, `${lib}/0.2.0`)) && existsSync(at(h, `${lib}/0.1.0`)) && existsSync(at(h, `${lib}/0.3.0`)));
  run(["remove", "service", "sidecar", "--instance", "two"], h);
  assert.equal(current(), "0.1.0");
  assert.equal(run(["doctor", "--service", "sidecar"], h).report.checks.find((c) => c.check === "current symlink").ok, true);
  run(["remove", "service", "sidecar"], h);
  assert.ok(!existsSync(at(h, `${lib}/current`)) && !existsSync(at(h, `${lib}/0.1.0`)));
});

test("an upgrade keeps the old version while another instance still runs it", () => {
  const h = host();
  const rel = release("0.1.0");
  install(h, rel);
  install(h, rel, ["--instance", "two"]);
  install(h, release("0.2.0"), ["--instance", "two"]);
  assert.ok(existsSync(at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-sidecar")), "default still runs 0.1.0");
  assert.equal(run(["doctor", "--service", "sidecar"], h).report.checks.find((c) => c.check === "binary vbcdx-sidecar").ok, true);
});

test("newestVersion orders by SemVer precedence", () => {
  assert.equal(newestVersion(["0.9.0", "0.10.0"]), "0.10.0");
  assert.equal(newestVersion(["1.0.0", "1.0.0-rc.1"]), "1.0.0");
  assert.equal(newestVersion(["1.0.0-rc.1", "1.0.0"]), "1.0.0");
  assert.equal(newestVersion(["1.0.0-b", "1.0.0-a"]), "1.0.0-b");
  assert.equal(newestVersion(["2.0.0", "10.0.0", "9.9.9"]), "10.0.0");
});

test("remove works when the unit file was already deleted by hand: stopped, not disabled", () => {
  const h = host();
  install(h, release());
  const unit = at(h, "/etc/systemd/system/vbcdx-sidecar-default.service");
  // As systemctl does: disabling a unit whose file is gone fails.
  h.sys.run = ((orig) => (cmd, args, o) => (cmd === "systemctl" && args.includes("disable") && !existsSync(unit)
    ? (h.sys.calls.push([cmd, ...args]), { status: 1, stdout: "", stderr: "Unit file does not exist." }) : orig(cmd, args, o)))(h.sys.run);
  unlinkSync(unit);
  const r = run(["remove", "service", "sidecar"], h).report;
  assert.equal(r.removed, true);
  assert.ok(calls(h, "systemctl").includes("stop vbcdx-sidecar-default.service"));
  assert.ok(!calls(h, "systemctl").some((c) => c.startsWith("disable")));
  assert.ok(!existsSync(at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0")));
});

test("a failure midway rolls the install back: nothing new is left, an upgrade returns to the old version", () => {
  const failOn = (h, verb) => {
    h.sys.run = ((orig) => (cmd, args, o) => (cmd === "systemctl" && args[0] === verb
      ? (h.sys.calls.push([cmd, ...args]), { status: 1, stdout: "", stderr: `${verb} failed` }) : orig(cmd, args, o)))(h.sys.run);
  };
  const fresh = host();
  failOn(fresh, "enable");
  assert.throws(() => install(fresh, release()), (e) => e.code === 6 && /enabling/.test(e.message));
  for (const p of ["/etc/systemd/system/vbcdx-sidecar-default.service", "/etc/vbcdx/default/sidecar.toml",
    "/usr/local/lib/vbcdx/sidecar/current", "/usr/local/lib/vbcdx/sidecar/0.1.0"]) assert.ok(!existsSync(at(fresh, p)), p);
  // Nothing new means the user and the directories too, not only the files inside them.
  for (const p of ["/usr/local/lib/vbcdx", "/var/lib/vbcdx", "/etc/vbcdx", "/etc/systemd/system"]) assert.ok(!existsSync(at(fresh, p)), p);
  assert.deepEqual(calls(fresh, "userdel"), ["vbcdx"]);
  assert.equal(run(["list", "services"], fresh).report.services.length, 0);

  const up = host();
  install(up, release("0.1.0"));
  const unit = at(up, "/etc/systemd/system/vbcdx-sidecar-default.service");
  const oldUnit = readFileSync(unit, "utf8");
  failOn(up, "restart");
  const conf = `root:vbcdx ${at(up, "/etc/vbcdx/default/sidecar.toml")}`;
  const confChowns = () => calls(up, "chown").filter((c) => c === conf).length;
  const chownsBefore = confChowns();
  // Every restart fails on this host, so putting 0.1.0 back fails too, and the error says so.
  assert.throws(() => install(up, release("0.2.0")), (e) => e.code === 6 && /restarting/.test(e.message)
    && /Starting 0\.1\.0 again failed too \(systemctl restart exited 1\)/.test(e.message));
  assert.equal(confChowns() - chownsBefore, 2, "the config is chowned when written and again when restored");
  // Back onto 0.1.0 last, after every restorer, and reset-failed first (a start limit the failed start hit).
  assert.deepEqual(calls(up, "systemctl").slice(-3), ["daemon-reload", "reset-failed vbcdx-sidecar-default.service", "restart vbcdx-sidecar-default.service"], "back onto 0.1.0");
  assert.equal(readFileSync(unit, "utf8"), oldUnit);
  assert.equal(readlinkSync(at(up, "/usr/local/lib/vbcdx/sidecar/current")), "0.1.0");
  assert.ok(!existsSync(at(up, "/usr/local/lib/vbcdx/sidecar/0.2.0")) && existsSync(at(up, "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-sidecar")));
  assert.deepEqual(run(["list", "services"], up).report.services.map((s) => s.version), ["0.1.0"]);
  // A failed upgrade is not a fresh host: the user and the levels 0.1.0 runs from all stay.
  assert.deepEqual(calls(up, "userdel"), []);
  for (const p of ["/etc/vbcdx/default", "/var/lib/vbcdx/default", "/usr/local/lib/vbcdx/sidecar"]) assert.ok(existsSync(at(up, p)), p);
});

test("--force, then a later step fails: the saved copy goes and the user's file is back, byte for byte", () => {
  const h = host();
  const rel = release();
  install(h, rel);
  edit(h, CONF);
  const edited = readFileSync(at(h, CONF));
  const healthy = h.sys.run;
  h.sys.run = (cmd, args, o) => (cmd === "systemctl" && args[0] === "restart"
    ? (h.sys.calls.push([cmd, ...args]), { status: 1, stdout: "", stderr: "restart failed" }) : healthy(cmd, args, o));
  assert.throws(() => install(h, rel, ["--listen", "127.0.0.1:7781", "--force"]), (e) => e.code === 6 && /restarting/.test(e.message));
  assert.ok(!existsSync(at(h, `${CONF}.vbcdx-old`)), "the copy this run saved is removed");
  assert.deepEqual(readFileSync(at(h, CONF)), edited, "the user's edited file is restored");
  // So the next --force isn't refused by a leftover copy, and saves the same edit.
  h.sys.run = healthy;
  assert.deepEqual(install(h, rel, ["--listen", "127.0.0.1:7781", "--force"]).report.replaced.map((x) => x.path), [CONF]);
  assert.deepEqual(readFileSync(at(h, `${CONF}.vbcdx-old`)), edited);
});

test("an exit-5 refusal on a fresh host writes nothing: no user, no state, lib or config levels", () => {
  const h = host();
  // A config file on disk that no record names counts as edited (fileConflicts).
  mkdirSync(at(h, "/etc/vbcdx/default"), { recursive: true });
  writeFileSync(at(h, CONF), "# someone's own sidecar.toml\n");
  assert.throws(() => install(h, release()), (e) => e.code === 5 && /Edited since install/.test(e.message));
  assert.deepEqual(calls(h, "useradd"), [], "refused before the user step");
  for (const p of ["/var/lib/vbcdx", "/usr/local/lib/vbcdx", "/etc/systemd/system"]) assert.ok(!existsSync(at(h, p)), p);
  assert.deepEqual(readdirSync(at(h, "/etc/vbcdx/default")), ["sidecar.toml"], "the config dir holds only the user's file");
});

test("a plan whose verified bytes were changed after verification is refused before anything is switched", () => {
  const h = host();
  const parsed = parseServiceArgs(["install", "service", "sidecar", "--from", release()]);
  const { plan } = planInstall(parsed, h.deps);
  plan.binaries[0].bytes.write("X", 0); // the buffer the plan carries, altered in place
  assert.throws(() => applyInstall(plan, h.sys), (e) => e.code === 5 && /verified bytes/.test(e.message));
  assert.equal(existsSync(at(h, "/usr/local/lib/vbcdx/sidecar/current")), false);
});

test("--dry-run with a trusted release writes nothing and runs no command", () => {
  const h = host();
  const r = run(["install", "service", "sidecar", "--from", release(), "--dry-run"], h);
  assert.equal(r.kind, "plan");
  assert.equal(r.report.dryRun, true);
  assert.deepEqual(h.sys.calls, [], "no useradd, chown, systemctl or npm");
  assert.deepEqual(readdirSync(h.root, { recursive: true }), [], "nothing under the host root");
});

test("remove refuses a level swapped for a symlink since install: the link target is never touched", () => {
  for (const [uid, level, inside] of [[1000, "/home/u/.vbcdx/lib/sidecar", "0.1.0/vbcdx-sidecar"],
    [0, "/usr/local/lib/vbcdx", "sidecar/0.1.0/vbcdx-sidecar"], [0, "/etc/vbcdx/default", "sidecar.toml"], [0, "/var/lib/vbcdx", "default"]]) {
    const h = host({ uid });
    install(h, release());
    // The real tree moves aside and a link to it takes its place.
    renameSync(at(h, level), at(h, "/elsewhere"));
    symlinkSync(at(h, "/elsewhere"), at(h, level));
    const before = h.sys.calls.length;
    for (const argv of [["remove", "service", "sidecar", "--dry-run"], ["remove", "service", "sidecar", "--wipe"]]) {
      assert.throws(() => run(argv, h), (e) => e.code === 4 && /symlink/.test(e.message), `${level}: ${argv.join(" ")}`);
    }
    assert.equal(h.sys.calls.length, before, `${level}: nothing run`);
    assert.ok(existsSync(at(h, `/elsewhere/${inside}`)), `${level}: the link target is intact`);
  }
});

// An earlier release wrote /etc/vbcdx/<instance>/modules.toml for `install service keyhole|dispatch`
// and recorded it. legacyModules puts such an install in place: the file, and the record's entry.
const LEGACY = "/etc/vbcdx/default/modules.toml";
function legacyModules(h, { edited = false } = {}) {
  const body = "keyhole = true\n";
  writeFileSync(at(h, LEGACY), edited ? "# edited\n" : body);
  const m = JSON.parse(readFileSync(recFile(h), "utf8"));
  m.services["sidecar:default"].modules = { path: LEGACY, sha256: sha(Buffer.from(body)) };
  writeFileSync(recFile(h), JSON.stringify(m, null, 2));
}
const sidecarRecord = (h) => JSON.parse(readFileSync(recFile(h), "utf8")).services["sidecar:default"];

test("an upgrade removes an old modules.toml install wrote, and drops its record entry", () => {
  const h = host();
  install(h, release("0.1.0"));
  legacyModules(h);
  // A record with the old field still loads, and a same-version re-run is still a no-op.
  assert.equal(install(h, release("0.1.0")).report.changed, false, "a legacy entry doesn't make a re-run look changed");
  assert.ok(existsSync(at(h, LEGACY)));
  const r = install(h, release("0.2.0")).report;
  assert.equal(r.legacy_removed, LEGACY);
  assert.deepEqual(r.kept, []);
  assert.ok(!existsSync(at(h, LEGACY)), "the file the sidecar no longer reads is gone");
  assert.equal(sidecarRecord(h).modules, null);
  assert.equal(install(h, release("0.2.0")).report.changed, false, "nothing left to do after it");
});

test("an upgrade keeps and names an old modules.toml edited since install", () => {
  const h = host();
  install(h, release("0.1.0"));
  legacyModules(h, { edited: true });
  const r = install(h, release("0.2.0")).report;
  assert.equal(r.legacy_removed, null);
  assert.deepEqual(r.kept, [LEGACY]);
  assert.equal(readFileSync(at(h, LEGACY), "utf8"), "# edited\n", "left exactly as the user had it");
  assert.equal(sidecarRecord(h).modules, null, "no longer install's file");
});

// It runs after the install is done: a file that can't be removed (EPERM: an immutable bit, a
// read-only mount) never fails the upgrade. It is named with the reason and stays recorded.
test("an upgrade that can't remove an old modules.toml still succeeds, names it, and keeps it recorded", (t) => {
  const h = host();
  install(h, release("0.1.0"));
  legacyModules(h);
  const recorded = sidecarRecord(h).modules;
  const real = fs.unlinkSync;
  t.mock.method(fs, "unlinkSync", (path, ...rest) => {
    if (String(path) === at(h, LEGACY)) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
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
  assert.deepEqual([r.changed, r.upgraded_from, r.legacy_removed], [true, "0.1.0", null]);
  assert.deepEqual(r.legacy_not_removed, { path: LEGACY, reason: "EPERM" });
  assert.ok(existsSync(at(h, LEGACY)));
  assert.equal(sidecarRecord(h).version, "0.2.0", "the record names the version now installed");
  assert.deepEqual(sidecarRecord(h).modules, recorded, "still install's file, so still recorded");
  run(["remove", "service", "sidecar", "--wipe"], h);
  assert.ok(!existsSync(at(h, LEGACY)), "a later remove takes it out");
});

test("install never writes a modules.toml, and an upgrade without one removes nothing", () => {
  const h = host();
  install(h, release("0.1.0"));
  assert.equal(sidecarRecord(h).modules, null);
  const r = install(h, release("0.2.0")).report;
  assert.equal(r.legacy_removed, null);
  assert.equal(sidecarRecord(h).modules, null);
  assert.ok(!existsSync(at(h, LEGACY)));
});

test("remove takes out an old recorded modules.toml, or keeps and names it when edited", () => {
  const h = host();
  install(h, release());
  legacyModules(h);
  assert.ok(run(["remove", "service", "sidecar", "--dry-run"], h).report.actions.includes(`delete ${LEGACY}`));
  run(["remove", "service", "sidecar", "--wipe"], h);
  assert.ok(!existsSync(at(h, LEGACY)));

  const e = host();
  install(e, release());
  legacyModules(e, { edited: true });
  assert.deepEqual(run(["remove", "service", "sidecar", "--wipe"], e).report.kept, [LEGACY]);
  assert.ok(existsSync(at(e, LEGACY)));
});

test("remove --dry-run plans to delete current only with the last instance", () => {
  const h = host();
  const rel = release();
  install(h, rel);
  install(h, rel, ["--instance", "two"]);
  const line = "delete /usr/local/lib/vbcdx/sidecar/current";
  assert.ok(!run(["remove", "service", "sidecar", "--instance", "two", "--dry-run"], h).report.actions.includes(line));
  run(["remove", "service", "sidecar", "--instance", "two"], h);
  assert.ok(run(["remove", "service", "sidecar", "--dry-run"], h).report.actions.includes(line));
});

// A config or unit file the user edited is theirs: kept when this install
// would write the same bytes as before, refused (exit 5, nothing written) when it would change
// it, and replaced only with --force, after the edited copy is saved as <file>.vbcdx-old.
const CONF = "/etc/vbcdx/default/sidecar.toml";
const UNIT = "/etc/systemd/system/vbcdx-sidecar-default.service";
const edit = (h, p, line = "# local edit\n") => writeFileSync(at(h, p), readFileSync(at(h, p), "utf8") + line);

test("edit, remove (kept), reinstall: refused with exit 5 before anything is written; the edit survives", () => {
  const h = host();
  const rel = release();
  install(h, rel);
  edit(h, CONF);
  const edited = readFileSync(at(h, CONF));
  assert.deepEqual(run(["remove", "service", "sidecar"], h).report.kept, [CONF]);
  const usersBefore = calls(h, "useradd").length;
  assert.throws(() => install(h, rel), (e) => e.code === 5 && /Edited since install/.test(e.message) && e.message.includes(CONF) && /--force/.test(e.message));
  assert.deepEqual(readFileSync(at(h, CONF)), edited, "the edited file is byte-identical");
  assert.ok(!existsSync(at(h, UNIT)), "nothing else was written (the unit remove took out is still gone)");
  assert.ok(!existsSync(at(h, `${CONF}.vbcdx-old`)));
  assert.ok(!existsSync(at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0")), "no version dir was put back");
  const record = JSON.parse(readFileSync(at(h, "/root/.vbcdx/manifests/installation.json"), "utf8"));
  assert.equal((record.services || {})["sidecar:default"], undefined, "no record was written");
  assert.equal(calls(h, "useradd").length, usersBefore, "the user step didn't run again");
});

test("--force replaces the edited file, after saving the user's copy as <file>.vbcdx-old", () => {
  const h = host();
  const rel = release();
  const fresh = (install(h, rel), readFileSync(at(h, CONF), "utf8"));
  edit(h, CONF);
  const edited = readFileSync(at(h, CONF), "utf8");
  run(["remove", "service", "sidecar"], h);
  const r = install(h, rel, ["--force"]).report;
  assert.equal(r.changed, true);
  assert.deepEqual(r.replaced, [{ path: CONF, saved_as: `${CONF}.vbcdx-old` }]);
  assert.equal(readFileSync(at(h, CONF), "utf8"), fresh, "install's own config is back");
  assert.equal(readFileSync(at(h, `${CONF}.vbcdx-old`), "utf8"), edited, "the user's copy is kept");
});

test("an edit while installed, reinstalled with the same options: the file is kept and nothing changes", () => {
  const h = host();
  const rel = release();
  install(h, rel);
  edit(h, CONF);
  const edited = readFileSync(at(h, CONF));
  const r = install(h, rel).report;
  assert.equal(r.changed, false, "already in place: the kept edit is not a change to make");
  assert.deepEqual(r.kept, [CONF]);
  assert.deepEqual(readFileSync(at(h, CONF)), edited);
});

test("an edit while installed, reinstalled with options that change the file: refused; --force replaces it", () => {
  const h = host();
  const rel = release();
  install(h, rel);
  edit(h, CONF);
  const edited = readFileSync(at(h, CONF));
  assert.throws(() => install(h, rel, ["--listen", "127.0.0.1:7781"]), (e) => e.code === 5 && e.message.includes(CONF));
  assert.deepEqual(readFileSync(at(h, CONF)), edited);
  const r = install(h, rel, ["--listen", "127.0.0.1:7781", "--force"]).report;
  assert.deepEqual(r.replaced.map((x) => x.path), [CONF]);
  assert.match(readFileSync(at(h, CONF), "utf8"), /127\.0\.0\.1:7781/);
  assert.deepEqual(readFileSync(at(h, `${CONF}.vbcdx-old`)), edited);
});

test("an edited unit file and an upgrade that changes it: refused, the unit untouched", () => {
  const h = host();
  install(h, release("0.1.0"));
  edit(h, UNIT, "# local unit edit\n");
  const edited = readFileSync(at(h, UNIT));
  assert.throws(() => install(h, writeRelease(tempDir("vbcdx-rel-"), "0.2.0")), (e) => e.code === 5 && e.message.includes(UNIT));
  assert.deepEqual(readFileSync(at(h, UNIT)), edited);
});

test("the dry run shows the conflict and exits 5; with --force it shows the replacement and exits 0", () => {
  const h = host();
  const rel = release();
  install(h, rel);
  edit(h, CONF);
  run(["remove", "service", "sidecar"], h);
  const dry = install(h, rel, ["--dry-run"]);
  assert.equal(dry.code, 5);
  assert.deepEqual(dry.report.conflicts, [CONF]);
  assert.match(humanPlan(dry.report), new RegExp(`CONFLICT ${CONF.replace(/[./]/g, "\\$&")}: edited since install`));
  const forced = install(h, rel, ["--dry-run", "--force"]);
  assert.equal(forced.code, 0);
  assert.match(humanPlan(forced.report), /replace \/etc\/vbcdx\/default\/sidecar\.toml \(edited since install; saved first as/);
  assert.ok(!existsSync(at(h, `${CONF}.vbcdx-old`)), "a dry run writes nothing");
});

test("a kept file the user put back to what install wrote is simply adopted", () => {
  const h = host();
  const rel = release();
  install(h, rel);
  const original = readFileSync(at(h, CONF));
  edit(h, CONF);
  run(["remove", "service", "sidecar"], h);
  writeFileSync(at(h, CONF), original);
  assert.equal(install(h, rel).report.changed, true);
  assert.ok(!existsSync(at(h, `${CONF}.vbcdx-old`)), "no conflict, so no saved copy");
});

test("an edited config through an upgrade that doesn't change it: the upgrade happens, the edit is kept", () => {
  const h = host();
  install(h, release("0.1.0"));
  edit(h, CONF);
  const edited = readFileSync(at(h, CONF));
  const r = install(h, writeRelease(tempDir("vbcdx-rel-"), "0.2.0")).report;
  assert.equal(r.upgraded_from, "0.1.0");
  assert.deepEqual(r.kept, [CONF]);
  assert.deepEqual(readFileSync(at(h, CONF)), edited, "the upgrade left the user's config as it was");
});

test("an edited unit file while the config changes: the config is rewritten, the unit edit is kept", () => {
  const h = host();
  const rel = release();
  install(h, rel);
  edit(h, UNIT, "# local unit edit\n");
  const edited = readFileSync(at(h, UNIT));
  const r = install(h, rel, ["--listen", "127.0.0.1:7781"]).report;
  assert.equal(r.changed, true);
  assert.deepEqual(r.kept, [UNIT]);
  assert.deepEqual(readFileSync(at(h, UNIT)), edited);
  assert.match(readFileSync(at(h, CONF), "utf8"), /127\.0\.0\.1:7781/);
});

test("--force refuses to overwrite an existing <file>.vbcdx-old: both copies survive (exit 5, nothing written)", () => {
  const h = host();
  const rel = release();
  install(h, rel);
  edit(h, CONF);
  run(["remove", "service", "sidecar"], h);
  writeFileSync(at(h, `${CONF}.vbcdx-old`), "# the copy an earlier --force saved\n");
  const edited = readFileSync(at(h, CONF));
  const earlier = readFileSync(at(h, `${CONF}.vbcdx-old`));
  assert.throws(() => install(h, rel, ["--force"]), (e) => e.code === 5 && e.message.includes(`${CONF}.vbcdx-old`) && /already exists/.test(e.message));
  assert.deepEqual(readFileSync(at(h, CONF)), edited, "the edited file is untouched");
  assert.deepEqual(readFileSync(at(h, `${CONF}.vbcdx-old`)), earlier, "the earlier saved copy is untouched");
  const dry = install(h, rel, ["--dry-run", "--force"]);
  assert.equal(dry.code, 5, "the dry run says --force would be refused too");
  assert.match(humanPlan(dry.report), /CONFLICT \/etc\/vbcdx\/default\/sidecar\.toml\.vbcdx-old already exists/);
});

test("the saved copy keeps the edited file's mode", () => {
  const h = host();
  const rel = release();
  install(h, rel);
  edit(h, CONF);
  assert.equal(statSync(at(h, CONF)).mode & 0o777, 0o640);
  install(h, rel, ["--listen", "127.0.0.1:7781", "--force"]);
  assert.equal(statSync(at(h, `${CONF}.vbcdx-old`)).mode & 0o777, 0o640);
});

test("a dry run against an installed instance's record sees the edit", () => {
  const h = host();
  const rel = release();
  install(h, rel);
  edit(h, CONF);
  const dry = install(h, rel, ["--listen", "127.0.0.1:7781", "--dry-run"]);
  assert.equal(dry.code, 5);
  assert.deepEqual(dry.report.conflicts, [CONF]);
  const same = install(h, rel, ["--dry-run"]);
  assert.equal(same.code, 0);
  assert.deepEqual(same.report.kept, [CONF], "with the same options the edit is kept, and the dry run says so");
});

test("a config path that isn't a regular file is refused before it is read (exit 4)", () => {
  const h = host();
  mkdirSync(at(h, CONF), { recursive: true });
  assert.throws(() => install(h, release()), (e) => e.code === 4 && e.message.includes(CONF) && /not a regular file/.test(e.message));
});

test("--force on plain keyhole is the usage error naming keyhole-server", () => {
  assert.throws(() => parseServiceArgs(["install", "service", "keyhole", "--force"]),
    (e) => e.code === 2 && /^keyhole is not a service of its own: .*vbcdx install service keyhole-server\)\.$/.test(e.message));
});

// After install starts the unit, it waits for the daemon to stay up (src/service/apply.js
// waitStarted). These hosts script systemd on the fake clock (h.sys.clock): `script(t)` gives the
// unit's is-active state and NRestarts at t ms after `enable --now`; journalctl answers `journal`.
const DAEMON_LINE = "vbcdx-sidecar: tcp 127.0.0.1:7777: address in use";
function scripted({ script, journal = `Started vbcdx sidecar.\n${DAEMON_LINE}\nvbcdx-sidecar-default.service: Main process exited, code=exited, status=9/n/a\n`, ss = "" , uid = 0 } = {}) {
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
    if (cmd === "ss") {
      h.sys.calls.push([cmd, ...args]);
      return { status: 0, stdout: ss, stderr: "" };
    }
    return orig(cmd, args, o);
  })(h.sys.run);
  return h;
}
// Every path under the host's root, to compare a host with itself before an install. The record's
// own directory (made by the record lock, withRecord) is left out: assertRecordDirEmpty checks that
// it holds no record and no lock afterwards.
const RECORD_DIRS = new Set(["/root", "/root/.vbcdx", "/root/.vbcdx/manifests"]);
function assertRecordDirEmpty(h) {
  const d = at(h, "/root/.vbcdx/manifests");
  if (existsSync(d)) assert.deepEqual(readdirSync(d), [], "the record directory holds no record and no lock");
}
function tree(h) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      out.push(join(d, e.name).slice(h.root.length));
      if (e.isDirectory()) walk(join(d, e.name));
    }
  };
  walk(h.root);
  return out.filter((p) => !RECORD_DIRS.has(p)).sort();
}
// A daemon that exits at once (its listen address taken): systemd restarts it every 2 s.
const loop = (t) => ({ state: t % 2500 < 500 ? "active" : "activating", restarts: String(Math.floor(t / 2500)) });

test("a daemon that can't start: install exits 6 with the daemon's own line, and leaves the host as it found it", () => {
  const h = scripted({ script: loop });
  const before = tree(h);
  assert.throws(() => install(h, release(), ["--listen", "127.0.0.1:7777"]),
    (e) => e.code === 6 && /vbcdx-sidecar-default\.service did not start/.test(e.message) && e.message.includes(DAEMON_LINE)
      && /install was undone/.test(e.message));
  assert.ok(calls(h, "systemctl").includes("disable --now vbcdx-sidecar-default.service"), "the looping unit is stopped and disabled");
  assert.deepEqual(tree(h), before, "no file or directory this run made is left");
  assertRecordDirEmpty(h);
  assert.ok(!h.acct.users.has("vbcdx"), "the user this run created is gone");
  assert.ok(!existsSync(at(h, "/root/.vbcdx/manifests/installation.json"))
    || JSON.parse(readFileSync(at(h, "/root/.vbcdx/manifests/installation.json"), "utf8")).services["sidecar:default"] === undefined, "nothing recorded");
  assert.ok(calls(h, "journalctl").every((c) => c.includes("-u vbcdx-sidecar-default.service") && /--since @\d+/.test(c)), "only this start's journal lines");
});

test("a daemon that comes up and dies again (no restart counter to read) is still refused, at the deadline", () => {
  // NRestarts empty (an older systemd): the 3 s settle alone must reject a 2.5 s restart cycle.
  const h = scripted({ script: (t) => ({ state: loop(t).state, restarts: "" }) });
  const t0 = h.sys.clock.t;
  assert.throws(() => install(h, release()), (e) => e.code === 6 && /did not start/.test(e.message));
  const waited = h.sys.clock.t - t0;
  assert.ok(waited >= START_DEADLINE_MS && waited < START_DEADLINE_MS + 1000, `gave up at the deadline (${waited} ms)`);
});

test("a daemon that restarts faster than the poll (every poll reads active) is caught by its restart counter", () => {
  // A unit edited to RestartSec=100ms: is-active may read "active" every time, but NRestarts climbs.
  const h = scripted({ script: (t) => ({ state: "active", restarts: String(Math.floor(t / 400)) }) });
  const t0 = h.sys.clock.t;
  assert.throws(() => install(h, release()), (e) => e.code === 6 && /it exited and systemd is restarting it/.test(e.message));
  assert.ok(h.sys.clock.t - t0 < SETTLE_MS, "refused before the settle time, on the counter alone");
});

test("a failed unit is reported at once, not after the deadline", () => {
  const h = scripted({ script: () => ({ state: "failed", restarts: "0" }) });
  const t0 = h.sys.clock.t;
  assert.throws(() => install(h, release()), (e) => e.code === 6 && /\(it is failed\)/.test(e.message));
  assert.ok(h.sys.clock.t - t0 < 1000, "no waiting on a unit that has failed");
});

test("a unit that stays activating is refused at the deadline; one that takes 4 s to come up is installed", () => {
  const stuck = scripted({ script: () => ({ state: "activating", restarts: "0" }) });
  assert.throws(() => install(stuck, release()), (e) => e.code === 6 && /\(it is activating\)/.test(e.message));
  const slow = scripted({ script: (t) => ({ state: t < 4000 ? "activating" : "active", restarts: "0" }) });
  const r = install(slow, release()).report;
  assert.equal(r.changed, true);
  assert.equal(r.started, true);
});

test("the daemon must stay up for the whole settle time: up for 2.9 s then down is refused", () => {
  const h = scripted({ script: (t) => ({ state: t < SETTLE_MS - 100 ? "active" : "activating", restarts: "0" }) });
  assert.throws(() => install(h, release()), (e) => e.code === 6);
});

test("--no-start and --service none never wait (nothing was started)", () => {
  for (const extra of [["--no-start"], ["--service", "none"]]) {
    const h = scripted({ script: () => ({ state: "failed", restarts: "9" }) });
    install(h, release(), extra);
    assert.ok(!calls(h, "systemctl").some((c) => /^(is-active|show) /.test(c)), extra.join(" "));
  }
});

test("the units bound their restarts: StartLimitIntervalSec=60, StartLimitBurst=5, in [Unit]", () => {
  for (const [name, h, extra] of [["system sidecar", host(), []], ["user sidecar", host({ uid: 1000 }), []]]) {
    const p = planInstall(parseServiceArgs(["install", "service", "sidecar", "--from", release(), ...extra]), h.deps).plan;
    const unitSection = p.unit.text.split("[Service]")[0];
    assert.match(unitSection, /^StartLimitIntervalSec=60$/m, name);
    assert.match(unitSection, /^StartLimitBurst=5$/m, name);
    assert.doesNotMatch(p.unit.text.split("[Service]")[1], /StartLimit/, `${name}: not in [Service], where systemd ignores it`);
  }
});

test("a TCP --listen something already holds: the dry run says CONFLICT (exit 5) and install refuses before writing", () => {
  for (const held of ["127.0.0.1:7777", "0.0.0.0:7777", "*:7777", "[::]:7777"]) {
    const h = scripted({ script: loop, ss: `LISTEN 0 5 ${held} 0.0.0.0:*\n` });
    const dry = install(h, release(), ["--listen", "127.0.0.1:7777", "--dry-run"]);
    assert.equal(dry.code, 5, held);
    assert.match(humanPlan(dry.report), /CONFLICT --listen 127\.0\.0\.1:7777 \(in use: something already listens on /, held);
    const before = tree(h);
    assert.throws(() => install(h, release(), ["--listen", "127.0.0.1:7777"]), (e) => e.code === 5 && /in use/.test(e.message), held);
    assert.deepEqual(tree(h), before, `${held}: nothing written`);
    assertRecordDirEmpty(h);
    assert.deepEqual(calls(h, "useradd"), [], `${held}: no user made`);
  }
  // Another port, another address, or a unix listen: no conflict.
  for (const [ss, listen] of [["LISTEN 0 5 127.0.0.1:7778 0.0.0.0:*\n", "127.0.0.1:7777"], ["LISTEN 0 5 10.0.0.5:7777 0.0.0.0:*\n", "127.0.0.1:7777"]]) {
    const h = scripted({ script: () => ({ state: "active", restarts: "0" }), ss });
    assert.equal(install(h, release(), ["--listen", listen, "--dry-run"]).code, 0, ss);
  }
  const unix = scripted({ script: () => ({ state: "active", restarts: "0" }), ss: "LISTEN 0 5 127.0.0.1:7777 0.0.0.0:*\n" });
  assert.equal(install(unix, release(), ["--dry-run"]).code, 0);
  assert.deepEqual(calls(unix, "ss"), [], "a unix listen is not checked");
});

test("a reinstall with the instance's own recorded TCP listen is not refused (that's its own daemon on the port)", () => {
  const h = scripted({ script: () => ({ state: "active", restarts: "0" }), ss: "LISTEN 0 5 127.0.0.1:7777 0.0.0.0:*\n" });
  // First install: the port is free.
  const free = h.sys.run;
  h.sys.run = (cmd, args, o) => (cmd === "ss" ? { status: 0, stdout: "", stderr: "" } : free(cmd, args, o));
  install(h, release(), ["--listen", "127.0.0.1:7777"]);
  h.sys.run = free;
  assert.equal(install(h, release(), ["--listen", "127.0.0.1:7777", "--dry-run"]).code, 0);
  assert.doesNotThrow(() => install(h, release("0.2.0"), ["--listen", "127.0.0.1:7777"]));
});

test("doctor on a non-active unit shows the daemon's last line; the user journal for a user install", () => {
  const h = host();
  install(h, release());
  h.unit.active = "activating";
  const plain = h.sys.run;
  h.sys.run = (cmd, args, o) => (cmd === "journalctl" ? { status: 0, stdout: `${DAEMON_LINE}\nvbcdx-sidecar-default.service: Scheduled restart job\n`, stderr: "" } : plain(cmd, args, o));
  const c = run(["doctor", "--service", "sidecar"], h).report.checks.find((x) => x.check === "unit active");
  assert.equal(c.ok, false);
  assert.ok(c.detail.endsWith(`; last: ${DAEMON_LINE}`), c.detail);
  const fake = { run: (cmd, args) => (fake.seen = [cmd, ...args], { status: 0, stdout: `${DAEMON_LINE}\nsystemd: noise\n` }) };
  assert.equal(lastDaemonLine(fake, "user", "u.service", "vbcdx-sidecar"), DAEMON_LINE, "systemd's own lines are skipped");
  assert.deepEqual(fake.seen.slice(0, 4), ["journalctl", "--user", "-u", "u.service"]);
  assert.equal(lastDaemonLine({ run: () => ({ status: 1, stdout: `${DAEMON_LINE}\n` }) }, "system", "u.service", "vbcdx-sidecar"), null,
    "a failed journal read is never quoted, whatever it printed");
});

// An instance that was running goes through the wait too.
// `switchable`: a host whose unit fails the wait once `h.fail` is set; every restart records the
// config and unit on disk at that moment, so a test can see what the old daemon starts with.
const isPollCall = (c) => c[0] === "systemctl" && (c.includes("is-active") || c.includes("show"));
function switchable() {
  const h = host();
  h.fail = false;
  h.undoRestartStatus = 0;
  h.atRestart = [];
  let failedRestarts = 0;
  h.sys.run = ((orig) => (cmd, args, o) => {
    if (cmd === "systemctl" && args.includes("is-active")) {
      h.sys.calls.push([cmd, ...args]);
      return { status: 0, stdout: h.fail ? "failed\n" : "active\n", stderr: "" };
    }
    if (cmd === "systemctl" && args.includes("restart")) {
      h.sys.calls.push([cmd, ...args]);
      h.atRestart.push({ conf: readFileSync(at(h, CONF), "utf8"), unit: readFileSync(at(h, UNIT), "utf8") });
      // While failing: the first restart is the new version's, the next one the undo's.
      if (h.fail) failedRestarts += 1;
      const undo = h.fail && failedRestarts > 1;
      return { status: undo ? h.undoRestartStatus : 0, stdout: "", stderr: undo && h.undoRestartStatus ? "restart failed\n" : "" };
    }
    return orig(cmd, args, o);
  })(h.sys.run);
  return h;
}
const recordVersion = (h) => JSON.parse(readFileSync(at(h, "/root/.vbcdx/manifests/installation.json"), "utf8")).services["sidecar:default"].version;
const tailCtl = (h, mark) => h.sys.calls.slice(mark).filter((c) => c[0] === "systemctl" && !isPollCall(c)).map((c) => c.slice(1).join(" "));

test("a failed upgrade through the wait: exit 6, the unit is never disabled, and 0.1.0 (unit, config, current, record) is back before it restarts", () => {
  const h = switchable();
  install(h, release());
  const before = { conf: readFileSync(at(h, CONF), "utf8"), unit: readFileSync(at(h, UNIT), "utf8") };
  const mark = h.sys.calls.length;
  h.fail = true;
  h.atRestart.length = 0;
  assert.throws(() => install(h, release("0.2.0")), (e) => e.code === 6 && /did not start \(it is failed\)/.test(e.message));
  const ctl = tailCtl(h, mark);
  assert.ok(!ctl.some((c) => c.startsWith("disable")), `an upgrade never disables the instance's unit: ${ctl.join(", ")}`);
  assert.deepEqual(ctl.slice(-3), ["daemon-reload", "reset-failed vbcdx-sidecar-default.service", "restart vbcdx-sidecar-default.service"]);
  assert.deepEqual(h.atRestart.at(-1), before, "0.1.0's unit and config are on disk when it restarts");
  assert.equal(readFileSync(at(h, UNIT), "utf8"), before.unit);
  assert.equal(readFileSync(at(h, CONF), "utf8"), before.conf);
  assert.equal(readlinkSync(at(h, "/usr/local/lib/vbcdx/sidecar/current")), "0.1.0");
  assert.equal(recordVersion(h), "0.1.0");
  assert.ok(!existsSync(at(h, "/usr/local/lib/vbcdx/sidecar/0.2.0")), "the 0.2.0 version dir is gone");
});

test("a failed config-only change through the wait: the old config is back before the daemon restarts", () => {
  const h = switchable();
  install(h, release());
  const before = { conf: readFileSync(at(h, CONF), "utf8"), unit: readFileSync(at(h, UNIT), "utf8") };
  const mark = h.sys.calls.length;
  h.fail = true;
  h.atRestart.length = 0;
  assert.throws(() => install(h, release(), ["--listen", "127.0.0.1:7781"]), (e) => e.code === 6);
  const ctl = tailCtl(h, mark);
  assert.ok(!ctl.some((c) => c.startsWith("disable")), ctl.join(", "));
  assert.equal(ctl.at(-1), "restart vbcdx-sidecar-default.service");
  assert.deepEqual(h.atRestart.at(-1), before, "the daemon restarts on the config it had");
  assert.equal(readFileSync(at(h, CONF), "utf8"), before.conf);
});

test("when starting the previous version fails too, the error says so and stays exit 6", () => {
  const h = switchable();
  install(h, release());
  h.fail = true;
  h.undoRestartStatus = 1;
  assert.throws(() => install(h, release("0.2.0")), (e) => e.code === 6 && /did not start/.test(e.message)
    && /Starting 0\.1\.0 again failed too \(systemctl restart exited 1\): check systemctl status vbcdx-sidecar-default\.service\./.test(e.message)
    && e.details.lines.at(-1).startsWith("Starting 0.1.0 again failed too"));
});

// Round 3 (PR review 109369, item 3): a failed fresh install has no previous version to start.
test("a failed fresh install never restarts a previous version: no reset-failed or restart, daemon-reload last", () => {
  const h = scripted({ script: () => ({ state: "failed", restarts: "0" }) });
  assert.throws(() => install(h, release()), (e) => e.code === 6 && /did not start/.test(e.message) && !/again failed/.test(e.message));
  const ctl = calls(h, "systemctl").filter((c) => !/^(is-active|show) /.test(c));
  assert.ok(!ctl.some((c) => /^(reset-failed|restart) /.test(c)), ctl.join(", "));
  assert.deepEqual(ctl.slice(-2), ["disable --now vbcdx-sidecar-default.service", "daemon-reload"]);
});

// Round 3 (PR review 109369, item 2): an instance installed with --service none has a record but
// no unit. A reinstall with a unit is that unit's first install: a failed start disables it, and
// nothing restarts a previous unit that never existed.
test("a --service none instance reinstalled with a unit that fails: the unit is disabled and removed, nothing restarted after", () => {
  const h = switchable();
  install(h, release(), ["--service", "none"]);
  assert.ok(!existsSync(at(h, UNIT)), "no unit yet");
  const mark = h.sys.calls.length;
  h.fail = true;
  // --service systemd given: left out, an installed --service none instance stays without a unit (carry.js).
  assert.throws(() => install(h, release("0.2.0"), ["--service", "systemd"]), (e) => e.code === 6 && /did not start/.test(e.message) && !/again failed/.test(e.message));
  const ctl = tailCtl(h, mark);
  assert.ok(ctl.includes("disable --now vbcdx-sidecar-default.service"), `the unit this run enabled is disabled: ${ctl.join(", ")}`);
  assert.ok(!ctl.some((c) => c.startsWith("reset-failed")), ctl.join(", "));
  assert.equal(ctl.at(-1), "daemon-reload", ctl.join(", "));
  assert.ok(!existsSync(at(h, UNIT)), "the unit file this run wrote is gone");
  assert.equal(recordVersion(h), "0.1.0");
});

test("an inactive unit after start fails at once, not at the deadline", () => {
  const h = scripted({ script: () => ({ state: "inactive", restarts: "0" }) });
  const t0 = h.sys.clock.t;
  assert.throws(() => install(h, release()), (e) => e.code === 6 && /\(it is inactive\)/.test(e.message));
  assert.ok(h.sys.clock.t - t0 < 1000, "no waiting on an inactive unit");
});

test("a held port is not a conflict when nothing is started (--no-start, --service none)", () => {
  for (const extra of [["--no-start"], ["--service", "none"]]) {
    const h = scripted({ script: () => ({ state: "active", restarts: "0" }), ss: "LISTEN 0 5 127.0.0.1:7777 0.0.0.0:*\n" });
    const dry = install(h, release(), ["--listen", "127.0.0.1:7777", "--dry-run", ...extra]);
    assert.equal(dry.code, 0, extra.join(" "));
    assert.equal(dry.report.listen_in_use, null, extra.join(" "));
    assert.doesNotThrow(() => install(h, release(), ["--listen", "127.0.0.1:7777", ...extra]), extra.join(" "));
  }
});

test("the daemon's line is made safe where it is read: no escapes, controls or bidi; secrets redacted; capped", () => {
  const hostile = "vbcdx-sidecar: \x1b[31mred\x1b[0m \x1b]0;title\x07 bell\x07 nul\x00 \u202eevil\u202c token=abc123 KEY=s3cr3t Bearer eyJhbGciOi.x "
    + "dsn postgres://u:hunter2@db/x kh_live_CANARY0123456789 " + "A".repeat(40) + " /var/lib/vbcdx/default/tunnel/client-certificate " + "more words ".repeat(40);
  const out = safeLine(hostile);
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(out), "no C0/C1 controls (ESC sequences included)");
  assert.ok(!out.includes("[31m") && !out.includes("[0m") && out.includes("red"), "a CSI sequence goes whole, its text stays");
  assert.ok(!/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(out), "no bidi overrides");
  assert.ok(!out.includes("title"), "an OSC sequence goes with its payload");
  for (const secret of ["abc123", "s3cr3t", "eyJhbGciOi", "hunter2", "CANARY0123456789", "A".repeat(40)]) assert.ok(!out.includes(secret), secret);
  assert.match(out, /token=\[redacted\]/);
  assert.match(out, /Bearer \[redacted\]/);
  assert.match(out, /postgres:\/\/u:\[redacted\]@db\/x/);
  assert.ok(out.includes("/var/lib/vbcdx/default/tunnel/client-certificate"), "a long path is kept");
  assert.ok(out.length <= LINE_MAX && out.endsWith("…"), `capped at ${LINE_MAX}`);
  // Through the journal: lastDaemonLine returns the safe line.
  assert.equal(lastDaemonLine({ run: () => ({ status: 0, stdout: `${hostile}\n` }) }, "system", "u.service", "vbcdx-sidecar"), out);
  assert.equal(safeLine("vbcdx-sidecar: tcp 127.0.0.1:7777: address in use"), "vbcdx-sidecar: tcp 127.0.0.1:7777: address in use", "an ordinary line is unchanged");
});

// Round 3 (PR review 109369, item 1): `_` is a word character, so a secret's name with a prefix
// (api_key, access_token, DB_PASSWORD) must be redacted whole, with a short value too.
test("a key=value secret whose name has a prefix is redacted too; other key=value pairs stay", () => {
  const out = safeLine("vbcdx-sidecar: api_key=short access_token=tok1 client_secret=cs1 DB_PASSWORD=pw1 AUTH_TOKEN=at1 apikey=ak1 --token=t2 listen=127.0.0.1:7777 state=/var/lib/vbcdx/default");
  for (const secret of ["short", "tok1", "cs1", "pw1", "at1", "ak1", "t2"]) assert.ok(!out.includes(secret), `${secret}: ${out}`);
  for (const name of ["api_key", "access_token", "client_secret", "DB_PASSWORD", "AUTH_TOKEN", "apikey", "--token"]) assert.ok(out.includes(` ${name}=[redacted]`), `${name}: ${out}`);
  assert.ok(out.includes(" listen=127.0.0.1:7777 state=/var/lib/vbcdx/default"), `not a secret, kept: ${out}`);
});

// An upgrade keeps the instance's settings (carry.js): `--version <new>` alone, nothing dropped.
test("an upgrade with nothing but the new version keeps --listen and --service none from the installed instance", () => {
  const h = host();
  install(h, release(), ["--listen", "127.0.0.1:7781"]);
  const conf = readFileSync(at(h, CONF), "utf8");
  const r = install(h, release("0.2.0")).report;
  assert.equal(r.listen, "127.0.0.1:7781");
  assert.equal(readFileSync(at(h, CONF), "utf8"), conf, "the config is unchanged (it names no version)");
  const none = host();
  install(none, release(), ["--service", "none"]);
  assert.equal(install(none, release("0.2.0")).report.unit, null, "--service none stays none");
  assert.ok(!existsSync(at(none, UNIT)));
  assert.equal(install(none, release("0.3.0"), ["--service", "systemd"]).report.unit, "vbcdx-sidecar-default.service", "a given --service overrides it");
});

test("a given --listen overrides only the listen; the dry run of an upgrade names what it keeps and what changes", () => {
  const h = host();
  install(h, release(), ["--listen", "127.0.0.1:7781"]);
  assert.equal(install(h, release("0.2.0"), ["--listen", "127.0.0.1:7782"]).report.listen, "127.0.0.1:7782");
  const dry = install(h, release("0.3.0"), ["--dry-run"]);
  assert.equal(dry.code, 0);
  assert.deepEqual(dry.report.upgrade, { from: "0.2.0", to: "0.3.0" });
  assert.deepEqual(dry.report.carried, [{ setting: "listen", value: "127.0.0.1:7782", from: "record" }]);
  const text = humanPlan(dry.report);
  assert.match(text, /^Planned upgrade service sidecar 0\.2\.0 → 0\.3\.0 /);
  assert.match(text, /^ {2}keep listen 127\.0\.0\.1:7782 \(from the installed record\)$/m);
  assert.doesNotMatch(text, /user: create system user/, "the user exists: not listed");
  assert.doesNotMatch(text, /^ {2}dir .* \/etc\/vbcdx\/default$/m, "an existing dir: not listed");
  assert.match(text, /^ {2}dir 0755 root:root \/usr\/local\/lib\/vbcdx\/sidecar\/0\.3\.0$/m, "the new version dir: listed");
  assert.doesNotMatch(text, /sidecar\.toml/, "the config doesn't change: not listed");
  assert.match(text, /^ {2}change \/etc\/systemd\/system\/vbcdx-sidecar-default\.service:$/m);
  assert.match(text, /^ {6}-ExecStart=\/usr\/local\/lib\/vbcdx\/sidecar\/0\.2\.0\//m);
  assert.match(text, /^ {6}\+ExecStart=\/usr\/local\/lib\/vbcdx\/sidecar\/0\.3\.0\//m);
  assert.match(text, /^ {2}binary 0755 \/usr\/local\/lib\/vbcdx\/sidecar\/0\.3\.0\/vbcdx-sidecar /m);
  assert.match(text, /^ {2}restart vbcdx-sidecar-default\.service, then check it stays up$/m);
});

// A version older than the instance runs is refused (exit 5) unless --allow-downgrade.
for (const [older, newer] of [["0.1.0-dev.3.1", "0.1.0-dev.4.1"], ["0.1.0-dev.9", "0.1.0-rc.1"], ["0.1.0-rc.1", "0.1.0"], ["0.9.0", "0.10.0"]]) {
  test(`${newer} → ${older} is a downgrade: refused (exit 5, nothing written, dry run too); --allow-downgrade does it`, () => {
    const h = host();
    install(h, release(newer));
    const before = tree(h);
    const dry = install(h, release(older), ["--dry-run"]);
    assert.equal(dry.code, 5);
    assert.equal(dry.report.refused, "downgrade");
    assert.deepEqual(dry.report.downgrade, { from: newer, to: older });
    assert.match(humanPlan(dry.report), new RegExp(`REFUSED downgrade ${newer.replace(/\./g, "\\.")} → ${older.replace(/\./g, "\\.")}: install would refuse \\(exit 5\\)`));
    assert.throws(() => install(h, release(older)), (e) => e.code === 5 && e.details.refused === "downgrade"
      && e.message.includes(`runs ${newer}, and ${older} is older`) && /Nothing was changed/.test(e.message) && /--allow-downgrade/.test(e.message));
    assert.deepEqual(tree(h), before, "nothing written");
    assert.equal(recordVersion(h), newer);
    const r = install(h, release(older), ["--allow-downgrade"]).report;
    assert.deepEqual([r.changed, r.downgraded_from, r.upgraded_from], [true, newer, null]);
    assert.equal(recordVersion(h), older);
    assert.ok(!existsSync(at(h, `/usr/local/lib/vbcdx/sidecar/${newer}`)), "the newer version's dir goes: no instance runs it");
  });
  test(`${older} → ${newer} is an upgrade ("upgraded from"), and the same version again is a no-op`, () => {
    const h = host();
    install(h, release(older));
    const r = install(h, release(newer)).report;
    assert.deepEqual([r.upgraded_from, r.downgraded_from], [older, null]);
    assert.equal(install(h, release(newer)).report.changed, false);
  });
}

test("a downgrade is per instance: another instance's version doesn't count, and its version dir stays", () => {
  const h = host();
  install(h, release("0.2.0"));
  install(h, release("0.2.0"), ["--instance", "b"]);
  assert.throws(() => install(h, release("0.1.0")), (e) => e.code === 5 && e.details.refused === "downgrade");
  // Instance c is new: 0.1.0 is not a downgrade of anything it runs.
  assert.equal(install(h, release("0.1.0"), ["--instance", "c"]).report.changed, true);
  install(h, release("0.1.0"), ["--allow-downgrade"]);
  assert.ok(existsSync(at(h, "/usr/local/lib/vbcdx/sidecar/0.2.0/vbcdx-sidecar")), "instance b still runs 0.2.0");
});

test("--allow-downgrade, --no-control-plane and --no-tunnel: refused where they don't fit", () => {
  assert.throws(() => parseServiceArgs(["install", "service", "keyhole", "--allow-downgrade"]), (e) => e.code === 2 && /is not a service of its own/.test(e.message));
  assert.throws(() => parseServiceArgs(["install", "service", "sidecar", "--no-control-plane", "--control-plane", "vbcdx+https://x:1"]), (e) => e.code === 2 && /--no-control-plane/.test(e.message));
  assert.throws(() => parseServiceArgs(["install", "service", "sidecar", "--no-control-plane", "--enroll-token-stdin"]), (e) => e.code === 2);
  assert.throws(() => parseServiceArgs(["install", "service", "control-plane", "--no-tunnel", "--tunnel", "0.0.0.0:8443", "--tunnel-name", "n"]), (e) => e.code === 2 && /--no-tunnel/.test(e.message));
  assert.throws(() => parseServiceArgs(["install", "service", "sidecar", "--no-tunnel"]), (e) => e.code === 2 && /is for the control plane/.test(e.message));
  assert.throws(() => parseServiceArgs(["install", "service", "control-plane", "--no-control-plane"]), (e) => e.code === 2 && /is for the sidecar/.test(e.message));
});

test("the documented sidecar upgrade, as written (`install service sidecar --version <new>`, from the registry), keeps --listen", () => {
  const h = host({ npm: (args) => {
    const prefix = args[args.indexOf("--prefix") + 1];
    const version = args.find((a) => a.startsWith("@vbcdx/sidecar@")).split("@")[2];
    const modules = join(prefix, "lib", "node_modules");
    writeRelease(join(modules, "@vbcdx", "sidecar"), version, modules);
    return { status: 0 };
  } });
  run(["install", "service", "sidecar", "--version", "0.4.0", "--listen", "127.0.0.1:7781"], h);
  const r = run(["install", "service", "sidecar", "--version", "0.5.0"], h).report;
  assert.deepEqual([r.version, r.upgraded_from, r.listen], ["0.5.0", "0.4.0", "127.0.0.1:7781"]);
});

test("a same-version reinstall's dry run lists no binaries or link, only the config change, as a diff", () => {
  const h = host();
  const rel = release("0.2.0");
  install(h, rel, ["--listen", "127.0.0.1:7781"]);
  const dry = install(h, rel, ["--listen", "127.0.0.1:7783", "--dry-run"]);
  assert.deepEqual([dry.report.upgrade, dry.report.downgrade], [null, null]);
  const text = humanPlan(dry.report);
  assert.match(text, /^Planned reinstall service sidecar 0\.2\.0 /);
  assert.doesNotMatch(text, /^ {2}binary /m, "the version dir exists: its binaries are in place");
  assert.doesNotMatch(text, /^ {2}symlink /m, "current already points at 0.2.0");
  assert.match(text, /^ {2}change \/etc\/vbcdx\/default\/sidecar\.toml:$/m);
  assert.match(text, /^ {6}-tcp = "vbcdx\+http:\/\/127\.0\.0\.1:7781"$/m);
  assert.match(text, /^ {6}\+tcp = "vbcdx\+http:\/\/127\.0\.0\.1:7783"$/m);
});

// A file the user edited is never echoed by the dry run.
// Only install's own text (on-disk hash = the recorded one) is diffed.
test("the dry run never prints a user-edited file's text: no secret, no escape byte, in human or --json, with or without --force", () => {
  const h = host();
  install(h, release(), ["--listen", "127.0.0.1:7781"]);
  writeFileSync(at(h, CONF), readFileSync(at(h, CONF), "utf8") + 'api_token = "s3cr3t-CONF-CANARY"\n');
  writeFileSync(at(h, UNIT), readFileSync(at(h, UNIT), "utf8") + "Environment=API_TOKEN=s3cr3t-UNIT-CANARY\n# \x1b[31mred\x1b]0;title\x07\n");
  for (const extra of [[], ["--force"]]) {
    const dry = install(h, release("0.2.0"), ["--listen", "127.0.0.1:7782", "--dry-run", ...extra]);
    const human = humanPlan(dry.report);
    const json = JSON.stringify(dry.report);
    for (const out of [human, json]) {
      assert.ok(!out.includes("s3cr3t"), `no user secret (${extra.join(" ") || "no flags"})`);
      assert.ok(!out.includes("\x1b") && !out.includes("\\u001b"), `no escape byte (${extra.join(" ") || "no flags"})`);
    }
    assert.deepEqual(dry.report.changes.files.map((f) => f.path).filter((p) => p === CONF || p === UNIT), [], "edited files are not in the change list");
    assert.match(human, extra.length ? /^ {2}replace \/etc\/vbcdx\/default\/sidecar\.toml /m : /^ {2}CONFLICT \/etc\/vbcdx\/default\/sidecar\.toml:/m, "named by path");
  }
});

test("a file the user edited that this install would not change is kept, and not listed as a change", () => {
  const h = host();
  install(h, release(), ["--listen", "127.0.0.1:7781"]);
  writeFileSync(at(h, CONF), readFileSync(at(h, CONF), "utf8") + "# a local note\n");
  const dry = install(h, release("0.2.0"), ["--dry-run"]);
  assert.deepEqual(dry.report.kept, [CONF]);
  assert.ok(!dry.report.changes.files.some((f) => f.path === CONF), "kept: not a change");
  assert.ok(dry.report.changes.files.some((f) => f.path === UNIT), "the unit (install's own text) is still diffed");
});

// The dry run honours --allow-downgrade.
test("the dry run honours --allow-downgrade: exit 0, no refusal, the downgrade is named; refused, it names no restart", () => {
  const h = host();
  install(h, release("0.2.0"));
  const dry = install(h, release("0.1.0"), ["--dry-run", "--allow-downgrade"]);
  assert.equal(dry.code, 0);
  assert.equal(dry.report.refused, null);
  assert.deepEqual(dry.report.downgrade, { from: "0.2.0", to: "0.1.0" });
  const text = humanPlan(dry.report);
  assert.match(text, /^Planned downgrade service sidecar 0\.2\.0 → 0\.1\.0 /);
  assert.match(text, /^ {2}downgrade 0\.2\.0 → 0\.1\.0 \(--allow-downgrade\)$/m);
  assert.match(text, /^ {2}restart vbcdx-sidecar-default\.service, then check it stays up$/m);
  assert.doesNotMatch(text, /REFUSED/);
  const refused = humanPlan(install(h, release("0.1.0"), ["--dry-run"]).report);
  assert.match(refused, /REFUSED downgrade/);
  assert.doesNotMatch(refused, /^ {2}restart /m, "a refused run restarts nothing");
});

// The carry-over is per instance.
test("the carry is per instance: instance b keeps its own listen, never the default instance's; a new instance carries nothing", () => {
  const h = host();
  install(h, release(), ["--listen", "127.0.0.1:7781"]);
  install(h, release(), ["--instance", "b", "--listen", "127.0.0.1:7782"]);
  assert.equal(install(h, release("0.2.0"), ["--instance", "b"]).report.listen, "127.0.0.1:7782");
  assert.equal(install(h, release("0.2.0")).report.listen, "127.0.0.1:7781");
  const c = install(h, release("0.2.0"), ["--instance", "c", "--dry-run"]);
  assert.deepEqual(c.report.carried, []);
  assert.equal(c.report.listen, "unix:/run/vbcdx/c.sock");
});

test("lineDiff: a removed or added blank line is a change; the texts' final newline is not", () => {
  assert.deepEqual(lineDiff("a\n\nb\n", "a\nb\n"), ["-"]);
  assert.deepEqual(lineDiff("a\nb\n", "a\n\nb\n"), ["+"]);
  assert.deepEqual(lineDiff("a\nb\n", "a\nb\n"), []);
  assert.deepEqual(lineDiff("a\nb\n", "a\nc\n"), ["-b", "+c"]);
  assert.deepEqual(lineDiff("a", "a\n"), [], "only the final newline differs: no change");
});

test("planChanges strips control characters from every diff line, even of install's own text", () => {
  const root = tempDir("vbcdx-host-");
  const sys = fakeSystem(root);
  mkdirSync(join(root, "/etc/x"), { recursive: true });
  writeFileSync(join(root, "/etc/x/a.toml"), "old = 1\n");
  const plan = { files: [{ path: "/etc/x/a.toml", text: "new = \"\x1b[31mred\x1b]0;t\x07\"\n" }], unit: null,
    dirs: [], binaries: [{ to: "/nowhere/1/b" }], symlink: { path: "/nowhere/current", target: "1" } };
  const rec = { files: [{ path: "/etc/x/a.toml", sha256: sha(Buffer.from("old = 1\n")) }], unit: null };
  const [f] = planChanges(sys, plan, rec).files;
  assert.deepEqual(f.diff, ["-old = 1", '+new = "red"']);
});
