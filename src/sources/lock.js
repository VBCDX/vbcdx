// vbcdx.lock.json: what `vbcdx fetch` resolved, read offline.
//
// With --lock, agent packs and tool packages come only from the lock: no git, npm or
// registry access, and no credentials. Every entry's tree is re-digested before use, so
// a store that was changed after the fetch, or an entry whose directory is missing, is
// refused by name and nothing is written.

import { readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseStrictJson } from "../config/json.js";
import { configError } from "../errors.js";
import { SOURCE_NAME_RE, FULL_SHA_RE, isRef, checkGitUrl } from "./config.js";
import { treeDigest } from "./tree.js";

export const LOCK_SCHEMA_VERSION = 1;
const KINDS = ["agents", "tool", "overlay"];
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const ENTRY_KEYS = ["kinds", "git", "shorthand", "dir", "ref", "sha", "path", "digest"];

/**
 * Read, validate and verify a lock.
 * @param {string} lockPath absolute
 * @param {object} [o]
 * @param {string} [o.store] a store directory to use instead of the one the lock records
 * @returns {{path:string, store:string, sources:Array<{name, kinds, git?, shorthand?, dir?, ref?, sha, path, digest, absDir}>}}
 */
export function readLock(lockPath, { store: storeOverride } = {}) {
  if (!isAbsolute(lockPath)) throw configError("--lock must be an absolute path.");
  let raw;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (err) {
    throw configError(`Cannot read the lock ${lockPath} (${err.code || "read error"}); run vbcdx fetch first.`);
  }
  const doc = parseStrictJson(raw, lockPath);
  const where = `Lock ${lockPath}`;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw configError(`${where} is not a JSON object.`);
  for (const k of Object.keys(doc)) if (!["schema_version", "store", "sources"].includes(k)) throw configError(`${where}: unknown field ${JSON.stringify(k)}.`);
  if (typeof doc.schema_version === "number" && doc.schema_version > LOCK_SCHEMA_VERSION) {
    throw configError(`${where} has schema_version ${doc.schema_version}, newer than this vbcdx reads (${LOCK_SCHEMA_VERSION}); upgrade vbcdx.`);
  }
  if (doc.schema_version !== LOCK_SCHEMA_VERSION) throw configError(`${where}: schema_version must be ${LOCK_SCHEMA_VERSION}.`);
  if (typeof doc.store !== "string" || doc.store === "") throw configError(`${where}: store must be a path.`);
  const store = storeOverride ? resolve(storeOverride) : resolve(dirname(lockPath), doc.store);
  if (!doc.sources || typeof doc.sources !== "object" || Array.isArray(doc.sources)) throw configError(`${where}: sources must be an object.`);
  const sources = [];
  for (const [name, e] of Object.entries(doc.sources)) {
    const label = `${where}: source ${JSON.stringify(name)}`;
    if (!SOURCE_NAME_RE.test(name)) throw configError(`${label}: invalid name.`);
    if (!e || typeof e !== "object" || Array.isArray(e)) throw configError(`${label} must be an object.`);
    for (const k of Object.keys(e)) if (!ENTRY_KEYS.includes(k)) throw configError(`${label}: unknown field ${JSON.stringify(k)}.`);
    if (!Array.isArray(e.kinds) || e.kinds.length === 0 || !e.kinds.every((k) => KINDS.includes(k)) || new Set(e.kinds).size !== e.kinds.length) {
      throw configError(`${label}: kinds must list agents, tool and/or overlay.`);
    }
    if (("git" in e) === ("dir" in e)) throw configError(`${label} needs exactly one of git and dir.`);
    if ("git" in e) {
      checkGitUrl(e.git, label);
      if (!isRef(e.ref)) throw configError(`${label}: invalid ref.`);
      if (typeof e.sha !== "string" || !FULL_SHA_RE.test(e.sha)) throw configError(`${label}: sha must be a full commit SHA.`);
    } else if (typeof e.dir !== "string" || e.sha !== null) {
      throw configError(`${label}: a dir source records its dir and a null sha.`);
    }
    if (typeof e.digest !== "string" || !DIGEST_RE.test(e.digest)) throw configError(`${label}: invalid digest.`);
    const id = e.sha || `dir-${e.digest.slice(7, 23)}`;
    // The path is always <name>@<commit or dir digest>: nothing in the lock can point outside the store.
    if (e.path !== `${name}@${id}`) throw configError(`${label}: path must be ${name}@${id}.`);
    const absDir = join(store, e.path);
    if (!existsSync(absDir)) throw configError(`${label}: ${absDir} is missing; rerun vbcdx fetch or point --store at the fetched store.`);
    let digest;
    try {
      digest = treeDigest(absDir); // also refuses a symlink out of the tree
    } catch (err) {
      throw configError(`${label}: ${err.message}`);
    }
    if (digest !== e.digest) throw configError(`${label}: ${absDir} no longer matches the digest vbcdx fetch recorded; rerun vbcdx fetch.`);
    sources.push({ name, ...e, absDir });
  }
  return { path: lockPath, store, sources };
}

/** Provenance lines for a report: name, kinds, where from, ref and commit. No path secrets exist to hide. */
export function provenance(lock) {
  return lock.sources.map((s) => ({
    name: s.name, kinds: s.kinds, ...(s.git ? { git: s.git, ref: s.ref, sha: s.sha } : { dir: s.dir, sha: null }),
    ...(s.shorthand ? { shorthand: s.shorthand } : {}), digest: s.digest, path: s.absDir,
  }));
}

/** The source named `name` (or, failing that, the one whose package.json name is `name`), of `kind`. */
export function lockedSource(lock, name, kind, what) {
  const hits = lock.sources.filter((s) => s.kinds.includes(kind) && s.name === name);
  if (hits.length) return hits[0];
  const byPkg = lock.sources.filter((s) => {
    if (!s.kinds.includes(kind)) return false;
    try {
      return JSON.parse(readFileSync(join(s.absDir, "package.json"), "utf8")).name === name;
    } catch {
      return false;
    }
  });
  if (byPkg.length === 1) return byPkg[0];
  const names = lock.sources.filter((s) => s.kinds.includes(kind)).map((s) => s.name);
  throw configError(`${name} is not ${/^[aeiou]/.test(what) ? "an" : "a"} ${what} in the lock ${lock.path} (it has: ${names.join(", ") || "none"}); with --lock, nothing else is searched.`);
}
