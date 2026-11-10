import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { keypair, signFile } from "./helpers/minisign-signer.js";
import { tempDir } from "./helpers/temp-dir.js";
import { planInstall, runService, serviceHost } from "../src/service/index.js";
import { fakeSystem } from "../src/service/system.js";
import { parseServiceArgs } from "../src/service/args.js";
import { parse as smolParse } from "smol-toml";
import { parseListen } from "../src/service/plan.js";
import { hostPlatform } from "../src/service/artifact.js";
import { RELEASE_KEYS } from "../src/service/trust.js";
import { parsePublicKey } from "../src/service/minisign.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "vbcdx.js");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const KEY = keypair(7);
const ROOT_HOST = { uid: 0, home: "/root", runtimeDir: null };

// A signed release on disk, in the layout the release job publishes.
// `mutate` edits the checksums document before it is signed (a validly signed odd release).
function release({ version = "0.1.0", pkg = "@vbcdx/sidecar", platform = "linux-x64-gnu", comment, tamper, sign = true, mutate } = {}) {
  const root = tempDir("vbcdx-rel-");
  const files = {};
  for (const name of ["vbcdx-sidecar", "vbcdx-svc"]) {
    const rel = `@vbcdx/sidecar-${platform}/bin/${name}`;
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    const body = Buffer.from(`#!/bin/sh\n# fake ${name} ${version}\n`);
    writeFileSync(join(root, rel), body, { mode: 0o755 });
    files[rel] = sha(body);
  }
  const doc = { schema: 1, package: pkg, version, files };
  if (mutate) mutate(doc);
  const sums = Buffer.from(JSON.stringify(doc, null, 2));
  writeFileSync(join(root, "checksums.json"), sums);
  if (sign) writeFileSync(join(root, "checksums.json.minisig"), signFile(KEY, sums, comment || `vbcdx-release ${pkg} ${version}`));
  if (tamper) writeFileSync(join(root, `@vbcdx/sidecar-${platform}/bin/vbcdx-sidecar`), "#!/bin/sh\n# swapped\n");
  return root;
}
const planOf = (o, d) => planInstall(o, d).plan;
// smol-toml's tables have a null prototype; a plain object compares with deepEqual.
const tomlParse = (text) => ({ ...smolParse(text) });
const opts = (from, extra = []) => parseServiceArgs(["install", "service", "sidecar", "--from", from, "--dry-run", "--json", ...extra]);
// An empty fake host by default: planInstall reads the instance's record (an installed instance's
// settings carry over), and a plan-only test must never read the real /root.
const deps = (extra = {}) => ({ trustedKeys: [KEY.pub], platformId: "linux-x64-gnu", host: ROOT_HOST,
  sys: fakeSystem(tempDir("vbcdx-host-")), ...extra });

test("the dry-run plan lists the unit, dirs, modes and binary checksums", () => {
  const root = release();
  const p = planOf(opts(root), deps());
  assert.equal(p.scope, "system");
  assert.equal(p.version, "0.1.0");
  assert.deepEqual(p.user, { name: "vbcdx", system: true, shell: "/usr/sbin/nologin" });
  const state = p.dirs.find((d) => d.path === "/var/lib/vbcdx/default");
  assert.deepEqual([state.mode, state.owner, state.group], ["0700", "vbcdx", "vbcdx"]);
  assert.ok(p.dirs.some((d) => d.path === "/usr/local/lib/vbcdx/sidecar/0.1.0" && d.mode === "0755"));
  const sums = JSON.parse(readFileSync(join(root, "checksums.json"), "utf8")).files;
  for (const b of p.binaries) {
    assert.equal(b.sha256, sums[`@vbcdx/sidecar-linux-x64-gnu/bin/${b.name}`]);
    assert.equal(b.to, `/usr/local/lib/vbcdx/sidecar/0.1.0/${b.name}`);
  }
  assert.deepEqual(p.symlink, { path: "/usr/local/lib/vbcdx/sidecar/current", target: "0.1.0" });
  assert.equal(p.unit.path, "/etc/systemd/system/vbcdx-sidecar-default.service");
  assert.equal(p.unit.sha256, sha(p.unit.text));
  assert.equal(p.listen, "unix:/run/vbcdx/default.sock");
  assert.equal(p.start, true);
  rmSync(root, { recursive: true });
});

