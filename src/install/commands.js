// The `vbcdx` commands: install agent|skill|tool, list, remove, doctor.
//
// Everything is recorded in the existing install manifest
// (<BASE_DIR>/manifests/installation.json), next to the definitions `init` writes:
//   files[<abs path>]     whole files the installer owns (agent definitions, skills)
//   entries[<file>#<key>] one owned entry in a harness config file (an MCP server),
//                         by the digest of its value (src/install/config-entry.js)
//   tools[<harness>:<scope>:<server>]  what `install tool` registered, which
//                         `install agent` binds roles to and `doctor` checks
// The same ownership rules hold for all three: a re-run is a no-op, content edited
// since the installer wrote it is a conflict unless --force, and remove deletes only
// what the manifest records and still matches.

import { dirname, join, sep } from "node:path";
import { existsSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { readManifest, writeManifest, classifyGenerated } from "../fs/manifest.js";
import { acquireLocks, atomicWrite, digestOf, ensureDir, sha256, validateExistingFile } from "../fs/safe-writer.js";
import { mergeConfig, ownedDigest } from "../fs/hermes-config.js";
import { isPlainObject } from "../fs/plain-object.js";
import { parsePy } from "../fs/pyyaml.js";
import { buildPlan } from "../planner.js";
import { executePlan } from "../executor.js";
import { resolveHarnessDir, resolveHermesProfileDir } from "../renderers/index.js";
import { allDocuments } from "../skills/catalogue.js";
import { legacyCredentialLeftovers, LEFTOVER_ADVICE } from "./legacy-credentials.js";
import { mcpTarget, renderMcpEntry, skillTarget } from "./harness-targets.js";
import { planEntryWrite, planEntryRemove } from "./config-entry.js";
import { resolveToolPackage, runToolManifest, binLaunch } from "./tool-package.js";
import { readToolDeclaration, envForMode } from "./tool-declaration.js";
import { shownName } from "../shown.js";
import { packageVersion } from "../index.js";
import { InstallerError, configError, conflictError } from "../errors.js";

const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/; // opencode.ai/docs/skills; also valid for Claude and Codex

function loadManifest(ctx) {
  const m = readManifest(ctx.manifestPath, packageVersion());
  m.entries = m.entries && typeof m.entries === "object" ? m.entries : {};
  m.tools = m.tools && typeof m.tools === "object" ? m.tools : {};
  return m;
}

function saveManifest(ctx, manifest) {
  manifest.package_version = packageVersion();
  writeManifest(ctx.manifestPath, manifest);
}

/** Where a record belongs: user:<harness root> or project:<worktree>. */
function scopeId(ctx) {
  return ctx.scope === "project" ? `project:${ctx.worktreeRoot}` : `user:${ctx.config.harnessRoot}`;
}

const toolKey = (ctx, server) => `${ctx.harness}:${scopeId(ctx)}:${server}`;

// Whether the installer created a config file is a fact about the file, not about the
// entry whose write happened to create it: an entry written into a file the installer
// created inherits the flag, so whichever entry is removed last deletes the file.
const fileCreated = (manifest, file) => Object.values(manifest.entries).some((e) => e.file === file && e.created_file);
const entryKey = (target) => `${target.file}#${target.path.join(".")}`;

function toolsFor(ctx, manifest) {
  const prefix = `${ctx.harness}:${scopeId(ctx)}:`;
  return Object.entries(manifest.tools).filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
}

function existingMode(absPath, fallback) {
  try {
    return statSync(absPath).mode & 0o777;
  } catch {
    return fallback;
  }
}

function withLocks(ctx, paths, fn) {
  ensureDir(dirname(ctx.manifestPath));
  const release = acquireLocks([ctx.manifestPath, ...paths]);
  try {
    return fn();
  } finally {
    release();
  }
}

function refuse(what, path, note) {
  return conflictError(`Refusing to ${what} ${path}: ${note}. Nothing was written.`);
}

// ── install tool ─────────────────────────────────────────────────────────────

// Running the manifest command executes the package's code, so installTool calls this only
// once it is about to write: never for --dry-run, and never for a run it refuses.
function runManifestFor(pkg, record, report) {
  const { tools, manifest } = runToolManifest(pkg);
  const decl = pkg.declaration;
  if (decl.contract && manifest.contract !== decl.contract) {
    throw conflictError(`${pkg.name} declares contract ${decl.contract} but its manifest reports ${manifest.contract}.`);
  }
  record.tools = tools;
  record.contract = manifest.contract;
  report.tools = tools.length;
}

export function installTool(ctx, spec, { force = false, dryRun = false } = {}) {
  const pkg = resolveToolPackage(spec, { cwd: ctx.cwd, home: ctx.home, lock: ctx.lock || null });
  const decl = pkg.declaration;
  const launch = binLaunch(pkg, decl.stdio.bin, decl.stdio.args);
  // tools stays null until the manifest command runs: never for --dry-run or a refused run,
  // so a cautious operator does not execute the package's code (see runManifestFor).
  const report = { kind: "tool", harness: ctx.harness, package: pkg.name, version: pkg.version, server: decl.server_name,
    tools: null, dryRun, warnings: [] };
  const record = {
    package: pkg.name, version: pkg.version, dir: pkg.dir, server_name: decl.server_name, harness: ctx.harness,
    scope: scopeId(ctx), launch, env: decl.env,
    manifest_args: decl.manifest.args, bin: decl.stdio.bin, tools: null,
  };
  for (const e of envForMode(decl.env, "stdio")) {
    if (e.required && !process.env[e.name]) report.warnings.push(`${e.name} is required by ${pkg.name} and is not set in this shell (${e.description})`);
  }

  const target = mcpTarget(ctx, decl.server_name);
  const value = renderMcpEntry(ctx.harness, decl, launch);
  const key = entryKey(target);
  const manifest = loadManifest(ctx);
  const plan = planEntryWrite({ absPath: target.file, format: target.format, path: target.path, value, recorded: manifest.entries[key] });
  report.file = target.file;
  report.action = plan.cls === "conflict" && force ? "forced" : plan.cls;
  if (plan.cls === "conflict" && (!force || plan.content === null)) {
    if (dryRun) return { ...report, conflict: plan.note };
    throw refuse("change", target.file, plan.note);
  }
  if (dryRun) return report;

  return withLocks(ctx, [target.file], () => {
    const m = loadManifest(ctx);
    const p = planEntryWrite({ absPath: target.file, format: target.format, path: target.path, value, recorded: m.entries[key] });
    if (p.cls === "conflict" && (!force || p.content === null)) throw refuse("change", target.file, p.note);
    runManifestFor(pkg, record, report);
    if (p.cls !== "noop") {
      ensureDir(dirname(target.file));
      if (existsSync(target.file)) validateExistingFile(target.file);
      atomicWrite(target.file, p.content, { mode: existingMode(target.file, target.mode) });
    }
    const prev = m.entries[key];
    m.entries[key] = { file: target.file, format: target.format, path: target.path, digest: p.digest,
      created_file: Boolean((prev && prev.created_file) || p.createsFile || fileCreated(m, target.file)),
      harness: ctx.harness, tool: pkg.name };
    m.tools[toolKey(ctx, decl.server_name)] = { ...record, entry: key };
    saveManifest(ctx, m);
    report.action = p.cls === "conflict" ? "forced" : p.cls;
    return report;
  });
}

// ── install agent ────────────────────────────────────────────────────────────

/**
 * True for a tool record an earlier version wrote for a tool that takes a key: one that
 * declared a per-call credential file, or an environment variable of kind "credential".
 * `install tool` refuses such a package now (src/install/tool-declaration.js), so only a
 * record from before the upgrade can be one.
 */
export function isKeyedToolRecord(t) {
  return Boolean(t.credential_file) || (Array.isArray(t.env) && t.env.some((e) => e && e.kind === "credential"));
}

/** What to do about a keyed tool record, in the words `doctor` and `install agent` both use. */
const keyedToolAdvice = (ctx, t) =>
  `${t.server_name} was installed by an earlier version as a tool that takes a per-role credential; it is bound to no role. ` +
  `Remove it (\`vbcdx remove tool ${t.server_name} --harness=${ctx.harness}\`) and register it as a Keyhole tool`;

/**
 * Bindings for the tools recorded as installed for this harness and scope, in the
 * shape loadIntegrations returns. A role is bound to a tool only through its
 * reviewed allowlist (renderers/native.js boundServiceTools), by the contract its
 * manifest reported (a record from before contracts were kept binds by server name).
 * A binding carries no credential and names no credential file. A keyed tool record
 * (isKeyedToolRecord) binds no role at all.
 */
export function installedToolBindings(ctx, manifest, roleIds) {
  const services = {};
  for (const t of toolsFor(ctx, manifest)) {
    if (isKeyedToolRecord(t)) continue;
    const stdio = ctx.harness === "hermes"
      ? { command: t.launch.command, args: t.launch.args, env: Object.fromEntries(envForMode(t.env, "stdio").map((e) => [e.name, `\${${e.name}}`])) }
      : null;
    services[t.server_name] = {
      serverName: t.server_name, contract: t.contract || null, tools: t.tools,
      roles: [...roleIds], stdio,
    };
  }
  return Object.keys(services).length ? { services } : null;
}

export function installAgent(ctx, roleIds, { force = false, dryRun = false } = {}) {
  const args = {
    harness: ctx.harness, scope: ctx.scope,
    force, dryRun, quiet: false, agents: roleIds, agentsExplicit: true, env: ctx.envPath,
  };
  const manifest = loadManifest(ctx);
  const installed = installedToolBindings(ctx, manifest, roleIds);
  // An integrations file, when configured, replaces the installed tools' bindings; it binds
  // no role to a tool itself (src/config/integrations.js).
  const integrations = ctx.config.integrationsFile ? null : installed;
  const plan = buildPlan(args, ctx.entries, { cwd: ctx.cwd, integrations });
  // The harness's own default home needs no launch variable; setting one would move
  // Claude's user config off ~/.claude.json, where `install tool` wrote the server.
  if (!ctx.rootExplicit) plan.launchEnv = {};
  // A keyed tool an earlier version registered is bound to no role: say so, and how to
  // clear it. (Credential files left on disk are warned about by buildPlan.)
  for (const t of toolsFor(ctx, manifest).filter(isKeyedToolRecord)) plan.warnings.push(`${keyedToolAdvice(ctx, t)}.`);
  return { kind: "agent", ...executePlan(plan) };
}

// ── install skill ────────────────────────────────────────────────────────────

export function frontmatter(content) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!m) return {};
  try {
    const fm = parsePy(m[1]);
    return fm && typeof fm === "object" ? fm : {};
  } catch {
    return {};
  }
}

