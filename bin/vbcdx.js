#!/usr/bin/env node
// Executable entrypoint for @vbcdx/vbcdx: one installer for agents, skills and
// MCP tool packages across harnesses.
//
// Exit codes follow the installer taxonomy (src/errors.js): 0 ok; 2 CLI/config;
// 3 credential; 4 filesystem; 5 conflict / unsupported / failed doctor check;
// 6 native subprocess.

import { packageVersion } from "../src/index.js";
import { EXIT, InstallerError } from "../src/errors.js";
import { conflictLines } from "../src/executor.js";
import { parseVbcdxArgs, printable, printableValue } from "../src/install/args.js";
import { resolveContext } from "../src/install/context.js";
import { installAgent, installSkill, installTool, list, remove, doctor, frontmatter } from "../src/install/commands.js";
import { loadCatalog, setActiveCatalog, activeCatalog } from "../src/packs/catalog.js";
import { roleIds } from "../src/roles/index.js";
import { fetchSources } from "../src/sources/fetch.js";
import { readLock, provenance } from "../src/sources/lock.js";
import { dirname, resolve } from "node:path";
import { parseEnvFile } from "../src/config/env-parser.js";
import { overlayDirsFrom } from "../src/config/config.js";
import { isLocalPath } from "../src/install/locate.js";

const HELP = `vbcdx — install agent packs, skills and MCP tools into your harness

Usage:
  vbcdx install agent <id>[,<id>...]|all --harness=<h>
                                                     render agent definitions, bound to installed tools
  vbcdx install skill <name>         --harness=<h>   copy a skill from an agent pack
  vbcdx install tool  <package|path> --harness=<h>   register an installed tool package's MCP server
  vbcdx packs                                        the agent packs found, with their roles and skills
  vbcdx list                         --harness=<h>   what is installed for a harness
  vbcdx remove <agent|skill|tool> <name> --harness=<h>  remove only what vbcdx wrote
  vbcdx doctor                       --harness=<h>   check installed tools (never prints a value)
  vbcdx fetch   [--sources=<file>] [--lock=<file>] [--store=<dir>]
                                                     build time: fetch every source, write the lock
  vbcdx sources [--lock=<file>]                      the lock's sources: repo, ref and commit
  vbcdx --help | --version

Harnesses: claude, codex, opencode, hermes

Options:
  --pack=<package|path>    the agent pack to take roles and skills from (repeatable; install
                           agent, install skill, packs); default: every installed agent pack
  --overlay=<dir>          a team overlay to layer onto the roles (repeatable, applied in
                           order; install agent), after any in the --env file's
                           VBCDX_AGENTS_OVERLAY_DIRS
  --scope=<user|project>   default user (claude, codex, opencode)
  --env=<absolute path>    literal config file pinning every directory (see .env.example);
                           without it vbcdx uses the harness's own home and ~/.vbcdx
  --lock=<file>            take agent packs and tool packages only from this lock (written by
                           vbcdx fetch); nothing is fetched or searched (install, packs)
  --sources=<file>         the sources to fetch; default ./vbcdx.sources.json (fetch)
  --store=<dir>            where fetched sources live; default vbcdx-store next to the lock
  --force                  replace content edited since vbcdx wrote it
  --dry-run                report what would change; write nothing
  --json                   print the report as JSON
  --quiet                  suppress routine progress

Agent packs and tool packages are not installed from the registry: npm install -g <package>
first, or list them in vbcdx.sources.json, run vbcdx fetch at build time and pass --lock.
No credential or endpoint value is ever accepted on the command line.
`;

// Each value placed in a report line (a package name, a path, a tool's error) is escaped
// on its own, newline and tab included, so it cannot break the line or forge another.
const L = (strings, ...values) => strings.reduce((line, s, i) => line + printableValue(values[i - 1]) + s);

// An error prints as "error: " and then lines of its own: each line is one escaped value,
// so a parser's code frame quoting a config file, a path or a tool's output can never add
// a line. An error that lists items carries its layout in details.lines.
function errorText(lines) {
  return lines.map((l, i) => (i === 0 ? L`error: ${l}` : L`${l}`)).join("\n") + "\n";
}
function errorLines(e) {
  if (e instanceof InstallerError && e.details && Array.isArray(e.details.lines)) return e.details.lines;
  return [e && e.message ? e.message : String(e)];
}