test("the unit runs the copied binary, as vbcdx, with the baseline hardening", () => {
  const p = planOf(opts(release()), deps());
  const t = p.unit.text;
  assert.match(t, /^ExecStart=\/usr\/local\/lib\/vbcdx\/sidecar\/0\.1\.0\/vbcdx-sidecar run --instance default --instance-dir \/etc\/vbcdx\/default$/m);
  assert.ok(!t.includes("node_modules"), "the unit must never run the binary inside node_modules");
  for (const line of ["User=vbcdx", "Group=vbcdx", "NoNewPrivileges=yes", "ProtectSystem=strict", "PrivateTmp=yes",
    "LimitCORE=0", "StateDirectoryMode=0700", "CapabilityBoundingSet=", "RuntimeDirectoryPreserve=yes"]) {
    assert.match(t, new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"), line);
  }
  const conf = p.files.find((f) => f.path === "/etc/vbcdx/default/sidecar.toml");
  assert.deepEqual([conf.mode, conf.owner, conf.group], ["0640", "root", "vbcdx"]);
  // Only the daemon's own keys: the instance is the directory, the socket mode follows socket_group.
  assert.deepEqual(tomlParse(conf.text), { listen: "vbcdx+unix:///run/vbcdx/default.sock",
    admin_socket: "/run/vbcdx/default.admin.sock", socket_group: "vbcdx", state_dir: "/var/lib/vbcdx/default" });
  assert.deepEqual(p.check, ["/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-sidecar", "check", "--instance", "default",
    "--instance-dir", "/etc/vbcdx/default"]);
});

test("another instance names itself to the daemon, in the unit and in every path", () => {
  const p = planOf(opts(release(), ["--instance", "two"]), deps());
  assert.match(p.unit.text, /^ExecStart=\S+\/vbcdx-sidecar run --instance two --instance-dir \/etc\/vbcdx\/two$/m);
  assert.deepEqual(tomlParse(p.files[0].text), { listen: "vbcdx+unix:///run/vbcdx/two.sock",
    admin_socket: "/run/vbcdx/two.admin.sock", socket_group: "vbcdx", state_dir: "/var/lib/vbcdx/two" });
  assert.deepEqual(p.check.slice(1), ["check", "--instance", "two", "--instance-dir", "/etc/vbcdx/two"]);
});

test("--listen on loopback TCP adds tcp = vbcdx+http://… and keeps the unix socket", () => {
  for (const [flag, tcp] of [["127.0.0.1:8787", "vbcdx+http://127.0.0.1:8787"], ["localhost:9", "vbcdx+http://localhost:9"],
    ["[::1]:8787", "vbcdx+http://[::1]:8787"]]) {
    const p = planOf(opts(release(), ["--listen", flag]), deps());
    assert.equal(p.listen, flag);
    assert.deepEqual(tomlParse(p.files[0].text), { listen: "vbcdx+unix:///run/vbcdx/default.sock",
      admin_socket: "/run/vbcdx/default.admin.sock", tcp, socket_group: "vbcdx", state_dir: "/var/lib/vbcdx/default" }, flag);
  }
});

test("a network --listen is refused before anything is written: a standalone sidecar serves loopback only", () => {
  const argv = ["--listen", "10.0.0.5:8787", "--expose-on-network", "--i-understand-network-exposure"];
  assert.throws(() => planOf(opts(release(), argv), deps()), (e) => e.code === 5 && /loopback only/.test(e.message));
});

test("--listen unix: can't take the admin socket's name", () => {
  assert.throws(() => planOf(opts(release(), ["--listen", "unix:/run/vbcdx/default.admin.sock"]), deps()),
    (e) => e.code === 2 && /admin socket/.test(e.message));
  // Another instance's admin socket name is just a name here.
  assert.equal(planOf(opts(release(), ["--listen", "unix:/run/vbcdx/two.admin.sock"]), deps()).listen, "unix:/run/vbcdx/two.admin.sock");
});

test("a socket path is percent-encoded in the connection string, so the daemon reads back the same path", () => {
  const runtimeDir = "/run/user/1000/a b%c?d#e";
  const p = planOf(opts(release()), deps({ host: { uid: 1000, home: "/home/u", runtimeDir } }));
  const { listen } = tomlParse(p.files[0].text);
  assert.equal(listen, "vbcdx+unix:///run/user/1000/a%20b%25c%3Fd%23e/vbcdx/default.sock");
  assert.equal(decodeURIComponent(listen.slice("vbcdx+unix://".length)), `${runtimeDir}/vbcdx/default.sock`);
});

test("a user install stays in HOME, with a user unit and a 0600 socket", () => {
  const p = planOf(opts(release()), deps({ host: { uid: 1000, home: "/home/u", runtimeDir: "/run/user/1000" } }));
  assert.equal(p.scope, "user");
  assert.equal(p.user, null);
  assert.equal(p.unit.path, "/home/u/.config/systemd/user/vbcdx-sidecar-default.service");
  assert.equal(p.listen, "unix:/run/user/1000/vbcdx/default.sock");
  assert.ok(!p.unit.text.includes("User=vbcdx"));
  assert.ok(p.dirs.every((d) => d.path.startsWith("/home/u/")));
  // No socket_group (so both sockets are 0600), and admin socket and state named: their defaults are /run and /var/lib.
  assert.deepEqual(tomlParse(p.files[0].text), { listen: "vbcdx+unix:///run/user/1000/vbcdx/default.sock",
    admin_socket: "/run/user/1000/vbcdx/default.admin.sock", state_dir: "/home/u/.vbcdx/services/default" });
  assert.match(p.unit.text, /^ExecStart=\S+ run --instance default --instance-dir \/home\/u\/\.vbcdx\/services\/default$/m);
});

test("the system unit runs in socket_group, and its syscall filter never allows chown", () => {
  // The daemon's sockets then get that group as created; chown (denied by ~@privileged) is never needed.
  const p = planOf(opts(release()), deps());
  const t = p.unit.text;
  const { socket_group } = tomlParse(p.files[0].text);
  assert.equal(socket_group, "vbcdx");
  assert.deepEqual(t.match(/^Group=.*$/gm), [`Group=${socket_group}`]);
  assert.deepEqual(t.match(/^User=.*$/gm), ["User=vbcdx"]);
  const filters = t.match(/^SystemCallFilter=.*$/gm);
  assert.ok(filters.includes("SystemCallFilter=~@privileged @resources"), filters.join("; "));
  for (const f of filters.filter((x) => !x.startsWith("SystemCallFilter=~"))) {
    assert.doesNotMatch(f, /chown|@privileged/, `an allow-list must not grant chown: ${f}`);
  }
  // A user unit: no group of its own, no socket_group (0600 sockets, no chown either).
  const u = planOf(opts(release()), deps({ host: { uid: 1000, home: "/home/u", runtimeDir: "/run/user/1000" } }));
  assert.equal(u.unit.text.match(/^(User|Group)=/m), null);
  assert.equal(tomlParse(u.files[0].text).socket_group, undefined);
});

test("a user install needs XDG_RUNTIME_DIR even with a TCP listen: the admin socket is unix-only", () => {
  const noRuntime = deps({ host: { uid: 1000, home: "/home/u", runtimeDir: null } });
  for (const extra of [[], ["--listen", "127.0.0.1:8787"]]) {
    assert.throws(() => planOf(opts(release(), extra), noRuntime), (e) => e.code === 2 && /XDG_RUNTIME_DIR/.test(e.message), extra.join(" "));
  }
});

test("--service none writes no unit and says how to run it in the foreground", () => {
  const p = planOf(opts(release(), ["--service", "none"]), deps());
  assert.equal(p.unit, null);
  assert.equal(p.start, false);
  assert.equal(p.run, "/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-sidecar run --instance default --instance-dir /etc/vbcdx/default");
});

test("every verification failure is refused with exit 5 before any plan exists", () => {
  const cases = [
    ["a swapped binary", release({ tamper: true }), {}, /does not match its signed checksum/],
    ["an unsigned release", release({ sign: false }), {}, /unsigned/],
    ["a key we don't trust", release(), { trustedKeys: [keypair(9).pub] }, /not a trusted release key/],
    ["no key pinned (the shipped default until a release key exists)", release(), { trustedKeys: [] }, /no release key is pinned/],
    ["another package", release({ pkg: "@vbcdx/other" }), {}, /not @vbcdx\/sidecar/],
    ["a comment for another version", release({ comment: "vbcdx-release @vbcdx/sidecar 9.9.9" }), {}, /trusted comment/],
    ["an unbuilt platform", release({ platform: "linux-x64-musl" }), {}, /no checksum/],
  ];
  for (const [name, root, extra, re] of cases) {
    assert.throws(() => planOf(opts(root), deps(extra)), (e) => e.code === 5 && re.test(e.message), name);
  }
});

test("--version must match the release; a bad --listen or instance is exit 2", () => {
  const root = release();
  // The registry path passes the requested --version on to the release check.
  assert.throws(() => planOf({ ...opts(root), version: "0.2.0" }, deps()), (e) => e.code === 2 && /not 0\.2\.0/.test(e.message));
  assert.equal(planOf({ ...opts(root), version: "0.1.0" }, deps()).version, "0.1.0");
  assert.throws(() => planOf(opts(root, ["--instance", "Bad_Name"]), deps()), (e) => e.code === 2);
  assert.throws(() => parseServiceArgs(["install", "service", "sidecar", "--version", "1.0.0", "--from", root]), (e) => e.code === 2 && /not both/.test(e.message));
});

test("--listen: loopback is fine; off-loopback needs both exposure flags", () => {
  assert.equal(parseListen("127.0.0.1:8787").kind, "tcp");
  assert.equal(parseListen("[::1]:8787").kind, "tcp");
  assert.throws(() => parseListen("0.0.0.0:8787"), (e) => e.code === 2);
  assert.throws(() => parseListen("10.0.0.5:8787", { expose: true }), (e) => e.code === 2);
  assert.equal(parseListen("10.0.0.5:8787", { expose: true, acknowledged: true }).host, "10.0.0.5");
  assert.throws(() => parseListen("unix:relative.sock"), (e) => e.code === 2);
  assert.throws(() => parseServiceArgs(["install", "service", "sidecar", "--i-understand-network-exposure"]), (e) => e.code === 2);
});

test("keyhole and dispatch are not services: no module to install, no package fetched", () => {
  const sys = fakeSystem(tempDir("vbcdx-nomod-"));
  for (const argv of [["install", "service", "keyhole", "--instance", "a"], ["install", "service", "dispatch", "--version", "1.0.0"],
    ["remove", "service", "keyhole"], ["remove", "service", "dispatch", "--wipe"]]) {
    assert.throws(() => runService(parseServiceArgs(argv), { sys, host: ROOT_HOST }),
      (e) => e.code === 2 && /is not a service of its own/.test(e.message) && /-server\)\.$/.test(e.message), argv.join(" "));
  }
});