/** Every catalogue skill, with the directory name it installs under. */
export function catalogueSkills() {
  return allDocuments()
    .filter((d) => d.relPath.includes("/"))
    .map((d) => {
      const stem = d.relPath.split("/")[1].replace(/\.MD$/, "");
      const fm = frontmatter(d.content);
      return { stem, relPath: d.relPath, content: d.content, name: fm.name, description: fm.description };
    });
}

function findSkill(name) {
  const lower = String(name).toLowerCase();
  const all = catalogueSkills();
  const hit = all.find((s) => s.stem.toLowerCase() === lower || s.name === name);
  const known = all.map((s) => (typeof s.name === "string" && s.name !== s.stem.toLowerCase() ? `${s.name} (or ${s.stem.toLowerCase()})` : s.stem.toLowerCase()));
  if (!hit) throw configError(`Unknown skill ${shownName(name)}. Available: ${known.join(", ") || "none"}.`);
  // Skill harnesses read the directory name; OpenCode requires it to equal `name` (opencode.ai/docs/skills).
  if (typeof hit.name !== "string" || !SKILL_NAME_RE.test(hit.name) || typeof hit.description !== "string" || !hit.description) {
    throw configError(`Skill ${hit.relPath} needs frontmatter with a lowercase-hyphenated name and a description.`);
  }
  return hit;
}

