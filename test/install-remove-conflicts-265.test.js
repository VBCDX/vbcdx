// Follow-up to the previous review's install/remove NITs, NIT 1:
//
// `planOwnedKeysRemove` let a mapping document it cannot safely edit throw out of
// `remove` as a plain error: a top-level `<<` merge key (mergeConfig) and a cyclic
// alias in an owned path (ownedDigest -> canonical recursion). Both are conflicts
// now: the file is left untouched, the manifest record kept, exit 5.
//
// Every case reaches the exported `remove` through real files and the real
// manifest reader/writer, never an internal helper.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tempDir } from "./helpers/temp-dir.js";
import "./helpers/fixture-pack.js";
import { EXIT, InstallerError } from "../src/errors.js";
import { resolveContext } from "../src/install/context.js";
import { catalogueSkills, remove } from "../src/install/commands.js";
import { skillTarget } from "../src/install/harness-targets.js";
import { readManifest, writeManifest } from "../src/fs/manifest.js";
import { ownedDigest } from "../src/fs/hermes-config.js";
import { packageVersion } from "../src/index.js";

const SKILL_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKILL = catalogueSkills().find((s) => typeof s.name === "string" && SKILL_RE.test(s.name) && s.description).name;

function ctxFor(harness) {
  const home = tempDir("vbcdx-265-conflict-");
  return resolveContext({ harness, scope: "user", envPath: null, home, cwd: home, env: {} });
}
function seed(ctx, files) {
  const m = readManifest(ctx.manifestPath, packageVersion());
  m.files = { ...m.files, ...files };
  mkdirSync(dirname(ctx.manifestPath), { recursive: true });
  writeManifest(ctx.manifestPath, m);
}
const manifest = (ctx) => JSON.parse(readFileSync(ctx.manifestPath, "utf8"));
const write = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
const read = (p) => readFileSync(p, "utf8");
const isConflict = (re) => (e) => e instanceof InstallerError && e.code === EXIT.CONFLICT && re.test(e.message);

// A record the way an install leaves one for a merged config key: it owns `vbcdx`
// and recorded some earlier value, so a conflict here is about the document, not
// about the digest of an unchanged key.
function seedOwnedRecord(ctx, dest) {
  const paths = [["vbcdx"]];
  seed(ctx, { [dest]: { skill: SKILL, harness: "claude", owned_paths: paths, owned_digest: ownedDigest({ vbcdx: "as written" }, paths) } });
}

const MAPPING_THAT_THREW = [
  // mergeConfig throws before it can edit: a merge key would supply keys it cannot see.
  ["a top-level << merge key", "base: &b {x: 1}\n<<: *b\nvbcdx: 1\n", /contains a << merge key/],
  // mergeConfig succeeds, then ownedDigest -> canonical recurses forever on the cycle.
  ["a cyclic alias in an owned path", "vbcdx: &a\n  self: *a\n", /Maximum call stack size exceeded/],
];

for (const [label, text, why] of MAPPING_THAT_THREW) {
  test(`remove skill: ${label} is a conflict, left untouched, record kept (exit 5)`, () => {
    const ctx = ctxFor("claude");
    const dest = skillTarget(ctx, SKILL);
    write(dest, text);
    seedOwnedRecord(ctx, dest);

    // A dry run reports the conflict; it never throws a raw internal error.
    const dry = remove(ctx, "skill", SKILL, { dryRun: true });
    assert.deepEqual(dry.conflicts, [dest]);

    // The real run refuses with an installer conflict code and an actionable note.
    assert.throws(() => remove(ctx, "skill", SKILL), isConflict(/cannot be .*; left untouched/));
    // ... and the reason is the one that was caught, not swallowed.
    assert.throws(() => remove(ctx, "skill", SKILL), (e) => e instanceof InstallerError && why.test(e.message));

    // The process is still alive and the file and its record are exactly as they were.
    assert.equal(read(dest), text);
    assert.equal(dest in manifest(ctx).files, true);
    assert.equal(existsSync(dest), true);
  });
}