test("the grammar still refuses what it doesn't take", () => {
  assert.throws(() => parseServiceArgs(["service", "sidecar", "status", "--follow"]), (e) => e.code === 2);
  assert.throws(() => parseServiceArgs(["install", "service", "sidecar", "--bogus"]), (e) => e.code === 2);
  assert.throws(() => parseServiceArgs(["service", "sidecar", "reboot"]), (e) => e.code === 2);
});

test("the CLI: a dry run writes nothing, and the shipped key list refuses a release from any other signer", () => {
  const root = release();
  const before = readdirSync(root, { recursive: true }).sort();
  const home = tempDir("vbcdx-home-");
  const r = spawnSync(process.execPath, [BIN, "install", "service", "sidecar", "--from", root, "--dry-run", "--json"],
    { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } });
  assert.equal(r.status, 5);
  assert.match(r.stderr, /which is not a trusted release key/);
  assert.deepEqual(readdirSync(root, { recursive: true }).sort(), before);
  assert.deepEqual(readdirSync(home), []);
});

test("the shipped key list is exactly the two overlapping DEV release keys, written out here independently", () => {
  // DEV key 1 (93226C4C92D7E33C) and DEV key 3 (17624991E82371C7). Changing the pinned keys means
  // changing this test too, in a reviewed PR.
  assert.deepEqual([...RELEASE_KEYS], [
    "RWQ849eSTGwikxhwcRqPpuACfXMuTCJ4CJzvVDdC5atdTp0ZoeC23oTN",
    "RWTHcSPokUliF6d2l3YdaFadHPLP85gvPsaLDo+66LQ5AleMffYib9Iq",
  ]);
  assert.deepEqual(RELEASE_KEYS.map((k) => Buffer.from(parsePublicKey(k).keyId).reverse().toString("hex").toUpperCase()),
    ["93226C4C92D7E33C", "17624991E82371C7"]);
  // DEV key 2 was never usable: a release signed by it must not install.
  assert.ok(!RELEASE_KEYS.includes("RWTRx9Wd7yxcfeYfPikn1jO6pPQ+XBHIxCojjR2a/D9M5c0eZtCy6efv"), "DEV key 2 is not trusted");
});

