// Plan construction (spec sections 3–8). Pure: it validates everything and
// computes every intended effect, but performs no writes, takes no locks, and
// runs no child process. The executor consumes the plan; --dry-run stops here
// and reports it. Validation runs in first-failed-phase order so the exit code
// reflects the earliest failure.

import { join, dirname, relative, isAbsolute, sep } from "node:path";
import { existsSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { getRole, roleIds } from "./roles/index.js";
import { loadConfig } from "./config/config.js";
import { loadIntegrations, FORGEJO_CONTRACT, isCleartextOffHost } from "./config/integrations.js";
import {
  collectCredentialTriples, classifyTriple, credentialPath, credentialConfigKey, describeFields, missingCredentialFields,
} from "./credentials/writer.js";
import { renderFlat, renderHermes, resolveHarnessDir, resolveHermesProfileDir } from "./renderers/index.js";
import { boundServiceTools } from "./renderers/native.js";
import { sha256 } from "./fs/safe-writer.js";
import { parseEnvText } from "./config/env-parser.js";
import { configError, credentialError, conflictError, filesystemError } from "./errors.js";
import { isKnownRole } from "./roles/index.js";

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

// Contract-specific required fields for an externally provisioned credential
// file (spec 6.1): the Forgejo contract needs USER + TOKEN/PASSWORD; any other
// contract (Coolify's included) needs TOKEN.
function externalCredentialOk(absPath, role, contract) {
  const has = (v) => typeof v === "string" && v.trim() !== "";
  let raw;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { ok: false, exit: 3, reason: "credential_missing" };
    return { ok: false, exit: 4, reason: "credential_unreadable" };
  }
  let parsed;
  try {
    parsed = parseEnvText(raw, absPath);
  } catch {
    return { ok: false, exit: 3, reason: "credential_malformed" };
  }
  if (parsed.get("VBCDX_AGENTS_ROLE") !== role) return { ok: false, exit: 3, reason: "role_mismatch" };
  if (contract === FORGEJO_CONTRACT) {
    if (!has(parsed.get("VBCDX_AGENTS_USER")) || !(has(parsed.get("VBCDX_AGENTS_TOKEN")) || has(parsed.get("VBCDX_AGENTS_PASSWORD")))) {
      return { ok: false, exit: 3, reason: "credential_key_missing" };
    }
  } else if (!has(parsed.get("VBCDX_AGENTS_TOKEN"))) {
    return { ok: false, exit: 3, reason: "credential_key_missing" };
  }
  return { ok: true };
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
 * @param {object} [io.launches] server -> { contract, stdio } for the tools `vbcdx install tool`
 *   recorded: an integrations-file stdio service of the same name and contract starts the
 *   way its installed vbcdx.json declares
 */
export function buildPlan(args, entries, { cwd = process.cwd(), integrations: installedTools = null, launches = null } = {}) {
  const { harness, scope, force, dryRun, agentsExplicit } = args;
  // No --agents selects every role of the loaded packs.
  const agents = args.agents || roleIds();

  // Phase: CLI/config (exit 2).
  const config = loadConfig(entries, { harness, scope });
  const roles = agents.map((id) => {
    const r = getRole(id);
    if (!r) {
      const known = roleIds();
      throw configError(`Unknown agent ID in selection: ${id} (not a role of a loaded agent pack). The loaded roles are: ${known.join(", ") || "none"}; \`vbcdx packs\` lists them by pack.`);
    }
    return r;
  });
  const selectedSet = new Set(agents);

  let worktreeRoot = null;
  if (scope === "project") {
    worktreeRoot = findWorktreeRoot(cwd);
    if (!worktreeRoot) throw configError("Project scope requires running inside a Git worktree; none was found.");
  }

  // Integrations (structure/manifest: exit 2/5).
  let integrations = null;
  if (config.integrationsFile) {
    integrations = loadIntegrations(config.integrationsFile);
    for (const [name, svc] of Object.entries(integrations.services)) {
      const installed = launches && Object.hasOwn(launches, name) ? launches[name] : null;
      if (svc.transport === "stdio" && !svc.stdio && installed && installed.contract === svc.contract) svc.stdio = installed.stdio;
    }
  } else if (installedTools) {
    integrations = installedTools;
  }

  // Phase: credentials (exit 3). Collect triples and decide per-file ops: one per
  // role-wide triple, one per role-and-service triple.
  const triples = collectCredentialTriples(entries);
  const credentialOps = [];
  const warnings = [];
  const plannedCredPaths = new Map(); // role -> Set of planned paths (write or retain)
  const planPath = (role, path) => {
    if (!plannedCredPaths.has(role)) plannedCredPaths.set(role, new Set());
    plannedCredPaths.get(role).add(path);
  };

  for (const triple of triples.values()) {
    const { role, service } = triple;
    const known = isKnownRole(role);
    const bound = service && integrations ? integrations.services[service] : undefined;
    const target = { service, contract: bound ? bound.contract || null : null };
    const cls = classifyTriple(triple, target);
    const isSelected = selectedSet.has(role);
    const path = credentialPath(config.credentialsDir, role, service);
    const what = service ? `${role} on ${service}` : role;
    const incomplete = () => {
      const keys = describeFields(missingCredentialFields(triple, target), (f) => credentialConfigKey(f, role, service));
      return `set ${keys} for ${path}, or leave all three blank to disable.`;
    };
    const unbound = () => {
      if (!service) return;
      if (!bound) warnings.push(`Credential file ${path} will be written, but no bound service is named ${service}; nothing reads it until one is.`);
      else if ((bound.transport || "stdio") === "http" || bound.credentialFree) {
        warnings.push(`Credential file ${path} will be written, but ${service} takes no credential file (its identity travels with each call); nothing reads it.`);
      }
    };

    if (known && isSelected) {
      if (cls === "incomplete") {
        throw credentialError(`Credential triple for ${what} is incomplete: ${incomplete()}`);
      }
      if (cls === "complete") {
        credentialOps.push({ role, service, contract: target.contract, path, triple: { ...triple, role } });
        planPath(role, path);
        unbound();
      }
      // disabled -> no file
      continue;
    }
    if (known && !isSelected) continue; // unselected known role: excluded

    // Unknown role.
    if (agentsExplicit) continue; // explicit selection excludes unknown triples
    if (cls === "disabled") continue;
    if (cls === "incomplete") {
      throw credentialError(`Credential triple for unknown role ${what} is incomplete (possible typo of a canonical agent ID); fix it or remove it: ${incomplete()}`);
    }
    // complete unknown triple under default-all: write with a warning.
    credentialOps.push({ role, service, contract: target.contract, path, triple: { ...triple, role }, unknown: true });
    planPath(role, path);
    warnings.push(`Credential file for unknown role ${role} will be written, but no corresponding agent is installed.`);
  }

  // An http service gets every bound role's bearer token on each call.
  if (integrations) {
    for (const [service, svc] of Object.entries(integrations.services)) {
      if (svc.transport !== "http" || !svc.url) continue;
      if (isCleartextOffHost(svc.url)) { // only reachable with "allow_cleartext": true
        warnings.push(`Integration ${service} sends each role's bearer token in cleartext to ${new URL(svc.url).host} (allow_cleartext); use https unless that host is on a trusted private network.`);
      }
    }
  }

  // Cross-check integration credential mappings for selected roles. Installed-tool
  // bindings name the role's default credential file, which may not exist yet; the
  // caller warns about it instead.
  if (integrations && config.integrationsFile) {
    for (const [service, svc] of Object.entries(integrations.services)) {
      for (const [role, credPath] of Object.entries(svc.credentials)) {
        if (!selectedSet.has(role)) continue; // completeness only for the selection
        if (plannedCredPaths.get(role)?.has(credPath)) continue; // this installer plans to create it
        // Otherwise it must be an existing, valid, separately provisioned file.
        const check = externalCredentialOk(credPath, role, svc.contract);
        if (!check.ok) {
          const msg = `Integration ${service} maps ${role} to ${credPath}, which is ${check.reason}. It must be a valid, separately provisioned credential file.`;
          if (check.exit === 4) throw filesystemError(msg);
          throw credentialError(msg);
        }
      }
    }
  }

  // Phase: generated definitions (rendered content + destinations). Each records the
  // credential file its role was told to pass to each tool, so doctor
  // checks exactly the role/tool pairs the definitions bind, without the packs loaded.
  const generated = [];
  const credentialsOf = (role) => Object.fromEntries(boundServiceTools(role.descriptor, integrations)
    .filter((b) => b.credentialFile).map((b) => [b.server, b.credentialFile]));
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
        generated.push({ role: role.id, harness, destination: join(dir, f.name), content: f.content, digest: sha256(Buffer.from(f.content)), mode: f.mode, merge: f.merge, credentials: credentialsOf(role), overlays: role.overlays || [], renamedFrom: role.renamedFrom || null });
      }
    }
  } else {
    const dir = resolveHarnessDir(harness, scope, { harnessRoot: config.harnessRoot, worktreeRoot });
    for (const role of roles) {
      const out = renderFlat(harness, role, { integrations });
      const destination = join(dir, out.filename);
      generated.push({ role: role.id, harness, destination, content: out.content, digest: sha256(Buffer.from(out.content)), mode: out.mode, credentials: credentialsOf(role), overlays: role.overlays || [], renamedFrom: role.renamedFrom || null });
    }
  }

  return {
    harness, scope, force, dryRun,
    baseDir: config.baseDir,
    credentialsDir: config.credentialsDir,
    manifestPath: join(config.baseDir, "manifests", "installation.json"),
    roles: agents,
    generated,
    credentialOps,
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
 * path the current render no longer produces — a role taken out of `git_roles`, a
 * `git_url` removed, or any other file a render stops emitting. Pure and read-only:
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
