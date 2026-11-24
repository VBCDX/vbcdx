// Plan construction (spec sections 3–8). Pure: it validates everything and
// computes every intended effect, but performs no writes, takes no locks, and
// runs no child process. The executor consumes the plan; --dry-run stops here
// and reports it. Validation runs in first-failed-phase order so the exit code
// reflects the earliest failure.

import { join, dirname, relative, isAbsolute, sep } from "node:path";
import { existsSync } from "node:fs";
import { getRole, roleIds } from "./roles/index.js";
import { loadConfig } from "./config/config.js";
import { loadIntegrations } from "./config/integrations.js";
import { legacyCredentialLeftovers, leftoverWarning } from "./install/legacy-credentials.js";
import { renderFlat, renderHermes, resolveHarnessDir, resolveHermesProfileDir } from "./renderers/index.js";
import { sha256 } from "./fs/safe-writer.js";
import { configError } from "./errors.js";
import { shownWord } from "./shown.js";

/** Find the top level of the containing Git worktree, or null. */
export function findWorktreeRoot(startDir) {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Build the installation plan.
 * @param {object} args parsed init options (from parseInitArgs)
 * @param {Map<string,string>} entries parsed literal config
 * @param {object} [io] { cwd }
 */
/**
 * @param {object} [io.integrations] bindings for the tools `vbcdx install tool` recorded
 *  , used when no integrations file is configured; the file always wins
 */
export function buildPlan(args, entries, { cwd = process.cwd(), integrations: installedTools = null } = {}) {
  const { harness, scope, force, dryRun } = args;
  // No --agents selects every role of the loaded packs.
  const agents = args.agents || roleIds();

  // Phase: CLI/config (exit 2).
  const config = loadConfig(entries, { harness, scope });
  const roles = agents.map((id) => {
    const r = getRole(id);
    if (!r) {
      const known = roleIds();
      throw configError(`Unknown agent ID in selection: ${shownWord(id)} (not a role of a loaded agent pack). The loaded roles are: ${known.join(", ") || "none"}; \`vbcdx packs\` lists them by pack.`);
    }
    return r;
  });

  let worktreeRoot = null;
  if (scope === "project") {
    worktreeRoot = findWorktreeRoot(cwd);
    if (!worktreeRoot) throw configError("Project scope requires running inside a Git worktree; none was found.");
  }

  // Integrations (structure/manifest: exit 2/5).
  let integrations = null;
  if (config.integrationsFile) {
    integrations = loadIntegrations(config.integrationsFile);
  } else if (installedTools) {
    integrations = installedTools;
  }

  // Nothing here writes or reads a credential: the configuration file's per-role credential
  // keys and the integrations file's credential fields were refused above (loadConfig,
  // loadIntegrations), before any write. Files an earlier version wrote are only listed, by
  // path, so the operator is told they are still on disk.
  const warnings = [];
  const leftovers = legacyCredentialLeftovers(config.legacyCredentialsDir);
  if (leftovers.length) warnings.push(leftoverWarning(leftovers));

  // Phase: generated definitions (rendered content + destinations).
  const generated = [];
  if (harness === "hermes") {
    if (!config.hermes) {
      warnings.push("No Hermes model routing configured (VBCDX_AGENTS_HERMES_BASE_URL/_MODEL): profiles are written without a model section and will not run until one is configured.");
    }
    const searchRoles = roles.filter((r) => r.descriptor.web_search === true).map((r) => r.id);
    if (searchRoles.length && !config.hermesWebSearch) {
      warnings.push(`No Hermes web search configured (VBCDX_AGENTS_HERMES_WEB_SEARCH_URL/_TOOL): ${searchRoles.join(", ")} are written without web search.`);
    }
    for (const role of roles) {
      const dir = resolveHermesProfileDir(config.harnessRoot, role.id);
      for (const f of renderHermes(role, { integrations, hermes: config.hermes, webSearch: config.hermesWebSearch }).files) {
        generated.push({ role: role.id, harness, destination: join(dir, f.name), content: f.content, digest: sha256(Buffer.from(f.content)), mode: f.mode, merge: f.merge, overlays: role.overlays || [], renamedFrom: role.renamedFrom || null });
      }
    }
  } else {
    const dir = resolveHarnessDir(harness, scope, { harnessRoot: config.harnessRoot, worktreeRoot });
    for (const role of roles) {
      const out = renderFlat(harness, role, { integrations });
      const destination = join(dir, out.filename);
      generated.push({ role: role.id, harness, destination, content: out.content, digest: sha256(Buffer.from(out.content)), mode: out.mode, overlays: role.overlays || [], renamedFrom: role.renamedFrom || null });
    }
  }

  return {
    harness, scope, force, dryRun,
    baseDir: config.baseDir,
    manifestPath: join(config.baseDir, "manifests", "installation.json"),
    roles: agents,
    generated,
    launchEnv: config.launchEnv,
    integrations: integrations ? Object.keys(integrations.services) : [],
    warnings,
  };
}

// ── Removal candidates ──────────────────────────────────────────

/**
 * The deepest directory every path in `dirs` has in common, or null when there is
 * none worth using. `"/"` and `""` are reported as null: a root that wide would not
 * confine a removal to anything.
 */
function commonRoot(dirs) {
  if (!dirs.length) return null;
  const split = (p) => p.split(sep);
  let parts = split(dirs[0]);
  for (const d of dirs.slice(1)) {
    const other = split(d);
    let i = 0;
    while (i < parts.length && i < other.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
    if (parts.length === 0) return null;
  }
  const root = parts.join(sep);
  return root === "" || root === sep ? null : root;
}

/** True when `absPath` is strictly inside the directory `root`. */
function isUnder(absPath, root) {
  const rel = relative(root, absPath);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep);
}

/**
 * Removal candidates: the manifest entries this run is responsible for whose
 * path the current render no longer produces — a role's web-search plugin once web
 * search is no longer configured, a file an earlier version rendered and this one does
 * not, or any other file a render stops emitting. Pure and read-only:
 * the executor decides what to do with each one.
 *
 * A candidate must pass every one of these, so a removal can never reach another
 * harness, another role, a file the installer never wrote, or anything outside the
 * directory this run renders into:
 *   * its `role` is one of the roles this run renders (an unselected role's files,
 *     and a role no longer in the registry, are left alone);
 *   * its `harness` is a target this run renders that same role for;
 *   * the path is not among the destinations this render produces;
 *   * the path is inside the common directory of everything this run renders.
 */
export function planRemovals(plan, manifest) {
  const produced = plan.generated.map((g) => ({ destination: g.destination, role: g.role, harness: g.harness }));
  const producedPaths = new Set(produced.map((p) => p.destination));
  const root = commonRoot(produced.map((p) => dirname(p.destination)));
  if (!root) return [];
  const selected = new Set(plan.roles);
  const candidates = [];
  for (const [destination, entry] of Object.entries(manifest.files || {})) {
    if (!entry || typeof entry.digest !== "string") continue; // not the installer's record: never touched
    if (!selected.has(entry.role)) continue; // another role's file, or a role this run does not render
    if (!produced.some((p) => p.role === entry.role && p.harness === entry.harness)) continue; // another harness/target
    if (producedPaths.has(destination)) continue; // the render still produces it
    if (!isUnder(destination, root)) continue; // outside this run's target root
    candidates.push({ role: entry.role, destination, digest: entry.digest });
  }
  return candidates;
}
