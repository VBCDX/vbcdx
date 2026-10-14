// Agent packs: reading and validating vbcdx-pack.json and each role's role.json.
//
// An agent pack is an npm package of roles and skills. It ships vbcdx-pack.json at
// its root (schema/vbcdx-pack.schema.json), naming its roles in order and the tool
// contracts they use; each role is <roles_dir>/<id>/ holding role.json
// (schema/vbcdx-role.schema.json) and prompt.md. The installer renders roles only
// from loaded packs: it ships none of its own.
//
// As for the tool declaration, every per-field rule is read from the shipped schemas
// so the validator and the schemas cannot drift. The rules that span fields or files
// live only here: the two directories resolve inside the package, every listed role
// has its directory with both files, a role's id is its directory name, its
// credential_suffix is derived from the id, and every contract a role depends on is
// one the pack declares.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";
import { parseStrictJson } from "../config/json.js";
import { configError } from "../errors.js";
import { idToSuffix } from "../roles/registry.js";
import { checkPackageIdentity } from "../install/locate.js";

export const PACK_DECLARATION_FILE = "vbcdx-pack.json";
const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schema");
export const PACK_SCHEMA_PATH = join(SCHEMA_DIR, "vbcdx-pack.schema.json");
export const ROLE_SCHEMA_PATH = join(SCHEMA_DIR, "vbcdx-role.schema.json");

const PACK = JSON.parse(readFileSync(PACK_SCHEMA_PATH, "utf8"));
const ROLE = JSON.parse(readFileSync(ROLE_SCHEMA_PATH, "utf8"));
const re = (node) => new RegExp(node.pattern);

const PP = PACK.properties;
const PACK_RE = {
  $schema: re(PP.$schema),
  name: re(PP.name),
  description: re(PP.description),
  relDir: re(PACK.$defs.relDir),
  roleId: re(PACK.$defs.roleId),
  contract: re(PP.contracts.items),
  varName: re(PP.vars.propertyNames),
  varLine: re(PP.vars.additionalProperties.properties.default),
};

const RP = ROLE.properties;
const ROLE_RE = {
  id: re(RP.id),
  suffix: re(RP.credential_suffix),
  line: re(ROLE.$defs.line),
  service: re(ROLE.$defs.service),
  kind: re(RP.policy.properties.kind),
  tool: re(RP.remote_capabilities.additionalProperties.items),
  contract: re(RP.dependencies.additionalProperties),
};

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function checkKeys(obj, node, label, errors) {
  const allowed = Object.keys(node.properties);
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push(`${label}: unknown field ${JSON.stringify(k)}.`);
  }
  for (const k of node.required || []) {
    if (!(k in obj)) errors.push(`${label}: missing required field ${k}.`);
  }
}

function checkLine(value, maxLength, label, errors) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || !ROLE_RE.line.test(value)) {
    errors.push(`${label} must be one non-empty line of printable text of at most ${maxLength} characters.`);
  }
}

