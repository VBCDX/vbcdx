// `vbcdx install|remove|doctor … keyhole-server`: the Keyhole server in control-plane mode, from its own
// signed release (@vbcdx/keyhole). Root only, its own user, co-hosted with the control plane (the
// forward listener is loopback only). Two recorded files (the unit's EnvironmentFile and the
// control CA, no secret in either); the KEK, link key and CSR made as the service user (the KEK
// once, never again); the unit starts only once the certificate from `vbcdx-control services add
// keyhole` passes `keyhole check`. The dispatch-server lessons hold here too.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { keypair, signFile } from "./helpers/minisign-signer.js";
import { tempDir } from "./helpers/temp-dir.js";
import { humanPlan, planInstall, runService } from "../src/service/index.js";
import { parseServiceArgs } from "../src/service/args.js";
import { fakeSystem } from "../src/service/system.js";
import { fakeAccounts } from "./helpers/fake-accounts.js";
import { EXIT } from "../src/errors.js";
import { validateRecord } from "../src/service/apply.js";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const KEY = keypair(12);
const EXEC = "/usr/local/lib/vbcdx/keyhole-server/0.1.0/keyhole";
const STATE = "/var/lib/vbcdx-keyhole/default";
const CONF = "/etc/vbcdx-keyhole/default";
const ENV = `${CONF}/keyhole.env`;
const CA_PATH = `${CONF}/control-ca.pem`;
const UNIT = "vbcdx-keyhole-server-default.service";
const CA = "-----BEGIN CERTIFICATE-----\nMIIBcontrolca\n-----END CERTIFICATE-----\n";
const CERT = "-----BEGIN CERTIFICATE-----\nMIIBleaf\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nMIIBca\n-----END CERTIFICATE-----\n";

const pemFile = (text, name = "x.pem") => {
  const p = join(tempDir("vbcdx-kpem-"), name);
  writeFileSync(p, text);
  return p;
};
const caFile = (text = CA) => pemFile(text, "control-ca.pem");
const certFile = (text = CERT) => pemFile(text, "keyhole.crt");
const cpMode = () => ["--link-listen", "127.0.0.1:8444", "--control-url", "https://127.0.0.1:8443", "--control-ca", caFile()];

// @vbcdx/keyhole as keyhole's release job packs it (one platform is enough here).
function release(version = "0.1.0") {
  const root = tempDir("vbcdx-krel-");
  const rel = "@vbcdx/keyhole-linux-x64-gnu/bin/keyhole";
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  const body = Buffer.from(`\x7fELF keyhole ${version}\n`);
  writeFileSync(join(root, rel), body, { mode: 0o755 });
  const sums = Buffer.from(JSON.stringify({ schema: 1, package: "@vbcdx/keyhole", version, files: { [rel]: sha(body) } }));
  writeFileSync(join(root, "checksums.json"), sums);
  writeFileSync(join(root, "checksums.json.minisig"), signFile(KEY, sums, `vbcdx-release @vbcdx/keyhole ${version}`));
  return root;
}

