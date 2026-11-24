// Follow-up to the previous review's install/remove NITs, NIT 2:
//
// "Plain object" had two definitions: `remove` required
// `Object.getPrototypeOf(v) === Object.prototype`, the Hermes config classifier did
// not. Both use src/fs/plain-object.js now, so a top-level timestamp is not a
// mapping on either side. This test pins the shared classification for the
// documents that review listed, and that ordinary mappings still work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "./helpers/temp-dir.js";
import "./helpers/fixture-pack.js";
import { EXIT, InstallerError } from "../src/errors.js";
import { resolveContext } from "../src/install/context.js";
import { catalogueSkills, remove } from "../src/install/commands.js";
import { skillTarget } from "../src/install/harness-targets.js";
import { readManifest, writeManifest } from "../src/fs/manifest.js";
import { classifyHermesConfig, mergeConfig, ownedDigest, ownedPaths } from "../src/fs/hermes-config.js";
import { sha256 } from "../src/fs/safe-writer.js";
import { parsePy } from "../src/fs/pyyaml.js";
import { packageVersion } from "../src/index.js";

const SKILL_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SKILL = catalogueSkills().find((s) => typeof s.name === "string" && SKILL_RE.test(s.name) && s.description).name;

function ctxFor(harness) {
  const home = tempDir("vbcdx-265-plain-");
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

function seedOwnedRecord(ctx, dest) {
  const paths = [["vbcdx"]];
  seed(ctx, { [dest]: { skill: SKILL, harness: "claude", owned_paths: paths, owned_digest: ownedDigest({ vbcdx: "as written" }, paths) } });
}

const NOT_A_MAPPING = [
  ["a null document", "null\n"],
  ["an empty document", ""],
  ["a sequence", "- a\n- b\n"],
  ["a top-level timestamp", "2026-01-02\n"],
  ["a top-level << merge key", "base: &b {x: 1}\n<<: *b\n"],
];

for (const [label, text] of NOT_A_MAPPING) {
  test(`install and remove classify ${label} the same way (conflict)`, () => {
    const ctx = ctxFor("claude");
    const dest = skillTarget(ctx, SKILL);
    write(dest, text);
    seedOwnedRecord(ctx, dest);

    const dry = remove(ctx, "skill", SKILL, { dryRun: true });
    assert.deepEqual(dry.conflicts, [dest], "remove says conflict");
    assert.throws(() => remove(ctx, "skill", SKILL), (e) => e instanceof InstallerError && e.code === EXIT.CONFLICT);
    assert.equal(read(dest), text);
    assert.equal(dest in manifest(ctx).files, true);

    // The install side is the exported classifier the executor uses. A recorded
    // entry whose owned value differs makes ownership the only open question.
    const rendered = "model:\n  default: new\n";
    const recorded = { owned_paths: [["model"]], owned_digest: ownedDigest({ model: { default: "old" } }, [["model"]]) };
    const report = classifyHermesConfig(dest, rendered, recorded);
    assert.equal(report.cls, "conflict", "install says conflict");
    // The classification read the file; it did not change it.
    assert.equal(read(dest), text);
  });
}

test("install and remove still handle an ordinary mapping", () => {
  const ctx = ctxFor("claude");
  const dest = skillTarget(ctx, SKILL);
  const text = "vbcdx: as written\nkeep: me\n";
  write(dest, text);
  const paths = [["vbcdx"]];
  seed(ctx, { [dest]: { skill: SKILL, harness: "claude", owned_paths: paths, owned_digest: ownedDigest({ vbcdx: "as written" }, paths) } });

  // Removal takes out the owned key and keeps the operator's key.
  assert.deepEqual(remove(ctx, "skill", SKILL).removed, [{ path: dest, action: "remove" }]);
  assert.doesNotMatch(read(dest), /vbcdx:/);
  assert.match(read(dest), /keep: me/);
  assert.equal(dest in manifest(ctx).files, false);

  // The install classifier still calls an ordinary, owned mapping an update.
  const rendered = "model:\n  default: new\n";
  const onDisk = "model:\n  default: old\nkeep: 1\n";
  const renderedPaths = ownedPaths(parsePy(rendered));
  const recorded = { owned_paths: renderedPaths, owned_digest: ownedDigest(parsePy(onDisk), renderedPaths) };
  const profile = join(ctx.home, "profile.yaml");
  write(profile, onDisk);
  const report = classifyHermesConfig(profile, rendered, recorded);
  assert.equal(report.cls, "update");
  assert.match(report.content, /keep: 1/);
});

test("an owned key whose parent is a scalar gets the map the key needs", () => {
  // The owned path's parent exists but is not a map: it is replaced by a map, so the
  // merged document holds the rendered key instead of a value the key cannot live in.
  const merged = mergeConfig("agent: 1\n", { agent: { disabled_toolsets: ["x"] } }, [["agent", "disabled_toolsets"]]);
  assert.deepEqual(parsePy(merged), { agent: { disabled_toolsets: ["x"] } });
});

test("a whole-file digest alone decides ownership when the entry has no owned paths", () => {
  const profile = join(tempDir("vbcdx-265-digest-"), "profile.yaml");
  const onDisk = "model:\n  default: old\nkeep: 1\n";
  write(profile, onDisk);
  const rendered = "model:\n  default: new\n";

  // A manifest entry from before key-level ownership records only the whole file's
  // digest; matching the bytes on disk makes the file ours, so this is an update.
  const asWritten = classifyHermesConfig(profile, rendered, { digest: sha256(Buffer.from(onDisk)) });
  assert.equal(asWritten.cls, "update");
  assert.match(asWritten.content, /keep: 1/);

  // Neither owned paths nor a digest: nothing says the file is ours, so it is a conflict.
  const unrecorded = classifyHermesConfig(profile, rendered, {});
  assert.equal(unrecorded.cls, "conflict");
  assert.match(unrecorded.note, /not recorded as written by the installer/);
});
