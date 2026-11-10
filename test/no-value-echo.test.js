// A value typed on the command line never comes back in an error: a secret
// pasted into the wrong slot (a raw token as --enroll-token-file's value, a password as a stray
// argument) must not reach the terminal or a log that captures stderr. Errors name the option,
// the kind or the position instead, and quote a word only when it is name-shaped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INSTALL_COMMON, SIDECAR_ONLY, CONTROL_ONLY, DISPATCH_ONLY, KEYHOLE_ONLY,
  REMOVE_OPTIONS, LIST_OPTIONS, DOCTOR_OPTIONS, SERVICE_OPTIONS,
} from "../src/service/args.js";
import { NOT_SHOWN, redactTyped, shownOption, shownWord, word } from "../src/shown.js";
import { FIXTURE_PACK_DIR } from "./helpers/fixture-pack.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const C = "SECRETVALUE123";
// The other realistic secret shape: lowercase hex, which is otherwise name-shaped.
const HEX = "a3f9c2e8b1d4f6a0c9e2b7d1f4a8c3e6";
// Canary shapes the code may transform before quoting them: each value, and the core that any
// copy of it (resolved, JSON-escaped, without its trailing "/") still contains.
const SHAPES = [
  [C, C],
  [HEX, HEX],
  ["./SECRET-SLASH-9X/", "SECRET-SLASH-9X"], // relative, with a trailing "/": resolve() rewrites it
  ['~/SECRET9TILDE"Q\\Z', "SECRET9TILDE"], // ~, a quote and a backslash: JSON-escaping rewrites it
];

// A private HOME and cwd, and an `npm` that fails at once, so no case reaches a registry or a
// real install: every case is a dry run or read-only.
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "vbcdx-echo-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "npm"), 0o755);
  // A harness home and a real config file, so the rows that load a pack get as far as planning.
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, "cfg.env"), `VBCDX_AGENTS_BASE_DIR=${home}/state\nVBCDX_AGENTS_CREDENTIALS_DIR=${home}/creds\nVBCDX_AGENTS_CLAUDE_CONFIG_DIR=${home}/.claude\n`);
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, XDG_RUNTIME_DIR: home, TMPDIR: home };
  const run = (b, argv) => spawnSync(process.execPath, [join(ROOT, "bin", b), ...argv], { encoding: "utf8", env, cwd: home, timeout: 30000 });
  return { home, run };
}

const VALUED = new Set(["--instance", "--version", "--from", "--service", "--listen", "--control-plane", "--tunnel", "--tunnel-name",
  "--enroll-token-file", "--link-listen", "--control-url", "--public-url", "--service-cert", "--control-ca"]);

/** Every command form × every option it takes (=value and space forms), an unknown option, a
 *  `--<value>` key, a stray positional, and the canary in each word and name slot. */
