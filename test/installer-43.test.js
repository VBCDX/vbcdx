// The installer vs Hermes Web UI, and runs that stop part-way.
//  1. A Hermes profile's config.yaml is merged on the keys the installer owns, so a
//     Web UI setting (agent.reasoning_effort) survives and does not make the next
//     run refuse the profile; a hand edit of an owned key still conflicts.
//  2. Every conflict is refused before the first write, all of them listed.
//  3. --dry-run reports the same classification, conflicts included (CLI exit 5).
//  4. A run that fails after writing some files still records them as owned.
//  5. A credential file an earlier version left on disk changes none of this: it is
//     warned about by path, never read, and never an exit code of its own.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { stringify as yamlStringify } from "yaml";
import { init, parseInitArgs, buildPlan } from "../src/index.js";
import { executePlan } from "../src/executor.js";
import { parseEnvFile } from "../src/config/env-parser.js";
import { EXIT, InstallerError } from "../src/errors.js";
import { mergeConfig, ownedPaths, ownedDigest, classifyHermesConfig } from "../src/fs/hermes-config.js";
import { PYYAML, parsePy, stringifyPy } from "../src/fs/pyyaml.js";
import { FIXTURE_IDS, PACK_ARG } from "./helpers/fixture-pack.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "vbcdx-dev-agents.js");
const roots = [];
after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function hermesEnv({ model = "qwen3-14b" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "vbcdx-43-"));
  roots.push(root);
  const write = (m) => {
    const p = join(root, "config.env");
    const routing = m ? [`VBCDX_AGENTS_HERMES_BASE_URL=https://llm.example/v1`, `VBCDX_AGENTS_HERMES_MODEL=${m}`] : [];
    writeFileSync(p, [
      `VBCDX_AGENTS_BASE_DIR=${root}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${root}/creds`,
      `VBCDX_AGENTS_HERMES_HOME=${root}/hermes`, ...routing,
    ].join("\n") + "\n");
    return p;
  };
  return {
    root,
    cfg: write(model),
    withModel: write,
    conf: (id) => join(root, "hermes", "profiles", id, "config.yaml"),
    manifest: () => JSON.parse(readFileSync(join(root, "state", "manifests", "installation.json"), "utf8")),
  };
}

const read = (p) => readFileSync(p, "utf8");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const actionFor = (report, dest) => report.generated.find((g) => g.destination === dest).action;

// What Hermes Web UI does when it saves one setting: load the file, set the key,
// write the whole document back in another style (different key order and
// indentation). A real PyYAML save is test/fixtures/hermes-webui-save.yaml.
function webUiSave(path, mutate) {
  const doc = parsePy(read(path));
  mutate(doc);
  const reordered = Object.fromEntries(Object.keys(doc).sort().reverse().map((k) => [k, doc[k]]));
  writeFileSync(path, yamlStringify(reordered, { ...PYYAML, indent: 4 }));
}
// Read the way Hermes (PyYAML) reads it; test/pyyaml.test.js checks this against PyYAML.
const hermesRead = (path) => parsePy(read(path));

