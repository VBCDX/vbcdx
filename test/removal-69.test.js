// The installer never removed a file it stopped rendering. A role taken
// out of the git binding (or a `git_url` removed) dropped the `terminal.env_passthrough`
// owned key but left `profiles/<id>/bin/hermes-git` on disk, with its manifest entry.
// On `init` such a leftover is now planned as a removal: deleted when it still matches
// the digest the installer recorded, a conflict (kept, reported, deleted only with
// `--force`) when it was edited by hand, and only ever a file the manifest records as
// written by the installer, for a role and target this run renders, inside that
// target's own directory.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { init, parseInitArgs, buildPlan } from "../src/index.js";
import { executePlan } from "../src/executor.js";
import { parseEnvFile } from "../src/config/env-parser.js";
import { readManifest } from "../src/fs/manifest.js";
import { EXIT } from "../src/errors.js";
import { sha256, removeManagedFile } from "../src/fs/safe-writer.js";
import { planRemovals } from "../src/planner.js";
import { classifyRemoval, applyRemoval } from "../src/fs/manifest.js";
import { FIXTURE_IDS, PACK_ARG } from "./helpers/fixture-pack.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "vbcdx-dev-agents.js");
const roots = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); roots.push(d); return d; };
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const read = (p) => readFileSync(p, "utf8");
const tool = (name, effect) => ({ name, description: name, inputSchema: {}, outputSchema: {}, effect, required_permissions: [] });

/** A Forgejo integration file. `gitUrl` and `gitRoles` (default: every bound role) decide who gets the git helper. */
function writeIntegrations(dir, { gitUrl, roles = ["code-agent"], gitRoles = roles } = {}) {
  writeFileSync(join(dir, "forgejo.json"), JSON.stringify({
    schema_version: 1, service: "forgejo", contract: "vbcdx.forgejo/1", package_version: "0.1.0",
    tools: [tool("create_comment", "write"), tool("whoami", "read")],
  }));
  const file = join(dir, "integrations.json");
  writeFileSync(file, JSON.stringify({
    schema_version: 1,
    services: {
      forgejo: {
        server_name: "forgejo", manifest_file: join(dir, "forgejo.json"),
        transport: "http", url: "https://gw.example/mcp/Forgejo", roles,
        ...(gitUrl ? { git_url: gitUrl, git_roles: Object.fromEntries(gitRoles.map((r) => [r, "fork"])) } : {}),
      },
    },
  }));
  chmodSync(file, 0o600);
  return file;
}

/** A Hermes install root whose git binding can be changed between runs. */
function env({ gitUrl = "https://git.example", roles = ["code-agent"] } = {}) {
  const root = tmp("vbcdx-69-");
  const cfg = join(root, "config.env");
  const write = ({ gitUrl: gu = gitUrl, roles: rl = roles, gitRoles = rl } = {}) => {
    const integ = writeIntegrations(root, { gitUrl: gu, roles: rl, gitRoles });
    writeFileSync(cfg, [
      `VBCDX_AGENTS_BASE_DIR=${root}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${root}/creds`,
      `VBCDX_AGENTS_HERMES_HOME=${root}/hermes`, `VBCDX_AGENTS_INTEGRATIONS_FILE=${integ}`,
    ].join("\n") + "\n");
    return cfg;
  };
  write();
  const manifestPath = join(root, "state", "manifests", "installation.json");
  return {
    root, cfg, write, manifestPath,
    prof: (id) => join(root, "hermes", "profiles", id),
    helper: (id) => join(root, "hermes", "profiles", id, "bin", "hermes-git"),
    manifest: () => JSON.parse(read(manifestPath)),
    rewriteManifest: (m) => writeFileSync(manifestPath, JSON.stringify(m, null, 2)),
  };
}

const args = (e, more = []) => [PACK_ARG, "--harness=hermes", "--env=" + e.cfg, ...more];

// ---- the main case: a role the render stops giving git access to

