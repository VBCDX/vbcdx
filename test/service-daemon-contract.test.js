// The sidecar.toml install writes against the daemon that reads it (the daemon's config schema
// is the contract; the installer adapts to it).
//
// Always: every generated file holds only the daemon's sidecar keys, pinned below from the
// daemon's schema, in the forms its parsers take. With VBCDX_SIDECAR_BIN set to a
// vbcdx-sidecar from a packed release tree: the real `vbcdx-sidecar check` resolves each
// generated file exactly as `run` would, and must accept it (and refuse a known-bad one).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as tomlParse } from "smol-toml";
import { tempDir } from "./helpers/temp-dir.js";
import { buildPlan } from "../src/service/plan.js";

// The daemon's sidecar schema: vbcdx-core crates/vbcdx-config/src/schema.rs `SIDECAR` (at
// 4eda5565, with control_plane). Any other key makes the daemon exit 2 naming the file and the key.
const DAEMON_KEYS = ["listen", "admin_socket", "socket_group", "tcp", "expose_on_network", "state_dir", "control_plane",
  "log.level", "cache.default_ttl_seconds", "cache.max_staleness_seconds"];
const CP = `vbcdx+https://cp.example:8443?auth=mtls&pin=sha256:${"ab".repeat(32)}`;
const MAX_UNIX_PATH = 107;
const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;

const release = { version: "0.1.0", package: "@vbcdx/sidecar", platform: "linux-x64-gnu", signature: { keyId: "0".repeat(16) },
  // Both binaries, as every verified sidecar release has them (artifact.js maps SERVICES.sidecar.binaries).
  binaries: [{ name: "vbcdx-sidecar", sha256: "0".repeat(64), path: "/x/vbcdx-sidecar", bytes: Buffer.alloc(0) },
    { name: "vbcdx-svc", sha256: "1".repeat(64), path: "/x/vbcdx-svc", bytes: Buffer.alloc(0) }] };
const SYSTEM = { uid: 0, home: "/root", runtimeDir: null };
const user = (home, runtimeDir) => ({ uid: 1000, home, runtimeDir });
const tcp = (text) => {
  const m = /^(.*):(\d+)$/.exec(text);
  return { kind: "tcp", host: m[1], port: Number(m[2]), text };
};
const plan = (o) => buildPlan({ service: "sidecar", instance: "default", release, serviceManager: "systemd", listen: null,
  start: true, ...o });

// Every install shape: scope, instance, unix and TCP listens, an odd runtime path.
function variants(home = "/home/u", runtimeDir = "/run/user/1000") {
  return [
    ["system, default", plan({ host: SYSTEM })],
    ["system, instance two", plan({ host: SYSTEM, instance: "two" })],
    ["system, --listen unix:", plan({ host: SYSTEM, listen: { kind: "unix", path: "/run/vbcdx/other.sock", text: "unix:/run/vbcdx/other.sock" } })],
    ["system, --listen 127.0.0.1", plan({ host: SYSTEM, listen: tcp("127.0.0.1:8787") })],
    ["system, --listen [::1]", plan({ host: SYSTEM, listen: tcp("[::1]:8787") })],
    ["user, default", plan({ host: user(home, runtimeDir) })],
    ["user, --listen localhost", plan({ host: user(home, runtimeDir), listen: tcp("localhost:8787") })],
    ["user, instance a-1, odd runtime dir", plan({ host: user(home, `${runtimeDir}/x y%z`), instance: "a-1" })],
    ["system, --control-plane", plan({ host: SYSTEM, controlPlane: CP })],
    ["user, --control-plane", plan({ host: user(home, runtimeDir), controlPlane: CP })],
  ];
}

