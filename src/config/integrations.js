// Explicit service bindings and portable manifest validation (spec 6.1).
//
// The optional VBCDX_AGENTS_INTEGRATIONS_FILE names one absolute, nonsecret
// JSON file describing which services are bound, where each service's exported
// manifest lives, and each role's explicit credential-file path. This module
// validates that file and the referenced manifests strictly and offline: it
// reads only these files, never interpolates, never runs a command supplied by
// configuration, and never reaches the network. Offline agreement proves
// interface compatibility only, not live registration.

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseStrictJson } from "./json.js";
import { normalizeSuffix } from "../roles/registry.js";
import { isKnownRole } from "../roles/index.js";
import { configError, conflictError } from "../errors.js";
import { validateServiceUrl } from "./config.js";

// The two contracts the bundled tool packages implement. Any other contract is accepted:
// a tool binds to a role only where the role's descriptor lists its contract, so an
// unknown contract reaches no role until someone grants it.
export const FORGEJO_CONTRACT = "vbcdx.forgejo/1";
export const COOLIFY_CONTRACT = "vbcdx.coolify/1";
// Same shapes as the tool declaration schema (schema/vbcdx-tool.schema.json):
// server_name and contract.
const SERVICE_NAME_RE = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;
export const isServiceName = (name) => typeof name === "string" && SERVICE_NAME_RE.test(name);
const CONTRACT_RE = /^[a-z0-9][a-z0-9.-]{0,62}\/[1-9][0-9]{0,3}$/;
// Service names whose derived Hermes bearer key, VBCDX_<SERVICE>_TOKEN, already means
// something: forgejo-git would get VBCDX_FORGEJO_GIT_TOKEN, the read-scoped git token a
// read role holds instead of a write-capable one, and agents would get VBCDX_AGENTS_TOKEN,
// the credential-file key. The derivation is one-to-one otherwise: names have no
// underscores, so "-" -> "_" cannot merge two names.
export const RESERVED_SERVICE_NAMES = Object.freeze(["agents", "forgejo-git"]);
const VALID_EFFECTS = new Set(["read", "write", "destructive"]);
// A tool name lands in every harness's rendered allowlist (mcp__<server>__<tool>).
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

function assertAbsolute(label, value) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw configError(`${label} must be an absolute path.`);
  }
  return value;
}

function onlyKeys(obj, allowed, label) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw configError(`Unknown field ${JSON.stringify(k)} in ${label}.`);
  }
}

/**
 * Validate a service manifest object (as produced by a tool package's `manifest`
 * command, e.g. `vbcdx-forgejo manifest`). Returns the sorted tool-name list. The one
 * validator for both an integrations file and `vbcdx install tool`.
 */
export function validateManifest(obj, service, source) {
  if (!obj || typeof obj !== "object") throw configError(`Manifest ${source} is not an object.`);
  onlyKeys(obj, ["schema_version", "service", "contract", "package_version", "tools"], `manifest ${source}`);
  if (obj.schema_version !== 1) throw conflictError(`Manifest ${source} has unsupported schema_version ${obj.schema_version}.`);
  if (obj.service !== service) throw conflictError(`Manifest ${source} declares service ${obj.service}, expected ${service}.`);
  if (typeof obj.contract !== "string" || !CONTRACT_RE.test(obj.contract)) {
    throw conflictError(`Manifest ${source} declares contract ${JSON.stringify(obj.contract)}; a contract looks like <name>/<major>, e.g. ${FORGEJO_CONTRACT}.`);
  }
  if (typeof obj.package_version !== "string" || obj.package_version === "") {
    throw configError(`Manifest ${source} is missing package_version.`);
  }
  if (!Array.isArray(obj.tools)) throw configError(`Manifest ${source} tools must be an array.`);
  const names = [];
  for (const tool of obj.tools) {
    if (!tool || typeof tool !== "object") throw configError(`Manifest ${source} has a non-object tool entry.`);
    for (const f of ["name", "description", "inputSchema", "outputSchema", "effect", "required_permissions"]) {
      if (!(f in tool)) throw configError(`Manifest ${source} tool is missing ${f}.`);
    }
    if (typeof tool.name !== "string" || tool.name === "") throw configError(`Manifest ${source} has a tool with no name.`);
    if (!TOOL_NAME_RE.test(tool.name)) {
      throw configError(`Manifest ${source} has a tool named ${JSON.stringify(tool.name)}; a tool name is 1-128 letters, digits, "_", "." or "-".`);
    }
    if (!VALID_EFFECTS.has(tool.effect)) throw configError(`Manifest ${source} tool ${tool.name} has invalid effect ${tool.effect}.`);
    if (!Array.isArray(tool.required_permissions)) throw configError(`Manifest ${source} tool ${tool.name} required_permissions must be an array.`);
    names.push(tool.name);
  }
  const sorted = [...names].sort();
  if (JSON.stringify(names) !== JSON.stringify(sorted)) {
    throw configError(`Manifest ${source} tools must be sorted by name.`);
  }
  if (new Set(names).size !== names.length) throw configError(`Manifest ${source} has duplicate tool names.`);
  return names;
}

