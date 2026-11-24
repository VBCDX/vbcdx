// A merged config whose YAML document is not a mapping is classified as a
// conflict, never thrown: whether the document is literally `null`, an empty file (which
// also parses to null), a sequence, a scalar or a top-level timestamp (a PyTimestamp
// object that is not a plain Object.prototype mapping), removal refuses (exit 5), leaves
// the file untouched and keeps the manifest record. --force has nothing to fall back on
// for a document it cannot edit in place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tempDir } from "./helpers/temp-dir.js";
import "./helpers/fixture-pack.js";
import { EXIT } from "../src/errors.js";
import { resolveContext } from "../src/install/context.js";
import { catalogueSkills, remove } from "../src/install/commands.js";
import { skillTarget } from "../src/install/harness-targets.js";
import { readManifest, writeManifest } from "../src/fs/manifest.js";
import { packageVersion } from "../src/index.js";

const ZERO = "0".repeat(64);
const SKILL_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKILL = catalogueSkills().find((s) => typeof s.name === "string" && SKILL_RE.test(s.name) && s.description).name;

function ctxFor(harness) {
  const home = tempDir("vbcdx-252-");
  return resolveContext({ harness, scope: "user", envPath: null, home, cwd: home, env: {} });
}
// The installer's own manifest, plus a record (written through the real reader/writer).
function seed(ctx, files) {
  const m = readManifest(ctx.manifestPath, packageVersion());
  m.files = { ...m.files, ...files };
  mkdirSync(dirname(ctx.manifestPath), { recursive: true });
  writeManifest(ctx.manifestPath, m);
}
const manifest = (ctx) => JSON.parse(readFileSync(ctx.manifestPath, "utf8"));
const write = (p, text) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); };
const isErr = (code, re) => (e) => e.code === code && re.test(e.message);

for (const [label, raw] of [["null", "null\n"], ["empty", ""], ["sequence", "[]\n"], ["timestamp", "2026-01-02\n"], ["scalar", "hello\n"]]) {
  test(`remove skill: an owned-keys ${label} document is a conflict, left untouched`, () => {
    const ctx = ctxFor("claude");
    const dest = skillTarget(ctx, SKILL);
    write(dest, raw);
    seed(ctx, { [dest]: { skill: SKILL, harness: "claude", owned_paths: [["vbcdx"]], owned_digest: ZERO } });

    assert.deepEqual(remove(ctx, "skill", SKILL, { dryRun: true }).conflicts, [dest]);

    assert.throws(() => remove(ctx, "skill", SKILL), isErr(EXIT.CONFLICT, /it is not a mapping; left untouched/));
    assert.equal(readFileSync(dest, "utf8"), raw);
    assert.equal(dest in manifest(ctx).files, true);

    // A non-mapping document has no owned keys to remove, so --force cannot delete it either.
    assert.throws(() => remove(ctx, "skill", SKILL, { force: true }), isErr(EXIT.CONFLICT, /it is not a mapping; left untouched/));
    assert.equal(readFileSync(dest, "utf8"), raw);
    assert.equal(dest in manifest(ctx).files, true);
  });
}
