// A non-root member of group vbcdx reaches the system sidecar through
// `vbcdx config service …`. A system install writes a public record (0640 root:vbcdx, in the
// instance's 0750 root:vbcdx config dir) naming the installed vbcdx-svc and its sha256; a
// non-root caller with no sidecar of its own runs that binary after the same hash check root
// gets. Every way the public record can be untrustworthy is refused before anything runs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { keypair, signFile } from "./helpers/minisign-signer.js";
import { tempDir } from "./helpers/temp-dir.js";
import { fakeAccounts } from "./helpers/fake-accounts.js";
import { runService } from "../src/service/index.js";
import { validateRecord } from "../src/service/apply.js";
import { parseServiceArgs } from "../src/service/args.js";
import { fakeSystem, realSystem } from "../src/service/system.js";
import { EXIT } from "../src/errors.js";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const KEY = keypair(7);
const PUB = "/etc/vbcdx/default/install.json";
const SYS_SVC = (v = "0.1.0") => `/usr/local/lib/vbcdx/sidecar/${v}/vbcdx-svc`;
const body = (name, version) => Buffer.from(`#!/bin/sh\n# ${name} ${version}\n`);

function release(version = "0.1.0", names = ["vbcdx-sidecar", "vbcdx-svc"]) {
  const root = tempDir("vbcdx-rel-");
  const files = {};
  for (const name of names) {
    const rel = `@vbcdx/sidecar-linux-x64-gnu/bin/${name}`;
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), body(name, version), { mode: 0o755 });
    files[rel] = sha(body(name, version));
  }
  const sums = Buffer.from(JSON.stringify({ schema: 1, package: "@vbcdx/sidecar", version, files }));
  writeFileSync(join(root, "checksums.json"), sums);
  writeFileSync(join(root, "checksums.json.minisig"), signFile(KEY, sums, `vbcdx-release @vbcdx/sidecar ${version}`));
  return root;
}

// One fake host (a temp root): root installs there; `as(h, 1000)` is a non-root user on the same
// host, with its own home and none of root's.
function host() {
  const root = tempDir("vbcdx-host-");
  const acct = fakeAccounts({ gid: process.getgid() });
  const sys = fakeSystem(root, { uid: 0, answer: (cmd, args) => acct.answer(cmd, args) || (cmd === "systemctl" && args.includes("is-active") ? { stdout: "active\n" } : {}) });
  return { root, sys, deps: { sys, trustedKeys: [KEY.pub], platformId: "linux-x64-gnu", host: { uid: 0, home: "/root", runtimeDir: null } } };
}
function as(h, uid, { rootUid } = {}) {
  const sys = { ...h.sys, uid, ...(rootUid === undefined ? {} : { rootUid }) };
  return { ...h, sys, deps: { ...h.deps, sys, host: { uid, home: "/home/u", runtimeDir: "/run/user/1000" } } };
}
const run = (argv, h) => runService(parseServiceArgs(argv), h.deps);
const at = (h, p) => join(h.root, p);
const WHOAMI = ["config", "service", "sidecar", "auth", "whoami"];
const ranSvc = (h) => h.sys.calls.some((c) => c[0].endsWith("/vbcdx-svc"));
const systemInstall = (version = "0.1.0") => {
  const h = host();
  run(["install", "service", "sidecar", "--from", release(version)], h);
  return h;
};
const recordOf = (h, home = "/root") => JSON.parse(readFileSync(at(h, `${home}/.vbcdx/manifests/installation.json`), "utf8"));

