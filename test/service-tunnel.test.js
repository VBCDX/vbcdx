// The sidecar ↔ control-plane tunnel in the installer: the control plane's listener
// (--tunnel/--tunnel-name), the sidecar's control_plane key (--control-plane), its one-time
// enrollment (--enroll-token-file / --enroll-token-stdin, never argv) and doctor's dial.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as tomlParse } from "smol-toml";
import { keypair, signFile } from "./helpers/minisign-signer.js";
import { tempDir } from "./helpers/temp-dir.js";
import { planInstall, runService, humanPlan } from "../src/service/index.js";
import { parseServiceArgs } from "../src/service/args.js";
import { parseControlPlane, parseTunnel } from "../src/service/plan.js";
import { fakeSystem } from "../src/service/system.js";
import { fakeAccounts } from "./helpers/fake-accounts.js";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const KEY = keypair(11);
const PIN = `sha256:${"ab".repeat(32)}`;
const CP = `vbcdx+https://cp.example:8443?auth=mtls&pin=${PIN}`;
const CP2 = `vbcdx+https://cp2.example:8443?auth=mtls&pin=${PIN}`;
const TOKEN = "vbx_enr_CANARY0123456789abcdefTOKEN";

function release(version = "0.1.0") {
  const root = tempDir("vbcdx-rel-");
  const files = {};
  for (const name of ["vbcdx-sidecar", "vbcdx-svc", "vbcdx-control"]) {
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

// The daemon's real output shapes, vbcdx-core main 4eda5565:
// - `vbcdx-sidecar enroll` prints {"changed":true,"data":{sidecar_id, replaced, state}}
//   (crates/vbcdx-sidecar/src/main.rs, Cmd::Enroll; daemon.rs `enroll` returns the data);
// - `vbcdx-sidecar check` prints Plan::summary() (daemon.rs:156), whose control_plane is
//   {host, port, trust, enrolled, sidecar_id};
// - `check --dial` prints the same summary with control_plane.dial = {ok: true, sidecar_id}
//   (main.rs, Cmd::Check with --dial);
// - `check --live` prints it with control_plane.live = {ok: true, sidecar_id}; exit 10 when the
//   running daemon is connected as another id, 9 when it is down (daemon.rs `live`).
const line = (o) => ({ stdout: `${JSON.stringify(o)}\n` });
const enrollOut = (id = "sc_7f3") => line({ changed: true, data: { sidecar_id: id, replaced: null, state: "/var/lib/vbcdx/default/tunnel" } });
function summary({ enrolled, dial = null, live = null }) {
  return { instance: "default", listen: "/run/vbcdx/default.sock", admin_socket: "/run/vbcdx/default.admin.sock",
    socket_mode: "0660", socket_group: "vbcdx", tcp: null, state_dir: "/var/lib/vbcdx/default",
    control_plane: { host: "cp.example", port: 8443, trust: "pin", enrolled, sidecar_id: enrolled ? "sc_7f3" : null, ...(dial ? { dial } : {}), ...(live ? { live } : {}) } };
}

// A host under a temp root. The sidecar starts unenrolled (`enrolled`); a successful enroll
// stub enrolls it, writing <state>/tunnel/ as the daemon does. `systemctl` can fail a verb.
function host({ enrolled = false, enroll = null, dial = null, live = null, stdin = () => Buffer.from(`${TOKEN}\n`), uid = 0, failVerb = null, accounts = {} } = {}) {
  const root = tempDir("vbcdx-host-");
  const state = { enrolled };
  const home = uid === 0 ? "/root" : "/home/u";
  const stateDir = uid === 0 ? "/var/lib/vbcdx/default" : "/home/u/.vbcdx/services/default";
  // Users and groups as shadow-utils keeps them (helpers/fake-accounts.js): no stub weaker than the host.
  const acct = fakeAccounts({ ...accounts, gid: process.getgid() });
  const sys = fakeSystem(root, { uid, answer: (cmd, args) => {
    const a = acct.answer(cmd, args);
    if (a) return a;
    if (args.includes("enroll")) {
      const r = enroll ? enroll(cmd, args) : enrollOut();
      if (!r.status) {
        state.enrolled = true;
        mkdirSync(join(root, stateDir, "tunnel"), { recursive: true });
        writeFileSync(join(root, stateDir, "tunnel", "client.key"), "k");
      }
      return r;
    }
    if (args.includes("--dial")) return dial ? dial(cmd, args) : line(summary({ enrolled: true, dial: { ok: true, sidecar_id: "sc_7f3" } }));
    if (args.includes("--live")) return live ? live(cmd, args) : line(summary({ enrolled: true, live: { ok: true, sidecar_id: "sc_7f3" } }));
    if (args.includes("check")) return line(summary({ enrolled: state.enrolled }));
    if (cmd === "systemctl" && args.includes("is-active")) return { stdout: "active\n" };
    if (cmd === "systemctl" && failVerb && args.includes(failVerb)) return { status: 1, stderr: `${failVerb} failed\n` };
    return {};
  } });
  return { acct, sys, root, stateDir, deps: { sys, trustedKeys: [KEY.pub], platformId: "linux-x64-gnu", readStdin: stdin,
    host: { uid, home, runtimeDir: uid === 0 ? null : "/run/user/1000" } } };
}
const argv = (svc, rel, extra = []) => ["install", "service", svc, "--from", rel, ...extra];
const run = (a, h) => runService(parseServiceArgs(a), h.deps);
const plan = (a, h) => planInstall(parseServiceArgs(a), h.deps).plan;
const at = (h, p) => join(h.root, p);
const calls = (h, cmd) => h.sys.calls.filter((c) => c[0] === cmd).map((c) => c.slice(1).join(" "));
// systemctl calls without the post-start liveness polls (is-active / show NRestarts), and whether the
// wait polled after `after` (the start or restart call).
const isPoll = (c) => c[0] === "systemctl" && (c.includes("is-active") || c.includes("show"));
const lifecycle = (h) => calls(h, "systemctl").filter((c) => !/^(--user )?(is-active|show) /.test(c));
const waitedAfter = (h, after) => {
  const all = calls(h, "systemctl");
  const i = all.lastIndexOf(after);
  return i >= 0 && /^(--user )?is-active /.test(all[i + 1] || "");
};
const BIN = (h) => at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-sidecar");
// The umask never decides the mode: it is set, then checked, so each refusal row really has it.
function tokenFile(mode = 0o600, body = `${TOKEN}\n`) {
  const f = join(tempDir("vbcdx-tok-"), "token");
  writeFileSync(f, body);
  chmodSync(f, mode);
  assert.equal(statSync(f).mode & 0o777, mode, "the fixture has the mode it claims");
  return f;
}
const recordText = (h) => (existsSync(at(h, "/root/.vbcdx/manifests/installation.json")) ? readFileSync(at(h, "/root/.vbcdx/manifests/installation.json"), "utf8") : "");
// Everything the installer said or ran: no token value may be in any of it.
const everything = (h, ...more) => JSON.stringify([h.sys.calls, recordText(h), ...more]);
const errorText = (e) => JSON.stringify([e.message, e.details]);

test("argument rules: each flag belongs to one service, the token needs a control plane, the tunnel needs a name", () => {
  const rel = "/x";
  const refused = [
    [argv("control-plane", rel, ["--control-plane", CP]), /--control-plane is for the sidecar/],
    [argv("control-plane", rel, ["--enroll-token-stdin"]), /--enroll-token-stdin is for the sidecar/],
    [argv("sidecar", rel, ["--tunnel", "0.0.0.0:8443", "--tunnel-name", "cp"]), /--tunnel is for the control plane/],
    [argv("sidecar", rel, ["--tunnel-name", "cp"]), /--tunnel-name is for the control plane/],
    [argv("sidecar", rel, ["--control-plane", CP, "--enroll-token-file", "/t", "--enroll-token-stdin"]), /Give the enrollment token once/],
    [argv("sidecar", rel, ["--enroll-token-stdin"]), /An enrollment token needs --control-plane/],
    [argv("sidecar", rel, ["--enroll-token-file", "/t"]), /An enrollment token needs --control-plane/],
    [argv("control-plane", rel, ["--tunnel", "0.0.0.0:8443"]), /--tunnel and --tunnel-name go together/],
    [argv("control-plane", rel, ["--tunnel-name", "cp"]), /--tunnel and --tunnel-name go together/],
    [["install", "service", "keyhole", "--control-plane", CP], /keyhole is not a service of its own: .*keyhole-server\)\.$/],
    [["install", "service", "dispatch", "--tunnel", "0.0.0.0:1"], /dispatch is not a service of its own: .*dispatch-server\)\.$/],
  ];
  for (const [a, re] of refused) assert.throws(() => parseServiceArgs(a), re, a.join(" "));
  const o = parseServiceArgs(argv("sidecar", rel, ["--control-plane", CP, "--enroll-token-file", "/t"]));
  assert.deepEqual([o.controlPlane, o.enrollTokenFile, o.enrollTokenStdin], [CP, "/t", false]);
});

