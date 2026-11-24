// Test fixture, loaded into the two spawned entrypoints only, with `node --require`.
//
// It answers this checkout's own package.json read with the same readFileSync call against a
// directory that genuinely has no package.json, so an entrypoint run from the repo can be put in
// its "damaged install" state without copying the tree. A copy cannot be used for that: it lives
// outside the repo root, and scripts/coverage.mjs measuredPath() drops every report whose path is
// not a .js under bin/ or src/ inside the root (a copy inside the root merges under its own path,
// which nobody publishes). The child therefore stays the real published entrypoint at its real
// path, and the ENOENT stays a real readFileSync failure — only which directory is read is chosen
// here.
//
// One call is intercepted, and only in this shape. Anything else — a different path, a file
// descriptor, a URL, the same path with other arguments, or a second read of it — either passes
// through untouched or throws, so a test cannot quietly depend on a second crash. The guards are
// unconditional on purpose: this file fails loudly rather than adapting to how it was loaded.
//
// It lives here, not under test/, because `node --test` with no arguments discovers every .cjs
// under test/ and would run this file as a test: its "VBCDX_TEST_DAMAGED_ROOT is not set" guard
// then fails the suite. scripts/ is not a discovery root (the runner looks for *.test.cjs,
// test-*.cjs, test.cjs and test/**/*.cjs), it is still syntax-checked by scripts/lint.mjs, and
// package.json `files` does not publish it. Do not move it back under test/.
const fs = require("node:fs");
const { join } = require("node:path");

const repo = fs.realpathSync(join(__dirname, "..", ".."));
const root = process.env.VBCDX_TEST_DAMAGED_ROOT;
if (!root) throw new Error("package-json-missing.cjs: VBCDX_TEST_DAMAGED_ROOT is not set");
const damaged = join(fs.realpathSync(root), "package.json");
if (fs.existsSync(damaged)) {
  throw new Error(`package-json-missing.cjs: the damaged root has a package.json: ${damaged}`);
}

const watched = join(repo, "package.json");
const real = fs.readFileSync;
let redirected = 0;

fs.readFileSync = function (p, ...rest) {
  if (String(p) !== watched) return real(p, ...rest);
  if (rest.length !== 1 || rest[0] !== "utf8") {
    throw new Error(`package-json-missing.cjs: unexpected arguments for ${watched}`);
  }
  if (++redirected > 1) throw new Error("package-json-missing.cjs: the package.json read happened twice");
  return real(damaged, ...rest);
};