function human(report) {
  const lines = [];
  const verb = report.dryRun ? "Planned" : "Applied";
  if (report.removed) {
    lines.push(L`${verb} remove ${report.kind} ${report.name} for ${report.harness}`);
    for (const r of report.removed) lines.push(L`  ${r.action}: ${r.path}`);
  } else if (report.kind === "tool") {
    lines.push(L`${verb} tool ${report.package}@${report.version} as MCP server "${report.server}" (${report.tools === null ? "manifest not run" : `${report.tools} tools`}) for ${report.harness}: ${report.action}`);
    if (report.file) lines.push(L`  ${report.file}`);
    if (report.command) lines.push(L`  ${report.command}`);
  } else if (report.kind === "skill") {
    lines.push(L`${verb} skill ${report.skill} for ${report.harness}: ${report.action}`, L`  ${report.file}`);
  } else if (report.kind === "agent") {
    lines.push(L`${verb} agents for ${report.harness} (${report.scope})`);
    for (const g of report.generated) lines.push(L`  ${g.role}: ${g.action} -> ${g.destination}`);
    for (const c of report.credentials) lines.push(L`  credential ${c.service ? `${c.role}/${c.service}` : c.role}: ${c.action}`);
    if (report.integrations && report.integrations.length) lines.push(L`  bound tools: ${report.integrations.join(", ")}`);
    for (const o of report.overlays || []) lines.push(L`  overlay ${o.name} ${o.version} ${o.digest}`); // one parseable line per overlay
    for (const [k, v] of Object.entries(report.launchEnv || {})) lines.push(L`  launch with ${k}=${v}`);
  } else if (report.checks === undefined && report.tools && report.agents) {
    lines.push(L`Installed for ${report.harness} (manifest ${report.manifest}):`);
    for (const t of report.tools) lines.push(L`  tool  ${t.server}  ${t.package}@${t.version}  ${t.scope}  ${t.tools} tools${t.file ? `  ${t.file}` : ""}`);
    for (const a of report.agents) lines.push(L`  agent ${a.role}  ${a.files.length} file(s)`);
    for (const s of report.skills) lines.push(L`  skill ${s.name}  ${s.file}`);
    if (!report.tools.length && !report.agents.length && !report.skills.length) lines.push("  nothing");
  }
  return lines.join("\n");
}

function humanPacks(report) {
  if (!report.packs.length) return "no agent packs found";
  const lines = [];
  for (const p of report.packs) {
    lines.push(L`${p.name}  ${p.package}@${p.version}  ${p.dir}`);
    lines.push(L`  roles: ${p.roles.join(", ")}`);
    if (p.skills.length) lines.push(L`  skills: ${p.skills.map((s) => `${s.name} (${s.file})`).join(", ")}`);
    if (p.contracts.length) lines.push(L`  tool contracts: ${p.contracts.join(", ")}`);
  }
  return lines.join("\n");
}

// Provenance: every source's origin and the exact commit it resolved to.
function humanSources(head, sources) {
  const lines = [L`${head}`];
  for (const s of sources) {
    lines.push(s.git
      ? L`  source ${s.name} (${s.kinds.join("+")}): ${s.git} ${s.ref} @ ${s.sha}`
      : L`  source ${s.name} (${s.kinds.join("+")}): dir ${s.dir} (${s.digest})`);
  }
  return lines.join("\n");
}

function humanDoctor(report) {
  const lines = [L`doctor for ${report.harness}: ${report.ok ? "ok" : "problems found"}`];
  if (!report.tools.length) lines.push("  no tools installed");
  for (const t of report.tools) {
    lines.push(L`  ${t.server} (${t.package}, ${t.scope}): ${t.ok ? "ok" : "FAIL"}`);
    for (const c of t.checks) lines.push(L`    ${c.ok ? "ok  " : "FAIL"} ${c.check}: ${c.detail}`);
  }
  return lines.join("\n");
}