test("--control-plane: the tunnel's own rules, checked before anything is written", () => {
  for (const ok of [CP, `vbcdx+https://10.0.0.5:8443?auth=mtls&pin=sha256:${"AB".repeat(32)}`,
    "vbcdx+https://[fd00::1]:8443?auth=mtls&ca=/etc/vbcdx/cp.pem", "vbcdx+https://cp:8443?auth=mtls&ca=%2Fetc%2Fca.pem",
    `vbcdx+https://cp:8443?pin=${PIN}&auth=mtls&timeout=30s`, `vbcdx+https://cp:65535?auth=mtls&pin=${PIN}`]) {
    assert.equal(parseControlPlane(ok), ok, ok);
  }
  const refused = [
    [`vbcdx+http://cp:8443?auth=mtls&pin=${PIN}`, /takes vbcdx\+https/],
    [`vbcdx+unix:///run/cp.sock?auth=mtls&pin=${PIN}`, /takes vbcdx\+https/],
    [`vbcdx+wss://cp:8443?auth=mtls&pin=${PIN}`, /takes vbcdx\+https/],
    [`vbcdx+https://cp?auth=mtls&pin=${PIN}`, /takes vbcdx\+https/],
    [`vbcdx+https://cp:0?auth=mtls&pin=${PIN}`, /takes vbcdx\+https/],
    [`vbcdx+https://cp:65536?auth=mtls&pin=${PIN}`, /takes vbcdx\+https/],
    ["vbcdx+https://cp:8443", /takes vbcdx\+https/],
    [`vbcdx+https://cp:8443?pin=${PIN}`, /needs auth=mtls/],
    [`vbcdx+https://cp:8443?auth=token&pin=${PIN}`, /needs auth=mtls/],
    [`vbcdx+https://cp:8443?auth=mtls&pin=${PIN}&ca=/x.pem`, /pin= or ca=, not both/],
    ["vbcdx+https://cp:8443?auth=mtls", /needs pin=sha256:<64 hex> or ca=/],
    ["vbcdx+https://cp:8443?auth=mtls&pin=sha256:abcd", /64 hex digits/],
    [`vbcdx+https://cp:8443?auth=mtls&pin=${"ab".repeat(32)}`, /64 hex digits/],
    ["vbcdx+https://cp:8443?auth=mtls&ca=etc/ca.pem", /ca= must be an absolute path/],
    ["vbcdx+https://cp:8443?auth=mtls&ca=%E0%A4%A", /ca= must be an absolute path/],
    [`vbcdx+https://cp:8443?auth=mtls&auth=mtls&pin=${PIN}`, /gives auth twice/],
  ];
  for (const [v, re] of refused) assert.throws(() => parseControlPlane(v), re, v);
});

test("--tunnel / --tunnel-name: host:port (IPv4, a name or [IPv6]) and a name of kind Id", () => {
  assert.deepEqual(parseTunnel("0.0.0.0:8443", "cp.example"), { conn: "vbcdx+https://0.0.0.0:8443?auth=mtls", name: "cp.example", text: "0.0.0.0:8443" });
  assert.equal(parseTunnel("[::]:8443", "203.0.113.9").conn, "vbcdx+https://[::]:8443?auth=mtls");
  assert.equal(parseTunnel("[fd00::1]:65535", "cp_1").conn, "vbcdx+https://[fd00::1]:65535?auth=mtls");
  assert.equal(parseTunnel("cp:1", "x".repeat(128)).name, "x".repeat(128));
  for (const [l, n, re] of [["8443", "cp", /--tunnel takes <host>:<port>/], ["cp:0", "cp", /--tunnel takes/], ["cp:65536", "cp", /--tunnel takes/],
    ["[fd00::1:8443", "cp", /--tunnel takes/], ["cp:8443", "cp example", /--tunnel-name takes/], ["cp:8443", "fd00::1", /--tunnel-name takes/],
    ["cp:8443", "cp/x", /--tunnel-name takes/], ["cp:8443", "x".repeat(129), /--tunnel-name takes/], ["cp:8443", "", /--tunnel-name takes/]]) {
    assert.throws(() => parseTunnel(l, n), re, `${l} ${n}`);
  }
});

test("the control plane with --tunnel: tunnel + tunnel_name in control.toml, and the unit gets AF_INET/AF_INET6", () => {
  const h = host();
  const p = plan(argv("control-plane", release(), ["--tunnel", "0.0.0.0:8443", "--tunnel-name", "cp.example"]), h);
  assert.deepEqual({ ...tomlParse(p.files[0].text) }, { admin_socket: "/run/vbcdx-control/default.admin.sock",
    state_dir: "/var/lib/vbcdx-control/default", tunnel: "vbcdx+https://0.0.0.0:8443?auth=mtls", tunnel_name: "cp.example" });
  const af = p.unit.text.split("\n").filter((l) => l.startsWith("RestrictAddressFamilies="));
  assert.deepEqual(af, ["RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6"]);
  assert.deepEqual(p.tunnel, { listen: "0.0.0.0:8443", name: "cp.example" });
  assert.match(humanPlan(p), /^ {2}tunnel listener 0\.0\.0\.0:8443 \(mTLS; sidecars dial cp\.example\)$/m);
  const q = plan(argv("control-plane", release()), host());
  assert.deepEqual(q.unit.text.split("\n").filter((l) => l.startsWith("RestrictAddressFamilies=")), ["RestrictAddressFamilies=AF_UNIX"]);
  assert.deepEqual(Object.keys(tomlParse(q.files[0].text)).sort(), ["admin_socket", "state_dir"]);
  assert.equal(q.tunnel, null);
});

