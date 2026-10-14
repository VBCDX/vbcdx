#!/usr/bin/env node
// Executable entrypoint for @vbcdx/dev-agents.
//
// Usage:
//   vbcdx-dev-agents init --harness=<claude|codex|opencode|hermes> --env=<abs-path>
//                         [--agents=<list>] [--pack=<package|path>]... [--scope=<user|project>]
//                         [--force] [--dry-run] [--quiet]
//   vbcdx-dev-agents --help
//   vbcdx-dev-agents --version
//
// Exit codes follow the spec taxonomy: 0 ok; 2 CLI/config; 3 credential;
// 4 filesystem; 5 conflict/scope/dependency; 6 native subprocess.

import { init, packageVersion } from "../src/index.js";
import { EXIT, InstallerError } from "../src/errors.js";
import { conflictLines } from "../src/executor.js";
import { printable, printableValue } from "../src/install/args.js";

// The same escaping as bin/vbcdx.js: every write is passed through printable,
// and each value placed in a line (a path, a role field, an error message) is escaped on its
// own with printableValue, newline and tab included, so it can neither drive the terminal
// nor break the line and forge another.
const out = (text) => process.stdout.write(printable(text));
const errOut = (text) => process.stderr.write(printable(text));
const L = (strings, ...values) => strings.reduce((line, s, i) => line + printableValue(values[i - 1]) + s);
// An error prints as "error: " and then lines of its own, one escaped value each. An error
// that lists items carries its layout in details.lines.
const errorText = (lines) => lines.map((l, i) => (i === 0 ? L`error: ${l}` : L`${l}`)).join("\n") + "\n";
const errorLines = (e) =>
  e instanceof InstallerError && e.details && Array.isArray(e.details.lines) ? e.details.lines : [e && e.message ? e.message : String(e)];

const HELP = `vbcdx-dev-agents — install the roles of agent packs (deprecated; use vbcdx)

Commands:
  init --harness=<claude|codex|opencode|hermes> --env=<absolute-config-path>
       [--agents=<comma,separated,ids>]   default: every role of the loaded packs
       [--pack=<package|path>]            agent pack to load (repeatable);
                                          default: every installed agent pack
       [--overlay=<absolute dir>]         team overlay applied to the roles (repeatable,
                                          in order; then VBCDX_AGENTS_OVERLAY_DIRS)
       [--scope=<user|project>]           default: user (not for hermes)
       [--lock=<absolute path>]           take agent packs only from this lock (written by
                                          vbcdx fetch at build time); offline
       [--store=<absolute path>]          the fetched store, if it moved from where the lock says
       [--force]                          replace conflicting generated content
       [--dry-run]                        validate and plan only; write nothing
       [--quiet]                          suppress routine progress
  --help       show this help
  --version    print the package version

No credential or endpoint value is ever accepted on the command line. The
--env file is a literal configuration file (never sourced or interpolated).
`;

function printReport(report) {
  const lines = [];
  const verb = report.dryRun ? "Planned" : "Applied";
  lines.push(L`${verb} install for harness=${report.harness} scope=${report.scope}`);
  for (const g of report.generated) lines.push(L`  definition ${g.role}: ${g.action} -> ${g.destination}`);
  // Files the installer wrote that this render no longer produces.
  for (const r of report.removals) lines.push(L`  removal ${r.role}: ${r.action} -> ${r.destination}`);
  if (report.removals.length) lines.push(L`  removals: ${report.removals.length} file(s) the installer wrote that this render no longer produces`);
  for (const c of report.credentials) lines.push(L`  credential ${c.service ? `${c.role}/${c.service}` : c.role}: ${c.action}` + (c.unknown ? " (unknown role)" : ""));
  if (report.integrations && report.integrations.length) lines.push(L`  integrations bound (offline): ${report.integrations.join(", ")} — runtime registration unverified`);
  // Provenance: each locked source's origin and the commit it resolved to.
  for (const s of report.sources || []) {
    lines.push(s.git ? L`  source ${s.name}: ${s.git} ${s.ref} @ ${s.sha}` : L`  source ${s.name}: dir ${s.dir} (${s.digest})`);
  }
  for (const o of report.overlays || []) lines.push(L`  overlay ${o.name} ${o.version} ${o.digest}`); // one parseable line per overlay
  if (report.launchEnv && Object.keys(report.launchEnv).length) {
    lines.push("  launch environment (set these before starting the harness):");
    for (const [k, v] of Object.entries(report.launchEnv)) lines.push(L`    ${k}=${v}`);
  }
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "--version" || cmd === "-v") {
    out(packageVersion() + "\n");
    return 0;
  }
  if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") {
    out(HELP);
    return cmd === undefined ? 2 : 0;
  }
  if (cmd !== "init") {
    errOut(L`Unknown command: ${cmd}` + "\n\n" + HELP);
    return EXIT.CONFIG;
  }
  // Deprecated alias for one release: the package is now @vbcdx/vbcdx.
  errOut("note: `vbcdx-dev-agents init` is deprecated and will be removed in the next release; use `vbcdx install agent <id> --harness=<h>` (see `vbcdx --help`).\n");

  const opts = argv.slice(1);
  const quiet = opts.includes("--quiet");
  try {
    const report = init(opts);
    if (!quiet) out(printReport(report) + "\n");
    // Warnings, conflicts, skips, and pending states are never suppressed.
    for (const w of report.warnings) errOut(L`warning: ${w}` + "\n");
    // A dry run that finds conflicts or bad credential files exits as the real run
    // would: the real run refuses conflicts first, so that code wins.
    const credErrors = report.credential_errors || [];
    if (credErrors.length) {
      errOut(errorText([`${credErrors.length} existing credential file(s) would be refused (these fail even with --force):`, ...credErrors.map((e) => `  ${e}`)]));
    }
    if (report.conflicts && report.conflicts.length) {
      errOut(errorText([`${report.conflicts.length} file(s) would be refused as modified outside the installer or not package-owned (rerun with --force to replace them):`, ...conflictLines(report.conflicts, report.conflict_notes)]));
      return EXIT.CONFLICT;
    }
    if (credErrors.length) return EXIT.CREDENTIAL;
    return EXIT.OK;
  } catch (err) {
    errOut(errorText(errorLines(err)));
    if (err instanceof InstallerError) return err.code;
    return EXIT.FILESYSTEM;
  }
}

main().then((code) => process.exit(code), (err) => {
  // A bug: the message is one escaped value; the stack frames are this package's own.
  const frames = err && err.stack ? String(err.stack).split("\n").filter((l) => /^\s+at /.test(l)) : [];
  errOut([L`fatal: ${err && err.message ? err.message : String(err)}`, ...frames.map((f) => L`${f}`)].join("\n") + "\n");
  process.exit(1);
});
