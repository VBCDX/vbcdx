// `vbcdx <command> --help` exits 0 and prints that command's options: every one its parser takes,
// and every flag the docs use with it. An unknown option still exits 2, naming it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INSTALL_COMMON, SIDECAR_ONLY, CONTROL_ONLY, DISPATCH_ONLY, KEYHOLE_ONLY,
  REMOVE_OPTIONS, LIST_OPTIONS, DOCTOR_OPTIONS, SERVICE_OPTIONS, ACTIONS,
} from "../src/service/args.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "vbcdx.js");
const run = (args, env) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", ...(env ? { env } : {}) });
// A flag as a whole word: --tunnel must not match inside --tunnel-name.
const has = (text, flag) => new RegExp(`(^|[^a-z-])${flag}(?![a-z-])`, "m").test(text);
// A Usage entry of HELP, by its first line's start ("  vbcdx fetch "), so the Options text that
// mentions `vbcdx fetch` in prose doesn't count.
const entry = (text, head) => new RegExp(`^  vbcdx ${head.replace(/[|<>[\]]/g, "\\$&")}`, "m").test(text);
// The shared Options text: its first row.
const OPTIONS_ROW = "--pack=<package|path>";

const INSTALL = [...INSTALL_COMMON, ...SIDECAR_ONLY, ...CONTROL_ONLY, ...DISPATCH_ONLY, ...KEYHOLE_ONLY];
// Each intercepted command (and its forms): the parser options it must show, its own Usage
// entries, the other commands' entries it must not show, and whether the shared Options text
// (the --harness commands' options) belongs: only for the harness forms, never a service form,
// whose parser takes none of those options.
const CASES = [
  { argv: ["install", "service", "--help"], flags: INSTALL, own: ["install service <service>"],
    not: ["doctor", "service <service>", "remove "], options: false },
  { argv: ["install", "agent", "--help"], flags: ["--harness"], own: ["install agent", "install skill", "install tool"],
    not: ["doctor", "remove "], options: true },
  { argv: ["remove", "service", "--help"], flags: REMOVE_OPTIONS, own: ["remove  service <service>"],
    not: ["install service <service>", "install agent"], options: false },
  { argv: ["remove", "agent", "x", "--help"], flags: ["--harness"], own: ["remove <agent|skill|tool>"], not: ["install agent", "doctor"], options: true },
  { argv: ["doctor", "--help"], flags: [...DOCTOR_OPTIONS, "--harness"], own: ["doctor  --service", "doctor "], not: ["remove", "install"], options: true },
  { argv: ["doctor", "--service", "sidecar", "--help"], flags: DOCTOR_OPTIONS, own: ["doctor  --service"], not: ["remove", "install"], options: false },
  { argv: ["service", "--help"], flags: SERVICE_OPTIONS, words: ACTIONS, own: ["service <service>"], not: ["install", "doctor"], options: false },
  { argv: ["service", "sidecar", "--help"], flags: SERVICE_OPTIONS, words: ACTIONS, own: ["service <service>"], not: ["install"], options: false },
  { argv: ["list", "services", "--help"], flags: LIST_OPTIONS, own: ["list    services"], not: ["install", "doctor"], options: false },
  { argv: ["list", "--help"], flags: ["--harness"], own: ["list "], not: ["install", "doctor"], options: true },
  { argv: ["packs", "--help"], flags: [], own: ["packs "], not: ["fetch", "sources", "install"], options: true },
  { argv: ["fetch", "--help"], flags: ["--sources", "--lock", "--store"], own: ["fetch "], not: ["sources", "packs", "install"], options: true },
  { argv: ["sources", "--help"], flags: ["--lock"], own: ["sources "], not: ["fetch", "packs", "install"], options: true },
  { argv: ["config", "--help"], flags: [], words: ["sidecar|keyhole|dispatch", "config service <svc> --help"], own: ["config  service"],
    not: ["install", "service <service>", "doctor"], options: false },
  { argv: ["config", "-h"], flags: [], own: ["config  service"], not: ["install", "doctor"], options: false },
];