export function installSkill(ctx, name, { force = false, dryRun = false } = {}) {
  const skill = findSkill(name);
  const dest = skillTarget(ctx, skill.name);
  if (!dest) throw conflictError(`Skills are not supported for the ${ctx.harness} harness; nothing was written.`);
  const digest = sha256(Buffer.from(skill.content));
  const report = { kind: "skill", harness: ctx.harness, skill: skill.name, file: dest, dryRun, warnings: [] };
  const manifest = loadManifest(ctx);
  const cls = classifyGenerated(dest, digest, manifest.files[dest]);
  report.action = cls === "conflict" && force ? "forced" : cls;
  if (cls === "conflict" && !force) {
    const note = "it was modified outside the installer or is not package-owned; rerun with --force to replace it";
    if (dryRun) return { ...report, conflict: note };
    throw refuse("overwrite", dest, note);
  }
  if (dryRun) return report;
  return withLocks(ctx, [dest], () => {
    const m = loadManifest(ctx);
    const c = classifyGenerated(dest, digest, m.files[dest]);
    if (c === "conflict" && !force) throw refuse("overwrite", dest, "it was modified outside the installer");
    if (c !== "noop") {
      ensureDir(dirname(dest));
      if (existsSync(dest)) validateExistingFile(dest);
      atomicWrite(dest, skill.content, { mode: 0o644 });
    }
    if (c !== "noop" || !m.files[dest]) {
      m.files[dest] = { digest, mode: 0o644, skill: skill.name, harness: ctx.harness, package_version: packageVersion(), written_at: new Date().toISOString() };
    }
    saveManifest(ctx, m);
    report.action = c === "conflict" ? "forced" : c;
    return report;
  });
}