test("the sidecar with --control-plane: the key in sidecar.toml; with a token, an enroll step that never holds the token", () => {
  const h = host();
  const rel = release();
  const plain = plan(argv("sidecar", rel, ["--control-plane", CP]), h);
  assert.equal(tomlParse(plain.files[0].text).control_plane, CP);
  assert.deepEqual([plain.control_plane, plain.enroll], [CP, null]);
  const f = tokenFile();
  const r = run([...argv("sidecar", rel, ["--control-plane", CP, "--enroll-token-file", f]), "--dry-run"], h).report;
  assert.deepEqual(r.enroll, { from: `file ${f}`, argv: ["/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-sidecar", "enroll", "--instance",
    "default", "--instance-dir", "/etc/vbcdx/default", "--token-stdin"] });
  assert.ok(!JSON.stringify(r).includes("CANARY"), "a dry run never reads or shows the token");
  assert.match(humanPlan(r), /enroll with it, token from file .*: .*vbcdx-sidecar enroll --instance default --instance-dir \/etc\/vbcdx\/default --token-stdin$/m);
  assert.equal(plan(argv("sidecar", rel), h).control_plane, null);
  assert.equal(tomlParse(plan(argv("sidecar", rel), h).files[0].text).control_plane, undefined);
});

test("install with --enroll-token-file: check, then enroll as vbcdx with the token on stdin only, then the unit; the id comes from data.sidecar_id", () => {
  const h = host();
  const r = run(argv("sidecar", release(), ["--control-plane", CP, "--enroll-token-file", tokenFile()]), h).report;
  assert.equal(r.enrolled, "sc_7f3");
  const order = h.sys.calls.filter((c) => !isPoll(c)).map((c) => (c.includes("enroll") ? "enroll" : c.includes("check") ? "check" : c[0])).filter((x) => ["enroll", "check", "systemctl"].includes(x));
  assert.deepEqual(order, ["check", "enroll", "systemctl", "systemctl"]);
  assert.deepEqual(lifecycle(h), ["daemon-reload", "enable --now vbcdx-sidecar-default.service"]);
  assert.deepEqual(calls(h, "runuser").filter((c) => c.includes("enroll")),
    [`-u vbcdx -- ${BIN(h)} enroll --instance default --instance-dir /etc/vbcdx/default --token-stdin`]);
  const i = h.sys.calls.findIndex((c) => c.includes("enroll"));
  assert.equal(h.sys.opts[i].input.toString(), `${TOKEN}\n`);
  assert.ok(!everything(h, r).includes("CANARY"), "the token is in no argv, report or record");
  assert.ok(!readFileSync(at(h, "/etc/vbcdx/default/sidecar.toml"), "utf8").includes("CANARY"));
  // An enroll that prints no data.sidecar_id (e.g. the old flat shape) is reported as such.
  const flat = host({ enroll: () => line({ sidecar_id: "sc_flat" }) });
  assert.equal(run(argv("sidecar", release(), ["--control-plane", CP, "--enroll-token-file", tokenFile()]), flat).report.enrolled, "(no id reported)");
});

test("--enroll-token-stdin reads the token from stdin; more than a token is refused", () => {
  const h = host({ stdin: () => Buffer.from(TOKEN) });
  const r = run(argv("sidecar", release(), ["--control-plane", CP, "--enroll-token-stdin"]), h).report;
  assert.equal(r.enrolled, "sc_7f3");
  const i = h.sys.calls.findIndex((c) => c.includes("enroll"));
  assert.equal(h.sys.opts[i].input.toString(), `${TOKEN}\n`);
  const big = host({ stdin: () => Buffer.alloc(4097, "a") });
  assert.throws(() => run(argv("sidecar", release(), ["--control-plane", CP, "--enroll-token-stdin"]), big), /stdin is larger than an enrollment token/);
  assert.deepEqual(big.sys.calls, []);
});

