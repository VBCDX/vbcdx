// The installer vs Hermes Web UI, and runs that stop part-way.
//  1. A Hermes profile's config.yaml is merged on the keys the installer owns, so a
//     Web UI setting (agent.reasoning_effort) survives and does not make the next
//     run refuse the profile; a hand edit of an owned key still conflicts.
//  2. Every conflict is refused before the first write, all of them listed.
//  3. --dry-run reports the same classification, conflicts included (CLI exit 5).
//  4. A run that fails after writing some files still records them as owned.
//  5. Existing credential files are pre-checked too: an unsafe or invalid one
//     refuses before the first write, and --dry-run reports it and exits 3.

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
  // No pre-check can see this one: the credential file is written after the definitions,
  // and a write that fails there (injected, as a full disk would) stops the run.
  const root = mkdtempSync(join(tmpdir(), "vbcdx-43-late-"));
  roots.push(root);
  const cfg = join(root, "config.env");
  writeFileSync(cfg, [`VBCDX_AGENTS_BASE_DIR=${root}/state`, `VBCDX_AGENTS_CREDENTIALS_DIR=${root}/creds`,
    `VBCDX_AGENTS_CLAUDE_CONFIG_DIR=${root}/claude`, "VBCDX_AGENTS_USER_CODE_AGENT=u", "VBCDX_AGENTS_TOKEN_CODE_AGENT=t", ""].join("\n"));
  const args = parseInitArgs(["--harness=claude", "--env=" + cfg, "--agents=code-agent"]);
  const plan = buildPlan(args, parseEnvFile(cfg));
  assert.equal(plan.credentialOps.length, 1, "the plan writes a credential file after the definition");
  let calls = 0;
  const writeCredential = () => { calls++; throw new InstallerError(EXIT.FILESYSTEM, "injected: no space left on device"); };
  assert.throws(() => executePlan(plan, { writeCredential }), (err) => {
    assert.equal(err.code, EXIT.FILESYSTEM, err.message);
    return true;
  });
  assert.equal(calls, 1, "the failure came from the credential step");
  const written = join(root, "claude", "agents", "code-agent.md");
  assert.ok(existsSync(written), "the definition was written before the failure");
  const manifest = JSON.parse(readFileSync(join(root, "state", "manifests", "installation.json"), "utf8"));
  assert.ok(manifest.files[written], "the written file is recorded despite the failure");
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

// Credential files are part of the pre-check and of --dry-run.
function credEnv() {
  const e = hermesEnv();
  const creds = join(e.root, "creds");
  const cfg = e.cfg.replace(/config\.env$/, "config-creds.env");
  writeFileSync(cfg, read(e.cfg) + "VBCDX_AGENTS_USER_PM_AGENT=pm\nVBCDX_AGENTS_TOKEN_PM_AGENT=t\n");
  const soul = join(e.root, "hermes", "profiles", "pm-agent", "SOUL.md");
  const bad = () => {
    mkdirSync(creds, { recursive: true, mode: 0o700 });
    chmodSync(creds, 0o700);
    const f = join(creds, "pm-agent.env");
    writeFileSync(f, 'VBCDX_AGENTS_ROLE="pm-agent"\nVBCDX_AGENTS_USER="pm"\nVBCDX_AGENTS_TOKEN="t"\n');
    chmodSync(f, 0o644); // not 0600: unsafe, fails even with --force
    return f;
  };
  return { e, cfg, creds, soul, bad };
}

