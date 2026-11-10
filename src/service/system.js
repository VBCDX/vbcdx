// The one place the service installer touches the host. Every path a plan names goes
// through path(), every command through run(): tests swap in a temporary root and a
// recording runner, so the whole install, remove and doctor flow runs without root or
// systemd. run() never uses a shell; arguments are passed as an array.

import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";

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
    run(cmd, args, { inherit = false, input, cwd } = {}) {
      const r = spawnSync(cmd, args, { encoding: "utf8", stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"], input, cwd });
      if (r.error) return { status: 127, stdout: "", stderr: `${cmd}: ${r.error.code || r.error.message}` };
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