test("hostPlatform names the libc", () => {
  assert.equal(hostPlatform({ os: "linux", cpu: "x64", report: () => ({ header: { glibcVersionRuntime: "2.41" } }) }), "linux-x64-gnu");
  assert.equal(hostPlatform({ os: "linux", cpu: "arm64", report: () => ({ header: {} }) }), "linux-arm64-musl");
  assert.equal(hostPlatform({ os: "darwin", cpu: "arm64" }), "darwin-arm64");
  assert.throws(() => hostPlatform({ os: "win32", cpu: "x64" }), (e) => e.code === 5);
});

test("a signed version must be strict semver, so it can never leave lib/ as a path", () => {
  for (const bad of ["../../etc", "1.0", "01.0.0", "1.0.0/x", "1.0.0-..", "1.0.0-", "v1.0.0", " 1.0.0"]) {
    // Signed by the trusted key, comment and all: only the semver check stands in the way.
    assert.throws(() => planOf(opts(release({ version: bad })), deps()), (e) => e.code === 5 && /semantic version/.test(e.message), bad);
  }
  for (const good of ["0.1.0", "1.2.3-rc.1", "1.0.0-alpha.0.beta", "2.0.0+build.7"]) {
    const p = planOf(opts(release({ version: good })), deps());
    assert.equal(p.binaries[0].to, `/usr/local/lib/vbcdx/sidecar/${good}/vbcdx-sidecar`, good);
  }
});