// ── list ─────────────────────────────────────────────────────────────────────

export function list(ctx) {
  const m = loadManifest(ctx);
  const agents = new Map();
  const skills = [];
  for (const [path, rec] of Object.entries(m.files)) {
    if (rec.harness !== ctx.harness) continue;
    if (rec.skill) skills.push({ name: rec.skill, file: path });
    else if (rec.role) agents.set(rec.role, [...(agents.get(rec.role) || []), path]);
  }
  const tools = Object.values(m.tools).filter((t) => t.harness === ctx.harness)
    .map((t) => ({ server: t.server_name, package: t.package, version: t.version, scope: t.scope, tools: t.tools.length, file: t.entry ? m.entries[t.entry]?.file : null }));
  return { harness: ctx.harness, manifest: ctx.manifestPath, tools, agents: [...agents].map(([role, files]) => ({ role, files: files.sort() })), skills };
}

// ── remove ───────────────────────────────────────────────────────────────────

function removeDirIfEmpty(dir) {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch { /* not ours to force */ }
}

/** Classify deleting a whole file the manifest records. */
function planFileRemove(path, rec) {
  if (rec.owned_paths) return planOwnedKeysRemove(path, rec);
  const onDisk = digestOf(path);
  if (onDisk === null) return { cls: "absent" };
  if (onDisk === rec.digest) return { cls: "delete-file" };
  return { cls: "conflict", removeAs: "delete-file", note: "it was modified since the installer wrote it; --force deletes it anyway" };
}

// A Hermes profile config.yaml is merged, not owned whole (src/fs/hermes-config.js):
// removal takes out the keys the installer owns and keeps every other one.
function planOwnedKeysRemove(path, rec) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { cls: "absent" };
  }
  let doc;
  try {
    doc = parsePy(raw);
  } catch {
    return { cls: "conflict", note: "it cannot be read as YAML; left untouched" };
  }
  // null (a `null` document or an empty file), a sequence, a scalar or a timestamp is
  // not a mapping: there are no owned keys to take out, and deleting the file whole
  // would discard a document the installer cannot read. Refuse it the same way as
  // unreadable YAML. src/fs/plain-object.js is the predicate the install side uses too.
  if (!isPlainObject(doc)) return { cls: "conflict", note: "it is not a mapping; left untouched" };
  let content;
  try {
    content = mergeConfig(raw, {}, rec.owned_paths);
  } catch (err) {
    // A merge key (or an alias the edit would dangle) cannot be edited in place:
    // refuse with a note, never let the internal error out as a raw throw.
    return { cls: "conflict", note: `cannot be edited in place (${err && err.message ? err.message : err}); left untouched` };
  }
  const left = parsePy(content) || {};
  const cls = Object.keys(left).length === 0 ? "delete-file" : "remove";
  let fresh;
  try {
    fresh = ownedDigest(doc, rec.owned_paths);
  } catch (err) {
    // A cyclic alias (or any value canonical() cannot walk) means ownership cannot be
    // checked: refuse rather than guess, leaving the file and its record as they are.
    return { cls: "conflict", note: `cannot be read in full (${err && err.message ? err.message : err}); left untouched` };
  }
  if (fresh !== rec.owned_digest) {
    return { cls: "conflict", removeAs: cls, content, note: "a key the installer owns was edited; --force removes the owned keys anyway" };
  }
  return { cls, content };
}

