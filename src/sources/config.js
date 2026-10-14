// Custom sources: the non-secret vbcdx.sources.json a consumer checks
// in, naming where each agent pack or tool package comes from.
//
//   { "schema_version": 1, "sources": {
//       "dev-agents": { "shorthand": "dev-agents", "ref": "main" },
//       "forgejo":    { "git": "https://git.example/acme/forgejo-plugin.git", "ref": "main", "auth_env": "FJ_ACCESS_TOKEN" },
//       "local":      { "dir": "../dev-agents-local" } } }
//
// Each source has exactly one origin: a shorthand for a canonical package, a git URL
// (https, or file for local repositories) plus a ref, or a local directory. auth_env
// names the variable that holds a token for a private repository; the value is read at
// fetch time only and is never written anywhere. A URL may not carry credentials.

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseStrictJson } from "../config/json.js";
import { configError } from "../errors.js";

export const SOURCES_SCHEMA_VERSION = 1;

// The canonical packages. They resolve to the public repositories, named after their
// packages, so the installer names no deployment of its own; a private
// mirror is named with an explicit `git` source.
export const SHORTHANDS = Object.freeze({
  "dev-agents": "https://github.com/VBCDX/dev-agents-plugin.git",
  forgejo: "https://github.com/VBCDX/forgejo-plugin.git",
  coolify: "https://github.com/VBCDX/coolify-plugin.git",
});

// A source name becomes a directory name in the store and a key in the lock.
export const SOURCE_NAME_RE = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;
export const FULL_SHA_RE = /^[0-9a-f]{40}$/;
// A branch or tag name: git's own rules, narrowed to what a ref spec can carry safely.
const REF_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]{1,200}(?<![./])$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const ORIGINS = ["shorthand", "git", "dir"];
const KEYS = [...ORIGINS, "ref", "auth_env"];

export const isRef = (ref) => typeof ref === "string" && (FULL_SHA_RE.test(ref) || REF_RE.test(ref));

/** Check a git URL: https or file, no userinfo. Returns the parsed URL. */
export function checkGitUrl(url, label) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw configError(`${label}: git must be an absolute https:// or file:// URL.`);
  }
  if (u.protocol !== "https:" && u.protocol !== "file:") throw configError(`${label}: git must be an https:// or file:// URL.`);
  // Never echo the URL itself: its userinfo is exactly what must not be printed.
  if (u.username || u.password) throw configError(`${label}: git URL carries credentials; name the variable that holds the token in auth_env instead.`);
  if (u.protocol === "https:" && !u.hostname) throw configError(`${label}: git URL has no host.`);
  return u;
}

/**
 * Validate a parsed sources document. Relative `dir` paths resolve against `baseDir`.
 * @returns {Array<{name:string, origin:"git"|"dir", git?:string, shorthand?:string, ref?:string, authEnv?:string, dir?:string}>}
 */
export function validateSources(doc, baseDir, label = "sources file") {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw configError(`${label} is not a JSON object.`);
  for (const k of Object.keys(doc)) {
    if (!["schema_version", "sources", "$schema"].includes(k)) throw configError(`${label}: unknown field ${JSON.stringify(k)}.`);
  }
  if (doc.schema_version !== SOURCES_SCHEMA_VERSION) {
    throw configError(`${label}: schema_version must be ${SOURCES_SCHEMA_VERSION}${typeof doc.schema_version === "number" && doc.schema_version > SOURCES_SCHEMA_VERSION ? "; upgrade vbcdx to read it" : ""}.`);
  }
  if (!doc.sources || typeof doc.sources !== "object" || Array.isArray(doc.sources)) throw configError(`${label}: sources must be an object.`);
  const out = [];
  for (const [name, s] of Object.entries(doc.sources)) {
    const where = `${label}: source ${JSON.stringify(name)}`;
    if (!SOURCE_NAME_RE.test(name)) throw configError(`${where}: a name is 2-64 lowercase letters, digits and hyphens, starting with a letter.`);
    if (!s || typeof s !== "object" || Array.isArray(s)) throw configError(`${where} must be an object.`);
    for (const k of Object.keys(s)) if (!KEYS.includes(k)) throw configError(`${where}: unknown field ${JSON.stringify(k)}.`);
    const origins = ORIGINS.filter((k) => k in s);
    if (origins.length !== 1) throw configError(`${where} needs exactly one of ${ORIGINS.join(", ")}.`);
    const origin = origins[0];
    if (origin === "dir") {
      if ("ref" in s || "auth_env" in s) throw configError(`${where}: a dir source takes no ref or auth_env.`);
      if (typeof s.dir !== "string" || s.dir === "") throw configError(`${where}: dir must be a path.`);
      out.push({ name, origin: "dir", dir: isAbsolute(s.dir) ? s.dir : resolve(baseDir, s.dir) });
      continue;
    }
    let git;
    if (origin === "shorthand") {
      if (typeof s.shorthand !== "string" || !Object.hasOwn(SHORTHANDS, s.shorthand)) {
        throw configError(`${where}: unknown shorthand; use one of ${Object.keys(SHORTHANDS).join(", ")}, or a git URL.`);
      }
      git = SHORTHANDS[s.shorthand];
    } else {
      if (typeof s.git !== "string") throw configError(`${where}: git must be a URL.`);
      git = s.git;
    }
    const u = checkGitUrl(git, where);
    if (!isRef(s.ref)) throw configError(`${where}: ref must be a branch, a tag or a full 40-character commit SHA.`);
    const entry = { name, origin: "git", git, ref: s.ref };
    if (origin === "shorthand") entry.shorthand = s.shorthand;
    if ("auth_env" in s) {
      if (typeof s.auth_env !== "string" || !ENV_NAME_RE.test(s.auth_env)) throw configError(`${where}: auth_env must be an environment variable name.`);
      if (u.protocol !== "https:") throw configError(`${where}: auth_env applies to an https:// source only.`);
      entry.authEnv = s.auth_env;
    }
    out.push(entry);
  }
  if (out.length === 0) throw configError(`${label} lists no sources.`);
  return out;
}

/** Read and validate a sources file. */
export function loadSources(absPath) {
  let raw;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch (err) {
    throw configError(`Cannot read the sources file ${absPath} (${err.code || "read error"}).`);
  }
  return validateSources(parseStrictJson(raw, absPath), dirname(absPath), absPath);
}