test("a system install writes the public record: 0640, beside the config, naming the installed vbcdx-svc and its sha256", () => {
  const h = systemInstall();
  const st = statSync(at(h, PUB));
  assert.equal(st.mode & 0o777, 0o640);
  assert.deepEqual(JSON.parse(readFileSync(at(h, PUB), "utf8")), {
    schema: 1, service: "sidecar", instance: "default", version: "0.1.0",
    vbcdx_svc: { path: SYS_SVC(), sha256: sha(body("vbcdx-svc", "0.1.0")) },
  });
  const rec = recordOf(h).services["sidecar:default"];
  assert.equal(rec.files.length, 2);
  assert.equal(rec.files[0].path, "/etc/vbcdx/default/sidecar.toml", "files[0] stays the config");
  assert.deepEqual(rec.files[1], { path: PUB, sha256: sha(readFileSync(at(h, PUB))) });
  assert.ok(h.sys.calls.some((c) => c[0] === "chown" && c[1] === "root:vbcdx" && c[2] === at(h, PUB)), "chowned root:vbcdx");
  // doctor checks it like the config; remove takes it out.
  const doc = run(["doctor", "--service", "sidecar"], h).report;
  assert.ok(doc.checks.some((c) => c.check === `file ${PUB}` && c.ok), "doctor checks the public record");
  writeFileSync(at(h, PUB), readFileSync(at(h, PUB), "utf8").replace("0.1.0\"", "0.1.0\" "));
  assert.ok(run(["doctor", "--service", "sidecar"], h).report.checks.some((c) => c.check === `file ${PUB}` && !c.ok), "an edited one fails doctor");
});

test("remove takes the public record out with the rest", () => {
  const h = systemInstall();
  run(["remove", "service", "sidecar"], h);
  assert.equal(existsSync(at(h, PUB)), false);
});

test("a user install writes no public record", () => {
  const h = host();
  const u = as(h, 1000);
  run(["install", "service", "sidecar", "--from", release()], u);
  assert.equal(recordOf(u, "/home/u").services["sidecar:default"].files.length, 1);
  assert.equal(existsSync(at(h, PUB)), false);
});

test("an upgrade rewrites it for the new version; a same-version reinstall adds it to a record from 0.2.3", () => {
  const h = systemInstall("0.1.0");
  run(["install", "service", "sidecar", "--from", release("0.2.0")], h);
  const pub = JSON.parse(readFileSync(at(h, PUB), "utf8"));
  assert.equal(pub.version, "0.2.0");
  assert.equal(pub.vbcdx_svc.path, SYS_SVC("0.2.0"));
  // A record as installer 0.2.3 left it: the config only, no public record on disk.
  const f = at(h, "/root/.vbcdx/manifests/installation.json");
  const r = JSON.parse(readFileSync(f, "utf8"));
  r.services["sidecar:default"].files = r.services["sidecar:default"].files.slice(0, 1);
  writeFileSync(f, JSON.stringify(r));
  unlinkSync(at(h, PUB));
  const again = run(["install", "service", "sidecar", "--from", release("0.2.0")], h).report;
  assert.equal(again.changed, true, "not 'already in place' without the public record");
  assert.equal(existsSync(at(h, PUB)), true);
  assert.equal(recordOf(h).services["sidecar:default"].files.length, 2);
});

test("a non-root caller with no sidecar of its own runs the system vbcdx-svc, after the same hash check", () => {
  const h = systemInstall();
  const u = as(h, 1000);
  run(WHOAMI, u);
  assert.deepEqual(u.sys.calls.at(-1), [at(h, SYS_SVC()), "sidecar", "auth", "whoami"]);
  assert.equal(u.sys.opts.at(-1).inherit, true);
  writeFileSync(at(h, SYS_SVC()), "#!/bin/sh\necho swapped\n");
  const n = u.sys.calls.length;
  assert.throws(() => run(WHOAMI, u), (e) => e.code === 5 && /does not match/.test(e.message));
  assert.equal(u.sys.calls.length, n, "a swapped binary never runs");
});

test("--instance picks the system instance's own public record", () => {
  const h = host();
  run(["install", "service", "sidecar", "--from", release(), "--instance", "two"], h);
  const u = as(h, 1000);
  run(["config", "service", "sidecar", "--instance", "two", "auth", "whoami"], u);
  assert.equal(u.sys.calls.at(-1)[0], at(h, SYS_SVC()));
  assert.throws(() => run(WHOAMI, u), (e) => e.code === 2 && /No sidecar instance "default" is installed for you/.test(e.message));
});

test("root with no record is still told to install: no public-record fallback for root", () => {
  const h = host();
  mkdirSync(at(h, "/etc/vbcdx/default"), { recursive: true });
  assert.throws(() => run(WHOAMI, h), (e) => e.code === 2 && /is installed: vbcdx install service sidecar\./.test(e.message) && !/for you/.test(e.message));
});

