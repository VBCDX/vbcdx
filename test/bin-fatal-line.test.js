// The crash line of both entrypoints: a command that rejects before it can report prints one
// "fatal:" line and the caller's own stack frames, then exits 1 — never Node's
// unhandled-rejection report. `--version` is the reachable path: it is the one command that
// reads package.json outside a try/catch (bin/vbcdx.js:270, bin/vbcdx-dev-agents.js:87),
// through packageVersion() (src/index.js:17).
//
// The install is a damaged one: package.json is gone. The child is the real published entrypoint,
// spawned from the repo root, and the damage is applied by scripts/fixtures/package-json-missing.cjs
// (`node --require`, children only): it answers this checkout's own package.json read with the
// same readFileSync call against an empty directory, so the rejection, the message, the frames and
// the exit code are all produced by the real code and a real syscall, and only the directory read
// is chosen by the fixture. No copy is involved, and that is what makes the reports measurable:
//
//   - a copy outside the repo root is dropped whole by scripts/coverage.mjs measuredPath()
//     (`:83-92`, `:106-109`), which keeps only a .js under bin/ or src/ inside the root;
//   - a copy under bin/ or src/ would merge under its own path — an entry nobody publishes —
//     because addProcessCoverage looks the path up through measuredPath() (`:108`, `:83-92`);
//   - moving the handler into a measured module moves the hole instead of closing it: the
//     rejection callback still only runs in a process that crashes.
//
// The fixture sits under scripts/, not under test/, because `node --test` with no arguments
// discovers every .cjs under test/ and would run it as a test file, where its fail-loud guard
// ("VBCDX_TEST_DAMAGED_ROOT is not set") fails the suite. scripts/ is not a discovery root, it is
// still syntax-checked by scripts/lint.mjs, and package.json `files` does not publish it. Moving it
// back under test/ puts the suite back to red.
//
// So this row both pins the behaviour and supplies the coverage: at this head the coverage job
// reports bin/vbcdx.js 401/401 and bin/vbcdx-dev-agents.js 128/128, not 395/401 and 122/128.
//
// The redaction arm is pinned deliberately, not incidentally: `--version` is name-shaped, so
// redactTyped shows it by design (src/shown.js:83-86, `:94`) and it can never be the redacted
// token. The damaged root is therefore also passed as the second argument, which makes the crash
// message genuinely contain a typed value — the same path the fixture reads — and the assertions
// below require it to come back as "<argument 2>" while the rest of the path survives.
//
// Not claimed here: the crash-path arms below stay unreachable, so branches stay below 100
// (lines and functions reach 100). They are a source decision with its own panel:
// bin/vbcdx.js:398 / :399 (`e && e.stack ? … : []` and `… : String(e)`), and
// bin/vbcdx-dev-agents.js:125 / :126, and bin/a2a-server.js:27 (`… : String(err)`).
// bin/a2a-server.js:36 is NOT one: coverage-v2v3-g3.test.js:255 takes the 8080 arm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.js";

// Real path: Node and V8 report the URL a module was loaded from with symlinks resolved, and the
// frame assertion below compares against it.
const ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const PRELOAD = join(ROOT, "scripts", "fixtures", "package-json-missing.cjs");

// The damaged root is empty and the test never writes into it, so it really has no package.json.
// It is also argv[2] of the child (see the header): process.argv.slice(2) is ["--version", dir],
// and --version ignores what follows it.
const run = (bin) => {
  const dir = tempDir("vbcdx-fatal-damaged-");
  const r = spawnSync(
    process.execPath,
    ["--require", PRELOAD, join(ROOT, "bin", bin), "--version", dir],
    {
      encoding: "utf8",
      timeout: 30000,
      cwd: ROOT,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        TMPDIR: dir,
        XDG_RUNTIME_DIR: dir,
        NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE,
        VBCDX_TEST_DAMAGED_ROOT: dir,
      },
    },
  );
  return { r, dir };
};

// One test per entrypoint: same line, same kind of frames, same status.
for (const bin of ["vbcdx.js", "vbcdx-dev-agents.js"]) {
  test(`${bin}: a missing package.json is one fatal line and exit 1, not an unhandled rejection`, () => {
    const { r, dir } = run(bin);
    const lines = r.stderr.replace(/\n$/, "").split("\n");
    // The read failure is one line, naming the file it could not open and nothing else. The one
    // typed value in the message — the damaged root, passed as argument 2 — is redacted, and the
    // rest of the path is kept: redacting the whole line would fail the suffix assertion.
    const fatal = lines.filter((l) => l.startsWith("fatal: "));
    assert.equal(fatal.length, 1, r.stderr);
    assert.equal(fatal[0], "fatal: ENOENT: no such file or directory, open '<argument 2>/package.json'");
    assert.ok(fatal[0].endsWith("/package.json'"), `the path after the argument must survive: ${fatal[0]}`);
    assert.equal(fatal[0].includes(dir), false, "the typed path must not come back: " + r.stderr);
    // The status is the handler's exit, not a module-load or uncaught-exception death: the fatal
    // line is the first line and there is no Node report under it.
    assert.equal(lines[0], fatal[0], r.stderr);
    assert.doesNotMatch(r.stderr, /^Node\.js v/m, r.stderr);
    assert.doesNotMatch(r.stderr, /^Error:/m, r.stderr);
    // Everything after it is one frame per line, and the frames kept are the caller's own. One of
    // them names the repo's own src/index.js: that is the coverage claim made visible here — the
    // process that crashed is this checkout, not a copy.
    const frames = lines.slice(lines.indexOf(fatal[0]) + 1);
    assert.ok(frames.length > 0, `the handler kept no frames: ${r.stderr}`);
    for (const frame of frames) assert.match(frame, /^\s+at /, frame);
    assert.ok(frames.some((f) => f.includes("packageVersion")), r.stderr);
    assert.ok(frames.some((f) => f.includes(join(ROOT, "src", "index.js"))), r.stderr);
    // The line ends with a newline of its own, and Node's own report for a rejection nobody
    // handled would say this instead.
    assert.ok(r.stderr.endsWith("\n"), "the fatal line must end with a newline: " + JSON.stringify(r.stderr));
    assert.doesNotMatch(r.stderr, /UnhandledPromiseRejection|ERR_INVALID_PACKAGE_CONFIG/);
    assert.equal(r.stdout, "");
    assert.equal(r.status, 1);
    assert.equal(r.signal, null);
  });
}