// The flat key names a TOML document defines (`[log] level` is `log.level`).
function keysOf(doc, prefix = "") {
  return Object.entries(doc).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? keysOf(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
}

// The daemon's vbcdx+unix rule: an absolute, normalised, strictly percent-encoded path.
function unixPath(conn) {
  assert.ok(conn.startsWith("vbcdx+unix:///"), conn);
  const raw = conn.slice("vbcdx+unix://".length);
  assert.doesNotMatch(raw, /[?#]/, "a query or fragment would be split off the path");
  assert.doesNotMatch(raw, /%(?![0-9A-Fa-f]{2})/, "a bad % escape");
  const path = decodeURIComponent(raw);
  assert.ok(path.slice(1).split("/").every((seg) => seg && seg !== "." && seg !== ".."), `not normalised: ${path}`);
  assert.ok(Buffer.byteLength(path) <= MAX_UNIX_PATH, `longer than ${MAX_UNIX_PATH} bytes: ${path}`);
  return path;
}

test("every generated sidecar.toml holds only the daemon's keys, in the daemon's forms", () => {
  for (const [name, p] of variants()) {
    const doc = tomlParse(p.files[0].text);
    for (const k of keysOf(doc)) assert.ok(DAEMON_KEYS.includes(k), `${name}: ${k} is not a key of the daemon's sidecar schema`);
    const listen = unixPath(doc.listen);
    assert.ok(doc.admin_socket.startsWith("/") && doc.admin_socket !== listen, `${name}: admin_socket`);
    assert.ok(doc.state_dir.startsWith("/"), `${name}: state_dir`);
    assert.equal(doc.socket_group, p.scope === "system" ? "vbcdx" : undefined, `${name}: socket_group`);
    assert.equal(doc.expose_on_network, undefined, `${name}: expose_on_network`);
    if (doc.tcp !== undefined) {
      const m = /^vbcdx\+http:\/\/(.+):(\d{1,5})$/.exec(doc.tcp);
      assert.ok(m && LOOPBACK_HOST.test(m[1]), `${name}: tcp must be vbcdx+http:// to loopback, got ${doc.tcp}`);
    }
    if (!p.listen.startsWith("unix:")) assert.ok(doc.tcp, `${name}: a TCP --listen must reach the daemon as tcp`);
    assert.equal(doc.control_plane, name.includes("--control-plane") ? CP : undefined, `${name}: control_plane`);
  }
});

test("the pinned key list itself catches the keys the daemon refused (instance, socket_mode)", () => {
  // A fixture mutation must change the verdict: the pre-fix file fails the same rule.
  const old = tomlParse('instance = "default"\nlisten = "unix:/run/vbcdx/default.sock"\nstate_dir = "/var/lib/vbcdx/default"\nsocket_mode = "0660"\n');
  assert.deepEqual(keysOf(old).filter((k) => !DAEMON_KEYS.includes(k)), ["instance", "socket_mode"]);
  assert.throws(() => unixPath(old.listen));
});

// The real daemon, from a packed release tree. It binds nothing; it only resolves the config.
const BIN = process.env.VBCDX_SIDECAR_BIN;
const check = (dir, instance) => spawnSync(BIN, ["check", "--instance", instance, "--instance-dir", dir], { encoding: "utf8", env: { PATH: process.env.PATH } });
const hasGroup = (g) => spawnSync("getent", ["group", g], { encoding: "utf8" }).status === 0;

test("the real vbcdx-sidecar check accepts every generated config", { skip: !BIN && "set VBCDX_SIDECAR_BIN to a vbcdx-sidecar from a packed tree" }, () => {
  const root = tempDir("vbcdx-check-");
  try {
    // User installs live under a temp HOME and runtime dir, as the test's own user.
    const home = join(root, "h");
    const runtimeDir = join(root, "r");
    for (const [name, p] of variants(home, runtimeDir)) {
      // A system file names /run/vbcdx and /var/lib/vbcdx and a group: checked only where they can be (root, group vbcdx).
      if (p.scope === "system" && (process.geteuid() !== 0 || !hasGroup("vbcdx"))) continue;
      const dir = join(root, "conf", name.replace(/[^a-z0-9]+/g, "-"));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "sidecar.toml"), p.files[0].text, { mode: 0o600 });
      const r = check(dir, p.instance);
      assert.equal(r.status, 0, `${name}: vbcdx-sidecar check exited ${r.status}: ${r.stderr.trim()}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.instance, p.instance, name);
    }
    // And it is the real parser: the file the daemon refused on the first real run is refused here.
    const bad = join(root, "conf", "pre-fix");
    mkdirSync(bad, { recursive: true, mode: 0o700 });
    writeFileSync(join(bad, "sidecar.toml"), `instance = "default"\nlisten = "unix:${runtimeDir}/vbcdx/default.sock"\n`, { mode: 0o600 });
    const r = check(bad, "default");
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /unknown key instance/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