function cases(C, home) {
  const out = [];
  const add = (b, argv) => out.push({ b, argv });
  const svc = [
    [["install", "service", "sidecar"], [...INSTALL_COMMON, ...SIDECAR_ONLY, ...CONTROL_ONLY, ...DISPATCH_ONLY, ...KEYHOLE_ONLY], true],
    [["install", "service", "control-plane"], [...CONTROL_ONLY], true],
    [["install", "service", "keyhole-server"], [...DISPATCH_ONLY, ...KEYHOLE_ONLY], true],
    [["remove", "service", "sidecar"], REMOVE_OPTIONS, true],
    [["list", "services"], LIST_OPTIONS, false],
    [["doctor", "--service", "sidecar"], DOCTOR_OPTIONS.filter((o) => o !== "--service"), false],
    [["service", "sidecar", "status"], SERVICE_OPTIONS, false],
  ];
  for (const [base, opts, dry] of svc) {
    const tail = dry ? ["--dry-run"] : [];
    for (const o of opts) {
      add("vbcdx.js", [...base, `${o}=${C}`, ...tail]);
      if (VALUED.has(o)) add("vbcdx.js", [...base, o, C, ...tail]);
    }
    add("vbcdx.js", [...base, `--bogus=${C}`, ...tail]);
    add("vbcdx.js", [...base, `--${C}`, ...tail]);
    add("vbcdx.js", [...base, C, ...tail]);
  }
  // The enrollment token file is the realistic slot for a pasted token.
  add("vbcdx.js", ["install", "service", "sidecar", "--control-plane", "tunnel://cp.example:7443", `--enroll-token-file=${C}`, "--dry-run"]);
  add("vbcdx.js", ["install", "service", "sidecar", "--control-plane", "tunnel://cp.example:7443", "--enroll-token-file", `/home/u/${C}`, "--dry-run"]);
  for (const argv of [["install", "service", C, "--dry-run"], ["remove", "service", C], ["doctor", "--service", C], ["service", C, "status"],
    ["service", "sidecar", C], ["config", "service", C], ["config", "service", `--${C}`], ["config", "service", `--instance=${C}`]]) add("vbcdx.js", argv);
  const harness = [
    ["install", "agent", "code-agent", "--harness=claude", "--dry-run"],
    ["install", "skill", "x", "--harness=claude", "--dry-run"],
    ["install", "tool", "x", "--harness=claude", "--dry-run"],
    ["remove", "agent", "code-agent", "--harness=claude", "--dry-run"],
    ["list", "--harness=claude"],
    ["doctor", "--harness=claude"],
    ["packs"],
    ["fetch"],
    ["sources"],
  ];
  for (const base of harness) {
    for (const o of ["--harness", "--scope", "--env", "--pack", "--lock", "--sources", "--store", "--overlay"]) {
      add("vbcdx.js", [...base, `${o}=${C}`]);
      add("vbcdx.js", [...base, `${o}=/abs/${C}`]);
    }
    for (const o of ["--force", "--dry-run", "--quiet", "--json"]) add("vbcdx.js", [...base, `${o}=${C}`]);
    add("vbcdx.js", [...base, `--bogus=${C}`]);
    add("vbcdx.js", [...base, `--${C}`]);
    add("vbcdx.js", [...base, C]);
  }
  for (const argv of [[C], ["install", C, "x", "--harness=claude"], ["install", "agent", C, "--harness=claude", "--dry-run"],
    ["install", "agent", `code-agent,${C}`, "--harness=claude", "--dry-run"]]) add("vbcdx.js", argv);
  // With a loaded pack and a real config, an agent list reaches the planner, which checks each
  // piece against the pack's roles (a lowercase hex piece passes the id shape check).
  add("vbcdx.js", ["install", "agent", `code-agent,${C}`, "--harness=claude", "--dry-run", `--pack=${FIXTURE_PACK_DIR}`]);
  add("vbcdx-dev-agents.js", ["init", "--harness=claude", `--env=${home}/cfg.env`, `--pack=${FIXTURE_PACK_DIR}`, `--agents=code-agent,${C}`, "--dry-run"]);
  // The name slots that reach an error after parsing: a skill or tool name, a package spec or path.
  for (const argv of [["install", "skill", C, "--harness=claude", "--dry-run"], ["remove", "skill", C, "--harness=claude"],
    ["install", "tool", C, "--harness=claude", "--dry-run"], ["remove", "tool", C, "--harness=claude"],
    ["install", "tool", `/abs/${C}`, "--harness=claude", "--dry-run"]]) add("vbcdx.js", argv);
  // The deprecated alias.
  add("vbcdx-dev-agents.js", [C]);
  for (const o of ["--harness", "--env", "--agents", "--pack", "--overlay", "--scope", "--lock", "--store"]) {
    add("vbcdx-dev-agents.js", ["init", "--harness=claude", "--env=/nonexistent.env", `${o}=${C}`, "--dry-run"]);
    add("vbcdx-dev-agents.js", ["init", "--harness=claude", "--env=/nonexistent.env", `${o}=/abs/${C}`, "--dry-run"]);
  }
  add("vbcdx-dev-agents.js", ["init", "--harness=claude", "--env=/nonexistent.env", `--bogus=${C}`]);
  add("vbcdx-dev-agents.js", ["init", "--harness=claude", "--env=/nonexistent.env", C]);
  return out;
}

// Every row must end as the CLI decided, never as a crash: an exit code from the installer's
// taxonomy (0, or 2–6), not 1 (a fatal bug) and not a signal or timeout.
const DECIDED = new Set([0, 2, 3, 4, 5, 6]);
const CASES_PER_SHAPE = 333;