function applyRemoval(path, step) {
  const cls = step.cls === "conflict" ? step.removeAs : step.cls;
  if (cls === "delete-file") {
    validateExistingFile(path);
    unlinkSync(path);
  } else if (cls === "remove") {
    validateExistingFile(path);
    atomicWrite(path, step.content, { mode: existingMode(path, 0o644) });
  }
}

function agentRoots(ctx, role) {
  if (ctx.harness === "hermes") return [resolveHermesProfileDir(ctx.config.harnessRoot, role)];
  return [resolveHarnessDir(ctx.harness, ctx.scope, { harnessRoot: ctx.config.harnessRoot, worktreeRoot: ctx.worktreeRoot })];
}

/**
 * Remove an installed agent, skill or tool. Only what the manifest records is a
 * candidate; anything edited since it was written is a conflict unless --force.
 */
export function remove(ctx, kind, name, { force = false, dryRun = false } = {}) {
  const manifest = loadManifest(ctx);
  const steps = []; // { path, step, drop(m) }
  const report = { kind, name, harness: ctx.harness, dryRun, removed: [], warnings: [] };

  if (kind === "tool") {
    const key = Object.keys(manifest.tools).find((k) => k.startsWith(`${ctx.harness}:${scopeId(ctx)}:`) &&
      (manifest.tools[k].server_name === name || manifest.tools[k].package === name));
    if (!key) throw configError(`No tool ${shownName(name)} is recorded as installed for ${ctx.harness} (${scopeId(ctx)}).`);
    const tool = manifest.tools[key];
    const ent = tool.entry ? manifest.entries[tool.entry] : null;
    if (ent) {
      steps.push({ path: ent.file, step: planEntryRemove({ absPath: ent.file, format: ent.format, path: ent.path, recorded: ent }),
        drop: (m) => { delete m.entries[tool.entry]; } });
    }
    steps.push({ path: null, step: { cls: "record" }, drop: (m) => { delete m.tools[key]; } });
    report.warnings.push(`agents installed while ${tool.server_name} was present still list its tools; rerun \`vbcdx install agent\` to rebind them`);
  } else if (kind === "skill") {
    // The same names install accepts (catalogue stem or frontmatter name); a skill no
    // longer in the catalogue is still removable by the name it was installed under.
    let installedName = name;
    try {
      installedName = findSkill(name).name;
    } catch (err) {
      if (!(err instanceof InstallerError)) throw err;
    }
    // Install only ever writes a SKILL_NAME_RE name, so no other is recorded as installed: say so
    // before a path is built from it (an error quoting that path would echo the typed value).
    if (!SKILL_NAME_RE.test(installedName)) throw configError(`Skill ${shownName(name)} is not recorded as installed.`);
    const dest = skillTarget(ctx, installedName);
    if (!dest) throw conflictError(`Skills are not supported for the ${ctx.harness} harness.`);
    const rec = manifest.files[dest];
    // Name the skills directory, not a path built from the typed name (that would quote it).
    if (!rec || !rec.skill) throw configError(`Skill ${shownName(name)} is not recorded as installed in ${dirname(dirname(dest))}.`);
    steps.push({ path: dest, step: planFileRemove(dest, rec), drop: (m) => { delete m.files[dest]; }, dir: dirname(dest) });
  } else if (kind === "agent") {
    const roots = agentRoots(ctx, name);
    for (const [path, rec] of Object.entries(manifest.files)) {
      if (rec.role !== name || rec.harness !== ctx.harness) continue;
      if (!roots.some((r) => path.startsWith(r + sep))) continue;
      steps.push({ path, step: planFileRemove(path, rec), drop: (m) => { delete m.files[path]; } });
    }
    if (!steps.length) throw configError(`Agent ${name} is not recorded as installed for ${ctx.harness} (${scopeId(ctx)}).`);
  } else {
    throw configError(`Unknown kind ${JSON.stringify(kind)}: use agent, skill or tool.`);
  }

  const conflicts = steps.filter((s) => s.step.cls === "conflict");
  const blocked = conflicts.filter((s) => !force || s.step.removeAs === undefined);
  for (const s of steps) if (s.path) report.removed.push({ path: s.path, action: s.step.cls === "conflict" && force && s.step.removeAs ? "forced" : s.step.cls });
  if (blocked.length) {
    const lines = blocked.map((s) => `  ${s.path}\n      ${s.step.note}`).join("\n");
    if (dryRun) return { ...report, conflicts: blocked.map((s) => s.path) };
    throw conflictError(`Refusing to remove ${blocked.length} item(s) changed since the installer wrote them; nothing was removed:\n${lines}`);
  }
  if (dryRun) return report;

  const paths = steps.map((s) => s.path).filter(Boolean);
  withLocks(ctx, paths, () => {
    const m = loadManifest(ctx);
    try {
      for (const s of steps) {
        if (s.path && s.step.cls !== "absent") applyRemoval(s.path, s.step);
        s.drop(m);
      }
    } finally {
      saveManifest(ctx, m);
    }
  });
  // After the locks are released: a lock file sits next to the file it guards.
  for (const s of steps) if (s.dir) removeDirIfEmpty(s.dir);
  return report;
}

