// Coverage for the small uncovered branches in tool-package.js, service/system.js,
// service/carry.js, install/args.js and renderers/index.js.
// Each test names the source range it reaches.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, cpSync, chmodSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.js";
import { FIXTURE_IDS } from "./helpers/fixture-pack.js";
import { EXIT } from "../src/errors.js";
import { resolveToolPackage, binLaunch, runToolManifest } from "../src/install/tool-package.js";
import { realSystem, fakeSystem } from "../src/service/system.js";
import { carryOver } from "../src/service/carry.js";
import { parseVbcdxArgs } from "../src/install/args.js";
import { resolveHarnessDir, renderFlat, resolveHermesProfileDir } from "../src/renderers/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_FIXTURE = join(HERE, "fixtures", "tool-package");

const dir = (prefix) => realpathSync(tempDir(prefix));
const isErr = (code, re) => (e) => e.code === code && re.test(e.message);

// --- tool-package.js -------------------------------------------------------------------

// tool-package.js 23: a spec that is not a non-empty string -> configError
test("resolveToolPackage refuses an empty or non-string spec (exit 2)", () => {
  for (const spec of ["", undefined, null, 42]) {
    assert.throws(() => resolveToolPackage(spec), isErr(EXIT.CONFIG, /^install tool needs a package name or path\.$/), String(spec));
  }
});

// tool-package.js 29: a package.json with no version resolves with version ""
test("resolveToolPackage reports version \"\" for a package.json without one", () => {
  const pkgDir = join(dir("vbcdx-cov-tp-"), "pkg");
  cpSync(TOOL_FIXTURE, pkgDir, { recursive: true });
  const pj = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  assert.equal(pj.version, "1.2.3", "the fixture has a version to remove");
  delete pj.version;
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(pj));
  const found = resolveToolPackage(pkgDir);
  assert.equal(found.version, "");
  assert.equal(found.name, "@example/tracker-plugin");
  assert.equal(found.dir, realpathSync(pkgDir));
});

// tool-package.js 34: a string `bin` is the entry for any bin name; 44: a non-node file runs itself
test("binLaunch: a string bin is used whatever the bin name; a non-node script runs directly with a copy of the args", () => {
  const d = dir("vbcdx-cov-bin-");
  mkdirSync(join(d, "bin"));
  writeFileSync(join(d, "bin", "run"), "#!/bin/sh\nexit 0\n");
  const args = ["a", "b"];
  const launch = binLaunch({ dir: d, pkg: { bin: "bin/run" } }, "whatever-name", args);
  assert.deepEqual(launch, { command: join(d, "bin", "run"), args: ["a", "b"] });
  assert.notEqual(launch.args, args, "args are copied, not shared");
  // The node form for contrast: a .js file runs under node.
  writeFileSync(join(d, "bin", "run.js"), "// js\n");
  assert.deepEqual(binLaunch({ dir: d, pkg: { bin: "bin/run.js" } }, "x", ["m"]), { command: "node", args: [join(d, "bin", "run.js"), "m"] });
});

// tool-package.js 36: a bin that resolves outside the package -> configError
test("binLaunch refuses a bin that points outside the package (exit 2)", () => {
  const d = dir("vbcdx-cov-out-");
  mkdirSync(join(d, "pkg"));
  writeFileSync(join(d, "outside"), "#!/bin/sh\n");
  assert.throws(() => binLaunch({ dir: join(d, "pkg"), pkg: { bin: { tool: "../outside" } } }, "tool", []),
    isErr(EXIT.CONFIG, /^Package bin tool points outside the package\.$/));
});

// tool-package.js 37: a declared bin file that does not exist -> configError naming the path
test("binLaunch refuses a bin file that is missing (exit 2)", () => {
  const d = dir("vbcdx-cov-miss-");
  assert.throws(() => binLaunch({ dir: d, pkg: { bin: { tool: "bin/nope" } } }, "tool", []),
    isErr(EXIT.CONFIG, new RegExp(`^Package bin tool is missing: ${join(d, "bin", "nope").replaceAll("/", "\\/")}\\.$`)));
});