function checkStringList(value, node, itemRe, label, what, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array.`);
    return;
  }
  if (node.minItems && value.length < node.minItems) errors.push(`${label} must list at least ${node.minItems} item(s).`);
  if (value.length > node.maxItems) errors.push(`${label} has more than ${node.maxItems} items.`);
  const seen = new Set();
  value.forEach((v, i) => {
    if (typeof v !== "string" || (node.items.maxLength && v.length > node.items.maxLength) || !itemRe.test(v)) {
      errors.push(`${label}[${i}] is not a valid ${what}.`);
    } else if (seen.has(v)) {
      errors.push(`${label}[${i}] ${v} is listed twice.`);
    } else {
      seen.add(v);
    }
  });
}

/**
 * Validate a parsed vbcdx-pack.json object (per-field rules only; readPack adds the
 * rules that need the package on disk).
 * @returns {{ok: boolean, errors: string[]}} every problem found, not only the first
 */
export function validatePackDeclaration(decl) {
  const errors = [];
  if (!isObject(decl)) return { ok: false, errors: [`${PACK_DECLARATION_FILE} must be a JSON object.`] };
  checkKeys(decl, PACK, PACK_DECLARATION_FILE, errors);
  if ("$schema" in decl && (typeof decl.$schema !== "string" || decl.$schema.length > PP.$schema.maxLength || !PACK_RE.$schema.test(decl.$schema))) {
    errors.push("$schema must be a relative path ending in vbcdx-pack.schema.json (no URL).");
  }
  if ("schema_version" in decl && decl.schema_version !== PP.schema_version.const) {
    errors.push(`schema_version must be ${PP.schema_version.const}; got ${JSON.stringify(decl.schema_version)}.`);
  }
  if ("name" in decl && (typeof decl.name !== "string" || !PACK_RE.name.test(decl.name))) {
    errors.push("name must be 2-64 characters of lowercase letters, digits and hyphens, starting with a letter and not ending in a hyphen.");
  }
  if ("description" in decl) {
    const d = decl.description;
    if (typeof d !== "string" || d.length < PP.description.minLength || d.length > PP.description.maxLength || !PACK_RE.description.test(d)) {
      errors.push(`description must be one non-empty line of printable text of at most ${PP.description.maxLength} characters.`);
    }
  }
  for (const key of ["roles_dir", "skills_dir"]) {
    if (!(key in decl)) continue;
    const v = decl[key];
    if (typeof v !== "string" || v.length > PACK.$defs.relDir.maxLength || !PACK_RE.relDir.test(v)) {
      errors.push(`${key} must be a relative directory inside the package (forward slashes, no '.' or '..' segment).`);
    }
  }
  // roles.items is a $ref: check against the definition it points to (its maxLength included).
  if ("roles" in decl) checkStringList(decl.roles, { ...PP.roles, items: PACK.$defs.roleId }, PACK_RE.roleId, "roles", "role id (lowercase hyphenated words)", errors);
  if ("contracts" in decl) checkStringList(decl.contracts, PP.contracts, PACK_RE.contract, "contracts", "contract (<name>/<major>)", errors);
  // Variables a pack's prompts use, each with a neutral default.
  if ("vars" in decl) {
    const v = decl.vars;
    if (!isObject(v)) errors.push("vars must be an object.");
    else {
      if (Object.keys(v).length > PP.vars.maxProperties) errors.push(`vars has more than ${PP.vars.maxProperties} variables.`);
      const item = PP.vars.additionalProperties;
      for (const [name, spec] of Object.entries(v)) {
        if (!PACK_RE.varName.test(name)) { errors.push(`vars: ${JSON.stringify(name)} is not a variable name (lowercase letters, digits and underscores, starting with a letter).`); continue; }
        if (!isObject(spec)) { errors.push(`vars.${name} must be an object.`); continue; }
        checkKeys(spec, item, `vars.${name}`, errors);
        for (const k of ["default", "description"]) {
          if (!(k in spec)) continue;
          const s = spec[k];
          if (typeof s !== "string" || s.length === 0 || s.length > item.properties[k].maxLength || !PACK_RE.varLine.test(s)) {
            errors.push(`vars.${name}.${k} must be one non-empty line of printable text of at most ${item.properties[k].maxLength} characters.`);
          }
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate one parsed role.json against the role schema, plus the two cross-field
 * rules: id is the role's directory name, credential_suffix is derived from it.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateRoleDescriptor(descriptor, expectedId) {
  const errors = [];
  if (!isObject(descriptor)) return { ok: false, errors: ["role.json must be a JSON object."] };
  checkKeys(descriptor, ROLE, "role.json", errors);
  const d = descriptor;
  if ("schema_version" in d && d.schema_version !== RP.schema_version.const) errors.push(`schema_version must be ${RP.schema_version.const}.`);
  if ("id" in d) {
    if (typeof d.id !== "string" || d.id.length > RP.id.maxLength || !ROLE_RE.id.test(d.id)) errors.push("id must be lowercase hyphenated words.");
    else if (expectedId !== undefined && d.id !== expectedId) errors.push(`id ${d.id} does not match its directory ${expectedId}.`);
  }
  if ("credential_suffix" in d) {
    if (typeof d.credential_suffix !== "string" || !ROLE_RE.suffix.test(d.credential_suffix)) errors.push("credential_suffix must be upper-case words joined by underscores.");
    else if (typeof d.id === "string" && d.credential_suffix !== idToSuffix(d.id)) errors.push(`credential_suffix must be ${idToSuffix(d.id)} (the id upper-cased, hyphens as underscores).`);
  }
  if ("name" in d) checkLine(d.name, RP.name.maxLength, "name", errors);
  if ("description" in d) checkLine(d.description, RP.description.maxLength, "description", errors);

  if ("policy" in d) {
    const p = d.policy;
    const node = RP.policy;
    if (!isObject(p)) errors.push("policy must be an object.");
    else {
      checkKeys(p, node, "policy", errors);
      if ("kind" in p && (typeof p.kind !== "string" || !ROLE_RE.kind.test(p.kind))) errors.push("policy.kind must be a short lowercase word.");
      if ("summary" in p) checkLine(p.summary, node.properties.summary.maxLength, "policy.summary", errors);
      if ("enforcement" in p) checkLine(p.enforcement, node.properties.enforcement.maxLength, "policy.enforcement", errors);
      for (const k of ["source_read_only", "may_merge"]) {
        if (k in p && typeof p[k] !== "boolean") errors.push(`policy.${k} must be true or false.`);
      }
    }
  }
  if ("local_capabilities" in d) {
    const c = d.local_capabilities;
    const node = RP.local_capabilities;
    if (!isObject(c)) errors.push("local_capabilities must be an object.");
    else {
      checkKeys(c, node, "local_capabilities", errors);
      if ("filesystem" in c && !node.properties.filesystem.enum.includes(c.filesystem)) {
        errors.push(`local_capabilities.filesystem must be one of ${node.properties.filesystem.enum.join(", ")}.`);
      }
      for (const k of ["shell", "web", "delegation"]) {
        if (k in c && typeof c[k] !== "boolean") errors.push(`local_capabilities.${k} must be true or false.`);
      }
    }
  }
  if ("web_search" in d && typeof d.web_search !== "boolean") errors.push("web_search must be true or false.");
  if ("remote_capabilities" in d) {
    const r = d.remote_capabilities;
    if (!isObject(r)) errors.push("remote_capabilities must be an object.");
    else {
      for (const [service, tools] of Object.entries(r)) {
        if (!ROLE_RE.service.test(service) && !ROLE_RE.contract.test(service)) {
          errors.push(`remote_capabilities key ${JSON.stringify(service)} is not a service name or a contract (<name>/<major>).`);
        }
        checkStringList(tools, { ...RP.remote_capabilities.additionalProperties, minItems: 0 }, ROLE_RE.tool, `remote_capabilities.${service}`, "tool name", errors);
      }
    }
  }
  if ("dependencies" in d) {
    const deps = d.dependencies;
    if (!isObject(deps)) errors.push("dependencies must be an object.");
    else {
      for (const [service, contract] of Object.entries(deps)) {
        if (!ROLE_RE.service.test(service)) errors.push(`dependencies key ${JSON.stringify(service)} is not a service name.`);
        if (typeof contract !== "string" || !ROLE_RE.contract.test(contract)) errors.push(`dependencies.${service} must be a contract (<name>/<major>).`);
      }
    }
  }
  if ("external_dependencies" in d) {
    const node = RP.external_dependencies;
    const item = node.items;
    if (!Array.isArray(d.external_dependencies)) errors.push("external_dependencies must be an array.");
    else {
      if (d.external_dependencies.length > node.maxItems) errors.push(`external_dependencies has more than ${node.maxItems} items.`);
      d.external_dependencies.forEach((e, i) => {
        const label = `external_dependencies[${i}]`;
        if (!isObject(e)) return errors.push(`${label} must be an object.`);
        checkKeys(e, item, label, errors);
        if ("name" in e && (typeof e.name !== "string" || e.name.length > item.properties.name.maxLength || !ROLE_RE.id.test(e.name))) errors.push(`${label}.name must be lowercase hyphenated words.`);
        if ("status" in e && !item.properties.status.enum.includes(e.status)) errors.push(`${label}.status must be one of ${item.properties.status.enum.join(", ")}.`);
        if ("note" in e) checkLine(e.note, item.properties.note.maxLength, `${label}.note`, errors);
      });
    }
  }
  if ("opencode_mode" in d && !RP.opencode_mode.enum.includes(d.opencode_mode)) {
    errors.push(`opencode_mode must be one of ${RP.opencode_mode.enum.join(", ")}.`);
  }
  return { ok: errors.length === 0, errors };
}

function invalid(source, errors) {
  const lines = [`Invalid agent pack ${source}:`, ...errors.map((e) => `  ${e}`)];
  return configError(lines.join("\n"), { lines });
}

function readText(path, what, source) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    throw invalid(source, [`${what} is missing or unreadable (${err.code || "read error"}).`]);
  }
}

/** A declared directory, resolved and confined to the package (no symlink out). */
function packSubdir(dir, rel, key, source) {
  const abs = join(dir, ...rel.split("/"));
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw invalid(source, [`${key} ${rel} is not a directory in the package.`]);
  const real = realpathSync(abs);
  if (real !== dir && !real.startsWith(dir + sep)) throw invalid(source, [`${key} ${rel} resolves outside the package.`]);
  return real;
}

/**
 * Read an agent pack from its package directory: the declaration, then every listed
 * role. Every problem in the declaration is reported together; a role's problems are
 * reported with the role named. Returns a frozen pack:
 *   { name, description, package, version, dir, rolesDir, skillsDir, contracts,
 *     roles: [{ id, prompt, descriptor, pack }] }
 */
export function readPack(packageDir, { spec } = {}) {
  const dir = realpathSync(packageDir);
  const source = join(dir, PACK_DECLARATION_FILE);
  if (!existsSync(source)) throw configError(`${dir} has no ${PACK_DECLARATION_FILE}; it is not a VBCDX agent pack.`);
  const pkgPath = join(dir, "package.json");
  const pkg = parseStrictJson(readText(pkgPath, "package.json", source), pkgPath);
  checkPackageIdentity(dir, spec, pkg);
  const decl = parseStrictJson(readText(source, PACK_DECLARATION_FILE, source), source);
  const { ok, errors } = validatePackDeclaration(decl);
  if (!ok) throw invalid(source, errors);

  const rolesDir = packSubdir(dir, decl.roles_dir, "roles_dir", source);
  const skillsDir = decl.skills_dir === undefined ? null : packSubdir(dir, decl.skills_dir, "skills_dir", source);
  const contracts = Object.freeze([...(decl.contracts || [])]);

  const roles = decl.roles.map((id) => {
    const roleDir = packSubdir(dir, `${decl.roles_dir}/${id}`, `role ${id}`, source);
    const prompt = readText(join(roleDir, "prompt.md"), `role ${id} prompt.md`, source);
    if (prompt.trim() === "") throw invalid(source, [`role ${id} prompt.md is empty.`]);
    const rolePath = join(roleDir, "role.json");
    const descriptor = parseStrictJson(readText(rolePath, `role ${id} role.json`, source), rolePath);
    const res = validateRoleDescriptor(descriptor, id);
    const roleErrors = res.errors.map((e) => `role ${id}: ${e}`);
    for (const [service, contract] of Object.entries(isObject(descriptor.dependencies) ? descriptor.dependencies : {})) {
      if (!contracts.includes(contract)) roleErrors.push(`role ${id}: dependencies.${service} names ${contract}, which the pack does not list in contracts.`);
    }
    for (const key of Object.keys(isObject(descriptor.remote_capabilities) ? descriptor.remote_capabilities : {})) {
      if (ROLE_RE.contract.test(key) && !contracts.includes(key)) {
        roleErrors.push(`role ${id}: remote_capabilities names contract ${key}, which the pack does not list in contracts.`);
      }
    }
    if (roleErrors.length) throw invalid(source, roleErrors);
    return { id, prompt, descriptor: deepFreeze(descriptor) };
  });

  const pack = {
    name: decl.name,
    description: decl.description || "",
    package: pkg.name,
    version: String(pkg.version || ""),
    dir,
    rolesDir,
    skillsDir,
    contracts,
    // name -> default value, for the {{vars.<name>}} references in the pack's prompts
    vars: Object.freeze(Object.fromEntries(Object.entries(decl.vars || {}).map(([k, v]) => [k, v.default]))),
  };
  pack.roles = Object.freeze(roles.map((r) => Object.freeze({ ...r, pack: pack.name })));
  return Object.freeze(pack);
}

function deepFreeze(v) {
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) deepFreeze(v[k]);
    Object.freeze(v);
  }
  return v;
}