// ── doctor ───────────────────────────────────────────────────────────────────

/**
 * Check every tool recorded for this harness: its package and bin still exist, its
 * harness entry is still as written, its manifest command runs, and the variables
 * it declares are set in this shell. Prints names and set/unset only, never a value.
 *
 * It also fails on what an earlier version left behind: a tool recorded as taking a
 * per-role credential, and every credential file still under the old credentials
 * directory (listed by path; none is opened, moved or deleted).
 */
export function doctor(ctx, { env = process.env } = {}) {
  const m = loadManifest(ctx);
  const results = [];
  for (const t of Object.values(m.tools).filter((x) => x.harness === ctx.harness)) {
    const problems = [];
    const r = { server: t.server_name, package: t.package, scope: t.scope, checks: [] };
    const pkgOk = existsSync(join(t.dir, "package.json"));
    r.checks.push({ check: "package", ok: pkgOk, detail: t.dir });
    if (!pkgOk) problems.push("package missing");
    if (t.entry) {
      const ent = m.entries[t.entry];
      const step = ent ? planEntryRemove({ absPath: ent.file, format: ent.format, path: ent.path, recorded: ent }) : { cls: "absent" };
      const state = step.cls === "absent" ? "missing" : step.cls === "conflict" ? "edited" : "as written";
      r.checks.push({ check: "harness entry", ok: state === "as written", detail: `${ent ? ent.file : "?"}: ${state}` });
      if (state !== "as written") problems.push(`harness entry ${state}`);
    }
    // The settings checked below come from the declaration as it is now when it re-validates,
    // so a package updated since install is judged by what it declares today.
    let declaredEnv = t.env;
    if (pkgOk) {
      // What runs is decided by the package as it is now, re-validated, never by the
      // local manifest alone: the recorded directory must still hold the same package.
      let current = null;
      try {
        const { declaration, pkg } = readToolDeclaration(t.dir);
        if (pkg.name !== t.package) throw new Error(`${t.dir} now holds ${pkg.name}, not ${t.package}`);
        current = { name: t.package, dir: t.dir, pkg, declaration };
        declaredEnv = declaration.env;
        r.checks.push({ check: "declaration", ok: true, detail: "vbcdx.json valid" });
      } catch (err) {
        r.checks.push({ check: "declaration", ok: false, detail: err.message.split("\n")[0] });
        problems.push("declaration invalid");
      }
      if (current) {
        try {
          const { tools } = runToolManifest(current, { env });
          r.checks.push({ check: "manifest", ok: true, detail: `${tools.length} tools` });
        } catch (err) {
          r.checks.push({ check: "manifest", ok: false, detail: err.message });
          problems.push("manifest command failed");
        }
      }
    }
    for (const e of envForMode(declaredEnv, "stdio")) {
      const set = typeof env[e.name] === "string" && env[e.name] !== "";
      r.checks.push({ check: `env ${e.name}`, ok: set || !e.required, detail: set ? "set" : e.required ? "not set (required)" : "not set" });
      if (!set && e.required) problems.push(`${e.name} not set`);
    }
    if (isKeyedToolRecord(t)) {
      r.checks.push({ check: "key", ok: false, detail: keyedToolAdvice(ctx, t) });
      problems.push("takes a per-role credential");
    }
    r.ok = problems.length === 0;
    results.push(r);
  }
  const leftovers = legacyCredentialLeftovers(ctx.config.legacyCredentialsDir)
    .map((path) => ({ path, detail: LEFTOVER_ADVICE }));
  return { harness: ctx.harness, ok: results.every((r) => r.ok) && leftovers.length === 0, tools: results, leftovers };
}