test("an unsafe existing credential file refuses the run before the first write", () => {
  const { cfg, soul, bad } = credEnv();
  bad();
  for (const extra of [[], ["--force"]]) {
    assert.throws(() => init([PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent", ...extra]), (err) => {
      assert.equal(err.code, EXIT.CREDENTIAL, err.message);
      assert.match(err.message, /nothing was written/);
      assert.match(err.message, /pm-agent\.env/);
      return true;
    });
    assert.ok(!existsSync(soul), `no definition was written (${extra.join(" ") || "no flags"})`);
  }
});

test("--dry-run reports an unsafe credential file as refused and exits 3", () => {
  const { cfg, soul, bad } = credEnv();
  const f = bad();
  const report = init([PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent", "--dry-run"]);
  assert.deepEqual(report.credentials.map((c) => [c.role, c.action]), [["pm-agent", "refused"]]);
  assert.equal(report.credential_errors.length, 1);
  assert.match(report.credential_errors[0], /unsafe/);
  assert.ok(!report.credential_errors[0].includes('"t"'), "no credential value in the reason");
  const cli = spawnSync(process.execPath, [BIN, "init", PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent", "--dry-run"], { encoding: "utf8" });
  assert.equal(cli.status, EXIT.CREDENTIAL, cli.stderr);
  assert.match(cli.stderr, /credential file\(s\) would be refused/);
  assert.match(cli.stdout, /credential pm-agent: refused/);
  assert.ok(!existsSync(soul), "the dry run wrote nothing");
  assert.equal(read(f).includes("VBCDX_AGENTS_TOKEN"), true, "the credential file is untouched");
});

test("--dry-run reports the real credential action: written, retained, replaced", () => {
  const { cfg, creds } = credEnv();
  // No credentials dir yet: the real run would write the file.
  let r = init([PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent", "--dry-run"]);
  assert.deepEqual(r.credentials.map((c) => c.action), ["written"]);
  assert.deepEqual(r.credential_errors, []);
  init([PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent"]);
  assert.ok(existsSync(join(creds, "pm-agent.env")));
  // A valid file is retained without --force and replaced with it.
  r = init([PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent", "--dry-run"]);
  assert.deepEqual(r.credentials.map((c) => c.action), ["retained"]);
  r = init([PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent", "--dry-run", "--force"]);
  assert.deepEqual(r.credentials.map((c) => c.action), ["replaced"]);
  const cli = spawnSync(process.execPath, [BIN, "init", PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent", "--dry-run"], { encoding: "utf8" });
  assert.equal(cli.status, EXIT.OK, cli.stderr);
});

test("a credentials dir that is not private refuses before the first write, and --dry-run says so", () => {
  const { cfg, creds, soul } = credEnv();
  mkdirSync(creds, { recursive: true });
  chmodSync(creds, 0o755); // not 0700: the secret write would refuse its parent
  const report = init([PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent", "--dry-run"]);
  assert.deepEqual(report.credentials.map((c) => c.action), ["refused"]);
  assert.match(report.credential_errors[0], /private 0700 dir/);
  assert.throws(() => init([PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent"]), (err) => {
    assert.equal(err.code, EXIT.CREDENTIAL, err.message);
    return true;
  });
  assert.ok(!existsSync(soul), "no definition was written");
});

// The refusal enumerates EVERY refused
// credential file, not just the first. Two roles, both unsafe; the suite used to
// carry exactly one credential op, so `refused.slice(0, 1)` survived it.
function twoCredEnv() {
  const e = hermesEnv();
  const creds = join(e.root, "creds");
  const cfg = e.cfg.replace(/config\.env$/, "config-creds-pair.env");
  writeFileSync(cfg, read(e.cfg) +
    "VBCDX_AGENTS_USER_PM_AGENT=pm\nVBCDX_AGENTS_TOKEN_PM_AGENT=t\n" +
    "VBCDX_AGENTS_USER_ADVERSARIAL_AUDITOR=ci\nVBCDX_AGENTS_TOKEN_ADVERSARIAL_AUDITOR=t2\n");
  const soul = join(e.root, "hermes", "profiles", "pm-agent", "SOUL.md");
  const unsafe = (role) => {
    mkdirSync(creds, { recursive: true, mode: 0o700 });
    chmodSync(creds, 0o700);
    const f = join(creds, `${role}.env`);
    writeFileSync(f, `VBCDX_AGENTS_ROLE="${role}"\nVBCDX_AGENTS_USER="u"\nVBCDX_AGENTS_TOKEN="t"\n`);
    chmodSync(f, 0o644); // not 0600: unsafe, fails even with --force
    return f;
  };
  return { cfg, creds, soul, unsafe };
}

const AGENTS_TWO = ["--agents=pm-agent,adversarial-auditor"];

test("every refused credential file is listed, and --dry-run reports them all (n>1)", () => {
  const { cfg, soul, unsafe } = twoCredEnv();
  const [f1, f2] = [unsafe("pm-agent"), unsafe("adversarial-auditor")];
  for (const extra of [[], ["--force"]]) {
    assert.throws(() => init([PACK_ARG, "--harness=hermes", "--env=" + cfg, ...AGENTS_TWO, ...extra]), (err) => {
      assert.equal(err.code, EXIT.CREDENTIAL, err.message);
      assert.match(err.message, /2 existing credential file\(s\) would fail/, `both refusals counted (${extra.join(" ") || "no flags"})`);
      assert.ok(err.message.includes(f1) && err.message.includes(f2), "both reasons are listed, not just the first");
      return true;
    });
    assert.ok(!existsSync(soul), `no definition was written (${extra.join(" ") || "no flags"})`);
  }
  const report = init([PACK_ARG, "--harness=hermes", "--env=" + cfg, ...AGENTS_TWO, "--dry-run"]);
  assert.deepEqual(report.credentials.map((c) => [c.role, c.action]).sort(), [["adversarial-auditor", "refused"], ["pm-agent", "refused"]]);
  assert.equal(report.credential_errors.length, 2, "both refusals are reported");
  assert.ok(report.credential_errors.some((r) => r.includes(f1)) && report.credential_errors.some((r) => r.includes(f2)));
  const cli = spawnSync(process.execPath, [BIN, "init", PACK_ARG, "--harness=hermes", "--env=" + cfg, ...AGENTS_TWO, "--dry-run"], { encoding: "utf8" });
  assert.equal(cli.status, EXIT.CREDENTIAL, cli.stderr);
});

test("a credentials dir that is not private refuses before the first write, --force included", () => {
  const { cfg, creds, soul } = credEnv();
  mkdirSync(creds, { recursive: true });
  chmodSync(creds, 0o755); // not 0700: the secret write would refuse its parent
  // The private-dir rule is not force-gated: --dry-run reports the refusal with --force too.
  for (const extra of [[], ["--force"]]) {
    const report = init([PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent", "--dry-run", ...extra]);
    assert.deepEqual(report.credentials.map((c) => c.action), ["refused"], `dry run refuses (${extra.join(" ") || "no flags"})`);
    assert.equal(report.credential_errors.length, 1);
    assert.match(report.credential_errors[0], /private 0700 dir/);
  }
  assert.throws(() => init([PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent", "--force"]), (err) => {
    assert.equal(err.code, EXIT.CREDENTIAL, err.message);
    return true;
  });
  assert.ok(!existsSync(soul), "no definition was written before the refusal (--force)");
  // The dry run refuses with --force through the spawned CLI too (exit 3), not
  // only through init()'s report.
  const cli = spawnSync(process.execPath, [BIN, "init", PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent", "--dry-run", "--force"], { encoding: "utf8" });
  assert.equal(cli.status, EXIT.CREDENTIAL, cli.stderr);
  assert.match(cli.stderr, /credential file\(s\) would be refused/);
});

test("the credentials dir is created 0700 even under a umask that would strip it", () => {
  const { e, cfg, creds } = credEnv();
  // Pre-create every directory the run would otherwise create under the exotic
  // umask, so the credentials dir is the only NEW directory (the original repro).
  for (const d of [
    join(e.root, "state"), join(e.root, "state", "manifests"),
    join(e.root, "hermes"), join(e.root, "hermes", "profiles"), join(e.root, "hermes", "profiles", "pm-agent"),
  ]) {
    mkdirSync(d, { recursive: true, mode: 0o755 });
    chmodSync(d, 0o755);
  }
  const old = process.umask(0o177); // would leave a plain mkdir 0600: no owner execute
  let report;
  try {
    report = init([PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent"]);
  } finally {
    process.umask(old);
  }
  assert.ok(report.generated.length > 0, "the run completed (the creds dir did not wedge it)");
  assert.equal(statSync(creds).mode & 0o777, 0o700, "the credentials dir is exactly 0700");
  assert.equal(statSync(join(creds, "pm-agent.env")).mode & 0o777, 0o600);
});

test("a missing multi-level credentials-dir parent is created 0700 under an exotic umask", () => {
  const e = hermesEnv();
  const creds = join(e.root, "missing", ".config", "vbcdx", "credentials");
  const cfg = join(e.root, "config-nested-creds.env");
  writeFileSync(cfg, [
    `VBCDX_AGENTS_BASE_DIR=${e.root}/state`,
    `VBCDX_AGENTS_CREDENTIALS_DIR=${creds}`,
    `VBCDX_AGENTS_HERMES_HOME=${e.root}/hermes`,
    "VBCDX_AGENTS_USER_PM_AGENT=pm",
    "VBCDX_AGENTS_TOKEN_PM_AGENT=t",
    "",
  ].join("\n"));
  // Pre-create every OTHER directory the run would create, so the credentials
  // chain is the only thing this run creates — the .env.example layout has a
  // not-yet-existing parent (the test above only covers an existing one).
  for (const d of [
    join(e.root, "state"), join(e.root, "state", "manifests"),
    join(e.root, "hermes"), join(e.root, "hermes", "profiles"), join(e.root, "hermes", "profiles", "pm-agent"),
  ]) {
    mkdirSync(d, { recursive: true, mode: 0o755 });
    chmodSync(d, 0o755);
  }
  const old = process.umask(0o177); // would leave a plain mkdir 0600: no owner execute
  let report;
  try {
    report = init([PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent"]);
  } finally {
    process.umask(old);
  }
  assert.ok(report.generated.length > 0, "the run completed (the missing parent did not wedge it)");
  for (const dir of [
    join(e.root, "missing"), join(e.root, "missing", ".config"),
    join(e.root, "missing", ".config", "vbcdx"), creds,
  ]) {
    assert.equal(statSync(dir).mode & 0o777, 0o700, `${dir} is exactly 0700`);
  }
  assert.equal(statSync(join(creds, "pm-agent.env")).mode & 0o777, 0o600);
});

test("a dry run with both a credential refusal and a conflict prints the credential block first, exit 5", () => {
  const { e, cfg, creds } = credEnv();
  init([PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent"]); // create config.yaml and the creds dir
  webUiSave(e.conf("pm-agent"), (d) => { d.platform_toolsets.cli = []; }); // hand edit of an owned key -> conflict
  chmodSync(creds, 0o755); // and the credentials dir is no longer private -> credential refusal
  const cli = spawnSync(process.execPath, [BIN, "init", PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent", "--dry-run"], { encoding: "utf8" });
  assert.equal(cli.status, EXIT.CONFLICT, cli.stderr);
  const credAt = cli.stderr.indexOf("credential file(s) would be refused");
  const conflictAt = cli.stderr.indexOf("file(s) would be refused as modified outside the installer");
  assert.ok(credAt >= 0 && conflictAt >= 0, `both blocks are present:\n${cli.stderr}`);
  assert.ok(credAt < conflictAt, "the credential block is written before the conflict block");
});

test("an invalid credential file (wrong ROLE) refuses before the first write", () => {
  const { cfg, creds, soul } = credEnv();
  const secret = "SENTINEL-SECRET-9f3a";
  mkdirSync(creds, { recursive: true, mode: 0o700 });
  chmodSync(creds, 0o700);
  const f = join(creds, "pm-agent.env");
  writeFileSync(f, `VBCDX_AGENTS_ROLE="adversarial-auditor"\nVBCDX_AGENTS_USER="${secret}"\nVBCDX_AGENTS_TOKEN="${secret}"\n`);
  chmodSync(f, 0o600); // mode is fine; only the ROLE is wrong -> invalid, not unsafe
  const report = init([PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent", "--dry-run"]);
  assert.deepEqual(report.credentials.map((c) => [c.role, c.action]), [["pm-agent", "refused"]]);
  assert.equal(report.credential_errors.length, 1);
  assert.match(report.credential_errors[0], /invalid/);
  assert.ok(!report.credential_errors.join("\n").includes(secret), "no credential value in the reason");
  assert.throws(() => init([PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent"]), (err) => {
    assert.equal(err.code, EXIT.CREDENTIAL, err.message);
    assert.match(err.message, /invalid/);
    assert.ok(!err.message.includes(secret), "no credential value in the error");
    return true;
  });
  assert.ok(!existsSync(soul), "no definition was written");
});

// The ROLE line is file content too. A secret pasted into it must not reach
// stderr or the report through the "role field" refusal, on the dry run or the real run.
test("a secret in the credential file's ROLE line never reaches stderr or the report", () => {
  const { cfg, creds, soul } = credEnv();
  const secret = "SENTINEL-ROLE-7c41";
  mkdirSync(creds, { recursive: true, mode: 0o700 });
  chmodSync(creds, 0o700);
  const f = join(creds, "pm-agent.env");
  writeFileSync(f, `VBCDX_AGENTS_ROLE="${secret}"\nVBCDX_AGENTS_USER="pm"\nVBCDX_AGENTS_TOKEN="t"\n`);
  chmodSync(f, 0o600);
  const run = ["init", PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent"];

  const report = init([PACK_ARG, ...run.slice(1), "--dry-run"]);
  assert.equal(report.credential_errors.length, 1);
  assert.ok(!JSON.stringify(report).includes(secret), "no ROLE value in the dry-run report");
  assert.match(report.credential_errors[0], /role field does not match the expected role pm-agent/);
  const dry = spawnSync(process.execPath, [BIN, ...run, "--dry-run"], { encoding: "utf8" });
  assert.equal(dry.status, EXIT.CREDENTIAL, dry.stderr);
  assert.ok(!dry.stderr.includes(secret) && !dry.stdout.includes(secret), "no ROLE value in dry-run output");
  assert.match(dry.stderr, /role field does not match/);

  assert.throws(() => init(run.slice(1)), (err) => {
    assert.equal(err.code, EXIT.CREDENTIAL, err.message);
    assert.ok(!err.message.includes(secret), "no ROLE value in the error");
    return true;
  });
  const real = spawnSync(process.execPath, [BIN, ...run], { encoding: "utf8" });
  assert.equal(real.status, EXIT.CREDENTIAL, real.stderr);
  assert.ok(!real.stderr.includes(secret) && !real.stdout.includes(secret), "no ROLE value in real-run output");
  assert.match(real.stderr, /role field does not match/);
  assert.ok(!existsSync(soul), "no definition was written");
});

// The dry-run exit precedence is a promise the suite must
// pin, not just a comment. The real run refuses definition conflicts (exit 5)
// before credential errors (exit 3) - src/executor.js:167 before :170 - so a dry
// run that finds BOTH must exit 5 and still print both blocks. Here: an unowned
// hand-written definition (a conflict) and a 0644 credential file (refused, fails
// even with --force) at once. Swapping the two returns in bin/vbcdx-dev-agents.js
// makes this dry run exit 3 and drop the conflict block; that swap fails this test.
test("a dry run with a definition conflict AND a refused credential file exits 5 first, with both blocks", () => {
  const { cfg, soul, bad } = credEnv();
  const handWritten = "# a definition the installer does not own\n";
  mkdirSync(dirname(soul), { recursive: true });
  writeFileSync(soul, handWritten);
  const f = bad();
  const cli = spawnSync(process.execPath, [BIN, "init", PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent", "--dry-run"], { encoding: "utf8" });
  assert.equal(cli.status, EXIT.CONFLICT, cli.stderr);
  assert.match(cli.stderr, /existing credential file\(s\) would be refused/);
  assert.match(cli.stderr, /would be refused as modified outside the installer or not package-owned/);
  assert.ok(cli.stderr.includes(f), "the refused credential file is named");
  assert.ok(cli.stderr.includes(soul), "the conflicting definition is named");
  assert.equal(read(soul), handWritten, "still a dry run: the conflicting definition is untouched");
});

// Conflicts win over credential refusals in
// BOTH modes, not only the dry run. The dry-run half is pinned by the test above;
// nothing drove a real run with both stimuli, so moving the credential pre-check
// above `refuseConflicts` in src/executor.js survived the whole suite while
// flipping the real run's exit 5 -> 3 and dropping the conflict list. The exact
// swap of the two dry-run returns in bin/vbcdx-dev-agents.js survived it too
// before this table. One table, both modes, four stimuli; each cell asserts the
// exit code and exactly which stderr blocks appear (the block text differs per
// mode: a dry run says what "would" happen, the real run reports the refusal it
// just took), plus that a refusal happens before the first write.
const DRY_CONFLICT = /1 file\(s\) would be refused as modified outside the installer or not package-owned/;
const REAL_CONFLICT = /Refusing to overwrite 1 file\(s\) modified outside the installer or not package-owned/;
const DRY_CREDENTIAL = /1 existing credential file\(s\) would be refused \(these fail even with --force\)/;
const REAL_CREDENTIAL = /Refusing to run: 1 existing credential file\(s\) would fail; nothing was written/;
const PRECEDENCE_BLOCKS = [DRY_CONFLICT, REAL_CONFLICT, DRY_CREDENTIAL, REAL_CREDENTIAL];

// Stimuli: a hand-written unowned definition (profiles/pm-agent/SOUL.md) and/or a
// 0644 credential file (creds/pm-agent.env, refused even with --force).
// `both` is the precedence cell: exit 5 in both modes. The dry run prints both
// blocks (it reports before it returns); the real run refuses the conflict first,
// so the credential block is never reached there.
const PRECEDENCE = [
  { stimulus: "neither", conflict: false, credential: false, exit: { dry: EXIT.OK, real: EXIT.OK }, blocks: { dry: [], real: [] } },
  { stimulus: "conflict only", conflict: true, credential: false, exit: { dry: EXIT.CONFLICT, real: EXIT.CONFLICT }, blocks: { dry: [DRY_CONFLICT], real: [REAL_CONFLICT] } },
  { stimulus: "credential only", conflict: false, credential: true, exit: { dry: EXIT.CREDENTIAL, real: EXIT.CREDENTIAL }, blocks: { dry: [DRY_CREDENTIAL], real: [REAL_CREDENTIAL] } },
  { stimulus: "both", conflict: true, credential: true, exit: { dry: EXIT.CONFLICT, real: EXIT.CONFLICT }, blocks: { dry: [DRY_CREDENTIAL, DRY_CONFLICT], real: [REAL_CONFLICT] } },
];

test("conflicts beat credential refusals (exit 5 over 3) in the dry run and the real run", async (t) => {
  for (const row of PRECEDENCE) {
    for (const mode of ["dry", "real"]) {
      await t.test(`${mode === "dry" ? "--dry-run" : "real run"} / ${row.stimulus}`, () => {
        const { cfg, soul, bad } = credEnv();
        const handWritten = "# a definition the installer does not own\n";
        if (row.conflict) {
          mkdirSync(dirname(soul), { recursive: true });
          writeFileSync(soul, handWritten);
        }
        const credentialFile = row.credential ? bad() : null;

        const args = ["init", PACK_ARG, "--harness=hermes", "--env=" + cfg, "--agents=pm-agent"];
        if (mode === "dry") args.push("--dry-run");
        const cli = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });
        const cell = `${mode}/${row.stimulus}`;

        // The exit code: 5 (conflict) beats 3 (credential) in both modes.
        assert.equal(cli.status, row.exit[mode], `exit ${row.exit[mode]} for ${cell}\nstderr: ${cli.stderr}`);

        // Exactly the blocks this cell expects, and no other: a lone conflict must
        // not print a credential block, a lone refusal must not print a conflict
        // block, and the real run with both never reaches the credential block.
        const expected = row.blocks[mode];
        for (const block of PRECEDENCE_BLOCKS) {
          if (expected.includes(block)) assert.match(cli.stderr, block, `expected block ${block} for ${cell}`);
          else assert.doesNotMatch(cli.stderr, block, `unexpected block ${block} for ${cell}`);
        }

        // The refused item is named where its block is printed.
        if (row.conflict) assert.ok(cli.stderr.includes(soul), `the conflicting definition is named (${cell})`);
        if (row.credential && expected.some((b) => b === DRY_CREDENTIAL || b === REAL_CREDENTIAL)) {
          assert.ok(cli.stderr.includes(credentialFile), `the refused credential file is named (${cell})`);
        }

        // A refusal is before the first write; only an allowed real run writes.
        // A conflict cell's definition already exists (hand-written above), so the
        // invariant there is that its content never changed.
        if (row.conflict) {
          assert.equal(read(soul), handWritten, `the conflicting definition is untouched (${cell})`);
        } else if (row.exit[mode] === EXIT.OK) {
          assert.equal(existsSync(soul), mode === "real", `the definition is written only by a real run (${cell})`);
        } else {
          assert.ok(!existsSync(soul), `nothing was written before the refusal (${cell})`);
        }
      });
    }
  }
});