function readJsonFile(absPath, label) {
  let raw;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch (err) {
    throw configError(`Cannot read ${label}: ${absPath} (${err.code || "read error"}).`);
  }
  return parseStrictJson(raw, absPath);
}

/**
 * True for a plain-http URL whose host is not loopback (localhost, ::1, 127.0.0.0/8).
 * WHATWG URL normalises every IPv4 spelling (127.1, 0x7f.1) to dotted-quad, so the
 * anchored pattern is exact; a DNS name such as 127.evil.example is not loopback.
 */
export function isCleartextOffHost(value) {
  const u = new URL(value);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  return u.protocol === "http:" && !loopback;
}

/**
 * Load and validate the integrations file and every referenced manifest.
 * Validates structure and manifests globally; per-role credential-file access
 * is checked later against the selection.
 *
 * A service uses the companion's stdio transport by default, binding a role
 * through an explicit credential-file mapping (`credentials`). With
 * `transport: "http"` it is reached at `url` (the companion's network mode,
 * e.g. through an MCP gateway), identity travels per request in a header the
 * harness supplies, and roles are bound by an explicit `roles` list — there is
 * no credential file for that service.
 *
 * @returns {{services: Record<string, {serverName:string, manifestFile:string,
 *   contract:string, packageVersion:string, tools:string[], transport:string,
 *   url:string|null, roles:string[], credentials: Record<string,string>}>}}
 */
