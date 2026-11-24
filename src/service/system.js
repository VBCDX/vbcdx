// The one place the service installer touches the host. Every path a plan names goes
// through path(), every command through run(): tests swap in a temporary root and a
// recording runner, so the whole install, remove and doctor flow runs without root or
// systemd. run() never uses a shell; arguments are passed as an array.

import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";

/** The system directories a command is looked up in, after the running node's own. */
export const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
// What the commands need from the caller's environment: the user and locale, the terminal, the
// user's systemd bus (systemctl --user), the network's proxy and extra CA (npm), and npm's
// registry and TLS settings. npm settings that can run code or change which config file is read
// (node-options, script-shell, userconfig, …) are not kept. VBCDX_* is not kept either: it can
// carry tokens (VBCDX_AGENTS_TOKEN, VBCDX_FORGEJO_TOKEN, …), so only a run that asks for it
// (`vbcdxEnv`: the user's own vbcdx-svc command, which reads its settings there) gets it.
const KEEP = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR"];
const NPM_KEEP = ["registry", "cafile", "ca", "proxy", "https_proxy", "noproxy", "strict_ssl"];

/** Whether a command gets the caller's variable `k`; `VBCDX_*` only when `vbcdx`. */
function kept(k, vbcdx) {
  if (KEEP.includes(k) || (vbcdx && /^VBCDX_/.test(k))) return true;
  const npm = /^npm_config_(.+)$/i.exec(k);
  if (!npm) return false;
  const name = npm[1].toLowerCase().replace(/-/g, "_");
  // A scope's registry (`npm_config_@acme:registry`) is a registry setting too.
  return NPM_KEEP.includes(name) || /^@[a-z0-9][a-z0-9._]*:registry$/.test(name);
}

/**
 * The environment every command runs with: never the caller's whole one. As root, an inherited
 * PATH could choose which binary runs, and LD_* or NODE_OPTIONS-style variables could load code.
 * PATH is the directory of the node running this installer (npm sits beside it), then the system
 * directories; the rest is the short list above, plus `VBCDX_*` when `vbcdx`. `home`, when given,
 * is HOME: as root it is the passwd entry's, so a `sudo -E` caller's HOME never makes root read
 * that user's ~/.npmrc or write a root-owned cache into their home.
 */
export function runEnv(env = process.env, node = process.execPath, { vbcdx = false, home } = {}) {
  const out = { PATH: `${dirname(node)}:${SYSTEM_PATH}` };
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && kept(k, vbcdx)) out[k] = v;
  }
  if (home !== undefined) out.HOME = home;
  return out;
}

/** The real host. */
export function realSystem() {
  return {
    root: "/",
    path: (p) => p,
    uid: process.getuid(),
    // Who must own the install record before it is trusted.
    euid: process.geteuid(),
    // Who must own a system install's files before a non-root caller trusts them (its public record).
    rootUid: 0,
    // The passwd entry's home, not $HOME: root's record is never located by its environment.
    passwdHome: () => userInfo().homedir,
    // The clock the post-start wait reads; sleep blocks this (synchronous) process.
    now: () => Date.now(),
    sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    // `vbcdxEnv`: the command also gets the caller's VBCDX_* (only the user's own vbcdx-svc).
    run(cmd, args, { inherit = false, input, cwd, vbcdxEnv = false } = {}) {
      const home = process.geteuid() === 0 ? userInfo().homedir : undefined;
      const env = runEnv(process.env, process.execPath, { vbcdx: vbcdxEnv, home });
      const r = spawnSync(cmd, args, { encoding: "utf8", env, stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"], input, cwd });
      if (r.error) return { status: 127, stdout: "", stderr: `${cmd}: ${r.error.code}` };
      return { status: r.status === null ? 1 : r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
    },
  };
}

/**
 * A host for tests: paths land under `root`, and commands are recorded and answered by
 * `answer(cmd, args)` (default: success with no output).
 */
export function fakeSystem(root, { uid = 0, euid = process.geteuid(), rootUid = process.geteuid(), passwdHome = "/root",
  answer = () => ({ status: 0, stdout: "", stderr: "" }) } = {}) {
  const calls = [];
  const opts = [];
  // A virtual clock: sleep advances it, so a wait runs instantly and answers can depend on it.
  const clock = { t: 1_700_000_000_000 };
  return {
    root,
    calls,
    opts,
    clock,
    now: () => clock.t,
    sleep: (ms) => {
      clock.t += ms;
    },
    uid,
    euid,
    // A test's files are its own user's, so "root-owned" means owned by the test's euid here.
    rootUid,
    passwdHome: () => passwdHome,
    path: (p) => join(root, p),
    run(cmd, args, o = {}) {
      calls.push([cmd, ...args]);
      opts.push(o);
      return { status: 0, stdout: "", stderr: "", ...answer(cmd, args, o) };
    },
  };
}