// A tool package whose bin is a plain (non-node) file, for the runToolManifest tests.
function shellPackage(body, mode = 0o755) {
  const d = dir("vbcdx-cov-run-");
  mkdirSync(join(d, "bin"));
  writeFileSync(join(d, "bin", "tool"), body);
  chmodSync(join(d, "bin", "tool"), mode);
  return { dir: d, name: "@example/shell-tool", pkg: { bin: { tool: "bin/tool" } },
    declaration: { server_name: "example-tracker", stdio: { bin: "tool" }, manifest: { args: ["manifest"] }, env: [] } };
}
const SAFE_ENV = { PATH: "/usr/bin:/bin" };

// tool-package.js 65 (command = the file itself) and 68: a non-zero exit -> subprocessError naming the status
test("runToolManifest: a non-node bin is run itself and its non-zero exit is a subprocess error (exit 6)", () => {
  const pkg = shellPackage("#!/bin/sh\nexit 3\n");
  assert.throws(() => runToolManifest(pkg, { env: SAFE_ENV }), isErr(EXIT.SUBPROCESS, /^@example\/shell-tool manifest command exited 3\.$/));
});

// tool-package.js 67: spawn failure (a file with no execute bit and no interpreter line) -> subprocessError with the errno code
test("runToolManifest: a bin that cannot be started is a subprocess error naming the errno (exit 6)", () => {
  const pkg = shellPackage("#!/bin/sh\nexit 0\n", 0o644);
  assert.throws(() => runToolManifest(pkg, { env: SAFE_ENV }), isErr(EXIT.SUBPROCESS, /^@example\/shell-tool manifest command failed to run: EACCES\.$/));
});

// tool-package.js 72-74: exit 0 but stdout is not JSON -> subprocessError
test("runToolManifest: output that is not JSON is a subprocess error (exit 6)", () => {
  const pkg = shellPackage("#!/bin/sh\necho 'not json at all'\n");
  assert.throws(() => runToolManifest(pkg, { env: SAFE_ENV }), isErr(EXIT.SUBPROCESS, /^@example\/shell-tool manifest command did not print JSON\.$/));
});

// --- service/system.js -----------------------------------------------------------------

// system.js 61, 63, 64: the real host's passwd home, clock and (blocking) sleep
test("realSystem: passwdHome is the passwd entry's home; now is the wall clock; sleep blocks for about the time asked", () => {
  const sys = realSystem();
  assert.equal(sys.passwdHome(), userInfo().homedir);
  const before = Date.now();
  const t = sys.now();
  assert.ok(Number.isInteger(t) && t >= before && t <= Date.now(), "now() is Date.now()");
  const start = Date.now();
  assert.equal(sys.sleep(30), "timed-out");
  assert.ok(Date.now() - start >= 25, "sleep(30) waited");
  assert.equal(sys.path("/etc/x"), "/etc/x");
  assert.equal(sys.root, "/");
});

// system.js 70: a command that cannot be started -> status 127 with "<cmd>: <errno code>"
test("realSystem.run: a command that does not exist answers status 127 and names the errno", () => {
  const cmd = "/nonexistent-vbcdx-cov/no-such-command";
  assert.deepEqual(realSystem().run(cmd, ["x"]), { status: 127, stdout: "", stderr: `${cmd}: ENOENT` });
});

