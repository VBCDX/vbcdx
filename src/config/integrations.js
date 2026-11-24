// Explicit service bindings and portable manifest validation (spec 6.1).
//
// The optional VBCDX_AGENTS_INTEGRATIONS_FILE names one absolute, nonsecret
// JSON file listing services by name and where each service's exported manifest lives.
// It carries no credential and names none: a per-role credential-file map, a headers
// field, an http service (it was reached with a role's bearer token) and the git fields
// are refused by name (a tool's key lives in Keyhole and reaches the tool through the
// sidecar). This module validates that file and the referenced manifests strictly and offline: it
// reads only these files, never interpolates, never runs a command supplied by
// configuration, and never reaches the network. Offline agreement proves
// interface compatibility only, not live registration.

import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { parseStrictJson } from "./json.js";
import { configError, conflictError } from "../errors.js";
import { ARG_RE, BIN_RE, ENV_NAME_RE } from "../install/tool-declaration.js";

// A contract the bundled tool packages implement. Any other contract is accepted:
// a tool binds to a role only where the role's descriptor lists its contract, so an
// unknown contract reaches no role until someone grants it.
export const COOLIFY_CONTRACT = "vbcdx.coolify/1";
// Same shapes as the tool declaration schema (schema/vbcdx-tool.schema.json):
// server_name and contract.
const SERVICE_NAME_RE = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;
const CONTRACT_RE = /^[a-z0-9][a-z0-9.-]{0,62}\/[1-9][0-9]{0,3}$/;
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
    throw conflictError(`Manifest ${source} declares contract ${JSON.stringify(obj.contract)}; a contract looks like <name>/<major>, e.g. vbcdx.forgejo/1.`);
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

/**
 * Read the integrations file only if no one but its owner can change it: it says which
 * program Hermes starts for a stdio service, so whoever can write or replace it could run
 * a command as the Hermes user. It must be a regular file (not a symlink) owned by the
 * effective user or root and writable by no one else, in a directory no one else can
 * write to unless the directory is sticky. Checked on the open file, so it can't be
 * swapped between the check and the read. A refusal names the path only.
 */