test("a token file that isn't a 0600 regular file of one vbx_enr_ token is refused before anything is written, and never shown", () => {
  const dir = tempDir("vbcdx-tok-");
  const link = join(dir, "link");
  symlinkSync(tokenFile(), link);
  const fifo = join(dir, "fifo");
  assert.equal(spawnSync("mkfifo", ["-m", "600", fifo]).status, 0, "mkfifo");
  const sub = join(dir, "sub");
  mkdirSync(sub, { mode: 0o700 });
  for (const [f, re] of [
    [tokenFile(0o644), /must be 0600 \(no group or other access\) and owned by you/], [tokenFile(0o640), /must be 0600/],
    [tokenFile(0o604), /must be 0600/], [tokenFile(0o606), /must be 0600/], [tokenFile(0o620), /must be 0600/],
    [link, /can't be opened \(ELOOP\); it must be a regular file, not a symlink/], [fifo, /must be a regular file\./], [sub, /must be a regular file\./],
    [tokenFile(0o600, "a".repeat(4097)), /is larger than an enrollment token/],
    [tokenFile(0o600, "kh_live_x\n"), /is not one vbx_enr_ token on one line/], [tokenFile(0o600, `${TOKEN}\n${TOKEN}\n`), /is not one vbx_enr_ token/],
    [tokenFile(0o600, `x${TOKEN}\n`), /is not one vbx_enr_ token/], [tokenFile(0o600, ""), /is not one vbx_enr_ token/]]) {
    const h = host();
    assert.throws(() => run(argv("sidecar", release(), ["--control-plane", CP, "--enroll-token-file", f]), h), (e) => {
      assert.match(e.message, re);
      assert.ok(!errorText(e).includes("CANARY") && !errorText(e).includes("kh_live_x"), "the value is never shown");
      return true;
    }, f);
    assert.deepEqual(h.sys.calls, [], "nothing ran");
    assert.ok(!existsSync(at(h, "/etc/vbcdx/default/sidecar.toml")));
  }
});

test("a 0600 token file owned by someone else is refused: only the installing user's own file is trusted", () => {
  const h = host();
  h.sys.euid = process.geteuid() + 1;
  assert.throws(() => run(argv("sidecar", release(), ["--control-plane", CP, "--enroll-token-file", tokenFile()]), h),
    /must be 0600 \(no group or other access\) and owned by you/);
  assert.deepEqual(h.sys.calls, []);
});

test("a refused enroll undoes the install: config, unit and record are taken back; exit 5 names a fresh token, not a bare --force", () => {
  const h = host({ enroll: () => ({ status: 5, stderr: "vbcdx-sidecar: this sidecar is already enrolled as sc_1; pass --force to enroll it again\n" }) });
  assert.throws(() => run(argv("sidecar", release(), ["--control-plane", CP, "--enroll-token-file", tokenFile()]), h), (e) => {
    assert.match(e.message, /^vbcdx-sidecar enroll exited 5; nothing was started\. An enrolled sidecar is refused: to replace its identity, /);
    // The remedy is executable: a fresh one-time token minted by an operator with the control plane's
    // own command (the installer's own vocabulary, as the no-token refusal at apply.js:175 uses), then
    // the sidecar's token input, with --force as the flag that replaces the identity.
    assert.match(e.message, /get a new one-time token from a control-plane operator/);
    assert.match(e.message, /vbcdx-control sidecars enroll-token/);
    // The remedy has to be executable by the reader the install addresses: root. The sidecar's state
    // directory belongs to the unit user, so a bare enroll as root fails its ownership check and
    // replaces nothing; the message names the runuser form the installer itself uses, with the token
    // on stdin (root's shell reads the file, the daemon reads stdin).
    assert.match(e.message, /then re-enroll with sudo runuser -u vbcdx -- \S*vbcdx-sidecar enroll --instance default --instance-dir \/etc\/vbcdx\/default --token-stdin --force < <token-file>/);
    assert.ok(!e.message.includes("--token-file <file>"), "the root-unusable --token-file form is gone");
    assert.match(e.message, /--token-stdin/);
    assert.match(e.message, /--force replaces the existing identity/);
    // Not the old bare invitation: the reader was told to run enroll --force with no token to pass.
    assert.ok(!e.message.includes("re-enroll it by hand with vbcdx-sidecar enroll --force"), e.message);
    assert.ok(!/\benroll --force\b/.test(e.message), e.message);
    assert.ok(!errorText(e).includes("CANARY"));
    return true;
  });
  assert.deepEqual(calls(h, "systemctl"), []);
  assert.ok(!existsSync(at(h, "/etc/vbcdx/default/sidecar.toml")));
  assert.ok(!existsSync(at(h, "/root/.vbcdx/manifests/installation.json")));
  assert.ok(!everything(h).includes("CANARY"));
  const other = host({ enroll: () => ({ status: 69, stderr: "vbcdx-sidecar: control plane unreachable\n" }) });
  assert.throws(() => run(argv("sidecar", release(), ["--control-plane", CP, "--enroll-token-stdin"]), other),
    /vbcdx-sidecar enroll exited 69; nothing was started\.$/);
});

test("a failing command's stderr reaches the error only through safeLine: no secret-shaped text is shown", () => {
  // A key=value secret and a long token-shaped run in the failing command's last stderr line.
  const long = "Z9".repeat(20);
  const said = `vbcdx-sidecar: refused: password=CANARYPW ${long}\n`;
  const hidden = (e) => {
    assert.ok(!errorText(e).includes("CANARYPW") && !errorText(e).includes(long), errorText(e));
    assert.ok(errorText(e).includes("password=[redacted]"), errorText(e));
    return true;
  };
  // The enroll step (the daemon's stderr right after it read the token on stdin).
  const refused = host({ enroll: () => ({ status: 69, stderr: said }) });
  assert.throws(() => run(argv("sidecar", release(), ["--control-plane", CP, "--enroll-token-file", tokenFile()]), refused), hidden);
  // A systemctl step (every unit command goes through the same check).
  const failing = host();
  const orig = failing.sys.run;
  failing.sys.run = (cmd, args, o) => (cmd === "systemctl" && args.includes("enable")
    ? (failing.sys.calls.push([cmd, ...args]), { status: 1, stdout: "", stderr: said })
    : orig(cmd, args, o));
  assert.throws(() => run(argv("sidecar", release(), ["--control-plane", CP, "--enroll-token-file", tokenFile()]), failing), hidden);
});

test("a failure after a successful enroll removes the new credentials and names the spent id to revoke", () => {
  const h = host({ failVerb: "enable" });
  assert.throws(() => run(argv("sidecar", release(), ["--control-plane", CP, "--enroll-token-file", tokenFile()]), h), (e) => {
    assert.match(e.message, /enabling vbcdx-sidecar-default\.service failed/);
    assert.match(e.message, /enrolled as sc_7f3 with a token that is now spent; its tunnel credentials were removed\. Revoke it on the control host \(vbcdx-control sidecars revoke sc_7f3 --yes\)/);
    assert.ok(e.details.lines.some((l) => l.includes("vbcdx-control sidecars revoke sc_7f3 --yes")));
    assert.ok(!errorText(e).includes("CANARY"));
    return true;
  });
  assert.ok(!existsSync(at(h, `${h.stateDir}/tunnel`)), "the credentials enroll wrote are gone");
  assert.ok(!existsSync(at(h, "/etc/vbcdx/default/sidecar.toml")));
  assert.ok(!existsSync(at(h, "/root/.vbcdx/manifests/installation.json")));
});

test("--control-plane with no token on an unenrolled sidecar is refused before the unit (it would crash-loop); --no-start or an enrolled one is fine", () => {
  const h = host();
  assert.throws(() => run(argv("sidecar", release(), ["--control-plane", CP]), h),
    /This sidecar is not enrolled with its control plane, so its unit would not start; nothing was started\. Pass --enroll-token-file or --enroll-token-stdin/);
  assert.deepEqual(calls(h, "systemctl"), []);
  assert.ok(!existsSync(at(h, "/etc/vbcdx/default/sidecar.toml")));
  const later = host();
  assert.equal(run(argv("sidecar", release(), ["--control-plane", CP, "--no-start"]), later).report.changed, true);
  assert.deepEqual(calls(later, "systemctl"), ["daemon-reload", "enable vbcdx-sidecar-default.service"]);
  const done = host({ enrolled: true });
  assert.equal(run(argv("sidecar", release(), ["--control-plane", CP]), done).report.changed, true);
});

// A refused install leaves the host as it found it: the user it created and every directory it
// made go again, so nothing is left that no record names and `remove` can't see.
const MADE = ["/usr/local/lib/vbcdx", "/var/lib/vbcdx", "/etc/vbcdx", "/etc/systemd/system/vbcdx-sidecar-default.service"];
test("the not-enrolled refusal on a fresh host takes back the user and every directory it made", () => {
  const h = host();
  assert.throws(() => run(argv("sidecar", release(), ["--control-plane", CP]), h), (e) => e.code === 2 && /not enrolled/.test(e.message));
  assert.deepEqual(calls(h, "useradd").length, 1, "the fixture really created the user first");
  assert.deepEqual(calls(h, "userdel"), ["vbcdx"], "the user this run created is deleted");
  assert.deepEqual(calls(h, "groupdel"), ["vbcdx"], "and its group (a no-op where userdel already took it)");
  for (const p of MADE) assert.ok(!existsSync(at(h, p)), `${p} is gone`);
  assert.deepEqual(run(["list", "services"], h).report.services, []);
  // And the documented way out then works on the same host.
  assert.equal(run(argv("sidecar", release(), ["--control-plane", CP, "--no-start"]), h).report.changed, true);
});

test("the not-enrolled refusal never takes a user or a directory that was there before", () => {
  const h = host({ accounts: { users: ["vbcdx"], groups: ["vbcdx"] } });
  // A co-hosted control plane's levels and a stale state root, already there. (This refusal stops
  // before the unit's parents: the enroll-then-fail test below covers an existing unit dir.)
  mkdirSync(at(h, "/usr/local/lib/vbcdx/control-plane"), { recursive: true });
  mkdirSync(at(h, "/var/lib/vbcdx"), { recursive: true });
  assert.throws(() => run(argv("sidecar", release(), ["--control-plane", CP]), h), /not enrolled/);
  assert.deepEqual(calls(h, "useradd"), []);
  assert.deepEqual(calls(h, "userdel"), [], "a user that was there before is kept");
  assert.deepEqual(calls(h, "groupdel"), []);
  assert.ok(h.acct.users.has("vbcdx") && h.acct.groups.has("vbcdx"));
  assert.ok(existsSync(at(h, "/usr/local/lib/vbcdx/control-plane")), "the other service's level is kept");
  assert.ok(existsSync(at(h, "/var/lib/vbcdx")), "a level that was there before is kept");
  for (const p of ["/usr/local/lib/vbcdx/sidecar", "/var/lib/vbcdx/default", "/etc/vbcdx"]) assert.ok(!existsSync(at(h, p)), `${p} (made by this run) is gone`);
});

test("a group named vbcdx but no user: useradd refuses (exit 9), and nothing is deleted", () => {
  const h = host({ accounts: { groups: ["vbcdx"] } });
  assert.throws(() => run(argv("sidecar", release(), ["--control-plane", CP]), h),
    (e) => e.code === 6 && /creating the vbcdx user failed \(useradd exited 9\)/.test(e.message));
  assert.deepEqual(calls(h, "userdel"), [], "no user was created, so none is deleted");
  assert.deepEqual(calls(h, "groupdel"), [], "the group that was there before is kept");
  assert.ok(h.acct.groups.has("vbcdx") && !h.acct.users.has("vbcdx"));
  for (const p of ["/usr/local/lib/vbcdx", "/var/lib/vbcdx", "/etc/vbcdx"]) assert.ok(!existsSync(at(h, p)), `${p} was never made`);
});

test("enrolled, then a later step fails: the tunnel goes first, so the state dirs, the dirs and the user all go", () => {
  const h = host({ failVerb: "enable" });
  // An empty unit dir already there: `enable` fails after ensureParents has passed it, so this pins
  // that a parent which existed is never recorded (and so never removed).
  mkdirSync(at(h, "/etc/systemd/system"), { recursive: true });
  assert.throws(() => run(argv("sidecar", release(), ["--control-plane", CP, "--enroll-token-file", tokenFile()]), h),
    (e) => /enabling/.test(e.message) && /enrolled as sc_7f3 with a token that is now spent/.test(e.message));
  assert.ok(calls(h, "runuser").some((c) => c.includes("enroll")), "the fixture really enrolled (tunnel/ was written)");
  for (const p of ["/var/lib/vbcdx", "/etc/vbcdx", "/usr/local/lib/vbcdx"]) assert.ok(!existsSync(at(h, p)), `${p} is gone`);
  assert.deepEqual(calls(h, "userdel"), ["vbcdx"], "the user goes once, after its directories");
  assert.ok(!h.acct.users.has("vbcdx") && !h.acct.groups.has("vbcdx"));
  assert.ok(existsSync(at(h, "/etc/systemd/system")), "the unit dir that was there before is kept");
});

test("removing the tunnel credentials throws: the undo still runs, and the error stays the one that stopped the install", () => {
  const h = host({ failVerb: "enable" });
  const tunnel = `${h.stateDir}/tunnel`;
  const path = h.sys.path;
  h.sys.path = (p) => {
    if (p === tunnel) throw Object.assign(new Error("EBUSY: tunnel in use"), { code: "EBUSY" });
    return path(p);
  };
  assert.throws(() => run(argv("sidecar", release(), ["--control-plane", CP, "--enroll-token-file", tokenFile()]), h), (e) => {
    assert.match(e.message, /^enabling vbcdx-sidecar-default\.service failed/, "the error is still the one that stopped the install");
    assert.match(e.message, new RegExp(`removing its tunnel credentials failed: remove ${tunnel} by hand`));
    assert.doesNotMatch(e.message, /EBUSY|credentials were removed/);
    assert.match(e.message, /The vbcdx user this install created was kept, so they stay owned by it: after removing them, run userdel vbcdx\./);
    assert.ok(e.details.lines.some((l) => /user this install created was kept/.test(l)), "the lines carry it too");
    return true;
  });
  assert.ok(existsSync(path(tunnel)), "the fixture really left the tunnel in place");
  for (const p of ["/etc/vbcdx", "/usr/local/lib/vbcdx"]) assert.ok(!existsSync(path(p)), `${p} is gone: the undo ran`);
  // The credentials stay, so the user that owns them stays: never a uid a later useradd could reuse.
  assert.deepEqual(calls(h, "userdel"), []);
  assert.deepEqual(calls(h, "groupdel"), []);
  assert.ok(h.acct.users.has("vbcdx") && h.acct.groups.has("vbcdx"));
  assert.ok(existsSync(path(h.stateDir)), "the state dir holding them stays too");
});

test("the tunnel removal is tried once: a failure that would pass on a retry is still reported as it happened", () => {
  const h = host({ failVerb: "enable" });
  const tunnel = `${h.stateDir}/tunnel`;
  const path = h.sys.path;
  let thrown = 0;
  h.sys.path = (p) => {
    if (p === tunnel && thrown++ === 0) throw Object.assign(new Error("EBUSY: tunnel in use"), { code: "EBUSY" });
    return path(p);
  };
  assert.throws(() => run(argv("sidecar", release(), ["--control-plane", CP, "--enroll-token-file", tokenFile()]), h), (e) => {
    assert.match(e.message, /removing its tunnel credentials failed/, "the message matches what was done: the user was kept for it");
    assert.match(e.message, /user this install created was kept/);
    return true;
  });
  assert.equal(thrown, 1, "one attempt, not a second one after the undo");
  assert.ok(existsSync(path(tunnel)) && h.acct.users.has("vbcdx"), "credentials and their owner, as the message says");
});

test("removing the tunnel throws for a user that was there before: kept as always, and not named as this install's", () => {
  const h = host({ failVerb: "enable", accounts: { users: ["vbcdx"], groups: ["vbcdx"] } });
  const tunnel = `${h.stateDir}/tunnel`;
  const path = h.sys.path;
  h.sys.path = (p) => {
    if (p === tunnel) throw Object.assign(new Error("EBUSY: tunnel in use"), { code: "EBUSY" });
    return path(p);
  };
  assert.throws(() => run(argv("sidecar", release(), ["--control-plane", CP, "--enroll-token-file", tokenFile()]), h), (e) => {
    assert.match(e.message, /removing its tunnel credentials failed/);
    assert.doesNotMatch(e.message, /user this install created was kept/);
    return true;
  });
  assert.deepEqual(calls(h, "useradd"), []);
  assert.deepEqual(calls(h, "userdel"), []);
});

test("an enrolled sidecar whose upgrade fails keeps its tunnel credentials and its user", () => {
  const h = host({ enrolled: true });
  run(argv("sidecar", release("0.1.0"), ["--control-plane", CP]), h);
  const key = at(h, `${h.stateDir}/tunnel/client.key`);
  mkdirSync(dirname(key), { recursive: true });
  writeFileSync(key, "live credential");
  const healthy = h.sys.run;
  h.sys.run = (cmd, args, o) => (cmd === "systemctl" && args.includes("restart")
    ? (h.sys.calls.push([cmd, ...args]), { status: 1, stdout: "", stderr: "restart failed\n" }) : healthy(cmd, args, o));
  assert.throws(() => run(argv("sidecar", release("0.2.0"), ["--control-plane", CP]), h), /restarting/);
  assert.equal(readFileSync(key, "utf8"), "live credential", "no enroll in this run, so its tunnel is untouched");
  assert.deepEqual(calls(h, "userdel"), [], "the user from the first install stays");
  assert.ok(h.acct.users.has("vbcdx"));
});

test("the rollback removes only empty directories (sidecar): one holding something this run didn't write stays", () => {
  const foreign = "/var/lib/vbcdx/default/not-from-this-run";
  const h = host();
  // The daemon's check runs after the directories exist: whatever lands in one meanwhile is not this run's.
  h.sys.run = ((orig) => (cmd, args, o) => (args.includes("check")
    ? (h.sys.calls.push([cmd, ...args]), writeFileSync(at(h, foreign), "x"), { status: 2, stdout: "", stderr: "vbcdx-sidecar: refused\n" })
    : orig(cmd, args, o)))(h.sys.run);
  assert.throws(() => run(argv("sidecar", release()), h), /refuses the config/);
  assert.equal(readFileSync(at(h, foreign), "utf8"), "x");
  assert.ok(existsSync(at(h, "/var/lib/vbcdx/default")) && existsSync(at(h, "/var/lib/vbcdx")), "its directory and that one's parent stay");
  for (const p of ["/etc/vbcdx", "/usr/local/lib/vbcdx"]) assert.ok(!existsSync(at(h, p)), `${p} (empty, made by this run) is gone`);
});

test("a reinstall that changes control_plane on a running sidecar restarts it (only run starts the tunnel)", () => {
  const h = host({ enrolled: true });
  const rel = release();
  run(argv("sidecar", rel, ["--control-plane", CP]), h);
  const before = h.sys.calls.length;
  run(argv("sidecar", rel, ["--control-plane", CP2]), h);
  assert.ok(lifecycle(h).slice(-3).includes("restart vbcdx-sidecar-default.service"),
    JSON.stringify(h.sys.calls.slice(before)));
  // Unchanged config, no token: a no-op, no restart.
  const n = h.sys.calls.length;
  run(argv("sidecar", rel, ["--control-plane", CP2]), h);
  assert.equal(h.sys.calls.length, n);
});

test("a re-run with an unchanged config and a token enrolls only, then restarts the unit; a failed restart removes the credentials", () => {
  const h = host();
  const rel = release();
  run(argv("sidecar", rel, ["--control-plane", CP, "--no-start"]), h);
  const before = h.sys.calls.length;
  const r = run(argv("sidecar", rel, ["--control-plane", CP, "--enroll-token-file", tokenFile()]), h).report;
  assert.deepEqual([r.changed, r.enrolled], [true, "sc_7f3"]);
  assert.ok(waitedAfter(h, "restart vbcdx-sidecar-default.service"), "the restart is waited on too");
  assert.deepEqual(h.sys.calls.slice(before).filter((c) => !isPoll(c)).map((c) => (c.includes("enroll") ? "enroll" : c.join(" "))),
    ["enroll", "systemctl restart vbcdx-sidecar-default.service"]);
  const bad = host({ failVerb: "restart" });
  run(argv("sidecar", rel, ["--control-plane", CP, "--no-start"]), bad);
  assert.throws(() => run(argv("sidecar", rel, ["--control-plane", CP, "--enroll-token-file", tokenFile()]), bad),
    /restarting vbcdx-sidecar-default\.service failed.*Revoke it on the control host \(vbcdx-control sidecars revoke sc_7f3 --yes\)/);
  assert.ok(!existsSync(at(bad, `${bad.stateDir}/tunnel`)));
});

test("a token run over an edited config (nothing else to change) enrolls, keeps the edit, and says it was kept", () => {
  const h = host();
  const rel = release();
  run(argv("sidecar", rel, ["--control-plane", CP, "--no-start"]), h);
  const conf = at(h, "/etc/vbcdx/default/sidecar.toml");
  writeFileSync(conf, readFileSync(conf, "utf8") + "# local edit\n");
  const edited = readFileSync(conf);
  const r = run(argv("sidecar", rel, ["--control-plane", CP, "--enroll-token-file", tokenFile()]), h).report;
  assert.deepEqual([r.write, r.enrolled], [false, "sc_7f3"], "the already-in-place path: enroll only");
  assert.deepEqual(r.kept, ["/etc/vbcdx/default/sidecar.toml"]);
  assert.deepEqual(readFileSync(conf), edited);
});

test("a token-only run whose restart doesn't stay up: the enroll's error (revoke the id), credentials removed, exit 6", () => {
  const h = host();
  const rel = release();
  run(argv("sidecar", rel, ["--control-plane", CP, "--no-start"]), h);
  // From now on the unit fails right after it starts: the restart's wait must catch it.
  h.sys.run = ((orig) => (cmd, args, o) => (cmd === "systemctl" && args.includes("is-active")
    ? (h.sys.calls.push([cmd, ...args]), { status: 0, stdout: "failed\n", stderr: "" }) : orig(cmd, args, o)))(h.sys.run);
  const unit = at(h, "/etc/systemd/system/vbcdx-sidecar-default.service");
  const unitBefore = readFileSync(unit);
  const mark = h.sys.calls.length;
  assert.throws(() => run(argv("sidecar", rel, ["--control-plane", CP, "--enroll-token-file", tokenFile()]), h),
    (e) => e.code === 6 && /did not start/.test(e.message) && /Revoke it on the control host \(vbcdx-control sidecars revoke sc_7f3 --yes\)/.test(e.message));
  assert.ok(!existsSync(at(h, `${h.stateDir}/tunnel`)), "the tunnel credentials this run wrote are gone");
  // The token-only path writes no unit or config, so it has
  // nothing to daemon-reload or put back. Its one systemctl call is the restart (then the wait's
  // polls): never a disable, and the unit is as it was.
  const ctl = h.sys.calls.slice(mark).filter((c) => c[0] === "systemctl" && !isPoll(c)).map((c) => c.slice(1).join(" "));
  assert.deepEqual(ctl, ["restart vbcdx-sidecar-default.service"], ctl.join(", "));
  assert.ok(h.sys.calls.slice(mark).findLastIndex((c) => c[0] === "systemctl" && !isPoll(c))
    > h.sys.calls.slice(mark).findIndex((c) => c.includes("enroll")), "the restart comes after the enroll");
  assert.deepEqual(readFileSync(unit), unitBefore, "the unit file is untouched");
});

test("a repair run with a token (config unchanged, a recorded file missing) restarts the running unit after the enroll", () => {
  const h = host();
  const rel = release();
  run(argv("sidecar", rel, ["--control-plane", CP, "--no-start"]), h);
  // A recorded file deleted by hand: not "already in place", but the config is unchanged.
  writeFileSync(at(h, "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-svc"), "damaged");
  const before = h.sys.calls.length;
  const r = run(argv("sidecar", rel, ["--control-plane", CP, "--enroll-token-file", tokenFile()]), h).report;
  assert.deepEqual([r.changed, r.enrolled], [true, "sc_7f3"]);
  assert.ok(calls(h, "systemctl").includes("restart vbcdx-sidecar-default.service"), JSON.stringify(h.sys.calls.slice(before)));
});

test("a user install enrolls and dials as the user itself, with no runuser", () => {
  const h = host({ uid: 1000 });
  const r = run(argv("sidecar", release(), ["--control-plane", CP, "--enroll-token-file", tokenFile()]), h).report;
  assert.equal(r.enrolled, "sc_7f3");
  const bin = at(h, "/home/u/.vbcdx/lib/sidecar/0.1.0/vbcdx-sidecar");
  assert.ok(h.sys.calls.some((c) => c[0] === bin && c.includes("enroll")));
  assert.deepEqual(calls(h, "runuser"), []);
  run(["doctor", "--service", "sidecar"], h);
  assert.ok(h.sys.calls.some((c) => c[0] === bin && c.includes("--dial")));
  // The live check too, run as the user itself (the runuser list stays empty below).
  assert.ok(h.sys.calls.some((c) => c[0] === bin && c[1] === "check" && c[2] === "--live"), "check --live is run as the user");
  assert.deepEqual(calls(h, "runuser"), []);
});

test("doctor dials as vbcdx and reads the dial result from check --dial's summary; a failed or empty dial fails doctor", () => {
  const h = host({ enrolled: true });
  run(argv("sidecar", release(), ["--control-plane", CP]), h);
  const report = run(["doctor", "--service", "sidecar"], h).report;
  const dial = report.checks.find((c) => c.check === "control plane tunnel (check --dial)");
  assert.deepEqual([dial.ok, dial.detail], [true, "reached as sidecar sc_7f3"]);
  assert.ok(calls(h, "runuser").includes(`-u vbcdx -- ${BIN(h)} check --dial --instance default --instance-dir /etc/vbcdx/default`));
  for (const [answer, want] of [
    [() => ({ status: 69, stderr: "vbcdx-sidecar: tunnel: connection refused\n" }), "vbcdx-sidecar: tunnel: connection refused"],
    [() => line(summary({ enrolled: true })), "check --dial exited 0 with no dial result"],
    [() => line(summary({ enrolled: true, dial: { ok: false, sidecar_id: "sc_7f3" } })), "check --dial exited 0 with no dial result"],
    [() => ({ stdout: "sc_7f3\n" }), "check --dial exited 0 with no dial result"]]) {
    const bad = host({ enrolled: true, dial: answer });
    run(argv("sidecar", release(), ["--control-plane", CP]), bad);
    const r = run(["doctor", "--service", "sidecar"], bad);
    assert.equal(r.code, 5);
    assert.deepEqual(r.report.checks.filter((c) => c.check === "control plane tunnel (check --dial)").map((c) => [c.ok, c.detail]), [[false, want]]);
  }
  // No control plane, or a config edited by hand since install: no dial.
  const none = host();
  run(argv("sidecar", release()), none);
  run(["doctor", "--service", "sidecar"], none);
  assert.ok(!none.sys.calls.some((c) => c.includes("--dial")));
  const edited = host({ enrolled: true });
  run(argv("sidecar", release(), ["--control-plane", CP]), edited);
  writeFileSync(at(edited, "/etc/vbcdx/default/sidecar.toml"), `control_plane = "${CP2}"\n`);
  run(["doctor", "--service", "sidecar"], edited);
  assert.ok(!edited.sys.calls.some((c) => c.includes("--dial")), "an edited config is not the one install wrote: no dial");
});

test("doctor asks the running daemon with check --live: the live id must be the one on disk", () => {
  const h = host({ enrolled: true });
  run(argv("sidecar", release(), ["--control-plane", CP]), h);
  const report = run(["doctor", "--service", "sidecar"], h).report;
  const live = report.checks.find((c) => c.check === "control plane tunnel (daemon, check --live)");
  assert.deepEqual([live.ok, live.detail], [true, "the running daemon is connected as sidecar sc_7f3"]);
  assert.ok(calls(h, "runuser").includes(`-u vbcdx -- ${BIN(h)} check --live --instance default --instance-dir /etc/vbcdx/default`));
  for (const [answer, want, ok] of [
    // Old id in memory, new id on disk: exit 10 fails doctor.
    [() => ({ status: 10, stderr: "vbcdx-sidecar: the running daemon is connected as sidecar sc_old, but the credential on disk is sc_7f3: it reconnects within a few seconds; if not, run `systemctl reload` on its unit\n" }),
      "vbcdx-sidecar: the running daemon is connected as sidecar sc_old, but the credential on disk is sc_7f3: it reconnects within a few seconds; if not, run `systemctl reload` on its unit", false],
    [() => ({ status: 9, stderr: "vbcdx-sidecar: the running daemon's tunnel is down (3 failed attempts): refused\n" }),
      "vbcdx-sidecar: the running daemon's tunnel is down (3 failed attempts): refused", false],
    [() => line(summary({ enrolled: true })), "check --live exited 0 with no live result", false],
    [() => line(summary({ enrolled: true, live: { ok: false, sidecar_id: "sc_7f3" } })), "check --live exited 0 with no live result", false],
    // An older sidecar without check --live: not checked, and said so.
    [() => ({ status: 2, stderr: "vbcdx-sidecar: unknown argument; usage: vbcdx-sidecar run|check [--dial] ...\n" }),
      "not checked: this vbcdx-sidecar is older than check --live", true],
    // Exit 0 and ok, but another id than the dial's (the disk's): the doctor's own compare fails it.
    [() => line(summary({ enrolled: true, live: { ok: true, sidecar_id: "sc_other" } })),
      "the running daemon is connected as sidecar sc_other, but the credential on disk dials as sc_7f3", false],
    // ok with no id is no live result.
    [() => line(summary({ enrolled: true, live: { ok: true } })), "check --live exited 0 with no live result", false],
    // "unknown argument" in an earlier stderr line, not the failure line, is no old binary.
    [() => ({ status: 2, stderr: "note: unknown argument seen upstream\nvbcdx-sidecar: --instance needs a name\n" }),
      "vbcdx-sidecar: --instance needs a name", false],
    // A non-zero exit fails even if stdout carries an ok summary.
    [() => ({ ...line(summary({ enrolled: true, live: { ok: true, sidecar_id: "sc_7f3" } })), status: 10, stderr: "vbcdx-sidecar: connected as another id\n" }),
      "vbcdx-sidecar: connected as another id", false],
    // "unknown argument" counts as an old binary only with its usage exit (2).
    [() => ({ status: 1, stderr: "vbcdx-sidecar: unknown argument in the control plane's reply\n" }),
      "vbcdx-sidecar: unknown argument in the control plane's reply", false],
    // A usage error for another reason is not mistaken for an old binary.
    [() => ({ status: 2, stderr: "vbcdx-sidecar: --instance needs a name\n" }), "vbcdx-sidecar: --instance needs a name", false]]) {
    const bad = host({ enrolled: true, live: answer });
    run(argv("sidecar", release(), ["--control-plane", CP]), bad);
    // The fake host has no real sockets, so doctor's exit is 5 whatever this check says; the
    // check's own verdict is what's asserted.
    const r = run(["doctor", "--service", "sidecar"], bad);
    assert.deepEqual(r.report.checks.filter((c) => c.check === "control plane tunnel (daemon, check --live)").map((c) => [c.ok, c.detail]), [[ok, want]]);
  }
  // No control plane: no live check either.
  const none = host();
  run(argv("sidecar", release()), none);
  run(["doctor", "--service", "sidecar"], none);
  assert.ok(!none.sys.calls.some((c) => c.includes("--live")));
});

// An upgrade keeps the sidecar's control plane (carry.js, from the installed sidecar.toml): the
// documented `install service sidecar --version <new>` must never unlink it.
const SIDECAR_CONF = "/etc/vbcdx/default/sidecar.toml";
const SIDECAR_UNIT = "/etc/systemd/system/vbcdx-sidecar-default.service";
test("an upgrade with nothing but the new version keeps the control plane: config and unit unchanged but for the version", () => {
  const h = host({ enrolled: true }); // an enrolled sidecar, as in the field report
  run(argv("sidecar", release(), ["--control-plane", CP, "--no-start"]), h);
  const conf = readFileSync(at(h, SIDECAR_CONF), "utf8");
  const unit = readFileSync(at(h, SIDECAR_UNIT), "utf8");
  const r = run(argv("sidecar", release("0.2.0")), h).report;
  assert.equal(r.upgraded_from, "0.1.0");
  assert.equal(tomlParse(readFileSync(at(h, SIDECAR_CONF), "utf8")).control_plane, CP);
  assert.equal(readFileSync(at(h, SIDECAR_CONF), "utf8"), conf, "the config is byte-identical");
  assert.equal(readFileSync(at(h, SIDECAR_UNIT), "utf8"), unit.replaceAll("/sidecar/0.1.0/", "/sidecar/0.2.0/"), "the unit differs only in the version path");
  assert.notEqual(unit.indexOf("/sidecar/0.1.0/"), -1, "the replace above changed something");
});

test("a given --control-plane overrides it; --no-control-plane clears it; the dry run names the one it keeps", () => {
  const h = host({ enrolled: true }); // an enrolled sidecar, as in the field report
  run(argv("sidecar", release(), ["--control-plane", CP, "--no-start"]), h);
  const dry = run(argv("sidecar", release("0.2.0"), ["--dry-run"]), h);
  assert.deepEqual(dry.report.carried, [{ setting: "control_plane", value: CP, from: SIDECAR_CONF }]);
  assert.match(humanPlan(dry.report), new RegExp(`^ {2}keep control_plane ${CP.replace(/[.?+]/g, "\\$&")} \\(from the installed ${SIDECAR_CONF}\\)$`, "m"));
  run(argv("sidecar", release("0.2.0"), ["--control-plane", CP2]), h);
  assert.equal(tomlParse(readFileSync(at(h, SIDECAR_CONF), "utf8")).control_plane, CP2);
  const cleared = run(argv("sidecar", release("0.3.0"), ["--no-control-plane", "--dry-run"]), h);
  assert.match(humanPlan(cleared.report), new RegExp(`^ {6}-control_plane = "${CP2.replace(/[.?+]/g, "\\$&")}"$`, "m"), "the diff shows the line going");
  run(argv("sidecar", release("0.3.0"), ["--no-control-plane"]), h);
  assert.equal(tomlParse(readFileSync(at(h, SIDECAR_CONF), "utf8")).control_plane, undefined);
  // Cleared, it stays cleared: nothing to carry.
  run(argv("sidecar", release("0.4.0")), h);
  assert.equal(tomlParse(readFileSync(at(h, SIDECAR_CONF), "utf8")).control_plane, undefined);
});

test("an installed config that can't be read refuses the upgrade (exit 5, nothing changed) unless the setting is given", () => {
  for (const damage of [(p) => writeFileSync(p, "control_plane = [unterminated\n"), (p) => rmSync(p)]) {
    const h = host({ enrolled: true }); // an enrolled sidecar, as in the field report
    run(argv("sidecar", release(), ["--control-plane", CP, "--no-start"]), h);
    damage(at(h, SIDECAR_CONF));
    assert.throws(() => run(argv("sidecar", release("0.2.0")), h),
      (e) => e.code === 5 && e.details.refused === "carry-over" && e.message.includes(SIDECAR_CONF) && /--no-control-plane/.test(e.message));
    assert.ok(!existsSync(at(h, "/usr/local/lib/vbcdx/sidecar/0.2.0")), "nothing written");
    // Given again, nothing needs carrying: the install goes ahead.
    assert.doesNotThrow(() => run(argv("sidecar", release("0.2.0"), ["--control-plane", CP, "--force"]), h));
  }
});

test("a control_plane that isn't a string, or a sidecar.toml that is a symlink, refuses the upgrade (exit 5) instead of dropping it", () => {
  const h = host({ enrolled: true }); // an enrolled sidecar, as in the field report
  run(argv("sidecar", release(), ["--control-plane", CP, "--no-start"]), h);
  const conf = readFileSync(at(h, SIDECAR_CONF), "utf8");
  writeFileSync(at(h, SIDECAR_CONF), conf.replace(/^control_plane = .*$/m, 'control_plane = ["not", "a", "string"]'));
  assert.throws(() => run(argv("sidecar", release("0.2.0")), h), (e) => e.code === 5 && e.details.refused === "carry-over" && /not a string/.test(e.message));
  // A symlink to a well-formed copy: never followed (the carry reads regular files only).
  writeFileSync(at(h, "/etc/vbcdx/elsewhere.toml"), conf);
  rmSync(at(h, SIDECAR_CONF));
  symlinkSync(at(h, "/etc/vbcdx/elsewhere.toml"), at(h, SIDECAR_CONF));
  assert.throws(() => run(argv("sidecar", release("0.2.0")), h), (e) => e.code === 5 && e.details.refused === "carry-over" && /ENOTREG/.test(e.message));
  assert.ok(!existsSync(at(h, "/usr/local/lib/vbcdx/sidecar/0.2.0")), "nothing written");
});