// system.js 71: a child killed by a signal has no exit status -> status 1
test("realSystem.run: a child ended by a signal answers status 1", () => {
  const r = realSystem().run(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  // And an ordinary exit keeps its own status and output.
  const ok = realSystem().run(process.execPath, ["-e", "process.stdout.write('hi'); process.exitCode = 7"]);
  assert.deepEqual(ok, { status: 7, stdout: "hi", stderr: "" });
});

// system.js 81: fakeSystem's default answer is a silent success, and the call is recorded
test("fakeSystem.run: with no answer given every command succeeds silently and is recorded", () => {
  const sys = fakeSystem("/tmp/vbcdx-cov-fake-root");
  assert.deepEqual(sys.run("anything", ["a", "b"]), { status: 0, stdout: "", stderr: "" });
  assert.deepEqual(sys.calls, [["anything", "a", "b"]]);
});

// --- service/carry.js ------------------------------------------------------------------

function carryHost(files) {
  const root = dir("vbcdx-cov-carry-");
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return fakeSystem(root);
}

// carry.js 107: a setting the installed env file doesn't hold is skipped, not carried as undefined
test("carryOver (dispatch-server): a variable missing from the installed env file is left out; the others are carried", () => {
  const sys = carryHost({ "/etc/vbcdx-dispatch/default/dispatch.env": "# written by install\nVBCDX_LINK_ADDR=127.0.0.1:7001\n" });
  const rec = { unit: "vbcdx-dispatch.service", listen: "127.0.0.1:7000", files: [{ path: "/etc/vbcdx-dispatch/default/dispatch.env" }] };
  const { opts, carried } = carryOver({ service: "dispatch-server", serviceManagerGiven: true }, rec, sys, {});
  assert.equal(opts.linkListen, "127.0.0.1:7001");
  assert.equal(opts.controlUrl, undefined);
  assert.equal(opts.publicUrl, undefined);
  assert.ok(!("controlUrl" in opts) && !("publicUrl" in opts));
  assert.deepEqual(carried, [
    { setting: "listen", value: "127.0.0.1:7000", from: "record" },
    { setting: "link_listen", value: "127.0.0.1:7001", from: "/etc/vbcdx-dispatch/default/dispatch.env" },
  ]);
});

// carry.js 127: a tunnel that is not a string (absent while tunnel_name is set, a number, or an array holding a valid connection string) is refused, not dropped
test("carryOver (control-plane): a non-string or missing tunnel next to a tunnel_name refuses the install (exit 5)", () => {
  const path = "/etc/vbcdx-control/default/control.toml";
  const rec = { unit: "vbcdx-control-plane.service", files: [{ path }] };
  // The array holds a valid connection string, so only the type check (not the pattern) can refuse it.
  for (const [toml, shown] of [['tunnel_name = "cp.example"\n', "tunnel = undefined"], ['tunnel = 5\ntunnel_name = "cp.example"\n', "tunnel = 5"],
    ['tunnel = ["vbcdx+https://cp.example:8443?auth=mtls"]\ntunnel_name = "cp.example"\n', null]]) {
    const sys = carryHost({ [path]: toml });
    assert.throws(() => carryOver({ service: "control-plane", serviceManagerGiven: true }, rec, sys, {}), (e) =>
      e.code === EXIT.CONFLICT && e.details.refused === "carry-over" && e.details.path === path
      && (shown === null || e.message.includes(shown)) && e.message.includes("--no-tunnel"), toml);
  }
});

// --- install/args.js -------------------------------------------------------------------

// args.js 23: an empty item in the agent list
test("parseVbcdxArgs: an agent list with an empty item is refused (exit 2)", () => {
  const id = FIXTURE_IDS[0];
  for (const list of [`${id},,${id}`, `${id},`, `,${id}`]) {
    assert.throws(() => parseVbcdxArgs(["install", "agent", list, "--harness=claude"]), isErr(EXIT.CONFIG, /^The agent list contains an empty item\.$/), list);
  }
  assert.deepEqual(parseVbcdxArgs(["install", "agent", id, "--harness=claude"]).names, [id]);
});

// args.js 86: skill/tool take one name
test("parseVbcdxArgs: install/remove of a skill or tool takes one name, not a comma list (exit 2)", () => {
  for (const [command, kind] of [["install", "skill"], ["install", "tool"], ["remove", "skill"], ["remove", "tool"]]) {
    assert.throws(() => parseVbcdxArgs([command, kind, "a,b", "--harness=claude"]), isErr(EXIT.CONFIG, new RegExp(`^${command} ${kind} takes one name\\.$`)), `${command} ${kind}`);
  }
  assert.deepEqual(parseVbcdxArgs(["install", "skill", "a", "--harness=claude"]).names, ["a"]);
});

// args.js 89-90: list / doctor / packs take no positional argument (fetch and sources go through the same check: test/simplified-paths-pins.test.js)
test("parseVbcdxArgs: list, doctor and packs refuse a positional argument (exit 2)", () => {
  for (const command of ["list", "doctor", "packs"]) {
    assert.throws(() => parseVbcdxArgs([command, "extra", "--harness=claude"]), isErr(EXIT.CONFIG, new RegExp(`^${command} takes no positional arguments\\.$`)), command);
  }
});

// --- renderers/index.js ----------------------------------------------------------------

// index.js 16, 19: scope needs its root
test("resolveHarnessDir: project scope needs a worktree, user scope needs the harness root (exit 2)", () => {
  assert.throws(() => resolveHarnessDir("claude", "project", { harnessRoot: "/h", worktreeRoot: null }),
    isErr(EXIT.CONFIG, /^Project scope requires a containing Git worktree\.$/));
  for (const harness of ["claude", "codex", "opencode"]) {
    assert.throws(() => resolveHarnessDir(harness, "user", { harnessRoot: undefined, worktreeRoot: "/w" }),
      isErr(EXIT.CONFIG, new RegExp(`^User scope requires the ${harness} configuration root\\.$`)), harness);
  }
  // With the roots present the destinations are native.
  assert.equal(resolveHarnessDir("claude", "project", { worktreeRoot: "/w" }), "/w/.claude/agents");
  assert.equal(resolveHarnessDir("codex", "user", { harnessRoot: "/h" }), "/h/agents");
});

// index.js 27-29: renderFlat only knows claude, codex, opencode
test("renderFlat: a harness that is not a flat-file one is refused before the role is touched (exit 2)", () => {
  for (const harness of ["hermes", "nonsense"]) {
    assert.throws(() => renderFlat(harness, undefined, {}), isErr(EXIT.CONFIG, new RegExp(`^Unknown flat-file harness: ${harness}$`)), harness);
  }
});

// index.js 33: Hermes needs HERMES_HOME
test("resolveHermesProfileDir: no HERMES_HOME is refused; with one the profile dir is <home>/profiles/<id> (exit 2)", () => {
  for (const home of [undefined, null, ""]) {
    assert.throws(() => resolveHermesProfileDir(home, FIXTURE_IDS[0]), isErr(EXIT.CONFIG, /^Hermes requires the HERMES_HOME configuration root\.$/));
  }
  assert.equal(resolveHermesProfileDir("/hh", FIXTURE_IDS[0]), `/hh/profiles/${FIXTURE_IDS[0]}`);
});

// carry.js 164: an error from the injected system seam that carries no code is reported by its first
// message line only, and the install is refused (exit 5)
test("carryOver (dispatch-server): a seam error without a code is reported by its first line and refuses the install", () => {
  const base = carryHost({});
  const sys = { ...base, path: () => { throw new Error("seam failed\nsecond line"); } };
  const rec = { unit: "vbcdx-dispatch.service", listen: "127.0.0.1:7000", files: [{ path: "/etc/vbcdx-dispatch/default/dispatch.env" }] };
  assert.throws(() => carryOver({ service: "dispatch-server", serviceManagerGiven: true }, rec, sys, {}), (e) => {
    assert.equal(e.code, EXIT.CONFLICT);
    assert.equal(e.details.refused, "carry-over");
    assert.match(e.message, /can't be read \(seam failed\)/);
    assert.doesNotMatch(e.message, /second line|undefined/);
    return true;
  });
});