const out = (text) => process.stdout.write(printable(text));
const err = (text) => process.stderr.write(printable(text));

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === "--version" || cmd === "-v") {
    out(packageVersion() + "\n");
    return EXIT.OK;
  }
  if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") {
    out(HELP);
    return cmd === undefined ? EXIT.CONFIG : EXIT.OK;
  }
  if (cmd === "init") {
    err("error: `vbcdx init` does not exist; use `vbcdx install agent`, or the deprecated `vbcdx-dev-agents init`.\n");
    return EXIT.CONFIG;
  }
  try {
    const opts = parseVbcdxArgs(argv);
    const lookup = { cwd: process.cwd(), home: process.env.HOME };
    const abs = (p) => resolve(process.cwd(), p);
    if (opts.command === "fetch") {
      const sourcesPath = abs(opts.sources || "vbcdx.sources.json");
      const lockPath = opts.lock ? abs(opts.lock) : resolve(dirname(sourcesPath), "vbcdx.lock.json");
      const storeDir = opts.store ? abs(opts.store) : resolve(dirname(lockPath), "vbcdx-store");
      const report = fetchSources({ sourcesPath, lockPath, storeDir });
      if (opts.json) out(JSON.stringify(report, null, 2) + "\n");
      else if (!opts.quiet) out(humanSources(`Fetched ${report.sources.length} source(s); lock ${report.lock}`, report.sources) + "\n");
      return EXIT.OK;
    }
    const lock = opts.command === "sources" || opts.lock !== null
      ? readLock(abs(opts.lock || "vbcdx.lock.json"), { store: opts.store ? abs(opts.store) : undefined })
      : null;
    if (opts.command === "sources") {
      const sources = provenance(lock);
      out((opts.json ? JSON.stringify({ lock: lock.path, store: lock.store, sources }, null, 2) : humanSources(`Lock ${lock.path}`, sources)) + "\n");
      return EXIT.OK;
    }
    if (lock) lookup.lock = lock;
    if (opts.command === "packs") {
      const catalog = loadCatalog(opts.packs, { ...lookup, allowEmpty: true });
      const report = packsReport(catalog);
      out((opts.json ? JSON.stringify(report, null, 2) : humanPacks(report)) + "\n");
      return EXIT.OK;
    }
    // Only installing an agent or a skill reads roles: load the packs before the config,
    // which checks per-role keys against them.
    if (opts.command === "install" && (opts.kind === "agent" || opts.kind === "skill")) {
      // Overlays, for install agent: --overlay in order, then the --env
      // file's VBCDX_AGENTS_OVERLAY_DIRS.
      const overlays = [
        // With --lock, an overlay that is not a path names a lock source.
        ...opts.overlays.map((d) => (lock && !isLocalPath(d) ? d : resolve(process.cwd(), d))),
        ...(opts.kind === "agent" && opts.env ? overlayDirsFrom(parseEnvFile(opts.env)) : []),
      ];
      setActiveCatalog(loadCatalog(opts.packs, { ...lookup, overlays }));
    } else if (opts.command === "remove" && opts.kind === "skill") {
      // Best effort: the installed packs map a catalogue name (WRITING-NOTES) to the name the
      // skill installed under. Without them a skill is still removable by its installed name.
      try {
        setActiveCatalog(loadCatalog([], { ...lookup, allowEmpty: true }));
      } catch {
        // an unreadable installed pack must not block removing what vbcdx wrote
      }
    }
    const ctx = resolveContext({ harness: opts.harness, scope: opts.scope, envPath: opts.env, requireHome: opts.command === "install" });
    ctx.lock = lock;
    const flags = { force: opts.force, dryRun: opts.dryRun };
    let report;
    if (opts.command === "install") {
      const name = opts.names[0];
      if (opts.kind === "agent") {
        // `all` is every role of the loaded packs, in pack order.
        const names = opts.names.length === 1 && opts.names[0] === "all" ? roleIds() : opts.names;
        report = installAgent(ctx, names, flags);
        if (activeCatalog().overlays.length) report.overlays = activeCatalog().overlays;
      }
      else if (opts.kind === "skill") report = installSkill(ctx, name, flags);
      else report = installTool(ctx, name, flags);
    } else if (opts.command === "remove") {
      report = remove(ctx, opts.kind, opts.names[0], flags);
    } else if (opts.command === "list") {
      report = list(ctx);
    } else {
      report = doctor(ctx);
      out((opts.json ? JSON.stringify(report, null, 2) : humanDoctor(report)) + "\n");
      return report.ok ? EXIT.OK : EXIT.CONFLICT;
    }
    if (lock) report.sources = provenance(lock);
    if (opts.json) out(JSON.stringify(report, null, 2) + "\n");
    else if (!opts.quiet) out(human(report) + (lock ? "\n" + humanSources("  from lock", report.sources) : "") + "\n");
    for (const w of report.warnings || []) err(L`warning: ${w}` + "\n");
    // A dry run that finds a conflict exits as the real run would.
    if (report.conflict) {
      err(errorText([`${report.file} would be refused: ${report.conflict}`]));
      return EXIT.CONFLICT;
    }
    const conflicts = report.conflicts || [];
    if (conflicts.length) {
      err(errorText([`${conflicts.length} item(s) would be refused (rerun with --force):`, ...conflictLines(conflicts, report.conflict_notes)]));
      return EXIT.CONFLICT;
    }
    if (report.credential_errors && report.credential_errors.length) {
      err(errorText(report.credential_errors));
      return EXIT.CREDENTIAL;
    }
    return EXIT.OK;
  } catch (e) {
    if (e instanceof InstallerError) {
      err(errorText(errorLines(e)));
      return e.code;
    }
    err(errorText(errorLines(e)));
    return EXIT.FILESYSTEM;
  }
}

function packsReport(catalog) {
  return {
    packs: catalog.packs.map((p) => ({
      name: p.name, package: p.package, version: p.version, dir: p.dir,
      roles: p.roles.map((r) => r.id),
      // Each skill by the name it installs as (its frontmatter name), the file-stem id
      // `install skill` also accepts, and the file it comes from.
      skills: [...catalog.skills.bySlug.values()].flatMap((c) => [...c.skills.values()].filter((s) => s.pack === p.name).map((s) => {
        const id = s.file.replace(/\.MD$/, "").toLowerCase();
        const name = frontmatter(s.content).name;
        return { name: typeof name === "string" ? name : id, id, file: `${c.slug}/${s.file}` };
      })),
      contracts: [...p.contracts],
    })),
  };
}

main().then((code) => process.exit(code), (e) => {
  // A bug: the message is one escaped value; the stack frames are vbcdx's own.
  const frames = e && e.stack ? String(e.stack).split("\n").filter((l) => /^\s+at /.test(l)) : [];
  err([L`fatal: ${e && e.message ? e.message : String(e)}`, ...frames.map((f) => L`${f}`)].join("\n") + "\n");
  process.exit(1);
});