test("a role removed from git_roles loses bin/hermes-git, and its record", () => {
  const e = env({ roles: ["code-agent", "pm-agent"] });
  init(args(e, ["--agents=code-agent,pm-agent"]));
  assert.ok(existsSync(e.helper("code-agent")) && existsSync(e.helper("pm-agent")));
  assert.ok(Object.hasOwn(e.manifest().files, e.helper("pm-agent")));

  // pm-agent is taken out of git_roles but stays bound: its render no longer produces the helper.
  e.write({ gitRoles: ["code-agent"] });
  const report = init(args(e, ["--agents=code-agent,pm-agent"]));

  assert.equal(existsSync(e.helper("pm-agent")), false, "the leftover helper must be gone");
  assert.equal(Object.hasOwn(e.manifest().files, e.helper("pm-agent")), false, "its manifest entry goes with it");
  assert.deepEqual(report.removals, [{ role: "pm-agent", destination: e.helper("pm-agent"), action: "remove" }]);
  // the role that still has git keeps its helper, and nothing else was rewritten
  assert.ok(existsSync(e.helper("code-agent")));
  assert.ok(report.generated.filter((g) => g.destination.startsWith(e.prof("code-agent"))).every((g) => g.action === "noop"));

  // a rerun has nothing left to do
  const again = init(args(e, ["--agents=code-agent,pm-agent"]));
  assert.deepEqual(again.removals, []);
});

test("a leftover that was edited by hand is kept and reported as a conflict; --force deletes it", () => {
  const e = env();
  init(args(e, ["--agents=code-agent"]));
  const helper = e.helper("code-agent");
  writeFileSync(helper, read(helper) + "\n# operator tweak\n");
  const edited = read(helper);
  const conf = join(e.prof("code-agent"), "config.yaml");
  const confBefore = read(conf); // the no-git render would update this owned key
  e.write({ gitUrl: null });

  const run = args(e, ["--agents=code-agent"]);
  try {
    init(run);
    assert.fail("a hand-edited leftover must be a conflict");
  } catch (err) {
    assert.equal(err.code, EXIT.CONFLICT, err.message);
    assert.match(err.message, /nothing was written/);
    assert.ok(err.message.includes(helper), err.message);
    assert.match(err.message, /--force deletes it/);
  }
  assert.equal(read(helper), edited, "the edited leftover is kept");
  assert.ok(Object.hasOwn(e.manifest().files, helper), "its record is kept with it");
  assert.equal(read(conf), confBefore, "and no definition was written before the refusal");

  // the same refusal in a dry run, which still deletes nothing
  const dry = init([...run, "--dry-run"]);
  assert.deepEqual(dry.conflicts, [helper]);
  assert.deepEqual(dry.removals, [{ role: "code-agent", destination: helper, action: "conflict" }]);
  assert.equal(read(helper), edited);
  const cli = spawnSync(process.execPath, [BIN, "init", ...run, "--dry-run"], { encoding: "utf8" });
  assert.equal(cli.status, EXIT.CONFLICT, cli.stderr);
  assert.ok(cli.stderr.includes(helper));

  // --force deletes it, and its record
  const forced = init([...run, "--force"]);
  assert.equal(existsSync(helper), false);
  assert.deepEqual(forced.removals, [{ role: "code-agent", destination: helper, action: "forced" }]);
  assert.equal(Object.hasOwn(e.manifest().files, helper), false);
});