test("a non-root caller with its own user install uses its own, not the system one", () => {
  const h = systemInstall();
  const u = as(h, 1000);
  run(["install", "service", "sidecar", "--from", release()], u);
  run(WHOAMI, u);
  assert.equal(u.sys.calls.at(-1)[0], at(h, "/home/u/.vbcdx/lib/sidecar/0.1.0/vbcdx-svc"));
});

// Each row breaks one thing about the public record (or the directories above it); a non-root
// `config service` must refuse with that reason, and run nothing.
const rewrite = (h, fn) => {
  const p = at(h, PUB);
  const j = JSON.parse(readFileSync(p, "utf8"));
  writeFileSync(p, typeof fn === "function" ? JSON.stringify(fn(j)) : fn);
  chmodSync(p, 0o640);
};
const REFUSALS = [
  ["no public record (a 0.2.3 system install)", (h) => unlinkSync(at(h, PUB)), EXIT.CONFIG, /installer 0\.2\.3 or older wrote none/],
  ["no system install at all", (h) => null, EXIT.CONFIG, /no system sidecar instance is installed either/, { fresh: true }],
  ["a symlink to a planted file", (h) => {
    writeFileSync(at(h, "/tmp-planted.json"), readFileSync(at(h, PUB)));
    unlinkSync(at(h, PUB));
    symlinkSync(at(h, "/tmp-planted.json"), at(h, PUB));
  }, EXIT.FILESYSTEM, /is a symlink/],
  ["group-writable", (h) => chmodSync(at(h, PUB), 0o660), EXIT.FILESYSTEM, /writable by group or other/],
  ["other-writable", (h) => chmodSync(at(h, PUB), 0o642), EXIT.FILESYSTEM, /writable by group or other/],
  ["under directories that aren't root's", (h) => null, EXIT.FILESYSTEM, /^\/etc\/vbcdx is not a root-owned directory/, { rootUid: process.geteuid() + 1 }],
  ["its config dir group-writable", (h) => chmodSync(at(h, "/etc/vbcdx/default"), 0o770), EXIT.FILESYSTEM, /not a root-owned directory/],
  ["/etc/vbcdx other-writable", (h) => chmodSync(at(h, "/etc/vbcdx"), 0o757), EXIT.FILESYSTEM, /not a root-owned directory/],
  ["under a symlinked instance directory", (h) => {
    // Same contents and modes, root's: only lstat (not stat) tells it is a symlink.
    mkdirSync(at(h, "/elsewhere"));
    renameSync(at(h, "/etc/vbcdx/default"), at(h, "/elsewhere/default"));
    symlinkSync(at(h, "/elsewhere/default"), at(h, "/etc/vbcdx/default"));
  }, EXIT.FILESYSTEM, /^\/etc\/vbcdx\/default is not a root-owned directory/],
  ["a FIFO", (h) => {
    unlinkSync(at(h, PUB));
    assert.equal(spawnSync("mkfifo", ["-m", "0640", at(h, PUB)]).status, 0, "mkfifo");
  }, EXIT.FILESYSTEM, /not a regular file/],
  ["under a path whose /etc is a file (ENOTDIR)", (h) => {
    renameSync(at(h, "/etc"), at(h, "/etc-moved"));
    writeFileSync(at(h, "/etc"), "");
  }, EXIT.FILESYSTEM, /^\/etc\/vbcdx can't be read \(ENOTDIR\)/],
  ["a directory, not a file", (h) => {
    unlinkSync(at(h, PUB));
    mkdirSync(at(h, PUB));
  }, EXIT.FILESYSTEM, /not a regular file/],
  ["a vbcdx-svc path outside the version dir", (h) => rewrite(h, (j) => ({ ...j, vbcdx_svc: { ...j.vbcdx_svc, path: "/tmp/evil/vbcdx-svc" } })), EXIT.FILESYSTEM, /unexpected contents/],
  ["a path for another version than it names", (h) => rewrite(h, (j) => ({ ...j, version: "0.9.0" })), EXIT.FILESYSTEM, /unexpected contents/],
  ["another instance", (h) => rewrite(h, (j) => ({ ...j, instance: "two" })), EXIT.FILESYSTEM, /unexpected contents/],
  ["another service", (h) => rewrite(h, (j) => ({ ...j, service: "control-plane" })), EXIT.FILESYSTEM, /unexpected contents/],
  ["a schema it doesn't know", (h) => rewrite(h, (j) => ({ ...j, schema: 2 })), EXIT.FILESYSTEM, /unexpected contents/],
  ["an extra field", (h) => rewrite(h, (j) => ({ ...j, extra: 1 })), EXIT.FILESYSTEM, /unexpected contents/],
  ["a short sha256", (h) => rewrite(h, (j) => ({ ...j, vbcdx_svc: { ...j.vbcdx_svc, sha256: "ab" } })), EXIT.FILESYSTEM, /unexpected contents/],
  // A version that isn't SEMVER, with the vbcdx-svc path layout() would derive from it, so only the
  // SEMVER check refuses it (a ".." version derives a path outside /usr/local/lib/vbcdx).
  ["a non-SEMVER version (x) with its own derived path", (h) => rewrite(h, (j) => ({ ...j, version: "x",
    vbcdx_svc: { ...j.vbcdx_svc, path: "/usr/local/lib/vbcdx/sidecar/x/vbcdx-svc" } })), EXIT.FILESYSTEM, /unexpected contents/],
  ["a '..' version with its own derived path", (h) => rewrite(h, (j) => ({ ...j, version: "../../../../tmp/evil",
    vbcdx_svc: { ...j.vbcdx_svc, path: join("/usr/local/lib/vbcdx/sidecar", "../../../../tmp/evil", "vbcdx-svc") } })), EXIT.FILESYSTEM, /unexpected contents/],
  ["missing its version", (h) => rewrite(h, ({ version, ...j }) => j), EXIT.FILESYSTEM, /unexpected contents/],
  ["missing vbcdx_svc", (h) => rewrite(h, ({ vbcdx_svc, ...j }) => j), EXIT.FILESYSTEM, /unexpected contents/],
  ["missing vbcdx_svc.sha256", (h) => rewrite(h, (j) => ({ ...j, vbcdx_svc: { path: j.vbcdx_svc.path } })), EXIT.FILESYSTEM, /unexpected contents/],
  ["an extra key inside vbcdx_svc", (h) => rewrite(h, (j) => ({ ...j, vbcdx_svc: { ...j.vbcdx_svc, args: ["--x"] } })), EXIT.FILESYSTEM, /unexpected contents/],
  ["not JSON", (h) => rewrite(h, "not json"), EXIT.FILESYSTEM, /is not JSON/],
  ["larger than a public record", (h) => rewrite(h, `${" ".repeat(5000)}{}`), EXIT.FILESYSTEM, /larger than a public record/],
];
// Only the file someone else's (its directories root's): needs chown, so only when the suite runs as root.
if (process.geteuid() === 0) {
  REFUSALS.push(["someone else's file in root's directories", (h) => chownSync(at(h, PUB), 1234, process.getgid()), EXIT.FILESYSTEM, /is not root's/]);
  // Only the instance directory someone else's (/etc/vbcdx and the file root's): isolates that check.
  REFUSALS.push(["in an instance directory that isn't root's", (h) => chownSync(at(h, "/etc/vbcdx/default"), 1234, process.getgid()),
    EXIT.FILESYSTEM, /^\/etc\/vbcdx\/default is not a root-owned directory/]);
} else {
  // Permission denied only bites a non-root euid (root reads through mode 000).
  const restore = (p) => (h) => chmodSync(at(h, p), 0o755);
  REFUSALS.push(["unreadable to the caller (not in group vbcdx: EACCES on open)", (h) => chmodSync(at(h, "/etc/vbcdx/default"), 0o000),
    EXIT.CONFIG, /isn't readable by you: .* group vbcdx/, { after: restore("/etc/vbcdx/default") }]);
  REFUSALS.push(["under an unsearchable /etc/vbcdx (EACCES on lstat)", (h) => chmodSync(at(h, "/etc/vbcdx"), 0o000),
    EXIT.FILESYSTEM, /^\/etc\/vbcdx\/default can't be read \(EACCES\)/, { after: restore("/etc/vbcdx") }]);
}
for (const [name, breakIt, code, re, o = {}] of REFUSALS) {
  test(`a non-root config service refuses a public record that is ${name}, and runs nothing`, () => {
    const h = o.fresh ? host() : systemInstall();
    breakIt(h);
    const u = as(h, 1000, o);
    const n = u.sys.calls.length;
    try {
      assert.throws(() => run(WHOAMI, u), (e) => e.code === code && re.test(e.message), name);
      assert.equal(ranSvc({ sys: { calls: u.sys.calls.slice(n) } }), false, `${name}: vbcdx-svc never runs`);
    } finally {
      if (o.after) o.after(h);
    }
  });
}

test("an --instance that isn't an instance name is refused before any path is built from it", () => {
  const h = systemInstall();
  const u = as(h, 1000);
  assert.throws(() => run(["config", "service", "sidecar", "--instance", "../x", "auth", "whoami"], u),
    (e) => e.code === 2 && /--instance is 1-32/.test(e.message));
});

// The record validator: the public record is a system sidecar's second file only.
test("a record may name the public record only as a system sidecar's second file", () => {
  const h = systemInstall();
  const rec = recordOf(h).services["sidecar:default"];
  const sys = { scope: "system", home: "/root" };
  assert.doesNotThrow(() => validateRecord("sidecar:default", rec, sys), "config + public record");
  assert.doesNotThrow(() => validateRecord("sidecar:default", { ...rec, files: rec.files.slice(0, 1) }, sys), "config only (installer 0.2.3)");
  const bad = (files) => assert.throws(() => validateRecord("sidecar:default", { ...rec, files }, sys), /unexpected files/);
  bad([rec.files[1], rec.files[0]]);
  bad([rec.files[0], { ...rec.files[1], path: "/etc/vbcdx/default/other.json" }]);
  bad([rec.files[0], rec.files[1], rec.files[1]]);
  bad([]);
  const u = as(host(), 1000);
  run(["install", "service", "sidecar", "--from", release()], u);
  const urec = recordOf(u, "/home/u").services["sidecar:default"];
  assert.throws(() => validateRecord("sidecar:default", { ...urec, files: [...urec.files, { path: PUB, sha256: "0".repeat(64) }] },
    { scope: "user", home: "/home/u" }), /unexpected files/, "a user install never has one");
});

test("no other service's record may carry a second file: a control plane writes no public record", () => {
  const h = host();
  run(["install", "service", "control-plane", "--from", release("0.1.0", ["vbcdx-sidecar", "vbcdx-svc", "vbcdx-control"])], h);
  const rec = recordOf(h).services["control-plane:default"];
  assert.equal(rec.files.length, 1);
  assert.equal(existsSync(at(h, "/etc/vbcdx-control/default/install.json")), false);
  assert.throws(() => validateRecord("control-plane:default",
    { ...rec, files: [...rec.files, { path: "/etc/vbcdx-control/default/install.json", sha256: "0".repeat(64) }] },
    { scope: "system", home: "/root" }), /unexpected files/);
});

test("on the real host, a public record is trusted only when it is uid 0's", () => {
  assert.equal(realSystem().rootUid, 0);
});

test("a non-root config service refuses a public record that is a unix socket (ENXIO on open), and runs nothing", async () => {
  const h = systemInstall();
  unlinkSync(at(h, PUB));
  const srv = createServer();
  await new Promise((ok, no) => srv.once("error", no).listen(at(h, PUB), ok));
  try {
    const u = as(h, 1000);
    const n = u.sys.calls.length;
    assert.throws(() => run(WHOAMI, u), (e) => e.code === EXIT.FILESYSTEM && /can't be opened \(ENXIO\), so it isn't trusted/.test(e.message));
    assert.equal(ranSvc({ sys: { calls: u.sys.calls.slice(n) } }), false, "vbcdx-svc never runs");
  } finally {
    await new Promise((ok) => srv.close(ok));
  }
});
