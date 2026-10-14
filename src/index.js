// Public programmatic API for @vbcdx/vbcdx (formerly @vbcdx/dev-agents).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { packSpecs, parseInitArgs } from "./cli/args.js";
import { loadCatalog, setActiveCatalog } from "./packs/catalog.js";
import { parseEnvFile } from "./config/env-parser.js";
import { overlayDirsFrom } from "./config/config.js";
import { buildPlan } from "./planner.js";
import { executePlan } from "./executor.js";
import { readLock, provenance } from "./sources/lock.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function packageVersion() {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
}

/**
 * Run `init` from an argv tail (the args after the `init` subcommand). The agent
 * packs named with --pack (or, with none, every installed pack) are loaded first and
 * become the active catalogue.
 * @param {string[]} argv
 * @param {object} [io] { cwd, home, packageRoot, npmGlobalRoot } (pack lookup)
 * @returns {object} the execution report
 */
export function init(argv, io = {}) {
  const args = parseInitArgs(argv);
  // With --lock the packs come from the lock alone, offline.
  const lock = args.lock ? readLock(args.lock, { store: args.store || undefined }) : null;
  const entries = parseEnvFile(args.env);
  // Overlays: --overlay first, then VBCDX_AGENTS_OVERLAY_DIRS, in order.
  const catalog = loadCatalog(packSpecs(argv), { ...io, lock, overlays: [...args.overlays, ...overlayDirsFrom(entries)] });
  setActiveCatalog(catalog);
  const plan = buildPlan(args, entries, io);
  const report = executePlan(plan);
  if (lock) report.sources = provenance(lock);
  if (catalog.overlays.length) report.overlays = catalog.overlays;
  return report;
}

export { parseInitArgs } from "./cli/args.js";
export { loadCatalog, buildCatalog, setActiveCatalog, activeCatalog } from "./packs/catalog.js";
export { readPack, validatePackDeclaration, validateRoleDescriptor, PACK_DECLARATION_FILE } from "./packs/load.js";
export { buildPlan } from "./planner.js";
export { EXIT, InstallerError } from "./errors.js";