test("a dry run lists the planned removal and deletes nothing; a real run counts it", () => {
  const e = env();
  init(args(e, ["--agents=code-agent"]));
  const helper = e.helper("code-agent");
  e.write({ gitUrl: null });

  const dry = init(args(e, ["--agents=code-agent", "--dry-run"]));
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.removals, [{ role: "code-agent", destination: helper, action: "remove" }]);
  assert.ok(existsSync(helper), "a dry run writes nothing");
  assert.ok(Object.hasOwn(e.manifest().files, helper));

  const cli = spawnSync(process.execPath, [BIN, "init", PACK_ARG, ...args(e, ["--agents=code-agent", "--dry-run"])], { encoding: "utf8" });
  assert.equal(cli.status, EXIT.OK, cli.stderr);
  assert.match(cli.stdout, /Planned install /);
  assert.match(cli.stdout, /removal code-agent: remove -> /);
  assert.match(cli.stdout, /removals: 1 file\(s\)/);

  const real = spawnSync(process.execPath, [BIN, "init", PACK_ARG, ...args(e, ["--agents=code-agent"])], { encoding: "utf8" });
  assert.equal(real.status, EXIT.OK, real.stderr);
  assert.match(real.stdout, /Applied install /);
  assert.match(real.stdout, /removals: 1 file\(s\)/);
  assert.equal(existsSync(helper), false);
});

// ---- what must never be a removal

test("an unrecorded file in the profile is never touched", () => {
  const e = env();
  init(args(e, ["--agents=code-agent"]));
  const notes = join(e.prof("code-agent"), "notes.txt");
  const mine = join(e.prof("code-agent"), "bin", "my-script");
  writeFileSync(notes, "operator notes\n");
  writeFileSync(mine, "#!/bin/sh\necho mine\n");
  e.write({ gitUrl: null });

  const report = init(args(e, ["--agents=code-agent"]));
  assert.equal(existsSync(e.helper("code-agent")), false);
  assert.equal(read(notes), "operator notes\n");
  assert.equal(read(mine), "#!/bin/sh\necho mine\n");
  assert.deepEqual(report.removals.map((r) => r.destination), [e.helper("code-agent")]);
});

test("a run for one role never prunes another role's leftover", () => {
  const e = env({ roles: ["code-agent", "pm-agent"] });
  init(args(e, ["--agents=code-agent,pm-agent"]));
  // Both helpers would now be leftovers, but this run renders code-agent only.
  e.write({ gitUrl: null, roles: ["code-agent"] });

  const report = init(args(e, ["--agents=code-agent"]));
  assert.equal(existsSync(e.helper("pm-agent")), true, "an unselected role's file is never touched");
  assert.ok(Object.hasOwn(e.manifest().files, e.helper("pm-agent")));
  assert.equal(existsSync(e.helper("code-agent")), false);
  assert.deepEqual(report.removals.map((r) => r.destination), [e.helper("code-agent")]);
});

test("a manifest record outside the run's target root is never removed", () => {
  const e = env();
  init(args(e, ["--agents=code-agent"]));
  e.write({ gitUrl: null });
  // A corrupted or hand-edited manifest that records a path outside this run's target
  // root: it must not become a removal candidate.
  const outside = join(e.root, "outside.txt");
  writeFileSync(outside, "leave me\n");
  const m = e.manifest();
  m.files[outside] = { digest: sha256(readFileSync(outside)), mode: 0o644, role: "code-agent", harness: "hermes", package_version: "0.1.0" };
  e.rewriteManifest(m);

  const report = init(args(e, ["--agents=code-agent"]));
  assert.equal(existsSync(outside), true);
  assert.equal(read(outside), "leave me\n");
  assert.deepEqual(report.removals.map((r) => r.destination), [e.helper("code-agent")]);
});

test("a leftover already deleted by hand is not a removal and keeps its record", () => {
  const e = env();
  init(args(e, ["--agents=code-agent"]));
  const helper = e.helper("code-agent");
  rmSync(helper);
  e.write({ gitUrl: null });

  const report = init(args(e, ["--agents=code-agent"]));
  assert.deepEqual(report.removals, []);
  assert.ok(Object.hasOwn(e.manifest().files, helper), "the record is left for a later rerun to repair");
  const dry = init(args(e, ["--agents=code-agent", "--dry-run"]));
  assert.deepEqual(dry.removals, [], "and is not reported as a planned removal");
});