function readTrustedJsonFile(absPath, label) {
  const refuse = (why) => configError(`Refusing the ${label} ${absPath}: ${why}. It decides which programs are started, so only its owner may be able to change it.`);
  let dir;
  try {
    dir = statSync(dirname(absPath));
  } catch (err) {
    throw configError(`Cannot read ${label}: ${absPath} (${err.code || "read error"}).`);
  }
  if ((dir.mode & 0o022) !== 0 && (dir.mode & 0o1000) === 0) throw refuse("its directory can be written by others");
  let fd;
  try {
    fd = openSync(absPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    if (err.code === "ELOOP") throw refuse("it is a symlink");
    throw configError(`Cannot read ${label}: ${absPath} (${err.code || "read error"}).`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw refuse("it is not a regular file");
    const euid = typeof process.geteuid === "function" ? process.geteuid() : st.uid;
    if (st.uid !== euid && st.uid !== 0) throw refuse("it is owned by another user");
    if ((st.mode & 0o022) !== 0) throw refuse("it can be written by others");
    return parseStrictJson(readFileSync(fd, "utf8"), absPath);
  } finally {
    closeSync(fd);
  }
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

// What an earlier version accepted to hand a role a credential, and no longer does.
const REMOVED_CREDENTIAL_FIELDS = Object.freeze(["credentials", "headers", "allow_cleartext"]);
// An http service: every call to one carried the role's bearer token.
const REMOVED_HTTP_FIELDS = Object.freeze(["transport", "url", "roles", "tool_prefix"]);
// Hermes git: a git host's token in a role's terminal. Not in this release.
const REMOVED_GIT_FIELDS = Object.freeze(["git_url", "git_roles"]);

/**
 * The fields of one service entry that are refused, in two groups. Field names only; no
 * value is read, except that `transport` is refused only when it says "http".
 *
 * `credential`: what carried, or pointed a role's bearer token at, a credential:
 * `credentials` (role -> credential file), `headers`, `allow_cleartext` (it only ever
 * allowed a bearer token over plain http), and an http service (`transport`, `url`,
 * `roles`, `tool_prefix`).
 *
 * `git`: `git_url` and `git_roles`, and with them the http fields of the service that
 * carried them, which were there only for git.
 */
function removedFields(svc) {
  const has = (f) => Object.hasOwn(svc, f);
  const credential = REMOVED_CREDENTIAL_FIELDS.filter(has);
  const http = REMOVED_HTTP_FIELDS.filter((f) => has(f) && (f !== "transport" || svc.transport === "http"));
  const git = REMOVED_GIT_FIELDS.filter(has);
  return git.length ? { credential, git: [...http, ...git] } : { credential: [...credential, ...http], git };
}

/**
 * Load and validate the integrations file and every referenced manifest.
 *
 * Every service is a stdio service (started by its `stdio` launch, or its installed
 * tool's). The file binds no role to a service: roles are bound to the tools
 * `vbcdx install tool` registered, so `roles` is always empty here.
 *
 * Every field that carried a per-role credential, every field of an http service and the
 * Hermes git fields are refused, for the whole file at once, with a message that names
 * the fields to remove and nothing else.
 *
 * @returns {{services: Record<string, {serverName:string, manifestFile:string,
 *   contract:string, packageVersion:string, tools:string[], roles:string[],
 *   stdio?:{command:string, args:string[], env:Record<string,string>}}>}}
 */
export function loadIntegrations(absPath) {
  const root = readTrustedJsonFile(absPath, "integrations file");
  if (!root || typeof root !== "object") throw configError(`Integrations file ${absPath} is not an object.`);
  onlyKeys(root, ["schema_version", "services"], "integrations file");
  if (root.schema_version !== 1) throw conflictError(`Integrations file has unsupported schema_version ${root.schema_version}.`);
  if (!root.services || typeof root.services !== "object") throw configError("Integrations file has no services object.");

  const services = {};
  const removed = { credential: [], git: [] };
  for (const [name, svc] of Object.entries(root.services)) {
    if (!SERVICE_NAME_RE.test(name)) {
      throw configError(`Service name ${JSON.stringify(name)} in integrations file must be 2-64 characters of lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen.`);
    }
    if (!svc || typeof svc !== "object") throw configError(`Service ${name} must be an object.`);
    const refused = removedFields(svc);
    if (refused.credential.length || refused.git.length) {
      // Collected for every service, so one run names everything there is to remove.
      for (const group of ["credential", "git"]) removed[group].push(...refused[group].map((f) => `${name}.${f}`));
      continue;
    }
    onlyKeys(svc, ["server_name", "manifest_file", "transport", "stdio"], `service ${name}`);
    if (svc.transport !== undefined && svc.transport !== "stdio") {
      throw configError(`Service ${name} transport must be "stdio".`);
    }
    if (svc.server_name !== name) {
      throw configError(`Service ${name} server_name must be exactly "${name}".`);
    }
    const manifestFile = assertAbsolute(`service ${name} manifest_file`, svc.manifest_file);
    const manifestObj = readJsonFile(manifestFile, `${name} manifest`);
    const tools = validateManifest(manifestObj, name, manifestFile);

    const stdio = svc.stdio === undefined ? null : parseStdioLaunch(name, svc.stdio);

    services[name] = {
      serverName: name,
      manifestFile,
      contract: manifestObj.contract,
      packageVersion: manifestObj.package_version,
      tools,
      roles: [],
      ...(stdio ? { stdio } : {}),
    };
  }
  if (removed.credential.length || removed.git.length) {
    const parts = [];
    if (removed.credential.length) {
      parts.push(`per-role credentials are no longer read or sent; remove these fields: ${removed.credential.join(", ")}. ` +
        "Put each key in Keyhole and grant the tool (README, \"How a tool gets its key\").");
    }
    if (removed.git.length) {
      parts.push(`Hermes git isn't in this release; remove these fields: ${removed.git.join(", ")}. ` +
        "The installer gives no role a git credential (README, \"Hermes git is removed\").");
    }
    throw configError(`Integrations file ${absPath}: ${parts.join(" ")}`);
  }
  return { services };
}

/**
 * A stdio service's declared launch: how the harness starts its MCP server, in the
 * shapes a tool declaration (vbcdx.json) uses. `command` is a program name on PATH,
 * `args` are lowercase words and bare --flags, and `env` names the variables it reads;
 * each is rendered as a reference to the variable, never a value. The result has the
 * shape of an installed tool's launch: {command, args, env: {NAME: "${NAME}"}}.
 */
function parseStdioLaunch(name, launch) {
  const where = `Service ${name} stdio`;
  if (!launch || typeof launch !== "object" || Array.isArray(launch)) throw configError(`${where} must be an object.`);
  onlyKeys(launch, ["command", "args", "env"], `service ${name} stdio`);
  if (typeof launch.command !== "string" || !BIN_RE.test(launch.command)) {
    throw configError(`${where}.command must be a program name: 1-64 characters of lowercase letters, digits, ".", "_" and "-", starting with a letter or digit.`);
  }
  const args = launch.args === undefined ? [] : launch.args;
  if (!Array.isArray(args) || args.length > 16 || !args.every((a) => typeof a === "string" && ARG_RE.test(a))) {
    throw configError(`${where}.args must be at most 16 subcommand words or bare --flags (lowercase letters and single hyphens).`);
  }
  const envNames = launch.env === undefined ? [] : launch.env;
  if (!Array.isArray(envNames) || envNames.length > 64 || !envNames.every((e) => typeof e === "string" && ENV_NAME_RE.test(e))) {
    throw configError(`${where}.env must be at most 64 variable names (uppercase letters, digits and "_", starting with a letter).`);
  }
  if (new Set(envNames).size !== envNames.length) throw configError(`${where}.env lists a variable twice.`);
  return Object.freeze({
    command: launch.command,
    args: Object.freeze([...args]),
    env: Object.freeze(Object.fromEntries(envNames.map((e) => [e, "${" + e + "}"]))),
  });
}
