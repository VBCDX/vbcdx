// `vbcdx --help` documents every service command the parser accepts: every installable
// service, every option of every command, and each service's own flags on its row.
// The sets come from the parser itself, so an option added there without a help line fails here,
// and a help line naming an option the parser refuses fails too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INSTALL_COMMON, SIDECAR_ONLY, CONTROL_ONLY, DISPATCH_ONLY, KEYHOLE_ONLY,
  REMOVE_OPTIONS, LIST_OPTIONS, DOCTOR_OPTIONS, SERVICE_OPTIONS, ACTIONS, CONFIG_AREAS,
} from "../src/service/args.js";
import { PROFILES } from "../src/service/plan.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "vbcdx.js");

function help() {
  const r = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

// A flag as a whole word: --tunnel must not match inside --tunnel-name.
const has = (text, flag) => new RegExp(`(^|[^a-z-])${flag}(?![a-z-])`, "m").test(text);

const lines = help().split("\n");
const indent = (l) => l.length - l.trimStart().length;

/** The lines from the first one starting (after indent) with `head`, up to the next line at that
 *  indent or less. */
function block(head) {
  const i = lines.findIndex((l) => l.trimStart().startsWith(head));
  assert.notEqual(i, -1, `help has no line starting with "${head}"`);
  const out = [lines[i]];
  for (let j = i + 1; j < lines.length && lines[j].trim() !== "" && indent(lines[j]) > indent(lines[i]); j++) out.push(lines[j]);
  return out.join("\n");
}

// The install block: from its usage line through the per-service rows, up to the remove line.
function installBlock() {
  const i = lines.findIndex((l) => l.trimStart().startsWith("vbcdx install service <service>"));
  const j = lines.findIndex((l) => l.trimStart().startsWith("vbcdx remove  service <service>"));
  assert.ok(i !== -1 && j > i, "help has the install service block, then the remove line");
  return lines.slice(i, j).join("\n");
}

test("the help names exactly the services the installer can install", () => {
  const line = lines.find((l) => l.includes("<service> is one of:"));
  assert.ok(line, "help has a '<service> is one of:' line");
  const named = line.split("one of:")[1].split(".")[0].split(",").map((s) => s.trim());
  assert.deepEqual([...named].sort(), Object.keys(PROFILES).sort());
  // Keyhole and Dispatch are config areas of the sidecar, not something to install or remove.
  for (const area of CONFIG_AREAS) {
    assert.ok(!named.includes(area), `help offers ${area} as a service to install`);
    assert.ok(!lines.some((l) => new RegExp(`(install|remove)\\S* +service +\\S*\\b${area}\\b(?!-)`).test(l)),
      `help still offers install or remove service ${area}`);
    assert.ok(block("vbcdx config  service").includes(area), `config service's help omits ${area}`);
  }
});

test("install documents every option the parser takes", () => {
  const text = installBlock();
  for (const flag of [...INSTALL_COMMON, ...SIDECAR_ONLY, ...CONTROL_ONLY, ...DISPATCH_ONLY, ...KEYHOLE_ONLY]) {
    assert.ok(has(text, flag), `install's help omits ${flag}`);
  }
});

test("each service's own flags are on that service's row", () => {
  const rows = { sidecar: SIDECAR_ONLY, "control-plane": CONTROL_ONLY, "dispatch-server": DISPATCH_ONLY, "keyhole-server": KEYHOLE_ONLY };
  assert.deepEqual(Object.keys(rows).sort(), Object.keys(PROFILES).sort(), "a row for every installable service");
  for (const [service, flags] of Object.entries(rows)) {
    const row = block(`${service}  `);
    for (const flag of flags) assert.ok(has(row, flag), `the ${service} row omits ${flag}`);
  }
});

test("remove, list, doctor and service document their options", () => {
  const cases = [
    ["vbcdx remove  service <service>", REMOVE_OPTIONS],
    ["vbcdx list    services", LIST_OPTIONS],
    ["vbcdx doctor  --service <service>", DOCTOR_OPTIONS],
    ["vbcdx service <service>", SERVICE_OPTIONS],
  ];
  for (const [head, flags] of cases) {
    const text = block(head);
    for (const flag of flags) assert.ok(has(text, flag), `"${head}" omits ${flag}`);
  }
  const svc = block("vbcdx service <service>");
  for (const action of ACTIONS) assert.ok(svc.includes(action), `service's help omits ${action}`);
});

test("every option the service help names is one the parser accepts", () => {
  const accepted = new Set([...INSTALL_COMMON, ...SIDECAR_ONLY, ...CONTROL_ONLY, ...DISPATCH_ONLY, ...KEYHOLE_ONLY,
    ...REMOVE_OPTIONS, ...LIST_OPTIONS, ...DOCTOR_OPTIONS, ...SERVICE_OPTIONS]);
  const text = [installBlock(), block("vbcdx remove  service <service>"), block("vbcdx list    services"),
    block("vbcdx doctor  --service <service>"), block("vbcdx service <service>")].join("\n");
  const named = new Set(text.match(/--[a-z][a-z-]*/g));
  for (const flag of named) assert.ok(accepted.has(flag), `the help names ${flag}, which the parser refuses`);
});

test("the flag matcher is whole-word, and catches a missing flag", () => {
  assert.ok(has("[--tunnel-name <n>]", "--tunnel-name"));
  assert.ok(!has("[--tunnel-name <n>]", "--tunnel"));
  assert.ok(has("[--tunnel <h>|--no-tunnel]", "--tunnel"));
  assert.ok(!has("vbcdx install service sidecar", "--json"));
});

// The root help's Exit codes block: exactly the installer's codes (src/errors.js EXIT), one line
// each, with the same meaning as README.md's Exit codes table, so the three can't drift.
test("the root help lists every exit code the installer uses, as the README does", async () => {
  const { EXIT } = await import("../src/errors.js");
  const i = lines.indexOf("Exit codes:");
  assert.notEqual(i, -1, "the root help has an Exit codes block");
  const rows = [];
  for (let j = i + 1; j < lines.length && lines[j].trim() !== ""; j++) {
    const m = lines[j].match(/^ {2}(\d+) {2}(\S.*)$/);
    assert.ok(m, `not an exit-code row: "${lines[j]}"`);
    rows.push([Number(m[1]), m[2]]);
  }
  assert.deepEqual(rows.map(([c]) => c), Object.values(EXIT).sort((a, b) => a - b), "the help's codes are exactly EXIT's, in order");
  const readme = readFileSync(join(dirname(BIN), "..", "README.md"), "utf8");
  const table = readme.slice(readme.indexOf("## Exit codes"));
  const documented = [...table.slice(0, table.indexOf("\n## ", 1)).matchAll(/^\| (\d+) \| (.+) \|$/gm)].map((m) => [Number(m[1]), m[2].replaceAll("`", "")]);
  assert.deepEqual(rows, documented, "the help's rows match README.md's Exit codes table");
});