test("a leftover a symlink replaced is refused, never followed", () => {
  const e = env();
  init(args(e, ["--agents=code-agent"]));
  const helper = e.helper("code-agent");
  const real = join(e.root, "real-helper");
  // identical bytes, so the recorded digest still matches: only the no-follow rules stop it
  writeFileSync(real, read(helper));
  rmSync(helper);
  symlinkSync(real, helper);
  e.write({ gitUrl: null });

  try {
    init(args(e, ["--agents=code-agent"]));
    assert.fail("removing a symlinked path must be refused");
  } catch (err) {
    assert.equal(err.code, EXIT.FILESYSTEM, err.message);
    assert.match(err.message, /symlink/i);
  }
  assert.equal(existsSync(real), true, "the link's target is untouched");
  assert.equal(lstatSync(helper).isSymbolicLink(), true, "the link itself is untouched");
});

test("a removal target is locked like every other managed destination", () => {
  const e = env();
  init(args(e, ["--agents=code-agent"]));
  const helper = e.helper("code-agent");
  e.write({ gitUrl: null });
  writeFileSync(helper + ".lock", `${process.pid}\n`); // as another run holding it would

  try {
    init(args(e, ["--agents=code-agent"]));
    assert.fail("the removal target must be locked");
  } catch (err) {
    assert.equal(err.code, EXIT.FILESYSTEM, err.message);
    assert.match(err.message, /lock/i);
  }
  assert.equal(existsSync(helper), true, "nothing was removed");

  rmSync(helper + ".lock");
  assert.deepEqual(init(args(e, ["--agents=code-agent"])).removals.map((r) => r.destination), [helper]);
  assert.equal(existsSync(helper), false);
});

test("the removal locks and the removals come from one manifest read, taken under the manifest lock (finding 2)", () => {
  const e = env({ roles: ["code-agent", "pm-agent"] });
  init(args(e, ["--agents=code-agent,pm-agent"]));
  e.write({ gitRoles: ["code-agent"] }); // pm-agent's helper becomes a leftover
  // A concurrent run, after this run's first look at the manifest, records a leftover of
  // its own in pm-agent's profile and still holds its lock. Any read after the first sees
  // that record; a run that applied removals from such a read would delete it unlocked.
  const racer = join(e.prof("pm-agent"), "bin", "racer-tool");
  const content = "written by the other run\n";
  writeFileSync(racer, content);
  writeFileSync(racer + ".lock", `${process.pid}\n`);
  const record = { digest: sha256(Buffer.from(content)), mode: 0o644, role: "pm-agent", harness: "hermes",
    package_version: "0.1.0", written_at: new Date().toISOString() };
  const reads = [];
  const racingRead = (path, version) => {
    reads.push(existsSync(path + ".lock"));
    const m = readManifest(path, version);
    if (reads.length > 1) m.files[racer] = record;
    return m;
  };
  const argv = args(e, ["--agents=pm-agent"]);
  try {
    const report = executePlan(buildPlan(parseInitArgs(argv), parseEnvFile(e.cfg), {}), { readManifest: racingRead });
    assert.deepEqual(report.removals.map((r) => r.destination), [e.helper("pm-agent")]);
  } finally { rmSync(racer + ".lock"); }
  assert.deepEqual(reads, [true], "one read, with the manifest lock held");
  assert.equal(existsSync(racer), true, "a file this run did not lock is never removed");
  assert.equal(existsSync(e.helper("pm-agent")), false);
});

// ---- unit: the candidate set, guard by guard

const manifestOf = (files) => ({ schema_version: 1, package: "@vbcdx/dev-agents", package_version: "0.1.0", files });
const digest = (c) => c.repeat(64);