test("a Web UI setting in config.yaml survives reruns and an update; the profile is not refused", () => {
  const e = hermesEnv();
  init([PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=pm-agent"]);
  webUiSave(e.conf("pm-agent"), (d) => { d.agent.reasoning_effort = "high"; });

  // Same render: no refusal, nothing rewritten, the setting is kept.
  const again = init([PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=pm-agent"]);
  assert.equal(actionFor(again, e.conf("pm-agent")), "noop");
  assert.equal(hermesRead(e.conf("pm-agent")).agent.reasoning_effort, "high");

  // A render change (new model) updates the owned keys and keeps the setting.
  const upd = init([PACK_ARG, "--harness=hermes", "--env=" + e.withModel("qwen3-coder"), "--agents=pm-agent"]);
  assert.equal(actionFor(upd, e.conf("pm-agent")), "update");
  const doc = hermesRead(e.conf("pm-agent"));
  assert.equal(doc.agent.reasoning_effort, "high");
  assert.equal(doc.model.default, "qwen3-coder");
  assert.ok(Array.isArray(doc.agent.disabled_toolsets) && doc.agent.disabled_toolsets.length > 0);
});

// The Web UI saves with PyYAML, which quotes the strings 'on'/'off' (booleans in YAML
// 1.1) and writes a real boolean bare. An update must hand Hermes back the same values.
test("an update keeps PyYAML-quoted strings strings and bare booleans booleans", () => {
  const e = hermesEnv();
  init([PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=pm-agent"]);
  // exactly what PyYAML's safe_dump writes for these values
  writeFileSync(e.conf("pm-agent"), read(e.conf("pm-agent")) + "display:\n  memory_notifications: 'on'\n  tool_progress: 'off'\n  bell: yes\n");
  assert.deepEqual(hermesRead(e.conf("pm-agent")).display, { memory_notifications: "on", tool_progress: "off", bell: true });
  const upd = init([PACK_ARG, "--harness=hermes", "--env=" + e.withModel("qwen3-coder"), "--agents=pm-agent"]);
  assert.equal(actionFor(upd, e.conf("pm-agent")), "update");
  const doc = hermesRead(e.conf("pm-agent"));
  assert.deepEqual(doc.display, { memory_notifications: "on", tool_progress: "off", bell: true });
  assert.equal(doc.model.default, "qwen3-coder");
});

// The installer's own render goes through the PyYAML writer. A model named "yes" is a
// plain string to YAML 1.2 (the yaml package's default writer leaves it bare), but PyYAML
// reads a bare yes as True, so only the PyYAML writer hands Hermes the string.
test("the rendered config.yaml is written for PyYAML: a model named yes stays a string", () => {
  const e = hermesEnv({ model: "yes" });
  init([PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=pm-agent"]);
  const doc = hermesRead(e.conf("pm-agent"));
  assert.equal(doc.model.default, "yes");
  assert.equal(doc.custom_providers[0].model, "yes");
});

// A key the installer starts owning in this run, which the operator had already set,
// is refused like a foreign file, not overwritten as an update.
test("a newly owned key that the operator already set to a different value conflicts", () => {
  const e = hermesEnv({ model: null }); // no routing: the installer does not own `model` yet
  init([PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=pm-agent"]);
  webUiSave(e.conf("pm-agent"), (d) => { d.model = { default: "operator-pick" }; });
  try {
    init([PACK_ARG, "--harness=hermes", "--env=" + e.withModel("qwen3-coder"), "--agents=pm-agent"]);
    assert.fail("an operator-set key the installer starts owning must conflict");
  } catch (err) {
    assert.equal(err.code, EXIT.CONFLICT);
  }
  assert.equal(hermesRead(e.conf("pm-agent")).model.default, "operator-pick");
});

// The same value is adopted. It reaches the adoption check only when another owned
// key changes too (an all-equal render is a noop first): here custom_providers is new.
test("a newly owned key the operator already set to the rendered value is adopted as an update", () => {
  const ref = hermesEnv({ model: "qwen3-coder" });
  init([PACK_ARG, "--harness=hermes", "--env=" + ref.cfg, "--agents=pm-agent"]);
  const renderedModel = hermesRead(ref.conf("pm-agent")).model;

  const e = hermesEnv({ model: null });
  init([PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=pm-agent"]);
  webUiSave(e.conf("pm-agent"), (d) => { d.model = renderedModel; });
  const upd = init([PACK_ARG, "--harness=hermes", "--env=" + e.withModel("qwen3-coder"), "--agents=pm-agent"]);
  assert.equal(actionFor(upd, e.conf("pm-agent")), "update");
  assert.deepEqual(hermesRead(e.conf("pm-agent")).model, renderedModel);
  assert.ok(e.manifest().files[e.conf("pm-agent")].owned_paths.some((p) => p.join(".") === "model"));
});

// An integer beyond 2^53 (a BigInt) in an owned key is an ordinary hand edit: a conflict
// that names the file (exit 5, dry run included), and --force gets through.
test("an integer beyond 2^53 in an owned key is a conflict naming the file; --force gets through", () => {
  const e = hermesEnv();
  init([PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=pm-agent"]);
  const text = read(e.conf("pm-agent"));
  assert.ok(/^model:\n/m.test(text));
  writeFileSync(e.conf("pm-agent"), text.replace(/^model:\n/m, "model:\n  context_length: 100000000000000000000\n"));
  const args = [PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=pm-agent"];
  try {
    init(args);
    assert.fail("a hand edit of an owned key must conflict");
  } catch (err) {
    assert.equal(err.code, EXIT.CONFLICT, err.message);
    assert.ok(err.message.includes(e.conf("pm-agent")));
    assert.match(err.message, /a key the installer owns was edited/);
  }
  const cli = spawnSync(process.execPath, [BIN, "init", PACK_ARG, ...args, "--dry-run"], { encoding: "utf8" });
  assert.equal(cli.status, EXIT.CONFLICT, cli.stderr);
  const forced = init([PACK_ARG, ...args, "--force"]);
  assert.equal(actionFor(forced, e.conf("pm-agent")), "forced");
  assert.ok(!Object.hasOwn(hermesRead(e.conf("pm-agent")).model, "context_length"));
});

test("the ownership digest tells apart values JSON cannot", () => {
  const d = (v) => ownedDigest({ model: v }, [["model"]]);
  const values = [null, NaN, Infinity, -Infinity, 10n ** 20n, "#int:100000000000000000000", 1e20, "#float:nan", { $int: "1" }];
  assert.equal(new Set(values.map(d)).size, values.length);
});

test("a config.yaml that exists but cannot be read is a conflict, not an install", () => {
  const e = hermesEnv();
  init([PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=pm-agent"]);
  const rendered = read(e.conf("pm-agent"));
  const dir = join(e.root, "is-a-directory.yaml");
  mkdirSync(dir);
  const c = classifyHermesConfig(dir, rendered, undefined);
  assert.equal(c.cls, "conflict");
  assert.match(c.note, /EISDIR/);
});

test("an update keeps every key where it was; only owned values change", () => {
  const e = hermesEnv();
  init([PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=pm-agent"]);
  webUiSave(e.conf("pm-agent"), (d) => { d.display = { theme: "dark" }; }); // reverse key order, as a foreign writer might
  const order = Object.keys(hermesRead(e.conf("pm-agent")));
  const upd = init([PACK_ARG, "--harness=hermes", "--env=" + e.withModel("qwen3-coder"), "--agents=pm-agent"]);
  assert.equal(actionFor(upd, e.conf("pm-agent")), "update");
  assert.deepEqual(Object.keys(hermesRead(e.conf("pm-agent"))), order);
});

// A file the installer cannot edit the way Hermes (PyYAML) reads it is never rewritten.
// A raw U+2028 (a line break to PyYAML, text to the yaml package) makes it unreadable, so
// every run refuses it; a << merge key is readable, so a rerun that changes nothing is a
// noop, but an update would replace merged-in values and is refused.
test("a config.yaml the installer cannot edit the way Hermes reads it is refused, never rewritten", () => {
  const expectConflict = (args) => {
    try {
      init(args);
      assert.fail("must conflict");
    } catch (err) {
      assert.equal(err.code, EXIT.CONFLICT, err.message);
    }
  };
  for (const [extra, rerun] of [[`note: "x${String.fromCharCode(0x2028)}y"\n`, "conflict"], ["base: &b {theme: dark}\ndisplay:\n  <<: *b\n", "noop"]]) {
    const e = hermesEnv();
    init([PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=pm-agent"]);
    writeFileSync(e.conf("pm-agent"), read(e.conf("pm-agent")) + extra);
    const before = read(e.conf("pm-agent"));
    const same = [PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=pm-agent"];
    if (rerun === "noop") assert.equal(actionFor(init(same), e.conf("pm-agent")), "noop");
    else expectConflict(same);
    const update = [PACK_ARG, "--harness=hermes", "--env=" + e.withModel("qwen3-coder"), "--agents=pm-agent"];
    expectConflict(update);
    assert.equal(read(e.conf("pm-agent")), before);
    // The refusal says that --force here replaces the whole file, in the error and
    // in the dry run, and that is what --force does: keys the installer does not own go.
    try { init(update); } catch (err) { assert.match(err.message, /--force replaces the whole file/); }
    const dry = spawnSync(process.execPath, [BIN, "init", PACK_ARG, ...update, "--dry-run"], { encoding: "utf8" });
    assert.equal(dry.status, EXIT.CONFLICT);
    assert.match(dry.stderr, /--force replaces the whole file/);
    init([PACK_ARG, ...update, "--force"]);
    const after = hermesRead(e.conf("pm-agent"));
    assert.equal(after.model.default, "qwen3-coder");
    assert.ok(!Object.hasOwn(after, "note") && !Object.hasOwn(after, "display"));
  }
});

test("a hand edit of an owned key conflicts; every conflict is refused before any write", () => {
  const e = hermesEnv();
  init([PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=pm-agent,adversarial-auditor"]);
  webUiSave(e.conf("pm-agent"), (d) => { d.platform_toolsets.cli = [...d.platform_toolsets.cli, "browser"]; });
  const ivanBefore = read(e.conf("adversarial-auditor"));

  // The new model would update both profiles; pm-agent's owned key was edited.
  const changed = e.withModel("qwen3-coder");
  try {
    init([PACK_ARG, "--harness=hermes", "--env=" + changed, "--agents=pm-agent,adversarial-auditor"]);
    assert.fail("an edited owned key must conflict");
  } catch (err) {
    assert.equal(err.code, EXIT.CONFLICT);
    assert.match(err.message, /nothing was written/);
    assert.ok(err.message.includes(e.conf("pm-agent")));
  }
  assert.equal(read(e.conf("adversarial-auditor")), ivanBefore, "no profile is touched when any file conflicts");

  // --force replaces the owned keys, and still keeps keys the installer does not own.
  webUiSave(e.conf("pm-agent"), (d) => { d.agent.reasoning_effort = "high"; });
  const forced = init([PACK_ARG, "--harness=hermes", "--env=" + changed, "--agents=pm-agent,adversarial-auditor", "--force"]);
  assert.equal(actionFor(forced, e.conf("pm-agent")), "forced");
  const doc = hermesRead(e.conf("pm-agent"));
  assert.ok(!doc.platform_toolsets.cli.includes("browser"));
  assert.equal(doc.agent.reasoning_effort, "high");
});

test("--dry-run reports the real classification, conflicts included, and the CLI exits 5", () => {
  const e = hermesEnv();
  init([PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=pm-agent,adversarial-auditor"]);
  webUiSave(e.conf("pm-agent"), (d) => { d.platform_toolsets.cli = []; });
  const before = read(e.conf("pm-agent"));
  const changed = e.withModel("qwen3-coder");

  const dry = init([PACK_ARG, "--harness=hermes", "--env=" + changed, "--agents=pm-agent,adversarial-auditor", "--dry-run"]);
  assert.deepEqual(dry.conflicts, [e.conf("pm-agent")]);
  assert.equal(actionFor(dry, e.conf("pm-agent")), "conflict");
  assert.equal(actionFor(dry, e.conf("adversarial-auditor")), "update");
  assert.equal(read(e.conf("pm-agent")), before, "a dry run writes nothing");

  const cli = spawnSync(process.execPath, [BIN, "init", PACK_ARG, "--harness=hermes", "--env=" + changed, "--agents=pm-agent,adversarial-auditor", "--dry-run"], { encoding: "utf8" });
  assert.equal(cli.status, EXIT.CONFLICT);
  assert.ok(cli.stderr.includes(e.conf("pm-agent")));

  const forcedDry = init([PACK_ARG, "--harness=hermes", "--env=" + changed, "--agents=pm-agent,adversarial-auditor", "--dry-run", "--force"]);
  assert.deepEqual(forcedDry.conflicts, []);
  assert.equal(actionFor(forcedDry, e.conf("pm-agent")), "forced");
});

test("a run that fails after writing some files still records them as package-owned", () => {
  // No pre-check can see this one: the second definition's write fails (injected, as a full
  // disk would) after the first was written, and that stops the run.
  const root = mkdtempSync(join(tmpdir(), "vbcdx-43-late-"));
  roots.push(root);
  const cfg = join(root, "config.env");
  writeFileSync(cfg, [`VBCDX_AGENTS_BASE_DIR=${root}/state`, `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${root}/claude`, ""].join("\n"));
  const args = parseInitArgs(["--harness=claude", "--env=" + cfg, "--agents=code-agent"]);
  const plan = buildPlan(args, parseEnvFile(cfg));
  assert.equal(plan.generated.length, 1);
  let calls = 0;
  const failing = { toString() { calls++; throw new InstallerError(EXIT.FILESYSTEM, "injected: no space left on device"); } };
  const second = join(root, "claude", "agents", "late.md");
  plan.generated.push({ ...plan.generated[0], destination: second, content: failing, digest: sha256("never written") });
  assert.throws(() => executePlan(plan), (err) => {
    assert.equal(err.code, EXIT.FILESYSTEM, err.message);
    assert.match(err.message, /injected/);
    return true;
  });
  assert.equal(calls, 1, "the failure came from the second write");
  assert.ok(!existsSync(second));
  const written = join(root, "claude", "agents", "code-agent.md");
  assert.ok(existsSync(written), "the definition was written before the failure");
  const manifest = JSON.parse(readFileSync(join(root, "state", "manifests", "installation.json"), "utf8"));
  assert.ok(manifest.files[written], "the written file is recorded despite the failure");
  assert.equal(manifest.files[second], undefined, "the file that was not written is not recorded");
  // The recorded digest must be the bytes actually on disk, not merely presence
  // of an entry (restores an assertion an earlier rework dropped).
  assert.equal(manifest.files[written].digest, sha256(readFileSync(written)), "the recorded digest is the file's bytes");
});

test("a manifest entry from before key-level ownership is adopted when the owned keys match", () => {
  const e = hermesEnv();
  init([PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=pm-agent"]);
  // Downgrade the entry to the old shape (whole-file digest only), then do what the
  // operator did live: a Web UI setting, so the file no longer matches that digest.
  const mpath = join(e.root, "state", "manifests", "installation.json");
  const m = e.manifest();
  delete m.files[e.conf("pm-agent")].owned_paths;
  delete m.files[e.conf("pm-agent")].owned_digest;
  writeFileSync(mpath, JSON.stringify(m));
  webUiSave(e.conf("pm-agent"), (d) => { d.agent.reasoning_effort = "high"; });

  const again = init([PACK_ARG, "--harness=hermes", "--env=" + e.cfg, "--agents=pm-agent"]);
  assert.equal(actionFor(again, e.conf("pm-agent")), "noop");
  assert.ok(e.manifest().files[e.conf("pm-agent")].owned_digest, "adoption records key-level ownership");
  const upd = init([PACK_ARG, "--harness=hermes", "--env=" + e.withModel("qwen3-coder"), "--agents=pm-agent"]);
  assert.equal(actionFor(upd, e.conf("pm-agent")), "update");
  assert.equal(hermesRead(e.conf("pm-agent")).agent.reasoning_effort, "high");
});

test("mergeConfig replaces owned keys, drops ones no longer rendered, keeps the rest", () => {
  const onDisk = {
    platform_toolsets: { cli: ["old"] },
    agent: { disabled_toolsets: ["x"], reasoning_effort: "high" },
    mcp_servers: { forgejo: { url: "old" }, mine: { command: "x" } },
    display: { theme: "dark" },
  };
  const rendered = { platform_toolsets: { cli: ["new"] }, agent: { disabled_toolsets: ["y"] } };
  const previous = [["platform_toolsets"], ["agent", "disabled_toolsets"], ["mcp_servers", "forgejo"]];
  const merged = parsePy(mergeConfig(stringifyPy(onDisk), rendered, previous));
  assert.deepEqual(merged, {
    platform_toolsets: { cli: ["new"] },
    agent: { disabled_toolsets: ["y"], reasoning_effort: "high" },
    mcp_servers: { mine: { command: "x" } },
    display: { theme: "dark" },
  });
  // Key order (also inside an owned value) and formatting do not change
  // ownership; values do.
  const two = { platform_toolsets: { cli: ["a"], telegram: ["b"] }, agent: { disabled_toolsets: ["y"] } };
  const paths = ownedPaths(two);
  const reordered = { agent: { disabled_toolsets: ["y"] }, platform_toolsets: { telegram: ["b"], cli: ["a"] } };
  assert.equal(ownedDigest(reordered, paths), ownedDigest(two, paths));
  assert.notEqual(ownedDigest({ ...two, platform_toolsets: { cli: ["a", "browser"], telegram: ["b"] } }, paths), ownedDigest(two, paths));
});

// A credential file an earlier version left behind is not part of the pre-check: it is never
// read, so it cannot refuse a run, and it never has an exit code of its own.
function leftoverEnv() {
  const e = hermesEnv();
  const creds = join(e.root, "creds");
  const soul = join(e.root, "hermes", "profiles", "pm-agent", "SOUL.md");
  // The file an earlier version refused in every way it could: a secret on the ROLE line, mode
  // 0644, in a directory that is not private.
  const leave = () => {
    mkdirSync(creds, { recursive: true });
    chmodSync(creds, 0o755);
    const f = join(creds, "pm-agent.env");
    writeFileSync(f, 'VBCDX_AGENTS_ROLE="SECRET-ON-THE-ROLE-LINE"\nVBCDX_AGENTS_TOKEN="SECRET-TOKEN"\n');
    chmodSync(f, 0o644);
    return f;
  };
  return { e, cfg: e.cfg, creds, soul, leave };
}

const CONFLICT_BLOCK = /would be refused as modified outside the installer|Refusing to overwrite \d+ file\(s\) modified outside the installer/;
const LEFTOVER_WARNING = /^warning: 1 credential file\(s\) written by an earlier version are still on disk and are no longer read: /m;
const LEFTOVER_ROWS = [
  { stimulus: "neither", conflict: false, leftover: false, exit: EXIT.OK },
  { stimulus: "conflict only", conflict: true, leftover: false, exit: EXIT.CONFLICT },
  { stimulus: "leftover only", conflict: false, leftover: true, exit: EXIT.OK },
  { stimulus: "both", conflict: true, leftover: true, exit: EXIT.CONFLICT },
];

test("a leftover credential file warns and decides nothing: the exit code is the conflict's alone, dry run and real run", async (t) => {
  for (const row of LEFTOVER_ROWS) {
    for (const mode of ["dry", "real"]) {
      await t.test(`${mode === "dry" ? "--dry-run" : "real run"} / ${row.stimulus}`, () => {
        const { cfg, soul, creds, leave } = leftoverEnv();
        const handWritten = "# a definition the installer does not own\n";
        if (row.conflict) {
          mkdirSync(dirname(soul), { recursive: true });
          writeFileSync(soul, handWritten);
        }
        const file = row.leftover ? leave() : null;
        const before = file ? [read(file), statSync(file).mode, statSync(file).mtimeMs, statSync(creds).mode] : null;

        const args = ["init", PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent"];
        if (mode === "dry") args.push("--dry-run");
        const cli = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
        const cell = `${mode}/${row.stimulus}`;

        // Exit 3 is never used: a leftover is 0 by itself, and a conflict is 5 with or without one.
        assert.equal(cli.status, row.exit, `exit ${row.exit} for ${cell}\nstderr: ${cli.stderr}`);
        if (row.conflict) assert.match(cli.stderr, CONFLICT_BLOCK, cell);
        else assert.doesNotMatch(cli.stderr, CONFLICT_BLOCK, cell);
        // The warning names the file whenever it is there, and only then. On a real run a
        // conflict is refused before the report is printed, so the warning is the dry run's.
        if (row.leftover && !(row.conflict && mode === "real")) {
          assert.match(cli.stderr, LEFTOVER_WARNING, cell);
          assert.ok(cli.stderr.includes(file), `the leftover is named (${cell})`);
        } else {
          assert.doesNotMatch(cli.stderr, /credential file/, cell);
        }
        assert.doesNotMatch(cli.stdout, /credential/, cell);
        // No byte of the file is echoed, and the file and its directory are exactly as they were.
        assert.doesNotMatch(cli.stdout + cli.stderr, /SECRET-ON-THE-ROLE-LINE|SECRET-TOKEN/, cell);
        if (file) assert.deepEqual([read(file), statSync(file).mode, statSync(file).mtimeMs, statSync(creds).mode], before, cell);
        else assert.ok(!existsSync(creds), `no credentials directory is created (${cell})`);

        if (row.conflict) assert.equal(read(soul), handWritten, `the conflicting definition is untouched (${cell})`);
        else assert.equal(existsSync(soul), mode === "real", `the definition is written only by a real run (${cell})`);
      });
    }
  }
});

test("no umask makes a run create a credentials directory, at any depth", () => {
  const root = mkdtempSync(join(tmpdir(), "vbcdx-43-umask-"));
  roots.push(root);
  const cfg = join(root, "config.env");
  const deep = join(root, "missing-base", ".config", "vbcdx", "credentials");
  writeFileSync(cfg, [`VBCDX_AGENTS_BASE_DIR=${root}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${deep}`, `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${root}/claude`, ""].join("\n"));
  for (const mask of [0o022, 0o077, 0o002]) {
    const previous = process.umask(mask);
    try {
      init([PACK_ARG, "--harness=claude", "--env=" + cfg, "--agents=code-agent", "--force"]);
    } finally {
      process.umask(previous);
    }
    assert.equal(existsSync(join(root, "missing-base")), false, `umask ${mask.toString(8)}`);
  }
  assert.ok(existsSync(join(root, "claude", "agents", "code-agent.md")));
});
