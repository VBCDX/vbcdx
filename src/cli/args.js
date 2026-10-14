// CLI argument parsing for `init` (spec section 3).
//
// No credential or endpoint value is ever accepted on the command line — only
// --harness, --env (an absolute path), --agents, --pack, --scope, and the
// boolean flags. Unknown options and values are rejected (exit 2).
//
// --agents is checked here for shape only. Whether each id names a role, and the
// default (every role of the loaded agent packs), is settled by the planner once
// the packs named with --pack (see packSpecs) are loaded.

import { isAbsolute } from "node:path";
import { HARNESSES, isSafeId } from "../roles/registry.js";
import { configError } from "../errors.js";

function parseSelection(raw) {
  const items = raw.split(",").map((s) => s.trim());
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (item === "") throw configError("--agents contains an empty item.");
    if (!isSafeId(item)) throw configError(`--agents has an unknown agent ID: ${item}.`);
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  if (out.length === 0) throw configError("--agents selected no agents.");
  return out;
}

/**
 * The --pack values in an argv tail, in order: each names an agent pack by npm
 * package name or path. Read before the full parse so the packs can be loaded first.
 */
export function packSpecs(argv) {
  const out = [];
  for (const arg of argv) {
    if (arg === "--pack" || arg.startsWith("--pack=")) out.push(requireValue("--pack", arg.slice("--pack=".length) || null));
  }
  return out;
}

/**
 * Parse the argv tail after the `init` subcommand.
 * @returns {object} options
 */
export function parseInitArgs(argv) {
  const opts = { agents: null, packs: [], overlays: [], scope: null, force: false, dryRun: false, quiet: false, harness: null, env: null, lock: null, store: null };
  for (const arg of argv) {
    let key = arg;
    let value = null;
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      key = arg.slice(0, eq);
      value = arg.slice(eq + 1);
    }
    switch (key) {
      case "--harness": opts.harness = requireValue(key, value); break;
      case "--env": opts.env = requireValue(key, value); break;
      case "--agents": opts.agents = parseSelection(requireValue(key, value)); break;
      case "--pack": opts.packs.push(requireValue(key, value)); break;
      case "--overlay": {
        const dir = requireValue(key, value);
        if (!isAbsolute(dir)) throw configError("--overlay must be an absolute path.");
        opts.overlays.push(dir);
        break;
      }
      case "--scope": opts.scope = requireValue(key, value); break;
      case "--lock": opts.lock = requireValue(key, value); break;
      case "--store": opts.store = requireValue(key, value); break;
      case "--force": opts.force = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--quiet": opts.quiet = true; break;
      default:
        throw configError(`Unknown or malformed option: ${arg}.`);
    }
  }

  if (!opts.harness) throw configError(`--harness is required (${HARNESSES.join("|")}).`);
  if (!HARNESSES.includes(opts.harness)) throw configError(`Unsupported --harness: ${opts.harness}.`);
  if (!opts.env) throw configError("--env is required (an absolute path to the literal config file).");
  if (!isAbsolute(opts.env)) throw configError("--env must be an absolute path.");
  // Packs from a lock written by `vbcdx fetch`, read offline.
  if (opts.lock !== null && !isAbsolute(opts.lock)) throw configError("--lock must be an absolute path.");
  if (opts.store !== null && (opts.lock === null || !isAbsolute(opts.store))) throw configError("--store goes with --lock and must be an absolute path.");

  // Scope rules.
  if (opts.harness === "hermes") {
    // Hermes agents are profiles under HERMES_HOME; there is no project-scoped profile.
    if (opts.scope !== null) throw configError("Hermes installs one profile per role under HERMES_HOME and does not accept --scope.");
    opts.scope = "user";
  } else {
    if (opts.scope === null) opts.scope = "user";
    if (!["user", "project"].includes(opts.scope)) {
      throw configError(`Unsupported --scope: ${opts.scope}. Use user or project (local/global are not scopes).`);
    }
  }

  opts.agentsExplicit = opts.agents !== null;
  return opts;
}

function requireValue(key, value) {
  if (value === null || value === undefined || value === "") {
    throw configError(`${key} requires a value (use ${key}=<value>).`);
  }
  return value;
}
