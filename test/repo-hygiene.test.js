// Repo-hygiene guards for configuration that is easy to regress silently: the ignore rules
// for local environment files, the lint script's exit path, the Forgejo pack step's tarball
// name, and the action pins in both CI workflows. Each is a fact the files state; a change
// that undoes it fails here rather than in a review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

test(".gitignore ignores a repo-root .env and *.local.env, and keeps .env.example", () => {
  const ignored = (p) => spawnSync("git", ["check-ignore", "-q", p], { cwd: ROOT }).status === 0;
  assert.equal(ignored(".env"), true, ".env is ignored");
  assert.equal(ignored("nested/.env"), true, "a nested .env is ignored too");
  assert.equal(ignored("nested/x.local.env"), true, "*.local.env is ignored");
  assert.equal(ignored(".env.example"), false, ".env.example stays tracked");
});

test("scripts/lint.mjs sets the exit code instead of calling process.exit", () => {
  const src = read("scripts/lint.mjs");
  assert.match(src, /process\.exitCode\s*=/, "sets process.exitCode");
  assert.doesNotMatch(src, /process\.exit\(/, "does not call process.exit (which can truncate a piped summary)");
});

test("the Forgejo pack step reads the tarball name from npm pack --json, not a glob", () => {
  const src = read(".forgejo/workflows/ci.yml");
  assert.match(src, /npm pack --json/, "asks npm for the packed file name");
  assert.match(src, /expected exactly one packed tarball/, "refuses anything but exactly one tarball");
  assert.doesNotMatch(src, /ls vbcdx-vbcdx-\*\.tgz/, "no glob a stale second tarball breaks");
});

test("CI actions are pinned to full commit SHAs, except the gate's own job", () => {
  const PINS = {
    "actions/checkout": "11bd71901bbe5b1630ceea73d27597364c9af683",
    "actions/setup-node": "49933ea5288caeca8642d1e84afbd3f7d6820020",
  };
  // The job each `uses:` is in, by the two-space job keys of these workflows.
  const usesInJobs = (src) => {
    const out = [];
    let job = null;
    for (const line of src.split("\n")) {
      const key = /^ {2}([A-Za-z0-9_-]+):[ \t]*$/.exec(line);
      if (key) job = key[1];
      const m = /uses:\s*(actions\/(?:checkout|setup-node))@(\S+)/.exec(line);
      if (m) out.push({ job, action: m[1], ref: m[2] });
    }
    return out;
  };
  // `.github` has no gate job: every checkout/setup-node is pinned.
  for (const u of usesInJobs(read(".github/workflows/ci.yml"))) {
    assert.equal(u.ref, PINS[u.action], `.github/workflows/ci.yml ${u.action} is pinned, not ${u.ref}`);
  }
  // `.forgejo`: pinned everywhere the general-use gate does not byte-protect. The gate
  // refuses a pull request that edits its own job (it must stay identical to the base), so
  // that job's two actions stay at `@v4` until a pin lands through the forge's workflow-path
  // protection; every other action in the file is pinned now.
  const forgejo = usesInJobs(read(".forgejo/workflows/ci.yml"));
  for (const u of forgejo) {
    if (u.job === "general-use") continue;
    assert.equal(u.ref, PINS[u.action], `.forgejo/workflows/ci.yml ${u.action} (${u.job}) is pinned, not ${u.ref}`);
  }
  assert.ok(forgejo.some((u) => u.job === "general-use"), "the general-use job is still present");
  assert.ok(forgejo.some((u) => u.job !== "general-use"), "a job outside the gate is pinned");
});
