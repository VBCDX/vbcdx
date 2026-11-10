// An interrupted install (SIGKILL: an OOM kill, a power loss, `kill -9`) leaves the install
// record's lock behind with a dead PID, and maybe files no record names. The next install or
// remove takes a stale lock over and says so; a live holder is named; a dry run and doctor
// report the lock and the unrecorded files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renameSync as renameSyncLocal } from "node:fs";
import { keypair, signFile } from "./helpers/minisign-signer.js";
import { tempDir } from "./helpers/temp-dir.js";
import { fakeAccounts } from "./helpers/fake-accounts.js";
import { acquireLocks, holderCommand, lockHolder, LOCK_FRESH_MS } from "../src/fs/safe-writer.js";
import { humanPlan, humanReport, runService } from "../src/service/index.js";
import { parseServiceArgs } from "../src/service/args.js";
import { fakeSystem } from "../src/service/system.js";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const KEY = keypair(7);

// A PID that is certainly not running: a process that has already exited.
function deadPid() {
  const r = spawnSync("true");
  assert.equal(r.status, 0);
  return r.pid;
}
// A live process that isn't vbcdx, and its start time as /proc gives it.
function liveOther() {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
  const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  return { pid: child.pid, start, stop: () => child.kill("SIGKILL") };
}
function lockOf(path, text, { ageMs = 0 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.lock`, text);
  if (ageMs) {
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(`${path}.lock`, t, t);
  }
}

// ── the lock itself ─────────────────────────────────────────────────────────

test("a lock whose PID is dead is taken over, and onStale names it", () => {
  const p = join(tempDir("vbcdx-lock-"), "installation.json");
  const dead = deadPid();
  lockOf(p, `${dead}\n`);
  const seen = [];
  const release = acquireLocks([p], { onStale: (s) => seen.push(s) });
  assert.deepEqual(seen, [{ path: p, pid: dead, reason: `process ${dead} is not running` }]);
  assert.match(readFileSync(`${p}.lock`, "utf8"), new RegExp(`^${process.pid} \\d+\\n$`), "the lock is ours now: pid and start time");
  release();
  assert.ok(!existsSync(`${p}.lock`));
});

test("a live holder is refused, by PID, command and how long it has held the lock", () => {
  const p = join(tempDir("vbcdx-lock-"), "installation.json");
  const other = liveOther();
  try {
    lockOf(p, `${other.pid} ${other.start}\n`, { ageMs: 12000 });
    assert.equal(lockHolder(`${p}.lock`).state, "held");
    assert.throws(() => acquireLocks([p], { onStale: () => assert.fail("not stale") }),
      new RegExp(`holds the lock for .*: process ${other.pid} \\(sleep\\), for 1[23] s\\. Retry after it finishes\\.`));
    assert.equal(readFileSync(`${p}.lock`, "utf8"), `${other.pid} ${other.start}\n`, "a live holder's lock is untouched");
  } finally {
    other.stop();
  }
});

test("a live PID with another start time is stale (reused); a live PID in a lock with no start time is the holder", () => {
  const other = liveOther();
  try {
    const a = join(tempDir("vbcdx-lock-"), "installation.json");
    lockOf(a, `${other.pid} 1\n`);
    const { ino, ...verdict } = lockHolder(`${a}.lock`);
    assert.deepEqual(verdict, { state: "stale", pid: other.pid, reason: `PID ${other.pid} now belongs to another process` });
    assert.equal(typeof ino, "number", "the verdict names the file it judged");
    const seen = [];
    acquireLocks([a], { onStale: (s) => seen.push(s.pid) })();
    assert.deepEqual(seen, [other.pid]);
    // The format 0.2.2 wrote: no start time, so a reused PID can't be told from the holder.
    const b = join(tempDir("vbcdx-lock-"), "installation.json");
    lockOf(b, `${other.pid}\n`);
    assert.equal(lockHolder(`${b}.lock`).state, "held");
    assert.throws(() => acquireLocks([b], { onStale: () => assert.fail("never taken over") }), new RegExp(`process ${other.pid}`));
  } finally {
    other.stop();
  }
});

test("an empty lock is someone's half-written one while young, and stale once old", () => {
  const p = join(tempDir("vbcdx-lock-"), "installation.json");
  lockOf(p, "");
  assert.equal(lockHolder(`${p}.lock`).state, "held");
  assert.throws(() => acquireLocks([p]), /holds the lock .*another process/);
  lockOf(p, "", { ageMs: LOCK_FRESH_MS + 1000 });
  const seen = [];
  acquireLocks([p], { onStale: (s) => seen.push(s.reason) })();
  assert.deepEqual(seen, ["it names no process"]);
});

test("no lock file: free, and acquiring writes pid and start time", () => {
  const p = join(tempDir("vbcdx-lock-"), "installation.json");
  assert.deepEqual(lockHolder(`${p}.lock`), { state: "free" });
  const release = acquireLocks([p], { onStale: () => assert.fail("nothing to take over") });
  assert.equal(lockHolder(`${p}.lock`).state, "held");
  release();
});

// ── takeover races ────────────────────────────────────────────

test("two takers of one stale lock: the second, acting on its old verdict, never removes the first's live lock", () => {
  const p = join(tempDir("vbcdx-lock-"), "installation.json");
  lockOf(p, `${deadPid()}\n`);
  let first = null;
  // B judged the lock stale; before B acts, A takes it over and holds it.
  const hooks = { afterJudge: () => { first = acquireLocks([p], { onStale: () => {} }); } };
  assert.throws(() => acquireLocks([p], { onStale: () => assert.fail("B never takes over"), hooks }),
    new RegExp(`holds the lock for .*: process ${process.pid} `));
  assert.match(readFileSync(`${p}.lock`, "utf8"), new RegExp(`^${process.pid} \\d+\\n$`), "A's lock is still there");
  assert.deepEqual(readdirSync(dirname(p)).filter((f) => f !== "installation.json.lock"), [], "no aside or takeover file left");
  first();
  assert.ok(!existsSync(`${p}.lock`));
});

test("a fresh acquirer that wins before the taker acts: the taker is refused, the fresh lock untouched", () => {
  const p = join(tempDir("vbcdx-lock-"), "installation.json");
  lockOf(p, `${deadPid()}\n`);
  const other = liveOther();
  try {
    // Between B's judgement and its takeover, the stale lock goes and another process's live one appears.
    const hooks = { afterJudge: (lock) => writeFileSync(lock, `${other.pid} ${other.start}\n`) };
    assert.throws(() => acquireLocks([p], { onStale: () => assert.fail("never taken over"), hooks }), new RegExp(`process ${other.pid}`));
    assert.equal(readFileSync(`${p}.lock`, "utf8"), `${other.pid} ${other.start}\n`);
  } finally {
    other.stop();
  }
});

test("the file renamed aside is checked: if it isn't the one judged stale it goes back, and the run is refused", () => {
  const p = join(tempDir("vbcdx-lock-"), "installation.json");
  lockOf(p, `${deadPid()}\n`);
  const other = liveOther();
  try {
    const live = `${other.pid} ${other.start}\n`;
    // A new file (another inode) at the path between the second judgement and the rename.
    const hooks = { beforeRename: (lock) => { writeFileSync(`${lock}.new`, live); renameSyncLocal(`${lock}.new`, lock); } };
    assert.throws(() => acquireLocks([p], { onStale: () => assert.fail("never taken over"), hooks }), /changed during takeover; retry/);
    assert.equal(readFileSync(`${p}.lock`, "utf8"), live, "the live lock is back at its path");
    assert.deepEqual(readdirSync(dirname(p)).filter((f) => f !== "installation.json.lock"), [], "nothing left aside");
  } finally {
    other.stop();
  }
});

test("a takeover in progress refuses a second taker; one interrupted (dead PID) is never cleared automatically", () => {
  const p = join(tempDir("vbcdx-lock-"), "installation.json");
  const other = liveOther();
  try {
    lockOf(p, `${deadPid()}\n`);
    writeFileSync(`${p}.lock.takeover`, `${other.pid} ${other.start}\n`);
    assert.throws(() => acquireLocks([p], { onStale: () => assert.fail("no") }), /Another run is taking over the stale lock for .*; retry/);
  } finally {
    other.stop();
  }
  writeFileSync(`${p}.lock.takeover`, `${deadPid()}\n`);
  assert.throws(() => acquireLocks([p], { onStale: () => assert.fail("no") }),
    /A takeover of the stale lock for .* was interrupted \(process \d+ is not running\)\. Remove .*installation\.json\.lock and .*installation\.json\.lock\.takeover by hand/);
  assert.ok(existsSync(`${p}.lock.takeover`) && existsSync(`${p}.lock`), "both left for the operator");
});

test("release removes only a lock that still holds this process's token", () => {
  const p = join(tempDir("vbcdx-lock-"), "installation.json");
  const release = acquireLocks([p]);
  const other = liveOther();
  try {
    writeFileSync(`${p}.lock`, `${other.pid} ${other.start}\n`); // someone else's now
    release();
    assert.equal(readFileSync(`${p}.lock`, "utf8"), `${other.pid} ${other.start}\n`, "another holder's lock is never removed");
  } finally {
    other.stop();
  }
});

test("a lock that keeps reappearing stale is not chased forever: three attempts, then refused", () => {
  const p = join(tempDir("vbcdx-lock-"), "installation.json");
  lockOf(p, `${deadPid()}\n`);
  let takeovers = 0;
  const hooks = { afterTakeover: (lock) => { takeovers++; writeFileSync(lock, `${deadPid()}\n`); } };
  assert.throws(() => acquireLocks([p], { onStale: () => {}, hooks }), /it keeps changing; retry/);
  assert.equal(takeovers, 3);
});

// ── fold-ins ───────────────────────────────────────────────

test("F1: the holder is shown as its program (and vbcdx subcommand), never its arguments", () => {
  assert.equal(holderCommand(["/usr/bin/node", "/usr/lib/node_modules/@vbcdx/vbcdx/bin/vbcdx.js", "install", "service", "sidecar", "--enroll-token-file", "/root/t"]),
    "vbcdx install service sidecar");
  assert.equal(holderCommand(["/usr/bin/mysql", "-pS3CRET", "--host", "db"]), "mysql");
  assert.equal(holderCommand(["/tmp/\u001b[31mevil\u0007", "x"]), "[31mevil");
  assert.equal(holderCommand(["vbcdx", "a".repeat(200)]).length <= 80, true);
  assert.equal(holderCommand([]), null);
});

test("F2: a lock that isn't a regular file is held (a symlink isn't followed, a FIFO doesn't block)", () => {
  const d = tempDir("vbcdx-lock-");
  const p = join(d, "installation.json");
  writeFileSync(join(d, "target"), `${deadPid()}\n`);
  symlinkSync(join(d, "target"), `${p}.lock`);
  assert.deepEqual({ ...lockHolder(`${p}.lock`), ageMs: 0 }, { state: "held", pid: null, command: null, ageMs: 0, note: "not a regular file" });
  assert.throws(() => acquireLocks([p], { onStale: () => assert.fail("no") }), /another process \(the lock is not a regular file\)/);
  const q = join(tempDir("vbcdx-lock-"), "installation.json");
  assert.equal(spawnSync("mkfifo", [`${q}.lock`]).status, 0);
  assert.equal(lockHolder(`${q}.lock`).state, "held", "returned without blocking");
});

test("F3/F4: content in no known format, and a PID of 0, are held at any age; never taken over, and 0 is never signalled", () => {
  const kill = process.kill;
  const signalled = [];
  process.kill = (pid, sig) => (signalled.push(pid), kill.call(process, pid, sig));
  try {
    for (const text of ["garbage\n", "123 456 789\n", "0\n", "0 123\n", "-5\n"]) {
      const p = join(tempDir("vbcdx-lock-"), "installation.json");
      lockOf(p, text, { ageMs: LOCK_FRESH_MS * 10 });
      assert.equal(lockHolder(`${p}.lock`).state, "held", JSON.stringify(text));
      assert.throws(() => acquireLocks([p], { onStale: () => assert.fail(`no takeover of ${JSON.stringify(text)}`) }), /holds the lock/);
      assert.equal(readFileSync(`${p}.lock`, "utf8"), text);
    }
  } finally {
    process.kill = kill;
  }
  assert.deepEqual(signalled.filter((pid) => pid <= 0), [], "kill(0, 0) would probe the whole process group");
});

// ── the service commands ────────────────────────────────────────────────────

function release(version = "0.1.0") {
  const root = tempDir("vbcdx-rel-");
  const files = {};
  for (const name of ["vbcdx-sidecar", "vbcdx-svc"]) {
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
function host() {
  const root = tempDir("vbcdx-host-");
  const acct = fakeAccounts();
  const sys = fakeSystem(root, { uid: 0, answer: (cmd, args) => {
    const a = acct.answer(cmd, args);
    if (a) return a;
    if (cmd === "systemctl" && args.includes("is-active")) return { stdout: "active\n" };
    return {};
  } });
  return { acct, sys, root, deps: { sys, trustedKeys: [KEY.pub], platformId: "linux-x64-gnu", host: { uid: 0, home: "/root", runtimeDir: null } } };
}
const run = (argv, h) => runService(parseServiceArgs(argv), h.deps);
const at = (h, p) => join(h.root, p);
const RECORD = "/root/.vbcdx/manifests/installation.json";

test("install and remove proceed over a dead install's lock, and their report warns about it", () => {
  const h = host();
  const rel = release();
  const dead = deadPid();
  lockOf(at(h, RECORD), `${dead}\n`);
  const r = run(["install", "service", "sidecar", "--from", rel], h);
  assert.equal(r.report.changed, true);
  assert.deepEqual(r.report.warnings, [`took over the lock for ${at(h, RECORD)}: process ${dead} is not running`]);
  assert.match(humanReport(r.kind, r.report), new RegExp(`^warning: took over the lock for .*: process ${dead} is not running\\nInstalled service sidecar`));
  const dead2 = deadPid();
  lockOf(at(h, RECORD), `${dead2}\n`);
  const rm = run(["remove", "service", "sidecar", "--wipe"], h);
  assert.deepEqual(rm.report.warnings, [`took over the lock for ${at(h, RECORD)}: process ${dead2} is not running`]);
  assert.deepEqual(run(["list", "services"], h).report.services, []);
  assert.ok(!existsSync(at(h, `${RECORD}.lock`)), "released");
});

test("a dry run reports the lock as the real run will meet it: held refuses (exit 4), stale is taken over", () => {
  const h = host();
  const rel = release();
  const other = liveOther();
  try {
    lockOf(at(h, RECORD), `${other.pid} ${other.start}\n`);
    const held = run(["install", "service", "sidecar", "--from", rel, "--dry-run"], h);
    assert.equal(held.code, 4, "the real run would refuse with exit 4, so the dry run does too");
    assert.match(humanPlan(held.report), new RegExp(`LOCK .*installation\\.json\\.lock is held by process ${other.pid} \\(sleep\\), for \\d+ s: install would refuse \\(exit 4\\)`));
    assert.throws(() => run(["install", "service", "sidecar", "--from", rel], h), (e) => e.code === 4 && new RegExp(`process ${other.pid}`).test(e.message));
  } finally {
    other.stop();
  }
  const dead = deadPid();
  lockOf(at(h, RECORD), `${dead}\n`);
  const stale = run(["install", "service", "sidecar", "--from", rel, "--dry-run"], h);
  assert.equal(stale.code, 0);
  assert.match(humanPlan(stale.report), new RegExp(`lock .* is stale \\(process ${dead} is not running\\): install takes it over`));
  assert.equal(readFileSync(at(h, `${RECORD}.lock`), "utf8"), `${dead}\n`, "a dry run takes nothing over");
  assert.deepEqual(h.sys.calls, [], "and runs no command");
});

// What a SIGKILL between the unit write and the record leaves: binaries, config, an enabled
// unit and the user, with no record.
function interrupted(h) {
  for (const [p, body] of [["/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-sidecar", "x"], ["/usr/local/lib/vbcdx/sidecar/0.1.0/vbcdx-svc", "x"],
    ["/etc/vbcdx/default/sidecar.toml", "# partial\n"], ["/etc/systemd/system/vbcdx-sidecar-default.service", "[Unit]\n"]]) {
    mkdirSync(dirname(at(h, p)), { recursive: true });
    writeFileSync(at(h, p), body);
  }
  mkdirSync(at(h, "/var/lib/vbcdx/default"), { recursive: true });
  mkdirSync(at(h, "/etc"), { recursive: true });
  writeFileSync(at(h, "/etc/passwd"), "root:x:0:0::/root:/bin/sh\nvbcdx:x:999:991::/var/lib/vbcdx:/usr/sbin/nologin\n");
}
const LEFT = ["/etc/vbcdx/default/sidecar.toml", "/etc/systemd/system/vbcdx-sidecar-default.service", "/var/lib/vbcdx/default",
  "/etc/vbcdx/default", "/usr/local/lib/vbcdx/sidecar/0.1.0", "user vbcdx"];

test("a dry run after an interrupted install lists what it left as 'exists, not recorded'", () => {
  const h = host();
  interrupted(h);
  const dry = run(["install", "service", "sidecar", "--from", release(), "--dry-run"], h);
  assert.deepEqual([...dry.report.leftovers].sort(), [...LEFT].sort());
  const text = humanPlan(dry.report);
  for (const f of LEFT) assert.ok(text.includes(`exists, not recorded: ${f} (left by an interrupted install; install adopts it)`), f);
  assert.deepEqual(h.sys.calls, [], "the check runs no command");
});

test("doctor for an instance no record names: names each leftover and a stale lock (exit 5); with nothing left it is 'not installed' as before", () => {
  const h = host();
  assert.throws(() => run(["doctor", "--service", "sidecar"], h), /No sidecar instance "default" is installed/);
  interrupted(h);
  const dead = deadPid();
  lockOf(at(h, RECORD), `${dead}\n`);
  const d = run(["doctor", "--service", "sidecar"], h);
  assert.equal(d.code, 5);
  assert.deepEqual(d.report.checks.filter((c) => c.check === "unrecorded leftover").map((c) => c.detail).sort(), [...LEFT].sort());
  assert.ok(d.report.checks.some((c) => c.check === "install record lock" && c.detail.includes(`process ${dead} is not running`)));
  const text = humanReport(d.kind, d.report);
  assert.match(text, /^doctor sidecar \(default, not installed\): problems found/);
  assert.match(text, /rerun vbcdx install service sidecar to finish it$/);
});

test("another recorded instance of the service: its shared user and binaries are not leftovers of this one", () => {
  const h = host();
  run(["install", "service", "sidecar", "--from", release(), "--instance", "s2", "--listen", "unix:/run/vbcdx/s2.sock"], h);
  interrupted(h);
  const dry = run(["install", "service", "sidecar", "--from", release(), "--dry-run"], h);
  assert.ok(!dry.report.leftovers.includes("user vbcdx") && !dry.report.leftovers.some((f) => f.startsWith("/usr/local/lib/vbcdx/sidecar/")));
  assert.ok(dry.report.leftovers.includes("/etc/systemd/system/vbcdx-sidecar-default.service"), "this instance's own files still are");
});

test("a dry run of a reinstall over a recorded instance lists no leftovers: its files are recorded", () => {
  const h = host();
  const rel = release();
  run(["install", "service", "sidecar", "--from", rel], h);
  const dry = run(["install", "service", "sidecar", "--from", rel, "--dry-run"], h);
  assert.deepEqual(dry.report.leftovers, []);
  assert.doesNotMatch(humanPlan(dry.report), /exists, not recorded/);
});
