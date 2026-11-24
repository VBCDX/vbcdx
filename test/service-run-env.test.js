// The environment the service installer's commands run with: never the caller's whole one, and a
// PATH an inherited value can't point elsewhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runEnv, SYSTEM_PATH } from "../src/service/system.js";
import { tempDir } from "./helpers/temp-dir.js";

// Every name runEnv keeps, each with a value of its own, so dropping any one of them fails.
const KEPT = {
  HOME: "/root", USER: "root", LOGNAME: "root", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "xterm",
  XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  HTTPS_PROXY: "http://p1.example:3128", https_proxy: "http://p2.example:3128",
  HTTP_PROXY: "http://p3.example:3128", http_proxy: "http://p4.example:3128",
  NO_PROXY: "localhost", no_proxy: "127.0.0.1",
  NODE_EXTRA_CA_CERTS: "/etc/ssl/extra.pem", SSL_CERT_FILE: "/etc/ssl/certs/ca.pem", SSL_CERT_DIR: "/etc/ssl/certs",
  // npm's registry, TLS and proxy settings, in npm's spellings (any case, - or _).
  npm_config_registry: "https://registry.example/",
  "npm_config_@acme:registry": "https://acme.example/",
  npm_config_cafile: "/etc/ssl/npm.pem",
  npm_config_ca: "-----BEGIN CERTIFICATE-----",
  npm_config_proxy: "http://p5.example:3128",
  "npm_config_https-proxy": "http://p6.example:3128",
  npm_config_noproxy: "internal.example",
  NPM_CONFIG_STRICT_SSL: "true",
};
// The caller's settings for the user's own vbcdx-svc: they can carry tokens.
const VBCDX = { VBCDX_INSTANCE: "default", VBCDX_AGENTS_TOKEN: "CANARY-TOKEN" };

test("runEnv keeps only what the commands need, with PATH = the running node's directory, then the system's", () => {
  const env = {
    ...KEPT,
    ...VBCDX,
    PATH: "/tmp/evil:/usr/bin",
    LD_PRELOAD: "/tmp/evil.so",
    NODE_OPTIONS: "--require /tmp/evil.js",
    SOME_SECRET: "CANARY",
    // npm settings that run code or change which config file is read: dropped.
    npm_config_node_options: "--require /tmp/evil.js",
    npm_config_script_shell: "/tmp/evil.sh",
    npm_config_userconfig: "/tmp/evil.npmrc",
  };
  const path = `/opt/node/bin:${SYSTEM_PATH}`;
  // Every command: no VBCDX_*, so a token in it reaches no systemctl, runuser or npm.
  assert.deepEqual(runEnv(env, "/opt/node/bin/node"), { PATH: path, ...KEPT });
  // The run that asks for it (the user's own vbcdx-svc) also gets VBCDX_*, and nothing more.
  assert.deepEqual(runEnv(env, "/opt/node/bin/node", { vbcdx: true }), { PATH: path, ...KEPT, ...VBCDX });
  // `home` is HOME, whatever the caller's says (as root: the passwd entry's).
  assert.equal(runEnv({ ...env, HOME: "/home/someone" }, "/opt/node/bin/node", { home: "/root" }).HOME, "/root");
});

// system.js 44: a value that is not a string is dropped, never stringified, so a number or a null in
// a kept name reaches no command.
test("runEnv drops a non-string value instead of stringifying it", () => {
  const env = { PATH: "/bin", HOME: "/root", LANG: 42, HTTPS_PROXY: null, USER: "root" };
  assert.deepEqual(runEnv(env, "/opt/node/bin/node"), {
    PATH: `/opt/node/bin:${SYSTEM_PATH}`,
    HOME: "/root",
    USER: "root",
  });
});

test("the real host runs the command the fixed PATH finds, never one an inherited PATH points at", () => {
  // A `true` that fails, first on the caller's PATH: the system's own must run instead.
  const dir = tempDir("vbcdx-path-");
  const planted = join(dir, "true");
  writeFileSync(planted, "#!/bin/sh\nexit 42\n");
  chmodSync(planted, 0o755);
  const system = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "service", "system.js");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { realSystem } from ${JSON.stringify(system)};
     const sys = realSystem();
     const out = { status: sys.run("true", []).status, env: sys.run("env", []).stdout,
       svc: sys.run("env", [], { vbcdxEnv: true }).stdout };
     // As root (the euid check is the only thing that differs): HOME is the passwd entry's.
     process.geteuid = () => 0;
     out.root = sys.run("env", []).stdout;
     process.stdout.write(JSON.stringify(out));`],
  { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CANARY_ENV_NAME: "CANARY_VALUE",
    VBCDX_AGENTS_TOKEN: "TOKEN_CANARY", HOME: dir } });
  assert.equal(child.status, 0, child.stderr);
  const out = JSON.parse(child.stdout);
  const lines = (s) => s.split("\n");
  assert.equal(out.status, 0, "the planted `true` ran instead of the system's");
  assert.ok(!out.env.includes("CANARY"), out.env);
  assert.ok(lines(out.env).includes(`PATH=${dirname(process.execPath)}:${SYSTEM_PATH}`), out.env);
  // The caller's HOME unless this runs as root. vbcdxEnv adds the caller's VBCDX_* and nothing else.
  assert.ok(lines(out.env).includes(`HOME=${process.geteuid() === 0 ? userInfo().homedir : dir}`), out.env);
  assert.ok(lines(out.svc).includes("VBCDX_AGENTS_TOKEN=TOKEN_CANARY"), out.svc);
  assert.ok(!out.svc.includes("CANARY_VALUE"), out.svc);
  assert.ok(lines(out.root).includes(`HOME=${userInfo().homedir}`), out.root);
  assert.notEqual(userInfo().homedir, dir);
});