export function loadIntegrations(absPath) {
  const root = readJsonFile(absPath, "integrations file");
  if (!root || typeof root !== "object") throw configError(`Integrations file ${absPath} is not an object.`);
  onlyKeys(root, ["schema_version", "services"], "integrations file");
  if (root.schema_version !== 1) throw conflictError(`Integrations file has unsupported schema_version ${root.schema_version}.`);
  if (!root.services || typeof root.services !== "object") throw configError("Integrations file has no services object.");

  const services = {};
  for (const [name, svc] of Object.entries(root.services)) {
    if (!SERVICE_NAME_RE.test(name)) {
      throw configError(`Service name ${JSON.stringify(name)} in integrations file must be 2-64 characters of lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen.`);
    }
    if (RESERVED_SERVICE_NAMES.includes(name)) {
      throw configError(`Service name ${JSON.stringify(name)} in integrations file is reserved: its token key would be one the installer already uses. Pick another name.`);
    }
    if (!svc || typeof svc !== "object") throw configError(`Service ${name} must be an object.`);
    onlyKeys(svc, ["server_name", "manifest_file", "credentials", "transport", "url", "roles", "tool_prefix", "allow_cleartext", "git_url", "git_roles"], `service ${name}`);
    const transport = svc.transport === undefined ? "stdio" : svc.transport;
    if (transport !== "stdio" && transport !== "http") {
      throw configError(`Service ${name} transport must be "stdio" or "http".`);
    }
    if (svc.server_name !== name) {
      throw configError(`Service ${name} server_name must be exactly "${name}".`);
    }
    const manifestFile = assertAbsolute(`service ${name} manifest_file`, svc.manifest_file);
    const manifestObj = readJsonFile(manifestFile, `${name} manifest`);
    const tools = validateManifest(manifestObj, name, manifestFile);

    let url = null;
    let toolPrefix = "";
    const roles = [];
    if (transport === "http") {
      if (svc.credentials !== undefined) {
        throw configError(`Service ${name} uses transport "http": identity is per request, so it takes a roles list, not credentials.`);
      }
      if (typeof svc.url !== "string") throw configError(`Service ${name} transport "http" requires a url.`);
      url = validateServiceUrl(`service ${name} url`, svc.url);
      // Every call carries a role's bearer token: plain http to a non-loopback host needs an
      // explicit opt-in (e.g. a private container network); init still warns.
      if (svc.allow_cleartext !== undefined && typeof svc.allow_cleartext !== "boolean") {
        throw configError(`Service ${name} allow_cleartext must be true or false.`);
      }
      if (isCleartextOffHost(url) && svc.allow_cleartext !== true) {
        throw configError(`Service ${name} url sends bearer tokens over plain http to a non-loopback host; use https, or set "allow_cleartext": true if that host is on a trusted private network.`);
      }
      // A gateway may namespace the companion's tools (LiteLLM lists them as
      // "<ServerAlias>-<tool>"); tool_prefix makes rendered allow-lists match.
      if (svc.tool_prefix !== undefined) {
        // no "." — Claude/OpenCode tool IDs are built from it (mcp__<server>__<prefix><tool>)
        if (typeof svc.tool_prefix !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(svc.tool_prefix)) {
          throw configError(`Service ${name} tool_prefix must be 1-64 characters of [A-Za-z0-9_-].`);
        }
        toolPrefix = svc.tool_prefix;
      }
      if (!Array.isArray(svc.roles)) throw configError(`Service ${name} transport "http" requires a roles array.`);
      for (const roleId of svc.roles) {
        if (!isKnownRole(roleId)) throw configError(`Service ${name} role ${JSON.stringify(roleId)} is not a role of a loaded agent pack.`);
        if (roles.includes(roleId)) throw configError(`Service ${name} lists role ${roleId} twice.`);
        roles.push(roleId);
      }
    } else if (svc.url !== undefined || svc.roles !== undefined || svc.tool_prefix !== undefined || svc.allow_cleartext !== undefined) {
      throw configError(`Service ${name}: url, roles, tool_prefix and allow_cleartext are only valid with transport "http".`);
    }
    // Hermes git: where the role's Forgejo token clones from and pushes to its fork.
    // Only for a Forgejo-contract service over http: the token is the one the profile's .env holds.
    let gitUrl = null;
    if (svc.git_url !== undefined) {
      if (manifestObj.contract !== FORGEJO_CONTRACT || transport !== "http") {
        throw configError(`Service ${name}: git_url is only valid for a ${FORGEJO_CONTRACT} service with transport "http".`);
      }
      if (typeof svc.git_url !== "string") {
        throw configError(`Service ${name} git_url must be a string.`);
      }
      if (/[\u0000-\u0020\u007f"'`\\$]/.test(svc.git_url)) {
        throw configError(`Service ${name} git_url must be a plain URL: no whitespace, control characters, quotes, backslashes or "$".`);
      }
      gitUrl = validateServiceUrl(`service ${name} git_url`, svc.git_url).replace(/\/+$/, "");
      if (isCleartextOffHost(gitUrl)) {
        throw configError(`Service ${name} git_url sends the role's token over plain http to a non-loopback host; use https.`);
      }
    }
    // Which roles get git, and how: "fork" clones through the role's fork with its own token;
    // "read" clones read-only with a separate read-scoped token. git_url alone enables no role.
    const gitRoles = Object.create(null);
    if (svc.git_roles !== undefined) {
      if (gitUrl === null) throw configError(`Service ${name}: git_roles needs git_url.`);
      if (!svc.git_roles || typeof svc.git_roles !== "object" || Array.isArray(svc.git_roles)) {
        throw configError(`Service ${name} git_roles must be an object of role id -> "read" or "fork".`);
      }
      for (const [roleId, mode] of Object.entries(svc.git_roles)) {
        if (!isKnownRole(roleId)) throw configError(`Service ${name} git_roles role ${JSON.stringify(roleId)} is not a role of a loaded agent pack.`);
        if (!roles.includes(roleId)) throw configError(`Service ${name} git_roles lists ${roleId}, which is not in the service's roles.`);
        if (mode !== "read" && mode !== "fork") {
          throw configError(`Service ${name} git_roles.${roleId} must be "read" or "fork", not ${JSON.stringify(mode)}.`);
        }
        gitRoles[roleId] = mode;
      }
    }

    const credentials = {};
    const creds = svc.credentials || {};
    if (typeof creds !== "object") throw configError(`Service ${name} credentials must be an object.`);
    const normalizedSeen = new Map();
    for (const [roleId, credPath] of Object.entries(creds)) {
      if (!isKnownRole(roleId)) throw configError(`Service ${name} credential role ${JSON.stringify(roleId)} is not a role of a loaded agent pack.`);
      const norm = normalizeSuffix(roleId.toUpperCase().replace(/-/g, "_"));
      if (normalizedSeen.has(norm)) throw configError(`Service ${name} has ambiguous credential role keys for ${roleId}.`);
      normalizedSeen.set(norm, roleId);
      credentials[roleId] = assertAbsolute(`service ${name} credential path for ${roleId}`, credPath);
    }
    services[name] = {
      serverName: name,
      manifestFile,
      contract: manifestObj.contract,
      packageVersion: manifestObj.package_version,
      tools,
      transport,
      url,
      roles,
      toolPrefix,
      credentials,
      gitUrl,
      gitRoles,
    };
  }
  return { services };
}
