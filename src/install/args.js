// Argument parsing for the `vbcdx` front door.
//
//   vbcdx install <agent|skill|tool> <name>[,<name>...] --harness=<h> [options]
//   vbcdx remove  <agent|skill|tool> <name>             --harness=<h> [options]
//   vbcdx list | doctor                                 --harness=<h> [--env=...] [--scope=...]
//   vbcdx packs                                         [--pack=...] [--json]
//
// As for `init`, no credential or endpoint value is accepted on the command line;
// --env names a literal configuration file and is optional here (see context.js).
// Agent ids are checked here for shape only: whether one names a role is up to the
// agent packs, which the caller loads (from the --pack values) after parsing.

import { isAbsolute } from "node:path";
import { HARNESSES, isSafeId } from "../roles/registry.js";
import { configError } from "../errors.js";

export const KINDS = Object.freeze(["agent", "skill", "tool"]);

function parseAgents(raw) {
  const out = [];
  for (const item of raw.split(",").map((s) => s.trim())) {
    if (item === "") throw configError("The agent list contains an empty item.");
    if (!isSafeId(item)) throw configError(`Unknown agent ID: ${item}.`);
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * @param {string[]} argv the arguments after `vbcdx`
 * @returns {{command: string, kind?: string, names?: string[], harness: string, scope: string,
 *   env: string|null, force: boolean, dryRun: boolean, quiet: boolean, json: boolean}}
 */
export function parseVbcdxArgs(argv) {
  const [command, ...rest] = argv;
  if (!["install", "remove", "list", "doctor", "packs", "fetch", "sources"].includes(command)) throw configError(`Unknown command: ${command}.`);
  const positional = [];
  const opts = { command, harness: null, scope: null, env: null, packs: [], overlays: [], force: false, dryRun: false, quiet: false, json: false,
    lock: null, sources: null, store: null };
  for (const arg of rest) {
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const value = eq === -1 ? null : arg.slice(eq + 1);
    const need = () => {
      if (!value) throw configError(`${key} requires a value (use ${key}=<value>).`);
      return value;
    };
    const flag = () => {
      if (value !== null) throw configError(`${key} takes no value.`);
      return true;
    };
    switch (key) {
      case "--harness": opts.harness = need(); break;
      case "--scope": opts.scope = need(); break;
      case "--env": opts.env = need(); break;
      case "--pack": opts.packs.push(need()); break;
      case "--lock": opts.lock = need(); break;
      case "--sources": opts.sources = need(); break;
      case "--store": opts.store = need(); break;
      case "--overlay": opts.overlays.push(need()); break;
      case "--force": opts.force = flag(); break;
      case "--dry-run": opts.dryRun = flag(); break;
      case "--quiet": opts.quiet = flag(); break;
      case "--json": opts.json = flag(); break;
      default: throw configError(`Unknown or malformed option: ${arg}.`);
    }
  }

  if (command === "install" || command === "remove") {
    const [kind, name, ...extra] = positional;
    if (!KINDS.includes(kind)) throw configError(`${command} needs a kind: agent, skill or tool.`);
    if (!name) throw configError(`${command} ${kind} needs a name.`);
    if (extra.length) throw configError(`Unexpected argument: ${extra[0]}.`);
    opts.kind = kind;
    if (kind === "agent") {
      opts.names = parseAgents(name);
      if (command === "remove" && opts.names.length !== 1) throw configError("remove agent takes one agent ID.");
    } else {
      if (name.includes(",")) throw configError(`${command} ${kind} takes one name.`);
      opts.names = [name];
    }
  } else if (positional.length) {
    throw configError(`${command} takes no positional arguments.`);
  }
  // Custom sources: fetch writes the lock at build time; sources prints it.
  if (command === "fetch" || command === "sources") {
    if (positional.length) throw configError(`${command} takes no positional arguments.`);
    for (const k of ["harness", "scope", "env"]) if (opts[k] !== null) throw configError(`${command} does not take --${k}.`);
    if (opts.packs.length || opts.force || opts.dryRun) throw configError(`${command} does not take --pack, --force or --dry-run.`);
    if (command === "sources" && opts.sources !== null) throw configError("sources does not take --sources; it reads the lock.");
    return opts;
  }
  if (opts.sources !== null) throw configError(`${command} does not take --sources; only fetch reads the sources file.`);
  const takesLock = command === "packs" || command === "install";
  if (opts.lock !== null && !takesLock) throw configError(`${command} does not take --lock.`);
  if (opts.store !== null && opts.lock === null) throw configError("--store goes with --lock.");
  if ((command === "list" || command === "doctor" || command === "packs") && (opts.force || opts.dryRun)) {
    throw configError(`${command} does not take --force or --dry-run.`);
  }
  // Only what reads roles or skills takes --pack: listing packs, installing an agent or a skill.
  const takesPacks = command === "packs" || (command === "install" && (opts.kind === "agent" || opts.kind === "skill"));
  if (opts.packs.length && !takesPacks) throw configError(`${command}${opts.kind ? ` ${opts.kind}` : ""} does not take --pack.`);
  if (opts.overlays.length && !(command === "install" && opts.kind === "agent")) throw configError("Only install agent takes --overlay.");
  if (command === "packs") {
    for (const k of ["harness", "scope", "env"]) {
      if (opts[k] !== null) throw configError(`packs does not take --${k}.`);
    }
    return opts;
  }

  if (!opts.harness) throw configError(`--harness is required (${HARNESSES.join("|")}).`);
  if (!HARNESSES.includes(opts.harness)) throw configError(`Unsupported --harness: ${opts.harness}.`);
  if (opts.env !== null && !isAbsolute(opts.env)) throw configError("--env must be an absolute path.");

  if (opts.harness === "hermes") {
    if (opts.scope !== null) throw configError("Hermes has no project scope and does not accept --scope.");
    opts.scope = "user";
  } else {
    opts.scope = opts.scope || "user";
    if (!["user", "project"].includes(opts.scope)) throw configError(`Unsupported --scope: ${opts.scope}. Use user or project.`);
  }
  return opts;
}

// Text a tool package or the filesystem supplied (a path, a description, an error) can
// hold terminal control sequences or invisible characters. Every line vbcdx prints goes
// through printable: newlines and tabs are kept; every other C0/C1 control character,
// U+2028/U+2029, every Unicode format character (bidi overrides and isolates, zero-width
// characters, the soft hyphen, tag characters) and any lone surrogate is shown as a \u
// escape, so output can be neither reordered, hidden nor used to drive the terminal.
// A value placed inside a printed line goes through printableValue, which escapes
// newlines and tabs too, so a value can never break its line or forge another.
// JSON.stringify leaves C1 controls and U+2028/U+2029 raw, so --json goes through it too.
const UNPRINTABLE_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}|\p{Cs}/gu;
const UNPRINTABLE_VALUE_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}|\p{Cs}/gu;
const escapeChar = (c) => {
  const n = c.codePointAt(0);
  return n > 0xffff ? `\\u{${n.toString(16)}}` : `\\u${n.toString(16).padStart(4, "0")}`;
};
export function printable(text) {
  return String(text).replace(UNPRINTABLE_RE, escapeChar);
}
export function printableValue(text) {
  return String(text).replace(UNPRINTABLE_VALUE_RE, escapeChar);
}