test("checksums.json must be schema 1 with hex SHA-256 values", () => {
  assert.throws(() => planOf(opts(release({ mutate: (d) => { d.schema = 2; } })), deps()), (e) => e.code === 5 && /schema 1/.test(e.message));
  const notHex = (d) => { for (const k of Object.keys(d.files)) d.files[k] = d.files[k].toUpperCase(); };
  assert.throws(() => planOf(opts(release({ mutate: notHex })), deps()), (e) => e.code === 5 && /no checksum/.test(e.message));
});

test("the plan carries the verified bytes, and --json never prints them", () => {
  const p = planOf(opts(release()), deps());
  for (const b of p.binaries) {
    assert.ok(Buffer.isBuffer(b.bytes) && sha(b.bytes) === b.sha256, b.name);
    assert.ok(!Object.keys(b).includes("bytes"), "bytes must not be enumerable");
  }
  assert.ok(!JSON.stringify(p).includes("#!/bin/sh"), "no binary content in --json");
});

test("a signed version that is not a string is refused, even one an array would coerce past the pattern", () => {
  const root = release({ mutate: (d) => { d.version = ["0.1.0"]; }, comment: "vbcdx-release @vbcdx/sidecar 0.1.0" });
  assert.throws(() => planOf(opts(root), deps()), (e) => e.code === 5 && /semantic version/.test(e.message));
});