test("planRemovals takes only what the render stopped producing, for a rendered role and target, under its root", () => {
  const root = join(tmp("vbcdx-69-unit-"), "hermes", "profiles");
  const at = (rel) => join(root, rel);
  const plan = {
    harness: "hermes", roles: ["code-agent"],
    generated: [
      { role: "code-agent", harness: "hermes", destination: at("code-agent/SOUL.md") },
      { role: "pm-agent", harness: "hermes", destination: at("pm-agent/SOUL.md") },
    ],
  };
  const entry = (extra = {}) => ({ role: "code-agent", harness: "hermes", digest: digest("a"), ...extra });
  const never = {
    "still rendered": { [at("code-agent/SOUL.md")]: entry() },
    "another role": { [at("pm-agent/bin/hermes-git")]: entry({ role: "pm-agent" }) },
    "another harness": { [at("code-agent/bin/hermes-git")]: entry({ harness: "claude" }) },
    "outside the root": { "/etc/passwd": entry() },
    "a sibling that only shares the root's prefix": { [root + "-evil/bin/hermes-git"]: entry() },
    "a path that walks out of the root": { [root + "/code-agent/../../outside"]: entry() },
    "no digest recorded": { [at("code-agent/bin/hermes-git")]: entry({ digest: undefined }) },
    "not an entry": { [at("code-agent/bin/hermes-git")]: null },
  };
  for (const [label, files] of Object.entries(never)) {
    assert.deepEqual(planRemovals(plan, manifestOf(files)), [], label);
  }
  const odd = entry({ digest: digest("b") });
  assert.deepEqual(
    planRemovals({ ...plan, roles: ["code-agent", "pm-agent"] }, manifestOf({ [at("code-agent/bin/hermes-git")]: odd })),
    [{ role: "code-agent", destination: at("code-agent/bin/hermes-git"), digest: digest("b") }],
  );
});

test("planRemovals removes nothing when the run's own destinations share no usable root", () => {
  const plan = {
    harness: "hermes", roles: ["code-agent"],
    generated: [
      { role: "code-agent", harness: "hermes", destination: "/tmp/vbcdx-a/SOUL.md" },
      { role: "code-agent", harness: "hermes", destination: "/var/tmp/vbcdx-b/SOUL.md" },
    ],
  };
  const files = { "/tmp/vbcdx-a/bin/hermes-git": { role: "code-agent", harness: "hermes", digest: digest("c") } };
  assert.deepEqual(planRemovals(plan, manifestOf(files)), []);
});

// ---- unit: classification and the safe removal itself

test("classifyRemoval: a matching digest removes, a hand edit conflicts, a missing file is absent", () => {
  const dir = tmp("vbcdx-69-classify-");
  const file = join(dir, "helper");
  writeFileSync(file, "one\n");
  const recorded = sha256(Buffer.from("one\n"));
  assert.equal(classifyRemoval(file, recorded), "remove");
  assert.equal(classifyRemoval(file, sha256(Buffer.from("other"))), "conflict");
  assert.equal(classifyRemoval(join(dir, "gone"), recorded), "absent");
});

test("applyRemoval honours the record and --force; removeManagedFile refuses what it must not unlink", () => {
  const dir = tmp("vbcdx-69-apply-");
  const file = join(dir, "helper");
  writeFileSync(file, "one\n");
  const recorded = sha256(Buffer.from("one\n"));
  assert.equal(applyRemoval({ absPath: join(dir, "gone"), recordedDigest: recorded }).action, "absent");

  writeFileSync(file, "two\n"); // edited by hand since it was written
  assert.throws(() => applyRemoval({ absPath: file, recordedDigest: recorded }),
    (err) => err.code === EXIT.CONFLICT && /--force to delete it/.test(err.message));
  assert.equal(read(file), "two\n");
  assert.equal(applyRemoval({ absPath: file, recordedDigest: recorded, force: true }).action, "forced");
  assert.equal(existsSync(file), false);

  const sub = join(dir, "sub");
  mkdirSync(sub);
  assert.throws(() => removeManagedFile(sub), (err) => err.code === EXIT.FILESYSTEM && /Not a regular file/.test(err.message));
  const link = join(dir, "link");
  symlinkSync(sub, link);
  assert.throws(() => removeManagedFile(link), (err) => err.code === EXIT.FILESYSTEM && /symlink/i.test(err.message));
  assert.equal(existsSync(sub), true, "nothing behind the link was removed");
  assert.equal(removeManagedFile(join(dir, "gone")), false);
});