test("each command's --help exits 0, shows its own entries and every option its parser takes, and no other command", () => {
  for (const c of CASES) {
    const r = run(c.argv);
    const what = c.argv.join(" ");
    assert.equal(r.status, 0, `${what}: ${r.stderr}`);
    assert.match(r.stdout, /^Usage:\n/, what);
    for (const head of c.own) assert.ok(entry(r.stdout, head), `${what} lacks its entry "vbcdx ${head}"`);
    for (const head of c.not) assert.ok(!entry(r.stdout, head), `${what} shows another command's entry "vbcdx ${head}"`);
    for (const flag of c.flags) assert.ok(has(r.stdout, flag), `${what} omits ${flag}`);
    for (const w of c.words || []) assert.ok(r.stdout.includes(w), `${what} omits ${w}`);
    assert.equal(r.stdout.includes(OPTIONS_ROW), c.options, `${what}: the shared Options text should${c.options ? "" : " not"} be there`);
    // The layout: the Options text ends on its last line, right before the pointer to the root help.
    assert.ok(r.stdout.endsWith(c.options ? "on the command line.\nAll commands: vbcdx --help\n" : "\n\nAll commands: vbcdx --help\n"), `${what}: ${JSON.stringify(r.stdout.slice(-80))}`);
  }
});

// Every intercepted command, and the root help, apart from the Exit codes block: that is the
// root help's alone, never a command's.
test("the Exit codes block is in the root help only", () => {
  for (const c of CASES) assert.ok(!run(c.argv).stdout.includes("Exit codes:"), `${c.argv.join(" ")} shows the Exit codes block`);
  for (const argv of [["--help"], ["-h"], ["help"], []]) assert.ok(run(argv).stdout.includes("\nExit codes:\n"), `vbcdx ${argv.join(" ")} lacks it`);
});

test("-h is the same as --help", () => {
  const short = run(["install", "service", "sidecar", "-h"]);
  assert.equal(short.status, 0, short.stderr);
  assert.match(short.stdout, /^Usage:\n {2}vbcdx install/);
  assert.equal(short.stdout, run(["install", "service", "--help"]).stdout);
});

test("--help is never taken as an option's value, and nothing runs", () => {
  const r = run(["install", "service", "sidecar", "--version", "--help"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Usage:\n {2}vbcdx install/);
  assert.equal(r.stderr, "");
});

test("an option a command doesn't take still exits 2, naming it", () => {
  const r = run(["install", "service", "sidecar", "--bogus", "--dry-run"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--bogus/);
});

// A private HOME and runtime dir, so the passthrough finds no user-scope sidecar. A system
// sidecar is found through /etc, which a test can't redirect: on such a host, skip rather than
// run the real vbcdx-svc.
test("config service … --help still goes to the sidecar's vbcdx-svc, not to this help", { skip: existsSync("/etc/vbcdx/default/install.json") && "a system sidecar is installed here" }, () => {
  const home = mkdtempSync(join(tmpdir(), "vbcdx-help-"));
  try {
    const r = run(["config", "service", "sidecar", "--help"], { PATH: process.env.PATH, HOME: home, XDG_RUNTIME_DIR: home });
    assert.ok(!r.stdout.includes("All commands: vbcdx --help"), r.stdout);
    // It reached the passthrough: the sidecar instance lookup, which finds none here.
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /No sidecar instance "default" is installed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// The flags the docs use with each command, from their command lines (a `\` continues one).
const DOC_HEADS = [
  ["install service", ["install", "service", "--help"]],
  ["remove service", ["remove", "service", "--help"]],
  ["doctor", ["doctor", "--help"]],
  ["list services", ["list", "services", "--help"]],
  ["service", ["service", "--help"]],
];
function docFlags() {
  const files = ["README.md", ...readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => join("docs", f))];
  const found = new Map(DOC_HEADS.map(([h]) => [h, new Set()]));
  for (const f of files) {
    const lines = readFileSync(join(ROOT, f), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*(?:sudo\s+)?vbcdx\s+(install service|remove service|doctor|list services|service)\b(.*)$/);
      if (!m) continue;
      let rest = m[2];
      while (rest.trimEnd().endsWith("\\") && i + 1 < lines.length) rest = rest.trimEnd().slice(0, -1) + " " + lines[++i];
      rest = rest.replace(/\s#.*$/, "");
      for (const flag of rest.match(/--[a-z][a-z-]*/g) || []) found.get(m[1]).add(flag);
    }
  }
  return found;
}

test("each command's --help shows every flag the docs use with it", () => {
  const found = docFlags();
  // Each of these is used with flags in the docs; an empty set means the scan broke for it.
  for (const head of ["install service", "remove service", "doctor", "service"]) {
    assert.ok(found.get(head).size > 0, `the docs scan found no flags for "${head}"`);
  }
  for (const [head, argv] of DOC_HEADS) {
    const r = run(argv);
    for (const flag of found.get(head)) assert.ok(has(r.stdout, flag), `docs use ${flag} with "${head}", its --help omits it`);
  }
});