test("--version takes an exact version: no range, tag or partial version reaches npm", () => {
  for (const bad of ["^1.0.0", "latest", "1.0", ">=1.0.0", "1.0.0 || 2.0.0", "file:../x"]) {
    assert.throws(() => parseServiceArgs(["install", "service", "sidecar", "--version", bad]), (e) => e.code === 2 && /exact version/.test(e.message), bad);
  }
  assert.equal(parseServiceArgs(["install", "service", "sidecar", "--version", "1.2.3-rc.1"]).version, "1.2.3-rc.1");
});

test("--listen unix: must be in the unit's runtime directory, the one place ProtectSystem=strict lets it write", () => {
  const root = release();
  for (const bad of ["unix:/tmp/x.sock", "unix:/run/x.sock", "unix:/run/vbcdx/sub/x.sock", "unix:/var/lib/vbcdx/x.sock"]) {
    assert.throws(() => planOf(opts(root, ["--listen", bad]), deps()), (e) => e.code === 2 && /runtime|directly in/.test(e.message), bad);
  }
  assert.equal(planOf(opts(root, ["--listen", "unix:/run/vbcdx/other.sock"]), deps()).listen, "unix:/run/vbcdx/other.sock");
  const user = { host: { uid: 1000, home: "/home/u", runtimeDir: "/run/user/1000" } };
  assert.throws(() => planOf(opts(root, ["--listen", "unix:/home/u/x.sock"]), deps(user)), (e) => e.code === 2);
  assert.equal(planOf(opts(root, ["--listen", "unix:/run/user/1000/vbcdx/a.sock"]), deps(user)).listen, "unix:/run/user/1000/vbcdx/a.sock");
  assert.throws(() => planOf(opts(root, ["--listen", "unix:/run/user/1000/vbcdx/a.sock"]), deps({ host: { uid: 1000, home: "/home/u", runtimeDir: null } })),
    (e) => e.code === 2);
});

test("the plan creates each level it owns with that level's own mode and owner", () => {
  const p = planOf(opts(release()), deps());
  const dirs = Object.fromEntries(p.dirs.map((d) => [d.path, `${d.mode} ${d.owner}:${d.group}`]));
  assert.deepEqual(dirs, {
    "/usr/local/lib/vbcdx": "0755 root:root", "/usr/local/lib/vbcdx/sidecar": "0755 root:root",
    "/usr/local/lib/vbcdx/sidecar/0.1.0": "0755 root:root", "/var/lib/vbcdx": "0755 root:root",
    "/var/lib/vbcdx/default": "0700 vbcdx:vbcdx", "/etc/vbcdx": "0755 root:root", "/etc/vbcdx/default": "0750 root:vbcdx",
  });
  const u = planOf(opts(release()), deps({ host: { uid: 1000, home: "/home/u", runtimeDir: "/run/user/1000" } }));
  assert.deepEqual(u.dirs.map((d) => `${d.path} ${d.mode}`), ["/home/u/.vbcdx/lib 0755", "/home/u/.vbcdx/lib/sidecar 0755",
    "/home/u/.vbcdx/lib/sidecar/0.1.0 0755", "/home/u/.vbcdx/services 0700", "/home/u/.vbcdx/services/default 0700"]);
});

test("root's record is found through its passwd home, never $HOME", () => {
  const sys = fakeSystem("/nowhere", { uid: 0, passwdHome: "/root" });
  assert.equal(serviceHost(sys, { HOME: "/tmp/evil" }).home, "/root");
  assert.equal(serviceHost(fakeSystem("/nowhere", { uid: 1000 }), { HOME: "/home/u" }).home, "/home/u");
});

test("the unit's UMask: 0007 for a system install (socket 0660 for group vbcdx), 0077 for a user one", () => {
  assert.match(planOf(opts(release()), deps()).unit.text, /^UMask=0007$/m);
  const u = planOf(opts(release()), deps({ host: { uid: 1000, home: "/home/u", runtimeDir: "/run/user/1000" } }));
  assert.match(u.unit.text, /^UMask=0077$/m);
});