// A host under a temp root. `keyhole service csr` and `keyhole kek generate` (run through runuser)
// write their files as the real ones do, refusing existing ones; `keyhole … check` answers `check`.
function host({ uid = 0, check = () => ({ stdout: "ok: settings\nok: control-plane link\n" }), active = "active", ss = () => "" } = {}) {
  const root = tempDir("vbcdx-khost-");
  const acct = fakeAccounts({ gid: process.getgid() });
  const sys = fakeSystem(root, { uid, answer: (cmd, args, o) => {
    const a = acct.answer(cmd, args);
    if (a) return a;
    if (cmd === "runuser" && args.includes("csr")) {
      const key = args[args.indexOf("--key-out") + 1];
      const csr = args[args.indexOf("--csr-out") + 1];
      if (existsSync(join(root, key)) || existsSync(join(root, csr))) return { status: 1, stderr: "keyhole: exists\n" };
      writeFileSync(join(root, key), "KEY", { mode: 0o600 });
      writeFileSync(join(root, csr), "-----BEGIN CERTIFICATE REQUEST-----\n", { mode: 0o644 });
      return {};
    }
    if (cmd === "runuser" && args.includes("kek")) {
      const out = args[args.indexOf("--out") + 1];
      if (existsSync(join(root, out))) return { status: 1, stderr: "keyhole: envelope: KEK file exists\n" };
      writeFileSync(join(root, out), `KEK-${Math.random()}`, { mode: 0o600 });
      return {};
    }
    if (cmd === "ss") return { stdout: ss() };
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
const install = (h, rel, extra = []) => run(["install", "service", "keyhole-server", "--from", rel, ...cpMode(), ...extra], h);
const rerun = (h, rel, extra = []) => run(["install", "service", "keyhole-server", "--from", rel, ...extra], h);
const plan = (h, rel, extra = cpMode()) => planInstall(parseServiceArgs(["install", "service", "keyhole-server", "--from", rel, ...extra]), h.deps).plan;
const at = (h, p) => join(h.root, p);
const calls = (h, cmd) => h.sys.calls.filter((c) => c[0] === cmd).map((c) => c.slice(1).join(" "));
const CHECK = (h) => `-u vbcdx-keyhole -- ${at(h, EXEC)} --env-file ${ENV} check`;

test("the plan: its own user and dirs, the env file (no secret) and the control CA, the link and KEK paths", () => {
  const p = plan(host(), release());
  assert.equal(p.scope, "system");
  assert.deepEqual(p.user, { name: "vbcdx-keyhole", system: true, shell: "/usr/sbin/nologin" });
  assert.deepEqual(p.binaries.map((b) => [b.name, b.to]), [["keyhole", EXEC]]);
  const dir = (path) => p.dirs.find((d) => d.path === path);
  assert.deepEqual(dir(STATE), { path: STATE, mode: "0700", owner: "vbcdx-keyhole", group: "vbcdx-keyhole" });
  assert.deepEqual(dir(CONF), { path: CONF, mode: "0750", owner: "root", group: "vbcdx-keyhole" });
  assert.deepEqual(p.files.map((f) => [f.path, f.mode, f.owner, f.group]),
    [[ENV, "0640", "root", "vbcdx-keyhole"], [CA_PATH, "0640", "root", "vbcdx-keyhole"]]);
  const settings = p.files[0].text.split("\n").filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(settings, ["LISTEN_ADDR=127.0.0.1:8080", "PUBLIC_URL=http://127.0.0.1:8080", `DATA_DIR=${STATE}`, "AUTH_MODE=local",
    "SERVICE_LISTEN_ADDR=127.0.0.1:8444", `SERVICE_CERT_FILE=${STATE}/link.crt`, `SERVICE_KEY_FILE=${STATE}/link.key`,
    `CONTROL_CA_FILE=${CA_PATH}`, "CONTROL_URL=https://127.0.0.1:8443", `KEK_FILE=${STATE}/kek`]);
  assert.ok(!/SECRET|PASSWORD|TOKEN/.test(p.files[0].text), "no secret in the env file");
  assert.equal(p.files[1].text, CA);
  for (const f of p.files) assert.equal(f.sha256, sha(f.text));
  assert.deepEqual(p.check, [EXEC, "--env-file", ENV, "check"]);
  assert.deepEqual(p.csr, [EXEC, "service", "csr", "--key-out", `${STATE}/link.key`, "--csr-out", `${STATE}/link.csr`]);
  assert.deepEqual(p.kek, { path: `${STATE}/kek`, db: `${STATE}/keyhole.db`, argv: [EXEC, "kek", "generate", "--out", `${STATE}/kek`] });
  // Keyhole serves the forwarded routes at its root: no path in the URL.
  assert.equal(p.link.services_add,
    `vbcdx-control services add keyhole --url https://127.0.0.1:8444 --csr ${STATE}/link.csr --cert-out keyhole.crt`);
  const named = plan(host(), release(), [...cpMode(), "--listen", "127.0.0.1:9090", "--public-url", "https://keyhole.example"]);
  assert.ok(named.files[0].text.includes("LISTEN_ADDR=127.0.0.1:9090\nPUBLIC_URL=https://keyhole.example\n"));
});

test("the unit: env file, check then serve, as vbcdx-keyhole, UMask=0077, D-b's hardening", () => {
  const lines = plan(host(), release()).unit.text.split("\n");
  // The product term is "control-plane mode"; no internal wording ships in the unit.
  assert.ok(!new RegExp(["he", "rd"].join(""), "i").test(lines.join("\n")), "no internal wording in the unit");
  for (const line of ["Description=Keyhole server, control-plane mode (instance default)", "Type=exec", "User=vbcdx-keyhole", "Group=vbcdx-keyhole", `EnvironmentFile=${ENV}`,
    `ExecStartPre=${EXEC} check`, `ExecStart=${EXEC} serve`, "Restart=on-failure", "UMask=0077",
    "StateDirectory=vbcdx-keyhole/default", "StateDirectoryMode=0700", "NoNewPrivileges=yes", "ProtectSystem=strict",
    "ProtectHome=yes", "PrivateTmp=yes", "PrivateDevices=yes", "MemoryDenyWriteExecute=yes",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6", "SystemCallFilter=@system-service", "SystemCallFilter=~@privileged",
    "SystemCallErrorNumber=EPERM", "CapabilityBoundingSet=", "AmbientCapabilities=", "LimitCORE=0", "WantedBy=multi-user.target"]) {
    assert.ok(lines.includes(line), `missing: ${line}`);
  }
  assert.ok(!lines.includes("SystemCallFilter=~@privileged @resources"), "@resources is not denied (Go's setrlimit)");
  // Nothing weaker than dispatch-server's unit: every hardening line there is here.
  const d = planInstall(parseServiceArgs(["install", "service", "dispatch-server", "--from", dispatchRelease(),
    "--link-listen", "0.0.0.0:8443", "--control-url", "https://10.0.0.5:8443"]), host().deps).plan.unit.text.split("\n");
  const hardening = (ls) => ls.filter((l) => /^(No|Protect|Private|Restrict|Lock|Memory|SystemCall|Capability|Ambient|Limit|UMask|Keyring|Remove|Devic)/.test(l));
  assert.deepEqual(hardening(lines), hardening(d));
});

// @vbcdx/dispatch, for the hardening comparison only.
function dispatchRelease() {
  const root = tempDir("vbcdx-kdrel-");
  const rel = "@vbcdx/dispatch-linux-x64-gnu/bin/dispatch";
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  const body = Buffer.from("\x7fELF dispatch\n");
  writeFileSync(join(root, rel), body, { mode: 0o755 });
  const sums = Buffer.from(JSON.stringify({ schema: 1, package: "@vbcdx/dispatch", version: "0.1.0", files: { [rel]: sha(body) } }));
  writeFileSync(join(root, "checksums.json"), sums);
  writeFileSync(join(root, "checksums.json.minisig"), signFile(KEY, sums, "vbcdx-release @vbcdx/dispatch 0.1.0"));
  return root;
}

test("control-plane-mode flags are checked before the registry is asked; the forward listener is loopback only", () => {
  const h = host();
  const refused = (extra, re) => {
    const o = parseServiceArgs(["install", "service", "keyhole-server", ...extra]);
    assert.throws(() => planInstall(o, h.deps), (e) => e.code === EXIT.CONFIG && re.test(e.message), extra.join(" "));
  };
  const ca = caFile();
  refused([], /control-plane mode: it needs --link-listen 127\.0\.0\.1:<port>.*--control-url.*--control-ca/);
  refused(["--link-listen", "127.0.0.1:8444", "--control-url", "https://cp:8443"], /needs --link-listen/);
  refused(["--link-listen", "127.0.0.1:8444", "--control-ca", ca], /needs --link-listen/);
  refused(["--control-url", "https://cp:8443", "--control-ca", ca], /needs --link-listen/);
  refused(["--link-listen", "8444", "--control-url", "https://cp:8443", "--control-ca", ca], /--link-listen takes/);
  refused(["--link-listen", "127.0.0.1:0", "--control-url", "https://cp:8443", "--control-ca", ca], /--link-listen takes/);
  for (const notLoopback of ["0.0.0.0:8444", "[::]:8444", "10.0.0.5:8444", "keyhole.lan:8444", "localhost:8444", "128.0.0.1:8444",
    "127.999.1.1:8444", "127.0.0.256:8444", "127.00.0.1:8444", "127.0.0.1.5:8444"]) {
    refused(["--link-listen", notLoopback, "--control-url", "https://cp:8443", "--control-ca", ca], /--link-listen must be a loopback address/);
  }
  for (const ok of ["127.0.0.1:8444", "127.1.2.3:8444", "127.255.255.254:8444", "[::1]:8444"]) {
    assert.ok(plan(h, release(), ["--link-listen", ok, "--control-url", "https://cp:8443", "--control-ca", ca]).files[0].text
      .includes(`SERVICE_LISTEN_ADDR=${ok}\n`), ok);
  }
  for (const bad of ["http://cp:8443", "https://cp", "https://cp:8443/x", "https://u:p@cp:8443", "https://cp:8443/", "cp:8443"]) {
    refused(["--link-listen", "127.0.0.1:1", "--control-url", bad, "--control-ca", ca], /--control-url takes/);
  }
  // Each value is one line of keyhole.env: new URL() would drop a newline or tab and pass it.
  for (const [flag, bad] of [["--control-url", "https://cp\nKEK_FILE=/tmp/x:8443"], ["--control-url", "https://cp:8443\t"],
    ["--control-url", "https://cp:8443?a=1"], ["--control-url", "https://cp:8443#x"], ["--public-url", "https://k.example\rX=1"],
    ["--public-url", "https://k.example?"], ["--public-url", "https://k.example #"], ["--link-listen", "127.0.0.1:1\n"]]) {
    const extra = { "--control-url": ["--link-listen", "127.0.0.1:1", "--control-url", bad, "--control-ca", ca],
      "--public-url": [...cpMode(), "--public-url", bad],
      "--link-listen": ["--link-listen", bad, "--control-url", "https://cp:8443", "--control-ca", ca] }[flag];
    refused(extra, new RegExp(`${flag} has a control character, a space, \\? or #`));
  }
  // The forward listener can't be the web listener's address.
  for (const [listen, link] of [["127.0.0.1:8444", "127.0.0.1:8444"], ["localhost:8444", "127.0.0.1:8444"],
    ["0.0.0.0:8444", "127.0.0.1:8444"], ["[::]:8444", "[::1]:8444"]]) {
    const extra = ["--listen", listen, ...(listen.startsWith("0") || listen.startsWith("[::]") ? ["--expose-on-network", "--i-understand-network-exposure",
      "--public-url", "https://keyhole.example"] : []), "--link-listen", link, "--control-url", "https://cp:8443", "--control-ca", ca];
    refused(extra, /--link-listen .* is the address --listen .* serves the web app on/);
  }
  assert.ok(plan(h, release(), ["--listen", "127.0.0.1:8444", "--link-listen", "127.0.0.2:8444", "--control-url", "https://cp:8443",
    "--control-ca", ca]).files[0].text.includes("SERVICE_LISTEN_ADDR=127.0.0.2:8444\n"), "another loopback address on the same port is fine");
  refused([...cpMode(), "--public-url", "http://keyhole.example"], /must be https unless/);
  refused([...cpMode(), "--public-url", "https://keyhole.example/app"], /--public-url takes/);
  assert.deepEqual(calls(h, "npm"), [], "npm was never run");
});

test("--control-ca is read safely: a regular file, PEM certificates only, never a key, bounded; before anything is written", () => {
  const h = host();
  const dir = tempDir("vbcdx-kcabad-");
  const link = join(dir, "ca.pem");
  symlinkSync(caFile(), link);
  const big = join(dir, "big.pem");
  writeFileSync(big, "-----BEGIN CERTIFICATE-----\n" + "A".repeat(70 * 1024));
  const fifo = join(dir, "fifo");
  mkfifoSync(fifo);
  const base = ["--link-listen", "127.0.0.1:8444", "--control-url", "https://127.0.0.1:8443"];
  for (const [path, re] of [[link, /not a symlink/], [dir, /regular file/], [fifo, /regular file/], [caFile("hello\n"), /not a PEM certificate chain/],
    [caFile(CA + "-----BEGIN EC PRIVATE KEY-----\nx\n-----END EC PRIVATE KEY-----\n"), /not a PEM certificate chain/],
    [big, /larger than a certificate chain/], [join(dir, "none.pem"), /can't be opened/]]) {
    assert.throws(() => run(["install", "service", "keyhole-server", "--from", release(), ...base, "--control-ca", path], h),
      (e) => e.code === EXIT.CONFIG && e.message.startsWith("--control-ca ") && re.test(e.message), path);
  }
  assert.ok(!existsSync(at(h, ENV)), "nothing was installed");
  assert.deepEqual(calls(h, "runuser"), []);
});

function mkfifoSync(p) {
  const r = spawnSync("mkfifo", [p]);
  assert.equal(r.status, 0, "mkfifo");
}

test("flags of other services are refused for keyhole-server, and --control-ca for every other service", () => {
  for (const extra of [["--control-plane", "vbcdx+https://h:1?auth=mtls&pin=sha256:" + "0".repeat(64)], ["--tunnel", "0.0.0.0:1", "--tunnel-name", "t"],
    ["--enroll-token-stdin"]]) {
    assert.throws(() => parseServiceArgs(["install", "service", "keyhole-server", ...cpMode(), ...extra]), /not a keyhole-server flag/);
  }
  for (const svc of ["sidecar", "control-plane", "dispatch-server"]) {
    assert.throws(() => parseServiceArgs(["install", "service", svc, "--control-ca", "x"]), /--control-ca is for keyhole-server/);
  }
  for (const svc of ["sidecar", "control-plane"]) {
    for (const k of ["--link-listen", "--control-url", "--public-url", "--service-cert"]) {
      assert.throws(() => parseServiceArgs(["install", "service", svc, k, "x"]), new RegExp(`${k} is for dispatch-server and keyhole-server`));
    }
  }
  assert.throws(() => plan(host(), release(), [...cpMode(), "--listen", "unix:/run/x.sock"]), /takes <host>:<port>/);
});

test("first install: the KEK, then the key and CSR, made as vbcdx-keyhole; nothing checked or started; the next step is printed", () => {
  const h = host();
  const r = install(h, release());
  assert.equal(r.code, 0);
  const made = calls(h, "runuser").filter((c) => c.includes(" kek ") || c.includes(" csr "));
  assert.deepEqual(made, [`-u vbcdx-keyhole -- ${at(h, EXEC)} kek generate --out ${STATE}/kek`,
    `-u vbcdx-keyhole -- ${at(h, EXEC)} service csr --key-out ${STATE}/link.key --csr-out ${STATE}/link.csr`]);
  assert.ok(!calls(h, "runuser").some((c) => c.endsWith(" check")), "no check without a certificate");
  const ctl = calls(h, "systemctl");
  assert.ok(ctl.includes(`enable ${UNIT}`), ctl.join("|"));
  assert.ok(!ctl.some((c) => c.includes("--now") || c.startsWith("restart")), "not started");
  assert.equal(r.report.started, false);
  assert.equal(r.report.link.cert, null);
  assert.equal(r.report.link.control_ca, CA_PATH);
  assert.match(r.report.link.next, /vbcdx-control services add keyhole --url https:\/\/127\.0\.0\.1:8444 .*--service-cert keyhole\.crt/);
  assert.equal(statSync(at(h, `${STATE}/link.key`)).mode & 0o777, 0o600);
  assert.equal(statSync(at(h, `${STATE}/kek`)).mode & 0o777, 0o600);
  assert.equal(readFileSync(at(h, CA_PATH), "utf8"), CA);
  assert.equal(statSync(at(h, CA_PATH)).mode & 0o777, 0o640);
  const rec = JSON.parse(readFileSync(at(h, "/root/.vbcdx/manifests/installation.json"), "utf8")).services["keyhole-server:default"];
  assert.deepEqual(rec.files.map((f) => f.path), [ENV, CA_PATH]);
  assert.equal(rec.package, "@vbcdx/keyhole");
  // No KEK bytes anywhere in what install reports.
  const kek = readFileSync(at(h, `${STATE}/kek`), "utf8");
  assert.ok(!JSON.stringify(r.report).includes(kek), "the KEK is never reported");
});

test("the KEK is made once: a re-run, a certificate run and an upgrade never make or touch it again", () => {
  const h = host();
  install(h, release());
  const kek = readFileSync(at(h, `${STATE}/kek`), "utf8");
  const runs = () => calls(h, "runuser").filter((c) => c.includes(" kek ")).length;
  assert.equal(runs(), 1);
  assert.equal(rerun(h, release(), ["--service-cert", certFile()]).code, 0);
  assert.equal(rerun(h, release("0.2.0")).code, 0);
  assert.equal(install(h, release("0.2.0"), ["--force"]).code, 0);
  assert.equal(runs(), 1, "kek generate ran only on the first install");
  assert.equal(readFileSync(at(h, `${STATE}/kek`), "utf8"), kek, "the KEK's bytes are unchanged");
  // A KEK gone from an instance that has run is never replaced: the install stops, names the
  // way out, and changes nothing.
  rmSync(at(h, `${STATE}/kek`));
  const envBefore = readFileSync(at(h, ENV), "utf8");
  assert.throws(() => rerun(h, release("0.3.0")),
    (e) => e.code === EXIT.CONFLICT && /kek is missing, but this instance has already run \(.*link\.key exists\)/.test(e.message)
      && /remove service keyhole-server --wipe/.test(e.message));
  assert.equal(runs(), 1, "no new KEK");
  assert.ok(!existsSync(at(h, `${STATE}/kek`)));
  assert.equal(readFileSync(at(h, ENV), "utf8"), envBefore);
  const rec = JSON.parse(readFileSync(at(h, "/root/.vbcdx/manifests/installation.json"), "utf8")).services["keyhole-server:default"];
  assert.equal(rec.version, "0.2.0", "the record is still 0.2.0");
  assert.equal(readlinkSync(at(h, "/usr/local/lib/vbcdx/keyhole-server/current")), "0.2.0", "current still points at 0.2.0");
  assert.ok(!existsSync(at(h, "/usr/local/lib/vbcdx/keyhole-server/0.3.0")), "0.3.0's binary was not left behind");
});

test("a failed first install takes out the KEK and key it made; a failed later run never touches them", () => {
  const h = host({ active: "inactive" });
  const answer = h.sys.run.bind(h.sys);
  let failEnable = true;
  h.sys.run = (cmd, args, o) => (failEnable && cmd === "systemctl" && args[0] === "enable"
    ? (h.sys.calls.push([cmd, ...args]), { status: 1, stdout: "", stderr: "enable failed\n" }) : answer(cmd, args, o));
  assert.throws(() => install(h, release()), (e) => e.code === EXIT.SUBPROCESS);
  assert.ok(!existsSync(at(h, `${STATE}/kek`)) && !existsSync(at(h, `${STATE}/link.key`)), "the first run's KEK and key are gone");
  failEnable = false;
  assert.equal(install(h, release()).code, 0);
  const kek = readFileSync(at(h, `${STATE}/kek`), "utf8");
  failEnable = true;
  assert.throws(() => install(h, release("0.2.0")), (e) => e.code === EXIT.SUBPROCESS);
  assert.equal(readFileSync(at(h, `${STATE}/kek`), "utf8"), kek, "a failed upgrade keeps the KEK");
});

test("--service-cert: written 0600 by the service user, checked as that user with --env-file, then started", () => {
  const h = host();
  install(h, release());
  const before = h.sys.calls.length;
  const r = rerun(h, release(), ["--service-cert", certFile()]);
  assert.equal(r.code, 0);
  const after = h.sys.calls.slice(before).map((c) => c.join(" "));
  assert.ok(!after.some((c) => c.includes(" csr ") || c.includes(" kek ")), "the key and KEK are not remade");
  assert.ok(after.includes(`runuser ${CHECK(h)}`), after.join("\n"));
  const write = after.findIndex((c) => c.startsWith("runuser -u vbcdx-keyhole -- /bin/sh -c umask 077") && c.endsWith(at(h, `${STATE}/link.crt`)));
  assert.ok(write >= 0, after.join("\n"));
  assert.ok(!after.some((c) => c.startsWith("chown") && c.includes(STATE)), "root chowns nothing in the state directory");
  assert.ok(after.includes(`systemctl restart ${UNIT}`), after.join("\n"));
  assert.equal(readFileSync(at(h, `${STATE}/link.crt`), "utf8"), CERT);
  assert.equal(statSync(at(h, `${STATE}/link.crt`)).mode & 0o777, 0o600);
  assert.equal(r.report.started, true);
  assert.equal(r.report.link.next, null);
  const i = (s) => after.findIndex((c) => c.includes(s));
  assert.ok(write < i(" --env-file ") && i(" --env-file ") < i("systemctl restart"));
});

test("a certificate keyhole check refuses: nothing starts, and the certificate is taken back out", () => {
  const h = host({ active: "inactive", check: () => ({ status: 1, stderr: "keyhole: check: service: identity: private key does not match public key\n" }) });
  install(h, release());
  assert.throws(() => rerun(h, release(), ["--service-cert", certFile()]),
    (e) => e.code === EXIT.SUBPROCESS && /refuses the config install wrote/.test(e.message) && e.details.lines.some((l) => /does not match/.test(l)));
  assert.ok(!existsSync(at(h, `${STATE}/link.crt`)), "the refused certificate is gone");
  assert.ok(!calls(h, "systemctl").some((c) => c.startsWith("restart") || c.includes("--now")));
  assert.ok(existsSync(at(h, `${STATE}/link.key`)) && existsSync(at(h, `${STATE}/kek`)), "the key and KEK stay");
});

test("B1: a link.crt or kek the service user replaced with a symlink is never followed by root", () => {
  const h = host();
  install(h, release());
  const target = at(h, "/etc/shadow-stand-in");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "root-only\n", { mode: 0o600 });
  symlinkSync(target, at(h, `${STATE}/link.crt`));
  const before = h.sys.calls.length;
  assert.equal(rerun(h, release(), ["--service-cert", certFile()]).code, 0);
  assert.equal(readFileSync(target, "utf8"), "root-only\n", "the link's target is untouched");
  assert.ok(!lstatSync(at(h, `${STATE}/link.crt`)).isSymbolicLink(), "the link itself was replaced");
  const after = h.sys.calls.slice(before).map((c) => c.join(" "));
  assert.ok(!after.some((c) => c.startsWith("chown") && (c.includes("link.crt") || c.includes("shadow"))), after.join("\n"));
  // A planted kek link: root neither reads nor writes through it (keyhole check, as the user, refuses a symlinked KEK).
  rmSync(at(h, `${STATE}/kek`));
  symlinkSync(target, at(h, `${STATE}/kek`));
  // The link stands where a KEK is, so none is made; keyhole check (as the user, O_NOFOLLOW) is what refuses it.
  assert.equal(rerun(h, release("0.2.0")).code, 0);
  assert.ok(lstatSync(at(h, `${STATE}/kek`)).isSymbolicLink(), "root did not replace or follow the link");
  assert.equal(readFileSync(target, "utf8"), "root-only\n");
  assert.ok(!h.sys.calls.some((c) => c[0] === "chown" && c.join(" ").includes(`${STATE}/`)), "no chown of anything in the state directory");
});

test("B2: a cert re-run that fails to start on a running instance puts the old certificate back and starts it again", () => {
  let fail = false;
  const h = host();
  install(h, release(), ["--service-cert", certFile()]);
  const answer = h.sys.run.bind(h.sys);
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
  assert.throws(() => rerun(h, release(), ["--service-cert", certFile(NEW)]), (e) => e.code === EXIT.SUBPROCESS && /did not start/.test(e.message));
  assert.equal(readFileSync(at(h, `${STATE}/link.crt`), "utf8"), CERT, "the old certificate is back");
  const ctl = h.sys.calls.slice(before).filter((c) => c[0] === "systemctl").map((c) => c.slice(1).join(" "));
  assert.deepEqual(ctl.slice(-2), [`reset-failed ${UNIT}`, `restart ${UNIT}`], ctl.join("|"));
});

test("the cert re-run needs no control-plane-mode flags again: listen, link, control URL, public URL and the control CA are carried", () => {
  const h = host();
  assert.equal(install(h, release(), ["--listen", "127.0.0.1:9090", "--public-url", "https://keyhole.example"]).code, 0);
  const envBefore = readFileSync(at(h, ENV), "utf8");
  const r = rerun(h, release(), ["--service-cert", certFile()]);
  assert.equal(r.code, 0);
  assert.equal(r.report.started, true);
  assert.equal(readFileSync(at(h, ENV), "utf8"), envBefore, "the settings are unchanged");
  assert.equal(readFileSync(at(h, CA_PATH), "utf8"), CA, "the control CA is unchanged");
  const dry = rerun(h, release(), ["--dry-run"]);
  assert.deepEqual(dry.report.carried.map((c) => [c.setting, c.value]), [["listen", "127.0.0.1:9090"],
    ["link_listen", "127.0.0.1:8444"], ["control_url", "https://127.0.0.1:8443"], ["public_url", "https://keyhole.example"],
    ["control_ca", CA_PATH]]);
  // A flag that is given overrides only its own setting; a new CA replaces the recorded one.
  const NEWCA = CA.replace("MIIBcontrolca", "MIIBnewca");
  const over = rerun(h, release(), ["--link-listen", "127.0.0.1:9444", "--control-ca", caFile(NEWCA), "--dry-run"]);
  assert.ok(over.report.files[0].text.includes("SERVICE_LISTEN_ADDR=127.0.0.1:9444\n"));
  assert.ok(over.report.files[0].text.includes("CONTROL_URL=https://127.0.0.1:8443\n"));
  assert.equal(over.report.files[1].text, NEWCA);
});

test("an installed control CA that is missing, a symlink, not PEM, a key or too big refuses the carry-over: nothing is guessed", () => {
  const h = host();
  install(h, release());
  const refused = (re, what) => assert.throws(() => rerun(h, release(), ["--dry-run"]),
    (e) => e.code === EXIT.CONFLICT && /control-ca\.pem can't be carried over/.test(e.message) && re.test(e.message)
      && e.details.refused === "carry-over", what);
  rmSync(at(h, CA_PATH));
  refused(/can't be opened \(ENOENT\)/, "missing");
  symlinkSync(caFile(), at(h, CA_PATH));
  refused(/can't be opened \(ELOOP\)/, "a symlink");
  rmSync(at(h, CA_PATH));
  for (const [text, re, what] of [["hello\n", /not a PEM certificate chain/, "not PEM"],
    [CA + "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n", /not a PEM certificate chain/, "a key"],
    ["-----BEGIN CERTIFICATE-----\n" + "A".repeat(70 * 1024), /larger than a certificate chain/, "too big"]]) {
    writeFileSync(at(h, CA_PATH), text, { mode: 0o640 });
    refused(re, what);
  }
  // Given again, it isn't needed.
  rmSync(at(h, CA_PATH));
  assert.equal(rerun(h, release(), ["--control-ca", caFile(), "--dry-run"]).code, 0);
});

test("--link-listen already bound is refused before anything is written; the instance's own listener is not 'in use'", () => {
  const listening = (...locals) => () => locals.map((l) => `LISTEN 0 4096 ${l} 0.0.0.0:*`).join("\n") + "\n";
  for (const held of ["127.0.0.1:8444", "0.0.0.0:8444"]) {
    const h = host({ ss: listening(held) });
    assert.throws(() => install(h, release()),
      (e) => e.code === EXIT.CONFLICT && e.message.startsWith(`--link-listen 127.0.0.1:8444 (in use: something already listens on ${held})`), held);
    assert.ok(!existsSync(at(h, ENV)) && !calls(h, "runuser").length, "nothing written or run");
  }
  let held = "";
  const h = host({ ss: () => held });
  install(h, release());
  held = listening("127.0.0.1:8444", "127.0.0.1:8080")();
  assert.equal(rerun(h, release(), ["--service-cert", certFile()]).code, 0);
});

test("doctor: the key, the KEK, the certificate and keyhole check, as the unit's user", () => {
  const h = host();
  install(h, release());
  const byName = (rep) => Object.fromEntries(rep.checks.map((c) => [c.check, c]));
  let r = run(["doctor", "--service", "keyhole-server"], h);
  assert.equal(r.code, 5);
  let c = byName(r.report);
  assert.equal(c["link key 0600"].ok, true);
  assert.equal(c["KEK 0600"].ok, true);
  assert.equal(c["link certificate"].ok, false);
  assert.match(c["link certificate"].detail, /services add keyhole/);
  rerun(h, release(), ["--service-cert", certFile()]);
  const before = h.sys.calls.length;
  r = run(["doctor", "--service", "keyhole-server"], h);
  assert.equal(r.code, 0, JSON.stringify(r.report.checks.filter((x) => !x.ok)));
  assert.deepEqual(h.sys.calls.slice(before).filter((c) => c[0] === "runuser").map((c) => c.slice(1).join(" ")), [CHECK(h)],
    "doctor runs keyhole --env-file <env> check as vbcdx-keyhole");
  assert.deepEqual(r.report.checks.map((x) => x.check), ["binary keyhole", "current symlink", `file ${ENV}`, `file ${CA_PATH}`,
    "state dir 0700", "link key 0600", "KEK 0600", "link certificate", "keyhole check", "unit file", "unit active"]);
  assert.ok(calls(h, "runuser").includes(CHECK(h)));
  chmodSync(at(h, `${STATE}/kek`), 0o640);
  r = run(["doctor", "--service", "keyhole-server"], h);
  assert.equal(r.code, 5);
  assert.equal(byName(r.report)["KEK 0600"].ok, false);
  // A control CA edited since install fails its file check.
  chmodSync(at(h, `${STATE}/kek`), 0o600);
  writeFileSync(at(h, CA_PATH), CA + "\n");
  r = run(["doctor", "--service", "keyhole-server"], h);
  assert.equal(byName(r.report)[`file ${CA_PATH}`].ok, false);
});

test("a user (non-root) install is refused: keyhole-server runs as its own system user", () => {
  const h = host({ uid: 1000 });
  assert.throws(() => install(h, release()), (e) => e.code === EXIT.CONFLICT && /needs root/.test(e.message));
});

test("remove takes out the unit, env file and control CA; the KEK and keys stay unless --wipe", () => {
  const h = host();
  install(h, release(), ["--service-cert", certFile()]);
  const kek = readFileSync(at(h, `${STATE}/kek`), "utf8");
  run(["remove", "service", "keyhole-server"], h);
  assert.ok(!existsSync(at(h, ENV)) && !existsSync(at(h, CA_PATH)) && !existsSync(at(h, `/etc/systemd/system/${UNIT}`)));
  assert.equal(readFileSync(at(h, `${STATE}/kek`), "utf8"), kek, "the KEK is kept without --wipe");
  assert.ok(existsSync(at(h, `${STATE}/link.key`)), "state is kept without --wipe");
  // Reinstalled over the kept state: the same KEK, never a new one.
  install(h, release(), ["--service-cert", certFile()]);
  assert.equal(readFileSync(at(h, `${STATE}/kek`), "utf8"), kek);
  run(["remove", "service", "keyhole-server", "--wipe"], h);
  assert.ok(!existsSync(at(h, `${STATE}/kek`)) && !existsSync(at(h, `${STATE}/link.key`)) && !existsSync(at(h, `${STATE}/link.crt`)));
});

test("a dry run shows the plan and the link step, and writes or runs nothing", () => {
  const h = host();
  const r = run(["install", "service", "keyhole-server", "--from", release(), ...cpMode(), "--dry-run", "--json"], h);
  assert.equal(r.code, 0);
  assert.equal(r.report.dryRun, true);
  assert.equal(r.report.link.key, `${STATE}/link.key`);
  assert.ok(!existsSync(at(h, ENV)) && !existsSync(at(h, CA_PATH)));
  assert.deepEqual(calls(h, "runuser"), []);
});

test("a record for keyhole-server must name exactly its env file and then its control CA", () => {
  const h = host();
  install(h, release());
  const rec = JSON.parse(readFileSync(at(h, "/root/.vbcdx/manifests/installation.json"), "utf8")).services["keyhole-server:default"];
  const where = { scope: "system", home: "/root" };
  validateRecord("keyhole-server:default", rec, where);
  for (const files of [[rec.files[0]], [rec.files[1], rec.files[0]], [rec.files[0], { ...rec.files[1], path: `${CONF}/other.pem` }],
    [...rec.files, rec.files[1]], [...rec.files, { ...rec.files[1], path: `${CONF}/other.pem` }]]) {
    assert.throws(() => validateRecord("keyhole-server:default", { ...rec, files }, where),
      (e) => e.code === EXIT.FILESYSTEM && /files/.test(e.message), JSON.stringify(files.map((f) => f.path)));
  }
});

test("the URLs written to keyhole.env are the parsed ones, never the raw text", () => {
  const p = plan(host(), release(), ["--link-listen", "127.0.0.1:8444", "--control-url", "HTTPS://CP.Example:8443",
    "--public-url", "HTTPS://Keyhole.Example", "--control-ca", caFile()]);
  assert.ok(p.files[0].text.includes("CONTROL_URL=https://cp.example:8443\n"), p.files[0].text);
  assert.ok(p.files[0].text.includes("PUBLIC_URL=https://keyhole.example\n"), p.files[0].text);
});

test("a Keyhole release older than 0.1.0-dev.2 (no keyhole check or --env-file) is refused before anything is written", () => {
  for (const old of ["0.1.0-dev.1", "0.0.9"]) {
    const h = host();
    assert.throws(() => install(h, release(old)),
      (e) => e.code === EXIT.CONFLICT && e.message.startsWith(`keyhole-server needs @vbcdx/keyhole 0.1.0-dev.2 or newer`) && e.message.includes(`not ${old}`), old);
    assert.ok(!existsSync(at(h, ENV)) && !calls(h, "runuser").length, "nothing written or run");
  }
  for (const ok of ["0.1.0-dev.2", "0.1.0-dev.10", "0.1.0"]) assert.equal(plan(host(), release(ok)).version, ok);
});

test("a database without a KEK (the operator removed both the KEK and the link key) is never given a new KEK", () => {
  const h = host();
  install(h, release());
  // Keyhole has run: its database is there. Then the KEK and the link files are removed by hand.
  writeFileSync(at(h, `${STATE}/keyhole.db`), "SQLite format 3\0", { mode: 0o600 });
  for (const f of ["kek", "link.key", "link.csr"]) rmSync(at(h, `${STATE}/${f}`));
  const runs = () => calls(h, "runuser").filter((c) => c.includes(" kek ")).length;
  assert.throws(() => rerun(h, release("0.3.0")),
    (e) => e.code === EXIT.CONFLICT && new RegExp(`has already run \\(${STATE}/keyhole\\.db exists\\)`).test(e.message));
  assert.equal(runs(), 1, "no new KEK over the sealed values");
  assert.ok(!existsSync(at(h, `${STATE}/kek`)));
});

test("B3: the cert re-run works on a network-exposed instance: the recorded listen carries its acknowledgement", () => {
  const h = host();
  assert.equal(install(h, release(), ["--listen", "0.0.0.0:8080", "--expose-on-network", "--i-understand-network-exposure",
    "--public-url", "https://keyhole.example"]).code, 0);
  const r = rerun(h, release(), ["--service-cert", certFile()]);
  assert.equal(r.code, 0);
  assert.equal(r.report.started, true);
  assert.ok(readFileSync(at(h, ENV), "utf8").includes("LISTEN_ADDR=0.0.0.0:8080\nPUBLIC_URL=https://keyhole.example\n"));
  const dry = rerun(h, release(), ["--dry-run"]);
  assert.ok(dry.report.carried.some((c) => c.setting === "expose_on_network"));
  // Without the acknowledgement, a network listen is refused on a first install.
  assert.throws(() => install(host(), release(), ["--listen", "0.0.0.0:8080", "--public-url", "https://keyhole.example"]),
    (e) => e.code === EXIT.CONFIG && /expose-on-network/.test(e.message));
  // A loopback listen carries no acknowledgement.
  const h2 = host();
  install(h2, release());
  assert.ok(!rerun(h2, release(), ["--dry-run"]).report.carried.some((c) => c.setting === "expose_on_network"));
});

test("the dry run says what the link step makes and whether the unit starts", () => {
  // A first install with no certificate: the KEK, key and CSR are listed (path, mode, owner), the
  // link listener is named, and the unit is installed but not started.
  const h = host();
  const first = run(["install", "service", "keyhole-server", "--from", release(), ...cpMode(), "--dry-run"], h);
  assert.deepEqual(first.report.link_steps, { cert: "missing", starts: false, refused: null, make: [
    { what: "KEK", path: `${STATE}/kek`, mode: "0600", owner: "vbcdx-keyhole:vbcdx-keyhole" },
    { what: "link key", path: `${STATE}/link.key`, mode: "0600", owner: "vbcdx-keyhole:vbcdx-keyhole" },
    { what: "link CSR", path: `${STATE}/link.csr`, mode: "0600", owner: "vbcdx-keyhole:vbcdx-keyhole" }] });
  const text = humanPlan(first.report);
  for (const line of [`  make as vbcdx-keyhole: KEK 0600 vbcdx-keyhole:vbcdx-keyhole ${STATE}/kek`,
    `  make as vbcdx-keyhole: link key 0600 vbcdx-keyhole:vbcdx-keyhole ${STATE}/link.key`,
    `  make as vbcdx-keyhole: link CSR 0600 vbcdx-keyhole:vbcdx-keyhole ${STATE}/link.csr`,
    "  link listener 127.0.0.1:8444 (mTLS; vbcdx-control calls it), control https://127.0.0.1:8443"]) {
    assert.ok(text.split("\n").includes(line), `missing: ${line}\n${text}`);
  }
  assert.match(text, /unit \(systemd\) 0644 \/etc\/systemd\/system\/vbcdx-keyhole-server-default\.service, not started: no link certificate yet \(vbcdx-control services add keyhole .*then rerun with --service-cert\)/);
  assert.ok(!text.includes("then start it"), text);
  // The same first install with --service-cert: it starts, after the check.
  const withCert = humanPlan(run(["install", "service", "keyhole-server", "--from", release(), ...cpMode(), "--service-cert", certFile(), "--dry-run"], host()).report);
  assert.match(withCert, /link certificate .*link\.crt \(--service-cert\), checked as vbcdx-keyhole before the start/);
  assert.match(withCert, /vbcdx-keyhole-server-default\.service, then start it/);
  // --no-start says so, certificate or not.
  assert.match(humanPlan(run(["install", "service", "keyhole-server", "--from", release(), ...cpMode(), "--no-start", "--dry-run"], host()).report),
    /service, not started \(--no-start\)/);
  // Once installed, nothing already there is listed again: no KEK, key or CSR to make.
  install(h, release());
  const again = run(["install", "service", "keyhole-server", "--from", release("0.2.0"), "--dry-run"], h);
  assert.deepEqual(again.report.link_steps.make, []);
  assert.ok(!humanPlan(again.report).includes("make as"), humanPlan(again.report));
  // A KEK or key's content never appears in the plan.
  const kek = readFileSync(at(h, `${STATE}/kek`), "utf8");
  assert.ok(!JSON.stringify(again.report).includes(kek) && !humanPlan(again.report).includes(kek));
});

test("the same for dispatch-server (no KEK): key and CSR, and no start without a certificate", () => {
  const h = host();
  const r = planInstall(parseServiceArgs(["install", "service", "dispatch-server", "--from", dispatchRelease(),
    "--link-listen", "0.0.0.0:8443", "--control-url", "https://10.0.0.5:8443"]), h.deps);
  assert.ok(!r.plan.kek, "dispatch-server has no KEK");
  const dry = run(["install", "service", "dispatch-server", "--from", dispatchRelease(), "--link-listen", "0.0.0.0:8443",
    "--control-url", "https://10.0.0.5:8443", "--dry-run"], h);
  assert.deepEqual(dry.report.link_steps.make.map((m) => m.what), ["link key", "link CSR"]);
  assert.match(humanPlan(dry.report), /vbcdx-dispatch-server-default\.service, not started: no link certificate yet/);
});

test("the dry run mirrors install's missing-KEK refusal: no KEK line, a CONFLICT, exit 5", () => {
  for (const [what, setup] of [["the link key is there", () => {}],
    ["keyhole.db is there (key and CSR removed too)", (h) => {
      writeFileSync(at(h, `${STATE}/keyhole.db`), "SQLite format 3\0", { mode: 0o600 });
      for (const f of ["link.key", "link.csr"]) rmSync(at(h, `${STATE}/${f}`));
    }]]) {
    const h = host();
    install(h, release());
    rmSync(at(h, `${STATE}/kek`));
    setup(h);
    const dry = rerun(h, release("0.3.0"), ["--dry-run"]);
    assert.equal(dry.code, EXIT.CONFLICT, what);
    assert.deepEqual(dry.report.link_steps.make, [], what);
    assert.equal(dry.report.link_steps.starts, false, what);
    assert.match(dry.report.link_steps.refused, /kek is missing, but this instance has already run/, what);
    const text = humanPlan(dry.report);
    assert.ok(!text.includes("make as vbcdx-keyhole: KEK"), text);
    assert.match(text, /CONFLICT .*kek is missing, but this instance has already run .* Install would refuse \(exit 5\)\./);
    // And the real install refuses with the same words.
    assert.throws(() => rerun(h, release("0.3.0")), (e) => e.code === EXIT.CONFLICT && e.message === dry.report.link_steps.refused, what);
  }
});

test("cert 'installed' starts the unit; partial key material is planned as install makes it", () => {
  const h = host();
  install(h, release(), ["--service-cert", certFile()]);
  const dry = rerun(h, release("0.2.0"), ["--dry-run"]);
  assert.equal(dry.report.link_steps.cert, "installed");
  assert.equal(dry.report.link_steps.starts, true);
  // KEK there, key and CSR gone: the key and CSR are made, not the KEK.
  const h2 = host();
  install(h2, release());
  for (const f of ["link.key", "link.csr"]) rmSync(at(h2, `${STATE}/${f}`));
  writeFileSync(at(h2, `${STATE}/keyhole.db`), "SQLite format 3\0", { mode: 0o600 });
  // (the KEK is there, so no refusal even though the DB is)
  assert.deepEqual(rerun(h2, release("0.2.0"), ["--dry-run"]).report.link_steps.make.map((m) => m.what), ["link key", "link CSR"]);
  // Key there, CSR gone: nothing is made (install keeps the key and makes no CSR).
  const h3 = host();
  install(h3, release());
  rmSync(at(h3, `${STATE}/link.csr`));
  assert.deepEqual(rerun(h3, release("0.2.0"), ["--dry-run"]).report.link_steps.make, []);
  // Key gone, CSR there: both are made (install replaces the old CSR).
  const h4 = host();
  install(h4, release());
  rmSync(at(h4, `${STATE}/link.key`));
  assert.deepEqual(rerun(h4, release("0.2.0"), ["--dry-run"]).report.link_steps.make.map((m) => m.what), ["link key", "link CSR"]);
  // --no-start with --service-cert: checked, but nothing says it starts.
  const t = humanPlan(run(["install", "service", "keyhole-server", "--from", release(), ...cpMode(), "--service-cert", certFile(), "--no-start", "--dry-run"], host()).report);
  assert.ok(t.includes("(--service-cert), checked as vbcdx-keyhole\n") || /\(--service-cert\), checked as vbcdx-keyhole$/m.test(t), t);
  assert.ok(!t.includes("before the start") && /not started \(--no-start\)/.test(t), t);
});

test("dispatch-server with --service-cert or an installed cert starts; the sidecar has no link_steps", () => {
  const args = ["--link-listen", "0.0.0.0:8443", "--control-url", "https://10.0.0.5:8443"];
  const given = run(["install", "service", "dispatch-server", "--from", dispatchRelease(), ...args, "--service-cert", certFile(), "--dry-run"], host());
  assert.deepEqual([given.report.link_steps.cert, given.report.link_steps.starts], ["given", true]);
  assert.match(humanPlan(given.report), /vbcdx-dispatch-server-default\.service, then start it/);
  const h = host();
  run(["install", "service", "dispatch-server", "--from", dispatchRelease(), ...args, "--service-cert", certFile()], h);
  const again = run(["install", "service", "dispatch-server", "--from", dispatchRelease(), "--dry-run"], h);
  assert.deepEqual([again.report.link_steps.cert, again.report.link_steps.starts, again.report.link_steps.make], ["installed", true, []]);
});