for (const [value, core] of SHAPES) {
  test(`no command, option or argument slot echoes a typed value, in any form (${JSON.stringify(value)})`, () => {
    const { home, run } = sandbox();
    try {
      const all = cases(value, home);
      assert.equal(all.length, CASES_PER_SHAPE, "the table's size (update CASES_PER_SHAPE with the table)");
      const leaks = [];
      const crashed = [];
      let failed = 0;
      for (const c of all) {
        const r = run(c.b, c.argv);
        if (!DECIDED.has(r.status)) crashed.push(`${c.b} ${c.argv.join(" ")}: exit ${r.status} ${r.signal || ""}`);
        if (r.status !== 0) failed++;
        const text = (r.stdout || "") + (r.stderr || "");
        if (text.includes(core)) leaks.push(`${c.b} ${c.argv.join(" ")}: ${text.split("\n").find((l) => l.includes(core))}`);
      }
      assert.deepEqual(leaks, []);
      assert.deepEqual(crashed, []);
      // The table must exercise errors: most cases are refused (a canary is never a valid value).
      assert.ok(failed > all.length * 0.8, `${failed}/${all.length} cases failed`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

test("usage errors still name the option, the word or the position, and exit 2", () => {
  const { home, run } = sandbox();
  try {
    const want = [
      [["install", "service", "sidecar", `--bogus=${C}`], /error: Unknown or misplaced option: --bogus\.$/m],
      [["install", "service", "sidecar", "--dry-run", "extra"], /error: Unexpected argument \(position 5\)\.$/m],
      [["remove", "service", "sidecar", "x"], /error: Unexpected argument \(position 4\)\.$/m],
      [["doctor", "--service", "sidecar", "x"], /error: Unexpected argument \(position 4\)\.$/m],
      [["service", "sidecar", "status", "x"], /error: Unexpected argument \(position 4\)\.$/m],
      [["install", "tool", "a", "b", "--harness=claude"], /error: Unexpected argument \(position 4\)\.$/m],
      [["install", "service", "sidecr"], /error: Unknown service: sidecr\.$/m],
      [["install", "service", C], new RegExp(`error: Unknown service: ${NOT_SHOWN}\\.$`, "m")],
      [["list", `--profile=${C}`, "--harness=claude"], /error: Unknown or malformed option: --profile\.$/m],
      [["list", "--harness=vim"], /error: Unsupported --harness: vim\.$/m],
      [["bogus"], /error: Unknown command: bogus\.$/m],
      [["config", "service", "--instance=x"], /\(not --instance before it\)\.$/m],
      [["service", "sidecar", "frob"], /error: service sidecar needs one of: status/m],
    ];
    for (const [argv, re] of want) {
      const r = run("vbcdx.js", argv);
      assert.equal(r.status, 2, `${argv.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, re, argv.join(" "));
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an error raised after parsing names the argument's position, not its value", () => {
  const { home, run } = sandbox();
  try {
    const r = run("vbcdx.js", ["install", "agent", "code-agent", "--harness=claude", `--lock=/abs/${C}.json`, "--dry-run"]);
    assert.notEqual(r.status, 0);
    assert.ok(!r.stderr.includes(C), r.stderr);
    assert.match(r.stderr, /<argument 5>/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The parsers on their own, without the CLI's redaction: each parser message must be safe by
// itself, so a parser change can't lean on the backstop.
test("the parsers' own messages never quote a value", async () => {
  const { parseVbcdxArgs } = await import("../src/install/args.js");
  const { parseServiceArgs } = await import("../src/service/args.js");
  const { parseInitArgs } = await import("../src/cli/args.js");
  const svc = [
    ["install", "service", "sidecar", `--bogus=${C}`], ["install", "service", "sidecar", `--${C}`], ["install", "service", "sidecar", C],
    ["install", "service", C], ["remove", "service", "sidecar", C], ["remove", "service", C], ["remove", "service", "sidecar", `--${C}=x`],
    ["list", "services", `--${C}`], ["doctor", "--service", "sidecar", C], ["doctor", "--service", C], ["service", C, "status"],
    ["service", C, "frob"], ["service", "sidecar", "status", C], ["service", "sidecar", C], ["config", "service", `--${C}`],
    ["config", "service", `--instance=${C}`], ["config", "service", C],
  ];
  const harness = [
    [C], ["install", "agent", C, "--harness=claude"], ["install", "agent", `a,${C}`, "--harness=claude"], ["install", C, "x", "--harness=claude"],
    ["install", "tool", "x", C, "--harness=claude"], ["list", `--bogus=${C}`, "--harness=claude"], ["list", `--${C}`, "--harness=claude"],
    ["list", `--harness=${C}`], ["list", "--harness=claude", `--scope=${C}`], ["packs", `--${C}=x`],
  ];
  const init = [
    ["--harness=claude", "--env=/c", `--bogus=${C}`], ["--harness=claude", "--env=/c", C], [`--harness=${C}`, "--env=/c"],
    ["--harness=claude", "--env=/c", `--scope=${C}`], ["--harness=claude", "--env=/c", `--agents=a,${C}`], ["--harness=claude", "--env=/c", `--${C}`],
  ];
  const leaks = [];
  const check = (what, fn) => {
    try {
      fn();
      leaks.push(`${what}: parsed without an error`);
    } catch (e) {
      if (String(e.message).includes(C) || String(e.message).includes(HEX)) leaks.push(`${what}: ${e.message}`);
      if (e.code !== 2) leaks.push(`${what}: exit ${e.code}`);
    }
  };
  for (const v of [HEX]) {
    svc.push(["install", "service", v], ["install", "service", "sidecar", `--${v}`], ["service", v, "frob"], ["config", "service", `--${v}`]);
    harness.push([v], ["list", `--${v}`, "--harness=claude"], ["list", `--harness=${v}`]);
    init.push(["--harness=claude", "--env=/c", `--${v}`], [`--harness=${v}`, "--env=/c"]);
  }
  for (const a of svc) check(a.join(" "), () => parseServiceArgs(a));
  for (const a of harness) check(a.join(" "), () => parseVbcdxArgs(a));
  for (const a of init) check(`init ${a.join(" ")}`, () => parseInitArgs(a));
  assert.deepEqual(leaks, []);
});

// The call sites that quote a typed name or path, on their own, without the CLI's redaction: each
// must quote it only as typed, or by the shown rules, never transformed (resolved, JSON-escaped,
// joined into a path), so the backstop isn't what keeps the value out.
test("the call sites quote a typed name or path only as typed, never transformed", async () => {
  const { installAgent, installSkill, remove } = await import("../src/install/commands.js");
  const { locatePackageDir } = await import("../src/install/locate.js");
  const { resolveContext } = await import("../src/install/context.js");
  const { loadCatalog, setActiveCatalog } = await import("../src/packs/catalog.js");
  const { FIXTURE_PACK_DIR } = await import("./helpers/fixture-pack.js");
  const home = mkdtempSync(join(tmpdir(), "vbcdx-sites-"));
  try {
    // A loaded pack, so install skill reaches its "Unknown skill" error rather than "no pack".
    setActiveCatalog(loadCatalog([FIXTURE_PACK_DIR], { cwd: home, home }));
    mkdirSync(join(home, ".claude"));
    const ctx = resolveContext({ harness: "claude", scope: "user", envPath: null, home, cwd: home, env: {} });
    const quoted = 'SECRET9TILDE"Q\\Z'; // JSON.stringify rewrites it
    const slashed = "./SECRET-SLASH-9X/"; // resolve() and a path join rewrite it
    const message = (fn) => {
      try {
        fn();
      } catch (e) {
        return String(e.message);
      }
      return "(no error)";
    };
    const rows = [
      ["install skill <quoted>", message(() => installSkill(ctx, quoted, { dryRun: true })), "SECRET9TILDE"],
      ["install agent <hex piece>", message(() => installAgent(ctx, ["code-agent", HEX], { dryRun: true })), HEX], // passes isSafeId
      ["remove tool <quoted>", message(() => remove(ctx, "tool", quoted)), "SECRET9TILDE"],
      ["remove skill <slashed>", message(() => remove(ctx, "skill", slashed)), "SECRET-SLASH-9X"],
      ["remove skill <hex>", message(() => remove(ctx, "skill", HEX)), HEX], // a valid skill name, but all hex
      ["locate <non-name>", message(() => locatePackageDir('SECRET9TILDE"QZ', { cwd: home, home })), "SECRET9TILDE"],
    ];
    for (const [what, text, core] of rows) assert.ok(text !== "(no error)" && !text.includes(core), `${what}: ${text}`);
    assert.match(rows[0][1], /^Unknown skill <not shown>\. Available: /);
    assert.match(rows[1][1], /^Unknown agent ID in selection: <not shown> /);
    assert.match(rows[3][1], /is not recorded as installed\.$/);
    // A path is quoted exactly as typed, never as the directory it resolves to.
    assert.equal(message(() => locatePackageDir(slashed, { cwd: home, home })), `No package directory at ${slashed}.`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the shown rules: name-shaped words and option names only", () => {
  for (const ok of ["sidecar", "x", "keyhole-server", "x".repeat(32), "a1-g"]) assert.equal(word(ok), ok);
  // A lowercase hex token or key passes the shape rules, so all-hex is never a name (vbcdx-core's rule).
  for (const bad of ["", "Sidecar", "1abc", "a_b", "-a", "x".repeat(33), C, "a b", "a\u001b[31m", undefined, null, 7,
    HEX, "deadbeef", "cafe"]) {
    assert.equal(word(bad), null, String(bad));
    assert.equal(shownWord(bad), NOT_SHOWN);
  }
  assert.equal(shownOption("--listen"), "--listen");
  assert.equal(shownOption(`--listen=${C}`), "--listen");
  assert.equal(shownOption(`--${C}`), NOT_SHOWN);
  assert.equal(shownOption(`--${C}=x`), NOT_SHOWN);
  assert.equal(shownOption("-x"), NOT_SHOWN);
  assert.equal(shownOption(undefined), NOT_SHOWN);
});

test("redactTyped replaces each typed value that isn't name-shaped, and keeps the rest", () => {
  const argv = ["install", "service", "sidecar", `--from=/srv/${C}`, "--version", "1.2.3", "--instance", "blue", `--${C}`, "shorty"];
  assert.equal(redactTyped(`no release at /srv/${C}/checksums.json`, argv), "no release at <argument 4>/checksums.json");
  assert.equal(redactTyped(`unknown ${C}`, argv), "unknown <argument 9>");
  // Name-shaped words, versions, scoped package names and short values are kept: they aren't
  // plausible secrets. A path is not kept.
  assert.equal(redactTyped("instance blue, version 1.2.3, shorty", argv), "instance blue, version 1.2.3, shorty");
  // A version of the redaction length is kept by the version rule itself, not by the length rule.
  assert.equal(redactTyped("no 0.1.0-dev.7 release", ["--version", "0.1.0-dev.7"]), "no 0.1.0-dev.7 release");
  assert.equal(redactTyped("@example/tracker-plugin is not in /srv/locks/a.json", ["@example/tracker-plugin", "--lock=/srv/locks/a.json"]),
    "@example/tracker-plugin is not in <argument 2>");
  assert.equal(redactTyped(`@x/${C}`, [`@x/${C}`]), "<argument 1>"); // not npm's lowercase name rule
  // The longest value is replaced first, so a value inside another is still covered.
  // (The shorter one comes first in argv, so an unsorted pass would label the path as argument 1.)
  assert.equal(redactTyped("/srv/SECRETVALUE123 and SECRETVALUE123", ["SECRETVALUE123", "--a=/srv/SECRETVALUE123"]),
    "<argument 2> and <argument 1>");
  // A lowercase hex value is redacted too: it is name-shaped, but all-hex.
  assert.equal(redactTyped(`no lock at ${HEX}`, [`--lock=${HEX}`]), "no lock at <argument 1>");
  // What the code may turn a typed value into is redacted too, each form by itself:
  const cwd = "/work/dir", home = "/home/u";
  const q = 'SECRET9TILDE"Q\\Z';
  assert.equal(redactTyped(`Unknown skill ${JSON.stringify(q)}.`, [q], { cwd, home }), 'Unknown skill "<argument 1>".'); // JSON-escaped
  assert.equal(redactTyped("no skill SECRET-SLASH-9X here", ["SECRET-SLASH-9X/"], { cwd, home }), "no skill <argument 1> here"); // trailing "/" dropped (resolve() would add the cwd)
  assert.equal(redactTyped("no dir /work/dir/SECRET-SLASH-9X/a", ["./SECRET-SLASH-9X/"], { cwd, home }), "no dir <argument 1>/a"); // resolve(cwd, v)
  assert.equal(redactTyped("no dir /home/u/SECRET9TILDE", ["--lock=~/SECRET9TILDE"], { cwd, home }), "no dir <argument 1>"); // ~ expanded (resolve() keeps the ~)
  assert.equal(redactTyped("no dir /work/dir/~/SECRET9TILDE", ["--lock=~/SECRET9TILDE"], { cwd, home }), "no dir <argument 1>"); // ~ resolved literally
  // A comma list reaches errors one piece at a time, so each piece is redacted on its own.
  assert.equal(redactTyped(`unknown ${HEX} here`, [`code-agent,${HEX}`], { cwd, home }), "unknown <argument 1> here");
  // A variant shorter than the redaction length is kept, as any short value is ("abcdefg/" → "abcdefg").
  assert.equal(redactTyped("no skill abcdefg here", ["abcdefg/"], { cwd, home }), "no skill abcdefg here");
  // A space-form value is redacted where it appears.
  assert.equal(redactTyped(`token file /home/u/${C} unreadable`, ["--enroll-token-file", `/home/u/${C}`]), "token file <argument 2> unreadable");
});
